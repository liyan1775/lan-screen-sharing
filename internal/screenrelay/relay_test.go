package screenrelay

import (
	"bytes"
	"context"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

func offer(t *testing.T, ctx context.Context, pc *webrtc.PeerConnection) webrtc.SessionDescription {
	t.Helper()
	description, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	done := webrtc.GatheringCompletePromise(pc)
	if err = pc.SetLocalDescription(description); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	return *pc.LocalDescription()
}

func TestOneUpstreamForwardsIdenticalPayloadAndClockToTwoReceivers(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	m := New("")
	defer m.Close()
	source, err := m.api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	track, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000}, "screenVideo", "screen")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = source.AddTrack(track); err != nil {
		t.Fatal(err)
	}
	id, answer, err := m.Start(ctx, offer(t, ctx, source))
	if err != nil {
		t.Fatal(err)
	}
	if err = source.SetRemoteDescription(answer); err != nil {
		t.Fatal(err)
	}
	payload := []byte{0x10, 0x00, 0x9d, 0x01, 0x2a, 0x80, 0x07, 0x38, 0x04, 0x12, 0x34}
	go func() {
		ticker := time.NewTicker(10 * time.Millisecond)
		defer ticker.Stop()
		var sequence uint16
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				sequence++
				body := bytes.Clone(payload)
				body[len(body)-2], body[len(body)-1] = byte(sequence>>8), byte(sequence)
				_ = track.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2, PayloadType: 96, SequenceNumber: sequence, Timestamp: uint32(sequence) * 1500, Marker: true}, Payload: body})
			}
		}
	}()
	packets := []chan *rtp.Packet{make(chan *rtp.Packet, 20), make(chan *rtp.Packet, 20)}
	for i := 0; i < 2; i++ {
		pc, createErr := m.api.NewPeerConnection(webrtc.Configuration{})
		if createErr != nil {
			t.Fatal(createErr)
		}
		defer pc.Close()
		pc.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
			if remote.Kind() != webrtc.RTPCodecTypeVideo {
				return
			}
			for {
				packet, _, readErr := remote.ReadRTP()
				if readErr != nil {
					return
				}
				select {
				case packets[i] <- packet:
				case <-ctx.Done():
					return
				}
			}
		})
		for _, kind := range []webrtc.RTPCodecType{webrtc.RTPCodecTypeVideo, webrtc.RTPCodecTypeAudio} {
			if _, err = pc.AddTransceiverFromKind(kind, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}); err != nil {
				t.Fatal(err)
			}
		}
		answer, err = m.Answer(ctx, id, []string{"one", "two"}[i], offer(t, ctx, pc))
		if err != nil {
			t.Fatal(err)
		}
		if err = pc.SetRemoteDescription(answer); err != nil {
			t.Fatal(err)
		}
	}
	seen := [2]map[uint16]uint32{{}, {}}
	checkPayload := func(packet *rtp.Packet) {
		t.Helper()
		expected := bytes.Clone(payload)
		expected[len(expected)-2], expected[len(expected)-1] = byte(packet.SequenceNumber>>8), byte(packet.SequenceNumber)
		if !bytes.Equal(packet.Payload, expected) || packet.Timestamp != uint32(packet.SequenceNumber)*1500 {
			t.Fatal("encoded payload or RTP clock changed during forwarding")
		}
	}
	for matches := 0; matches < 3; {
		select {
		case packet := <-packets[0]:
			checkPayload(packet)
			seen[0][packet.SequenceNumber] = packet.Timestamp
			if timestamp, ok := seen[1][packet.SequenceNumber]; ok {
				if timestamp != packet.Timestamp {
					t.Fatal("clock changed between receivers")
				}
				matches++
			}
		case packet := <-packets[1]:
			checkPayload(packet)
			seen[1][packet.SequenceNumber] = packet.Timestamp
			if timestamp, ok := seen[0][packet.SequenceNumber]; ok {
				if timestamp != packet.Timestamp {
					t.Fatal("clock changed between receivers")
				}
				matches++
			}
		case <-ctx.Done():
			t.Fatal("two native receivers did not receive matching frames: ", ctx.Err())
		}
	}
	third, err := m.api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer third.Close()
	_, _ = third.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly})
	if _, err = m.Answer(ctx, id, "third", offer(t, ctx, third)); err == nil || err.Error() != "SCREEN_RELAY_FULL" {
		t.Fatalf("third receiver was accepted: %v", err)
	}
	m.RemoveReceiver(id, "one")
	var lastSequence uint16
	for sequence := range seen[1] {
		if sequence > lastSequence {
			lastSequence = sequence
		}
	}
	for active := false; !active; {
		select {
		case packet := <-packets[1]:
			checkPayload(packet)
			active = packet.SequenceNumber > lastSequence+5
		case <-ctx.Done():
			t.Fatal("removing a receiver interrupted the other")
		}
	}
	m.Stop("old-session")
	if _, err = m.session(id); err != nil {
		t.Fatal("a stale stop closed the current publisher")
	}
	m.Stop(id)
	if _, err = m.session(id); err == nil {
		t.Fatal("publisher survived stop")
	}
}

func TestClosedRelayCannotStartMoreSessions(t *testing.T) {
	m := New("")
	m.Close()
	if _, _, err := m.Start(context.Background(), webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: "not needed"}); err != ErrSession {
		t.Fatalf("closed manager: %v", err)
	}
}

func TestLocalPublishersRemainIndependentAndStoppedSessionsCannotResurrect(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	m := New("")
	defer m.Close()
	start := func(requestCtx context.Context) (string, error) {
		pc, err := m.api.NewPeerConnection(webrtc.Configuration{})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = pc.Close() })
		if _, err = pc.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly}); err != nil {
			t.Fatal(err)
		}
		id, _, err := m.Start(requestCtx, offer(t, ctx, pc))
		return id, err
	}
	old, err := start(ctx)
	if err != nil {
		t.Fatal(err)
	}
	current, err := start(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.session(old); err != nil {
		t.Fatal("starting another local page interrupted the existing publisher")
	}
	m.Stop(old)
	if _, err = m.session(current); err != nil {
		t.Fatal("late stop from the replaced publisher closed its replacement")
	}
	canceled, abort := context.WithCancel(ctx)
	abort()
	if _, err = start(canceled); err == nil {
		t.Fatal("canceled start published a session")
	}
	if _, err = m.session(current); err != nil {
		t.Fatal("canceled startup replaced the active publisher")
	}
	pending := make(chan error, 1)
	go func() {
		_, answerErr := m.Answer(ctx, current, "waiting", webrtc.SessionDescription{Type: webrtc.SDPTypeOffer})
		pending <- answerErr
	}()
	m.Stop(current)
	select {
	case err = <-pending:
		if err != ErrSession {
			t.Fatalf("pending receiver after stop: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("stopping a publisher left a receiver waiting")
	}
}
