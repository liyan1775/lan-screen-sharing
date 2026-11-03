package app

import (
	"bufio"
	"context"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"lan-screen-sharing/internal/web"
)

const (
	visibleHarnessTTL         = 45 * time.Minute
	visibleHarnessBridgeCap   = 32
	visibleHarnessOwnerHeader = "X-LANSW-Harness-Bridge-Owner"
)

type bridgeSocketRecorder struct {
	mu    sync.Mutex
	conns map[net.Conn]struct{}
	token string
}

func newBridgeSocketRecorder(token string) *bridgeSocketRecorder {
	return &bridgeSocketRecorder{conns: make(map[net.Conn]struct{}), token: token}
}

func visibleHarnessOwnerMarker(token, alias string) string { return token + ":" + alias }

type visibleHarnessTokenDiagnostics struct {
	present         bool
	utf8Bytes       int
	asciiLowerHex   bool
	decodedBytes    int
	decodeErrorKind string
	validatorOK     bool
}

func diagnoseVisibleHarnessOwnerToken(token string) visibleHarnessTokenDiagnostics {
	diagnostics := visibleHarnessTokenDiagnostics{
		present:         token != "",
		utf8Bytes:       len([]byte(token)),
		asciiLowerHex:   len(token) > 0,
		decodeErrorKind: "none",
	}
	for _, b := range []byte(token) {
		if !((b >= '0' && b <= '9') || (b >= 'a' && b <= 'f')) {
			diagnostics.asciiLowerHex = false
			break
		}
	}
	decoded, err := hex.DecodeString(token)
	if err != nil {
		if errors.Is(err, hex.ErrLength) {
			diagnostics.decodeErrorKind = "odd_length"
		} else {
			diagnostics.decodeErrorKind = "invalid_byte"
		}
	} else {
		diagnostics.decodedBytes = len(decoded)
	}
	diagnostics.validatorOK = diagnostics.present && diagnostics.utf8Bytes == 64 && err == nil && diagnostics.decodedBytes == 32
	return diagnostics
}

func validateVisibleHarnessOwnerToken(token string) error {
	diagnostics := diagnoseVisibleHarnessOwnerToken(token)
	if !diagnostics.present || diagnostics.utf8Bytes != 64 || diagnostics.decodeErrorKind != "none" || diagnostics.decodedBytes != 32 {
		return errors.New("visible harness owner token must encode exactly 32 bytes as 64 hexadecimal characters")
	}
	return nil
}

func (r *bridgeSocketRecorder) Record(conn net.Conn, marker string) {
	providedToken, alias, ok := strings.Cut(marker, ":")
	if conn == nil || !ok || (alias != "viewer-1" && alias != "viewer-2") || len(providedToken) != len(r.token) || subtle.ConstantTimeCompare([]byte(providedToken), []byte(r.token)) != 1 {
		return
	}
	r.mu.Lock()
	if len(r.conns) < visibleHarnessBridgeCap {
		r.conns[conn] = struct{}{}
	}
	r.mu.Unlock()
}

func (r *bridgeSocketRecorder) Count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.conns)
}

type visibleHarnessBridgeTransport struct {
	mu     sync.Mutex
	base   http.RoundTripper
	marker string
	marked int
	calls  int
	path   string
	host   string
}

func (t *visibleHarnessBridgeTransport) MarkedRequests() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.marked
}

func (t *visibleHarnessBridgeTransport) RoundTrips() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.calls
}

func (t *visibleHarnessBridgeTransport) LastTarget() (string, string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.path, t.host
}

func (t *visibleHarnessBridgeTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	t.mu.Lock()
	t.calls++
	t.path, t.host = request.URL.Path, request.URL.Host
	t.mu.Unlock()
	clone := request
	if request.URL.Path == "/signal/v1" {
		host, _, err := net.SplitHostPort(request.URL.Host)
		ip := net.ParseIP(host)
		if err == nil && ip != nil && ip.To4() != nil && ip.IsPrivate() && !ip.IsLoopback() && t.marker != "" {
			clone = request.Clone(request.Context())
			clone.Header = request.Header.Clone()
			clone.Header.Set(visibleHarnessOwnerHeader, t.marker)
			t.mu.Lock()
			t.marked++
			t.mu.Unlock()
		}
	}
	return t.base.RoundTrip(clone)
}

func installVisibleHarnessBridgeOwnership(token, alias string) error {
	if err := validateVisibleHarnessOwnerToken(token); err != nil {
		return err
	}
	if alias != "viewer-1" && alias != "viewer-2" && alias != "viewer-extra" {
		return errors.New("visible harness bridge alias is invalid")
	}
	base := http.DefaultClient.Transport
	if base == nil {
		base = http.DefaultTransport
	}
	marker := ""
	if alias == "viewer-1" || alias == "viewer-2" {
		marker = visibleHarnessOwnerMarker(token, alias)
	}
	http.DefaultClient.Transport = &visibleHarnessBridgeTransport{base: base, marker: marker}
	return nil
}

func initializeVisibleHarnessBridgeOwnership(token, role, alias string) error {
	switch role {
	case "host":
		if alias != "host" {
			return errors.New("visible harness host alias is invalid")
		}
		return validateVisibleHarnessOwnerToken(token)
	case "viewer":
		if alias != "viewer-1" && alias != "viewer-2" && alias != "viewer-extra" {
			return errors.New("visible harness viewer alias is invalid")
		}
		return installVisibleHarnessBridgeOwnership(token, alias)
	default:
		return errors.New("visible harness role is invalid")
	}
}

func (r *bridgeSocketRecorder) CloseAll() int {
	r.mu.Lock()
	conns := make([]net.Conn, 0, len(r.conns))
	for conn := range r.conns {
		conns = append(conns, conn)
		delete(r.conns, conn)
	}
	r.mu.Unlock()
	closed := 0
	for _, conn := range conns {
		if conn.Close() == nil {
			closed++
		}
	}
	return closed
}

type visibleHarnessResponseWriter struct {
	http.ResponseWriter
	recorder *bridgeSocketRecorder
	marker   string
}

func (w *visibleHarnessResponseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *visibleHarnessResponseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("underlying response writer does not support websocket hijack")
	}
	conn, reader, err := hijacker.Hijack()
	if err == nil {
		w.recorder.Record(conn, w.marker)
	}
	return conn, reader, err
}

func registerVisibleHarnessRoutes(s *Server, recorder *bridgeSocketRecorder, role, alias string) {
	productionLANHandler := s.lanHandler
	s.lanHandler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		wrapped := &visibleHarnessResponseWriter{ResponseWriter: w, recorder: recorder, marker: r.Header.Get(visibleHarnessOwnerHeader)}
		// Keep the actual production signal handler and request intact.
		productionLANHandler.ServeHTTP(wrapped, r)
	})
	s.localMux.HandleFunc("/__visible_test__/", serveVisibleHarnessPage(role))
	s.localMux.HandleFunc("/__visible_test__/bootstrap.js", serveVisibleHarnessBootstrap(role, alias))
	s.localMux.HandleFunc("/__visible_test__/controller.js", serveVisibleHarnessAsset("tests/e2e/visible-harness/controller.js"))
	s.localMux.HandleFunc("/__visible_test__/assertions.js", serveVisibleHarnessAsset("tests/e2e/visible-harness/assertions.js"))
	s.localMux.HandleFunc("/__visible_test__/silent-output.js", serveVisibleHarnessAsset("tests/e2e/visible-harness/silent-output.js"))
	s.localMux.HandleFunc("/__visible_test__/synthetic-media.js", serveVisibleHarnessAsset("tests/e2e/fixtures/synthetic-media.js"))
	s.localMux.HandleFunc("/__visible_test__/fault/drop-bridges", func(w http.ResponseWriter, r *http.Request) {
		if role != "host" || r.URL.Path != "/__visible_test__/fault/drop-bridges" || r.URL.RawQuery != "" || r.Method != http.MethodPost || r.ContentLength > 0 || !validLocalBrowserRequest(r) || !s.authorizeLocalControl(r, r.Header.Get("X-Local-Control-Token")) {
			writeError(w, http.StatusForbidden, "AUTH_REQUIRED", "测试桥接故障控制未通过本机验证", false)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(map[string]int{"closed": recorder.CloseAll()})
	})
}

func visibleHarnessLocalRequest(r *http.Request) bool {
	ipText, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(ipText)
	return ip != nil && ip.IsLoopback() && isLoopbackName(requestHost(r.Host))
}

func serveVisibleHarnessPage(role string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/__visible_test__/" || r.Method != http.MethodGet || !visibleHarnessLocalRequest(r) || r.URL.Query().Get("role") != role || (role != "host" && role != "viewer") {
			http.NotFound(w, r)
			return
		}
		page, err := web.Assets.ReadFile("assets/index.html")
		if err != nil {
			http.Error(w, "page unavailable", http.StatusInternalServerError)
			return
		}
		const original = `<script type="module" src="/assets/app.js"></script>`
		if strings.Count(string(page), original) != 1 {
			http.Error(w, "production app entry is not unique", http.StatusInternalServerError)
			return
		}
		page = []byte(strings.Replace(string(page), original, `<script type="module" src="/__visible_test__/bootstrap.js"></script>`, 1))
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(page)
	}
}

func serveVisibleHarnessBootstrap(role, alias string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		validAlias := (role == "host" && alias == "host") || (role == "viewer" && (alias == "viewer-1" || alias == "viewer-2" || alias == "viewer-extra"))
		if r.Method != http.MethodGet || !visibleHarnessLocalRequest(r) || r.URL.RawQuery != "" || !validAlias {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = fmt.Fprintf(w, `import { installSilentMediaOutput } from '/__visible_test__/silent-output.js';
import { installSyntheticMedia } from '/__visible_test__/synthetic-media.js';
import { installVisibleHarness } from '/__visible_test__/controller.js';
const query = new URLSearchParams(location.search);
const role = %q;
const alias = %q;
const denyMic = query.get('deny-mic') === '1';
const silentOutput = installSilentMediaOutput();
window.__lanScreenSilentOutput = silentOutput;
installSyntheticMedia({ denyMicrophone: denyMic, participantAlias: alias });
await import('/assets/app.js');
await installVisibleHarness({ role, alias, denyMic, silentOutput });
`, role, alias)
	}
}

func serveVisibleHarnessAsset(relativePath string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || !visibleHarnessLocalRequest(r) {
			http.NotFound(w, r)
			return
		}
		root, err := os.Getwd()
		if err != nil {
			http.Error(w, "test assets unavailable", http.StatusInternalServerError)
			return
		}
		var data []byte
		for _, base := range []string{root, filepath.Dir(root), filepath.Dir(filepath.Dir(root))} {
			data, err = os.ReadFile(filepath.Join(base, filepath.FromSlash(relativePath)))
			if err == nil {
				break
			}
		}
		if err != nil {
			http.Error(w, "test asset unavailable", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(data)
	}
}

func runVisibleHarness(t *testing.T, _ context.Context) {
	role := os.Getenv("LANSW_HARNESS_ROLE")
	if role != "host" && role != "viewer" {
		t.Fatal("LANSW_HARNESS_ROLE must be host or viewer")
	}
	alias := os.Getenv("LANSW_HARNESS_ALIAS")
	if (role == "host" && alias != "host") || (role == "viewer" && alias != "viewer-1" && alias != "viewer-2" && alias != "viewer-extra") {
		t.Fatal("LANSW_HARNESS_ALIAS must match the host/viewer-1/viewer-2/viewer-extra runner role")
	}
	ownerToken := os.Getenv("LANSW_HARNESS_OWNER_TOKEN")
	diagnostics := diagnoseVisibleHarnessOwnerToken(ownerToken)
	fmt.Printf("VISIBLE_HARNESS_ENV_DIAGNOSTIC role=%s alias=%s present=%t utf8_bytes=%d ascii_lower_hex=%t decoded_bytes=%d decode_error_kind=%s validator_ok=%t\n",
		role, alias, diagnostics.present, diagnostics.utf8Bytes, diagnostics.asciiLowerHex, diagnostics.decodedBytes, diagnostics.decodeErrorKind, diagnostics.validatorOK)
	originalTransport := http.DefaultClient.Transport
	if err := initializeVisibleHarnessBridgeOwnership(ownerToken, role, alias); err != nil {
		t.Fatalf("visible harness %s/%s initialization failed: %v", role, alias, err)
	}
	defer func() { http.DefaultClient.Transport = originalTransport }()
	ipv4 := firstPrivateIPv4()
	if ipv4 == "" {
		t.Fatal("visible CUA harness requires an RFC1918 IPv4 interface")
	}
	s := New(Config{LANIPv4: ipv4, SignalPort: 0, RoomTTL: visibleHarnessTTL, PageStartupGrace: visibleHarnessTTL})
	recorder := newBridgeSocketRecorder(ownerToken)
	defer recorder.CloseAll()
	registerVisibleHarnessRoutes(s, recorder, role, alias)
	ctx, cancel := context.WithTimeout(context.Background(), visibleHarnessTTL)
	defer cancel()
	listener, err := s.StartAtPort(ctx, 0, 1)
	if err != nil {
		t.Fatalf("start visible harness service: %v", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	baseURL := fmt.Sprintf("http://localhost:%d/__visible_test__/?role=%s", port, url.QueryEscape(role))
	fmt.Printf("VISIBLE_HARNESS_READY role=%s URL=%s\n", role, baseURL)
	select {
	case <-s.ShutdownRequested():
	case <-ctx.Done():
	}
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	if err := s.Shutdown(shutdownCtx); err != nil {
		t.Errorf("graceful visible harness shutdown: %v", err)
	}
}
