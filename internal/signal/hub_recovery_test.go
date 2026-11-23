package signal

import (
	"context"
	"testing"

	"lan-screen-sharing/internal/protocol"
	"lan-screen-sharing/internal/room"
)

func recoveryTestConnection() *Connection {
	return &Connection{write: func(context.Context, []byte) error { return nil }, close: func() {}, closeNow: func() {}}
}

func TestHostResumeIgnoresLateCloseFromTheReplacedSocket(t *testing.T) {
	manager := room.NewManager()
	snap, _, _ := manager.CreateHost()
	h := NewHub(manager)
	old := &session{role: protocol.RoleHost, roomID: snap.ID, peerID: hostPeer(snap), conn: recoveryTestConnection()}
	h.register(old)
	next := &session{role: protocol.RoleHost, conn: recoveryTestConnection()}
	restored, err := h.resumeLocalHost(next, snap.ID)
	if err != nil || restored.Code != snap.Code {
		t.Fatalf("resume: %#v %v", restored, err)
	}
	h.disconnect(old)
	if !h.ownsConnection(next) {
		t.Fatal("stale socket removed the new connection")
	}
	current, ok := manager.Get(snap.ID)
	if !ok || current.Members[0].State != "connected" {
		t.Fatalf("stale close ended or disconnected the room: %#v", current)
	}
	h.disconnect(next)
	current, ok = manager.Get(snap.ID)
	if !ok || current.Members[0].State != "reconnecting" {
		t.Fatalf("unexpected close must retain the room: %#v", current)
	}
}

func TestViewerTakeoverIgnoresLateDisconnectFromTheOldTransport(t *testing.T) {
	manager := room.NewManager()
	snap, _, _ := manager.CreateHost()
	h := NewHub(manager)
	peer, _, old, err := h.joinViewerAndRegister(context.Background(), recoveryTestConnection(), protocol.SignalJoinPayload{RoomCode: snap.Code}, func() {})
	if err != nil {
		t.Fatal(err)
	}
	nextPeer, _, next, err := h.joinViewerAndRegister(context.Background(), recoveryTestConnection(), protocol.SignalJoinPayload{RoomCode: snap.Code, ResumeToken: peer.ResumeToken}, func() {})
	if err != nil || nextPeer.PeerID != peer.PeerID {
		t.Fatalf("takeover: %#v %v", nextPeer, err)
	}
	if h.detachPeer(old) {
		t.Fatal("old transport disconnected the resumed member")
	}
	if !h.ownsConnection(next) {
		t.Fatal("resumed member lost its transport")
	}
	h.handleProfile(context.Background(), next, event("peer.profile", "new-profile", snap.ID, "", protocol.Profile{Nickname: "新连接", AvatarColor: "green"}))
	h.handleProfile(context.Background(), old, event("peer.profile", "stale-profile", snap.ID, "", protocol.Profile{Nickname: "过期连接", AvatarColor: "pink"}))
	current, _ := manager.Get(snap.ID)
	for _, member := range current.Members {
		if member.PeerID == peer.PeerID && (member.State != "connected" || member.Nickname != "新连接" || member.AvatarColor != "green") {
			t.Fatalf("old connection affected resumed member: %+v", member)
		}
	}
}
