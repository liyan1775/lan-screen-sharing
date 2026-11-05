package signal

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"lan-screen-sharing/internal/protocol"
	"lan-screen-sharing/internal/room"
)

func TestRejectPublicLoopbackAndInvalidHostTarget(t *testing.T) {
	for _, addr := range []string{"127.0.0.1", "::1", "8.8.8.8", "169.254.1.1", "not-ip"} {
		if err := ValidateHostTarget(addr, 8080); err == nil {
			t.Fatalf("accepted %q", addr)
		}
	}
	if err := ValidateHostTarget("192.168.1.10", 0); protocol.ErrorCode(err) != "INVALID_PORT" {
		t.Fatalf("bad port: %v", err)
	}
}

func TestServeLANLimitsFailedRoomCodeAttemptsByRemoteIP(t *testing.T) {
	hub := NewHub(room.NewManager())
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := Accept(w, r)
		if err == nil {
			hub.ServeLAN(r.Context(), conn)
		}
	}))
	defer server.Close()
	for attempt := 1; attempt <= 6; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		headers := http.Header{"X-Forwarded-For": []string{"198.51.100." + strconv.Itoa(attempt)}}
		conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), &websocket.DialOptions{HTTPHeader: headers})
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		payload, _ := json.Marshal(map[string]any{"roomCode": "BADCODE0"})
		if err = conn.Write(ctx, websocket.MessageText, mustJSON(protocol.Envelope{V: 1, Type: "signal.join", RequestID: "attempt-" + strconv.Itoa(attempt), Payload: payload})); err != nil {
			cancel()
			t.Fatal(err)
		}
		_, data, err := conn.Read(ctx)
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		var response protocol.Envelope
		if err = protocol.Decode(data, &response); err != nil {
			cancel()
			t.Fatal(err)
		}
		_ = conn.Close(websocket.StatusNormalClosure, "done")
		cancel()
		if response.Type != "error" {
			t.Fatalf("attempt %d got %q, expected an error", attempt, response.Type)
		}
		var p struct {
			Code      string `json:"code"`
			Retryable bool   `json:"retryable"`
		}
		if err = json.Unmarshal(response.Payload, &p); err != nil {
			t.Fatal(err)
		}
		if attempt <= 5 && p.Code == "RATE_LIMITED" {
			t.Fatalf("attempt %d was limited before the configured failure threshold: %#v", attempt, p)
		}
		if attempt == 6 && (p.Code != "RATE_LIMITED" || !p.Retryable) {
			t.Fatalf("sixth failed room code should be retryable RATE_LIMITED, got %#v", p)
		}
	}
}

func TestServeLANAllowsValidResumeAfterFailedRoomCodeLimit(t *testing.T) {
	manager := room.NewManager()
	hostRoom, _, err := manager.CreateHost()
	if err != nil {
		t.Fatal(err)
	}
	hub := NewHub(manager)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, acceptErr := Accept(w, r)
		if acceptErr == nil {
			hub.ServeLAN(r.Context(), conn)
		}
	}))
	defer server.Close()

	initialConn, initial := lanJoinRequest(t, server.URL, hostRoom.Code, "")
	if initial.Type != "room.joined" {
		t.Fatalf("initial join failed: %#v", initial)
	}
	var initialSession struct {
		PeerID      string `json:"peerId"`
		ResumeToken string `json:"resumeToken"`
	}
	if err = json.Unmarshal(initial.Payload, &initialSession); err != nil {
		t.Fatal(err)
	}
	_ = initialConn.Close(websocket.StatusNormalClosure, "simulate browser reconnect")
	deadline := time.Now().Add(time.Second)
	for {
		snapshot, ok := manager.Get(hostRoom.ID)
		if ok && hasMemberState(snapshot, initialSession.PeerID, "reconnecting") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("viewer seat was not reserved for resume: %#v", snapshot)
		}
		time.Sleep(5 * time.Millisecond)
	}
	for attempt := 1; attempt <= maxFailedJoinsPerIP; attempt++ {
		conn, response := lanJoinRequest(t, server.URL, "BADCODE0", "")
		_ = conn.Close(websocket.StatusNormalClosure, "failed attempt")
		if response.Type != "error" {
			t.Fatalf("failed room code attempt %d was accepted: %#v", attempt, response)
		}
	}
	resumedConn, resumed := lanJoinRequest(t, server.URL, hostRoom.Code, initialSession.ResumeToken)
	defer resumedConn.Close(websocket.StatusNormalClosure, "done")
	if resumed.Type != "room.joined" || resumed.PeerID != initialSession.PeerID {
		t.Fatalf("valid resume was blocked by failed room-code attempts: %#v", resumed)
	}
}

func lanJoinRequest(t *testing.T, serverURL, roomCode, resumeToken string) (*websocket.Conn, protocol.Envelope) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(serverURL, "http")+"/signal/v1", nil)
	if err != nil {
		t.Fatal(err)
	}
	payload := map[string]any{"roomCode": roomCode}
	if resumeToken != "" {
		payload["resumeToken"] = resumeToken
	}
	if err = conn.Write(ctx, websocket.MessageText, mustJSON(protocol.Envelope{V: 1, Type: "signal.join", RequestID: "join", Payload: raw(payload)})); err != nil {
		_ = conn.Close(websocket.StatusInternalError, "write failed")
		t.Fatal(err)
	}
	_, data, err := conn.Read(ctx)
	if err != nil {
		_ = conn.Close(websocket.StatusInternalError, "read failed")
		t.Fatal(err)
	}
	var response protocol.Envelope
	if err = protocol.Decode(data, &response); err != nil {
		_ = conn.Close(websocket.StatusInternalError, "decode failed")
		t.Fatal(err)
	}
	return conn, response
}

func TestBridgeDropNotifiesAndResumesOnSameLocalSocket(t *testing.T) {
	ip := privateIPv4ForTest(t)
	hostRooms := room.NewManager()
	hostRoom, _, err := hostRooms.CreateHost()
	if err != nil {
		t.Fatal(err)
	}
	nextRoom, _, err := hostRooms.CreateHost()
	if err != nil {
		t.Fatal(err)
	}
	fakeHost := startFakeLANHost(t, ip, hostRooms)
	defer fakeHost.close()

	hub := NewHub(room.NewManager())
	localServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, acceptErr := Accept(w, r)
		if acceptErr != nil {
			return
		}
		hub.ServeLocal(r.Context(), conn, "local-host-token")
	}))
	defer localServer.Close()
	localURL := "ws" + strings.TrimPrefix(localServer.URL, "http") + "/ws/v1"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	localConn, _, err := websocket.Dial(ctx, localURL, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{localServer.URL}}})
	if err != nil {
		t.Fatal(err)
	}
	defer localConn.Close(websocket.StatusNormalClosure, "test done")
	writeTestEnvelope(t, ctx, localConn, protocol.Envelope{V: 1, Type: "auth.hello", RequestID: "auth-viewer", Payload: json.RawMessage(`{"role":"viewer"}`)})
	if got := readTestEnvelope(t, ctx, localConn); got.Type != "room.state" {
		t.Fatalf("auth ack: %#v", got)
	}
	join := func(requestID, resumeToken string, roomCodes ...string) protocol.Envelope {
		code := hostRoom.Code
		if len(roomCodes) > 0 {
			code = roomCodes[0]
		}
		payload := map[string]any{"hostIPv4": ip, "hostPort": fakeHost.port, "roomCode": code}
		if resumeToken != "" {
			payload["resumeToken"] = resumeToken
		}
		b, _ := json.Marshal(payload)
		writeTestEnvelope(t, ctx, localConn, protocol.Envelope{V: 1, Type: "viewer.join", RequestID: requestID, Payload: b})
		return readTestEnvelope(t, ctx, localConn)
	}
	joined := join("join-initial", "")
	if joined.Type != "room.joined" {
		t.Fatalf("initial join: %#v", joined)
	}
	var first struct {
		PeerID      string `json:"peerId"`
		ResumeToken string `json:"resumeToken"`
	}
	if err = json.Unmarshal(joined.Payload, &first); err != nil {
		t.Fatal(err)
	}
	fakeHost.dropPeer(first.PeerID)
	lost := readTestEnvelope(t, ctx, localConn)
	if lost.Type != "error" {
		t.Fatalf("bridge loss was not reported: %#v", lost)
	}
	var lostPayload struct {
		Code      string `json:"code"`
		Retryable bool   `json:"retryable"`
	}
	if err = json.Unmarshal(lost.Payload, &lostPayload); err != nil {
		t.Fatal(err)
	}
	if lostPayload.Code != "SIGNAL_CONNECTION_LOST" || !lostPayload.Retryable {
		t.Fatalf("wrong bridge-loss contract: %#v", lostPayload)
	}
	state, ok := hostRooms.Get(hostRoom.ID)
	if !ok || !hasMemberState(state, first.PeerID, "reconnecting") {
		t.Fatalf("bridge loss released or failed to reserve the remote seat: %#v", state)
	}

	rejoined := join("join-resume", first.ResumeToken)
	if rejoined.Type != "room.joined" || rejoined.PeerID != first.PeerID {
		t.Fatalf("resume did not retain identity: %#v", rejoined)
	}
	var rotated struct {
		ResumeToken string `json:"resumeToken"`
	}
	if err = json.Unmarshal(rejoined.Payload, &rotated); err != nil {
		t.Fatal(err)
	}
	if rotated.ResumeToken == "" || rotated.ResumeToken == first.ResumeToken {
		t.Fatal("resume token was not rotated")
	}
	state, ok = hostRooms.Get(hostRoom.ID)
	if !ok || !hasMemberState(state, first.PeerID, "connected") {
		t.Fatalf("resumed peer is not connected: %#v", state)
	}

	fakeHost.dropPeer(first.PeerID)
	if e := readTestEnvelope(t, ctx, localConn); e.Type != "error" {
		t.Fatalf("second bridge loss was not reported: %#v", e)
	}
	writeTestEnvelope(t, ctx, localConn, protocol.Envelope{V: 1, Type: "viewer.leave", RequestID: "leave-after-loss", RoomID: hostRoom.ID, Payload: json.RawMessage(`{}`)})
	left := readTestEnvelope(t, ctx, localConn)
	if left.Type != "peer.left" || left.RequestID != "leave-after-loss" {
		t.Fatalf("lost bridge leave response: %#v", left)
	}
	state, ok = hostRooms.Get(hostRoom.ID)
	if !ok || len(state.Members) != 1 {
		t.Fatalf("best-effort leave did not reclaim the reserved seat: %#v", state)
	}
	if _, _, err = hostRooms.Join(hostRoom.Code, rotated.ResumeToken); err == nil {
		t.Fatal("lost bridge leave left the resume token valid")
	}
	joinedNext := join("join-next-room", "", nextRoom.Code)
	if joinedNext.Type != "room.joined" || joinedNext.RoomID != nextRoom.ID {
		t.Fatalf("lost bridge leave blocked a different room: %#v", joinedNext)
	}
}

func TestLostBridgeLeaveWithStaleTokenClearsSessionForAnotherRoom(t *testing.T) {
	ip := privateIPv4ForTest(t)
	hostRooms := room.NewManager()
	oldRoom, _, err := hostRooms.CreateHost()
	if err != nil {
		t.Fatal(err)
	}
	newRoom, _, err := hostRooms.CreateHost()
	if err != nil {
		t.Fatal(err)
	}
	fakeHost := startFakeLANHost(t, ip, hostRooms)
	defer fakeHost.close()

	hub := NewHub(room.NewManager())
	localServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, acceptErr := Accept(w, r)
		if acceptErr == nil {
			hub.ServeLocal(r.Context(), conn, "local-host-token")
		}
	}))
	defer localServer.Close()
	localURL := "ws" + strings.TrimPrefix(localServer.URL, "http") + "/ws/v1"
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	localConn, _, err := websocket.Dial(ctx, localURL, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{localServer.URL}}})
	if err != nil {
		t.Fatal(err)
	}
	defer localConn.Close(websocket.StatusNormalClosure, "test done")
	writeTestEnvelope(t, ctx, localConn, protocol.Envelope{V: 1, Type: "auth.hello", RequestID: "auth", Payload: json.RawMessage(`{"role":"viewer"}`)})
	if e := readTestEnvelope(t, ctx, localConn); e.Type != "room.state" {
		t.Fatalf("auth ack: %#v", e)
	}
	join := func(requestID, code, token string) protocol.Envelope {
		payload := map[string]any{"hostIPv4": ip, "hostPort": fakeHost.port, "roomCode": code}
		if token != "" {
			payload["resumeToken"] = token
		}
		b, _ := json.Marshal(payload)
		writeTestEnvelope(t, ctx, localConn, protocol.Envelope{V: 1, Type: "viewer.join", RequestID: requestID, Payload: b})
		return readTestEnvelope(t, ctx, localConn)
	}
	joined := join("join-old", oldRoom.Code, "")
	if joined.Type != "room.joined" {
		t.Fatalf("initial join: %#v", joined)
	}
	var session struct {
		PeerID string `json:"peerId"`
	}
	if err = json.Unmarshal(joined.Payload, &session); err != nil {
		t.Fatal(err)
	}
	// Invalidate the resume credential while the old bridge is still live, then
	// simulate its loss so leave must tolerate a stale token.
	hostRooms.Leave(oldRoom.ID, session.PeerID)
	fakeHost.dropPeer(session.PeerID)
	if e := readTestEnvelope(t, ctx, localConn); e.Type != "error" {
		t.Fatalf("expected bridge-loss notification, got %#v", e)
	}
	writeTestEnvelope(t, ctx, localConn, protocol.Envelope{V: 1, Type: "viewer.leave", RequestID: "leave-stale", RoomID: oldRoom.ID, Payload: json.RawMessage(`{}`)})
	left := readTestEnvelope(t, ctx, localConn)
	if left.Type != "peer.left" || left.RequestID != "leave-stale" {
		t.Fatalf("leave did not clear the local session: %#v", left)
	}
	joinedNew := join("join-new-room", newRoom.Code, "")
	if joinedNew.Type != "room.joined" || joinedNew.RoomID != newRoom.ID {
		t.Fatalf("stale bridge session blocked joining another room: %#v", joinedNew)
	}
}

func TestLeaveWriteFailureLeavesPeerLeftAsOnlyCorrelatedResponse(t *testing.T) {
	h := NewHub(room.NewManager())
	dialCount := 0
	h.dial = func(context.Context, string) (*Connection, error) {
		dialCount++
		if dialCount > 1 {
			return nil, errors.New("remote host unavailable after write failure")
		}
		joinedPayload, _ := json.Marshal(map[string]any{"roomId": "remote-room", "peerId": "viewer-peer", "resumeToken": "resume-token", "members": []any{}})
		joinedEnvelope := mustJSON(protocol.Envelope{V: 1, Type: "room.joined", RequestID: "join-request", RoomID: "remote-room", PeerID: "viewer-peer", Payload: joinedPayload})
		readFirst := true
		return &Connection{
			read: func(ctx context.Context) ([]byte, error) {
				if readFirst {
					readFirst = false
					return joinedEnvelope, nil
				}
				<-ctx.Done()
				return nil, ctx.Err()
			},
			write: func(_ context.Context, data []byte) error {
				var message protocol.Envelope
				if err := protocol.Decode(data, &message); err != nil {
					return err
				}
				if message.Type == "signal.leave" {
					return errors.New("simulated failed leave write")
				}
				return nil
			},
			close: func() {},
		}, nil
	}
	localServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := Accept(w, r)
		if err == nil {
			h.ServeLocal(r.Context(), conn, "host-token")
		}
	}))
	defer localServer.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	localURL := "ws" + strings.TrimPrefix(localServer.URL, "http")
	conn, _, err := websocket.Dial(ctx, localURL, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{localServer.URL}}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "test done")
	writeTestEnvelope(t, ctx, conn, protocol.Envelope{V: 1, Type: "auth.hello", RequestID: "auth", Payload: json.RawMessage(`{"role":"viewer"}`)})
	if got := readTestEnvelope(t, ctx, conn); got.Type != "room.state" {
		t.Fatalf("auth response: %#v", got)
	}
	writeTestEnvelope(t, ctx, conn, protocol.Envelope{V: 1, Type: "viewer.join", RequestID: "join-request", Payload: json.RawMessage(`{"hostIPv4":"192.168.1.10","hostPort":12345,"roomCode":"ABCD2345"}`)})
	if got := readTestEnvelope(t, ctx, conn); got.Type != "room.joined" {
		t.Fatalf("join response: %#v", got)
	}
	writeTestEnvelope(t, ctx, conn, protocol.Envelope{V: 1, Type: "viewer.leave", RequestID: "leave-request", RoomID: "remote-room", Payload: json.RawMessage(`{}`)})
	lost := readTestEnvelope(t, ctx, conn)
	if lost.Type != "error" || lost.RequestID != "" {
		t.Fatalf("transport-loss notification must not correlate with leave: %#v", lost)
	}
	left := readTestEnvelope(t, ctx, conn)
	if left.Type != "peer.left" || left.RequestID != "leave-request" {
		t.Fatalf("failed leave must have one correlated peer.left response; got %#v", left)
	}
}

type fakeLANHost struct {
	listener    net.Listener
	server      *http.Server
	port        int
	rooms       *room.Manager
	mu          sync.Mutex
	connections map[string]*websocket.Conn
}

func startFakeLANHost(t *testing.T, ip string, manager *room.Manager) *fakeLANHost {
	t.Helper()
	listener, err := net.Listen("tcp4", net.JoinHostPort(ip, "0"))
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeLANHost{listener: listener, port: listener.Addr().(*net.TCPAddr).Port, rooms: manager, connections: map[string]*websocket.Conn{}}
	f.server = &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/signal/v1" {
			http.NotFound(w, r)
			return
		}
		rawConn, acceptErr := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if acceptErr != nil {
			return
		}
		defer rawConn.Close(websocket.StatusNormalClosure, "done")
		rawConn.SetReadLimit(protocol.MaxMessageBytes)
		_, data, readErr := rawConn.Read(r.Context())
		if readErr != nil {
			return
		}
		var hello protocol.Envelope
		if protocol.Decode(data, &hello) != nil || hello.Type != "signal.join" {
			return
		}
		var payload struct {
			RoomCode    string `json:"roomCode"`
			ResumeToken string `json:"resumeToken"`
		}
		if json.Unmarshal(hello.Payload, &payload) != nil {
			return
		}
		peerSession, snapshot, joinErr := manager.Join(payload.RoomCode, payload.ResumeToken)
		if joinErr != nil {
			return
		}
		f.mu.Lock()
		f.connections[peerSession.PeerID] = rawConn
		f.mu.Unlock()
		responsePayload, _ := json.Marshal(map[string]any{"roomId": snapshot.ID, "peerId": peerSession.PeerID, "resumeToken": peerSession.ResumeToken, "members": snapshot.Members})
		response, _ := json.Marshal(protocol.Envelope{V: 1, Type: "room.joined", RequestID: hello.RequestID, RoomID: snapshot.ID, PeerID: peerSession.PeerID, Payload: responsePayload})
		if rawConn.Write(r.Context(), websocket.MessageText, response) != nil {
			return
		}
		for {
			_, data, readErr = rawConn.Read(r.Context())
			if readErr != nil {
				manager.Disconnect(snapshot.ID, peerSession.PeerID)
				return
			}
			var msg protocol.Envelope
			if protocol.Decode(data, &msg) != nil {
				return
			}
			if msg.Type == "signal.leave" {
				manager.Leave(snapshot.ID, peerSession.PeerID)
				return
			}
		}
	})}
	go func() { _ = f.server.Serve(listener) }()
	return f
}
func (f *fakeLANHost) dropPeer(peerID string) {
	f.mu.Lock()
	conn := f.connections[peerID]
	f.mu.Unlock()
	if conn != nil {
		_ = conn.Close(websocket.StatusInternalError, "simulated LAN loss")
	}
}
func (f *fakeLANHost) close() { _ = f.server.Close(); _ = f.listener.Close() }
func privateIPv4ForTest(t *testing.T) string {
	t.Helper()
	ifs, err := net.Interfaces()
	if err != nil {
		t.Fatal(err)
	}
	for _, iface := range ifs {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := iface.Addrs()
		for _, addr := range addrs {
			var ip net.IP
			switch v := addr.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip == nil || ip.To4() == nil {
				continue
			}
			parsed, parseErr := netip.ParseAddr(ip.To4().String())
			if parseErr == nil && parsed.IsPrivate() && !parsed.IsLinkLocalUnicast() {
				return parsed.String()
			}
		}
	}
	t.Skip("no private IPv4 available")
	return ""
}
func writeTestEnvelope(t *testing.T, ctx context.Context, conn *websocket.Conn, e protocol.Envelope) {
	t.Helper()
	data, err := json.Marshal(e)
	if err != nil {
		t.Fatal(err)
	}
	if err = conn.Write(ctx, websocket.MessageText, data); err != nil {
		t.Fatal(err)
	}
}
func readTestEnvelope(t *testing.T, ctx context.Context, conn *websocket.Conn) protocol.Envelope {
	t.Helper()
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var e protocol.Envelope
	if err = protocol.Decode(data, &e); err != nil {
		t.Fatalf("invalid event: %v: %s", err, data)
	}
	return e
}
func hasMemberState(s room.RoomSnapshot, peerID, state string) bool {
	for _, member := range s.Members {
		if member.PeerID == peerID && member.State == state {
			return true
		}
	}
	return false
}

func TestRejectArbitraryPathAndOversizedFrame(t *testing.T) {
	if ValidateSignalPath("/proxy") == nil {
		t.Fatal("arbitrary path accepted")
	}
	if err := protocol.Decode([]byte(`{"v":1,"type":"heartbeat","requestId":"x","payload":{}`+string(make([]byte, protocol.MaxMessageBytes))+`}`), new(protocol.Envelope)); err == nil {
		t.Fatal("oversized frame accepted")
	}
}

func TestRoomOnlySignalRouting(t *testing.T) {
	m := room.NewManager()
	r, _, _ := m.CreateHost()
	a, _, _ := m.Join(r.Code, "")
	b, _, _ := m.Join(r.Code, "")
	msg := protocol.Envelope{V: 1, Type: "rtc.candidate", RequestID: "x", Payload: []byte(`{"toPeerId":"` + b.PeerID + `","candidate":{"candidate":"candidate:1"}}`)}
	if err := m.Route(r.ID, a.PeerID, b.PeerID, room.SignalMessage{Type: msg.Type, Payload: msg.Payload}); err != nil {
		t.Fatal(err)
	}
	if err := m.Route(r.ID, a.PeerID, "other-room-peer", room.SignalMessage{Type: msg.Type, Payload: msg.Payload}); protocol.ErrorCode(err) != "SIGNAL_TARGET_NOT_MEMBER" {
		t.Fatalf("cross-room signal: %v", err)
	}
}

func TestViewerToViewerSignalViaHost(t *testing.T) {
	h := NewHub(room.NewManager())
	r, _, _ := h.rooms.CreateHost()
	a, _, _ := h.rooms.Join(r.Code, "")
	b, _, _ := h.rooms.Join(r.Code, "")
	msg := protocol.Envelope{V: 1, Type: "rtc.description", RequestID: "offer", Payload: []byte(`{"toPeerId":"` + b.PeerID + `","description":{"type":"offer","sdp":"v=0"},"tracks":[{"mid":"0","role":"microphone"}]}`)}
	routed, err := h.RouteFrom(r.ID, a.PeerID, msg)
	if err != nil {
		t.Fatal(err)
	}
	if routed.PeerID != b.PeerID || routed.Type != "rtc.description" {
		t.Fatalf("bad relay: %#v", routed)
	}
}

func TestDisconnectedPeerCannotSignal(t *testing.T) {
	m := room.NewManager()
	r, _, _ := m.CreateHost()
	a, _, _ := m.Join(r.Code, "")
	b, _, _ := m.Join(r.Code, "")
	m.Disconnect(r.ID, a.PeerID)
	msg := protocol.Envelope{V: 1, Type: "rtc.candidate", Payload: []byte(`{"toPeerId":"` + b.PeerID + `","candidate":{"candidate":"candidate:1"}}`)}
	if err := m.Route(r.ID, a.PeerID, b.PeerID, room.SignalMessage{Type: msg.Type, Payload: msg.Payload}); err == nil {
		t.Fatal("disconnected peer signaled")
	}
}

func TestScreenSignalsAreBoundToCurrentPresenterAndRoomMembership(t *testing.T) {
	h := NewHub(room.NewManager())
	r, _, _ := h.rooms.CreateHost()
	a, _, _ := h.rooms.Join(r.Code, "")
	b, _, _ := h.rooms.Join(r.Code, "")
	hostID := r.Members[0].PeerID
	if _, err := h.rooms.ClaimPresentation(r.ID, a.PeerID); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ kind, from, to, description, want string }{
		{"screen.ready", a.PeerID, hostID, "", ""},
		{"screen.ready", hostID, b.PeerID, "", "SHARE_NOT_OWNER"},
		{"screen.description", hostID, a.PeerID, "offer", ""},
		{"screen.description", a.PeerID, b.PeerID, "answer", ""},
		{"screen.description", hostID, b.PeerID, "offer", "SHARE_NOT_OWNER"},
		{"screen.description", b.PeerID, a.PeerID, "answer", "SHARE_NOT_OWNER"},
		{"screen.ready", a.PeerID, "other-room-peer", "", "SIGNAL_TARGET_NOT_MEMBER"},
	} {
		payload := map[string]any{"toPeerId": tc.to, "epoch": "capture-1"}
		if tc.description != "" {
			payload["description"] = map[string]string{"type": tc.description, "sdp": "v=0"}
		}
		msg := protocol.Envelope{V: 1, Type: tc.kind, PeerID: "forged-envelope-peer", RequestID: "screen", Payload: mustJSON(payload)}
		routed, err := h.RouteFrom(r.ID, tc.from, msg)
		if got := protocol.ErrorCode(err); got != tc.want {
			t.Fatalf("%s %s -> %s: %q, want %q", tc.kind, tc.from, tc.to, got, tc.want)
		}
		if err != nil {
			continue
		}
		var received map[string]any
		_ = json.Unmarshal(routed.Payload, &received)
		if received["fromPeerId"] != tc.from || received["toPeerId"] != nil || routed.PeerID != tc.to {
			t.Fatalf("screen sender was not bound to the authenticated connection: %#v", received)
		}
	}
	h.rooms.Disconnect(r.ID, b.PeerID)
	msg := protocol.Envelope{V: 1, Type: "screen.ready", RequestID: "screen", Payload: mustJSON(map[string]string{"toPeerId": b.PeerID, "epoch": "capture-1"})}
	if _, err := h.RouteFrom(r.ID, a.PeerID, msg); protocol.ErrorCode(err) != "SIGNAL_TARGET_NOT_MEMBER" {
		t.Fatalf("disconnected viewer received screen signaling: %v", err)
	}
}
