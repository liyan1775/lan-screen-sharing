package discovery

import (
	"context"
	"encoding/json"
	"net"
	"net/netip"
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
	return &Service{cache: NewCache(prefix, time.Now), receiver: receiver, sender: sender, destinations: queryDestinations(prefix, true), advertisements: func() []Advertisement { return nil }, cancel: func() {}, queries: map[string]time.Time{}, replied: map[string]time.Time{}, diagnostics: Diagnostics{Running: true}}, receiver, sender
}

func TestBroadcastCompletesDiscoveryWhenMulticastPacketsAreDropped(t *testing.T) {
	viewer, _, outgoing := memoryService()
	defer viewer.Close()
	viewer.query()
	if len(outgoing.writes) != 2 || outgoing.writes[0].address.String() != "239.255.77.77:49877" || outgoing.writes[1].address.String() != "192.168.1.255:49877" {
		t.Fatal("query did not use bounded multicast and subnet broadcast")
	}
	host, _, replies := memoryService()
	defer host.Close()
	host.advertisements = func() []Advertisement {
		return []Advertisement{{RoomID: "friends", Name: "一起玩", RoomCode: "ABCD2345", Port: 45678, Members: 1}}
	}
	querySource := &net.UDPAddr{IP: net.ParseIP("192.168.1.20"), Port: 50000}
	// Drop the multicast packet entirely; deliver only the broadcast fallback.
	host.handleQuery(outgoing.writes[1].data, querySource)
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
	host.handleQuery(outgoing.writes[0].data, querySource)
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
	if len(targets) != 1 || targets[0].String() != "10.208.191.255:49877" {
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
