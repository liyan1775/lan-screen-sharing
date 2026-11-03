package room

import (
	"strings"
	"testing"
	"time"
)

func TestRoomCapacityAndThirdViewerRejected(t *testing.T) {
	m := NewManager()
	r, _, err := m.CreateHost()
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Code) != 8 {
		t.Fatalf("room code length = %d", len(r.Code))
	}
	for i := 0; i < 2; i++ {
		if _, _, err = m.Join(r.Code, ""); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err = m.Join(r.Code, ""); err == nil || !strings.Contains(err.Error(), "ROOM_FULL") {
		t.Fatalf("third viewer: %v", err)
	}
}
func TestReconnectKeepsPeerIDAndReclaimsSeat(t *testing.T) {
	m := NewManager()
	r, _, _ := m.CreateHost()
	p, _, err := m.Join(r.Code, "")
	if err != nil {
		t.Fatal(err)
	}
	m.Disconnect(r.ID, p.PeerID)
	p2, _, err := m.Join(r.Code, p.ResumeToken)
	if err != nil {
		t.Fatal(err)
	}
	if p2.PeerID != p.PeerID {
		t.Fatalf("peer changed %s -> %s", p.PeerID, p2.PeerID)
	}
	if _, _, err := m.Join(r.Code, p.ResumeToken); err == nil || !strings.Contains(err.Error(), "INVALID_INVITE") {
		t.Fatal("rotated resume token was reusable")
	}
}

func TestDisconnectedSeatExpiresAfterTwentySeconds(t *testing.T) {
	now := time.Unix(100, 0)
	m := NewManager(WithClock(func() time.Time { return now }))
	r, _, _ := m.CreateHost()
	p, _, _ := m.Join(r.Code, "")
	m.Disconnect(r.ID, p.PeerID)
	now = now.Add(21 * time.Second)
	m.SetClock(func() time.Time { return now })
	m.ExpireDisconnected(r.ID, p.PeerID)
	if _, _, err := m.Join(r.Code, p.ResumeToken); err == nil || !strings.Contains(err.Error(), "INVALID_INVITE") {
		t.Fatalf("expired resume token: %v", err)
	}
	if _, _, err := m.Join(r.Code, ""); err != nil {
		t.Fatalf("expired seat was not reclaimed: %v", err)
	}
}
func TestLeaveAndEndInvalidateCredentials(t *testing.T) {
	m := NewManager()
	r, cred, _ := m.CreateHost()
	p, _, _ := m.Join(r.Code, "")
	m.Leave(r.ID, p.PeerID)
	if _, _, err := m.Join(r.Code, p.ResumeToken); err == nil {
		t.Fatal("left viewer credential still accepted")
	}
	m.End(r.ID)
	if m.AuthenticateHost(cred.Token) {
		t.Fatal("host credential survived end")
	}
}
func TestExpiredRoomCodeRejected(t *testing.T) {
	clock := func() time.Time { return time.Unix(100, 0) }
	m := NewManager(WithClock(clock), WithRoomTTL(time.Second))
	r, _, _ := m.CreateHost()
	m.SetClock(func() time.Time { return time.Unix(102, 0) })
	if _, _, err := m.Join(r.Code, ""); err == nil || !strings.Contains(err.Error(), "ROOM_EXPIRED") {
		t.Fatalf("expired room join: %v", err)
	}
}

func TestRoomExpiryCleansUpWithoutAnotherJoin(t *testing.T) {
	m := NewManager(WithRoomTTL(30 * time.Millisecond))
	expired := make(chan RoomSnapshot, 1)
	m.SetExpirationHandler(func(r RoomSnapshot) { expired <- r })
	r, _, _ := m.CreateHost()
	deadline := time.Now().Add(time.Second)
	for {
		if _, ok := m.Get(r.ID); !ok {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("room remained after expiry")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if _, _, err := m.Join(r.Code, ""); err == nil || !strings.Contains(err.Error(), "ROOM_EXPIRED") {
		t.Fatalf("expired invite result: %v", err)
	}
	select {
	case got := <-expired:
		if got.ID != r.ID || got.Code != r.Code {
			t.Fatalf("expiration callback payload: %#v", got)
		}
	case <-time.After(time.Second):
		t.Fatal("room expiry was not published")
	}
}
