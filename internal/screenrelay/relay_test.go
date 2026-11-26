package screenrelay

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/pion/rtcp"
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
	for _, codec := range []webrtc.RTPCodecCapability{
		{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000},
		{MimeType: webrtc.MimeTypeH264, ClockRate: 90000, SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"},
	} {
		t.Run(codec.MimeType, func(t *testing.T) { verifyFanout(t, codec) })
	}
}

func verifyFanout(t *testing.T, codec webrtc.RTPCodecCapability) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	m := New("")
	defer m.Close()
	source, err := m.api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	track, err := webrtc.NewTrackLocalStaticRTP(codec, "screenVideo", "screen")
	if err != nil {
		t.Fatal(err)
	}
	sender, err := source.AddTrack(track)
	if err != nil {
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
	if codec.MimeType == webrtc.MimeTypeH264 {
		payload[0] = 0x65
	}
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
	var reconnect webrtc.SessionDescription
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
			if remote.Codec().MimeType != codec.MimeType {
				t.Errorf("forwarded codec %s, want %s", remote.Codec().MimeType, codec.MimeType)
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
		reconnect = offer(t, ctx, pc)
		answer, err = m.Answer(ctx, id, []string{"one", "two"}[i], reconnect)
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
	s, err := m.session(id)
	if err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	old := s.receivers["two"]
	s.mu.Unlock()
	invalidICE := reconnect
	invalidICE.SDP = strings.ReplaceAll(invalidICE.SDP, "a=ice-ufrag:", "a=ignored-ufrag:")
	if _, err = m.Answer(ctx, id, "two", invalidICE); err == nil || errors.Is(err, ErrCodecMismatch) {
		t.Fatalf("expected compatible offer to fail during negotiation, got %v", err)
	}
	if codec.MimeType == webrtc.MimeTypeH264 {
		for _, tc := range []struct{ name, rtpmap, fmtp, direction string }{
			{"high", "H264", "packetization-mode=1;profile-level-id=640c1f", "recvonly"},
			{"mode 0", "H264", "packetization-mode=0;profile-level-id=42e01f", "recvonly"},
			{"lower level", "H264", "packetization-mode=1;profile-level-id=42e014;level-asymmetry-allowed=1", "recvonly"},
			{"VP8 only", "VP8", "", "recvonly"},
			{"send only", "H264", "packetization-mode=1;profile-level-id=42e01f", "sendonly"},
		} {
			incompatible := webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\na=" + tc.direction + "\r\na=rtpmap:96 " + tc.rtpmap + "/90000\r\na=fmtp:96 " + tc.fmtp + "\r\n"}
			if _, err = m.Answer(ctx, id, "two", incompatible); !errors.Is(err, ErrCodecMismatch) {
				t.Errorf("%s returned %v, want codec mismatch", tc.name, err)
			}
		}
	}
	s.mu.Lock()
	current := s.receivers["two"]
	s.mu.Unlock()
	if current != old || old.pc.ConnectionState() != webrtc.PeerConnectionStateConnected {
		t.Fatal("failed reconnection replaced or closed the connected receiver")
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
	checkUpstreamREMB(t, sender)
	m.Stop("old-session")
	if _, err = m.session(id); err != nil {
		t.Fatal("a stale stop closed the current publisher")
	}
	m.Stop(id)
	if _, err = m.session(id); err == nil {
		t.Fatal("publisher survived stop")
	}
}

func TestConstrainedHighAndBaselineNegotiateDistinctPayloads(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	m := New("")
	defer m.Close()
	pc, err := m.localAPI.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	tx, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
	if err != nil {
		t.Fatal(err)
	}
	var ordered []webrtc.RTPCodecParameters
	for _, profile := range []string{"640c1f", "42e01f"} {
		for _, codec := range tx.Sender().GetParameters().Codecs {
			params := fmtpParams(codec.SDPFmtpLine)
			if params["profile-level-id"] == profile && params["packetization-mode"] == "1" {
				ordered = append(ordered, codec)
			}
		}
	}
	if len(ordered) != 2 {
		t.Fatalf("local relay codecs missing: %+v", ordered)
	}
	if err = tx.SetCodecPreferences(ordered); err != nil {
		t.Fatal(err)
	}
	_, answer, err := m.Start(ctx, offer(t, ctx, pc))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(answer.SDP, "SAVPF 114 106") {
		t.Fatalf("relay did not preserve High before Baseline: %s", answer.SDP)
	}
	viewer := "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 98\r\na=mid:0\r\na=recvonly\r\na=rtpmap:98 H264/90000\r\na=fmtp:98 packetization-mode=1;profile-level-id=42e01f\r\n"
	if _, err := receiverCodec(viewer, ordered[0].RTPCodecCapability); !errors.Is(err, ErrCodecMismatch) {
		t.Fatalf("High RTP would reach a Baseline-only viewer: %v", err)
	}
	if codec, err := receiverCodec(viewer, ordered[1].RTPCodecCapability); err != nil || codec.PayloadType != 98 {
		t.Fatalf("Baseline encoder cannot serve Baseline-only viewer: %+v, %v", codec, err)
	}
}

func checkUpstreamREMB(t *testing.T, sender *webrtc.RTPSender) {
	t.Helper()
	if err := sender.SetReadDeadline(time.Now().Add(4 * time.Second)); err != nil {
		t.Fatal(err)
	}
	ssrc := uint32(sender.GetParameters().Encodings[0].SSRC)
	for {
		packets, _, err := sender.ReadRTCP()
		if err != nil {
			t.Fatalf("reading upstream REMB: %v", err)
		}
		for _, packet := range packets {
			if remb, ok := packet.(*rtcp.ReceiverEstimatedMaximumBitrate); ok && len(remb.SSRCs) == 1 && remb.SSRCs[0] == ssrc {
				if remb.Bitrate != 36_000_000 {
					t.Fatalf("upstream REMB = %v bps, want 36000000 bps", remb.Bitrate)
				}
				return
			}
		}
	}
}

func TestMalformedRTPBetweenValidPacketsDoesNotInterruptStream(t *testing.T) {
	good := func(sequence uint16) []byte {
		packet := &rtp.Packet{Header: rtp.Header{Version: 2, PayloadType: 96, SequenceNumber: sequence}, Payload: []byte{0x65}}
		encoded, err := packet.Marshal()
		if err != nil {
			t.Fatal(err)
		}
		return encoded
	}
	input := [][]byte{good(1), {0x80, 0x60, 0x00}, good(3)}
	var received []uint16
	readPackets(func(buffer []byte) (int, error) {
		if len(input) == 0 {
			return 0, io.EOF
		}
		n := copy(buffer, input[0])
		input = input[1:]
		return n, nil
	}, func(packet *rtp.Packet) { received = append(received, packet.SequenceNumber) })
	if len(received) != 2 || received[0] != 1 || received[1] != 3 {
		t.Fatalf("packets forwarded: %v", received)
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
