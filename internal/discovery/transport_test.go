package discovery

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/netip"
	"runtime"
	"syscall"
	"testing"
	"time"
)

type testDatagram struct {
	data    []byte
	address *net.UDPAddr
	err     error
}
type memorySocket struct {
	reads  []testDatagram
	writes []testDatagram
	closed int
}

func (s *memorySocket) ReadFromUDP(buffer []byte) (int, *net.UDPAddr, error) {
	if len(s.reads) == 0 {
		return 0, nil, net.ErrClosed
	}
	p := s.reads[0]
	s.reads = s.reads[1:]
	return copy(buffer, p.data), p.address, p.err
}
func (s *memorySocket) WriteToUDP(data []byte, address *net.UDPAddr) (int, error) {
	s.writes = append(s.writes, testDatagram{data: append([]byte(nil), data...), address: address})
	return len(data), nil
}
func (*memorySocket) SetWriteDeadline(time.Time) error { return nil }
func (s *memorySocket) Close() error                   { s.closed++; return nil }
func memoryService() (*Service, *memorySocket, *memorySocket) {
	receiver, sender := &memorySocket{}, &memorySocket{}
	prefix := netip.MustParsePrefix("192.168.1.0/24")
	return &Service{cache: NewCache(prefix, time.Now), receiver: receiver, sender: sender, destinations: queryDestinations(prefix, true), port: multicastPort, advertisements: func() []Advertisement { return nil }, cancel: func() {}, localIP: netip.MustParseAddr("192.168.1.10"), refreshRequests: make(chan struct{}, 1), queries: map[string]activeQuery{}, replied: map[querySource]time.Time{}, lastQueryByIP: map[netip.Addr]time.Time{}, diagnostics: Diagnostics{Running: true}}, receiver, sender
}

func TestBroadcastCompletesDiscoveryWhenMulticastPacketsAreDropped(t *testing.T) {
	viewer, _, outgoing := memoryService()
	defer viewer.Close()
	viewer.query()
	if len(outgoing.writes) != 3 || outgoing.writes[0].address.String() != "239.255.77.77:49877" || outgoing.writes[1].address.String() != "192.168.1.255:49877" || outgoing.writes[2].address.String() != "255.255.255.255:49877" {
		t.Fatal("query did not use bounded multicast and subnet broadcast")
	}
	host, _, replies := memoryService()
	defer host.Close()
	host.advertisements = func() []Advertisement {
		return []Advertisement{{RoomID: "friends", Name: "一起玩", RoomCode: "ABCD2345", Port: 45678, Members: 1}}
	}
	querySource := &net.UDPAddr{IP: net.ParseIP("192.168.1.20"), Port: 50000}
	// Drop the multicast packet entirely; deliver only the broadcast fallback.
	host.handleQuery(outgoing.writes[1].data, querySource, netip.MustParseAddr("192.168.1.255"))
	if len(replies.writes) != 1 || replies.writes[0].address != querySource {
		t.Fatal("reply was not sent to the actual querying UDP endpoint")
	}
	if !viewer.observeReply(replies.writes[0].data, netip.MustParseAddr("192.168.1.10"), time.Now()) {
		t.Fatal("broadcast reply was not correlated to the outstanding query")
	}
	rooms := viewer.Rooms()
	if len(rooms) != 1 || rooms[0].HostIPv4 != "192.168.1.10" {
		t.Fatal("broadcast path failed to populate a joinable room")
	}
	// The duplicate multicast copy must not amplify replies.
	host.handleQuery(outgoing.writes[0].data, &net.UDPAddr{IP: querySource.IP, Port: querySource.Port + 1}, multicastAddress)
	host.handleQuery(outgoing.writes[2].data, querySource, limitedBroadcastIP)
	paths := host.Diagnostics().Paths
	if paths.Multicast.QueriesReceived != 1 || paths.SubnetBroadcast.QueriesReceived != 1 || paths.LimitedBroadcast.QueriesReceived != 1 {
		t.Fatalf("missing per-path query counts: %+v", paths)
	}
	if len(replies.writes) != 1 {
		t.Fatal("duplicate transport query bypassed reply rate limit")
	}
}

func TestBroadcastNeverTargetsGlobalOrPointToPointNetworks(t *testing.T) {
	for _, prefix := range []string{"192.168.1.1/32", "192.168.1.0/31", "10.0.0.0/7", "0.0.0.0/0", "8.8.8.0/24"} {
		if len(queryDestinations(netip.MustParsePrefix(prefix), false)) != 0 {
			t.Fatalf("unsafe broadcast target for %s", prefix)
		}
	}
	targets := queryDestinations(netip.MustParsePrefix("10.208.128.0/18"), false)
	if len(targets) != 2 || targets[0].String() != "10.208.191.255:49877" || targets[1].String() != "255.255.255.255:49877" {
		t.Fatal("broadcast did not respect the actual subnet mask")
	}
}

func TestOversizedWindowsDatagramDoesNotStopSubsequentQueries(t *testing.T) {
	s, receiver, outgoing := memoryService()
	defer s.Close()
	s.advertisements = func() []Advertisement {
		return []Advertisement{{RoomID: "friends", Name: "房间", RoomCode: "ABCD2345", Port: 45678, Members: 1}}
	}
	data, _ := json.Marshal(packet{Service: ServiceName, Version: WireVersion, Kind: "query", QueryID: "0123456789abcdef0123456789abcdef"})
	receiver.reads = []testDatagram{{err: &net.OpError{Op: "read", Net: "udp", Err: syscall.Errno(10040)}}, {data: data, address: &net.UDPAddr{IP: net.ParseIP("192.168.1.20"), Port: 50000}}}
	s.readQueries(context.Background())
	if len(outgoing.writes) != 1 || s.Diagnostics().ReadErrors != 1 || s.Diagnostics().RepliesSent != 1 {
		t.Fatal("one oversized packet killed discovery")
	}
}

func TestFatalSocketFailureIsVisibleInsteadOfAnApparentlyHealthyEmptyList(t *testing.T) {
	s, receiver, sender := memoryService()
	sender.reads = []testDatagram{{err: syscall.EACCES}}
	s.readRooms(context.Background())
	d := s.Diagnostics()
	if d.Running || d.LastError != "NETWORK_PERMISSION_DENIED" || receiver.closed != 1 || sender.closed != 1 {
		t.Fatal("failed discovery did not expose failure and release both sockets")
	}
}

func TestFriendUnicastDiscoversCrossSubnetRoom(t *testing.T) {
	viewer, _, outgoing := memoryService()
	defer viewer.Close()
	host, _, replies := memoryService()
	defer host.Close()
	host.cache = NewCache(netip.MustParsePrefix("10.208.128.0/18"), time.Now)
	host.localIP = netip.MustParseAddr("10.208.138.52")
	host.advertisements = func() []Advertisement {
		return []Advertisement{{RoomID: "campus", Name: "校园房间", RoomCode: "ABCD2345", Port: 45678, Members: 1}}
	}
	viewerIP := &net.UDPAddr{IP: net.ParseIP("192.168.1.10"), Port: 55000}
	viewer.query()
	host.handleQuery(outgoing.writes[0].data, &net.UDPAddr{IP: viewerIP.IP, Port: 55001}, host.localIP)
	if len(replies.writes) != 1 {
		t.Fatal("host refused a private cross-subnet query")
	}
	oldReply := replies.writes[0].data
	if viewer.observeReply(oldReply, host.localIP, time.Now()) {
		t.Fatal("matching query ID accepted an unconfigured cross-subnet source")
	}
	viewer.SetDirectPeers([]string{host.localIP.String(), host.localIP.String(), "8.8.8.8", "127.0.0.1", viewer.localIP.String()})
	if viewer.Diagnostics().DirectPeers != 1 || viewer.observeReply(oldReply, host.localIP, time.Now()) {
		t.Fatal("peer list accepted invalid targets or an earlier probe became authorized retroactively")
	}
	outgoing.writes = nil
	viewer.query()
	if len(outgoing.writes) != 4 || outgoing.writes[3].address.String() != "10.208.138.52:49877" {
		t.Fatalf("missing direct friend query: %+v", outgoing.writes)
	}
	for _, write := range outgoing.writes {
		if string(write.data) != string(outgoing.writes[3].data) {
			t.Fatal("the query paths used different IDs")
		}
	}
	// Advance only the host's per-source limit to allow the next round.
	host.lastQueryByIP[viewer.localIP] = time.Now().Add(-time.Second)
	host.handleQuery(outgoing.writes[3].data, viewerIP, host.localIP)
	if len(replies.writes) != 2 ||
		!viewer.observeReply(replies.writes[1].data, host.localIP, time.Now()) ||
		viewer.observeReply(replies.writes[1].data, netip.MustParseAddr("10.208.138.53"), time.Now()) {
		t.Fatal("friend probe did not accept exactly the authorized cross-subnet source")
	}
	rooms := viewer.Rooms()
	d := viewer.Diagnostics()
	if len(rooms) != 1 || rooms[0].HostIPv4 != host.localIP.String() || d.Paths.DirectUnicast.QueriesSent != 1 || d.CrossSubnetRepliesReceived != 1 {
		t.Fatalf("direct discovery did not populate the room list and diagnostic counts: %+v", d)
	}
	viewer.SetDirectPeers(nil)
	if len(viewer.Rooms()) != 0 || viewer.observeReply(replies.writes[1].data, host.localIP, time.Now()) {
		t.Fatal("removing a peer did not immediately evict its cross-subnet room and reject in-flight replies")
	}
}

func TestHostReplyBudgetAndDeduplicationAreIndependentOfSourcePort(t *testing.T) {
	host, _, replies := memoryService()
	defer host.Close()
	host.advertisements = func() []Advertisement {
		return []Advertisement{{RoomID: "campus", Name: "校园房间", RoomCode: "ABCD2345", Port: 45678, Members: 1}}
	}
	query := func(ip string, port, serial int) {
		data, _ := json.Marshal(packet{Service: ServiceName, Version: WireVersion, Kind: "query", QueryID: fmt.Sprintf("%032x", serial)})
		host.handleQuery(data, &net.UDPAddr{IP: net.ParseIP(ip), Port: port}, host.localIP)
	}
	query("8.8.8.8", 50001, 99)
	query("127.0.0.1", 50001, 99)
	for i := 0; i < maxRepliesPerSecond+5; i++ {
		query("10.25.2.10", 50001+i, i)
	}
	if len(replies.writes) != 1 {
		t.Fatal("switching UDP ports bypassed the per-IP limit or unsafe sources got a reply")
	}
	host.lastQueryByIP[netip.MustParseAddr("10.25.2.10")] = time.Now().Add(-time.Second)
	query("10.25.2.10", 55000, 0)
	if len(replies.writes) != 1 {
		t.Fatal("same query ID got another reply after the per-IP cooldown")
	}
	for i := 1; i <= maxRepliesPerSecond+5; i++ {
		query(fmt.Sprintf("172.22.1.%d", i), 50001, 0)
	}
	if len(replies.writes) != maxRepliesPerSecond {
		t.Fatalf("multi-source traffic bypassed the global reply budget: %d", len(replies.writes))
	}
	now := time.Now()
	if host.reserveReply(now) || !host.reserveReply(now.Add(time.Second)) {
		t.Fatal("global reply budget did not recover after one second")
	}
}

func TestWindowsDiscoveryWithRealUDPSockets(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows Winsock integration")
	}
	ip := socketTestPrivateIPv4(t)
	ad := Advertisement{RoomID: "winsock", Name: "本机测试", RoomCode: "ABCD2345", Port: 45678, Members: 1}
	advertise := func() []Advertisement { return []Advertisement{ad} }
	service, err := Start(context.Background(), ip.String(), advertise)
	if ErrorCode(err) == "DISCOVERY_PORT_IN_USE" {
		// Other Go packages can run server tests in parallel and own 49877.
		service, err = start(context.Background(), ip.String(), advertise, 0)
	}
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("using real UDP sockets on %s:%d", ip, service.port)
	defer service.Close()

	waitForBroadcast := func(count uint64, timeout time.Duration) Diagnostics {
		t.Helper()
		deadline := time.Now().Add(timeout)
		for {
			d := service.Diagnostics()
			if d.Paths.LimitedBroadcast.QueriesSent >= count {
				return d
			}
			if !d.Running || time.Now().After(deadline) {
				t.Fatalf("limited broadcast did not reach the actual Windows socket: %+v", d)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	d := waitForBroadcast(1, time.Second)
	service.SetDirectPeers([]string{ip.String(), "8.8.8.8", "127.0.0.1"})
	if service.Diagnostics().DirectPeers != 0 {
		t.Fatal("the local address or invalid targets escaped the peer filter")
	}
	if !service.Refresh() {
		t.Fatal("first refresh was not queued")
	}
	d = waitForBroadcast(d.Paths.LimitedBroadcast.QueriesSent+1, time.Second)
	for i := 0; i < 20; i++ {
		service.Refresh()
	}
	time.Sleep(150 * time.Millisecond)
	if got := service.Diagnostics().Paths.LimitedBroadcast.QueriesSent; got != d.Paths.LimitedBroadcast.QueriesSent {
		t.Fatal("repeated refreshes bypassed the cooldown")
	}
	waitForBroadcast(d.Paths.LimitedBroadcast.QueriesSent+1, time.Second)

	// An independent, real private-IPv4 socket acts as the viewer and uses
	// unicast only, so multicast and broadcast cannot produce the reply.
	viewer, err := net.ListenUDP("udp4", net.UDPAddrFromAddrPort(netip.AddrPortFrom(ip, 0)))
	if err != nil {
		t.Fatal(err)
	}
	defer viewer.Close()
	if err := viewer.SetDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	const id = "0123456789abcdef0123456789abcdef"
	query, _ := json.Marshal(packet{Service: ServiceName, Version: WireVersion, Kind: "query", QueryID: id})
	before := service.Diagnostics()
	if _, err = viewer.WriteToUDP(query, net.UDPAddrFromAddrPort(netip.AddrPortFrom(ip, uint16(service.port)))); err != nil {
		t.Fatal(err)
	}
	buffer := make([]byte, maxPacketBytes)
	n, source, err := viewer.ReadFromUDP(buffer)
	if err != nil {
		t.Fatal(err)
	}
	response, err := decodePacket(buffer[:n])
	if err != nil || response.Kind != "room" || response.QueryID != id || *response.Room != ad || source.AddrPort().Addr().Unmap() != ip {
		t.Fatalf("unicast exchange did not return a matching room from %s: %v", ip, err)
	}
	deadline := time.Now().Add(time.Second)
	for {
		d := service.Diagnostics()
		if d.Paths.DirectUnicast.QueriesReceived > before.Paths.DirectUnicast.QueriesReceived && d.RepliesSent > before.RepliesSent {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("actual unicast did not update diagnostics: %+v", d)
		}
		time.Sleep(10 * time.Millisecond)
	}
	service.Close()
	if service.Refresh() || service.Diagnostics().Running {
		t.Fatal("closed service still accepted refresh")
	}
}

func socketTestPrivateIPv4(t *testing.T) netip.Addr {
	t.Helper()
	addresses, err := net.InterfaceAddrs()
	if err != nil {
		t.Fatal(err)
	}
	for _, address := range addresses {
		prefix, err := netip.ParsePrefix(address.String())
		if err == nil && subnetBroadcast(prefix).IsValid() {
			return prefix.Addr()
		}
	}
	t.Skip("no private IPv4 interface with broadcast")
	return netip.Addr{}
}
