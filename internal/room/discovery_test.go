package room

import (
	"testing"
	"time"
)

func TestOnlyExplicitlyDiscoverableLiveRoomsAreListed(t *testing.T) {
	m := NewManager()
	defer m.EndAll()
	public, _, err := m.CreateHostWithOptions("一起玩", true)
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = m.CreateHostWithOptions("指定朋友", false)
	if err != nil {
		t.Fatal(err)
	}
	list := m.DiscoverableRooms()
	if len(list) != 1 || list[0].ID != public.ID || list[0].Name != "一起玩" {
		t.Fatal("private room was advertised")
	}
	m.End(public.ID)
	if len(m.DiscoverableRooms()) != 0 {
		t.Fatal("ended room was advertised")
	}
	_, _, _ = m.CreateHostWithOptions("过期房间", true)
	m.SetClock(func() time.Time { return time.Now().Add(3 * time.Hour) })
	if len(m.DiscoverableRooms()) != 0 {
		t.Fatal("expired room was advertised")
	}
}
func TestInvalidRoomNamesAreRejectedWithoutCreatingARoom(t *testing.T) {
	m := NewManager()
	defer m.EndAll()
	if _, _, err := m.CreateHostWithOptions("name\nname", true); err == nil {
		t.Fatal("multiline room name accepted")
	}
	if len(m.DiscoverableRooms()) != 0 {
		t.Fatal("invalid room got created")
	}
}
