package app

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/coder/websocket"
	"lan-screen-sharing/internal/discovery"
	"lan-screen-sharing/internal/room"
	"lan-screen-sharing/internal/screenrelay"
	"lan-screen-sharing/internal/signal"
	"lan-screen-sharing/internal/web"
)

type Config struct {
	LANIPv4                  string
	PreferencesPath          string
	SignalPort               int
	RoomTTL                  time.Duration // Optional hard lifetime; zero keeps rooms until explicit end or host recovery expires.
	PageLeaseTTL             time.Duration
	PageLeaseShutdownGrace   time.Duration
	PageStartupGrace         time.Duration
	PageLeaseSweepInterval   time.Duration
	PagePresencePingInterval time.Duration
	PagePresencePingTimeout  time.Duration
}

const maxPagePresenceConnections = 16

type Server struct {
	config              Config
	rooms               *room.Manager
	hub                 *signal.Hub
	screens             *screenrelay.Manager
	serviceID           string
	hostToken           string
	localControlToken   string
	shutdownRequested   chan struct{}
	shutdownOnce        sync.Once
	shutdownMu          sync.Mutex
	shutdownStarted     bool
	shutdownDone        chan struct{}
	shutdownErr         error
	lifecycleMu         sync.Mutex
	listeners           []net.Listener
	httpServers         []*http.Server
	runContext          context.Context
	stopped             bool
	localMux            *http.ServeMux
	wrapLANHandler      func(http.Handler) http.Handler
	lanMu               sync.RWMutex
	lanIP               string
	lanAutoSelected     bool
	lanPort             int
	lanActive           bool
	lanListener         net.Listener
	lanServer           *http.Server
	cancelLAN           context.CancelFunc
	preferences         *preferenceStore
	listLANInterfaces   func() []LANInterface
	listenLAN           func(string, int) (net.Listener, error)
	startDiscovery      func(context.Context, string, func() []discovery.Advertisement) (lanDiscovery, error)
	pageLeaseMu         sync.Mutex
	pageLeases          map[string]time.Time
	pageLeaseEverSeen   bool
	pageLeaseExitAt     time.Time
	pageStartedAt       time.Time
	pendingPageSessions int
	activePageSessions  int
	pagePresenceConns   map[*websocket.Conn]struct{}
	pagePresenceIDs     map[string]int
	discoveryService    lanDiscovery
	discoveryError      string
}

type Bootstrap struct {
	lanState
	ScreenRelay       bool         `json:"screenRelay"`
	ServiceID         string       `json:"serviceId"`
	LocalWSPath       string       `json:"localWsPath"`
	RoleOptions       []string     `json:"roleOptions"`
	HostControlToken  string       `json:"hostControlToken,omitempty"`
	LocalControlToken string       `json:"localControlToken,omitempty"`
	Preferences       *Preferences `json:"preferences,omitempty"`
}

func New(config Config) *Server {
	if config.PageLeaseTTL <= 0 {
		config.PageLeaseTTL = 10 * time.Second
	}
	if config.PageLeaseShutdownGrace <= 0 {
		config.PageLeaseShutdownGrace = 30 * time.Second
	}
	if config.PageStartupGrace <= 0 {
		config.PageStartupGrace = 30 * time.Second
	}
	if config.PageLeaseSweepInterval <= 0 {
		config.PageLeaseSweepInterval = time.Second
	}
	if config.PagePresencePingInterval <= 0 {
		config.PagePresencePingInterval = 4 * time.Second
	}
	if config.PagePresencePingTimeout <= 0 {
		config.PagePresencePingTimeout = 6 * time.Second
	}
	token, _ := newHostToken()
	serviceID, _ := newHostToken()
	managerOptions := []room.Option{}
	if config.RoomTTL > 0 {
		managerOptions = append(managerOptions, room.WithRoomTTL(config.RoomTTL))
	}
	controlToken, _ := newHostToken()
	store := openPreferences(config.PreferencesPath)
	preferred := store.snapshot().PreferredLANIPv4
	lanIP := selectLANIPv4(config.LANIPv4, preferred, rankLANInterfaces(enumerateLANInterfaces()))
	s := &Server{config: config, rooms: room.NewManager(managerOptions...), serviceID: serviceID, hostToken: token, localControlToken: controlToken, shutdownRequested: make(chan struct{}), shutdownDone: make(chan struct{}), pageLeases: make(map[string]time.Time), pagePresenceConns: make(map[*websocket.Conn]struct{}), pagePresenceIDs: make(map[string]int),
		preferences: store, lanIP: lanIP, lanAutoSelected: config.LANIPv4 == "" && lanIP != preferred, listLANInterfaces: enumerateLANInterfaces, listenLAN: ListenLAN,
		startDiscovery: func(ctx context.Context, ip string, advertise func() []discovery.Advertisement) (lanDiscovery, error) {
			return discovery.Start(ctx, ip, advertise)
		},
	}
	s.hub = signal.NewHub(s.rooms)
	s.screens = screenrelay.New(lanIP)
	s.hub.SetHostCreatedHandler(func() error {
		s.lifecycleMu.Lock()
		ctx := s.runContext
		s.lifecycleMu.Unlock()
		s.lanMu.RLock()
		alreadyActive := s.lanActive && s.lanListener != nil
		s.lanMu.RUnlock()
		if alreadyActive {
			return nil
		}
		if ctx != nil {
			_, err := s.StartLAN(ctx)
			return err
		}
		return errors.New("SERVICE_START_FAILED: service is not running")
	})
	s.rooms.SetExpirationHandler(s.hub.RoomExpired)
	s.localMux = http.NewServeMux()
	s.localMux.HandleFunc("/", s.servePage)
	assetFS, _ := fs.Sub(web.Assets, "assets")
	s.localMux.Handle("/assets/", http.StripPrefix("/assets/", http.FileServer(http.FS(assetFS))))
	s.localMux.HandleFunc("/api/v1/bootstrap", s.serveBootstrap)
	s.localMux.HandleFunc("/api/v1/network", s.serveNetwork)
	s.localMux.HandleFunc("/api/v1/preferences", s.servePreferences)
	s.localMux.HandleFunc("/api/v1/rooms", s.serveDiscoveredRooms)
	s.localMux.HandleFunc("/api/v1/discovery/refresh", s.serveDiscoveryRefresh)
	s.localMux.HandleFunc("/api/v1/shutdown", s.serveShutdown)
	s.localMux.HandleFunc("/api/v1/page-lease", s.servePageLease)
	s.localMux.HandleFunc("/api/v1/screen-relay", s.serveScreenRelay)
	s.localMux.HandleFunc("/ws/page", s.servePagePresence)
	s.localMux.HandleFunc("/ws/v1", s.serveLocalWS)
	return s
}

func (s *Server) Handler() http.Handler { return s.localMux }
func (s *Server) Rooms() *room.Manager  { return s.rooms }

func (s *Server) LANHandler() http.Handler {
	s.lanMu.RLock()
	defer s.lanMu.RUnlock()
	return s.lanHandlerFor(s.lanIP)
}

func (s *Server) servePage(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	if r.Method != "GET" {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	data, err := web.Assets.ReadFile("assets/index.html")
	if err != nil {
		http.Error(w, "page unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(data)
}

func (s *Server) serveBootstrap(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	role := r.URL.Query().Get("role")
	if role != "" && role != "host" && role != "viewer" {
		writeError(w, http.StatusBadRequest, "INVALID_ROLE", "角色无效", false)
		return
	}
	b := Bootstrap{ServiceID: s.serviceID, LocalWSPath: "/ws/v1", RoleOptions: []string{"host", "viewer"}}
	local := validLocalBootstrapRequest(r)
	if local {
		b.LocalControlToken = s.localControlToken
		b.ScreenRelay = true
		s.lanMu.RLock()
		b.lanState = s.networkStateLocked()
		prefs := s.preferences.snapshot()
		b.Preferences = &prefs
		s.lanMu.RUnlock()
	}
	if role == "host" {
		if !local {
			writeError(w, http.StatusForbidden, "AUTH_REQUIRED", "主播控制仅限本机页面", false)
			return
		}
		b.HostControlToken = s.hostToken
	}
	writeJSON(w, b)
}

func (s *Server) serveShutdown(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || !validLocalBrowserRequest(r) || !s.authorizeLocalControl(r, r.Header.Get("X-Local-Control-Token")) {
		writeError(w, http.StatusForbidden, "AUTH_REQUIRED", "退出请求未通过本机验证", false)
		return
	}
	w.WriteHeader(http.StatusAccepted)
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}
	s.shutdownOnce.Do(func() { close(s.shutdownRequested) })
}

func (s *Server) servePageLease(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || r.URL.RawQuery != "" || !validLocalBrowserRequest(r) || !s.authorizeLocalControl(r, r.Header.Get("X-Local-Control-Token")) {
		writeError(w, http.StatusForbidden, "AUTH_REQUIRED", "本机页面租约验证失败", false)
		return
	}
	defer r.Body.Close()
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	var request struct {
		PageID string `json:"pageId"`
	}
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(&request); err != nil || !validPageID(request.PageID) {
		writeError(w, http.StatusBadRequest, "INVALID_PAGE_LEASE", "本机页面租约无效", false)
		return
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		writeError(w, http.StatusBadRequest, "INVALID_PAGE_LEASE", "本机页面租约无效", false)
		return
	}
	s.pageLeaseMu.Lock()
	if s.pagePresenceIDs[request.PageID] == 0 {
		s.pageLeaseEverSeen = true
		s.pageLeaseExitAt = time.Time{}
		s.pageLeases[request.PageID] = time.Now().Add(s.config.PageLeaseTTL)
	} else {
		delete(s.pageLeases, request.PageID)
	}
	s.pageLeaseMu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

func validPageID(id string) bool {
	if len(id) == 0 || len(id) > 64 {
		return false
	}
	for _, c := range id {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

func (s *Server) servePagePresence(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet || r.URL.RawQuery != "" || !validLocalBrowserRequest(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	s.pageLeaseMu.Lock()
	select {
	case <-s.shutdownRequested:
		s.pageLeaseMu.Unlock()
		http.Error(w, "service is stopping", http.StatusServiceUnavailable)
		return
	default:
	}
	if s.pendingPageSessions+s.activePageSessions >= maxPagePresenceConnections {
		s.pageLeaseMu.Unlock()
		http.Error(w, "too many page sessions", http.StatusServiceUnavailable)
		return
	}
	s.pendingPageSessions++
	s.pageLeaseMu.Unlock()
	reserved, registered, active := true, false, false
	pageID := ""
	var conn *websocket.Conn
	defer func() {
		s.pageLeaseMu.Lock()
		if reserved {
			s.pendingPageSessions--
		}
		if registered {
			delete(s.pagePresenceConns, conn)
		}
		if active {
			s.activePageSessions--
			if s.pagePresenceIDs[pageID] <= 1 {
				delete(s.pagePresenceIDs, pageID)
				delete(s.pageLeases, pageID)
			} else {
				s.pagePresenceIDs[pageID]--
			}
		}
		s.pageLeaseMu.Unlock()
		if conn != nil {
			_ = conn.CloseNow()
		}
	}()
	var err error
	conn, err = websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: []string{r.Host}})
	if err != nil {
		return
	}
	conn.SetReadLimit(1024)
	s.pageLeaseMu.Lock()
	select {
	case <-s.shutdownRequested:
		s.pageLeaseMu.Unlock()
		_ = conn.CloseNow()
		return
	default:
	}
	s.pagePresenceConns[conn] = struct{}{}
	registered = true
	s.pageLeaseMu.Unlock()
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	authCtx, authCancel := context.WithTimeout(ctx, 5*time.Second)
	messageType, raw, err := conn.Read(authCtx)
	authCancel()
	if err != nil || messageType != websocket.MessageText {
		_ = conn.CloseNow()
		return
	}
	var hello struct {
		Type   string `json:"type"`
		PageID string `json:"pageId"`
		Token  string `json:"token"`
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	decodeErr := decoder.Decode(&hello)
	var trailing any
	if decodeErr != nil || decoder.Decode(&trailing) != io.EOF || hello.Type != "page.hello" || !validPageID(hello.PageID) || !s.authorizeLocalControl(r, hello.Token) {
		_ = conn.CloseNow()
		return
	}
	s.pageLeaseMu.Lock()
	select {
	case <-s.shutdownRequested:
		s.pageLeaseMu.Unlock()
		_ = conn.CloseNow()
		return
	default:
	}
	s.pendingPageSessions--
	reserved = false
	s.activePageSessions++
	active = true
	pageID = hello.PageID
	s.pagePresenceIDs[hello.PageID]++
	s.pageLeaseEverSeen = true
	s.pageLeaseExitAt = time.Time{}
	s.pageLeaseMu.Unlock()
	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"type":"page.ready"}`)); err != nil {
		return
	}
	go s.pingPagePresence(ctx, conn)
	for {
		_, data, readErr := conn.Read(ctx)
		if readErr != nil {
			return
		}
		if len(data) != 0 {
			_ = conn.CloseNow()
			return
		}
	}
}

func (s *Server) pingPagePresence(ctx context.Context, conn *websocket.Conn) {
	ticker := time.NewTicker(s.config.PagePresencePingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			pingCtx, cancel := context.WithTimeout(ctx, s.config.PagePresencePingTimeout)
			err := conn.Ping(pingCtx)
			cancel()
			if err != nil {
				_ = conn.CloseNow()
				return
			}
		}
	}
}

func (s *Server) ShutdownRequested() <-chan struct{} { return s.shutdownRequested }

func (s *Server) authorizeLocalControl(r *http.Request, token string) bool {
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || net.ParseIP(ip) == nil || !net.ParseIP(ip).IsLoopback() || token == "" || len(token) != len(s.localControlToken) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(token), []byte(s.localControlToken)) == 1
}

func (s *Server) serveLocalWS(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/ws/v1" || r.URL.RawQuery != "" || r.Method != "GET" || !validLocalBrowserRequest(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	conn, err := signal.Accept(w, r)
	if err != nil {
		return
	}
	s.hub.ServeLocal(r.Context(), conn, s.hostToken)
}

func (s *Server) lanHandlerFor(ip string) http.Handler {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/signal/v1" {
			http.NotFound(w, r)
			return
		}
		if !validSignalRequest(r, ip) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		conn, err := signal.Accept(w, r)
		if err == nil {
			s.hub.ServeLAN(r.Context(), conn)
		}
	})
	if s.wrapLANHandler != nil {
		return s.wrapLANHandler(handler)
	}
	return handler
}

func validSignalRequest(r *http.Request, lanIP string) bool {
	if r.URL.Path != "/signal/v1" || r.URL.RawQuery != "" || r.Method != "GET" || r.Header.Get("Origin") != "" {
		return false
	}
	if lanIP == "" || requestHost(r.Host) != strings.ToLower(lanIP) {
		return false
	}
	ipText, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	remote, err := netip.ParseAddr(ipText)
	if err != nil || !remote.Is4() || !remote.IsPrivate() || remote.IsLoopback() || remote.IsLinkLocalUnicast() {
		return false
	}
	return true
}

func (s *Server) Start(ctx context.Context) (net.Listener, error) {
	return s.StartAtPort(ctx, 0, 1)
}

func (s *Server) StartAtPort(ctx context.Context, initialPort, attempts int) (net.Listener, error) {
	if initialPort < 0 || initialPort > 65535 || attempts < 1 {
		return nil, errors.New("INVALID_PORT")
	}
	if initialPort == 0 {
		attempts = 1
	}
	s.lifecycleMu.Lock()
	if s.stopped {
		s.lifecycleMu.Unlock()
		return nil, errors.New("SERVICE_STOPPING")
	}
	s.lifecycleMu.Unlock()
	var ln net.Listener
	var err error
	for i := 0; i < attempts; i++ {
		port := initialPort + i
		if port > 65535 {
			break
		}
		ln, err = net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
		if err == nil {
			break
		}
		if !isPortInUse(err) {
			return nil, err
		}
	}
	if ln == nil {
		return nil, fmt.Errorf("PORT_IN_USE: no free localhost port in %d attempts: %w", attempts, err)
	}
	hs := &http.Server{Handler: s.Handler(), ReadHeaderTimeout: 5 * time.Second}
	s.lifecycleMu.Lock()
	if s.stopped {
		s.lifecycleMu.Unlock()
		_ = ln.Close()
		return nil, errors.New("SERVICE_STOPPING")
	}
	s.runContext = ctx
	s.pageLeaseMu.Lock()
	if s.pageStartedAt.IsZero() {
		s.pageStartedAt = time.Now()
	}
	s.pageLeaseMu.Unlock()
	s.listeners = append(s.listeners, ln)
	s.httpServers = append(s.httpServers, hs)
	s.lifecycleMu.Unlock()
	s.lanMu.Lock()
	_ = s.startDiscoveryLocked(ctx)
	s.lanMu.Unlock()
	go func() { _ = hs.Serve(ln) }()
	go s.watchPageLeases(ctx)
	go func() {
		select {
		case <-ctx.Done():
			_ = s.Shutdown(context.Background())
		case <-s.shutdownRequested:
			_ = s.Shutdown(context.Background())
		}
	}()
	return ln, nil
}

func (s *Server) watchPageLeases(ctx context.Context) {
	ticker := time.NewTicker(s.config.PageLeaseSweepInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.shutdownRequested:
			return
		case now := <-ticker.C:
			s.pageLeaseMu.Lock()
			for id, expiresAt := range s.pageLeases {
				if !expiresAt.After(now) {
					delete(s.pageLeases, id)
				}
			}
			shouldShutdown := false
			if len(s.pageLeases) > 0 || s.activePageSessions > 0 {
				s.pageLeaseExitAt = time.Time{}
			} else if s.pageLeaseEverSeen {
				if s.pageLeaseExitAt.IsZero() {
					s.pageLeaseExitAt = now
				}
				shouldShutdown = now.Sub(s.pageLeaseExitAt) >= s.config.PageLeaseShutdownGrace
			} else if !s.pageStartedAt.IsZero() {
				shouldShutdown = now.Sub(s.pageStartedAt) >= s.config.PageStartupGrace
			}
			if shouldShutdown {
				s.shutdownOnce.Do(func() { close(s.shutdownRequested) })
			}
			s.pageLeaseMu.Unlock()
		}
	}
}

func ListenLAN(ip string, port int) (net.Listener, error) {
	addr, err := netip.ParseAddr(ip)
	if err != nil || !addr.Is4() || !addr.IsPrivate() || addr.IsLoopback() || addr.IsLinkLocalUnicast() || addr.IsUnspecified() || addr.IsMulticast() {
		return nil, errors.New("INVALID_HOST_ADDRESS")
	}
	if port < 0 || port > 65535 {
		return nil, errors.New("INVALID_PORT")
	}
	ln, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IP(addr.AsSlice()), Port: port})
	if err != nil {
		if errors.Is(err, syscall.EADDRNOTAVAIL) {
			return nil, errors.New("INVALID_HOST_ADDRESS")
		}
		if !isPortInUse(err) {
			return nil, fmt.Errorf("SERVICE_START_FAILED: %w", err)
		}
		return nil, fmt.Errorf("PORT_IN_USE: %w", err)
	}
	return ln, nil
}

func isPortInUse(err error) bool {
	if errors.Is(err, syscall.EADDRINUSE) {
		return true
	}
	var errno syscall.Errno
	if errors.As(err, &errno) && uint32(errno) == 10048 { // WSAEADDRINUSE on Windows.
		return true
	}
	return false
}

func writeError(w http.ResponseWriter, status int, code, message string, retryable bool) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"v": 1, "type": "error", "payload": map[string]any{"code": code, "message": message, "retryable": retryable}})
}
func appErrorCode(err error) string {
	if err == nil {
		return ""
	}
	for _, c := range []string{"INVALID_HOST_ADDRESS", "INVALID_PORT", "PORT_IN_USE"} {
		if strings.Contains(err.Error(), c) {
			return c
		}
	}
	return "SERVICE_START_FAILED"
}

func (s *Server) Shutdown(ctx context.Context) error {
	s.shutdownOnce.Do(func() { close(s.shutdownRequested) })
	s.shutdownMu.Lock()
	if s.shutdownStarted {
		done := s.shutdownDone
		s.shutdownMu.Unlock()
		select {
		case <-done:
			s.shutdownMu.Lock()
			err := s.shutdownErr
			s.shutdownMu.Unlock()
			return err
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	s.shutdownStarted = true
	s.shutdownMu.Unlock()

	err := s.shutdown(ctx)
	s.shutdownMu.Lock()
	s.shutdownErr = err
	close(s.shutdownDone)
	s.shutdownMu.Unlock()
	return err
}

func (s *Server) shutdown(ctx context.Context) error {
	s.lanMu.RLock()
	s.screens.Close()
	s.lanMu.RUnlock()
	s.pageLeaseMu.Lock()
	pageConnections := make([]*websocket.Conn, 0, len(s.pagePresenceConns))
	for conn := range s.pagePresenceConns {
		pageConnections = append(pageConnections, conn)
	}
	s.pageLeaseMu.Unlock()
	for _, conn := range pageConnections {
		_ = conn.CloseNow()
	}
	// Let the Hub deliver room.ended while the local and LAN WebSockets are
	// still available. Hub.Shutdown bounds the write phase independently of
	// the HTTP server's shutdown deadline.
	s.hub.Shutdown(ctx)
	s.lifecycleMu.Lock()
	s.stopped = true
	servers := append([]*http.Server(nil), s.httpServers...)
	listeners := append([]net.Listener(nil), s.listeners...)
	s.httpServers = nil
	s.listeners = nil
	s.lifecycleMu.Unlock()
	var first error
	for _, hs := range servers {
		if err := hs.Shutdown(ctx); err != nil && first == nil {
			first = err
		}
	}
	for _, ln := range listeners {
		_ = ln.Close()
	}
	s.lanMu.Lock()
	s.stopLANLocked(ctx)
	s.lanMu.Unlock()
	return first
}
