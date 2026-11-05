// Package screenrelay fans out encoded RTP without decoding or re-encoding it.
// One localhost browser connection supplies video; at most two room peers receive
// the same payloads over independent authenticated DTLS/SRTP connections.
package screenrelay

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

var ErrSession = errors.New("SCREEN_RELAY_SESSION_GONE")

type Manager struct {
	mu       sync.Mutex
	api      *webrtc.API
	localAPI *webrtc.API
	sessions map[string]*session
	closed   bool
}

type session struct {
	id                   string
	up                   *webrtc.PeerConnection
	ready                chan struct{}
	done                 chan struct{}
	readyOnce, closeOnce sync.Once
	feedbackOnce         sync.Once
	codec                webrtc.RTPCodecCapability // Published before ready is closed.
	ssrc                 atomic.Uint32
	mu                   sync.Mutex
	receivers            map[string]*receiver
	fanout               atomic.Pointer[[]*receiver]
	lastPLI              time.Time
}

type receiver struct {
	pc           *webrtc.PeerConnection
	video, audio *webrtc.TrackLocalStaticRTP
}

func New(localIPv4 string) *Manager {
	settings := webrtc.SettingEngine{}
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetIPFilter(func(ip net.IP) bool { return ip.IsLoopback() || ip.String() == localIPv4 })
	settings.SetRemoteIPFilter(func(ip net.IP) bool { return ip.To4() != nil && (ip.IsPrivate() || ip.IsLoopback()) })
	settings.SetICETimeouts(5*time.Second, 10*time.Second, 2*time.Second)
	local := settings
	local.SetRemoteIPFilter(func(ip net.IP) bool { return ip.IsLoopback() || ip.String() == localIPv4 })
	engine := &webrtc.MediaEngine{}
	registry := &interceptor.Registry{}
	// The upstream is confined to this computer. Use a fixed receiver budget
	// rather than Internet-style transport probing on the loopback connection.
	// The browser's selected bitrate ceiling still governs encoded video.
	if err := engine.RegisterDefaultCodecs(); err != nil {
		panic(err)
	}
	if err := webrtc.ConfigureNack(engine, registry); err != nil {
		panic(err)
	}
	if err := webrtc.ConfigureRTCPReports(registry); err != nil {
		panic(err)
	}
	if err := webrtc.ConfigureStatsInterceptor(registry); err != nil {
		panic(err)
	}
	return &Manager{sessions: map[string]*session{}, api: webrtc.NewAPI(webrtc.WithSettingEngine(settings)), localAPI: webrtc.NewAPI(webrtc.WithSettingEngine(local), webrtc.WithMediaEngine(engine), webrtc.WithInterceptorRegistry(registry))}
}

func (m *Manager) Start(ctx context.Context, offer webrtc.SessionDescription) (string, webrtc.SessionDescription, error) {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return "", webrtc.SessionDescription{}, ErrSession
	}
	m.mu.Unlock()
	if offer.Type != webrtc.SDPTypeOffer {
		return "", webrtc.SessionDescription{}, errors.New("SCREEN_RELAY_INVALID_OFFER")
	}
	pc, err := m.localAPI.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return "", webrtc.SessionDescription{}, err
	}
	var random [16]byte
	if _, err = rand.Read(random[:]); err != nil {
		_ = pc.Close()
		return "", webrtc.SessionDescription{}, err
	}
	s := &session{id: hex.EncodeToString(random[:]), up: pc, ready: make(chan struct{}), done: make(chan struct{}), receivers: map[string]*receiver{}}
	s.publishReceivers()
	pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		video := track.Kind() == webrtc.RTPCodecTypeVideo
		if video {
			s.readyOnce.Do(func() {
				s.codec = track.Codec().RTPCodecCapability
				s.ssrc.Store(uint32(track.SSRC()))
				close(s.ready)
			})
		} else if track.Codec().MimeType != webrtc.MimeTypeOpus {
			return
		}
		// ReadRTP allocates a receive buffer for every packet. Forwarding is
		// synchronous, so one full datagram buffer can be reused for this track.
		buffer := make([]byte, 64<<10)
		packet := &rtp.Packet{}
		for {
			n, _, readErr := track.Read(buffer)
			if readErr != nil {
				return
			}
			if packet.Unmarshal(buffer[:n]) != nil {
				return
			}
			s.forward(packet, video)
		}
	})
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateConnected {
			s.feedbackOnce.Do(func() { go s.localFeedback() })
		}
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			go m.remove(s)
		}
	})
	answer, err := answerOffer(ctx, pc, offer)
	if err != nil {
		s.close()
		return "", webrtc.SessionDescription{}, err
	}
	m.mu.Lock()
	if m.closed || ctx.Err() != nil || len(m.sessions) >= 16 {
		m.mu.Unlock()
		s.close()
		return "", webrtc.SessionDescription{}, ErrSession
	}
	select {
	case <-s.done:
		m.mu.Unlock()
		return "", webrtc.SessionDescription{}, ErrSession
	default:
	}
	// Pages on one local service can belong to different rooms. A new capture
	// must never replace another page's publisher; only its random ID can stop it.
	m.sessions[s.id] = s
	m.mu.Unlock()
	time.AfterFunc(15*time.Second, func() {
		if pc.ConnectionState() != webrtc.PeerConnectionStateConnected {
			m.remove(s)
		}
	})
	return s.id, answer, nil
}

func (m *Manager) session(id string) (*session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || m.sessions[id] == nil {
		return nil, ErrSession
	}
	return m.sessions[id], nil
}

func (m *Manager) Answer(ctx context.Context, id, peerID string, offer webrtc.SessionDescription) (webrtc.SessionDescription, error) {
	s, err := m.session(id)
	if err != nil {
		return webrtc.SessionDescription{}, err
	}
	select {
	case <-s.ready:
	case <-s.done:
		return webrtc.SessionDescription{}, ErrSession
	case <-ctx.Done():
		return webrtc.SessionDescription{}, ctx.Err()
	}
	pc, err := m.api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return webrtc.SessionDescription{}, err
	}
	video, err := webrtc.NewTrackLocalStaticRTP(s.codec, "screenVideo", "screen")
	if err != nil {
		_ = pc.Close()
		return webrtc.SessionDescription{}, err
	}
	audio, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "systemAudio", "screen")
	if err != nil {
		_ = pc.Close()
		return webrtc.SessionDescription{}, err
	}
	r := &receiver{pc: pc, video: video, audio: audio}
	s.mu.Lock()
	select {
	case <-s.done:
		s.mu.Unlock()
		_ = pc.Close()
		return webrtc.SessionDescription{}, ErrSession
	default:
	}
	old := s.receivers[peerID]
	if old == nil && len(s.receivers) >= 2 {
		s.mu.Unlock()
		_ = pc.Close()
		return webrtc.SessionDescription{}, errors.New("SCREEN_RELAY_FULL")
	}
	s.receivers[peerID] = r
	s.publishReceivers()
	s.mu.Unlock()
	if old != nil {
		_ = old.pc.Close()
	}
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateConnected {
			s.requestKeyframe()
		}
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			go s.removeReceiver(peerID, r)
		}
	})
	for _, track := range []webrtc.TrackLocal{video, audio} {
		sender, addErr := pc.AddTrack(track)
		if addErr != nil {
			s.removeReceiver(peerID, r)
			return webrtc.SessionDescription{}, addErr
		}
		go func() {
			for {
				packets, _, readErr := sender.ReadRTCP()
				if readErr != nil {
					return
				}
				for _, packet := range packets {
					switch packet.(type) {
					case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
						s.requestKeyframe()
					}
				}
			}
		}()
	}
	answer, err := answerOffer(ctx, pc, offer)
	if err != nil {
		s.removeReceiver(peerID, r)
	}
	return answer, err
}

func answerOffer(ctx context.Context, pc *webrtc.PeerConnection, offer webrtc.SessionDescription) (webrtc.SessionDescription, error) {
	if offer.Type != webrtc.SDPTypeOffer {
		return webrtc.SessionDescription{}, errors.New("SCREEN_RELAY_INVALID_OFFER")
	}
	if err := pc.SetRemoteDescription(offer); err != nil {
		return webrtc.SessionDescription{}, err
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		return webrtc.SessionDescription{}, err
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err = pc.SetLocalDescription(answer); err != nil {
		return webrtc.SessionDescription{}, err
	}
	select {
	case <-gathered:
	case <-ctx.Done():
		return webrtc.SessionDescription{}, ctx.Err()
	}
	return *pc.LocalDescription(), nil
}

func (s *session) publishReceivers() {
	items := make([]*receiver, 0, len(s.receivers))
	for _, r := range s.receivers {
		items = append(items, r)
	}
	s.fanout.Store(&items)
}

func (s *session) forward(packet *rtp.Packet, video bool) {
	// Extensions belong to the upstream transport, not the encoded picture/audio.
	packet.Extension = false
	packet.Extensions = nil
	packet.ExtensionProfile = 0
	for _, r := range *s.fanout.Load() {
		if r.pc.ConnectionState() != webrtc.PeerConnectionStateConnected {
			continue
		}
		track := r.audio
		if video {
			track = r.video
		}
		_ = track.WriteRTP(packet)
	}
}

func (s *session) requestKeyframe() {
	s.mu.Lock()
	if time.Since(s.lastPLI) < 300*time.Millisecond {
		s.mu.Unlock()
		return
	}
	s.lastPLI = time.Now()
	s.mu.Unlock()
	if ssrc := s.ssrc.Load(); ssrc != 0 {
		_ = s.up.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: ssrc}})
	}
}

func (s *session) localFeedback() {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		var sources []uint32
		if ssrc := s.ssrc.Load(); ssrc != 0 {
			sources = []uint32{ssrc}
		}
		_ = s.up.WriteRTCP([]rtcp.Packet{&rtcp.ReceiverEstimatedMaximumBitrate{Bitrate: 16_000_000, SSRCs: sources}})
		select {
		case <-s.done:
			return
		case <-ticker.C:
		}
	}
}

func (s *session) removeReceiver(id string, expected *receiver) {
	s.mu.Lock()
	if s.receivers[id] != expected {
		s.mu.Unlock()
		return
	}
	delete(s.receivers, id)
	s.publishReceivers()
	s.mu.Unlock()
	_ = expected.pc.Close()
}

func (m *Manager) RemoveReceiver(id, peerID string) {
	s, err := m.session(id)
	if err != nil {
		return
	}
	s.mu.Lock()
	r := s.receivers[peerID]
	s.mu.Unlock()
	if r != nil {
		s.removeReceiver(peerID, r)
	}
}

func (m *Manager) Stop(id string) {
	s, err := m.session(id)
	if err == nil {
		m.remove(s)
	}
}
func (m *Manager) remove(s *session) {
	m.mu.Lock()
	if m.sessions[s.id] == s {
		delete(m.sessions, s.id)
	}
	m.mu.Unlock()
	s.close()
}
func (m *Manager) Close() {
	m.mu.Lock()
	m.closed = true
	sessions := m.sessions
	m.sessions = nil
	m.mu.Unlock()
	for _, s := range sessions {
		s.close()
	}
}
func (s *session) close() {
	s.closeOnce.Do(func() {
		close(s.done)
		s.mu.Lock()
		items := *s.fanout.Load()
		s.receivers = map[string]*receiver{}
		s.publishReceivers()
		s.mu.Unlock()
		for _, r := range items {
			_ = r.pc.Close()
		}
		_ = s.up.Close()
	})
}
