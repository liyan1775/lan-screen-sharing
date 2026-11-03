package app

import (
	"context"
	"encoding/json"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"lan-screen-sharing/internal/protocol"
)

func TestTwoServerRoomLifecycleLeavesOneViewerAndEndsRoomOnHostShutdown(t *testing.T) {
	ip := firstPrivateIPv4()
	if ip == "" {
		t.Skip("no private IPv4 available")
	}

	hostServer := New(Config{LANIPv4: ip, SignalPort: 0})
	hostLocal, err := hostServer.StartAtPort(context.Background(), 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = hostServer.Shutdown(context.Background()) }()
	viewerServer := New(Config{})
	viewerLocal, err := viewerServer.StartAtPort(context.Background(), 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = viewerServer.Shutdown(context.Background()) }()

	hostOrigin := "http://" + hostLocal.Addr().String()
	hostURL := "ws" + strings.TrimPrefix(hostOrigin, "http") + "/ws/v1"
	host := dialAppLocal(t, hostURL, hostOrigin)
	defer host.Close(websocket.StatusNormalClosure, "test cleanup")
	writeEnvelope(t, host, protocol.Envelope{V: 1, Type: "auth.hello", RequestID: "host-auth", Payload: rawPayload(map[string]any{"role": "host", "hostToken": hostServer.hostToken})})
	readType(t, host, "room.state")
	writeEnvelope(t, host, protocol.Envelope{V: 1, Type: "host.createRoom", RequestID: "host-create", Payload: rawPayload(map[string]any{})})
	created := readType(t, host, "room.created")
	var invite struct {
		RoomID   string `json:"roomId"`
		RoomCode string `json:"roomCode"`
	}
	if err = json.Unmarshal(created.Payload, &invite); err != nil {
		t.Fatal(err)
	}
	if invite.RoomID == "" || invite.RoomCode == "" {
		t.Fatalf("host room creation returned incomplete invite: %#v", invite)
	}
	hostServer.lanMu.RLock()
	hostSignalPort := hostServer.lanPort
	lanListener := hostServer.lanListener
	var lanListenerAddr string
	if lanListener != nil {
		lanListenerAddr = lanListener.Addr().String()
	}
	hostServer.lanMu.RUnlock()
	if hostSignalPort <= 0 || lanListenerAddr == "" {
		t.Fatal("host server did not publish its LAN signal port")
	}

	viewerOrigin := "http://" + viewerLocal.Addr().String()
	viewerURL := "ws" + strings.TrimPrefix(viewerOrigin, "http") + "/ws/v1"
	connectViewer := func(authRequest, joinRequest string) *websocket.Conn {
		conn := dialAppLocal(t, viewerURL, viewerOrigin)
		writeEnvelope(t, conn, protocol.Envelope{V: 1, Type: "auth.hello", RequestID: authRequest, Payload: rawPayload(map[string]any{"role": "viewer"})})
		readType(t, conn, "room.state")
		writeEnvelope(t, conn, protocol.Envelope{V: 1, Type: "viewer.join", RequestID: joinRequest, Payload: rawPayload(map[string]any{
			"hostIPv4": ip, "hostPort": hostSignalPort, "roomCode": invite.RoomCode,
		})})
		joined := readUntilOptions(t, conn, "room.joined", "error")
		if joined.Type != "room.joined" {
			t.Fatalf("viewer join failed: %#v", joined)
		}
		return conn
	}

	viewerOne := connectViewer("viewer-one-auth", "viewer-one-join")
	viewerTwo := connectViewer("viewer-two-auth", "viewer-two-join")
	defer viewerTwo.Close(websocket.StatusNormalClosure, "test cleanup")
	readUntilType(t, host, "peer.joined")
	readUntilType(t, host, "peer.joined")

	if err = viewerOne.Close(websocket.StatusNormalClosure, "local viewer page closed"); err != nil {
		t.Fatalf("close first local viewer socket: %v", err)
	}
	left := readUntilType(t, host, "peer.left")
	if left.Payload == nil {
		t.Fatalf("viewer local socket close did not identify its departed peer: %#v", left)
	}
	deadline := time.Now().Add(time.Second)
	for {
		snapshot, ok := hostServer.Rooms().Get(invite.RoomID)
		if ok && len(snapshot.Members) == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("local viewer disconnect did not immediately reclaim its seat: %#v", snapshot)
		}
		time.Sleep(5 * time.Millisecond)
	}
	writeEnvelope(t, viewerTwo, protocol.Envelope{V: 1, Type: "heartbeat", RequestID: "surviving-viewer-heartbeat", Payload: rawPayload(map[string]any{})})
	if got := readUntilType(t, viewerTwo, "heartbeat"); got.RequestID != "surviving-viewer-heartbeat" {
		t.Fatalf("closing the other local viewer socket disrupted the surviving session: %#v", got)
	}

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 2*time.Second)
	err = hostServer.Shutdown(shutdownCtx)
	shutdownCancel()
	if err != nil {
		t.Fatalf("host server shutdown: %v", err)
	}
	ended := readUntilOptions(t, viewerTwo, "room.ended", "error")
	if ended.Type != "room.ended" || ended.RoomID != invite.RoomID {
		t.Fatalf("host shutdown did not deliver room.ended to the viewer before closing its bridge: %#v", ended)
	}
	localEnded := readUntilOptions(t, host, "room.ended", "error")
	if localEnded.Type != "room.ended" || localEnded.RoomID != invite.RoomID {
		t.Fatalf("host shutdown did not deliver room.ended to the local host session: %#v", localEnded)
	}
	quietCtx, quietCancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	_, raw, readErr := viewerTwo.Read(quietCtx)
	quietCancel()
	if readErr == nil {
		var next protocol.Envelope
		if err = protocol.Decode(raw, &next); err == nil && next.Type == "error" {
			var payload struct {
				Code      string `json:"code"`
				Retryable bool   `json:"retryable"`
			}
			_ = json.Unmarshal(next.Payload, &payload)
			if payload.Code == "SIGNAL_CONNECTION_LOST" && payload.Retryable {
				t.Fatalf("room.ended was followed by a retryable signal-loss error: %#v", next)
			}
		}
	}

	if _, ok := hostServer.Rooms().Get(invite.RoomID); ok {
		t.Fatal("host shutdown left the room active")
	}
	for label, addr := range map[string]string{"host localhost": hostLocal.Addr().String(), "host LAN": lanListenerAddr} {
		conn, dialErr := net.DialTimeout("tcp", addr, 150*time.Millisecond)
		if dialErr == nil {
			_ = conn.Close()
			t.Fatalf("%s listener remained open after host shutdown", label)
		}
	}
}

func TestHostShutdownBroadcastsRoomEndedBeforeClosingViewerBridge(t *testing.T) {
	ip := firstPrivateIPv4()
	if ip == "" {
		t.Skip("no private IPv4 available")
	}
	hostServer := New(Config{LANIPv4: ip, SignalPort: 0})
	hostLocal, err := hostServer.StartAtPort(context.Background(), 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = hostServer.Shutdown(context.Background()) }()
	viewerServer := New(Config{})
	viewerLocal, err := viewerServer.StartAtPort(context.Background(), 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = viewerServer.Shutdown(context.Background()) }()
	hostOrigin := "http://" + hostLocal.Addr().String()
	host := dialAppLocal(t, "ws"+strings.TrimPrefix(hostOrigin, "http")+"/ws/v1", hostOrigin)
	defer host.Close(websocket.StatusNormalClosure, "test cleanup")
	writeEnvelope(t, host, protocol.Envelope{V: 1, Type: "auth.hello", RequestID: "host-auth", Payload: rawPayload(map[string]any{"role": "host", "hostToken": hostServer.hostToken})})
	readType(t, host, "room.state")
	writeEnvelope(t, host, protocol.Envelope{V: 1, Type: "host.createRoom", RequestID: "host-create", Payload: rawPayload(map[string]any{})})
	created := readType(t, host, "room.created")
	var invite struct {
		RoomID   string `json:"roomId"`
		RoomCode string `json:"roomCode"`
	}
	if err = json.Unmarshal(created.Payload, &invite); err != nil {
		t.Fatal(err)
	}
	hostServer.lanMu.RLock()
	hostLANAddr := ""
	if hostServer.lanListener != nil {
		hostLANAddr = hostServer.lanListener.Addr().String()
	}
	hostServer.lanMu.RUnlock()
	if hostLANAddr == "" {
		t.Fatal("host LAN listener did not start")
	}

	viewerOrigin := "http://" + viewerLocal.Addr().String()
	viewer := dialAppLocal(t, "ws"+strings.TrimPrefix(viewerOrigin, "http")+"/ws/v1", viewerOrigin)
	defer viewer.Close(websocket.StatusNormalClosure, "test cleanup")
	writeEnvelope(t, viewer, protocol.Envelope{V: 1, Type: "auth.hello", RequestID: "viewer-auth", Payload: rawPayload(map[string]any{"role": "viewer"})})
	readType(t, viewer, "room.state")
	writeEnvelope(t, viewer, protocol.Envelope{V: 1, Type: "viewer.join", RequestID: "viewer-join", Payload: rawPayload(map[string]any{
		"hostIPv4": ip, "hostPort": hostServer.lanPort, "roomCode": invite.RoomCode,
	})})
	joined := readUntilOptions(t, viewer, "room.joined", "error")
	if joined.Type != "room.joined" {
		t.Fatalf("viewer join failed with %s", errorCodeFromPayload(t, joined))
	}
	readUntilType(t, host, "peer.joined")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	err = hostServer.Shutdown(shutdownCtx)
	cancel()
	if err != nil {
		t.Fatalf("host shutdown: %v", err)
	}
	ended := readUntilOptions(t, viewer, "room.ended", "error")
	if ended.Type != "room.ended" || ended.RoomID != invite.RoomID {
		t.Fatalf("expected room.ended before host socket closure, got type %q", ended.Type)
	}
	localEnded := readUntilOptions(t, host, "room.ended", "error")
	if localEnded.Type != "room.ended" || localEnded.RoomID != invite.RoomID {
		t.Fatalf("host shutdown did not deliver room.ended to the local host session: %#v", localEnded)
	}
	quietCtx, quietCancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	_, raw, readErr := viewer.Read(quietCtx)
	quietCancel()
	if readErr == nil {
		var next protocol.Envelope
		if protocol.Decode(raw, &next) == nil && next.Type == "error" {
			var payload struct {
				Code      string `json:"code"`
				Retryable bool   `json:"retryable"`
			}
			_ = json.Unmarshal(next.Payload, &payload)
			if payload.Code == "SIGNAL_CONNECTION_LOST" && payload.Retryable {
				t.Fatal("host shutdown followed room.ended with a retryable bridge-loss error")
			}
		}
	}
	if _, ok := hostServer.Rooms().Get(invite.RoomID); ok {
		t.Fatal("host shutdown left the room active")
	}
	for label, addr := range map[string]string{"host localhost": hostLocal.Addr().String(), "host LAN": hostLANAddr} {
		conn, dialErr := net.DialTimeout("tcp", addr, 150*time.Millisecond)
		if dialErr == nil {
			_ = conn.Close()
			t.Fatalf("%s listener remained open after host shutdown", label)
		}
	}
}

func TestViewerServerShutdownLeavesRoomWithoutEndingHostRoom(t *testing.T) {
	ip := firstPrivateIPv4()
	if ip == "" {
		t.Skip("no private IPv4 available")
	}
	hostServer := New(Config{LANIPv4: ip, SignalPort: 0})
	hostLocal, err := hostServer.StartAtPort(context.Background(), 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = hostServer.Shutdown(context.Background()) }()
	viewerServer := New(Config{})
	viewerLocal, err := viewerServer.StartAtPort(context.Background(), 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = viewerServer.Shutdown(context.Background()) }()

	hostOrigin := "http://" + hostLocal.Addr().String()
	host := dialAppLocal(t, "ws"+strings.TrimPrefix(hostOrigin, "http")+"/ws/v1", hostOrigin)
	defer host.Close(websocket.StatusNormalClosure, "test cleanup")
	writeEnvelope(t, host, protocol.Envelope{V: 1, Type: "auth.hello", RequestID: "host-auth", Payload: rawPayload(map[string]any{"role": "host", "hostToken": hostServer.hostToken})})
	readType(t, host, "room.state")
	writeEnvelope(t, host, protocol.Envelope{V: 1, Type: "host.createRoom", RequestID: "host-create", Payload: rawPayload(map[string]any{})})
	created := readType(t, host, "room.created")
	var invite struct{ RoomID, RoomCode string }
	if err = json.Unmarshal(created.Payload, &invite); err != nil {
		t.Fatal(err)
	}

	viewerOrigin := "http://" + viewerLocal.Addr().String()
	viewer := dialAppLocal(t, "ws"+strings.TrimPrefix(viewerOrigin, "http")+"/ws/v1", viewerOrigin)
	defer viewer.Close(websocket.StatusNormalClosure, "test cleanup")
	writeEnvelope(t, viewer, protocol.Envelope{V: 1, Type: "auth.hello", RequestID: "viewer-auth", Payload: rawPayload(map[string]any{"role": "viewer"})})
	readType(t, viewer, "room.state")
	hostServer.lanMu.RLock()
	hostPort := hostServer.lanPort
	hostServer.lanMu.RUnlock()
	writeEnvelope(t, viewer, protocol.Envelope{V: 1, Type: "viewer.join", RequestID: "viewer-join", Payload: rawPayload(map[string]any{
		"hostIPv4": ip, "hostPort": hostPort, "roomCode": invite.RoomCode,
	})})
	if joined := readUntilOptions(t, viewer, "room.joined", "error"); joined.Type != "room.joined" {
		t.Fatalf("viewer join failed with %s", errorCodeFromPayload(t, joined))
	}
	readUntilType(t, host, "peer.joined")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	err = viewerServer.Shutdown(shutdownCtx)
	cancel()
	if err != nil {
		t.Fatalf("viewer app shutdown: %v", err)
	}
	left := readUntilOptions(t, host, "peer.left", "room.ended")
	if left.Type != "peer.left" {
		t.Fatalf("viewer shutdown did not free its peer seat before closing listeners: %#v", left)
	}
	if _, ok := hostServer.Rooms().Get(invite.RoomID); !ok {
		t.Fatal("viewer shutdown ended the host's room")
	}
	snapshot, ok := hostServer.Rooms().Get(invite.RoomID)
	if !ok || len(snapshot.Members) != 1 || snapshot.Members[0].Role != "host" {
		t.Fatalf("viewer shutdown did not free only its own room seat: %#v", snapshot)
	}
}
