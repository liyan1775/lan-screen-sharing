// Package discovery finds opt-in rooms on the selected private IPv4 network and at configured peer addresses.
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

	"golang.org/x/net/ipv4"
)

const ServiceName = "lan-screen-sharing"
const WireVersion = 2
const RoomLifetime = 7 * time.Second
const multicastIP = "239.255.77.77"

var multicastAddress = netip.MustParseAddr(multicastIP)
var limitedBroadcastIP = netip.MustParseAddr("255.255.255.255")

const multicastPort = 49877
const maxPacketBytes = 1400
const MaxDirectPeers = 8
const refreshInterval = 800 * time.Millisecond
const queryInterval = 2 * time.Second
const maxRepliesPerSecond = 32

func privateIPv4(ip netip.Addr) bool {
	return ip.Is4() && ip.IsPrivate() && !ip.IsLoopback()
}

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
	peers  map[netip.Addr]struct{}
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
	_, direct := c.peers[source]
	return privateIPv4(source) && (c.prefix.Contains(source) || direct)
}
func (c *Cache) setDirectPeers(peers map[netip.Addr]struct{}) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.peers = peers
	for key, item := range c.rooms {
		if !c.allows(netip.MustParseAddr(item.room.HostIPv4)) {
			delete(c.rooms, key)
		}
	}
}
func (c *Cache) Observe(a Advertisement, source netip.Addr) bool {
	if !validAdvertisement(a) {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.allows(source) {
		return false
	}
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
	port             int
	localIP          netip.Addr
	directPeers      map[netip.Addr]struct{}
	localIPs         map[netip.Addr]struct{}
	refreshRequests  chan struct{}
	localQuerySource string
	advertisements   func() []Advertisement
	cancel           context.CancelFunc
	closeOnce        sync.Once
	queryMu          sync.Mutex
	queries          map[string]activeQuery
	replyMu          sync.Mutex
	replied          map[querySource]time.Time
	lastQueryByIP    map[netip.Addr]time.Time
	replyTimes       []time.Time
	writeMu          sync.Mutex
	diagnosticsMu    sync.Mutex
	diagnostics      Diagnostics
}

type activeQuery struct {
	created     time.Time
	directPeers map[netip.Addr]struct{}
}

type querySource struct {
	ip netip.Addr
	id string
}

type udpSocket interface {
	ReadFromUDP([]byte) (int, *net.UDPAddr, error)
	WriteToUDP([]byte, *net.UDPAddr) (int, error)
	SetWriteDeadline(time.Time) error
	Close() error
}

type PathDiagnostics struct {
	QueriesSent     uint64 `json:"queriesSent"`
	QueriesReceived uint64 `json:"queriesReceived"`
}

type DiscoveryPaths struct {
	Multicast        PathDiagnostics `json:"multicast"`
	SubnetBroadcast  PathDiagnostics `json:"subnetBroadcast"`
	LimitedBroadcast PathDiagnostics `json:"limitedBroadcast"`
	DirectUnicast    PathDiagnostics `json:"directUnicast"`
	Unknown          PathDiagnostics `json:"unknown"`
}

func (d *DiscoveryPaths) forDestination(ip, broadcast netip.Addr) *PathDiagnostics {
	switch {
	case !ip.IsValid():
		return &d.Unknown
	case ip == multicastAddress:
		return &d.Multicast
	case ip == limitedBroadcastIP:
		return &d.LimitedBroadcast
	case ip == broadcast:
		return &d.SubnetBroadcast
	default:
		return &d.DirectUnicast
	}
}

// Diagnostics intentionally excludes invitations, room contents and control tokens.
type Diagnostics struct {
	InterfaceName              string         `json:"interfaceName"`
	LocalIPv4                  string         `json:"localIPv4"`
	Subnet                     string         `json:"subnet"`
	Transport                  string         `json:"transport"`
	Running                    bool           `json:"running"`
	DirectPeers                int            `json:"directPeers"`
	Paths                      DiscoveryPaths `json:"paths"`
	SubnetRepliesReceived      uint64         `json:"subnetRepliesReceived"`
	CrossSubnetRepliesReceived uint64         `json:"crossSubnetRepliesReceived"`
	QueriesSent                uint64         `json:"queriesSent"`
	QueriesReceived            uint64         `json:"queriesReceived"`
	RepliesSent                uint64         `json:"repliesSent"`
	RepliesReceived            uint64         `json:"repliesReceived"`
	SendErrors                 uint64         `json:"sendErrors"`
	ReadErrors                 uint64         `json:"readErrors"`
	LastError                  string         `json:"lastError,omitempty"`
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

func subnetBroadcast(prefix netip.Prefix) netip.Addr {
	if !prefix.IsValid() || !prefix.Addr().Is4() || prefix.Bits() < 8 || prefix.Bits() > 30 {
		return netip.Addr{}
	}
	address := prefix.Masked().Addr().As4()
	for bit := prefix.Bits(); bit < 32; bit++ {
		address[bit/8] |= 1 << (7 - bit%8)
	}
	broadcast := netip.AddrFrom4(address)
	if privateIPv4(prefix.Masked().Addr()) && privateIPv4(broadcast) {
		return broadcast
	}
	return netip.Addr{}
}

func queryDestinations(prefix netip.Prefix, multicast bool) []*net.UDPAddr {
	result := []*net.UDPAddr{}
	if multicast {
		result = append(result, &net.UDPAddr{IP: net.ParseIP(multicastIP), Port: multicastPort})
	}
	if broadcast := subnetBroadcast(prefix); broadcast.IsValid() {
		result = append(result, net.UDPAddrFromAddrPort(netip.AddrPortFrom(broadcast, multicastPort)))
		result = append(result, &net.UDPAddr{IP: net.IPv4bcast, Port: multicastPort})
	}
	return result
}

func interfaceFor(ip netip.Addr) (*net.Interface, netip.Prefix, error) {
	list, err := net.Interfaces()
	if err != nil {
		return nil, netip.Prefix{}, err
	}
	for _, iface := range list {
		if iface.Flags&net.FlagUp == 0 {
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
	return start(parent, ipText, advertisements, multicastPort)
}

func start(parent context.Context, ipText string, advertisements func() []Advertisement, port int) (*Service, error) {
	ip, err := netip.ParseAddr(ipText)
	if err != nil || !privateIPv4(ip) {
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
	if err := enableBroadcast(sender); err != nil {
		sender.Close()
		return nil, err
	}
	receiver, err := net.ListenUDP("udp4", &net.UDPAddr{Port: port})
	if err != nil {
		sender.Close()
		return nil, err
	}
	group := &net.UDPAddr{IP: net.ParseIP(multicastIP)}
	multicastErr := configureMulticast(sender)
	if multicastErr == nil {
		multicastErr = ipv4.NewPacketConn(receiver).JoinGroup(iface, group)
	}
	queryReceiver := newQuerySocket(receiver, iface.Index)
	localIPs := map[netip.Addr]struct{}{ip: {}}
	addresses, _ := net.InterfaceAddrs()
	for _, address := range addresses {
		if local, err := netip.ParsePrefix(address.String()); err == nil {
			localIPs[local.Addr().Unmap()] = struct{}{}
			if broadcast := subnetBroadcast(local); broadcast.IsValid() {
				localIPs[broadcast] = struct{}{}
			}
		}
	}
	port = receiver.LocalAddr().(*net.UDPAddr).Port
	targets := queryDestinations(prefix, multicastErr == nil)
	for _, destination := range targets {
		destination.Port = port
	}
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
	s := &Service{
		cache: NewCache(prefix, time.Now), receiver: queryReceiver, sender: newSenderSocket(sender, iface.Index),
		destinations: targets, port: port, localIP: ip, localIPs: localIPs, refreshRequests: make(chan struct{}, 1),
		localQuerySource: sender.LocalAddr().String(), advertisements: advertisements, cancel: cancel,
		queries: make(map[string]activeQuery), replied: make(map[querySource]time.Time),
		lastQueryByIP: make(map[netip.Addr]time.Time),
		diagnostics:   Diagnostics{InterfaceName: iface.Name, LocalIPv4: ipText, Subnet: prefix.String(), Transport: transport, Running: true},
	}
	go s.readQueries(ctx)
	go s.readRooms(ctx)
	go s.runQueries(ctx)
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

// SetDirectPeers replaces the list of explicitly trusted probe targets.
func (s *Service) SetDirectPeers(ips []string) {
	peers := make(map[netip.Addr]struct{})
	for _, text := range ips {
		ip, err := netip.ParseAddr(text)
		_, local := s.localIPs[ip]
		if err != nil || !privateIPv4(ip) || ip == s.localIP || local {
			continue
		}
		peers[ip] = struct{}{}
		if len(peers) == MaxDirectPeers {
			break
		}
	}
	s.queryMu.Lock()
	defer s.queryMu.Unlock()
	s.cache.setDirectPeers(peers)
	s.directPeers = peers
	s.record(func(d *Diagnostics) { d.DirectPeers = len(peers) })
}

// Refresh requests a probe. Requests during the cooldown coalesce into one
// pending round, so a changed peer list is still probed promptly.
func (s *Service) Refresh() bool {
	if !s.Diagnostics().Running {
		return false
	}
	select {
	case s.refreshRequests <- struct{}{}:
		return true
	default:
		return false
	}
}

func (s *Service) runQueries(ctx context.Context) {
	defer s.Close()
	ticker := time.NewTicker(queryInterval)
	defer ticker.Stop()
	s.query()
	var refreshed time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.query()
		case <-s.refreshRequests:
			if delay := time.Until(refreshed.Add(refreshInterval)); delay > 0 {
				timer := time.NewTimer(delay)
				select {
				case <-ctx.Done():
					timer.Stop()
					return
				case <-timer.C:
				}
			}
			// A request queued during the cooldown is covered by this same round.
			select {
			case <-s.refreshRequests:
			default:
			}
			refreshed = time.Now()
			s.query()
		}
	}
}

func (s *Service) query() {
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return
	}
	id := hex.EncodeToString(random[:])
	now := time.Now()
	s.queryMu.Lock()
	for key, created := range s.queries {
		if now.Sub(created.created) >= RoomLifetime {
			delete(s.queries, key)
		}
	}
	peers := s.directPeers
	s.queries[id] = activeQuery{created: now, directPeers: peers}
	s.queryMu.Unlock()
	data, _ := json.Marshal(packet{Service: ServiceName, Version: WireVersion, Kind: "query", QueryID: id})
	broadcast := subnetBroadcast(s.cache.prefix)
	send := func(destination *net.UDPAddr) {
		if s.writePacket(data, destination) {
			s.record(func(d *Diagnostics) {
				d.QueriesSent++
				d.Paths.forDestination(destination.AddrPort().Addr().Unmap(), broadcast).QueriesSent++
			})
		}
	}
	for _, destination := range s.destinations {
		send(destination)
	}
	for peer := range peers {
		send(net.UDPAddrFromAddrPort(netip.AddrPortFrom(peer, uint16(s.port))))
	}
}

func (s *Service) writePacket(data []byte, destination *net.UDPAddr) bool {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
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
		var destination netip.Addr
		var n int
		var source *net.UDPAddr
		var err error
		if receiver, ok := s.receiver.(interface {
			readQuery([]byte) (int, *net.UDPAddr, netip.Addr, error)
		}); ok {
			n, source, destination, err = receiver.readQuery(buffer)
		} else {
			n, source, err = s.receiver.ReadFromUDP(buffer)
		}
		if err != nil {
			if s.handleReadError(ctx, err) {
				continue
			}
			return
		}
		if ctx.Err() != nil {
			return
		}
		s.handleQuery(buffer[:n], source, destination)
	}
}

func (s *Service) handleQuery(data []byte, source *net.UDPAddr, destination netip.Addr) {
	if source == nil || source.String() == s.localQuerySource {
		return
	}
	if destination.IsValid() && destination != s.localIP && destination != multicastAddress &&
		destination != limitedBroadcastIP && destination != subnetBroadcast(s.cache.prefix) {
		return
	}
	p, err := decodePacket(data)
	ip := source.AddrPort().Addr().Unmap()
	if err != nil || p.Kind != "query" || !privateIPv4(ip) || source.Port == 0 {
		return
	}
	s.record(func(d *Diagnostics) {
		d.QueriesReceived++
		d.Paths.forDestination(destination, subnetBroadcast(s.cache.prefix)).QueriesReceived++
	})
	if !s.allowQuery(ip, p.QueryID, time.Now()) {
		return
	}
	for index, a := range s.advertisements() {
		if index >= 8 {
			break
		}
		if !validAdvertisement(a) {
			continue
		}
		if !s.reserveReply(time.Now()) {
			break
		}
		reply, _ := json.Marshal(packet{Service: ServiceName, Version: WireVersion, Kind: "room", QueryID: p.QueryID, Room: &a})
		if s.writePacket(reply, source) {
			s.record(func(d *Diagnostics) { d.RepliesSent++ })
		}
	}
}
func (s *Service) allowQuery(ip netip.Addr, id string, now time.Time) bool {
	s.replyMu.Lock()
	defer s.replyMu.Unlock()
	key := querySource{ip, id}
	if seen, ok := s.replied[key]; ok && now.Sub(seen) < RoomLifetime {
		return false
	}
	if seen, ok := s.lastQueryByIP[ip]; ok && now.Sub(seen) < time.Second {
		return false
	}
	for key, seen := range s.replied {
		if now.Sub(seen) >= RoomLifetime {
			delete(s.replied, key)
		}
	}
	for source, seen := range s.lastQueryByIP {
		if now.Sub(seen) >= time.Second {
			delete(s.lastQueryByIP, source)
		}
	}
	if len(s.replied) >= 256 || len(s.lastQueryByIP) >= 128 {
		return false
	}
	s.replied[key] = now
	s.lastQueryByIP[ip] = now
	return true
}

func (s *Service) reserveReply(now time.Time) bool {
	s.replyMu.Lock()
	defer s.replyMu.Unlock()
	expired := 0
	for expired < len(s.replyTimes) && now.Sub(s.replyTimes[expired]) >= time.Second {
		expired++
	}
	if expired > 0 {
		s.replyTimes = s.replyTimes[:copy(s.replyTimes, s.replyTimes[expired:])]
	}
	if len(s.replyTimes) >= maxRepliesPerSecond {
		return false
	}
	s.replyTimes = append(s.replyTimes, now)
	return true
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
	query, known := s.queries[p.QueryID]
	s.queryMu.Unlock()
	if !known || now.Before(query.created) || now.Sub(query.created) >= RoomLifetime {
		return false
	}
	inSubnet := s.cache.prefix.Contains(source)
	if !inSubnet {
		if _, probed := query.directPeers[source]; !probed {
			return false
		}
	}
	accepted := s.cache.Observe(*p.Room, source)
	if accepted {
		// Wire v2 replies echo a shared query ID. Their source is observable,
		// but the path taken by the original query cannot be inferred.
		s.record(func(d *Diagnostics) {
			d.RepliesReceived++
			if inSubnet {
				d.SubnetRepliesReceived++
			} else {
				d.CrossSubnetRepliesReceived++
			}
		})
	}
	return accepted
}
