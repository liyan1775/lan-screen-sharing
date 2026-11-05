package room

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

const ReconnectWindow = 30 * time.Second
const roomCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

type Manager struct {
	mu           sync.Mutex
	rooms        map[string]*room
	byCode       map[string]string
	hostTokens   map[[32]byte]string
	now          func() time.Time
	roomTTL      time.Duration
	expiredCodes map[string]time.Time
	onExpire     func(RoomSnapshot)
}

type Option func(*Manager)

func WithClock(now func() time.Time) Option {
	return func(m *Manager) {
		if now != nil {
			m.now = now
		}
	}
}

// WithRoomTTL opts into a fixed room lifetime. By default, rooms remain usable
// until explicitly ended or the host fails to recover its connection.
func WithRoomTTL(ttl time.Duration) Option {
	return func(m *Manager) {
		if ttl > 0 {
			m.roomTTL = ttl
		}
	}
}

func NewManager(options ...Option) *Manager {
	m := &Manager{rooms: map[string]*room{}, byCode: map[string]string{}, hostTokens: map[[32]byte]string{}, now: time.Now}
	for _, option := range options {
		option(m)
	}
	return m
}
func (m *Manager) SetClock(now func() time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if now != nil {
		m.now = now
	}
}
func (m *Manager) SetExpirationHandler(handler func(RoomSnapshot)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.onExpire = handler
}

type room struct {
	id                   string
	code                 string
	expires              time.Time
	hostID               string
	peers                map[string]*peer
	ended                bool
	timer                *time.Timer
	presenterPeerID      string
	screenSharing        bool
	hasSystemAudio       bool
	isolationStatus      string
	presentationRevision uint64
	name                 string
	discoverable         bool
}
type peer struct {
	id             string
	role           string
	resumeHash     [32]byte
	connected      bool
	reconnectUntil time.Time
}

func (r *room) expired(now time.Time) bool {
	return !r.expires.IsZero() && !now.Before(r.expires)
}

type PeerSnapshot struct {
	PeerID string `json:"peerId"`
	Role   string `json:"role"`
	State  string `json:"state"`
}
type RoomSnapshot struct {
	ID                   string         `json:"roomId"`
	Code                 string         `json:"roomCode"`
	ExpiresAt            time.Time      `json:"expiresAt,omitzero"`
	Members              []PeerSnapshot `json:"members"`
	PresenterPeerID      string         `json:"presenterPeerId"`
	ScreenSharing        bool           `json:"screenSharing"`
	HasSystemAudio       bool           `json:"hasSystemAudio"`
	IsolationStatus      string         `json:"isolationStatus"`
	PresentationRevision uint64         `json:"presentationRevision"`
	Name                 string         `json:"name"`
	Discoverable         bool           `json:"discoverable"`
}
type HostCredential struct{ Token string }
type PeerSession struct {
	PeerID      string `json:"peerId"`
	ResumeToken string `json:"resumeToken"`
}
type SignalMessage struct {
	Type    string
	Payload []byte
}

func (m *Manager) CreateHost() (RoomSnapshot, HostCredential, error) {
	return m.CreateHostWithOptions("", true)
}

func (m *Manager) CreateHostWithOptions(name string, discoverable bool) (RoomSnapshot, HostCredential, error) {
	name = strings.TrimSpace(name)
	if !utf8.ValidString(name) || utf8.RuneCountInString(name) > 32 {
		return RoomSnapshot{}, HostCredential{}, errors.New("INVALID_ROOM_NAME")
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return RoomSnapshot{}, HostCredential{}, errors.New("INVALID_ROOM_NAME")
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.expiredCodes == nil {
		m.expiredCodes = map[string]time.Time{}
	}
	code, err := uniqueCode(func(c string) bool { _, ok := m.byCode[c]; _, expired := m.expiredCodes[c]; return ok || expired })
	if err != nil {
		return RoomSnapshot{}, HostCredential{}, err
	}
	id, err := randomID(16)
	if err != nil {
		return RoomSnapshot{}, HostCredential{}, err
	}
	hostID, err := randomID(16)
	if err != nil {
		return RoomSnapshot{}, HostCredential{}, err
	}
	token, err := randomToken(32)
	if err != nil {
		return RoomSnapshot{}, HostCredential{}, err
	}
	h := sha256.Sum256([]byte(token))
	r := &room{id: id, code: code, hostID: hostID, peers: map[string]*peer{hostID: {id: hostID, role: "host", connected: true}}}
	if name == "" {
		name = "朋友的房间 " + id[:4]
	}
	r.name = name
	r.discoverable = discoverable
	m.rooms[id] = r
	m.byCode[code] = id
	m.hostTokens[h] = id
	if m.roomTTL > 0 {
		r.expires = m.now().Add(m.roomTTL)
		r.timer = time.AfterFunc(m.roomTTL, func() {
			m.mu.Lock()
			defer m.mu.Unlock()
			if m.rooms[id] == r && !r.ended {
				m.expireLocked(r)
			}
		})
	}
	return snapshot(r), HostCredential{Token: token}, nil
}

func (m *Manager) Join(roomCode, resumeToken string) (PeerSession, RoomSnapshot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	id, ok := m.byCode[strings.ToUpper(strings.TrimSpace(roomCode))]
	if !ok {
		if _, expired := m.expiredCodes[strings.ToUpper(strings.TrimSpace(roomCode))]; expired {
			return PeerSession{}, RoomSnapshot{}, errors.New("ROOM_EXPIRED")
		}
		return PeerSession{}, RoomSnapshot{}, errors.New("ROOM_NOT_FOUND")
	}
	r := m.rooms[id]
	if r == nil || r.ended {
		return PeerSession{}, RoomSnapshot{}, errors.New("ROOM_NOT_FOUND")
	}
	if r.expired(m.now()) {
		m.expireLocked(r)
		return PeerSession{}, RoomSnapshot{}, errors.New("ROOM_EXPIRED")
	}
	m.pruneDisconnected(r)
	if resumeToken != "" {
		h := sha256.Sum256([]byte(resumeToken))
		for _, p := range r.peers {
			if p.role == "viewer" && p.resumeHash == h && (p.connected || m.now().Before(p.reconnectUntil)) {
				token, err := randomToken(32)
				if err != nil {
					return PeerSession{}, RoomSnapshot{}, err
				}
				p.connected = true
				p.reconnectUntil = time.Time{}
				p.resumeHash = sha256.Sum256([]byte(token))
				return PeerSession{PeerID: p.id, ResumeToken: token}, snapshot(r), nil
			}
		}
		return PeerSession{}, RoomSnapshot{}, errors.New("INVALID_INVITE")
	}
	viewers := 0
	for _, p := range r.peers {
		if p.role == "viewer" {
			viewers++
		}
	}
	if viewers >= 2 {
		return PeerSession{}, RoomSnapshot{}, errors.New("ROOM_FULL")
	}
	peerID, err := randomID(16)
	if err != nil {
		return PeerSession{}, RoomSnapshot{}, err
	}
	token, err := randomToken(32)
	if err != nil {
		return PeerSession{}, RoomSnapshot{}, err
	}
	r.peers[peerID] = &peer{id: peerID, role: "viewer", connected: true, resumeHash: sha256.Sum256([]byte(token))}
	return PeerSession{PeerID: peerID, ResumeToken: token}, snapshot(r), nil
}

func (m *Manager) Leave(roomID, peerID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.rooms[roomID]
	if r == nil {
		return
	}
	p := r.peers[peerID]
	if p == nil {
		return
	}
	if p.role == "host" {
		m.endLocked(r)
		return
	}
	delete(r.peers, peerID)
	if r.presenterPeerID == peerID {
		clearPresentation(r)
	}
}

func (m *Manager) End(roomID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r := m.rooms[roomID]; r != nil {
		m.endLocked(r)
	}
}

func (m *Manager) EndAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, r := range m.rooms {
		m.endLocked(r)
	}
}

func (m *Manager) Disconnect(roomID, peerID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.rooms[roomID]
	if r == nil {
		return
	}
	p := r.peers[peerID]
	if p == nil {
		return
	}
	p.connected = false
	p.reconnectUntil = m.now().Add(ReconnectWindow)
}

// ResumeHost is called only after the local host control token has been authenticated.
func (m *Manager) ResumeHost(roomID string) (RoomSnapshot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.rooms[roomID]
	if r == nil || r.ended || r.expired(m.now()) {
		return RoomSnapshot{}, errors.New("ROOM_NOT_FOUND")
	}
	p := r.peers[r.hostID]
	if p == nil || (!p.connected && !m.now().Before(p.reconnectUntil)) {
		return RoomSnapshot{}, errors.New("ROOM_NOT_FOUND")
	}
	p.connected = true
	p.reconnectUntil = time.Time{}
	return snapshot(r), nil
}

func (m *Manager) DisconnectedExpired(roomID, peerID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.rooms[roomID]
	if r == nil || r.ended {
		return false
	}
	p := r.peers[peerID]
	return p != nil && !p.connected && !m.now().Before(p.reconnectUntil)
}

func (m *Manager) ExpireDisconnected(roomID, peerID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.rooms[roomID]
	if r == nil {
		return
	}
	p := r.peers[peerID]
	if p != nil && p.role == "viewer" && !p.connected && !m.now().Before(p.reconnectUntil) {
		delete(r.peers, peerID)
		if r.presenterPeerID == peerID {
			clearPresentation(r)
		}
	}
}

func (m *Manager) AuthenticateHost(token string) bool {
	if token == "" {
		return false
	}
	h := sha256.Sum256([]byte(token))
	m.mu.Lock()
	defer m.mu.Unlock()
	id, ok := m.hostTokens[h]
	if !ok {
		return false
	}
	r := m.rooms[id]
	return r != nil && !r.ended && !r.expired(m.now())
}

func (m *Manager) Route(roomID, fromPeerID, toPeerID string, msg SignalMessage) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.rooms[roomID]
	if r == nil || r.ended {
		return errors.New("ROOM_NOT_FOUND")
	}
	from := r.peers[fromPeerID]
	to := r.peers[toPeerID]
	if from == nil || to == nil || fromPeerID == toPeerID || !from.connected || !to.connected {
		return errors.New("SIGNAL_TARGET_NOT_MEMBER")
	}
	if msg.Type != "rtc.description" && msg.Type != "rtc.candidate" && msg.Type != "screen.ready" && msg.Type != "screen.description" {
		return errors.New("INVALID_MESSAGE")
	}
	if msg.Type == "screen.ready" && r.presenterPeerID != fromPeerID {
		return errors.New("SHARE_NOT_OWNER")
	}
	if msg.Type == "screen.description" {
		var payload struct {
			Description struct {
				Type string `json:"type"`
			} `json:"description"`
		}
		if err := json.Unmarshal(msg.Payload, &payload); err != nil {
			return errors.New("INVALID_MESSAGE")
		}
		switch payload.Description.Type {
		case "offer":
			if toPeerID != r.presenterPeerID {
				return errors.New("SHARE_NOT_OWNER")
			}
		case "answer":
			if fromPeerID != r.presenterPeerID {
				return errors.New("SHARE_NOT_OWNER")
			}
		default:
			return errors.New("INVALID_MESSAGE")
		}
	}
	return nil
}

func (m *Manager) Get(roomID string) (RoomSnapshot, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.rooms[roomID]
	if r == nil || r.ended {
		return RoomSnapshot{}, false
	}
	return snapshot(r), true
}

func (m *Manager) DiscoverableRooms() []RoomSnapshot {
	m.mu.Lock()
	defer m.mu.Unlock()
	result := []RoomSnapshot{}
	for _, r := range m.rooms {
		if !r.ended && r.discoverable && !r.expired(m.now()) {
			m.pruneDisconnected(r)
			result = append(result, snapshot(r))
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result
}

// Presentation belongs to an authenticated room member, independently of the
// host credential used to create/end the room. All changes share the room lock.
func (m *Manager) presentationMember(roomID, peerID string) (*room, error) {
	r := m.rooms[roomID]
	if r == nil || r.ended {
		return nil, errors.New("ROOM_NOT_FOUND")
	}
	if r.expired(m.now()) {
		m.expireLocked(r)
		return nil, errors.New("ROOM_EXPIRED")
	}
	p := r.peers[peerID]
	if p == nil || !p.connected {
		return nil, errors.New("AUTH_REQUIRED")
	}
	return r, nil
}

func (m *Manager) ClaimPresentation(roomID, peerID string) (RoomSnapshot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, err := m.presentationMember(roomID, peerID)
	if err != nil {
		return RoomSnapshot{}, err
	}
	if r.presenterPeerID != "" && r.presenterPeerID != peerID {
		return RoomSnapshot{}, errors.New("SHARE_BUSY")
	}
	r.presenterPeerID = peerID
	r.presentationRevision++
	return snapshot(r), nil
}

func (m *Manager) ReleasePresentation(roomID, peerID string) (RoomSnapshot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, err := m.presentationMember(roomID, peerID)
	if err != nil {
		return RoomSnapshot{}, err
	}
	if r.presenterPeerID != "" && r.presenterPeerID != peerID {
		return RoomSnapshot{}, errors.New("SHARE_NOT_OWNER")
	}
	clearPresentation(r)
	return snapshot(r), nil
}

func (m *Manager) UpdatePresentation(roomID, peerID string, sharing, systemAudio bool, isolation string) (RoomSnapshot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, err := m.presentationMember(roomID, peerID)
	if err != nil {
		return RoomSnapshot{}, err
	}
	if r.presenterPeerID != peerID {
		return RoomSnapshot{}, errors.New("SHARE_NOT_OWNER")
	}
	if !sharing {
		clearPresentation(r)
	} else {
		r.screenSharing = true
		r.hasSystemAudio = systemAudio
		r.isolationStatus = isolation
		r.presentationRevision++
	}
	return snapshot(r), nil
}

func clearPresentation(r *room) {
	r.presentationRevision++
	r.presenterPeerID = ""
	r.screenSharing = false
	r.hasSystemAudio = false
	r.isolationStatus = "unverified"
}
func (m *Manager) RoomForCode(code string) (RoomSnapshot, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	id, ok := m.byCode[strings.ToUpper(code)]
	if !ok {
		return RoomSnapshot{}, false
	}
	r := m.rooms[id]
	if r == nil || r.ended {
		return RoomSnapshot{}, false
	}
	return snapshot(r), true
}
func (m *Manager) endLocked(r *room) {
	if r.ended {
		return
	}
	r.ended = true
	if r.timer != nil {
		r.timer.Stop()
	}
	delete(m.byCode, r.code)
	for h, id := range m.hostTokens {
		if id == r.id {
			delete(m.hostTokens, h)
		}
	}
	delete(m.rooms, r.id)
}
func (m *Manager) expireLocked(r *room) {
	if m.expiredCodes == nil {
		m.expiredCodes = map[string]time.Time{}
	}
	code, expiredAt := r.code, m.now()
	snapshot := snapshot(r)
	m.expiredCodes[code] = expiredAt
	m.endLocked(r)
	if m.onExpire != nil {
		go m.onExpire(snapshot)
	}
	time.AfterFunc(5*time.Minute, func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.expiredCodes[code] == expiredAt {
			delete(m.expiredCodes, code)
		}
	})
}
func (m *Manager) pruneDisconnected(r *room) {
	for id, p := range r.peers {
		if p.role == "viewer" && !p.connected && !m.now().Before(p.reconnectUntil) {
			delete(r.peers, id)
			if r.presenterPeerID == id {
				clearPresentation(r)
			}
		}
	}
}
func snapshot(r *room) RoomSnapshot {
	s := RoomSnapshot{ID: r.id, Code: r.code, ExpiresAt: r.expires, Members: make([]PeerSnapshot, 0, len(r.peers)), PresenterPeerID: r.presenterPeerID, ScreenSharing: r.screenSharing, HasSystemAudio: r.hasSystemAudio, IsolationStatus: r.isolationStatus, PresentationRevision: r.presentationRevision, Name: r.name, Discoverable: r.discoverable}
	for _, p := range r.peers {
		state := "connected"
		if !p.connected {
			state = "reconnecting"
		}
		s.Members = append(s.Members, PeerSnapshot{PeerID: p.id, Role: p.role, State: state})
	}
	sort.Slice(s.Members, func(i, j int) bool {
		if s.Members[i].Role != s.Members[j].Role {
			return s.Members[i].Role < s.Members[j].Role
		}
		return s.Members[i].PeerID < s.Members[j].PeerID
	})
	return s
}
func randomID(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
func randomToken(n int) (string, error) { return randomID(n) }
func uniqueCode(taken func(string) bool) (string, error) {
	for tries := 0; tries < 8; tries++ {
		b := make([]byte, 8)
		if _, err := rand.Read(b); err != nil {
			return "", err
		}
		var out strings.Builder
		for _, v := range b {
			out.WriteByte(roomCodeAlphabet[int(v)%len(roomCodeAlphabet)])
		}
		code := out.String()
		if !taken(code) {
			return code, nil
		}
	}
	return "", fmt.Errorf("could not allocate unique invite code")
}
