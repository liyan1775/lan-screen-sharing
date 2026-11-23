package room

import (
	"strings"
	"testing"
	"time"

	"lan-screen-sharing/internal/protocol"
)

func TestProfileSeatsRemainStableAndReservedForThirtySeconds(t *testing.T) {
	now := time.Unix(1_000, 0)
	m := NewManager(WithClock(func() time.Time { return now }))
	host, _, err := m.CreateHostWithProfile("游戏", true, protocol.Profile{Nickname: "  " + strings.Repeat("🌙", 23), AvatarColor: "orange"})
	if err != nil || host.Members[0].Nickname != strings.Repeat("🌙", 20) {
		t.Fatalf("host profile was not truncated at twenty characters: %+v %v", host.Members, err)
	}
	first, _, err := m.JoinWithProfile(host.Code, "", protocol.Profile{Nickname: "第一位", AvatarColor: "pink"})
	if err != nil {
		t.Fatal(err)
	}
	second, full, err := m.Join(host.Code, "")
	if err != nil || full.Members[1].PeerID != first.PeerID || full.Members[2].PeerID != second.PeerID {
		t.Fatalf("seats were not assigned in entry order: %+v %v", full.Members, err)
	}
	m.Leave(host.ID, first.PeerID)
	remaining, _ := m.Get(host.ID)
	if remaining.Members[1].SeatIndex != 3 {
		t.Fatal("remaining member was renumbered after a departure")
	}
	profile, err := m.UpdateProfile(host.ID, second.PeerID, protocol.Profile{Nickname: "恢复用名字", AvatarColor: "green"})
	if err != nil {
		t.Fatal(err)
	}
	m.Disconnect(host.ID, second.PeerID)
	now = now.Add(ReconnectWindow - time.Millisecond)
	resumed, snapshot, err := m.JoinWithProfile(host.Code, second.ResumeToken, protocol.Profile{Nickname: "不覆盖"})
	if err != nil || resumed.PeerID != second.PeerID || snapshot.Members[1].SeatIndex != 3 || snapshot.Members[1].ProfileUpdate != profile {
		t.Fatalf("member did not recover the original seat and profile: %+v %v", snapshot.Members, err)
	}
	newPeer, snapshot, err := m.Join(host.Code, "")
	if err != nil || snapshot.Members[1].SeatIndex != 2 || snapshot.Members[1].PeerID != newPeer.PeerID {
		t.Fatalf("new member did not take the free seat: %+v %v", snapshot.Members, err)
	}
	m.Disconnect(host.ID, resumed.PeerID)
	now = now.Add(ReconnectWindow)
	if _, _, err := m.Join(host.Code, resumed.ResumeToken); protocol.ErrorCode(err) != "INVALID_INVITE" {
		t.Fatalf("expired resume token was accepted: %v", err)
	}
}
