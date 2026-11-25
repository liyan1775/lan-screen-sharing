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
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/sdp/v3"
	"github.com/pion/webrtc/v4"
)

var ErrSession = errors.New("SCREEN_RELAY_SESSION_GONE")
var ErrCodecMismatch = errors.New("SCREEN_RELAY_CODEC_MISMATCH")

type Manager struct {
	mu       sync.Mutex
	api      *webrtc.API
	localAPI *webrtc.API
	settings webrtc.SettingEngine
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
	negotiating          map[string]*receiver
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
	return &Manager{sessions: map[string]*session{}, settings: settings, api: webrtc.NewAPI(webrtc.WithSettingEngine(settings)), localAPI: webrtc.NewAPI(webrtc.WithSettingEngine(local), webrtc.WithMediaEngine(engine), webrtc.WithInterceptorRegistry(registry))}
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
	s := &session{id: hex.EncodeToString(random[:]), up: pc, ready: make(chan struct{}), done: make(chan struct{}), receivers: map[string]*receiver{}, negotiating: map[string]*receiver{}}
	s.publishReceivers()
	pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		video := track.Kind() == webrtc.RTPCodecTypeVideo
		payloadType := track.PayloadType()
		if video {
			locked := false
			s.readyOnce.Do(func() {
				locked = true
				s.codec = track.Codec().RTPCodecCapability
				s.ssrc.Store(uint32(track.SSRC()))
				close(s.ready)
			})
			if !locked {
				return
			}
		} else if track.Codec().MimeType != webrtc.MimeTypeOpus {
			return
		}
		// ReadRTP allocates a receive buffer for every packet. Forwarding is
		// synchronous, so one full datagram buffer can be reused for this track.
		readPackets(func(buffer []byte) (int, error) {
			n, _, err := track.Read(buffer)
			return n, err
		}, func(packet *rtp.Packet) {
			if webrtc.PayloadType(packet.PayloadType) == payloadType {
				s.forward(packet, video)
			}
		})
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
	if offer.Type != webrtc.SDPTypeOffer {
		return webrtc.SessionDescription{}, errors.New("SCREEN_RELAY_INVALID_OFFER")
	}
	codec, err := receiverCodec(offer.SDP, s.codec)
	if err != nil {
		return webrtc.SessionDescription{}, err
	}
	engine := &webrtc.MediaEngine{}
	opus := webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}
	if err = engine.RegisterCodec(codec, webrtc.RTPCodecTypeVideo); err != nil {
		return webrtc.SessionDescription{}, err
	}
	if err = engine.RegisterCodec(webrtc.RTPCodecParameters{RTPCodecCapability: opus, PayloadType: 111}, webrtc.RTPCodecTypeAudio); err != nil {
		return webrtc.SessionDescription{}, err
	}
	registry := &interceptor.Registry{}
	if err = webrtc.RegisterDefaultInterceptors(engine, registry); err != nil {
		return webrtc.SessionDescription{}, err
	}
	pc, err := webrtc.NewAPI(webrtc.WithSettingEngine(m.settings), webrtc.WithMediaEngine(engine), webrtc.WithInterceptorRegistry(registry)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return webrtc.SessionDescription{}, err
	}
	video, err := webrtc.NewTrackLocalStaticRTP(codec.RTPCodecCapability, "screenVideo", "screen")
	if err != nil {
		_ = pc.Close()
		return webrtc.SessionDescription{}, err
	}
	audio, err := webrtc.NewTrackLocalStaticRTP(opus, "systemAudio", "screen")
	if err != nil {
		_ = pc.Close()
		return webrtc.SessionDescription{}, err
	}
	r := &receiver{pc: pc, video: video, audio: audio}
	s.mu.Lock()
	s.negotiating[peerID] = r
	s.mu.Unlock()
	published := false
	defer func() {
		s.mu.Lock()
		if s.negotiating[peerID] == r {
			delete(s.negotiating, peerID)
		}
		s.mu.Unlock()
		if !published {
			_ = pc.Close()
		}
	}()
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
	answer, err := answerOffer(ctx, pc, offer, codec)
	if err != nil {
		return webrtc.SessionDescription{}, err
	}
	s.mu.Lock()
	select {
	case <-s.done:
		s.mu.Unlock()
		return webrtc.SessionDescription{}, ErrSession
	default:
	}
	if err = ctx.Err(); err != nil {
		s.mu.Unlock()
		return webrtc.SessionDescription{}, err
	}
	if s.negotiating[peerID] != r {
		s.mu.Unlock()
		return webrtc.SessionDescription{}, ErrSession
	}
	if state := pc.ConnectionState(); state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
		s.mu.Unlock()
		return webrtc.SessionDescription{}, ErrSession
	}
	old := s.receivers[peerID]
	if old == nil && len(s.receivers) >= 2 {
		s.mu.Unlock()
		return webrtc.SessionDescription{}, errors.New("SCREEN_RELAY_FULL")
	}
	s.receivers[peerID] = r
	s.publishReceivers()
	published = true
	s.mu.Unlock()
	if old != nil {
		_ = old.pc.Close()
	}
	return answer, nil
}

func readPackets(read func([]byte) (int, error), forward func(*rtp.Packet)) {
	buffer := make([]byte, 64<<10)
	packet := &rtp.Packet{}
	for {
		n, err := read(buffer)
		if err != nil {
			if n > 0 {
				continue
			}
			return
		}
		if packet.Unmarshal(buffer[:n]) != nil {
			continue
		}
		forward(packet)
	}
}

func receiverCodec(raw string, upstream webrtc.RTPCodecCapability) (webrtc.RTPCodecParameters, error) {
	var offer sdp.SessionDescription
	var codec webrtc.RTPCodecParameters
	if err := offer.UnmarshalString(raw); err != nil {
		return codec, err
	}
	videoSections := 0
	found := false
	for _, media := range offer.MediaDescriptions {
		if media.MediaName.Media != "video" || media.MediaName.Port.Value == 0 {
			continue
		}
		videoSections++
		if direction, _ := media.Attribute("mid"); direction == "" {
			continue
		}
		canReceive := true
		for _, direction := range []string{"inactive", "sendonly"} {
			_, blocked := media.Attribute(direction)
			_, sessionBlocked := offer.Attribute(direction)
			_, recv := media.Attribute("recvonly")
			_, both := media.Attribute("sendrecv")
			canReceive = canReceive && !blocked && (!sessionBlocked || recv || both)
		}
		if !canReceive {
			continue
		}
		for _, format := range media.MediaName.Formats {
			pt, err := strconv.ParseUint(format, 10, 7)
			if err != nil {
				continue
			}
			// Resolve the payload within this media section, not by scanning
			// matching strings elsewhere in the offer.
			part := sdp.SessionDescription{MediaDescriptions: []*sdp.MediaDescription{media}}
			offered, err := part.GetCodecForPayloadType(uint8(pt))
			if err != nil || !strings.EqualFold("video/"+offered.Name, upstream.MimeType) || offered.ClockRate != upstream.ClockRate {
				continue
			}
			if !compatibleConfig(upstream, offered.Fmtp) {
				continue
			}
			codec = webrtc.RTPCodecParameters{RTPCodecCapability: upstream, PayloadType: webrtc.PayloadType(pt)}
			codec.SDPFmtpLine = offered.Fmtp
			found = true
			break
		}
	}
	if !found || videoSections != 1 {
		return webrtc.RTPCodecParameters{}, ErrCodecMismatch
	}
	return codec, nil
}

func compatibleConfig(upstream webrtc.RTPCodecCapability, offered string) bool {
	a, b := fmtpParams(upstream.SDPFmtpLine), fmtpParams(offered)
	switch strings.ToLower(upstream.MimeType) {
	case "video/h264":
		profile := func(value string) ([]byte, bool) {
			profile, err := hex.DecodeString(value)
			if err != nil || len(profile) != 3 {
				return nil, false
			}
			switch profile[2] {
			case 10, 11, 12, 13, 20, 21, 22, 30, 31, 32, 40, 41, 42, 50, 51, 52, 60, 61, 62:
				return profile, true
			default:
				return nil, false
			}
		}
		mode := func(params map[string]string) string {
			if value, ok := params["packetization-mode"]; ok {
				return value
			}
			return "0"
		}
		profileID := func(params map[string]string) string {
			if value, ok := params["profile-level-id"]; ok {
				return value
			}
			return "42e01f"
		}
		x, validX := profile(profileID(a))
		y, validY := profile(profileID(b))
		if !validX || !validY || x[0] != y[0] || x[1] != y[1] || mode(a) != mode(b) || (mode(a) != "0" && mode(a) != "1") {
			return false
		}
		// Level 1b (constraint_set3_flag) sorts between levels 1 and 1.1.
		level := func(profile []byte) int {
			if profile[2] == 11 && profile[1]&0x10 != 0 {
				return 21
			}
			return int(profile[2]) * 2
		}
		if max, ok := b["max-recv-level"]; ok {
			extended, valid := profile(max)
			if !valid || extended[0] != y[0] || extended[1] != y[1] || level(extended) <= level(y) {
				return false
			}
			y = extended
		}
		return level(y) >= level(x)
	case "video/vp9", "video/av1":
		profile := func(params map[string]string, key string) string {
			if value, ok := params[key]; ok {
				return value
			}
			return "0"
		}
		key := "profile-id"
		if strings.EqualFold(upstream.MimeType, "video/av1") {
			key = "profile"
		}
		return profile(a, key) == profile(b, key)
	default:
		return true
	}
}

func fmtpParams(line string) map[string]string {
	params := map[string]string{}
	for _, entry := range strings.Split(strings.ToLower(line), ";") {
		key, value, ok := strings.Cut(entry, "=")
		if ok {
			params[strings.TrimSpace(key)] = strings.TrimSpace(value)
		}
	}
	return params
}

func answerOffer(ctx context.Context, pc *webrtc.PeerConnection, offer webrtc.SessionDescription, codecs ...webrtc.RTPCodecParameters) (webrtc.SessionDescription, error) {
	if offer.Type != webrtc.SDPTypeOffer {
		return webrtc.SessionDescription{}, errors.New("SCREEN_RELAY_INVALID_OFFER")
	}
	if err := pc.SetRemoteDescription(offer); err != nil {
		return webrtc.SessionDescription{}, err
	}
	if len(codecs) > 0 {
		for _, transceiver := range pc.GetTransceivers() {
			if transceiver.Kind() == webrtc.RTPCodecTypeVideo {
				if err := transceiver.SetCodecPreferences(codecs); err != nil {
					return webrtc.SessionDescription{}, err
				}
			}
		}
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
		// Leave room above the 15 Mbps video target for audio and RTP overhead.
		_ = s.up.WriteRTCP([]rtcp.Packet{&rtcp.ReceiverEstimatedMaximumBitrate{Bitrate: 24_000_000, SSRCs: sources}})
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
	delete(s.negotiating, peerID)
	r := s.receivers[peerID]
	if r != nil {
		delete(s.receivers, peerID)
		s.publishReceivers()
	}
	s.mu.Unlock()
	if r != nil {
		_ = r.pc.Close()
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
