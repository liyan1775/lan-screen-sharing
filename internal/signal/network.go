package signal

import (
	"errors"
	"time"

	"lan-screen-sharing/internal/room"
)

var ErrNetworkBusy = errors.New("room or recovery is active")

type viewerNetworkUse struct {
	roomID, peerID string
	bridge         *Connection
	recoverUntil   time.Time
}

// WithIdleNetwork serializes the network change with room creation, incoming
// joins and the reservation made before an outbound join starts dialing.
func (h *Hub) WithIdleNetwork(change func() error) error {
	h.lifecycleMu.Lock()
	defer h.lifecycleMu.Unlock()
	if h.shuttingDown {
		return errHubShuttingDown
	}
	if h.rooms.HasActiveRooms() || h.viewerJoining != 0 {
		return ErrNetworkBusy
	}
	now := time.Now()
	for s, use := range h.viewerNetwork {
		if use.recoverUntil.IsZero() || now.Before(use.recoverUntil) {
			return ErrNetworkBusy
		}
		delete(h.viewerNetwork, s)
	}
	return change()
}

func (h *Hub) beginViewerDial() bool {
	h.lifecycleMu.Lock()
	defer h.lifecycleMu.Unlock()
	if h.shuttingDown {
		return false
	}
	h.viewerJoining++
	return true
}

func (h *Hub) finishViewerDial() {
	h.lifecycleMu.Lock()
	defer h.lifecycleMu.Unlock()
	h.viewerJoining--
}

func (h *Hub) setViewerNetwork(s *session, bridge *Connection) {
	h.lifecycleMu.Lock()
	defer h.lifecycleMu.Unlock()
	for previous, use := range h.viewerNetwork {
		if use.roomID == s.roomID && use.peerID == s.peerID {
			delete(h.viewerNetwork, previous)
		}
	}
	h.viewerNetwork[s] = viewerNetworkUse{roomID: s.roomID, peerID: s.peerID, bridge: bridge}
}

func (h *Hub) clearViewerNetwork(s *session, bridge *Connection) {
	h.lifecycleMu.Lock()
	defer h.lifecycleMu.Unlock()
	if use, ok := h.viewerNetwork[s]; ok && (bridge == nil || use.bridge == bridge) {
		delete(h.viewerNetwork, s)
	}
}

func (h *Hub) reserveViewerRecovery(s *session, bridge *Connection) {
	h.lifecycleMu.Lock()
	defer h.lifecycleMu.Unlock()
	use, ok := h.viewerNetwork[s]
	if !ok || (bridge != nil && use.bridge != bridge) || !use.recoverUntil.IsZero() {
		return
	}
	use.recoverUntil = time.Now().Add(room.ReconnectWindow)
	h.viewerNetwork[s] = use
	time.AfterFunc(room.ReconnectWindow, func() {
		h.lifecycleMu.Lock()
		defer h.lifecycleMu.Unlock()
		if h.viewerNetwork[s] == use {
			delete(h.viewerNetwork, s)
		}
	})
}
