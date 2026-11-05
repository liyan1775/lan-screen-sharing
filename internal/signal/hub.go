package signal

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"lan-screen-sharing/internal/protocol"
	"lan-screen-sharing/internal/room"
)

type Connection struct {
	raw        *websocket.Conn
	read       func(context.Context) ([]byte, error)
	write      func(context.Context, []byte) error
	close      func()
	closeNow   func()
	remoteAddr string
}

func Accept(w http.ResponseWriter, r *http.Request) (*Connection, error) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: []string{r.Host}})
	if err != nil {
		return nil, err
	}
	c.SetReadLimit(protocol.MaxMessageBytes)
	return &Connection{raw: c, remoteAddr: r.RemoteAddr}, nil
}
func Dial(ctx context.Context, target string) (*Connection, error) {
	c, _, err := websocket.Dial(ctx, target, nil)
	if err != nil {
		return nil, err
	}
	c.SetReadLimit(protocol.MaxMessageBytes)
	return &Connection{raw: c}, nil
}
func (c *Connection) Read(ctx context.Context) ([]byte, error) {
	if c.read != nil {
		return c.read(ctx)
	}
	_, data, err := c.raw.Read(ctx)
	return data, err
}
func (c *Connection) Write(ctx context.Context, data []byte) error {
	if c.write != nil {
		return c.write(ctx, data)
	}
	return c.raw.Write(ctx, websocket.MessageText, data)
}
func (c *Connection) Close() {
	if c.close != nil {
		c.close()
		return
	}
	if c.raw == nil {
		return
	}
	_ = c.raw.Close(websocket.StatusNormalClosure, "closed")
}
func (c *Connection) CloseNow() {
	if c.closeNow != nil {
		c.closeNow()
		return
	}
	if c.raw != nil {
		_ = c.raw.CloseNow()
		return
	}
	c.Close()
}

type Hub struct {
	rooms         *room.Manager
	joinFailures  *joinFailureLimiter
	lifecycleMu   sync.Mutex
	shuttingDown  bool
	sessionMu     sync.Mutex
	sessions      map[*session]struct{}
	mu            sync.RWMutex
	connections   map[string]*Connection
	pendingJoins  map[*Connection]*pendingViewerJoin
	onHostCreated func() error
	dial          func(context.Context, string) (*Connection, error)
}

func NewHub(manager *room.Manager) *Hub {
	return &Hub{rooms: manager, joinFailures: newJoinFailureLimiter(), sessions: map[*session]struct{}{}, connections: map[string]*Connection{}, pendingJoins: map[*Connection]*pendingViewerJoin{}, dial: Dial}
}

var errHubShuttingDown = errors.New("signal hub is shutting down")

func (h *Hub) trackSession(s *session) bool {
	h.lifecycleMu.Lock()
	defer h.lifecycleMu.Unlock()
	if h.shuttingDown {
		return false
	}
	h.sessionMu.Lock()
	h.sessions[s] = struct{}{}
	h.sessionMu.Unlock()
	return true
}

func (h *Hub) untrackSession(s *session) {
	h.sessionMu.Lock()
	delete(h.sessions, s)
	h.sessionMu.Unlock()
}

func (h *Hub) CloseAll() {
	h.mu.Lock()
	connections := make([]*Connection, 0, len(h.connections))
	for key, conn := range h.connections {
		connections = append(connections, conn)
		delete(h.connections, key)
	}
	h.mu.Unlock()
	for _, conn := range connections {
		conn.CloseNow()
	}
}

const gracefulRoomEndLimit = 750 * time.Millisecond

func gracefulRoomEndContext(parent context.Context) (context.Context, context.CancelFunc) {
	if parent == nil || parent.Err() != nil {
		return context.WithTimeout(context.Background(), gracefulRoomEndLimit)
	}
	return context.WithTimeout(parent, gracefulRoomEndLimit)
}

func closeWithin(ctx context.Context, conn *Connection) {
	done := make(chan struct{})
	go func() {
		conn.Close()
		close(done)
	}()
	select {
	case <-done:
	case <-ctx.Done():
		conn.CloseNow()
	}
}

type pendingViewerJoin struct {
	conn         *Connection
	ackReady     chan struct{}
	done         chan struct{}
	acknowledged bool
	ackClosed    bool
	doneClosed   bool
	cancelFanout context.CancelFunc
}

type hubShutdownPlan struct {
	connections  map[string]*Connection
	pendingJoins []*pendingViewerJoin
	sessions     []*session
}

func (h *Hub) beginShutdown() (hubShutdownPlan, bool) {
	h.lifecycleMu.Lock()
	defer h.lifecycleMu.Unlock()
	if h.shuttingDown {
		return hubShutdownPlan{}, false
	}
	h.shuttingDown = true

	plan := hubShutdownPlan{connections: map[string]*Connection{}}
	h.mu.RLock()
	for key, conn := range h.connections {
		plan.connections[key] = conn
	}
	for _, pending := range h.pendingJoins {
		plan.pendingJoins = append(plan.pendingJoins, pending)
	}
	h.mu.RUnlock()
	h.sessionMu.Lock()
	for s := range h.sessions {
		plan.sessions = append(plan.sessions, s)
	}
	h.sessionMu.Unlock()
	return plan, true
}

func (h *Hub) finishShutdown(ctx context.Context, plan hubShutdownPlan) {
	closedPending := map[*Connection]struct{}{}
	for _, pending := range plan.pendingJoins {
		h.mu.RLock()
		cancelFanout := pending.cancelFanout
		h.mu.RUnlock()
		if cancelFanout != nil {
			cancelFanout()
		}
	}
	for _, pending := range plan.pendingJoins {
		select {
		case <-pending.ackReady:
		case <-ctx.Done():
		}
		if !h.pendingViewerJoinAcknowledged(pending) {
			pending.conn.CloseNow()
			closedPending[pending.conn] = struct{}{}
		}
	}
	for _, pending := range plan.pendingJoins {
		if _, closed := closedPending[pending.conn]; closed {
			continue
		}
		select {
		case <-pending.done:
		case <-ctx.Done():
		}
	}

	for _, s := range plan.sessions {
		if s.role == protocol.RoleViewer && s.cancel != nil {
			s.cancel()
		}
	}

	h.lifecycleMu.Lock()
	h.rooms.EndAll()
	h.mu.Lock()
	for key := range h.connections {
		delete(h.connections, key)
	}
	h.mu.Unlock()
	h.lifecycleMu.Unlock()

	var fanout sync.WaitGroup
	for key, conn := range plan.connections {
		if _, closed := closedPending[conn]; closed {
			continue
		}
		roomID, _, ok := strings.Cut(key, "/")
		if !ok || roomID == "" {
			continue
		}
		fanout.Add(1)
		go func(conn *Connection, roomID string) {
			defer fanout.Done()
			_ = h.writeEnvelope(ctx, conn, event("room.ended", "", roomID, "", map[string]any{"reason": "ended"}))
		}(conn, roomID)
	}
	var cleanup sync.WaitGroup
	for _, s := range plan.sessions {
		cleanup.Add(1)
		go func(s *session) {
			defer cleanup.Done()
			if s.role == protocol.RoleViewer {
				s.cleanupMu.Lock()
				if s.roomID != "" {
					h.leaveViewerWithContext(ctx, s, "shutdown-"+s.peerID, false, false)
				}
				s.cleanupMu.Unlock()
				s.conn.CloseNow()
			}
		}(s)
	}
	waitGroupUntil(ctx, &fanout)
	waitGroupUntil(ctx, &cleanup)
	var closes sync.WaitGroup
	for _, conn := range plan.connections {
		closes.Add(1)
		go func(conn *Connection) {
			defer closes.Done()
			closeWithin(ctx, conn)
		}(conn)
	}
	for _, s := range plan.sessions {
		if connectionInPlan(plan.connections, s.conn) {
			continue
		}
		closes.Add(1)
		go func(conn *Connection) {
			defer closes.Done()
			closeWithin(ctx, conn)
		}(s.conn)
	}
	waitGroupUntil(ctx, &closes)
	for _, conn := range plan.connections {
		conn.CloseNow()
	}
	for _, s := range plan.sessions {
		s.conn.CloseNow()
	}
}

func waitGroupUntil(ctx context.Context, wg *sync.WaitGroup) {
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-ctx.Done():
	}
}

func connectionInPlan(connections map[string]*Connection, target *Connection) bool {
	for _, conn := range connections {
		if conn == target {
			return true
		}
	}
	return false
}

// Shutdown sends the normal room.ended terminal event to each connected room
// before it closes the corresponding local and LAN WebSocket connections.
func (h *Hub) Shutdown(ctx context.Context) {
	writeCtx, cancel := gracefulRoomEndContext(ctx)
	defer cancel()
	plan, ok := h.beginShutdown()
	if !ok {
		return
	}
	h.finishShutdown(writeCtx, plan)
}

func (h *Hub) SetHostCreatedHandler(handler func() error) { h.onHostCreated = handler }

func (h *Hub) RoomExpired(snapshot room.RoomSnapshot) {
	h.broadcast(snapshot.ID, "", event("room.ended", "", snapshot.ID, "", map[string]any{"reason": "expired"}))
	h.mu.Lock()
	var expired []*Connection
	for key, conn := range h.connections {
		if strings.HasPrefix(key, snapshot.ID+"/") {
			expired = append(expired, conn)
			delete(h.connections, key)
		}
	}
	h.mu.Unlock()
	for _, conn := range expired {
		conn.Close()
	}
}

type session struct {
	role           protocol.Role
	roomID, peerID string
	conn           *Connection
	cleanupMu      sync.Mutex
	cancel         context.CancelFunc
	bridgeMu       sync.Mutex
	bridge         *Connection
	bridgeCancel   context.CancelFunc
	bridgeLost     bool
	bridgeLeaving  bool
	bridgeEnded    bool
	resumeToken    string
	roomCode       string
	hostIPv4       string
	hostPort       int
}

func (s *session) bridgeSnapshot() (*Connection, bool) {
	s.bridgeMu.Lock()
	defer s.bridgeMu.Unlock()
	return s.bridge, s.bridgeLost
}

func (s *session) setBridge(c *Connection, cancel context.CancelFunc, p protocol.JoinPayload, token string) {
	s.bridgeMu.Lock()
	s.bridge, s.bridgeLost = c, false
	s.bridgeCancel = cancel
	s.bridgeLeaving = false
	s.bridgeEnded = false
	s.roomCode, s.hostIPv4, s.hostPort, s.resumeToken = p.RoomCode, p.HostIPv4, p.HostPort, token
	s.bridgeMu.Unlock()
}

func (s *session) bridgeDied(c *Connection) (bool, context.CancelFunc) {
	s.bridgeMu.Lock()
	defer s.bridgeMu.Unlock()
	if s.bridge != c || s.bridgeLost || s.bridgeLeaving {
		return false, nil
	}
	s.bridge, s.bridgeLost = nil, true
	cancel := s.bridgeCancel
	s.bridgeCancel = nil
	return true, cancel
}

func (s *session) markBridgeLeaving(c *Connection, leaving bool) {
	s.bridgeMu.Lock()
	if s.bridge == c {
		s.bridgeLeaving = leaving
	}
	s.bridgeMu.Unlock()
}

func (s *session) clearBridge() *Connection {
	s.bridgeMu.Lock()
	c := s.bridge
	s.bridge, s.bridgeLost = nil, false
	cancel := s.bridgeCancel
	s.bridgeCancel = nil
	s.bridgeLeaving = false
	s.bridgeEnded = false
	s.roomCode, s.hostIPv4, s.hostPort, s.resumeToken = "", "", 0, ""
	s.bridgeMu.Unlock()
	if cancel != nil {
		cancel()
	}
	return c
}

func (s *session) finishBridgeEnded(c *Connection) (bool, context.CancelFunc) {
	s.bridgeMu.Lock()
	defer s.bridgeMu.Unlock()
	if s.bridge != c {
		return false, nil
	}
	s.bridge, s.bridgeLost, s.bridgeLeaving = nil, false, false
	cancel := s.bridgeCancel
	s.bridgeCancel = nil
	s.bridgeEnded = true
	s.roomCode, s.hostIPv4, s.hostPort, s.resumeToken = "", "", 0, ""
	return true, cancel
}

func (s *session) takeBridgeEnded() bool {
	s.bridgeMu.Lock()
	defer s.bridgeMu.Unlock()
	ended := s.bridgeEnded
	s.bridgeEnded = false
	return ended
}

func (h *Hub) ServeLocal(ctx context.Context, conn *Connection, hostToken string) {
	defer conn.Close()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	first, err := readEnvelope(ctx, conn)
	if err != nil {
		return
	}
	if first.Type != "auth.hello" {
		h.sendError(ctx, conn, first.RequestID, "AUTH_REQUIRED", "请先选择主播或观众身份", false)
		return
	}
	var hello protocol.AuthHelloPayload
	if json.Unmarshal(first.Payload, &hello) != nil || protocol.ValidateRole(hello.Role) != nil {
		h.sendError(ctx, conn, first.RequestID, "AUTH_REQUIRED", "身份验证失败", false)
		return
	}
	switch hello.Role {
	case protocol.RoleHost:
		if !constantEqual(hello.HostToken, hostToken) {
			h.sendError(ctx, conn, first.RequestID, "AUTH_REQUIRED", "主播控制凭证无效", false)
			return
		}
	case protocol.RoleViewer:
		if hello.HostToken != "" || hello.RoomID != "" {
			h.sendError(ctx, conn, first.RequestID, "AUTH_REQUIRED", "观众连接不得携带主播凭证", false)
			return
		}
	}
	s := &session{role: hello.Role, conn: conn, cancel: cancel}
	if !h.trackSession(s) {
		conn.CloseNow()
		return
	}
	defer h.untrackSession(s)
	ack := protocol.Envelope{V: 1, Type: "room.state", RequestID: first.RequestID, Payload: raw(map[string]any{"members": []any{}, "screenSharing": false})}
	if hello.RoomID != "" {
		snap, err := h.resumeLocalHost(s, hello.RoomID)
		if err != nil {
			h.sendError(ctx, conn, first.RequestID, protocol.ErrorCode(err), "原房间已结束，无法恢复", false)
			return
		}
		ack.RoomID, ack.PeerID = snap.ID, s.peerID
		ack.Payload = raw(map[string]any{"name": snap.Name, "roomCode": snap.Code, "members": snap.Members, "screenSharing": snap.ScreenSharing, "presenterPeerId": snap.PresenterPeerID, "presentationRevision": snap.PresentationRevision, "hasSystemAudio": snap.HasSystemAudio, "isolationStatus": snap.IsolationStatus, "resumed": true})
	}
	if err := h.writeEnvelope(ctx, conn, ack); err != nil {
		h.disconnect(s)
		return
	}
	if hello.RoomID != "" {
		h.broadcast(s.roomID, s.peerID, event("peer.state", "", s.roomID, s.peerID, map[string]any{"peerId": s.peerID, "state": "connected", "restartMedia": true}))
		h.sendCurrentRoomState(s.roomID, "")
	}
	for {
		msg, err := readEnvelope(ctx, conn)
		if err != nil {
			h.disconnect(s)
			return
		}
		if s.takeBridgeEnded() {
			s.cleanupMu.Lock()
			s.roomID = ""
			s.peerID = ""
			s.cleanupMu.Unlock()
		}
		bridge, lost := s.bridgeSnapshot()
		if bridge != nil && msg.Type == "viewer.join" {
			h.sendError(ctx, conn, msg.RequestID, "ROOM_ALREADY_JOINED", "当前观众连接已经加入房间", false)
			continue
		}
		if bridge != nil && (msg.Type == "host.createRoom" || msg.Type == "host.endRoom") {
			h.sendError(ctx, conn, msg.RequestID, "HOST_ONLY", "观众不能执行主播控制", false)
			continue
		}
		if bridge != nil && msg.Type != "viewer.leave" {
			if err := bridge.Write(ctx, mustJSON(msg)); err != nil {
				h.bridgeTransportLost(ctx, s, bridge, msg.RequestID)
			}
			continue
		}
		if lost && msg.Type != "viewer.join" && msg.Type != "viewer.leave" && (strings.HasPrefix(msg.Type, "rtc.") || strings.HasPrefix(msg.Type, "screen.") || strings.HasPrefix(msg.Type, "share.") || msg.Type == "media.state" || msg.Type == "heartbeat") {
			h.sendError(ctx, conn, msg.RequestID, "SIGNAL_CONNECTION_LOST", "主播信令连接已断开，请使用重连凭证重试", true)
			continue
		}
		switch msg.Type {
		case "host.createRoom":
			if s.role != protocol.RoleHost {
				h.sendError(ctx, conn, msg.RequestID, "HOST_ONLY", "只有主播可以创建房间", false)
				continue
			}
			h.lifecycleMu.Lock()
			if h.shuttingDown {
				h.lifecycleMu.Unlock()
				conn.CloseNow()
				return
			}
			if s.roomID != "" {
				if _, active := h.rooms.Get(s.roomID); active {
					h.lifecycleMu.Unlock()
					h.sendError(ctx, conn, msg.RequestID, "ROOM_EXISTS", "当前已有房间", false)
					continue
				}
				h.unregister(s)
				s.roomID = ""
				s.peerID = ""
			}
			var options struct {
				Name         string `json:"name"`
				Discoverable *bool  `json:"discoverable"`
			}
			_ = json.Unmarshal(msg.Payload, &options)
			public := options.Discoverable == nil || *options.Discoverable
			snap, _, e := h.rooms.CreateHostWithOptions(options.Name, public)
			if e != nil {
				h.lifecycleMu.Unlock()
				if protocol.ErrorCode(e) == "INVALID_ROOM_NAME" {
					h.sendError(ctx, conn, msg.RequestID, "INVALID_ROOM_NAME", "房间名无效", false)
				} else {
					h.sendError(ctx, conn, msg.RequestID, "SERVICE_START_FAILED", "创建房间失败", true)
				}
				continue
			}
			if h.onHostCreated != nil {
				if startErr := h.onHostCreated(); startErr != nil {
					h.rooms.End(snap.ID)
					h.lifecycleMu.Unlock()
					h.sendError(ctx, conn, msg.RequestID, protocol.ErrorCode(startErr), "启动房间信令服务失败，请检查绑定地址和端口后重试", true)
					continue
				}
			}
			s.roomID = snap.ID
			s.peerID = hostPeer(snap)
			h.register(s)
			h.lifecycleMu.Unlock()
			created := map[string]any{"roomId": snap.ID, "hostPeerId": s.peerID, "roomCode": snap.Code, "name": snap.Name, "discoverable": snap.Discoverable}
			if !snap.ExpiresAt.IsZero() {
				created["expiresAt"] = snap.ExpiresAt
			}
			_ = h.writeEnvelope(ctx, conn, event("room.created", msg.RequestID, snap.ID, s.peerID, created))
			h.sendRoomState(snap, msg.RequestID)
		case "host.endRoom":
			if s.role != protocol.RoleHost {
				h.sendError(ctx, conn, msg.RequestID, "HOST_ONLY", "只有主播可以结束房间", false)
				continue
			}
			if s.roomID == "" || msg.RoomID != s.roomID {
				h.sendError(ctx, conn, msg.RequestID, "ROOM_NOT_FOUND", "房间不存在", false)
				continue
			}
			h.endRoom(ctx, s, msg.RequestID)
		case "viewer.join":
			if s.role != protocol.RoleViewer {
				h.sendError(ctx, conn, msg.RequestID, "HOST_ONLY", "主播不能以观众身份加入", false)
				continue
			}
			if (s.roomID != "" && !lost) || bridge != nil {
				h.sendError(ctx, conn, msg.RequestID, "ROOM_ALREADY_JOINED", "当前观众连接已经加入房间", false)
				continue
			}
			var p protocol.JoinPayload
			if json.Unmarshal(msg.Payload, &p) != nil {
				h.sendError(ctx, conn, msg.RequestID, "INVALID_MESSAGE", "加入信息无效", false)
				continue
			}
			if e := ValidateHostTarget(p.HostIPv4, p.HostPort); e != nil {
				h.sendError(ctx, conn, msg.RequestID, protocol.ErrorCode(e), "主播地址无效", false)
				continue
			}
			if lost {
				s.bridgeMu.Lock()
				resumeOK := p.ResumeToken != "" && constantEqual(p.ResumeToken, s.resumeToken) && p.RoomCode == s.roomCode && p.HostIPv4 == s.hostIPv4 && p.HostPort == s.hostPort
				s.bridgeMu.Unlock()
				if !resumeOK {
					h.sendError(ctx, conn, msg.RequestID, "INVALID_INVITE", "重连凭证无效", false)
					continue
				}
			}
			s.cleanupMu.Lock()
			e := h.joinBridge(ctx, s, msg, p)
			s.cleanupMu.Unlock()
			if e != nil {
				continue
			}
		case "viewer.leave":
			if s.role != protocol.RoleViewer {
				h.sendError(ctx, conn, msg.RequestID, "HOST_ONLY", "主播不能以观众身份离开", false)
				continue
			}
			s.cleanupMu.Lock()
			h.leaveViewer(ctx, s, msg.RequestID, true, true)
			s.cleanupMu.Unlock()
		case "rtc.description", "rtc.candidate", "screen.ready", "screen.description":
			if s.role != protocol.RoleHost || s.roomID == "" {
				if b, _ := s.bridgeSnapshot(); b != nil {
					if err := b.Write(ctx, mustJSON(msg)); err != nil {
						h.bridgeTransportLost(ctx, s, b, msg.RequestID)
					}
				} else {
					h.sendError(ctx, conn, msg.RequestID, "AUTH_REQUIRED", "尚未加入房间", false)
				}
				continue
			}
			if err := h.route(s, msg); err != nil {
				h.sendError(ctx, conn, msg.RequestID, protocol.ErrorCode(err), "信令目标不属于当前房间", false)
			}
		case "media.state", "heartbeat":
			if b, _ := s.bridgeSnapshot(); b != nil {
				if err := b.Write(ctx, mustJSON(msg)); err != nil {
					h.bridgeTransportLost(ctx, s, b, msg.RequestID)
				}
			} else {
				if msg.Type == "media.state" {
					h.handlePresentation(ctx, s, msg)
				}
			}
		case "share.claim", "share.release":
			h.handlePresentation(ctx, s, msg)
		default:
			h.sendError(ctx, conn, msg.RequestID, "INVALID_MESSAGE", "消息类型无效", false)
		}
	}
}

func (h *Hub) ServeLAN(ctx context.Context, conn *Connection) {
	defer conn.Close()
	first, err := readEnvelope(ctx, conn)
	if err != nil {
		return
	}
	if first.Type != "signal.join" {
		h.sendError(ctx, conn, first.RequestID, "AUTH_REQUIRED", "需要房间码加入", false)
		return
	}
	var p struct {
		RoomCode     string `json:"roomCode"`
		ResumeToken  string `json:"resumeToken,omitempty"`
		RestartMedia bool   `json:"restartMedia,omitempty"`
	}
	if json.Unmarshal(first.Payload, &p) != nil {
		h.sendError(ctx, conn, first.RequestID, "INVALID_INVITE", "房间信息无效", false)
		return
	}
	resuming := p.ResumeToken != ""
	sourceIP := connectionSourceIP(conn.remoteAddr)
	if sourceIP == "" {
		h.sendError(ctx, conn, first.RequestID, "INVALID_HOST_ADDRESS", "无法识别连接来源地址", false)
		return
	}
	reserved := false
	if !resuming {
		if !h.joinFailures.begin(sourceIP) {
			h.sendError(ctx, conn, first.RequestID, "RATE_LIMITED", "房间码尝试次数过多，请等待 60 秒后重试。", true)
			return
		}
		reserved = true
	}
	joinCtx, cancelJoin := context.WithTimeout(ctx, gracefulRoomEndLimit)
	fanoutCtx, cancelFanout := context.WithCancel(joinCtx)
	peerSession, snap, s, err := h.joinViewerAndRegister(conn, p.RoomCode, p.ResumeToken, cancelFanout)
	if err != nil {
		cancelFanout()
		cancelJoin()
		if errors.Is(err, errHubShuttingDown) {
			if reserved {
				h.joinFailures.finish(sourceIP, false)
			}
			conn.CloseNow()
			return
		}
		if reserved {
			h.joinFailures.finish(sourceIP, false)
		} else if !h.joinFailures.begin(sourceIP) {
			h.sendError(ctx, conn, first.RequestID, "RATE_LIMITED", "房间码尝试次数过多，请等待 60 秒后重试。", true)
			return
		} else {
			h.joinFailures.finish(sourceIP, false)
		}
		h.sendError(ctx, conn, first.RequestID, protocol.ErrorCode(err), friendlyError(err), false)
		return
	}
	if reserved {
		h.joinFailures.finish(sourceIP, true)
	}
	if err = h.writeEnvelope(joinCtx, conn, event("room.joined", first.RequestID, s.roomID, s.peerID, map[string]any{"name": snap.Name, "roomId": s.roomID, "peerId": s.peerID, "resumeToken": peerSession.ResumeToken, "members": snap.Members, "presenterPeerId": snap.PresenterPeerID, "presentationRevision": snap.PresentationRevision, "screenSharing": snap.ScreenSharing, "hasSystemAudio": snap.HasSystemAudio, "isolationStatus": snap.IsolationStatus})); err != nil {
		h.rooms.Leave(s.roomID, s.peerID)
		h.unregister(s)
		cancelFanout()
		h.completeViewerJoin(conn)
		cancelJoin()
		conn.CloseNow()
		return
	}
	h.acknowledgeViewerJoin(conn)
	if resuming {
		h.broadcastWithContext(fanoutCtx, s.roomID, s.peerID, event("peer.state", first.RequestID, s.roomID, s.peerID, map[string]any{"peerId": s.peerID, "state": "connected", "restartMedia": p.RestartMedia}))
	} else {
		h.broadcastWithContext(fanoutCtx, s.roomID, s.peerID, event("peer.joined", "", s.roomID, s.peerID, map[string]any{"peerId": s.peerID, "role": "viewer"}))
	}
	h.sendRoomStateExcludingWithContext(fanoutCtx, snap, "", s.peerID)
	if resuming {
		_ = h.writeEnvelope(fanoutCtx, conn, event("room.state", "", snap.ID, "", map[string]any{"name": snap.Name, "members": snap.Members, "screenSharing": snap.ScreenSharing, "presenterPeerId": snap.PresenterPeerID, "presentationRevision": snap.PresentationRevision, "hasSystemAudio": snap.HasSystemAudio, "isolationStatus": snap.IsolationStatus}))
	}
	cancelFanout()
	h.completeViewerJoin(conn)
	cancelJoin()
	for {
		msg, e := readEnvelope(ctx, conn)
		if e != nil {
			if !h.detachPeer(s) {
				return
			}
			h.broadcast(s.roomID, s.peerID, event("peer.state", "", s.roomID, s.peerID, map[string]any{"peerId": s.peerID, "state": "reconnecting"}))
			h.sendCurrentRoomState(s.roomID, "")
			roomID, peerID := s.roomID, s.peerID
			time.AfterFunc(room.ReconnectWindow, func() {
				h.rooms.ExpireDisconnected(roomID, peerID)
				if snapshot, ok := h.rooms.Get(roomID); ok {
					present := false
					for _, member := range snapshot.Members {
						if member.PeerID == peerID {
							present = true
							break
						}
					}
					if !present {
						h.broadcast(roomID, "", event("peer.left", "", roomID, peerID, map[string]any{"peerId": peerID, "reason": "disconnected"}))
					}
					h.sendRoomState(snapshot, "")
				}
			})
			return
		}
		switch msg.Type {
		case "rtc.description", "rtc.candidate", "screen.ready", "screen.description":
			if e := h.route(s, msg); e != nil {
				h.sendError(ctx, conn, msg.RequestID, protocol.ErrorCode(e), "信令目标不属于当前房间", false)
			}
		case "signal.leave":
			h.lifecycleMu.Lock()
			if !h.ownsConnection(s) {
				h.lifecycleMu.Unlock()
				return
			}
			h.rooms.Leave(s.roomID, s.peerID)
			h.unregister(s)
			h.lifecycleMu.Unlock()
			h.broadcast(s.roomID, s.peerID, event("peer.left", msg.RequestID, s.roomID, s.peerID, map[string]any{"peerId": s.peerID, "reason": "left"}))
			h.sendCurrentRoomState(s.roomID, msg.RequestID)
			return
		case "heartbeat":
			_ = h.writeEnvelope(ctx, conn, protocol.Envelope{V: 1, Type: "heartbeat", RequestID: msg.RequestID, RoomID: s.roomID, PeerID: s.peerID, Payload: raw(map[string]any{})})
		case "share.claim", "share.release", "media.state":
			h.handlePresentation(ctx, s, msg)
		default:
			h.sendError(ctx, conn, msg.RequestID, "INVALID_MESSAGE", "消息类型无效", false)
		}
	}
}

func (h *Hub) joinBridge(ctx context.Context, s *session, msg protocol.Envelope, p protocol.JoinPayload) error {
	target := (&url.URL{Scheme: "ws", Host: net.JoinHostPort(p.HostIPv4, strconv.Itoa(p.HostPort)), Path: "/signal/v1"}).String()
	bridge, err := h.dial(ctx, target)
	if err != nil {
		h.sendError(ctx, s.conn, msg.RequestID, "ROOM_NOT_FOUND", "无法连接主播信令服务", true)
		return err
	}
	joinPayload := map[string]any{"roomCode": p.RoomCode}
	if p.RestartMedia {
		joinPayload["restartMedia"] = true
	}
	if p.ResumeToken != "" {
		joinPayload["resumeToken"] = p.ResumeToken
	}
	join := protocol.Envelope{V: 1, Type: "signal.join", RequestID: msg.RequestID, Payload: raw(joinPayload)}
	if err = bridge.Write(ctx, mustJSON(join)); err != nil {
		bridge.Close()
		h.sendError(ctx, s.conn, msg.RequestID, "ROOM_NOT_FOUND", "加入主播房间失败", true)
		return err
	}
	data, err := bridge.Read(ctx)
	if err != nil {
		bridge.Close()
		h.sendError(ctx, s.conn, msg.RequestID, "ROOM_NOT_FOUND", "加入主播房间失败", true)
		return err
	}
	var response protocol.Envelope
	if err = protocol.Decode(data, &response); err != nil || response.Type == "error" {
		bridge.Close()
		h.forwardEvent(ctx, s.conn, data)
		return errors.New("remote room join rejected")
	}
	var joined struct {
		ResumeToken string `json:"resumeToken"`
	}
	if json.Unmarshal(response.Payload, &joined) != nil || joined.ResumeToken == "" || response.RoomID == "" || response.PeerID == "" {
		bridge.Close()
		h.sendError(ctx, s.conn, msg.RequestID, "INVALID_MESSAGE", "主播信令响应无效", false)
		return errors.New("invalid remote join response")
	}
	if s.roomID != "" && (s.roomID != response.RoomID || s.peerID != response.PeerID) {
		bridge.Close()
		h.sendError(ctx, s.conn, msg.RequestID, "INVALID_INVITE", "重连凭证未恢复原观众身份", false)
		return errors.New("resume changed peer identity")
	}
	if err = h.writeEnvelope(ctx, s.conn, protocol.Envelope{V: 1, Type: "room.joined", RequestID: msg.RequestID, RoomID: response.RoomID, PeerID: response.PeerID, Payload: response.Payload}); err != nil {
		bridge.Close()
		return err
	}
	s.roomID, s.peerID = response.RoomID, response.PeerID
	bridgeCtx, bridgeCancel := context.WithCancel(context.WithoutCancel(ctx))
	s.setBridge(bridge, bridgeCancel, p, joined.ResumeToken)
	go h.pumpBridge(bridgeCtx, s, bridge)
	return nil
}

func (h *Hub) pumpBridge(ctx context.Context, s *session, bridge *Connection) {
	for {
		data, err := bridge.Read(ctx)
		if err != nil {
			h.bridgeTransportLost(ctx, s, bridge, "")
			return
		}
		var message protocol.Envelope
		if protocol.Decode(data, &message) == nil && message.Type == "room.ended" {
			if ok, cancel := s.finishBridgeEnded(bridge); ok {
				_ = s.conn.Write(ctx, data)
				bridge.CloseNow()
				if cancel != nil {
					cancel()
				}
			}
			return
		}
		if err = s.conn.Write(ctx, data); err != nil {
			// The browser connection is gone. Closing the LAN socket lets ServeLAN
			// preserve its seat for the normal resume window.
			bridge.Close()
			return
		}
	}
}

func (h *Hub) bridgeTransportLost(ctx context.Context, s *session, bridge *Connection, requestID string) {
	died, cancel := s.bridgeDied(bridge)
	if !died {
		return
	}
	bridge.Close()
	h.sendError(ctx, s.conn, requestID, "SIGNAL_CONNECTION_LOST", "主播信令连接已断开，请使用重连凭证重试", true)
	if cancel != nil {
		cancel()
	}
}

func (h *Hub) bestEffortRemoteLeave(ctx context.Context, s *session, requestID, roomID, peerID string) {
	s.bridgeMu.Lock()
	p := protocol.JoinPayload{HostIPv4: s.hostIPv4, HostPort: s.hostPort, RoomCode: s.roomCode, ResumeToken: s.resumeToken}
	s.bridgeMu.Unlock()
	if roomID == "" || peerID == "" || p.ResumeToken == "" || ValidateHostTarget(p.HostIPv4, p.HostPort) != nil {
		return
	}
	attemptCtx, cancel := context.WithTimeout(ctx, 750*time.Millisecond)
	defer cancel()
	target := (&url.URL{Scheme: "ws", Host: net.JoinHostPort(p.HostIPv4, strconv.Itoa(p.HostPort)), Path: "/signal/v1"}).String()
	bridge, err := h.dial(attemptCtx, target)
	if err != nil {
		return
	}
	defer bridge.CloseNow()
	join := protocol.Envelope{V: 1, Type: "signal.join", RequestID: requestID, Payload: raw(map[string]any{"roomCode": p.RoomCode, "resumeToken": p.ResumeToken})}
	if err = bridge.Write(attemptCtx, mustJSON(join)); err != nil {
		return
	}
	data, err := bridge.Read(attemptCtx)
	if err != nil {
		return
	}
	var response protocol.Envelope
	if protocol.Decode(data, &response) != nil || response.Type != "room.joined" || response.RoomID != roomID || response.PeerID != peerID {
		return
	}
	leave := protocol.Envelope{V: 1, Type: "signal.leave", RequestID: requestID, RoomID: roomID, Payload: raw(map[string]any{})}
	if err = bridge.Write(attemptCtx, mustJSON(leave)); err != nil {
		return
	}
	// Complete the close handshake before reporting the local leave. An
	// immediate CloseNow can discard signal.leave and strand the resumed seat.
	closeWithin(attemptCtx, bridge)
}

func (h *Hub) RouteFrom(roomID, fromPeerID string, msg protocol.Envelope) (protocol.Envelope, error) {
	to, err := targetPeer(msg)
	if err != nil {
		return protocol.Envelope{}, err
	}
	if err = h.rooms.Route(roomID, fromPeerID, to, room.SignalMessage{Type: msg.Type, Payload: msg.Payload}); err != nil {
		return protocol.Envelope{}, err
	}
	payload, err := forwardPayload(msg, fromPeerID)
	if err != nil {
		return protocol.Envelope{}, err
	}
	routed := protocol.Envelope{V: 1, Type: msg.Type, RequestID: msg.RequestID, RoomID: roomID, PeerID: to, Payload: payload}
	if len(mustJSON(routed)) > protocol.MaxMessageBytes {
		return protocol.Envelope{}, errors.New("MESSAGE_TOO_LARGE")
	}
	return routed, nil
}

func (h *Hub) route(source *session, msg protocol.Envelope) error {
	routed, err := h.RouteFrom(source.roomID, source.peerID, msg)
	if err != nil {
		return err
	}
	h.mu.RLock()
	target := h.connections[connKey(source.roomID, routed.PeerID)]
	h.mu.RUnlock()
	if target == nil {
		return errors.New("SIGNAL_TARGET_NOT_MEMBER")
	}
	return target.Write(context.Background(), mustJSON(routed))
}
func (h *Hub) register(s *session) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.connections[connKey(s.roomID, s.peerID)] = s.conn
}

func (h *Hub) joinViewerAndRegister(conn *Connection, roomCode, resumeToken string, cancelFanout context.CancelFunc) (room.PeerSession, room.RoomSnapshot, *session, error) {
	h.lifecycleMu.Lock()
	defer h.lifecycleMu.Unlock()
	if h.shuttingDown {
		return room.PeerSession{}, room.RoomSnapshot{}, nil, errHubShuttingDown
	}
	peerSession, snapshot, err := h.rooms.Join(roomCode, resumeToken)
	if err != nil {
		return room.PeerSession{}, room.RoomSnapshot{}, nil, err
	}
	s := &session{role: protocol.RoleViewer, roomID: snapshot.ID, peerID: peerSession.PeerID, conn: conn}
	pending := &pendingViewerJoin{conn: conn, ackReady: make(chan struct{}), done: make(chan struct{}), cancelFanout: cancelFanout}
	h.mu.Lock()
	previous := h.connections[connKey(s.roomID, s.peerID)]
	h.connections[connKey(s.roomID, s.peerID)] = conn
	h.pendingJoins[conn] = pending
	h.mu.Unlock()
	if previous != nil && previous != conn {
		go h.closeReplaced(previous, s.roomID, s.peerID)
	}
	return peerSession, snapshot, s, nil
}

func (h *Hub) pendingViewerJoinAcknowledged(pending *pendingViewerJoin) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return pending.acknowledged
}

func (h *Hub) acknowledgeViewerJoin(conn *Connection) {
	h.mu.Lock()
	if pending := h.pendingJoins[conn]; pending != nil && !pending.ackClosed {
		pending.acknowledged = true
		pending.ackClosed = true
		close(pending.ackReady)
	}
	h.mu.Unlock()
}

func (h *Hub) completeViewerJoin(conn *Connection) {
	h.mu.Lock()
	if pending := h.pendingJoins[conn]; pending != nil {
		delete(h.pendingJoins, conn)
		if !pending.ackClosed {
			pending.ackClosed = true
			close(pending.ackReady)
		}
		if !pending.doneClosed {
			pending.doneClosed = true
			close(pending.done)
		}
	}
	h.mu.Unlock()
}
func (h *Hub) unregister(s *session) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.connections[connKey(s.roomID, s.peerID)] == s.conn {
		delete(h.connections, connKey(s.roomID, s.peerID))
	}
}

func (h *Hub) ownsConnection(s *session) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.connections[connKey(s.roomID, s.peerID)] == s.conn
}

func (h *Hub) detachPeer(s *session) bool {
	h.lifecycleMu.Lock()
	defer h.lifecycleMu.Unlock()
	if h.shuttingDown || !h.ownsConnection(s) {
		return false
	}
	h.rooms.Disconnect(s.roomID, s.peerID)
	h.unregister(s)
	return true
}

func (h *Hub) resumeLocalHost(s *session, roomID string) (room.RoomSnapshot, error) {
	h.lifecycleMu.Lock()
	defer h.lifecycleMu.Unlock()
	if h.shuttingDown {
		return room.RoomSnapshot{}, errors.New("ROOM_NOT_FOUND")
	}
	snap, err := h.rooms.ResumeHost(roomID)
	if err != nil {
		return room.RoomSnapshot{}, err
	}
	s.roomID, s.peerID = roomID, hostPeer(snap)
	h.mu.Lock()
	previous := h.connections[connKey(s.roomID, s.peerID)]
	h.connections[connKey(s.roomID, s.peerID)] = s.conn
	h.mu.Unlock()
	if previous != nil && previous != s.conn {
		go h.closeReplaced(previous, s.roomID, s.peerID)
	}
	return snap, nil
}

func (h *Hub) closeReplaced(conn *Connection, roomID, peerID string) {
	ctx, cancel := gracefulRoomEndContext(context.Background())
	defer cancel()
	_ = h.writeEnvelope(ctx, conn, event("room.ended", "", roomID, peerID, map[string]any{"reason": "session_replaced"}))
	closeWithin(ctx, conn)
}
func (h *Hub) broadcast(roomID, exclude string, e protocol.Envelope) {
	h.broadcastWithContext(context.Background(), roomID, exclude, e)
}
func (h *Hub) broadcastWithContext(ctx context.Context, roomID, exclude string, e protocol.Envelope) {
	h.mu.RLock()
	var conns []*Connection
	for k, c := range h.connections {
		if strings.HasPrefix(k, roomID+"/") && !strings.HasSuffix(k, "/"+exclude) {
			conns = append(conns, c)
		}
	}
	h.mu.RUnlock()
	data := mustJSON(e)
	var writes sync.WaitGroup
	writes.Add(len(conns))
	for _, c := range conns {
		go func(conn *Connection) {
			defer writes.Done()
			_ = conn.Write(ctx, data)
		}(c)
	}
	done := make(chan struct{})
	go func() { writes.Wait(); close(done) }()
	select {
	case <-done:
	case <-ctx.Done():
	}
}

func (h *Hub) sendCurrentRoomState(roomID, requestID string) {
	if snap, ok := h.rooms.Get(roomID); ok {
		h.sendRoomState(snap, requestID)
	}
}
func (h *Hub) sendRoomState(snap room.RoomSnapshot, requestID string, screenSharing ...bool) {
	h.sendRoomStateWithContext(context.Background(), snap, requestID, screenSharing...)
}
func (h *Hub) sendRoomStateWithContext(ctx context.Context, snap room.RoomSnapshot, requestID string, screenSharing ...bool) {
	h.sendRoomStateExcludingWithContext(ctx, snap, requestID, "", screenSharing...)
}
func (h *Hub) sendRoomStateExcludingWithContext(ctx context.Context, snap room.RoomSnapshot, requestID, exclude string, screenSharing ...bool) {
	h.broadcastWithContext(ctx, snap.ID, exclude, event("room.state", requestID, snap.ID, "", map[string]any{"name": snap.Name, "members": snap.Members, "screenSharing": snap.ScreenSharing, "presenterPeerId": snap.PresenterPeerID, "presentationRevision": snap.PresentationRevision, "hasSystemAudio": snap.HasSystemAudio, "isolationStatus": snap.IsolationStatus}))
}

func (h *Hub) handlePresentation(ctx context.Context, s *session, msg protocol.Envelope) {
	if s.roomID == "" || s.peerID == "" || (msg.RoomID != "" && msg.RoomID != s.roomID) {
		h.sendError(ctx, s.conn, msg.RequestID, "AUTH_REQUIRED", "请先加入房间", false)
		return
	}
	var snap room.RoomSnapshot
	var err error
	switch msg.Type {
	case "share.claim":
		snap, err = h.rooms.ClaimPresentation(s.roomID, s.peerID)
	case "share.release":
		snap, err = h.rooms.ReleasePresentation(s.roomID, s.peerID)
	case "media.state":
		var state struct {
			ScreenSharing   bool   `json:"screenSharing"`
			HasScreenVideo  bool   `json:"hasScreenVideo"`
			HasSystemAudio  bool   `json:"hasSystemAudio"`
			IsolationStatus string `json:"isolationStatus"`
		}
		if json.Unmarshal(msg.Payload, &state) != nil || state.ScreenSharing != state.HasScreenVideo || (!state.ScreenSharing && state.HasSystemAudio) {
			h.sendError(ctx, s.conn, msg.RequestID, "INVALID_MESSAGE", "共享状态无效", false)
			return
		}
		snap, err = h.rooms.UpdatePresentation(s.roomID, s.peerID, state.ScreenSharing, state.HasSystemAudio, state.IsolationStatus)
	}
	if err != nil {
		h.sendError(ctx, s.conn, msg.RequestID, protocol.ErrorCode(err), "其他成员正在共享或当前没有共享权限", false)
		return
	}
	h.sendRoomStateWithContext(ctx, snap, msg.RequestID)
}
func (h *Hub) disconnect(s *session) {
	s.cleanupMu.Lock()
	defer s.cleanupMu.Unlock()
	if s.roomID == "" {
		return
	}
	if s.role == protocol.RoleHost {
		if !h.detachPeer(s) {
			return
		}
		h.broadcast(s.roomID, s.peerID, event("peer.state", "", s.roomID, s.peerID, map[string]any{"peerId": s.peerID, "state": "reconnecting"}))
		h.sendCurrentRoomState(s.roomID, "")
		roomID, peerID := s.roomID, s.peerID
		time.AfterFunc(room.ReconnectWindow, func() {
			ctx, cancel := gracefulRoomEndContext(context.Background())
			defer cancel()
			h.lifecycleMu.Lock()
			defer h.lifecycleMu.Unlock()
			if !h.shuttingDown && h.rooms.DisconnectedExpired(roomID, peerID) {
				h.endRoomLocked(ctx, roomID, "")
			}
		})
		return
	}
	// A lost local browser socket is not an explicit leave. Let the host retain
	// this viewer's identity for the authenticated resume window.
	if bridge := s.clearBridge(); bridge != nil {
		bridge.CloseNow()
	}
}

func (h *Hub) leaveViewer(ctx context.Context, s *session, requestID string, sendResponse, reportTransportLoss bool) {
	cleanupCtx, cancel := gracefulRoomEndContext(ctx)
	defer cancel()
	h.leaveViewerWithContext(cleanupCtx, s, requestID, sendResponse, reportTransportLoss)
}

func (h *Hub) leaveViewerWithContext(ctx context.Context, s *session, requestID string, sendResponse, reportTransportLoss bool) {
	oldRoomID, oldPeerID := s.roomID, s.peerID
	if requestID == "" {
		requestID = "disconnect-" + oldPeerID
	}
	bridge, lost := s.bridgeSnapshot()
	bestEffortLeave := lost
	if bridge != nil {
		leave := protocol.Envelope{V: 1, Type: "signal.leave", RequestID: requestID, RoomID: oldRoomID, Payload: raw(map[string]any{})}
		s.markBridgeLeaving(bridge, true)
		if err := bridge.Write(ctx, mustJSON(leave)); err != nil {
			s.markBridgeLeaving(bridge, false)
			if reportTransportLoss {
				// Keep the asynchronous loss uncorrelated so it cannot reject this leave.
				h.bridgeTransportLost(ctx, s, bridge, "")
			} else {
				_, cancel := s.bridgeDied(bridge)
				bridge.CloseNow()
				if cancel != nil {
					cancel()
				}
			}
			bestEffortLeave = true
		} else {
			// A normal WebSocket close preserves the preceding signal.leave frame.
			// CloseNow here can drop that frame and leave the peer in resume grace.
			closeWithin(ctx, bridge)
		}
	}
	if bestEffortLeave {
		h.bestEffortRemoteLeave(ctx, s, requestID, oldRoomID, oldPeerID)
	}
	if oldRoomID != "" {
		h.unregister(s)
		s.roomID, s.peerID = "", ""
	}
	s.clearBridge()
	if sendResponse {
		_ = h.writeEnvelope(ctx, s.conn, event("peer.left", requestID, oldRoomID, oldPeerID, map[string]any{"peerId": oldPeerID, "reason": "left"}))
	}
}

func (h *Hub) endRoom(ctx context.Context, s *session, requestID string) {
	h.lifecycleMu.Lock()
	defer h.lifecycleMu.Unlock()
	if !h.shuttingDown && s.roomID != "" {
		h.endRoomLocked(ctx, s.roomID, requestID)
	}
	s.roomID, s.peerID = "", ""
}

func (h *Hub) endRoomLocked(ctx context.Context, roomID, requestID string) {
	if roomID == "" {
		return
	}
	h.rooms.End(roomID)
	h.broadcastWithContext(ctx, roomID, "", event("room.ended", requestID, roomID, "", map[string]any{"reason": "ended"}))
	h.mu.Lock()
	for k := range h.connections {
		if strings.HasPrefix(k, roomID+"/") {
			delete(h.connections, k)
		}
	}
	h.mu.Unlock()
}
func (h *Hub) sendError(ctx context.Context, c *Connection, requestID, code, message string, retryable bool) {
	_ = h.writeEnvelope(ctx, c, protocol.Envelope{V: 1, Type: "error", RequestID: requestID, Payload: raw(map[string]any{"code": code, "message": message, "retryable": retryable})})
}
func (h *Hub) writeEnvelope(ctx context.Context, c *Connection, e protocol.Envelope) error {
	return c.Write(ctx, mustJSON(e))
}
func (h *Hub) forwardEvent(ctx context.Context, c *Connection, data []byte) { _ = c.Write(ctx, data) }

func ValidateHostTarget(ip string, port int) error {
	addr, err := netip.ParseAddr(ip)
	if err != nil || !addr.Is4() || !addr.IsPrivate() || addr.IsLoopback() || addr.IsLinkLocalUnicast() || addr.IsUnspecified() || addr.IsMulticast() {
		return errors.New("INVALID_HOST_ADDRESS")
	}
	if port < 1 || port > 65535 {
		return errors.New("INVALID_PORT")
	}
	return nil
}
func ValidateSignalPath(path string) error {
	if path != "/signal/v1" {
		return errors.New("INVALID_SIGNAL_PATH")
	}
	return nil
}
func readEnvelope(ctx context.Context, c *Connection) (protocol.Envelope, error) {
	data, err := c.Read(ctx)
	if err != nil {
		if ctx.Err() == nil && websocket.CloseStatus(err) < 0 {
			log.Printf("websocket read failed: %s", protocol.ErrorCode(err))
		}
		return protocol.Envelope{}, err
	}
	var e protocol.Envelope
	if err = protocol.Decode(data, &e); err != nil {
		log.Printf("rejected websocket message: %s", protocol.ErrorCode(err))
		return protocol.Envelope{}, err
	}
	return e, nil
}
func hostPeer(s room.RoomSnapshot) string {
	for _, m := range s.Members {
		if m.Role == "host" {
			return m.PeerID
		}
	}
	return ""
}
func targetPeer(e protocol.Envelope) (string, error) {
	var p struct {
		ToPeerID string `json:"toPeerId"`
	}
	if err := json.Unmarshal(e.Payload, &p); err != nil || p.ToPeerID == "" {
		return "", errors.New("SIGNAL_TARGET_NOT_MEMBER")
	}
	return p.ToPeerID, nil
}
func forwardPayload(e protocol.Envelope, from string) (json.RawMessage, error) {
	var p map[string]json.RawMessage
	if err := json.Unmarshal(e.Payload, &p); err != nil {
		return nil, err
	}
	delete(p, "toPeerId")
	p["fromPeerId"], _ = json.Marshal(from)
	return json.Marshal(p)
}
func event(typ, requestID, roomID, peerID string, payload any) protocol.Envelope {
	return protocol.Envelope{V: 1, Type: typ, RequestID: requestID, RoomID: roomID, PeerID: peerID, Payload: raw(payload)}
}
func raw(v any) json.RawMessage            { b, _ := json.Marshal(v); return b }
func mustJSON(v any) []byte                { b, _ := json.Marshal(v); return b }
func connKey(roomID, peerID string) string { return roomID + "/" + peerID }
func constantEqual(a, b string) bool {
	if len(a) != len(b) || a == "" {
		return false
	}
	var x byte
	for i := range a {
		x |= a[i] ^ b[i]
	}
	return x == 0
}
func friendlyError(err error) string {
	switch protocol.ErrorCode(err) {
	case "ROOM_FULL":
		return "房间已满"
	case "ROOM_EXPIRED":
		return "房间码已过期"
	case "ROOM_NOT_FOUND":
		return "找不到房间"
	case "INVALID_INVITE":
		return "房间码无效"
	default:
		return "加入房间失败"
	}
}
