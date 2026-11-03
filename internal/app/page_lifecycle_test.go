package app

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func pageLifecycleServer(t *testing.T, cfg Config) (*Server, string) {
	t.Helper()
	s := New(cfg)
	ln, err := s.StartAtPort(context.Background(), 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Shutdown(context.Background()) })
	return s, "http://" + ln.Addr().String()
}

func postPageLease(t *testing.T, s *Server, origin, pageID, token string, remote string, requestOrigin ...string) int {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, origin+"/api/v1/page-lease", strings.NewReader(`{"pageId":"`+pageID+`"}`))
	req.RemoteAddr = remote
	req.Host = strings.TrimPrefix(origin, "http://")
	actualOrigin := origin
	if len(requestOrigin) > 0 {
		actualOrigin = requestOrigin[0]
	}
	req.Header.Set("Origin", actualOrigin)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Local-Control-Token", token)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, req)
	return w.Code
}

func assertRunning(t *testing.T, requested <-chan struct{}) {
	t.Helper()
	select {
	case <-requested:
		t.Fatal("service shutdown was requested while a page lease should be active")
	default:
	}
}

func waitShutdown(t *testing.T, requested <-chan struct{}, within time.Duration) {
	t.Helper()
	select {
	case <-requested:
	case <-time.After(within):
		t.Fatal("service did not request shutdown before its lease deadline")
	}
}

func TestPageLeasesKeepServiceAliveUntilEveryPageCloses(t *testing.T) {
	s, origin := pageLifecycleServer(t, Config{PageLeaseTTL: 180 * time.Millisecond, PageLeaseShutdownGrace: 90 * time.Millisecond, PageStartupGrace: 700 * time.Millisecond, PageLeaseSweepInterval: 10 * time.Millisecond})
	if code := postPageLease(t, s, origin, "page-a", s.localControlToken, "127.0.0.1:1234"); code != http.StatusNoContent {
		t.Fatalf("first page lease status = %d", code)
	}
	if code := postPageLease(t, s, origin, "page-b", s.localControlToken, "127.0.0.1:1234"); code != http.StatusNoContent {
		t.Fatalf("second page lease status = %d", code)
	}
	keepB := time.NewTicker(45 * time.Millisecond)
	defer keepB.Stop()
	deadline := time.Now().Add(260 * time.Millisecond)
	for time.Now().Before(deadline) {
		<-keepB.C
		if code := postPageLease(t, s, origin, "page-b", s.localControlToken, "127.0.0.1:1234"); code != http.StatusNoContent {
			t.Fatalf("renewing second page lease status = %d", code)
		}
		assertRunning(t, s.ShutdownRequested())
	}
	waitShutdown(t, s.ShutdownRequested(), 500*time.Millisecond)
}

func TestPageLeaseRefreshDuringGraceCancelsExit(t *testing.T) {
	s, origin := pageLifecycleServer(t, Config{PageLeaseTTL: 120 * time.Millisecond, PageLeaseShutdownGrace: 180 * time.Millisecond, PageStartupGrace: 700 * time.Millisecond, PageLeaseSweepInterval: 5 * time.Millisecond})
	if code := postPageLease(t, s, origin, "old-document", s.localControlToken, "127.0.0.1:1234"); code != http.StatusNoContent {
		t.Fatalf("old page lease status = %d", code)
	}
	time.Sleep(145 * time.Millisecond)
	assertRunning(t, s.ShutdownRequested())
	if code := postPageLease(t, s, origin, "refreshed-document", s.localControlToken, "127.0.0.1:1234"); code != http.StatusNoContent {
		t.Fatalf("refreshed page lease status = %d", code)
	}
	time.Sleep(220 * time.Millisecond)
	assertRunning(t, s.ShutdownRequested())
	waitShutdown(t, s.ShutdownRequested(), 500*time.Millisecond)
}

func connectPagePresence(t *testing.T, origin, pageID, token string) (*websocket.Conn, <-chan struct{}) {
	t.Helper()
	target := "ws" + strings.TrimPrefix(origin, "http") + "/ws/page"
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, target, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{origin}}})
	if err != nil {
		t.Fatalf("dial page presence: %v", err)
	}
	payload := `{"type":"page.hello","pageId":"` + pageID + `","token":"` + token + `"}`
	if err = conn.Write(ctx, websocket.MessageText, []byte(payload)); err != nil {
		_ = conn.Close(websocket.StatusNormalClosure, "test")
		t.Fatalf("write page auth: %v", err)
	}
	_, raw, err := conn.Read(ctx)
	if err != nil {
		_ = conn.Close(websocket.StatusNormalClosure, "test")
		t.Fatalf("read page auth ack: %v", err)
	}
	var ack struct {
		Type string `json:"type"`
	}
	if err = json.Unmarshal(raw, &ack); err != nil || ack.Type != "page.ready" {
		_ = conn.Close(websocket.StatusNormalClosure, "test")
		t.Fatalf("page auth ack=%s err=%v", raw, err)
	}
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		for {
			if _, _, readErr := conn.Read(context.Background()); readErr != nil {
				return
			}
		}
	}()
	return conn, readDone
}

func TestOpenPagePresenceSurvivesFrozenJavaScriptTimersPastLeaseTTL(t *testing.T) {
	s, origin := pageLifecycleServer(t, Config{PageLeaseTTL: 80 * time.Millisecond, PageLeaseShutdownGrace: 80 * time.Millisecond, PageStartupGrace: 700 * time.Millisecond, PageLeaseSweepInterval: 5 * time.Millisecond, PagePresencePingInterval: 15 * time.Millisecond, PagePresencePingTimeout: 35 * time.Millisecond})
	conn, _ := connectPagePresence(t, origin, "frozen-page", s.localControlToken)
	time.Sleep(250 * time.Millisecond) // Longer than the HTTP lease and close grace; no application heartbeat is sent.
	assertRunning(t, s.ShutdownRequested())
	_ = conn.Close(websocket.StatusNormalClosure, "tab closed")
	waitShutdown(t, s.ShutdownRequested(), 350*time.Millisecond)
}

func TestPagePresencePingTimeoutReleasesUnresponsivePage(t *testing.T) {
	s, origin := pageLifecycleServer(t, Config{PageLeaseTTL: 80 * time.Millisecond, PageLeaseShutdownGrace: 80 * time.Millisecond, PageStartupGrace: 700 * time.Millisecond, PageLeaseSweepInterval: 5 * time.Millisecond, PagePresencePingInterval: 15 * time.Millisecond, PagePresencePingTimeout: 35 * time.Millisecond})
	target := "ws" + strings.TrimPrefix(origin, "http") + "/ws/page"
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, target, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{origin}}})
	if err != nil {
		t.Fatalf("page websocket handshake: %v", err)
	}
	if err = conn.Write(ctx, websocket.MessageText, []byte(`{"type":"page.hello","pageId":"unresponsive-page","token":"`+s.localControlToken+`"}`)); err != nil {
		t.Fatalf("page websocket auth: %v", err)
	}
	if _, _, err = conn.Read(ctx); err != nil {
		t.Fatalf("page websocket ack: %v", err)
	}
	// No further client read occurs, so the protocol Ping receives no Pong.
	waitShutdown(t, s.ShutdownRequested(), 500*time.Millisecond)
	_ = conn.CloseNow()
}

func TestPagePresenceRefreshReconnectCancelsFinalPageGrace(t *testing.T) {
	s, origin := pageLifecycleServer(t, Config{PageLeaseTTL: 80 * time.Millisecond, PageLeaseShutdownGrace: 160 * time.Millisecond, PageStartupGrace: 700 * time.Millisecond, PageLeaseSweepInterval: 5 * time.Millisecond, PagePresencePingInterval: 20 * time.Millisecond, PagePresencePingTimeout: 40 * time.Millisecond})
	first, _ := connectPagePresence(t, origin, "before-refresh", s.localControlToken)
	_ = first.Close(websocket.StatusNormalClosure, "refresh")
	time.Sleep(30 * time.Millisecond)
	second, _ := connectPagePresence(t, origin, "after-refresh", s.localControlToken)
	time.Sleep(210 * time.Millisecond)
	assertRunning(t, s.ShutdownRequested())
	_ = second.Close(websocket.StatusNormalClosure, "tab closed")
	waitShutdown(t, s.ShutdownRequested(), 350*time.Millisecond)
}

func TestClosingOneOfMultiplePagePresenceSocketsKeepsServiceAlive(t *testing.T) {
	s, origin := pageLifecycleServer(t, Config{PageLeaseTTL: 80 * time.Millisecond, PageLeaseShutdownGrace: 80 * time.Millisecond, PageStartupGrace: 700 * time.Millisecond, PageLeaseSweepInterval: 5 * time.Millisecond, PagePresencePingInterval: 15 * time.Millisecond, PagePresencePingTimeout: 35 * time.Millisecond})
	first, _ := connectPagePresence(t, origin, "tab-one", s.localControlToken)
	second, _ := connectPagePresence(t, origin, "tab-two", s.localControlToken)
	_ = first.Close(websocket.StatusNormalClosure, "one tab closed")
	time.Sleep(230 * time.Millisecond)
	assertRunning(t, s.ShutdownRequested())
	_ = second.Close(websocket.StatusNormalClosure, "last tab closed")
	waitShutdown(t, s.ShutdownRequested(), 350*time.Millisecond)
}

func TestExplicitShutdownClosesPagePresenceConnection(t *testing.T) {
	s, origin := pageLifecycleServer(t, Config{PageStartupGrace: 2 * time.Second, PageLeaseSweepInterval: 5 * time.Millisecond, PagePresencePingInterval: 20 * time.Millisecond, PagePresencePingTimeout: 40 * time.Millisecond})
	conn, readDone := connectPagePresence(t, origin, "owned-page", s.localControlToken)
	defer conn.Close(websocket.StatusNormalClosure, "test cleanup")
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if err := s.Shutdown(ctx); err != nil {
		t.Fatalf("explicit service shutdown: %v", err)
	}
	select {
	case <-readDone:
	case <-time.After(100 * time.Millisecond):
		t.Fatal("explicit shutdown left the page presence websocket alive")
	}
}

func TestPagePresenceConnectionLimitBoundsAdditionalSockets(t *testing.T) {
	s, origin := pageLifecycleServer(t, Config{PageStartupGrace: 2 * time.Second, PageLeaseSweepInterval: 5 * time.Millisecond, PagePresencePingInterval: time.Second, PagePresencePingTimeout: time.Second})
	target := "ws" + strings.TrimPrefix(origin, "http") + "/ws/page"
	badUpgrade, err := http.NewRequest(http.MethodGet, origin+"/ws/page", nil)
	if err != nil {
		t.Fatal(err)
	}
	badUpgrade.Header.Set("Origin", origin)
	badResponse, err := http.DefaultClient.Do(badUpgrade)
	if err != nil {
		t.Fatalf("non-websocket request: %v", err)
	}
	_ = badResponse.Body.Close()
	if badResponse.StatusCode < http.StatusBadRequest {
		t.Fatalf("malformed websocket upgrade status=%d, want rejection", badResponse.StatusCode)
	}
	unauthorizedCtx, unauthorizedCancel := context.WithTimeout(context.Background(), time.Second)
	defer unauthorizedCancel()
	unauthorized, _, err := websocket.Dial(unauthorizedCtx, target, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{origin}}})
	if err != nil {
		t.Fatalf("unauthorized handshake: %v", err)
	}
	if err = unauthorized.Write(unauthorizedCtx, websocket.MessageText, []byte(`{"type":"page.hello","pageId":"invalid-page","token":"wrong"}`)); err != nil {
		t.Fatalf("write invalid page auth: %v", err)
	}
	if _, _, err = unauthorized.Read(unauthorizedCtx); err == nil {
		t.Fatal("invalid first-frame auth remained open")
	}
	_ = unauthorized.Close(websocket.StatusNormalClosure, "rejected")

	connections := make([]*websocket.Conn, 0, maxPagePresenceConnections)
	for i := 0; i < maxPagePresenceConnections; i++ {
		conn, _ := connectPagePresence(t, origin, "page-"+strconv.Itoa(i), s.localControlToken)
		connections = append(connections, conn)
	}
	extraCtx, extraCancel := context.WithTimeout(context.Background(), time.Second)
	defer extraCancel()
	if extra, _, err := websocket.Dial(extraCtx, target, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{origin}}}); err == nil {
		_ = extra.Close(websocket.StatusNormalClosure, "unexpected extra session")
		t.Fatal("page presence connection limit accepted a 17th websocket handshake")
	}
	for _, conn := range connections {
		_ = conn.Close(websocket.StatusNormalClosure, "test complete")
	}
}

func TestExplicitShutdownClosesUnauthenticatedPendingPageConnection(t *testing.T) {
	s, origin := pageLifecycleServer(t, Config{PageStartupGrace: 2 * time.Second, PageLeaseSweepInterval: 5 * time.Millisecond})
	target := "ws" + strings.TrimPrefix(origin, "http") + "/ws/page"
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, target, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{origin}}})
	if err != nil {
		t.Fatalf("pending websocket handshake: %v", err)
	}
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer shutdownCancel()
	if err = s.Shutdown(shutdownCtx); err != nil {
		t.Fatalf("explicit service shutdown with pending page auth: %v", err)
	}
	readCtx, readCancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer readCancel()
	if _, _, err = conn.Read(readCtx); err == nil {
		t.Fatal("explicit shutdown left unauthenticated pending websocket open")
	}
	_ = conn.Close(websocket.StatusNormalClosure, "test cleanup")
}

func TestShutdownDoesNotWaitForUnresponsivePageCloseHandshake(t *testing.T) {
	s, origin := pageLifecycleServer(t, Config{PageStartupGrace: 2 * time.Second, PageLeaseSweepInterval: 5 * time.Millisecond, PagePresencePingInterval: time.Hour})
	target := "ws" + strings.TrimPrefix(origin, "http") + "/ws/page"
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, target, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{origin}}})
	if err != nil {
		t.Fatalf("page websocket handshake: %v", err)
	}
	if err = conn.Write(ctx, websocket.MessageText, []byte(`{"type":"page.hello","pageId":"unresponsive-page","token":"`+s.localControlToken+`"}`)); err != nil {
		t.Fatalf("page websocket auth: %v", err)
	}
	if _, _, err = conn.Read(ctx); err != nil {
		t.Fatalf("page websocket ack: %v", err)
	}
	started := time.Now()
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer shutdownCancel()
	if err = s.Shutdown(shutdownCtx); err != nil {
		t.Fatalf("shutdown with page socket: %v", err)
	}
	if elapsed := time.Since(started); elapsed > 150*time.Millisecond {
		t.Fatalf("shutdown waited %v for an unresponsive page close handshake", elapsed)
	}
	_ = conn.CloseNow()
}

func TestPagePresenceRequiresLocalOriginAndFirstFrameSecret(t *testing.T) {
	s, origin := pageLifecycleServer(t, Config{PageStartupGrace: 450 * time.Millisecond, PageLeaseSweepInterval: 5 * time.Millisecond, PagePresencePingInterval: 20 * time.Millisecond, PagePresencePingTimeout: 40 * time.Millisecond})
	target := "ws" + strings.TrimPrefix(origin, "http") + "/ws/page"
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, _, err := websocket.Dial(ctx, target, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{"http://evil.example"}}}); err == nil {
		t.Fatal("foreign origin opened page presence websocket")
	}
	conn, _, err := websocket.Dial(ctx, target, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{origin}}})
	if err != nil {
		t.Fatalf("local-origin websocket handshake: %v", err)
	}
	if err = conn.Write(ctx, websocket.MessageText, []byte(`{"type":"page.hello","pageId":"bad-secret","token":"wrong"}`)); err != nil {
		t.Fatalf("write invalid page auth: %v", err)
	}
	if _, _, err = conn.Read(ctx); err == nil {
		t.Fatal("invalid first-frame secret was accepted")
	}
	_ = conn.Close(websocket.StatusNormalClosure, "rejected")
	conn, _, err = websocket.Dial(ctx, target, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{origin}}})
	if err != nil {
		t.Fatalf("local-origin websocket handshake for binary frame: %v", err)
	}
	if err = conn.Write(ctx, websocket.MessageBinary, []byte(`{"type":"page.hello","pageId":"binary-frame","token":"`+s.localControlToken+`"}`)); err != nil {
		t.Fatalf("write binary page auth: %v", err)
	}
	if _, _, err = conn.Read(ctx); err == nil {
		t.Fatal("binary page.hello frame was accepted")
	}
	_ = conn.Close(websocket.StatusNormalClosure, "rejected")
	waitShutdown(t, s.ShutdownRequested(), time.Second)
}

func TestServiceWithNoOpenedPageExpiresAfterStartupGrace(t *testing.T) {
	s, _ := pageLifecycleServer(t, Config{PageLeaseTTL: 80 * time.Millisecond, PageLeaseShutdownGrace: 30 * time.Millisecond, PageStartupGrace: 100 * time.Millisecond, PageLeaseSweepInterval: 5 * time.Millisecond})
	waitShutdown(t, s.ShutdownRequested(), 350*time.Millisecond)
}

func TestPageLeaseRejectsUnauthorizedOriginsRemotesAndTokens(t *testing.T) {
	s, origin := pageLifecycleServer(t, Config{PageLeaseTTL: 120 * time.Millisecond, PageLeaseShutdownGrace: 80 * time.Millisecond, PageStartupGrace: 400 * time.Millisecond, PageLeaseSweepInterval: 5 * time.Millisecond})
	if code := postPageLease(t, s, origin, "evil-origin", s.localControlToken, "127.0.0.1:1234", "http://evil.example"); code != http.StatusForbidden {
		t.Fatalf("evil origin status = %d", code)
	}
	if code := postPageLease(t, s, origin, "lan-peer", s.localControlToken, "192.168.1.20:1234"); code != http.StatusForbidden {
		t.Fatalf("LAN remote status = %d", code)
	}
	if code := postPageLease(t, s, origin, "bad-token", "wrong-token", "127.0.0.1:1234"); code != http.StatusForbidden {
		t.Fatalf("bad token status = %d", code)
	}
	if code := postPageLease(t, s, origin, "bad/page", s.localControlToken, "127.0.0.1:1234"); code != http.StatusBadRequest {
		t.Fatalf("malformed page ID status = %d", code)
	}
	waitShutdown(t, s.ShutdownRequested(), 700*time.Millisecond)
}

func TestPageLeaseRouteDoesNotExposeCredentialToLANBootstrap(t *testing.T) {
	s := New(Config{})
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8080/api/v1/page-lease", strings.NewReader(`{"pageId":"page-a"}`))
	req.RemoteAddr = net.JoinHostPort("192.168.1.9", "1234")
	req.Host = "127.0.0.1:8080"
	req.Header.Set("Origin", "http://127.0.0.1:8080")
	req.Header.Set("X-Local-Control-Token", s.localControlToken)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("LAN page-lease status = %d, want forbidden", w.Code)
	}
}
