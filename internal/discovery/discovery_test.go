package discovery

import (
	"encoding/json"
	"net/netip"
	"testing"
	"time"
)

func TestRoomCacheUsesPacketSourceAndExpiresRooms(t *testing.T) {
	now := time.Unix(100, 0)
	cache := NewCache(netip.MustParsePrefix("192.168.1.0/24"), func() time.Time { return now })
	ad := Advertisement{RoomID: "room-one", Name: "朋友的房间", RoomCode: "ABCD2345", Port: 45678, Members: 2, ScreenSharing: true}
	if !cache.Observe(ad, netip.MustParseAddr("192.168.1.25")) {
		t.Fatal("valid room rejected")
	}
	list := cache.List()
	if len(list) != 1 || list[0].HostIPv4 != "192.168.1.25" || list[0].Capacity != 3 {
		t.Fatalf("discovery result: %+v", list)
	}
	ad.Members = 3
	cache.Observe(ad, netip.MustParseAddr("192.168.1.25"))
	if len(cache.List()) != 1 || cache.List()[0].Members != 3 {
		t.Fatal("room update was duplicated or stale")
	}
	now = now.Add(RoomLifetime + time.Second)
	if len(cache.List()) != 0 {
		t.Fatal("ended/offline room stayed visible")
	}
}

func TestDiscoveryRejectsForeignTargetsMalformedInvitesAndOversizedNames(t *testing.T) {
	cache := NewCache(netip.MustParsePrefix("192.168.1.0/24"), time.Now)
	good := Advertisement{RoomID: "room-one", Name: "房间", RoomCode: "ABCD2345", Port: 45678, Members: 1}
	for _, source := range []string{"8.8.8.8", "127.0.0.1", "192.168.2.1", "224.0.0.1"} {
		if cache.Observe(good, netip.MustParseAddr(source)) {
			t.Fatal("accepted source outside selected private subnet")
		}
	}
	for _, change := range []func(*Advertisement){func(a *Advertisement) { a.Port = 0 }, func(a *Advertisement) { a.Port = 65536 }, func(a *Advertisement) { a.RoomCode = "bad" }, func(a *Advertisement) { a.Members = 4 }, func(a *Advertisement) { a.Name = "bad\nname" }} {
		a := good
		change(&a)
		if cache.Observe(a, netip.MustParseAddr("192.168.1.20")) {
			t.Fatal("invalid discovery advertisement accepted")
		}
	}
}

func TestDiscoveryWireHasNoArbitraryReplyAddressOrControlFields(t *testing.T) {
	id := "0123456789abcdef0123456789abcdef"
	data, _ := json.Marshal(packet{Service: ServiceName, Version: WireVersion, Kind: "query", QueryID: id})
	if _, err := decodePacket(data); err != nil {
		t.Fatal(err)
	}
	for _, data := range [][]byte{[]byte(`{"service":"lan-screen-sharing","version":2,"kind":"query","queryId":"` + id + `","replyPort":80}`), []byte(`{"service":"lan-screen-sharing","version":2,"kind":"query","queryId":"` + id + `","hostControlToken":"secret"}`), []byte(`{"service":"other-app","version":2,"kind":"query","queryId":"` + id + `"}`)} {
		if _, err := decodePacket(data); err == nil {
			t.Fatal("foreign/unsafe discovery packet accepted")
		}
	}
}

func TestOnlyRecentOutstandingQueriesCanPopulateTheRoomList(t *testing.T) {
	now := time.Unix(100, 0)
	id := "0123456789abcdef0123456789abcdef"
	ad := Advertisement{RoomID: "friends", Name: "一起玩", RoomCode: "ABCD2345", Port: 45678, Members: 1}
	data, _ := json.Marshal(packet{Service: ServiceName, Version: WireVersion, Kind: "room", QueryID: id, Room: &ad})
	s := &Service{cache: NewCache(netip.MustParsePrefix("192.168.1.0/24"), func() time.Time { return now }), queries: map[string]time.Time{}}
	source := netip.MustParseAddr("192.168.1.25")
	if s.observeReply(data, source, now) || len(s.Rooms()) != 0 {
		t.Fatal("unsolicited room appeared")
	}
	s.queries[id] = now.Add(-RoomLifetime)
	if s.observeReply(data, source, now) {
		t.Fatal("expired query accepted a room")
	}
	s.queries[id] = now
	if s.observeReply(data, netip.MustParseAddr("192.168.2.25"), now) {
		t.Fatal("reply from another subnet accepted")
	}
	if !s.observeReply(data, source, now) || len(s.Rooms()) != 1 {
		t.Fatal("recent matching query did not discover the room")
	}
}
