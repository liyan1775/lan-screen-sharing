package room

import (
	"testing"
	"time"
)

func TestDefaultRoomKeepsSharingAndCanRecoverAfterSeveralDays(t *testing.T) {
	for _, presenterRole := range []string{"host", "viewer"} {
		t.Run(presenterRole, func(t *testing.T) {
			started := time.Unix(100, 0)
			m := NewManager(WithClock(func() time.Time { return started }))
			defer m.EndAll()
			r, credential, err := m.CreateHost()
			if err != nil {
				t.Fatal(err)
			}
			hostID := r.Members[0].PeerID
			viewer, _, err := m.Join(r.Code, "")
			if err != nil {
				t.Fatal(err)
			}
			presenterID := hostID
			if presenterRole == "viewer" {
				presenterID = viewer.PeerID
			}
			if _, err = m.ClaimPresentation(r.ID, presenterID); err != nil {
				t.Fatal(err)
			}
			if _, err = m.UpdatePresentation(r.ID, presenterID, true, true, "browser_reported"); err != nil {
				t.Fatal(err)
			}

			// Neither the original two-hour deadline nor a longer session may
			// invalidate an active room, its invite or its recovery credentials.
			for _, elapsed := range []time.Duration{2 * time.Hour, 3 * time.Hour, 7 * 24 * time.Hour} {
				m.SetClock(func() time.Time { return started.Add(elapsed) })
				if !m.AuthenticateHost(credential.Token) {
					t.Fatalf("host credential expired after %s", elapsed)
				}
				listed := m.DiscoverableRooms()
				if len(listed) != 1 || listed[0].ID != r.ID || listed[0].Code != r.Code || !listed[0].ScreenSharing {
					t.Fatalf("active room disappeared after %s: %#v", elapsed, listed)
				}
				current, updateErr := m.UpdatePresentation(r.ID, presenterID, true, true, "browser_reported")
				if updateErr != nil || current.PresenterPeerID != presenterID || !current.HasSystemAudio {
					t.Fatalf("sharing failed after %s: %#v %v", elapsed, current, updateErr)
				}
			}
			if !r.ExpiresAt.IsZero() {
				t.Fatalf("default room advertised a fixed expiry: %s", r.ExpiresAt)
			}
			if err = m.Route(r.ID, hostID, viewer.PeerID, SignalMessage{Type: "rtc.description"}); err != nil {
				t.Fatalf("long-running room cannot negotiate media: %v", err)
			}

			m.Disconnect(r.ID, hostID)
			m.Disconnect(r.ID, viewer.PeerID)
			m.SetClock(func() time.Time { return started.Add(7*24*time.Hour + time.Second) })
			restored, err := m.ResumeHost(r.ID)
			if err != nil || restored.ID != r.ID || restored.Code != r.Code || restored.PresenterPeerID != presenterID || !restored.ScreenSharing {
				t.Fatalf("long-running host could not refresh: %#v %v", restored, err)
			}
			resumed, restored, err := m.Join(r.Code, viewer.ResumeToken)
			if err != nil || resumed.PeerID != viewer.PeerID || restored.ID != r.ID || len(restored.Members) != 2 {
				t.Fatalf("long-running viewer could not refresh: %#v %#v %v", resumed, restored, err)
			}
			if _, _, err = m.Join(r.Code, ""); err != nil {
				t.Fatalf("long-running invite cannot admit a new viewer: %v", err)
			}
			if _, err = m.ReleasePresentation(r.ID, presenterID); err != nil {
				t.Fatalf("long-running presenter cannot stop sharing: %v", err)
			}
			if _, err = m.ClaimPresentation(r.ID, presenterID); err != nil {
				t.Fatalf("long-running presenter cannot restart sharing: %v", err)
			}
			m.End(r.ID)
			if m.AuthenticateHost(credential.Token) {
				t.Fatal("explicit end retained host credentials")
			}
			if _, err = m.ResumeHost(r.ID); err == nil {
				t.Fatal("explicitly ended long-running room could be restored")
			}
		})
	}
}
