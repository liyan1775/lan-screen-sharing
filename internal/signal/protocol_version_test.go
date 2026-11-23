package signal

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"lan-screen-sharing/internal/protocol"
	"lan-screen-sharing/internal/room"
)

func TestOldLANClientReceivesVersionErrorAndCannotJoin(t *testing.T) {
	manager := room.NewManager()
	snapshot, _, err := manager.CreateHost()
	if err != nil {
		t.Fatal(err)
	}
	h := NewHub(manager)
	hostEvents := make(chan []byte, 1)
	h.register(&session{roomID: snapshot.ID, peerID: hostPeer(snapshot), conn: &Connection{write: func(_ context.Context, data []byte) error {
		hostEvents <- data
		return nil
	}}})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := Accept(w, r)
		if err == nil {
			h.ServeLAN(r.Context(), conn)
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	old, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer old.CloseNow()
	legacyJoin := event("signal.join", "old-join", "", "", map[string]string{"roomCode": snapshot.Code})
	if err := old.Write(ctx, websocket.MessageText, mustJSON(legacyJoin)); err != nil {
		t.Fatal(err)
	}
	_, viewerEvent, err := old.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var hostEvent []byte
	select {
	case hostEvent = <-hostEvents:
	case <-ctx.Done():
		t.Fatal("host did not receive version guidance")
	}
	for _, data := range [][]byte{viewerEvent, hostEvent} {
		var response protocol.Envelope
		var payload struct{ Code, Message string }
		if protocol.Decode(data, &response) != nil || json.Unmarshal(response.Payload, &payload) != nil || payload.Code != "UNSUPPORTED_PROTOCOL" || payload.Message != incompatibleVersion {
			t.Fatalf("unexpected version guidance: %s", data)
		}
	}
	if current, _ := manager.Get(snapshot.ID); len(current.Members) != 1 {
		t.Fatalf("incompatible peer reserved a room seat: %+v", current.Members)
	}
}

func TestNewLANBridgeDetectsOldHostBeforeSendingRoomCredentials(t *testing.T) {
	oldHost := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err == nil {
			_, _, err = conn.Read(r.Context())
			if err == nil {
				t.Error("client sent an invitation to an incompatible host")
			}
			_ = conn.CloseNow()
		}
	}))
	defer oldHost.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := Dial(ctx, "ws"+strings.TrimPrefix(oldHost.URL, "http")); !errors.Is(err, errIncompatibleVersion) {
		t.Fatalf("older host did not yield the explicit version error: %v", err)
	}
}
