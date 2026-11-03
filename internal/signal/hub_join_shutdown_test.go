package signal

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"lan-screen-sharing/internal/protocol"
	"lan-screen-sharing/internal/room"
)

func TestShutdownFirstRejectsLANJoinWithoutReservingSeat(t *testing.T) {
	manager := room.NewManager()
	h := NewHub(manager)
	host, _, err := manager.CreateHost()
	if err != nil {
		t.Fatal(err)
	}
	hostConn := &Connection{write: func(context.Context, []byte) error { return nil }, closeNow: func() {}}
	h.register(&session{role: protocol.RoleHost, roomID: host.ID, peerID: "host", conn: hostConn})
	plan, ok := h.beginShutdown()
	if !ok {
		t.Fatal("shutdown did not establish the join barrier")
	}

	viewerConn := &Connection{write: func(context.Context, []byte) error { return nil }, closeNow: func() {}}
	_, _, _, joinErr := h.joinViewerAndRegister(viewerConn, host.Code, "", func() {})
	if !errors.Is(joinErr, errHubShuttingDown) {
		t.Fatalf("shutdown-first LAN join was not rejected at the lifecycle barrier: %v", joinErr)
	}
	if snapshot, exists := manager.Get(host.ID); !exists || len(snapshot.Members) != 1 {
		t.Fatalf("shutdown-first join reserved a viewer seat: %#v", snapshot)
	}
	h.finishShutdown(context.Background(), plan)
}

func TestJoinFirstPendingHandshakeIsCoveredByTerminalShutdownSnapshot(t *testing.T) {
	manager := room.NewManager()
	h := NewHub(manager)
	host, _, err := manager.CreateHost()
	if err != nil {
		t.Fatal(err)
	}
	type writeRecord struct {
		typ string
	}
	var writesMu sync.Mutex
	var writes []writeRecord
	var closed bool
	viewerConn := &Connection{
		write: func(_ context.Context, data []byte) error {
			var envelope protocol.Envelope
			if err := protocol.Decode(data, &envelope); err != nil {
				return err
			}
			writesMu.Lock()
			writes = append(writes, writeRecord{typ: envelope.Type})
			writesMu.Unlock()
			return nil
		},
		closeNow: func() { writesMu.Lock(); closed = true; writesMu.Unlock() },
	}
	hostConn := &Connection{write: func(context.Context, []byte) error { return nil }, closeNow: func() {}}
	h.register(&session{role: protocol.RoleHost, roomID: host.ID, peerID: "host", conn: hostConn})
	peerSession, snapshot, viewer, err := h.joinViewerAndRegister(viewerConn, host.Code, "", func() {})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Members) != 2 || viewer.roomID != host.ID || viewer.peerID != peerSession.PeerID {
		t.Fatalf("join-first registration was incomplete: snapshot=%#v viewer=%#v", snapshot, viewer)
	}

	plan, ok := h.beginShutdown()
	if !ok {
		t.Fatal("shutdown did not establish after the successful join")
	}
	if len(plan.pendingJoins) != 1 || plan.pendingJoins[0].conn != viewerConn {
		t.Fatalf("shutdown snapshot missed the pending joined socket: %#v", plan.pendingJoins)
	}
	joined := event("room.joined", "join", host.ID, peerSession.PeerID, map[string]any{"roomId": host.ID, "peerId": peerSession.PeerID, "resumeToken": peerSession.ResumeToken, "members": snapshot.Members})
	if err = h.writeEnvelope(context.Background(), viewerConn, joined); err != nil {
		t.Fatal(err)
	}
	h.acknowledgeViewerJoin(viewerConn)
	h.completeViewerJoin(viewerConn)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	h.finishShutdown(ctx, plan)

	writesMu.Lock()
	defer writesMu.Unlock()
	if len(writes) != 2 || writes[0].typ != "room.joined" || writes[1].typ != "room.ended" {
		serialized, _ := json.Marshal(writes)
		t.Fatalf("join success did not precede terminal shutdown: %s", serialized)
	}
	if !closed {
		t.Fatal("joined connection was not closed after its terminal event")
	}
}
