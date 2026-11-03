package signal

import (
	"context"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"lan-screen-sharing/internal/protocol"
	"lan-screen-sharing/internal/room"
)

func TestServeLANShutdownAfterJoinAckStillDeliversTerminalToNewViewer(t *testing.T) {
	ip := privateIPv4ForTest(t)
	manager := room.NewManager()
	host, _, err := manager.CreateHost()
	if err != nil {
		t.Fatal(err)
	}
	oldPeer, _, err := manager.Join(host.Code, "")
	if err != nil {
		t.Fatal(err)
	}
	h := NewHub(manager)
	h.register(&session{role: protocol.RoleHost, roomID: host.ID, peerID: "host-peer", conn: &Connection{write: func(context.Context, []byte) error { return nil }, close: func() {}, closeNow: func() {}}})
	oldPeerBlocked := make(chan struct{})
	var blockOnce sync.Once
	oldConn := &Connection{
		write: func(ctx context.Context, data []byte) error {
			var envelope protocol.Envelope
			if protocol.Decode(data, &envelope) != nil {
				return nil
			}
			if envelope.Type == "peer.joined" || envelope.Type == "room.state" {
				blockOnce.Do(func() { close(oldPeerBlocked) })
				<-ctx.Done()
				return ctx.Err()
			}
			return nil
		},
		close:    func() {},
		closeNow: func() {},
	}
	h.register(&session{role: protocol.RoleViewer, roomID: host.ID, peerID: oldPeer.PeerID, conn: oldConn})

	joinEnvelope := protocol.Envelope{V: 1, Type: "signal.join", RequestID: "incoming-join", Payload: raw(map[string]any{"roomCode": host.Code})}
	joinBytes := mustJSON(joinEnvelope)
	var readOnce sync.Once
	acknowledged := make(chan struct{})
	var messagesMu sync.Mutex
	var messages []string
	newConn := &Connection{
		remoteAddr: net.JoinHostPort(ip, "45678"),
		read: func(ctx context.Context) ([]byte, error) {
			first := false
			readOnce.Do(func() { first = true })
			if first {
				return joinBytes, nil
			}
			<-ctx.Done()
			return nil, ctx.Err()
		},
		write: func(_ context.Context, data []byte) error {
			var envelope protocol.Envelope
			if err := protocol.Decode(data, &envelope); err != nil {
				return err
			}
			messagesMu.Lock()
			messages = append(messages, envelope.Type)
			messagesMu.Unlock()
			if envelope.Type == "room.joined" {
				close(acknowledged)
			}
			return nil
		},
		close:    func() {},
		closeNow: func() {},
	}
	serveCtx, cancelServe := context.WithCancel(context.Background())
	serveDone := make(chan struct{})
	go func() {
		defer close(serveDone)
		h.ServeLAN(serveCtx, newConn)
	}()
	defer func() { cancelServe(); <-serveDone }()

	select {
	case <-acknowledged:
	case <-time.After(time.Second):
		t.Fatal("ServeLAN did not deliver room.joined")
	}
	select {
	case <-oldPeerBlocked:
	case <-time.After(time.Second):
		t.Fatal("old peer writer did not block the post-ACK join fanout")
	}

	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 120*time.Millisecond)
	h.Shutdown(shutdownCtx)
	cancelShutdown()
	cancelServe()
	<-serveDone

	messagesMu.Lock()
	defer messagesMu.Unlock()
	joinedAt, endedAt := -1, -1
	for index, typ := range messages {
		if typ == "room.joined" {
			joinedAt = index
		}
		if typ == "room.ended" {
			endedAt = index
		}
	}
	if joinedAt < 0 {
		t.Fatalf("test failed to observe join acknowledgment: %s", strings.Join(messages, ","))
	}
	if endedAt <= joinedAt {
		t.Fatalf("shutdown omitted room.ended after an acknowledged ServeLAN join: %s", strings.Join(messages, ","))
	}
}
