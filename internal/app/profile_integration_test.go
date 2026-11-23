package app

import (
	"context"
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"lan-screen-sharing/internal/protocol"
)

func TestViewerProfileSynchronizesAndSurvivesLocalSocketRecovery(t *testing.T) {
	ip := firstPrivateIPv4()
	if ip == "" {
		t.Skip("no private IPv4 interface")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	host := New(Config{LANIPv4: ip, PreferencesPath: filepath.Join(t.TempDir(), "host.json")})
	viewer := New(Config{LANIPv4: ip, PreferencesPath: filepath.Join(t.TempDir(), "viewer.json")})
	connect := func(server *Server, addr, role string) *websocket.Conn {
		t.Helper()
		conn := dialAppLocal(t, "ws://"+addr+"/ws/v1", "http://"+addr)
		t.Cleanup(func() { _ = conn.CloseNow() })
		auth := map[string]string{"role": role}
		if role == "host" {
			auth["hostToken"] = server.hostToken
		}
		writeEnvelope(t, conn, protocol.Envelope{V: 1, Type: "auth.hello", RequestID: "auth", Payload: rawPayload(auth)})
		readUntilType(t, conn, "room.state")
		return conn
	}
	hostAddr, err := host.Start(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = host.Shutdown(context.Background()) })
	viewerAddr, err := viewer.Start(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = viewer.Shutdown(context.Background()) })
	hostWS := connect(host, hostAddr.Addr().String(), "host")
	writeEnvelope(t, hostWS, protocol.Envelope{V: 1, Type: "host.createRoom", RequestID: "create",
		Payload: rawPayload(map[string]any{"nickname": "房主小雨", "avatarColor": "teal"})})
	created := readUntilType(t, hostWS, "room.created")
	var invitation struct {
		RoomCode string            `json:"roomCode"`
		Members  []protocol.Member `json:"members"`
	}
	if err := json.Unmarshal(created.Payload, &invitation); err != nil || len(invitation.Members) != 1 ||
		invitation.Members[0].Nickname != "房主小雨" || invitation.Members[0].AvatarColor != "teal" || invitation.Members[0].SeatIndex != 1 {
		t.Fatalf("host profile missing in create: %s %v", created.Payload, err)
	}
	host.lanMu.RLock()
	signalPort := host.lanPort
	host.lanMu.RUnlock()
	join := func(conn *websocket.Conn, resumeToken string) (protocol.Envelope, string, protocol.Member) {
		t.Helper()
		writeEnvelope(t, conn, protocol.Envelope{V: 1, Type: "viewer.join", RequestID: "join", Payload: rawPayload(protocol.JoinPayload{
			HostIPv4: ip, HostPort: signalPort, RoomCode: invitation.RoomCode, ResumeToken: resumeToken,
			Profile: protocol.Profile{Nickname: "  观\x00众🌙  ", AvatarColor: "invalid"},
		})})
		joined := readUntilType(t, conn, "room.joined")
		var payload struct {
			ResumeToken string            `json:"resumeToken"`
			Members     []protocol.Member `json:"members"`
		}
		if err := json.Unmarshal(joined.Payload, &payload); err != nil || payload.ResumeToken == "" || len(payload.Members) != 2 {
			t.Fatalf("invalid joined roster: %s %v", joined.Payload, err)
		}
		return joined, payload.ResumeToken, payload.Members[1]
	}
	viewerWS := connect(viewer, viewerAddr.Addr().String(), "viewer")
	joined, resumeToken, before := join(viewerWS, "")
	if before.PeerID != joined.PeerID || before.Nickname != "观众🌙" || before.AvatarColor != "blue" || before.SeatIndex != 2 {
		t.Fatalf("join did not carry normalized profile and seat: %+v", before)
	}
	peerJoined := readUntilType(t, hostWS, "peer.joined")
	var remoteMember protocol.Member
	if json.Unmarshal(peerJoined.Payload, &remoteMember) != nil || remoteMember != before {
		t.Fatalf("host received different joined profile: %s", peerJoined.Payload)
	}
	if w := switchTestNetwork(viewer, ip); w.Code != http.StatusConflict {
		t.Fatalf("joined viewer was allowed to change networks: %d %s", w.Code, w.Body)
	}
	profile := rawPayload(protocol.Profile{Nickname: "夜航", AvatarColor: "pink"})
	writeEnvelope(t, viewerWS, protocol.Envelope{V: 1, Type: "peer.profile", RequestID: "impersonate", RoomID: created.RoomID, PeerID: created.PeerID, Payload: profile})
	if rejected := readUntilType(t, viewerWS, "error"); !strings.Contains(string(rejected.Payload), "AUTH_REQUIRED") {
		t.Fatalf("viewer impersonation was not rejected: %s", rejected.Payload)
	}
	writeEnvelope(t, viewerWS, protocol.Envelope{V: 1, Type: "peer.profile", RequestID: "edit", RoomID: created.RoomID, Payload: profile})
	for _, conn := range []*websocket.Conn{hostWS, viewerWS} {
		update := readUntilType(t, conn, "peer.profile")
		var current protocol.ProfileUpdate
		if json.Unmarshal(update.Payload, &current) != nil || current.Nickname != "夜航" || current.AvatarColor != "pink" ||
			current.ProfileRevision <= before.ProfileRevision || update.PeerID != joined.PeerID {
			t.Fatalf("unexpected synchronized profile: %+v %s", update, update.Payload)
		}
	}
	if err := viewerWS.CloseNow(); err != nil {
		t.Fatal(err)
	}
	readUntilType(t, hostWS, "peer.state")
	if w := switchTestNetwork(viewer, ip); w.Code != http.StatusConflict {
		t.Fatalf("recovering viewer was allowed to change networks: %d %s", w.Code, w.Body)
	}
	resumedWS := connect(viewer, viewerAddr.Addr().String(), "viewer")
	_, rotatedToken, after := join(resumedWS, resumeToken)
	if after.PeerID != before.PeerID || after.SeatIndex != before.SeatIndex || after.Nickname != "夜航" ||
		after.AvatarColor != "pink" || rotatedToken == resumeToken {
		t.Fatalf("recovery changed stable identity: before=%+v after=%+v", before, after)
	}
	writeEnvelope(t, resumedWS, protocol.Envelope{V: 1, Type: "viewer.leave", RequestID: "leave", RoomID: created.RoomID, Payload: rawPayload(map[string]any{})})
	readUntilType(t, resumedWS, "peer.left")
	if err := viewer.hub.WithIdleNetwork(func() error { return nil }); err != nil {
		t.Fatalf("explicit leave did not clear network reservation: %v", err)
	}
	writeEnvelope(t, hostWS, protocol.Envelope{V: 1, Type: "host.endRoom", RequestID: "end", RoomID: created.RoomID, Payload: rawPayload(map[string]any{})})
	readUntilType(t, hostWS, "room.ended")
}
