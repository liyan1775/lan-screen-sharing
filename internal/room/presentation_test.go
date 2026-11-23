package room

import (
	"sync"
	"testing"
)

func TestMembersCanTakeTurnsPresentingWithoutChangingRoomOwnership(t *testing.T) {
	m := NewManager()
	initial, _, err := m.CreateHost()
	if err != nil {
		t.Fatal(err)
	}
	defer m.EndAll()
	first, _, _ := m.Join(initial.Code, "")
	second, _, _ := m.Join(initial.Code, "")
	granted, err := m.ClaimPresentation(initial.ID, first.PeerID)
	if err != nil || granted.PresenterPeerID != first.PeerID {
		t.Fatalf("member claim: %v %+v", err, granted)
	}
	if _, err := m.ClaimPresentation(initial.ID, second.PeerID); err == nil || err.Error() != "SHARE_BUSY" {
		t.Fatalf("second simultaneous claim: %v", err)
	}
	if _, err := m.ReleasePresentation(initial.ID, second.PeerID); err == nil {
		t.Fatal("another member released the presenter")
	}
	if _, err := m.UpdatePresentation(initial.ID, second.PeerID, true, true, "browser_reported"); err == nil {
		t.Fatal("non-presenter published media state")
	}
	active, err := m.UpdatePresentation(initial.ID, first.PeerID, true, true, "browser_reported")
	if err != nil || !active.ScreenSharing || !active.HasSystemAudio || !active.PresentationStarted {
		t.Fatalf("presenter update: %v", err)
	}
	current, _ := m.Get(initial.ID)
	if !current.ScreenSharing || current.PresentationStarted {
		t.Fatal("roster snapshot must keep presentation state without repeating the start event")
	}
	update, err := m.UpdatePresentation(initial.ID, first.PeerID, true, false, "unverified")
	if err != nil || update.PresentationStarted {
		t.Fatalf("routine media update repeated the start event: %v", err)
	}
	m.Leave(initial.ID, first.PeerID)
	idle, _ := m.Get(initial.ID)
	if idle.PresenterPeerID != "" || idle.ScreenSharing {
		t.Fatal("leaving member retained presentation")
	}
	next, err := m.ClaimPresentation(initial.ID, second.PeerID)
	if err != nil || next.PresenterPeerID != second.PeerID {
		t.Fatalf("next member claim: %v", err)
	}
	if _, err := m.ReleasePresentation(initial.ID, second.PeerID); err != nil {
		t.Fatal(err)
	}
	idle, _ = m.Get(initial.ID)
	if idle.PresenterPeerID != "" {
		t.Fatal("stop did not restore voice-only room")
	}
}

func TestPresentationClaimIsAtomicAndRejectsUnauthenticatedMembers(t *testing.T) {
	m := NewManager()
	initial, _, _ := m.CreateHost()
	defer m.EndAll()
	one, _, _ := m.Join(initial.Code, "")
	two, _, _ := m.Join(initial.Code, "")
	if _, err := m.ClaimPresentation(initial.ID, "forged"); err == nil {
		t.Fatal("outsider claimed sharing")
	}
	var wg sync.WaitGroup
	successes := make(chan string, 2)
	for _, id := range []string{one.PeerID, two.PeerID} {
		wg.Add(1)
		go func(peerID string) {
			defer wg.Done()
			if _, err := m.ClaimPresentation(initial.ID, peerID); err == nil {
				successes <- peerID
			}
		}(id)
	}
	wg.Wait()
	close(successes)
	if len(successes) != 1 {
		t.Fatalf("successful concurrent claims: %d", len(successes))
	}
	winner := <-successes
	m.Disconnect(initial.ID, winner)
	snap, _ := m.Get(initial.ID)
	if snap.PresenterPeerID != winner {
		t.Fatal("temporary signaling loss should retain active media during resume window")
	}
}

func TestPresentationRecoveryDoesNotAnnounceStart(t *testing.T) {
	m := NewManager()
	initial, _, err := m.CreateHost()
	if err != nil {
		t.Fatal(err)
	}
	defer m.EndAll()
	viewer, _, err := m.Join(initial.Code, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.ClaimPresentation(initial.ID, viewer.PeerID); err != nil {
		t.Fatal(err)
	}
	m.Disconnect(initial.ID, viewer.PeerID)
	if _, _, err = m.Join(initial.Code, viewer.ResumeToken); err != nil {
		t.Fatal(err)
	}
	active, err := m.UpdatePresentation(initial.ID, viewer.PeerID, true, false, "unverified")
	if err != nil || !active.ScreenSharing || active.PresentationStarted {
		t.Fatalf("recovery should restore sharing silently: %+v %v", active, err)
	}
}
