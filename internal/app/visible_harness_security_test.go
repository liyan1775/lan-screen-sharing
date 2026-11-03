package app

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"lan-screen-sharing/internal/protocol"
)

func visibleControlRequest(s *Server, method, origin, token string) *http.Request {
	r := httptest.NewRequest(method, "http://127.0.0.1:8123/__visible_test__/fault/drop-bridges", nil)
	r.RemoteAddr = "127.0.0.1:45678"
	r.Host = "127.0.0.1:8123"
	r.Header.Set("Origin", origin)
	if token != "" {
		r.Header.Set("X-Local-Control-Token", token)
	}
	return r
}

func visibleHarnessTestToken() string { return strings.Repeat("a", 64) }

type visibleTestRoundTripper func(*http.Request) (*http.Response, error)

func (f visibleTestRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

func TestVisibleHarnessBridgeTransportMarksOnlyPrivateSignalDials(t *testing.T) {
	token := visibleHarnessTestToken()
	marker := visibleHarnessOwnerMarker(token, "viewer-2")
	transport := &visibleHarnessBridgeTransport{base: visibleTestRoundTripper(func(request *http.Request) (*http.Response, error) {
		if request.Header.Get(visibleHarnessOwnerHeader) != marker {
			t.Fatal("private signal bridge did not carry this runner's private ownership marker")
		}
		return &http.Response{StatusCode: http.StatusSwitchingProtocols, Header: make(http.Header), Body: http.NoBody, Request: request}, nil
	}), marker: marker}
	private, _ := http.NewRequest(http.MethodGet, "http://192.168.1.20:42000/signal/v1", nil)
	if _, err := transport.RoundTrip(private); err != nil {
		t.Fatal(err)
	}
	if private.Header.Get(visibleHarnessOwnerHeader) != "" {
		t.Fatal("transport mutated the production request object")
	}
	untouched := &visibleHarnessBridgeTransport{base: visibleTestRoundTripper(func(request *http.Request) (*http.Response, error) {
		if request.Header.Get(visibleHarnessOwnerHeader) != "" {
			t.Fatal("ownership marker escaped the fixed private LAN bridge route")
		}
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: http.NoBody, Request: request}, nil
	}), marker: marker}
	for _, target := range []string{"http://127.0.0.1:42000/signal/v1", "http://192.168.1.20:42000/other", "http://192.168.1.20:42000/ws/v1", "http://[fd00::1]:42000/signal/v1"} {
		request, _ := http.NewRequest(http.MethodGet, target, nil)
		if _, err := untouched.RoundTrip(request); err != nil {
			t.Fatal(err)
		}
	}
}

func TestVisibleHarnessOwnershipInstallsSharedTokenOnlyForMediaViewers(t *testing.T) {
	original := http.DefaultClient.Transport
	defer func() { http.DefaultClient.Transport = original }()
	token := visibleHarnessTestToken()
	for _, tc := range []struct{ alias, marker string }{
		{"viewer-1", visibleHarnessOwnerMarker(token, "viewer-1")},
		{"viewer-2", visibleHarnessOwnerMarker(token, "viewer-2")},
		{"viewer-extra", ""},
	} {
		if err := installVisibleHarnessBridgeOwnership(token, tc.alias); err != nil {
			t.Fatal("valid run owner configuration was rejected")
		}
		transport, ok := http.DefaultClient.Transport.(*visibleHarnessBridgeTransport)
		if !ok || transport.marker != tc.marker {
			t.Fatalf("alias %s received an incorrect scoped bridge marker", tc.alias)
		}
	}
	for _, bad := range []string{"", "short", strings.Repeat("z", 64)} {
		if installVisibleHarnessBridgeOwnership(bad, "viewer-1") == nil {
			t.Fatal("invalid owner token was accepted")
		}
	}
}

func TestVisibleHarnessRoleAwareInitialization(t *testing.T) {
	original := http.DefaultClient.Transport
	t.Cleanup(func() { http.DefaultClient.Transport = original })
	http.DefaultClient.Transport = nil
	token := visibleHarnessTestToken()

	if err := initializeVisibleHarnessBridgeOwnership(token, "host", "host"); err != nil {
		t.Fatalf("valid host role/alias and 32-byte token should initialize: %v", err)
	}
	if http.DefaultClient.Transport != nil {
		t.Fatal("host initialization installed a viewer outbound ownership marker")
	}

	if err := initializeVisibleHarnessBridgeOwnership(token, "viewer", "viewer-1"); err != nil {
		t.Fatalf("valid viewer role/alias and token should initialize: %v", err)
	}
	transport, ok := http.DefaultClient.Transport.(*visibleHarnessBridgeTransport)
	if !ok || transport.marker != visibleHarnessOwnerMarker(token, "viewer-1") {
		t.Fatal("viewer-1 did not receive its scoped ownership marker")
	}

	if err := initializeVisibleHarnessBridgeOwnership(token, "host", "viewer-1"); err == nil || !strings.Contains(err.Error(), "alias") {
		t.Fatalf("host with viewer alias should return an alias error, got %v", err)
	}
	if err := initializeVisibleHarnessBridgeOwnership("invalid", "host", "host"); err == nil || !strings.Contains(err.Error(), "token") {
		t.Fatalf("invalid host token should return a token error, got %v", err)
	}
	if err := initializeVisibleHarnessBridgeOwnership("invalid", "viewer", "viewer-1"); err == nil || !strings.Contains(err.Error(), "token") {
		t.Fatalf("invalid viewer token should return a token error, got %v", err)
	}
}

func TestVisibleHarnessOwnerTokenValidatorDistinguishesBytesFromMarkerSuffix(t *testing.T) {
	token := strings.Repeat("a", 64)
	diagnostics := diagnoseVisibleHarnessOwnerToken(token)
	if err := validateVisibleHarnessOwnerToken(token); err != nil {
		t.Fatalf("64 hex characters should validate as 32 bytes: %v", err)
	}
	if !diagnostics.present || diagnostics.utf8Bytes != 64 || !diagnostics.asciiLowerHex || diagnostics.decodedBytes != 32 || diagnostics.decodeErrorKind != "none" || !diagnostics.validatorOK {
		t.Fatalf("valid token diagnostic mismatch: %+v", diagnostics)
	}
	if err := validateVisibleHarnessOwnerToken(""); err == nil {
		t.Fatal("empty owner token was accepted")
	}
	invalid := strings.Repeat("a", 63) + "g"
	invalidDiagnostics := diagnoseVisibleHarnessOwnerToken(invalid)
	if err := validateVisibleHarnessOwnerToken(invalid); err == nil {
		t.Fatal("non-hex owner token was accepted")
	}
	if invalidDiagnostics.validatorOK || invalidDiagnostics.asciiLowerHex || invalidDiagnostics.decodeErrorKind != "invalid_byte" {
		t.Fatalf("invalid token diagnostic mismatch: %+v", invalidDiagnostics)
	}
	if err := validateVisibleHarnessOwnerToken(token + ":viewer-1"); err == nil {
		t.Fatal("alias-suffixed bridge marker was accepted as the raw owner token")
	}
}

func TestVisibleHarnessRecorderRejectsForeignMarkersAndClearsOwnedSockets(t *testing.T) {
	token := visibleHarnessTestToken()
	recorder := newBridgeSocketRecorder(token)
	ownedPeers := make([]net.Conn, 0, 2)
	foreignPeers := make([]net.Conn, 0, 3)
	for _, tc := range []struct {
		marker string
		owned  bool
	}{
		{visibleHarnessOwnerMarker(token, "viewer-1"), true},
		{visibleHarnessOwnerMarker(token, "viewer-2"), true},
		{visibleHarnessOwnerMarker(strings.Repeat("b", 64), "viewer-1"), false},
		{visibleHarnessOwnerMarker(token, "viewer-extra"), false},
		{"", false},
	} {
		serverSide, peerSide := net.Pipe()
		if tc.owned {
			ownedPeers = append(ownedPeers, peerSide)
		} else {
			foreignPeers = append(foreignPeers, peerSide)
		}
		recorder.Record(serverSide, tc.marker)
	}
	if recorder.Count() != 2 {
		t.Fatalf("recorded=%d want only the two owned viewer bridges", recorder.Count())
	}
	if closed := recorder.CloseAll(); closed != 2 {
		t.Fatalf("closed=%d want 2", closed)
	}
	if recorder.Count() != 0 {
		t.Fatalf("recorder retained %d sockets after cleanup", recorder.Count())
	}
	for _, peer := range ownedPeers {
		_ = peer.SetReadDeadline(time.Now().Add(time.Second))
		if _, err := peer.Read(make([]byte, 1)); err == nil || err == context.DeadlineExceeded {
			t.Fatalf("owned socket did not close: %v", err)
		}
		_ = peer.Close()
	}
	for _, peer := range foreignPeers {
		_ = peer.SetReadDeadline(time.Now().Add(25 * time.Millisecond))
		if _, err := peer.Read(make([]byte, 1)); err == nil {
			t.Fatal("foreign socket unexpectedly delivered data")
		} else if timeout, ok := err.(net.Error); !ok || !timeout.Timeout() {
			t.Fatalf("foreign socket was closed: %v", err)
		}
		_ = peer.Close()
	}
}

func TestVisibleHarnessRecorderCapacityIsBoundedAndCleanupEmptiesIt(t *testing.T) {
	token := visibleHarnessTestToken()
	recorder := newBridgeSocketRecorder(token)
	peers := make([]net.Conn, 0, visibleHarnessBridgeCap+1)
	for i := 0; i < visibleHarnessBridgeCap+1; i++ {
		serverSide, peerSide := net.Pipe()
		peers = append(peers, peerSide)
		recorder.Record(serverSide, visibleHarnessOwnerMarker(token, "viewer-1"))
	}
	if recorder.Count() != visibleHarnessBridgeCap {
		t.Fatalf("recorded=%d want bounded capacity %d", recorder.Count(), visibleHarnessBridgeCap)
	}
	if closed := recorder.CloseAll(); closed != visibleHarnessBridgeCap {
		t.Fatalf("closed=%d want capacity %d", closed, visibleHarnessBridgeCap)
	}
	if recorder.Count() != 0 {
		t.Fatal("recorder did not release its bounded map on cleanup")
	}
	for _, peer := range peers {
		_ = peer.Close()
	}
}

func TestVisibleHarnessFaultRouteRequiresSameOriginAndLocalToken(t *testing.T) {
	s := New(Config{})
	recorder := newBridgeSocketRecorder(visibleHarnessTestToken())
	registerVisibleHarnessRoutes(s, recorder, "host", "host")
	origin := "http://127.0.0.1:8123"
	for _, tc := range []struct {
		name, method, requestOrigin, token string
		want                               int
	}{
		{"missing origin", http.MethodPost, "", s.localControlToken, http.StatusForbidden},
		{"wrong origin", http.MethodPost, "http://127.0.0.1:8124", s.localControlToken, http.StatusForbidden},
		{"wrong token", http.MethodPost, origin, "wrong", http.StatusForbidden},
		{"wrong method", http.MethodGet, origin, s.localControlToken, http.StatusForbidden},
		{"valid host-local control", http.MethodPost, origin, s.localControlToken, http.StatusOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := visibleControlRequest(s, tc.method, tc.requestOrigin, tc.token)
			response := httptest.NewRecorder()
			s.Handler().ServeHTTP(response, request)
			if response.Code != tc.want {
				t.Fatalf("status=%d want=%d body=%s", response.Code, tc.want, response.Body.String())
			}
		})
	}
	viewer := New(Config{})
	registerVisibleHarnessRoutes(viewer, newBridgeSocketRecorder(visibleHarnessTestToken()), "viewer", "viewer-1")
	response := httptest.NewRecorder()
	viewer.Handler().ServeHTTP(response, visibleControlRequest(viewer, http.MethodPost, origin, viewer.localControlToken))
	if response.Code != http.StatusForbidden {
		t.Fatalf("viewer harness service could invoke host bridge fault: %d", response.Code)
	}
}

func TestVisibleHarnessFaultClosesOnlyRecordedBridgeSockets(t *testing.T) {
	s := New(Config{})
	recorder := newBridgeSocketRecorder(visibleHarnessTestToken())
	registerVisibleHarnessRoutes(s, recorder, "host", "host")
	serverSide, peerSide := net.Pipe()
	defer peerSide.Close()
	recorder.Record(serverSide, visibleHarnessOwnerMarker(visibleHarnessTestToken(), "viewer-1"))
	request := visibleControlRequest(s, http.MethodPost, "http://127.0.0.1:8123", s.localControlToken)
	response := httptest.NewRecorder()
	s.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("fault status=%d body=%s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), s.localControlToken) || strings.Contains(response.Body.String(), s.hostToken) {
		t.Fatal("fault result leaked a production credential")
	}
	var result struct {
		Closed int `json:"closed"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Closed != 1 {
		t.Fatalf("closed=%d want 1", result.Closed)
	}
	if _, err := peerSide.Write([]byte("x")); err == nil {
		t.Fatal("peer side remained writable after captured connection was closed")
	}
}

type fakeHijackResponseWriter struct {
	header http.Header
	conn   net.Conn
	reader *bufio.ReadWriter
}

func (w *fakeHijackResponseWriter) Header() http.Header            { return w.header }
func (w *fakeHijackResponseWriter) Write(data []byte) (int, error) { return len(data), nil }
func (w *fakeHijackResponseWriter) WriteHeader(int)                {}
func (w *fakeHijackResponseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return w.conn, w.reader, nil
}

func TestVisibleHarnessWriterRecordsAndReturnsSameHijackedConnection(t *testing.T) {
	left, right := net.Pipe()
	defer right.Close()
	recorder := newBridgeSocketRecorder(visibleHarnessTestToken())
	writer := &visibleHarnessResponseWriter{ResponseWriter: &fakeHijackResponseWriter{header: make(http.Header), conn: left, reader: bufio.NewReadWriter(bufio.NewReader(left), bufio.NewWriter(left))}, recorder: recorder, marker: visibleHarnessOwnerMarker(visibleHarnessTestToken(), "viewer-1")}
	conn, _, err := writer.Hijack()
	if err != nil {
		t.Fatal(err)
	}
	if conn != left {
		t.Fatal("wrapper replaced the production hijacked connection")
	}
	closed := recorder.CloseAll()
	if closed != 1 {
		t.Fatalf("closed=%d want 1", closed)
	}
}

func TestVisibleHarnessWriterDoesNotOwnUnmarkedHijackedConnections(t *testing.T) {
	left, right := net.Pipe()
	defer right.Close()
	recorder := newBridgeSocketRecorder(visibleHarnessTestToken())
	writer := &visibleHarnessResponseWriter{ResponseWriter: &fakeHijackResponseWriter{header: make(http.Header), conn: left, reader: bufio.NewReadWriter(bufio.NewReader(left), bufio.NewWriter(left))}, recorder: recorder}
	if _, _, err := writer.Hijack(); err != nil {
		t.Fatal(err)
	}
	if closed := recorder.CloseAll(); closed != 0 {
		t.Fatalf("unmarked socket was treated as harness-owned: closed=%d", closed)
	}
	_ = right.SetReadDeadline(time.Now().Add(25 * time.Millisecond))
	if _, err := right.Read(make([]byte, 1)); err == nil {
		t.Fatal("expected the ownership probe read deadline")
	} else if timeout, ok := err.(net.Error); !ok || !timeout.Timeout() {
		t.Fatalf("unmarked socket was closed by the harness fault: %v", err)
	}
}

func TestVisibleHarnessDropRouteClosesActualProductionLANBridge(t *testing.T) {
	ipv4 := firstPrivateIPv4()
	if ipv4 == "" {
		t.Skip("no RFC1918 IPv4 available")
	}
	s := New(Config{LANIPv4: ipv4, SignalPort: 0})
	recorder := newBridgeSocketRecorder(visibleHarnessTestToken())
	registerVisibleHarnessRoutes(s, recorder, "host", "host")
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	local, err := s.StartAtPort(ctx, 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Shutdown(context.Background()) }()
	origin := "http://" + local.Addr().String()
	host := dialAppLocal(t, "ws://"+local.Addr().String()+"/ws/v1", origin)
	defer host.Close(websocket.StatusNormalClosure, "test cleanup")
	writeEnvelope(t, host, protocol.Envelope{V: 1, Type: "auth.hello", RequestID: "host-auth", Payload: rawPayload(map[string]any{"role": "host", "hostToken": s.hostToken})})
	readUntilType(t, host, "room.state")
	writeEnvelope(t, host, protocol.Envelope{V: 1, Type: "host.createRoom", RequestID: "host-create", Payload: rawPayload(map[string]any{})})
	created := readType(t, host, "room.created")
	var invite struct {
		RoomCode string `json:"roomCode"`
	}
	if err := json.Unmarshal(created.Payload, &invite); err != nil || invite.RoomCode == "" {
		t.Fatalf("host room did not expose its in-memory invite code: %v", err)
	}
	s.lanMu.RLock()
	signalPort := s.lanPort
	s.lanMu.RUnlock()
	bridgeURL := "ws://" + net.JoinHostPort(ipv4, fmt.Sprint(signalPort)) + "/signal/v1"
	bridgeHeaders := make(http.Header)
	bridgeHeaders.Set(visibleHarnessOwnerHeader, visibleHarnessOwnerMarker(visibleHarnessTestToken(), "viewer-1"))
	originalTransport := http.DefaultClient.Transport
	baseTransport := originalTransport
	if baseTransport == nil {
		baseTransport = http.DefaultTransport
	}
	ownerTransport := &visibleHarnessBridgeTransport{base: baseTransport, marker: bridgeHeaders.Get(visibleHarnessOwnerHeader)}
	http.DefaultClient.Transport = ownerTransport
	owned, _, err := websocket.Dial(ctx, bridgeURL, nil)
	http.DefaultClient.Transport = originalTransport
	if err != nil {
		t.Fatalf("dial owned production LAN handler using the native default websocket path: %v", err)
	}
	defer owned.Close(websocket.StatusNormalClosure, "test cleanup")
	if ownerTransport.RoundTrips() != 1 || ownerTransport.MarkedRequests() != 1 {
		path, host := ownerTransport.LastTarget()
		t.Fatalf("native websocket Dial did not use the scoped marker transport: calls=%d marked=%d target=%s %s", ownerTransport.RoundTrips(), ownerTransport.MarkedRequests(), path, host)
	}
	unowned, _, err := websocket.Dial(ctx, bridgeURL, nil)
	if err != nil {
		t.Fatalf("dial unmarked production LAN handler: %v", err)
	}
	defer unowned.Close(websocket.StatusNormalClosure, "test cleanup")
	join, err := json.Marshal(protocol.Envelope{V: 1, Type: "signal.join", RequestID: "bridge-join", Payload: rawPayload(map[string]string{"roomCode": invite.RoomCode})})
	if err != nil {
		t.Fatal(err)
	}
	if err := unowned.Write(ctx, websocket.MessageText, join); err != nil {
		t.Fatal(err)
	}
	if got := readType(t, unowned, "room.joined"); got.Type != "room.joined" {
		t.Fatalf("bridge join: %s", got.Type)
	}
	if err := owned.Write(ctx, websocket.MessageText, join); err != nil {
		t.Fatal(err)
	}
	if got := readType(t, owned, "room.joined"); got.Type != "room.joined" {
		t.Fatalf("owned bridge join: %s", got.Type)
	}
	request := visibleControlRequest(s, http.MethodPost, origin, s.localControlToken)
	request.Host = local.Addr().String()
	response := httptest.NewRecorder()
	s.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("fault endpoint status=%d: %s", response.Code, response.Body.String())
	}
	var result struct {
		Closed int `json:"closed"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Closed != 1 || recorder.Count() != 0 {
		t.Fatalf("fault route closed %d owned bridge sockets; remaining recorded=%d, want 1 and 0", result.Closed, recorder.Count())
	}
	readCtx, readCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer readCancel()
	for {
		if _, _, err := owned.Read(readCtx); err != nil {
			if errors.Is(err, context.DeadlineExceeded) {
				t.Fatal("production LAN bridge did not close before deadline")
			}
			break
		}
	}
	foreignReadCtx, foreignReadCancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer foreignReadCancel()
	for {
		if _, _, err := unowned.Read(foreignReadCtx); err != nil {
			if errors.Is(err, context.DeadlineExceeded) {
				break
			}
			t.Fatalf("fault route closed an unmarked LAN bridge: %v", err)
		}
	}
}

func TestVisibleHarnessServesProductionAppThroughTestBootstrap(t *testing.T) {
	s := New(Config{})
	registerVisibleHarnessRoutes(s, newBridgeSocketRecorder(visibleHarnessTestToken()), "host", "host")
	r := httptest.NewRequest(http.MethodGet, "http://localhost:8123/__visible_test__/?role=host", nil)
	r.RemoteAddr = "127.0.0.1:45678"
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("page status=%d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `id="quick-create-room"`) || !strings.Contains(w.Body.String(), `id="quick-manual-join"`) || !strings.Contains(w.Body.String(), `src="/__visible_test__/bootstrap.js"`) {
		t.Fatal("test page did not preserve production role UI and select the test-only bootstrap")
	}
	if strings.Contains(w.Body.String(), `src="/assets/app.js"`) {
		t.Fatal("test page bypassed the synthetic bootstrap")
	}

	bootstrap := httptest.NewRequest(http.MethodGet, "http://localhost:8123/__visible_test__/bootstrap.js", nil)
	bootstrap.RemoteAddr = "127.0.0.1:45678"
	bootstrapResponse := httptest.NewRecorder()
	s.Handler().ServeHTTP(bootstrapResponse, bootstrap)
	if bootstrapResponse.Code != http.StatusOK || !strings.Contains(bootstrapResponse.Body.String(), "installSilentMediaOutput") || !strings.Contains(bootstrapResponse.Body.String(), "installSyntheticMedia") || !strings.Contains(bootstrapResponse.Body.String(), "participantAlias") || strings.Index(bootstrapResponse.Body.String(), "installSilentMediaOutput") > strings.Index(bootstrapResponse.Body.String(), "await import('/assets/app.js')") {
		t.Fatalf("bootstrap did not install fixture before production app import: status=%d", bootstrapResponse.Code)
	}
	if strings.Contains(bootstrapResponse.Body.String(), s.hostToken) || strings.Contains(bootstrapResponse.Body.String(), s.localControlToken) {
		t.Fatal("test bootstrap leaked a production credential")
	}
	silentRequest := httptest.NewRequest(http.MethodGet, "http://localhost:8123/__visible_test__/silent-output.js", nil)
	silentRequest.RemoteAddr = "127.0.0.1:45678"
	silentResponse := httptest.NewRecorder()
	s.Handler().ServeHTTP(silentResponse, silentRequest)
	if silentResponse.Code != http.StatusOK || !strings.Contains(silentResponse.Body.String(), "createMediaElementSource") || !strings.Contains(silentResponse.Body.String(), "gain.gain.value = 0") || !strings.Contains(silentResponse.Body.String(), "nativePlay") {
		t.Fatalf("test page did not serve its pre-app native silent sink adapter: status=%d body=%s", silentResponse.Code, silentResponse.Body.String())
	}
}

func TestVisibleHarnessRunner(t *testing.T) {
	if strings.TrimSpace(os.Getenv("LANSW_VISIBLE_HARNESS")) != "1" {
		t.Skip("test-only CUA runner is opt-in")
	}
	runVisibleHarness(t, context.Background())
}
