package app

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"lan-screen-sharing/internal/protocol"
)

func TestLongRunningRoomKeepsSharingAndHostCanRefreshOverWebSocket(t *testing.T) {
	ip := firstPrivateIPv4()
	if ip == "" {
		t.Skip("no private IPv4 available")
	}
	s := New(Config{LANIPv4: ip})
	started := time.Now()
	s.rooms.SetClock(func() time.Time { return started })
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() { cancel(); _ = s.Shutdown(context.Background()) })
	local, err := s.Start(ctx)
	if err != nil {
		t.Fatal(err)
	}
	address := local.Addr().String()
	host := dialAppLocal(t, "ws://"+address+"/ws/v1", "http://"+address)
	defer host.CloseNow()
	writeEnvelope(t, host, protocol.Envelope{V: 1, Type: "auth.hello", RequestID: "auth", Payload: rawPayload(map[string]any{"role": "host", "hostToken": s.hostToken})})
	readType(t, host, "room.state")
	writeEnvelope(t, host, protocol.Envelope{V: 1, Type: "host.createRoom", RequestID: "create", Payload: rawPayload(map[string]any{})})
	created := readType(t, host, "room.created")
	var invite map[string]json.RawMessage
	if err = json.Unmarshal(created.Payload, &invite); err != nil {
		t.Fatal(err)
	}
	if _, present := invite["expiresAt"]; present {
		t.Fatalf("default room announced a fixed expiry: %s", created.Payload)
	}
	var roomCode string
	if err = json.Unmarshal(invite["roomCode"], &roomCode); err != nil {
		t.Fatal(err)
	}
	readType(t, host, "room.state")
	writeEnvelope(t, host, protocol.Envelope{V: 1, Type: "share.claim", RequestID: "claim", RoomID: created.RoomID, Payload: rawPayload(map[string]any{})})
	readType(t, host, "room.state")

	s.rooms.SetClock(func() time.Time { return started.Add(3 * time.Hour) })
	writeEnvelope(t, host, protocol.Envelope{V: 1, Type: "media.state", RequestID: "still-sharing", RoomID: created.RoomID, Payload: rawPayload(map[string]any{"screenSharing": true, "hasScreenVideo": true, "hasSystemAudio": true, "isolationStatus": "browser_reported"})})
	sharing := readUntilOptions(t, host, "room.state", "error", "room.ended")
	if sharing.Type != "room.state" {
		t.Fatalf("long-running sharing ended: %#v", sharing)
	}
	_ = host.CloseNow()

	refreshed := dialAppLocal(t, "ws://"+address+"/ws/v1", "http://"+address)
	defer refreshed.CloseNow()
	writeEnvelope(t, refreshed, protocol.Envelope{V: 1, Type: "auth.hello", RequestID: "refresh", Payload: rawPayload(map[string]any{"role": "host", "hostToken": s.hostToken, "roomId": created.RoomID})})
	resumed := readUntilOptions(t, refreshed, "room.state", "error")
	var state struct {
		Resumed         bool   `json:"resumed"`
		RoomCode        string `json:"roomCode"`
		ScreenSharing   bool   `json:"screenSharing"`
		HasSystemAudio  bool   `json:"hasSystemAudio"`
		PresenterPeerID string `json:"presenterPeerId"`
	}
	if err = json.Unmarshal(resumed.Payload, &state); err != nil {
		t.Fatal(err)
	}
	if resumed.Type != "room.state" || resumed.RoomID != created.RoomID || resumed.PeerID != created.PeerID || !state.Resumed || state.RoomCode != roomCode || !state.ScreenSharing || !state.HasSystemAudio || state.PresenterPeerID != created.PeerID {
		t.Fatalf("refresh lost the long-running room or sharing: %#v %#v", resumed, state)
	}
	writeEnvelope(t, refreshed, protocol.Envelope{V: 1, Type: "host.endRoom", RequestID: "end", RoomID: created.RoomID, Payload: rawPayload(map[string]any{})})
	ended := readUntilType(t, refreshed, "room.ended")
	if ended.RoomID != created.RoomID {
		t.Fatalf("explicit end targeted another room: %#v", ended)
	}
}
