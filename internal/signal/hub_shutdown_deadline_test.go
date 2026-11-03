package signal

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"lan-screen-sharing/internal/room"
)

func TestHubShutdownUsesOneDeadlineAcrossRoomsAndViewerLeaves(t *testing.T) {
	manager := room.NewManager()
	h := NewHub(manager)
	var roomAWrites atomic.Int32
	var roomBWrites atomic.Int32
	var bridgeAWrites atomic.Int32
	var bridgeBWrites atomic.Int32
	blockWrite := func(counter *atomic.Int32) func(context.Context, []byte) error {
		return func(ctx context.Context, _ []byte) error {
			counter.Add(1)
			<-ctx.Done()
			return ctx.Err()
		}
	}
	roomA := &Connection{write: blockWrite(&roomAWrites), closeNow: func() {}}
	roomB := &Connection{write: blockWrite(&roomBWrites), closeNow: func() {}}
	bridgeA := &Connection{write: blockWrite(&bridgeAWrites), closeNow: func() {}}
	bridgeB := &Connection{write: blockWrite(&bridgeBWrites), closeNow: func() {}}
	h.connections[connKey("room-a", "host-a")] = roomA
	h.connections[connKey("room-b", "host-b")] = roomB
	viewerA := &session{role: "viewer", roomID: "remote-a", peerID: "viewer-a", conn: &Connection{closeNow: func() {}}, bridge: bridgeA}
	viewerB := &session{role: "viewer", roomID: "remote-b", peerID: "viewer-b", conn: &Connection{closeNow: func() {}}, bridge: bridgeB}
	h.sessions[viewerA] = struct{}{}
	h.sessions[viewerB] = struct{}{}

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Millisecond)
	defer cancel()
	started := time.Now()
	h.Shutdown(ctx)
	elapsed := time.Since(started)
	if elapsed > 350*time.Millisecond {
		t.Fatalf("shutdown extended its shared deadline across sessions: elapsed %s", elapsed)
	}
	if roomAWrites.Load() == 0 || roomBWrites.Load() == 0 {
		t.Fatalf("shutdown did not attempt terminal delivery to every room: room-a=%d room-b=%d", roomAWrites.Load(), roomBWrites.Load())
	}
	if bridgeAWrites.Load() == 0 || bridgeBWrites.Load() == 0 {
		t.Fatalf("shutdown did not attempt viewer bridge leave for every session: bridge-a=%d bridge-b=%d", bridgeAWrites.Load(), bridgeBWrites.Load())
	}
}
