// Package discovery finds opt-in rooms on the selected private IPv4 subnet.
// It never carries media or host/local control credentials.
package discovery

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/netip"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"
)

const ServiceName = "lan-screen-sharing"
const WireVersion = 2
const RoomLifetime = 7 * time.Second
const multicastIP = "239.255.77.77"
const multicastPort = 49877
const maxPacketBytes = 1400

type Advertisement struct {
	RoomID        string `json:"roomId"`
	Name          string `json:"name"`
	RoomCode      string `json:"roomCode"`
	Port          int    `json:"port"`
	Members       int    `json:"members"`
	ScreenSharing bool   `json:"screenSharing"`
}
type Room struct {
	ID            string `json:"id"`
	RoomID        string `json:"roomId"`
	Name          string `json:"name"`
	HostIPv4      string `json:"hostIPv4"`
	HostPort      int    `json:"hostPort"`
	RoomCode      string `json:"roomCode"`
	Members       int    `json:"members"`
	Capacity      int    `json:"capacity"`
	ScreenSharing bool   `json:"screenSharing"`
	Own           bool   `json:"own"`
}
type cachedRoom struct {
	room Room
	seen time.Time
}
type Cache struct {
	mu     sync.Mutex
	prefix netip.Prefix
	now    func() time.Time
	rooms  map[string]cachedRoom
}

func NewCache(prefix netip.Prefix, now func() time.Time) *Cache {
	return &Cache{prefix: prefix, now: now, rooms: map[string]cachedRoom{}}
}

func ValidName(name string) bool {
	if !utf8.ValidString(name) || utf8.RuneCountInString(name) > 32 || strings.TrimSpace(name) == "" {
		return false
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}
func validID(id string) bool {
	if len(id) < 1 || len(id) > 64 {
		return false
	}
	for _, r := range id {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-') {
			return false
		}
	}
	return true
}
func validAdvertisement(a Advertisement) bool {
	if !validID(a.RoomID) || !ValidName(a.Name) || a.Port < 1 || a.Port > 65535 || a.Members < 1 || a.Members > 3 || len(a.RoomCode) != 8 {
		return false
	}
	for _, r := range a.RoomCode {
		if !strings.ContainsRune("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", r) {
			return false
		}
	}
	return true
}
func (c *Cache) allows(source netip.Addr) bool {
	return source.Is4() && source.IsPrivate() && !source.IsLoopback() && c.prefix.IsValid() && c.prefix.Contains(source)
}
func (c *Cache) Observe(a Advertisement, source netip.Addr) bool {
	if !c.allows(source) || !validAdvertisement(a) {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	c.prune(now)
	key := source.String() + ":" + strconv.Itoa(a.Port) + "/" + a.RoomID
	if _, present := c.rooms[key]; !present && len(c.rooms) >= 64 {
		return false
	}
	c.rooms[key] = cachedRoom{Room{ID: key, RoomID: a.RoomID, Name: a.Name, HostIPv4: source.String(), HostPort: a.Port, RoomCode: a.RoomCode, Members: a.Members, Capacity: 3, ScreenSharing: a.ScreenSharing}, now}
	return true
}
func (c *Cache) prune(now time.Time) {
	for key, item := range c.rooms {
		if now.Sub(item.seen) >= RoomLifetime {
			delete(c.rooms, key)
		}
	}
}
func (c *Cache) List() []Room {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.prune(c.now())
	result := make([]Room, 0, len(c.rooms))
	for _, item := range c.rooms {
		result = append(result, item.room)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Name == result[j].Name {
			return result[i].ID < result[j].ID
		}
		return result[i].Name < result[j].Name
	})
	return result
}

type packet struct {
	Service string         `json:"service"`
	Version int            `json:"version"`
	Kind    string         `json:"kind"`
	QueryID string         `json:"queryId"`
	Room    *Advertisement `json:"room,omitempty"`
}

func decodePacket(data []byte) (packet, error) {
	var p packet
	if len(data) > maxPacketBytes {
		return p, errors.New("discovery packet too large")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&p); err != nil {
		return p, err
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return p, errors.New("trailing packet")
	}
	if p.Service != ServiceName || p.Version != WireVersion || (p.Kind != "query" && p.Kind != "room") || len(p.QueryID) != 32 {
		return p, errors.New("foreign packet")
	}
	if _, err := hex.DecodeString(p.QueryID); err != nil {
		return p, err
	}
	if p.Kind == "query" && p.Room != nil || p.Kind == "room" && (p.Room == nil || !validAdvertisement(*p.Room)) {
		return p, errors.New("invalid room packet")
	}
	return p, nil
}

type Service struct {
	cache            *Cache
	receiver, sender udpSocket
	destinations     []*net.UDPAddr
	localQuerySource string
	advertisements   func() []Advertisement
	cancel           context.CancelFunc
	closeOnce        sync.Once
	queryMu          sync.Mutex
	queries          map[string]time.Time
	replyMu          sync.Mutex
	replied          map[string]time.Time
	diagnosticsMu    sync.Mutex
	diagnostics      Diagnostics
}

type udpSocket interface {
	ReadFromUDP([]byte) (int, *net.UDPAddr, error)
	WriteToUDP([]byte, *net.UDPAddr) (int, error)
	SetWriteDeadline(time.Time) error
	Close() error
}

// Diagnostics intentionally excludes invitations, room contents and control tokens.
type Diagnostics struct {
	InterfaceName   string `json:"interfaceName"`
	LocalIPv4       string `json:"localIPv4"`
	Subnet          string `json:"subnet"`
	Transport       string `json:"transport"`
	Running         bool   `json:"running"`
	QueriesSent     uint64 `json:"queriesSent"`
	QueriesReceived uint64 `json:"queriesReceived"`
	RepliesSent     uint64 `json:"repliesSent"`
	RepliesReceived uint64 `json:"repliesReceived"`
	SendErrors      uint64 `json:"sendErrors"`
	ReadErrors      uint64 `json:"readErrors"`
	LastError       string `json:"lastError,omitempty"`
}

func (s *Service) Diagnostics() Diagnostics {
	s.diagnosticsMu.Lock()
	defer s.diagnosticsMu.Unlock()
	return s.diagnostics
}

func (s *Service) record(update func(*Diagnostics)) {
	s.diagnosticsMu.Lock()
	defer s.diagnosticsMu.Unlock()
	update(&s.diagnostics)
}

func ErrorCode(err error) string {
	if err == nil {
		return ""
	}
	switch err.Error() {
	case "NO_PRIVATE_NETWORK", "NETWORK_INTERFACE_UNAVAILABLE":
		return err.Error()
	}
	var errno syscall.Errno
	_ = errors.As(err, &errno)
	switch {
	case errors.Is(err, syscall.EACCES) || uint32(errno) == 10013:
		return "NETWORK_PERMISSION_DENIED"
	case errors.Is(err, syscall.EADDRINUSE) || uint32(errno) == 10048:
		return "DISCOVERY_PORT_IN_USE"
	case errors.Is(err, syscall.EMSGSIZE) || uint32(errno) == 10040:
		return "PACKET_TOO_LARGE"
	default:
		return "DISCOVERY_SOCKET_ERROR"
	}
}

func queryDestinations(prefix netip.Prefix, multicast bool) []*net.UDPAddr {
	result := []*net.UDPAddr{}
	if multicast {
		result = append(result, &net.UDPAddr{IP: net.ParseIP(multicastIP), Port: multicastPort})
	}
	if !prefix.IsValid() || !prefix.Addr().Is4() || prefix.Bits() < 8 || prefix.Bits() > 30 {
		return result
	}
	address := prefix.Masked().Addr().As4()
	for bit := prefix.Bits(); bit < 32; bit++ {
		address[bit/8] |= 1 << (7 - bit%8)
	}
	broadcast := netip.AddrFrom4(address)
	if prefix.Masked().Addr().IsPrivate() && broadcast.IsPrivate() {
		result = append(result, &net.UDPAddr{IP: net.IP(address[:]), Port: multicastPort})
	}
	return result
}

func interfaceFor(ip netip.Addr) (*net.Interface, netip.Prefix, error) {
	list, err := net.Interfaces()
	if err != nil {
		return nil, netip.Prefix{}, err
	}
	for _, iface := range list {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addresses, _ := iface.Addrs()
		for _, address := range addresses {
			prefix, err := netip.ParsePrefix(address.String())
			if err == nil && prefix.Addr().Unmap() == ip {
				copy := iface
				return &copy, prefix.Masked(), nil
			}
		}
	}
	return nil, netip.Prefix{}, errors.New("NETWORK_INTERFACE_UNAVAILABLE")
}

func Start(parent context.Context, ipText string, advertisements func() []Advertisement) (*Service, error) {
	ip, err := netip.ParseAddr(ipText)
	if err != nil || !ip.Is4() || !ip.IsPrivate() || ip.IsLoopback() {
		return nil, errors.New("NO_PRIVATE_NETWORK")
	}
	iface, prefix, err := interfaceFor(ip)
	if err != nil {
		return nil, err
	}
	sender, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.ParseIP(ipText)})
	if err != nil {
		return nil, err
	}
	receiver, multicastErr := net.ListenMulticastUDP("udp4", iface, &net.UDPAddr{IP: net.ParseIP(multicastIP), Port: multicastPort})
	if multicastErr == nil {
		multicastErr = configureMulticast(receiver, sender)
		if multicastErr != nil {
			receiver.Close()
		}
	}
	if multicastErr != nil {
		// UDP broadcasts still work on networks/interfaces without multicast membership.
		config := net.ListenConfig{Control: reuseDiscoveryPort}
		conn, listenErr := config.ListenPacket(parent, "udp4", net.JoinHostPort("0.0.0.0", strconv.Itoa(multicastPort)))
		if listenErr != nil {
			sender.Close()
			return nil, listenErr
		}
		receiver = conn.(*net.UDPConn)
	}
	targets := queryDestinations(prefix, multicastErr == nil)
	if len(targets) == 0 {
		receiver.Close()
		sender.Close()
		return nil, errors.New("NETWORK_INTERFACE_UNAVAILABLE")
	}
	ctx, cancel := context.WithCancel(parent)
	transport := "multicast+broadcast"
	if multicastErr != nil {
		transport = "broadcast"
	} else if len(targets) == 1 {
		transport = "multicast"
	}
	s := &Service{cache: NewCache(prefix, time.Now), receiver: receiver, sender: sender, destinations: targets, localQuerySource: sender.LocalAddr().String(), advertisements: advertisements, cancel: cancel, queries: map[string]time.Time{}, replied: map[string]time.Time{}, diagnostics: Diagnostics{InterfaceName: iface.Name, LocalIPv4: ipText, Subnet: prefix.String(), Transport: transport, Running: true}}
	go s.readQueries(ctx)
	go s.readRooms(ctx)
	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		s.query()
		for {
			select {
			case <-ctx.Done():
				s.Close()
				return
			case <-ticker.C:
				s.query()
			}
		}
	}()
	return s, nil
}
func (s *Service) Close() {
	s.closeOnce.Do(func() {
		s.record(func(d *Diagnostics) { d.Running = false })
		s.cancel()
		s.receiver.Close()
		s.sender.Close()
	})
}
func (s *Service) Rooms() []Room { return s.cache.List() }
func (s *Service) query() {
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return
	}
	id := hex.EncodeToString(random[:])
	now := time.Now()
	s.queryMu.Lock()
	for key, created := range s.queries {
		if now.Sub(created) >= RoomLifetime {
			delete(s.queries, key)
		}
	}
	s.queries[id] = now
	s.queryMu.Unlock()
	data, _ := json.Marshal(packet{Service: ServiceName, Version: WireVersion, Kind: "query", QueryID: id})
	for _, destination := range s.destinations {
		if s.writePacket(data, destination) {
			s.record(func(d *Diagnostics) { d.QueriesSent++ })
		}
	}
}

func (s *Service) writePacket(data []byte, destination *net.UDPAddr) bool {
	err := s.sender.SetWriteDeadline(time.Now().Add(250 * time.Millisecond))
	if err == nil {
		_, err = s.sender.WriteToUDP(data, destination)
	}
	if err != nil {
		s.record(func(d *Diagnostics) { d.SendErrors++; d.LastError = ErrorCode(err) })
	}
	return err == nil
}

func (s *Service) handleReadError(ctx context.Context, err error) bool {
	if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
		return false
	}
	s.record(func(d *Diagnostics) { d.ReadErrors++; d.LastError = ErrorCode(err) })
	// Windows reports an oversized datagram as a read error. Discard that packet,
	// rather than silently stopping the discovery receiver forever.
	if ErrorCode(err) == "PACKET_TOO_LARGE" {
		return true
	}
	s.Close()
	return false
}
func (s *Service) readQueries(ctx context.Context) {
	buffer := make([]byte, maxPacketBytes+1)
	for {
		n, source, err := s.receiver.ReadFromUDP(buffer)
		if err != nil {
			if s.handleReadError(ctx, err) {
				continue
			}
			return
		}
		if ctx.Err() != nil {
			return
		}
		s.handleQuery(buffer[:n], source)
	}
}

func (s *Service) handleQuery(data []byte, source *net.UDPAddr) {
	if source.String() == s.localQuerySource {
		return
	}
	p, err := decodePacket(data)
	if err != nil || p.Kind != "query" {
		return
	}
	ip, ok := netip.AddrFromSlice(source.IP)
	ip = ip.Unmap()
	if !ok || !s.cache.allows(ip) {
		return
	}
	s.record(func(d *Diagnostics) { d.QueriesReceived++ })
	s.replyMu.Lock()
	now := time.Now()
	key := source.String()
	last, known := s.replied[key]
	for key, seen := range s.replied {
		if now.Sub(seen) > RoomLifetime {
			delete(s.replied, key)
		}
	}
	allowed := now.Sub(last) >= time.Second && (known || len(s.replied) < 128)
	if allowed {
		s.replied[key] = now
	}
	s.replyMu.Unlock()
	if !allowed {
		return
	}
	for index, a := range s.advertisements() {
		if index >= 8 {
			break
		}
		if !validAdvertisement(a) {
			continue
		}
		reply, _ := json.Marshal(packet{Service: ServiceName, Version: WireVersion, Kind: "room", QueryID: p.QueryID, Room: &a})
		if s.writePacket(reply, source) {
			s.record(func(d *Diagnostics) { d.RepliesSent++ })
		}
	}
}
func (s *Service) readRooms(ctx context.Context) {
	buffer := make([]byte, maxPacketBytes+1)
	for {
		n, source, err := s.sender.ReadFromUDP(buffer)
		if err != nil {
			if s.handleReadError(ctx, err) {
				continue
			}
			return
		}
		if ctx.Err() != nil {
			return
		}
		ip, ok := netip.AddrFromSlice(source.IP)
		if ok {
			s.observeReply(buffer[:n], ip.Unmap(), time.Now())
		}
	}
}

func (s *Service) observeReply(data []byte, source netip.Addr, now time.Time) bool {
	p, err := decodePacket(data)
	if err != nil || p.Kind != "room" {
		return false
	}
	s.queryMu.Lock()
	created, known := s.queries[p.QueryID]
	s.queryMu.Unlock()
	if !known || now.Before(created) || now.Sub(created) >= RoomLifetime {
		return false
	}
	accepted := s.cache.Observe(*p.Room, source)
	if accepted {
		s.record(func(d *Diagnostics) { d.RepliesReceived++ })
	}
	return accepted
}
