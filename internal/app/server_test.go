package app

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"lan-screen-sharing/internal/protocol"
)

func TestBootstrapOnlyReturnsHostTokenOnLoopback(t *testing.T) {
	s := New(Config{})
	h := s.Handler()
	local := httptest.NewRequest("GET", "http://127.0.0.1/api/v1/bootstrap?role=host", nil)
	local.RemoteAddr = "127.0.0.1:1234"
	local.Host = "127.0.0.1"
	local.Header.Set("Origin", "http://127.0.0.1")
	r := httptest.NewRecorder()
	h.ServeHTTP(r, local)
	if r.Code != 200 || !strings.Contains(r.Body.String(), "hostControlToken") {
		t.Fatalf("loopback bootstrap: %d %s", r.Code, r.Body.String())
	}
	lan := httptest.NewRequest("GET", "http://127.0.0.1/api/v1/bootstrap?role=host", nil)
	lan.RemoteAddr = "192.168.1.2:1234"
	r = httptest.NewRecorder()
	h.ServeHTTP(r, lan)
	if r.Code == 200 && strings.Contains(r.Body.String(), "hostControlToken") {
		t.Fatal("LAN bootstrap leaked host credential")
	}
}

func TestBootstrapAllowsSameOriginBrowserFetchWithoutOriginHeader(t *testing.T) {
	s := New(Config{})
	r := httptest.NewRequest("GET", "http://127.0.0.1:8080/api/v1/bootstrap?role=host", nil)
	r.RemoteAddr = "127.0.0.1:1234"
	r.Host = "127.0.0.1:8080"
	r.Header.Set("Sec-Fetch-Site", "same-origin")
	r.Header.Set("Referer", "http://127.0.0.1:8080/")
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "hostControlToken") {
		t.Fatalf("same-origin fetch bootstrap: %d %s", w.Code, w.Body.String())
	}
	r.Header.Set("Referer", "http://127.0.0.1:8081/")
	w = httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code == http.StatusOK && strings.Contains(w.Body.String(), "hostControlToken") {
		t.Fatal("mismatched Referer received host token")
	}
}

func TestHostCreateRoomReportsLANBindFailureAndCanRetry(t *testing.T) {
	ip := firstPrivateIPv4()
	if ip == "" {
		t.Skip("no private IPv4 available")
	}
	occupied, err := net.Listen("tcp4", net.JoinHostPort(ip, "0"))
	if err != nil {
		t.Fatal(err)
	}
	port := occupied.Addr().(*net.TCPAddr).Port
	s := New(Config{LANIPv4: ip, SignalPort: port})
	ctx, cancel := context.WithCancel(context.Background())
	local, err := s.Start(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { cancel(); _ = s.Shutdown(context.Background()) }()
	localURL := "ws://" + local.Addr().String() + "/ws/v1"
	origin := "http://" + local.Addr().String()
	host := dialAppLocal(t, localURL, origin)
	defer host.Close(websocket.StatusNormalClosure, "test complete")
	writeEnvelope(t, host, protocol.Envelope{V: 1, Type: "auth.hello", RequestID: "auth", Payload: rawPayload(map[string]any{"role": "host", "hostToken": s.hostToken})})
	readType(t, host, "room.state")
	writeEnvelope(t, host, protocol.Envelope{V: 1, Type: "host.createRoom", RequestID: "create-fails", Payload: rawPayload(map[string]any{})})
	failed := readUntilOptions(t, host, "error", "room.created")
	if failed.Type != "error" || errorCodeFromPayload(t, failed) != "PORT_IN_USE" {
		t.Fatalf("LAN bind failure was not returned to the host: %#v", failed)
	}
	_ = occupied.Close()
	writeEnvelope(t, host, protocol.Envelope{V: 1, Type: "host.createRoom", RequestID: "create-retry", Payload: rawPayload(map[string]any{})})
	created := readUntilOptions(t, host, "error", "room.created")
	if created.Type != "room.created" {
		t.Fatalf("create did not recover after releasing the LAN port: %#v", created)
	}
	request := httptest.NewRequest("GET", origin+"/api/v1/bootstrap?role=host", nil)
	request.RemoteAddr = "127.0.0.1:1234"
	request.Host = local.Addr().String()
	request.Header.Set("Origin", origin)
	response := httptest.NewRecorder()
	s.Handler().ServeHTTP(response, request)
	var bootstrap Bootstrap
	if err = json.Unmarshal(response.Body.Bytes(), &bootstrap); err != nil {
		t.Fatal(err)
	}
	if bootstrap.LANIPv4 != ip || bootstrap.SignalPort != port {
		t.Fatalf("retry did not publish the bound invite endpoint: %#v", bootstrap)
	}
}

func TestViewerBootstrapOmitsHostCredential(t *testing.T) {
	s := New(Config{LANIPv4: "192.168.1.20", SignalPort: 9000})
	r := httptest.NewRequest("GET", "http://127.0.0.1:8080/api/v1/bootstrap?role=viewer", nil)
	r.RemoteAddr = "127.0.0.1:1234"
	r.Host = "127.0.0.1:8080"
	r.Header.Set("Origin", "http://127.0.0.1:8080")
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	var bootstrap Bootstrap
	if err := json.Unmarshal(w.Body.Bytes(), &bootstrap); err != nil {
		t.Fatal(err)
	}
	if bootstrap.HostControlToken != "" || bootstrap.LANIPv4 != "" || bootstrap.SignalPort != 0 {
		t.Fatalf("viewer bootstrap leaked host-only data: %#v", bootstrap)
	}
	if bootstrap.LocalControlToken == "" || bootstrap.LocalControlToken == s.hostToken {
		t.Fatalf("viewer bootstrap needs a separate local exit nonce: %#v", bootstrap)
	}
}
func TestHostControlRequiresTokenAndLoopback(t *testing.T) {
	s := New(Config{})
	token := s.hostToken
	if token == "" {
		t.Fatal("missing host token")
	}
	if !s.authorizeHost(&http.Request{RemoteAddr: "127.0.0.1:1234"}, token) {
		t.Fatal("loopback host denied")
	}
	if s.authorizeHost(&http.Request{RemoteAddr: "192.168.1.9:1234"}, token) {
		t.Fatal("LAN client with token accepted")
	}
	if s.authorizeHost(&http.Request{RemoteAddr: "127.0.0.1:1234"}, "wrong") {
		t.Fatal("bad token accepted")
	}
}
func TestLanListenerBindsChosenPrivateIPv4Only(t *testing.T) {
	if _, err := ListenLAN("127.0.0.1", 0); err == nil {
		t.Fatal("loopback accepted as LAN")
	}
	if _, err := ListenLAN("8.8.8.8", 0); appErrorCode(err) != "INVALID_HOST_ADDRESS" {
		t.Fatalf("public IP result: %v", err)
	}
	if ip := firstPrivateIPv4(); ip == "" {
		t.Skip("no private IPv4 available")
	}
	ln, err := ListenLAN(firstPrivateIPv4(), 0)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if ln.Addr().(*net.TCPAddr).IP.IsLoopback() {
		t.Fatal("LAN listener bound loopback")
	}
}

func TestLocalOriginAndHostMustMatchLoopback(t *testing.T) {
	r := httptest.NewRequest("GET", "http://127.0.0.1:8080/ws/v1", nil)
	r.RemoteAddr = "127.0.0.1:4312"
	r.Header.Set("Origin", "http://evil.example")
	if validLocalBrowserRequest(r) {
		t.Fatal("forged Origin accepted over loopback")
	}
	r.Header.Set("Origin", "http://127.0.0.1:8081")
	if validLocalBrowserRequest(r) {
		t.Fatal("mismatched Origin port accepted over loopback")
	}
	r.Header.Set("Origin", "http://127.0.0.1:8080")
	r.Host = "evil.example"
	if validLocalBrowserRequest(r) {
		t.Fatal("forged Host accepted over loopback")
	}
	r.Host = "127.0.0.1:8080"
	if !validLocalBrowserRequest(r) {
		t.Fatal("same-origin loopback rejected")
	}
}

func TestLANListenerExposesOnlyFixedSignalPath(t *testing.T) {
	ip := firstPrivateIPv4()
	if ip == "" {
		t.Skip("no private IPv4 available")
	}
	s := New(Config{LANIPv4: ip})
	for _, path := range []string{"/", "/api/v1/bootstrap?role=host", "/assets/app.js", "/signal/v1/other"} {
		r := httptest.NewRequest("GET", "http://"+ip+path, nil)
		r.Host = ip + ":9000"
		r.RemoteAddr = ip + ":1234"
		w := httptest.NewRecorder()
		s.LANHandler().ServeHTTP(w, r)
		if w.Code != http.StatusNotFound {
			t.Fatalf("LAN path %s returned %d", path, w.Code)
		}
	}
	r := httptest.NewRequest("GET", "http://"+ip+"/signal/v1?proxy=x", nil)
	r.Host = ip + ":9000"
	r.RemoteAddr = ip + ":1234"
	w := httptest.NewRecorder()
	s.LANHandler().ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("query was not rejected on signal endpoint: %d", w.Code)
	}
	r = httptest.NewRequest("GET", "http://"+ip+"/signal/v1", nil)
	r.Host = ip + ":9000"
	r.RemoteAddr = ip + ":1234"
	r.Header.Set("Origin", "http://evil.example")
	w = httptest.NewRecorder()
	s.LANHandler().ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("browser Origin was not rejected on LAN signal endpoint: %d", w.Code)
	}
}

func TestLocalWebSocketRoleIsolationAndBridgeSeats(t *testing.T) {
	ip := firstPrivateIPv4()
	if ip == "" {
		t.Skip("no private IPv4 available")
	}
	s := New(Config{LANIPv4: ip})
	local, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	lan, err := s.StartLAN(ctx)
	if err != nil {
		t.Fatal(err)
	}
	localHTTP := &http.Server{Handler: s.Handler()}
	go func() { _ = localHTTP.Serve(local) }()
	t.Cleanup(func() { cancel(); _ = localHTTP.Close(); _ = lan.Close() })
	localURL := "ws://" + local.Addr().String() + "/ws/v1"
	origin := "http://" + local.Addr().String()
	bootstrapRequest := httptest.NewRequest("GET", "http://"+local.Addr().String()+"/api/v1/bootstrap?role=host", nil)
	bootstrapRequest.RemoteAddr = "127.0.0.1:12000"
	bootstrapRequest.Host = local.Addr().String()
	bootstrapRequest.Header.Set("Origin", origin)
	bootstrapResponse := httptest.NewRecorder()
	s.Handler().ServeHTTP(bootstrapResponse, bootstrapRequest)
	var bootstrap Bootstrap
	if err = json.Unmarshal(bootstrapResponse.Body.Bytes(), &bootstrap); err != nil {
		t.Fatal(err)
	}
	if bootstrap.LANIPv4 != ip || bootstrap.SignalPort != lan.Addr().(*net.TCPAddr).Port || bootstrap.HostControlToken != s.hostToken {
		t.Fatalf("host bootstrap endpoint contract mismatch: %#v", bootstrap)
	}
	host := dialAppLocal(t, localURL, origin)
	defer host.Close(websocket.StatusNormalClosure, "test complete")
	writeEnvelope(t, host, protocol.Envelope{V: 1, Type: "auth.hello", RequestID: "host-auth", Payload: rawPayload(map[string]any{"role": "host", "hostToken": s.hostToken})})
	readType(t, host, "room.state")
	writeEnvelope(t, host, protocol.Envelope{V: 1, Type: "host.createRoom", RequestID: "create", Payload: rawPayload(map[string]any{})})
	created := readType(t, host, "room.created")
	var invite struct {
		RoomID   string `json:"roomId"`
		RoomCode string `json:"roomCode"`
	}
	if err = json.Unmarshal(created.Payload, &invite); err != nil {
		t.Fatal(err)
	}
	if len(invite.RoomCode) != 8 {
		t.Fatalf("room code: %q", invite.RoomCode)
	}
	if strings.ContainsAny(invite.RoomCode, "IO01") {
		t.Fatalf("room code contains an ambiguous character: %q", invite.RoomCode)
	}

	joinViewer := func(requestID string) *websocket.Conn {
		v := dialAppLocal(t, localURL, origin)
		writeEnvelope(t, v, protocol.Envelope{V: 1, Type: "auth.hello", RequestID: requestID + "-auth", Payload: rawPayload(map[string]any{"role": "viewer"})})
		readType(t, v, "room.state")
		return v
	}
	v1 := joinViewer("v1")
	defer v1.Close(websocket.StatusNormalClosure, "test complete")
	writeEnvelope(t, v1, protocol.Envelope{V: 1, Type: "host.createRoom", RequestID: "viewer-host-create", Payload: rawPayload(map[string]any{})})
	if e := readType(t, v1, "error"); errorCodeFromPayload(t, e) != "HOST_ONLY" {
		t.Fatalf("viewer host control: %#v", e)
	}
	writeEnvelope(t, v1, protocol.Envelope{V: 1, Type: "host.endRoom", RequestID: "viewer-host-end", RoomID: invite.RoomID, Payload: rawPayload(map[string]any{})})
	if e := readType(t, v1, "error"); errorCodeFromPayload(t, e) != "HOST_ONLY" {
		t.Fatalf("viewer ended host room: %#v", e)
	}
	join := func(c *websocket.Conn, id string, resume ...string) protocol.Envelope {
		joinData := map[string]any{"hostIPv4": bootstrap.LANIPv4, "hostPort": bootstrap.SignalPort, "roomCode": invite.RoomCode}
		if len(resume) > 0 && resume[0] != "" {
			joinData["resumeToken"] = resume[0]
		}
		writeEnvelope(t, c, protocol.Envelope{V: 1, Type: "viewer.join", RequestID: id, Payload: rawPayload(joinData)})
		return readUntilOptions(t, c, "room.joined", "error")
	}
	joined1 := join(v1, "join-1")
	if joined1.Type != "room.joined" {
		t.Fatalf("first viewer join failed: %#v", joined1)
	}
	if duplicate := join(v1, "join-duplicate"); duplicate.Type != "error" || errorCodeFromPayload(t, duplicate) != "ROOM_ALREADY_JOINED" {
		t.Fatalf("duplicate join created another peer: %#v", duplicate)
	}
	v2 := joinViewer("v2")
	defer v2.Close(websocket.StatusNormalClosure, "test complete")
	joined2 := join(v2, "join-2")
	if joined2.Type != "room.joined" {
		t.Fatalf("second viewer join failed: %#v", joined2)
	}
	var member1, member2 struct {
		PeerID string `json:"peerId"`
	}
	if err = json.Unmarshal(joined1.Payload, &member1); err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(joined2.Payload, &member2); err != nil {
		t.Fatal(err)
	}
	// room.joined already carries the snapshot for the joining viewer. The
	// post-ACK room.state fanout is reserved for existing peers so a terminal
	// room.ended cannot be followed by a stale snapshot on the new connection.
	var session1 struct {
		PeerID      string `json:"peerId"`
		ResumeToken string `json:"resumeToken"`
	}
	if err = json.Unmarshal(joined1.Payload, &session1); err != nil {
		t.Fatal(err)
	}
	writeEnvelope(t, v1, protocol.Envelope{V: 1, Type: "rtc.description", RequestID: "viewer-offer", PeerID: "forged", RoomID: "wrong-room", Payload: rawPayload(map[string]any{"toPeerId": member2.PeerID, "description": map[string]any{"type": "offer", "sdp": "v=0"}, "tracks": []map[string]string{{"mid": "0", "role": "microphone"}}})})
	forwarded := readUntilType(t, v2, "rtc.description")
	var signalPayload struct {
		FromPeerID string `json:"fromPeerId"`
		ToPeerID   string `json:"toPeerId"`
	}
	if err = json.Unmarshal(forwarded.Payload, &signalPayload); err != nil {
		t.Fatal(err)
	}
	if signalPayload.FromPeerID != member1.PeerID || signalPayload.ToPeerID != "" {
		t.Fatalf("sender was not derived from authenticated connection: %#v", signalPayload)
	}
	// Any authenticated member may claim the single presentation slot. The
	// forged peer ID must not change which session becomes the presenter.
	writeEnvelope(t, v1, protocol.Envelope{V: 1, Type: "share.claim", RequestID: "claim", RoomID: invite.RoomID, PeerID: "forged", Payload: rawPayload(map[string]any{})})
	claimed := readUntilType(t, v2, "room.state")
	var claimState struct {
		PresenterPeerID string `json:"presenterPeerId"`
	}
	if err = json.Unmarshal(claimed.Payload, &claimState); err != nil {
		t.Fatal(err)
	}
	if claimState.PresenterPeerID != member1.PeerID {
		t.Fatalf("presentation identity did not come from the session: %#v", claimState)
	}
	writeEnvelope(t, v1, protocol.Envelope{V: 1, Type: "media.state", RequestID: "screen-on", RoomID: invite.RoomID, PeerID: "forged", Payload: rawPayload(map[string]any{"screenSharing": true, "hasScreenVideo": true, "hasSystemAudio": true, "isolationStatus": "manual-check"})})
	roomState := readUntilType(t, v2, "room.state")
	var state struct {
		Members       []any `json:"members"`
		ScreenSharing bool  `json:"screenSharing"`
	}
	if err = json.Unmarshal(roomState.Payload, &state); err != nil {
		t.Fatal(err)
	}
	if !state.ScreenSharing || len(state.Members) != 3 {
		t.Fatalf("room.state payload mismatch: %#v", state)
	}
	writeEnvelope(t, host, protocol.Envelope{V: 1, Type: "rtc.candidate", RequestID: "host-ice", Payload: rawPayload(map[string]any{"toPeerId": member1.PeerID, "candidate": map[string]any{"candidate": "candidate:1"}})})
	fromHost := readUntilType(t, v1, "rtc.candidate")
	if fromHost.PeerID != member1.PeerID {
		t.Fatalf("host signal target mismatch: %#v", fromHost)
	}
	_ = v1.Close(websocket.StatusNormalClosure, "simulate local browser reconnect")
	deadline := time.Now().Add(time.Second)
	for {
		snapshot, ok := s.rooms.Get(invite.RoomID)
		if ok && len(snapshot.Members) == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("ending the local viewer WebSocket did not free its seat: %#v", snapshot)
		}
		time.Sleep(5 * time.Millisecond)
	}
	readUntilType(t, host, "peer.left")
	readUntilType(t, v2, "peer.left")
	v1r := joinViewer("v1-reconnected")
	defer v1r.Close(websocket.StatusNormalClosure, "test complete")
	staleResume := join(v1r, "join-stale-resume", session1.ResumeToken)
	if staleResume.Type != "error" || errorCodeFromPayload(t, staleResume) != "INVALID_INVITE" {
		t.Fatalf("a closed local viewer session retained its old resume credential: %#v", staleResume)
	}
	v3 := joinViewer("v3")
	defer v3.Close(websocket.StatusNormalClosure, "test complete")
	third := join(v3, "join-3")
	if third.Type != "room.joined" {
		t.Fatalf("closing the local viewer session did not release room capacity: %#v", third)
	}
	v4 := joinViewer("v4")
	defer v4.Close(websocket.StatusNormalClosure, "test complete")
	fourth := join(v4, "join-4")
	if fourth.Type != "error" || errorCodeFromPayload(t, fourth) != "ROOM_FULL" {
		t.Fatalf("viewer beyond room capacity was not rejected: %#v", fourth)
	}
	writeEnvelope(t, v2, protocol.Envelope{V: 1, Type: "viewer.leave", RequestID: "leave-v2", RoomID: invite.RoomID, Payload: rawPayload(map[string]any{})})
	if left := readUntilType(t, v2, "peer.left"); left.RequestID != "leave-v2" {
		t.Fatalf("unexpected leave response: %#v", left)
	}
	deadline = time.Now().Add(time.Second)
	for {
		snapshot, ok := s.rooms.Get(invite.RoomID)
		if ok && len(snapshot.Members) == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("leave did not reclaim viewer seat: %#v", snapshot)
		}
		time.Sleep(5 * time.Millisecond)
	}
	rejoined := join(v4, "join-after-leave")
	if rejoined.Type != "room.joined" {
		t.Fatalf("leave did not free seat: %#v", rejoined)
	}
	writeEnvelope(t, host, protocol.Envelope{V: 1, Type: "host.endRoom", RequestID: "end-room-missing-envelope-id", Payload: rawPayload(map[string]any{})})
	wrongLocation := readUntilType(t, host, "error")
	if errorCodeFromPayload(t, wrongLocation) != "ROOM_NOT_FOUND" {
		t.Fatalf("missing envelope roomId was not rejected: %#v", wrongLocation)
	}
	if _, ok := s.rooms.Get(invite.RoomID); !ok {
		t.Fatal("invalid host.endRoom ended the room")
	}
	writeEnvelope(t, host, protocol.Envelope{V: 1, Type: "host.endRoom", RequestID: "end-room-envelope", RoomID: invite.RoomID, Payload: rawPayload(map[string]any{})})
	ended := readUntilType(t, host, "room.ended")
	if ended.RequestID != "end-room-envelope" {
		t.Fatalf("host.endRoom response: %#v", ended)
	}
	if _, ok := s.rooms.Get(invite.RoomID); ok {
		t.Fatal("valid host.endRoom did not end the room")
	}
}

func dialAppLocal(t *testing.T, target, origin string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	h := http.Header{"Origin": []string{origin}}
	c, _, err := websocket.Dial(ctx, target, &websocket.DialOptions{HTTPHeader: h})
	if err != nil {
		t.Fatal(err)
	}
	return c
}
func writeEnvelope(t *testing.T, c *websocket.Conn, e protocol.Envelope) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	b, err := json.Marshal(e)
	if err != nil {
		t.Fatal(err)
	}
	if err = c.Write(ctx, websocket.MessageText, b); err != nil {
		t.Fatal(err)
	}
}
func readType(t *testing.T, c *websocket.Conn, allowed ...string) protocol.Envelope {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, b, err := c.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var e protocol.Envelope
	if err = protocol.Decode(b, &e); err != nil {
		t.Fatalf("invalid service envelope %s: %v", b, err)
	}
	for _, a := range allowed {
		if e.Type == a {
			return e
		}
	}
	t.Fatalf("got type %q, want one of %v: %s", e.Type, allowed, b)
	return e
}

func readUntilType(t *testing.T, c *websocket.Conn, want string) protocol.Envelope {
	t.Helper()
	for i := 0; i < 64; i++ {
		e := readType(t, c, "room.state", "peer.joined", "peer.left", "peer.state", "rtc.description", "rtc.candidate", "room.ended", "heartbeat", "error")
		if e.Type == want {
			return e
		}
		if e.Type == "error" {
			t.Fatalf("unexpected service error while waiting for %s: %#v", want, e)
		}
	}
	t.Fatalf("did not receive %s", want)
	return protocol.Envelope{}
}

func readUntilOptions(t *testing.T, c *websocket.Conn, wants ...string) protocol.Envelope {
	t.Helper()
	allowed := append([]string{"room.state", "peer.joined", "peer.left", "peer.state"}, wants...)
	for i := 0; i < 12; i++ {
		e := readType(t, c, allowed...)
		for _, want := range wants {
			if e.Type == want {
				return e
			}
		}
	}
	t.Fatalf("did not receive any of %v", wants)
	return protocol.Envelope{}
}
func rawPayload(v any) json.RawMessage { b, _ := json.Marshal(v); return b }
func errorCodeFromPayload(t *testing.T, e protocol.Envelope) string {
	t.Helper()
	var p struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(e.Payload, &p); err != nil {
		t.Fatal(err)
	}
	return p.Code
}
