package signal

import (
	"context"
	"encoding/json"
	"sync"
	"testing"

	"lan-screen-sharing/internal/protocol"
	"lan-screen-sharing/internal/room"
)

// Uses only in-memory connections; never starts a TCP listener or browser.
func TestMemberPresentationUsesAuthenticatedSessionAndPreservesState(t *testing.T) {
	manager := room.NewManager()
	initial, _, _ := manager.CreateHost()
	defer manager.EndAll()
	one, _, _ := manager.Join(initial.Code, "")
	two, _, _ := manager.Join(initial.Code, "")
	hub := NewHub(manager)
	var mu sync.Mutex
	var events []protocol.Envelope
	writer := func(_ context.Context, data []byte) error {
		var e protocol.Envelope
		if err := protocol.Decode(data, &e); err != nil {
			t.Errorf("invalid output: %v", err)
			return err
		}
		mu.Lock()
		events = append(events, e)
		mu.Unlock()
		return nil
	}
	first := &session{role: protocol.RoleViewer, roomID: initial.ID, peerID: one.PeerID, conn: &Connection{write: writer}}
	second := &session{role: protocol.RoleViewer, roomID: initial.ID, peerID: two.PeerID, conn: &Connection{write: writer}}
	hub.register(first)
	hub.register(second)
	claim := protocol.Envelope{V: 1, Type: "share.claim", RequestID: "claim", RoomID: initial.ID, PeerID: "forged-other-peer", Payload: raw(map[string]any{})}
	hub.handlePresentation(context.Background(), first, claim)
	state, _ := manager.Get(initial.ID)
	if state.PresenterPeerID != one.PeerID {
		t.Fatal("client forged the presenter identity")
	}
	hub.handlePresentation(context.Background(), second, claim)
	mu.Lock()
	last := events[len(events)-1]
	mu.Unlock()
	var failure struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(last.Payload, &failure)
	if last.Type != "error" || failure.Code != "SHARE_BUSY" {
		t.Fatalf("competing share: %+v", last)
	}
	hub.handlePresentation(context.Background(), first, protocol.Envelope{V: 1, Type: "media.state", RequestID: "active", Payload: raw(map[string]any{"screenSharing": true, "hasScreenVideo": true, "hasSystemAudio": true, "isolationStatus": "browser_reported"})})
	state, _ = manager.Get(initial.ID)
	if !state.ScreenSharing || !state.HasSystemAudio {
		t.Fatal("member state not stored")
	}
	hub.sendCurrentRoomState(initial.ID, "roster-refresh")
	mu.Lock()
	last = events[len(events)-1]
	mu.Unlock()
	var public struct {
		Presenter string `json:"presenterPeerId"`
		Sharing   bool   `json:"screenSharing"`
	}
	_ = json.Unmarshal(last.Payload, &public)
	if public.Presenter != one.PeerID || !public.Sharing {
		t.Fatal("roster update reset active presentation")
	}
	hub.handlePresentation(context.Background(), second, protocol.Envelope{V: 1, Type: "share.release", RequestID: "forged-release", Payload: raw(map[string]any{})})
	state, _ = manager.Get(initial.ID)
	if state.PresenterPeerID != one.PeerID {
		t.Fatal("non-presenter stopped another member")
	}
	hub.handlePresentation(context.Background(), first, protocol.Envelope{V: 1, Type: "media.state", RequestID: "stop", Payload: raw(map[string]any{"screenSharing": false, "hasScreenVideo": false, "hasSystemAudio": false, "isolationStatus": "unverified"})})
	state, _ = manager.Get(initial.ID)
	if state.PresenterPeerID != "" || len(state.Members) != 3 {
		t.Fatal("stop did not keep the voice room with an empty presentation slot")
	}
}
