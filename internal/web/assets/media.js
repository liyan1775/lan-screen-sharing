import { inspectDisplaySurface, isolationStatus } from './state.js';
import { prepareSystemAudioIsolation, describeSilentCapture } from './system-audio-isolation.js';
import { RoomText } from './room-text.js';
import { ScreenRelay } from './screen-relay.js';

export const QUALITY = Object.freeze({
  '1080p60': { width: 1920, height: 1080, fps: 60, bitrate: 25_000_000 },
  '720p60': { width: 1280, height: 720, fps: 60, bitrate: 8_000_000 },
  '720p30': { width: 1280, height: 720, fps: 30, bitrate: 2_500_000 },
});

function captureVideoConstraints(quality, shareCursor = false) {
  const target = QUALITY[quality];
  return { width: { ideal: target.width, max: target.width }, height: { ideal: target.height, max: target.height }, frameRate: { ideal: target.fps, max: target.fps }, cursor: shareCursor ? 'always' : 'never' };
}

export function mapRemoteTrack({ fromPeerId, mid, role, track, stream }) {
  if (!fromPeerId || !mid || !track || !['screenVideo', 'systemAudio', 'microphone'].includes(role)) return null;
  if (role === 'screenVideo' && track.kind !== 'video') return null;
  if ((role === 'systemAudio' || role === 'microphone') && track.kind !== 'audio') return null;
  const isolatedStream = typeof MediaStream === 'function'
    ? new MediaStream([track])
    : { getTracks: () => [track], getVideoTracks: () => track.kind === 'video' ? [track] : [], getAudioTracks: () => track.kind === 'audio' ? [track] : [] };
  return {
    sourcePeerId: fromPeerId,
    role,
    target: role === 'screenVideo' ? 'screen' : role === 'systemAudio' ? 'system-audio' : 'microphone',
    track,
    stream: isolatedStream,
  };
}

export function formatActualStats({ width, height, fps, bitrate, droppedFrames } = {}) {
  const resolution = width && height ? `${Math.round(width)}×${Math.round(height)}` : '分辨率未知';
  const frameRate = Number.isFinite(fps) ? `${fps.toFixed(1)} FPS` : 'FPS 未知';
  const rate = Number.isFinite(bitrate) ? `${(bitrate / 1_000_000).toFixed(1)} Mbps` : '码率未知';
  const dropped = Number.isFinite(droppedFrames) ? Math.round(droppedFrames) : '未知';
  return `实际 ${resolution} · ${frameRate} · ${rate} · 丢帧 ${dropped}`;
}

function readTrackRoleMap(transceivers) {
  return transceivers.map((transceiver) => ({ mid: transceiver.mid, role: transceiver.__trackRole })).filter((item) => item.mid != null && item.role);
}

// These values come from the active RTP stream's codecId, not the offer's
// preference list. Never infer a default profile if the browser omits fmtp.
function videoCodecStats(codecStats) {
  const mime = codecStats?.mimeType?.toUpperCase();
  const codec = ['VIDEO/VP8', 'VIDEO/VP9', 'VIDEO/H264', 'VIDEO/AV1'].includes(mime) ? mime.slice(6) : null;
  const profileLevelId = codec === 'H264'
    ? codecStats.sdpFmtpLine?.match(/(?:^|;)\s*profile-level-id\s*=\s*([\da-f]{6})\s*(?:;|$)/i)?.[1] ?? null : null;
  if (!profileLevelId) return { codec, codecProfile: codec, profileLevelId };

  const profileId = parseInt(profileLevelId.slice(0, 2), 16);
  const constraints = parseInt(profileLevelId.slice(2, 4), 16);
  const levelId = parseInt(profileLevelId.slice(4), 16);
  let profile = { 0x42:'Baseline', 0x4d:'Main', 0x58:'Extended', 0x64:'High' }[profileId];
  if ((profileId === 0x42 && (constraints & 0x40)) || (profileId === 0x4d && (constraints & 0x80)) ||
      (profileId === 0x58 && (constraints & 0xc0) === 0xc0)) profile = 'Constrained Baseline';
  if (profileId === 0x64 && constraints === 0x0c) profile = 'Constrained High';
  const level1b = levelId === 11 && [0x42, 0x4d, 0x58].includes(profileId) && (constraints & 0x10);
  const level = level1b || (levelId === 9 && profileId === 0x64) ? '1b'
    : [10,11,12,13,20,21,22,30,31,32,40,41,42,50,51,52,60,61,62].includes(levelId) ? (levelId / 10).toFixed(1) : '';
  return { codec, codecProfile: [codec, profile, level && `L${level}`].filter(Boolean).join(' '), profileLevelId };
}

function counterDelta(current, previous) {
  return Number.isFinite(current) && Number.isFinite(previous) && current >= previous ? current - previous : null;
}

const VOICE_SIGNAL_TIMEOUT = 4000;
const VOICE_ICE_TIMEOUT = 8000;
const VOICE_RETRY_BACKOFF = [350, 800, 1600];
// The server validates the existing RTC envelope strictly. Carry the attempt
// inside SDP, and use the allowed rollback type for retry requests only. Neither
// the attribute nor the request is passed to RTCPeerConnection.
const voiceAttemptLine = /(?:\r?\n)a=x-lan-voice-attempt:([\da-f-]{36})\r?\n$/;
const voiceRetryRequest = /^lan-voice-retry:(auto|manual):([\da-f-]{36}|none)$/;

function iceFragments(sdp) {
  return new Set([...sdp.matchAll(/^a=ice-ufrag:([^\s]+)/gm)].map(match => match[1]));
}

export class MeshMedia extends EventTarget {
  constructor(roomClient, { onRemoteTrack = () => {}, onState = () => {}, onAudioSource = () => {}, audioControlFor = () => {}, onText = () => {}, onReaction = () => {},
    setTimer = globalThis.setTimeout.bind(globalThis), clearTimer = globalThis.clearTimeout.bind(globalThis), now = Date.now } = {}) {
    super();
    this.client = roomClient;
    this.onRemoteTrack = onRemoteTrack;
    this.onState = onState;
    this.onAudioSource = onAudioSource;
    this.audioControlFor = audioControlFor;
    Object.assign(this, { setTimer, clearTimer, now });
    this.text = new RoomText({onMessage:onText, onReaction, onChange:() => this.onState({state:'text_connection'})});
    this.selfPeerId = '';
    this.selfRole = '';
    this.peers = new Map();
    this.screenStream = null;
    this.pendingScreenStream = null;
    this.screenVideoTrack = null;
    this.systemAudioTrack = null;
    this.microphoneTrack = null;
    this.microphoneGeneration = 0;
    this.microphoneQueue = Promise.resolve();
    this.pendingMicrophones = new Set();
    this.captureMode = 'limited';
    this.isolation = isolationStatus({ supported: false });
    this.quality = '1080p60';
    this.noNetworkPriority = new WeakSet();
    this.pauseBackgroundPreview = true;
    this.audioElements = new Map();
    this.blockedAudio = new Set();
    this.statsPrevious = new Map();
    this.captureGeneration = 0;
    this.statsCaptureGeneration = -1;
    this.ownsPresentation = false;
    this.presenterPeerId = '';
    this.hasSystemAudio = false;
    this.remoteScreens = new Map();
    this.voiceOnly = false;
    this.captureAttempt = null;
    this.claimingStream = null;
    this.preparingScreenStream = null;
    this.systemAudioDiagnostics = null;
    this.shareCursor = false;
    this.relay = new ScreenRelay(roomClient, {
      peerIds:() => [...this.peers.keys()], presenter:() => this.presenterPeerId,
      applyQuality:(sender, options) => this.applyVideoQuality(sender, options), onTrack:(id,role,track) => this.receiveTrack(id,role,track),
      onViewClosed:id => {
        this.remoteScreens.delete(id);
        this.removeAudio(id, 'systemAudio');
        this.onState({state:'remote_screen_ended',peerId:id});
      },
      onError:error => this.onState({state:'screen_relay_error',message:error.message}),
      onCodecChange:change => this.onState({state:'screen_codec_change', ...change}),
      onSourceClosed:() => this.onState({state:'screen_stats_changed'}),
    });
  }

  get usesScreenRelay() { return this.client.bootstrap?.screenRelay === true; }

  receiveTrack(peerId, role, track) {
    const mapped = mapRemoteTrack({fromPeerId:peerId,mid:'relay',role,track});
    if (!mapped) return;
    if (role === 'screenVideo') {
      track.enabled = !this.voiceOnly; this.remoteScreens.set(peerId,mapped.stream);
      track.addEventListener('ended',() => { if(this.remoteScreens.get(peerId) === mapped.stream) this.remoteScreens.delete(peerId); this.onState({state:'remote_screen_ended',peerId}); },{once:true});
    } else this.attachAudio(peerId,role,track);
    this.onRemoteTrack(mapped);
  }

  setIdentity(peerId, role) { this.selfPeerId = peerId; this.selfRole = role; }

  addPeer(peerId, role) {
    if (!peerId || peerId === this.selfPeerId || this.peers.has(peerId)) return this.peers.get(peerId);
    const isHostViewerPair = this.selfRole === 'host' || role === 'host';
    const shouldOffer = isHostViewerPair ? this.selfRole === 'host' : this.selfPeerId < peerId;
    const peer = this.openVoicePeer(peerId, role, { shouldOffer, retries: 0, retired: new Set() });
    if (this.usesScreenRelay && this.screenVideoTrack) void this.relay.start(this.screenVideoTrack,this.systemAudioTrack).then(() => this.relay.announce(peerId)).catch(error => this.relay.onError(error));
    return peer;
  }

  openVoicePeer(peerId, role, link, attempt = link.shouldOffer ? crypto.randomUUID() : '', voiceStatus = '') {
    const { shouldOffer } = link;
    const pc = new RTCPeerConnection({ iceServers: [] });
    const peer = { peerId, role, pc, link, attempt, remoteRoles: new Map(), localRoles: new Map(), candidates: [], outbound: [],
      incoming: Promise.resolve(), descriptionSent: false, descriptionsReady: false, state: 'connecting',
      voiceStatus, timer: null, noticeTimer: null };
    this.peers.set(peerId, peer);
    this.watchVoice(peer, VOICE_SIGNAL_TIMEOUT, () => this.recoverVoice(peer, 'signaling_timeout'));
    peer.noticeTimer = this.voiceTimer(() => {
      if (this.isVoicePeerCurrent(peer) && !peer.voiceStatus) this.setVoiceStatus(peer, 'connecting');
    }, 750);

    // An answerer must let setRemoteDescription associate the incoming m-lines
    // first. Pre-created transceivers can remain without an MID in browsers.
    if (shouldOffer) {
      {
        const video = pc.addTransceiver('video', { direction: 'sendrecv' });
        video.__trackRole = 'screenVideo'; peer.localRoles.set(video, 'screenVideo');
        const audio = pc.addTransceiver('audio', { direction: 'sendrecv' });
        audio.__trackRole = 'systemAudio'; peer.localRoles.set(audio, 'systemAudio');
      }
      const voice = pc.addTransceiver('audio', { direction: 'sendrecv' });
      voice.__trackRole = 'microphone'; peer.localRoles.set(voice, 'microphone');
      peer.voiceSender = voice.sender;
      peer.screenSender = [...peer.localRoles].find(([, trackRole]) => trackRole === 'screenVideo')?.[0].sender ?? null;
      peer.systemAudioSender = [...peer.localRoles].find(([, trackRole]) => trackRole === 'systemAudio')?.[0].sender ?? null;
      void this.syncMicrophoneSender(peer, peer.voiceSender).catch(() => {});
      {
        void peer.screenSender.replaceTrack(this.usesScreenRelay ? null : this.screenVideoTrack).catch(() => {});
        void peer.systemAudioSender.replaceTrack(!this.usesScreenRelay && this.captureMode === 'combined' ? this.systemAudioTrack : null).catch(() => {});
        this.applyVideoQuality(peer.screenSender);
      }
    }

    pc.onicecandidate = ({ candidate }) => {
      if (!candidate || !this.isVoicePeerCurrent(peer)) return;
      const json = candidate.toJSON();
      if (peer.descriptionSent) this.client.sendSignal('rtc.candidate', peerId, { candidate: json });
      else peer.outbound.push(json);
    };
    pc.ontrack = (event) => {
      if (!this.isVoicePeerCurrent(peer)) return;
      const roleForTrack = peer.remoteRoles.get(event.transceiver.mid);
      if (this.usesScreenRelay && roleForTrack !== 'microphone') return;
      const mapped = mapRemoteTrack({ fromPeerId: peerId, mid: event.transceiver.mid, role: roleForTrack, track: event.track });
      if (!mapped) return;
      if (mapped.role === 'screenVideo') {
        mapped.track.enabled = !this.voiceOnly;
        this.remoteScreens.set(peerId, mapped.stream);
        mapped.track.addEventListener('ended', () => {
          if (this.remoteScreens.get(peerId) === mapped.stream) this.remoteScreens.delete(peerId);
          this.onState({ state: 'remote_screen_ended', peerId });
        }, { once: true });
      }
      if (mapped.role === 'microphone' || mapped.role === 'systemAudio') this.attachAudio(peerId, mapped.role, mapped.track);
      this.onRemoteTrack(mapped);
    };
    pc.onconnectionstatechange = pc.oniceconnectionstatechange = () => this.syncVoiceTransport(peer);

    this.text.addPeer(peerId, pc, shouldOffer);
    if (shouldOffer) void this.negotiate(peer);
    return peer;
  }

  isVoicePeerCurrent(peer) { return this.peers.get(peer.peerId) === peer; }

  voiceTimer(callback, delay) {
    const timer = this.setTimer(callback, delay);
    timer?.unref?.();
    return timer;
  }

  watchVoice(peer, delay, callback) {
    this.clearTimer(peer.timer);
    peer.timer = this.voiceTimer(() => {
      peer.timer = null;
      if (this.isVoicePeerCurrent(peer)) callback();
    }, delay);
  }

  setVoiceStatus(peer, status, reason) {
    if (peer.voiceStatus === status) return;
    peer.voiceStatus = status;
    this.onState({ state: 'voice_connection', peerId: peer.peerId, status, reason });
  }

  syncVoiceTransport(peer) {
    if (!this.isVoicePeerCurrent(peer)) return;
    if (peer.voiceStatus === 'retrying' || peer.voiceStatus === 'failed') return;
    const { connectionState, iceConnectionState } = peer.pc;
    if (connectionState === 'failed' || iceConnectionState === 'failed') {
      this.recoverVoice(peer, 'ice_failed');
      return;
    }
    peer.state = connectionState;
    if (!peer.descriptionsReady || peer.pc.signalingState !== 'stable') return;
    if (connectionState === 'connected' || (connectionState == null && ['connected', 'completed'].includes(iceConnectionState))) {
      this.clearTimer(peer.timer); peer.timer = null;
      this.clearTimer(peer.noticeTimer);
      peer.connectedAt ??= this.now();
      this.setVoiceStatus(peer, 'connected');
    } else if (peer.voiceStatus === 'connected' && connectionState === 'disconnected') {
      this.setVoiceStatus(peer, 'connecting');
      this.watchVoice(peer, VOICE_ICE_TIMEOUT, () => this.recoverVoice(peer, 'ice_timeout'));
    }
  }

  recoverVoice(peer, reason, manual = false) {
    if (!this.isVoicePeerCurrent(peer) || (!manual && (peer.voiceStatus === 'retrying' || peer.voiceStatus === 'failed'))) return;
    this.clearTimer(peer.timer); peer.timer = null;
    this.clearTimer(peer.noticeTimer);
    const { link } = peer;
    if (manual || (peer.connectedAt != null && this.now() - peer.connectedAt >= 15_000)) link.retries = 0;
    peer.connectedAt = null;
    if (!link.shouldOffer) {
      const lastAttempt = peer.attempt || peer.awaitingAttempt;
      const waiting = this.replaceVoicePeer(peer, '', 'retrying');
      waiting.awaitingAttempt = lastAttempt;
      this.client.sendSignal('rtc.description', peer.peerId, {
        description: { type: 'rollback', sdp: `lan-voice-retry:${manual ? 'manual' : 'auto'}:${lastAttempt || 'none'}` },
        tracks: [],
      });
      this.watchVoice(waiting, VOICE_ICE_TIMEOUT + VOICE_SIGNAL_TIMEOUT, () => this.setVoiceStatus(waiting, 'failed', reason));
      return;
    }
    const delay = manual ? 0 : VOICE_RETRY_BACKOFF[link.retries];
    if (delay == null) { this.setVoiceStatus(peer, 'failed', reason); return; }
    if (!manual) link.retries += 1;
    this.setVoiceStatus(peer, 'retrying', reason);
    this.watchVoice(peer, delay, () => this.replaceVoicePeer(peer));
  }

  replaceVoicePeer(peer, attempt, status = 'connecting') {
    if (peer.attempt) {
      peer.link.retired.add(peer.attempt);
      if (peer.link.retired.size > 16) peer.link.retired.delete(peer.link.retired.values().next().value);
    }
    this.closeVoicePeer(peer);
    const next = this.openVoicePeer(peer.peerId, peer.role, peer.link, attempt, status);
    this.onState({ state: 'voice_connection', peerId: next.peerId, status });
    return next;
  }

  retryVoiceConnections() {
    for (const peer of [...this.peers.values()]) {
      if (peer.voiceStatus === 'failed') this.recoverVoice(peer, 'manual', true);
    }
  }

  async bindAnswererTransceivers(peer, remoteTracks) {
    const negotiatedByMid = new Map(peer.pc.getTransceivers().filter((transceiver) => transceiver.mid != null).map((transceiver) => [transceiver.mid, transceiver]));
    const localRoles = new Map();
    for (const item of remoteTracks ?? []) {
      const transceiver = negotiatedByMid.get(item.mid);
      if (!transceiver) continue;
      const kindMatches = item.role === 'screenVideo'
        ? transceiver.receiver.track.kind === 'video'
        : (item.role === 'systemAudio' || item.role === 'microphone') && transceiver.receiver.track.kind === 'audio';
      if (!kindMatches) continue;
      transceiver.direction = 'sendrecv';
      transceiver.__trackRole = item.role;
      localRoles.set(transceiver, item.role);
    }
    peer.localRoles = localRoles;
    peer.voiceSender = [...localRoles].find(([, role]) => role === 'microphone')?.[0].sender ?? null;
    peer.screenSender = [...localRoles].find(([, role]) => role === 'screenVideo')?.[0].sender ?? null;
    peer.systemAudioSender = [...localRoles].find(([, role]) => role === 'systemAudio')?.[0].sender ?? null;

    // Remote role metadata identifies a negotiated media slot; local role
    // decides which local track, if any, is allowed to use that sender.
    await Promise.all([...localRoles].map(([transceiver, role]) => {
      if (role === 'microphone') return this.syncMicrophoneSender(peer, transceiver.sender);
      const track = this.usesScreenRelay ? null
        : role === 'screenVideo' ? this.screenVideoTrack
          : role === 'systemAudio' && this.captureMode === 'combined' ? this.systemAudioTrack
            : null;
      return transceiver.sender.replaceTrack(track);
    }));
    if (peer.screenSender) this.applyVideoQuality(peer.screenSender);
  }

  async negotiate(peer) {
    peer.negotiation = (async () => {
      try {
        const offer = await peer.pc.createOffer();
        if (!this.isVoicePeerCurrent(peer)) return;
        await peer.pc.setLocalDescription(offer);
        if (this.isVoicePeerCurrent(peer)) this.sendVoiceDescription(peer);
      } catch {
        this.recoverVoice(peer, 'signaling_error');
      }
    })();
    return peer.negotiation;
  }

  sendVoiceDescription(peer) {
    const description = peer.pc.localDescription.toJSON();
    if (peer.attempt) description.sdp = `${description.sdp.trimEnd()}\r\na=x-lan-voice-attempt:${peer.attempt}\r\n`;
    this.client.sendSignal('rtc.description', peer.peerId, { description, tracks: readTrackRoleMap(peer.pc.getTransceivers()) });
    peer.descriptionSent = true;
    for (const candidate of peer.outbound.splice(0)) this.client.sendSignal('rtc.candidate', peer.peerId, { candidate });
  }

  async addVoiceCandidate(peer, candidate) {
    // Candidates can arrive after the old connection has been replaced. A
    // reliable in-order description precedes candidates from the new sender.
    const fragment = candidate?.usernameFragment || candidate?.candidate?.match(/\bufrag ([^ ]+)/)?.[1];
    if (fragment && peer.remoteFragments.size && !peer.remoteFragments.has(fragment)) return;
    await peer.pc.addIceCandidate(candidate);
  }

  async handleSignal(type, payload) {
    if (type.startsWith('screen.')) { if (this.usesScreenRelay) await this.relay.handle(type,payload); return; }
    const peerId = payload.fromPeerId;
    let peer = this.peers.get(peerId);
    const description = type === 'rtc.description' ? payload.description : null;
    if (!peer && description?.type === 'offer') {
      const member = this.client.room?.members?.find(member => member.peerId === peerId);
      if (!this.client.room || member) peer = this.addPeer(peerId, member?.role ?? 'viewer');
    }
    if (!peer) return;
    if (description?.type === 'rollback') {
      const request = voiceRetryRequest.exec(description.sdp);
      if (request && peer.link.shouldOffer && (request[1] === 'manual' || request[2] === peer.attempt ||
        (request[2] === 'none' && !peer.descriptionsReady))) {
        this.recoverVoice(peer, 'remote_retry', request[1] === 'manual');
      }
      return;
    }

    const attempt = description?.sdp?.match(voiceAttemptLine)?.[1] ?? '';
    if (description?.type === 'offer') {
      if (peer.link.shouldOffer || peer.link.retired.has(attempt) || (peer.receivedOffer && (!attempt || attempt === peer.attempt))) return;
      if (peer.receivedOffer) peer = this.replaceVoicePeer(peer, attempt);
      else if (peer.voiceStatus === 'retrying' || peer.voiceStatus === 'failed') {
        this.watchVoice(peer, VOICE_SIGNAL_TIMEOUT, () => this.recoverVoice(peer, 'signaling_timeout'));
        this.setVoiceStatus(peer, 'connecting');
      }
      peer.attempt = attempt;
      peer.receivedOffer = true;
    } else if (description?.type === 'answer') {
      if (!peer.link.shouldOffer || (attempt && attempt !== peer.attempt) || peer.voiceStatus === 'retrying' || peer.voiceStatus === 'failed') return;
    } else if (type !== 'rtc.candidate') return;

    peer.incoming = peer.incoming.then(async () => {
      if (!this.isVoicePeerCurrent(peer) || peer.voiceStatus === 'retrying' || peer.voiceStatus === 'failed') return;
      if (!description) {
        if (peer.remoteFragments) await this.addVoiceCandidate(peer, payload.candidate);
        else if (peer.candidates.length < 128) peer.candidates.push(payload.candidate);
        return;
      }
      if (description.type === 'answer' && peer.pc.signalingState !== 'have-local-offer') return;
      const sdp = description.sdp.replace(voiceAttemptLine, '\r\n');
      for (const item of payload.tracks ?? []) peer.remoteRoles.set(item.mid, item.role);
      await peer.pc.setRemoteDescription({ ...description, sdp });
      if (!this.isVoicePeerCurrent(peer)) return;
      peer.remoteFragments = iceFragments(sdp);
      for (const candidate of peer.candidates.splice(0)) await this.addVoiceCandidate(peer, candidate);
      if (!this.isVoicePeerCurrent(peer)) return;
      if (description.type === 'offer') {
        await this.bindAnswererTransceivers(peer, payload.tracks);
        if (!this.isVoicePeerCurrent(peer)) return;
        const answer = await peer.pc.createAnswer();
        if (!this.isVoicePeerCurrent(peer)) return;
        await peer.pc.setLocalDescription(answer);
        if (!this.isVoicePeerCurrent(peer)) return;
        this.sendVoiceDescription(peer);
      }
      peer.descriptionsReady = true;
      if (peer.pc.signalingState === 'stable' && peer.voiceStatus !== 'retrying' && peer.voiceStatus !== 'failed') {
        this.watchVoice(peer, VOICE_ICE_TIMEOUT, () => this.recoverVoice(peer, 'ice_timeout'));
        this.syncVoiceTransport(peer);
      }
    }).catch(() => this.recoverVoice(peer, 'signaling_error'));
    return peer.incoming;
  }

  closeVoicePeer(peer, peerId = peer.peerId) {
    this.clearTimer(peer.timer);
    this.clearTimer(peer.noticeTimer);
    this.peers.delete(peerId);
    this.text.removePeer(peerId);
    peer.pc.close();
    this.removeAudio(peerId, 'microphone');
    if (!this.usesScreenRelay) {
      this.remoteScreens.delete(peerId);
      this.removeAudio(peerId, 'systemAudio');
    }
    for (const key of this.statsPrevious.keys()) if (key.startsWith(`${peerId}:`)) this.statsPrevious.delete(key);
  }

  async setScreenStream(stream, { mode = 'limited', isolation = this.isolation, ended = false } = {}) {
    const generation = this.captureGeneration;
    const captureRoomId = this.client.room?.roomId;
    if (stream) {
      this.claimingStream = stream;
      try {
        await this.client.claimPresentation?.();
        if (generation !== this.captureGeneration) {
          await this.client.releasePresentation?.(captureRoomId).catch(() => {});
          throw Object.assign(new Error('房间已离开，已取消共享。'), { code: 'CAPTURE_CANCELLED' });
        }
        this.ownsPresentation = true;
      } catch (error) {
        if (stream !== this.screenStream) stream.getTracks().forEach((track) => track.stop());
        throw error;
      } finally {
        if (this.claimingStream === stream) this.claimingStream = null;
      }
    }
    if (!stream && this.pendingScreenStream) await this.discardPendingScreen();
    if (stream && this.pendingScreenStream && this.pendingScreenStream !== stream) {
      this.pendingScreenStream.getTracks().forEach((track) => track.stop());
    }
    this.pendingScreenStream = null;
    const previousStream = this.screenStream;
    this.screenStream = stream;
    this.screenVideoTrack = stream?.getVideoTracks?.()[0] ?? null;
    this.systemAudioTrack = mode === 'combined' ? stream?.getAudioTracks?.()[0] ?? null : null;
    this.captureMode = mode;
    this.isolation = isolation;
    this.onState({state:'screen_stats_changed'});
    if (this.screenVideoTrack) await this.applyCaptureQuality();
    if (generation !== this.captureGeneration || this.screenStream !== stream) return;
    if (this.screenVideoTrack) {
      const capturedTrack = this.screenVideoTrack;
      capturedTrack.addEventListener('ended', () => {
        if (this.screenVideoTrack === capturedTrack) {
          void this.setScreenStream(null, {ended:true}).catch(() => {});
        }
      }, { once: true });
    }
    try {
      if (this.usesScreenRelay) {
        if (this.screenVideoTrack && this.peers.size) await this.relay.start(this.screenVideoTrack,this.systemAudioTrack);
        else await this.relay.stopSource();
      } else await Promise.all([...this.peers].map(async ([peerId, peer]) => {
        if (!peer.screenSender) return;
        try {
          await peer.screenSender.replaceTrack(this.screenVideoTrack);
          if (this.peers.get(peerId) !== peer) return;
          await peer.systemAudioSender.replaceTrack(mode === 'combined' ? this.systemAudioTrack : null);
          if (this.screenVideoTrack) await this.applyVideoQuality(peer.screenSender);
        } catch (error) {
          if (this.peers.get(peerId) === peer) throw error;
        }
      }));
    } catch (error) {
      if (generation !== this.captureGeneration || this.screenStream !== stream) {
        if (stream && stream !== this.screenStream) stream.getTracks().forEach(track => track.stop());
        throw error;
      }
      await this.relay.stopSource();
      await Promise.allSettled([...this.peers.values()].flatMap((peer) => [peer.screenSender?.replaceTrack(null), peer.systemAudioSender?.replaceTrack(null)]));
      this.screenStream?.getTracks().forEach((track) => track.stop());
      this.screenStream = null; this.screenVideoTrack = null; this.systemAudioTrack = null;
      previousStream?.getTracks().forEach((track) => track.stop());
      await this.client.releasePresentation?.(captureRoomId).catch(() => {});
      this.ownsPresentation = false;
      this.onState({ state: 'screen_stopped' });
      throw error;
    }
    if (generation !== this.captureGeneration || this.screenStream !== stream) return;
    if (mode === 'combined' && this.systemAudioTrack) {
      const capturedAudio = this.systemAudioTrack;
      capturedAudio.addEventListener('ended', () => { if (this.systemAudioTrack === capturedAudio) void this.setSystemAudioTrack(null); }, { once: true });
    }
    if (previousStream && previousStream !== stream) previousStream.getTracks().forEach((track) => track.stop());
    this.statsCaptureGeneration = generation;
    this.publishMediaState();
    if (this.usesScreenRelay && stream) this.relay.announce();
    this.publishQualityState();
    this.onState({ state: stream ? 'screen_started' : 'screen_stopped', ...(ended ? {ended} : {}) });
  }

  async acceptPendingScreenAsLimited() {
    const stream = this.pendingScreenStream;
    if (!stream) throw new Error('没有待确认的屏幕画面。');
    const captureGeneration = this.captureGeneration;
    this.pendingScreenStream = null;
    stream.getAudioTracks().forEach((track) => track.stop());
    await this.setScreenStream(stream, { mode: 'limited', isolation: this.isolation });
    if (captureGeneration !== this.captureGeneration) {
      stream.getTracks().forEach((track) => track.stop());
      throw Object.assign(new Error('本机信令已关闭，屏幕捕获已取消。'), { code: 'CAPTURE_CANCELLED' });
    }
    return { stream, mode: 'limited', isolation: this.isolation, hasSystemAudio: false };
  }

  async discardPendingScreen({ended = false} = {}) {
    const stream = this.pendingScreenStream;
    this.pendingScreenStream = null;
    stream?.getTracks?.().forEach((track) => track.stop());
    this.isolation = { state: 'unverified', label: '未验证', verified: false };
    if (stream) this.onState({state:'capture_discarded', ended});
    return !!stream;
  }

  async setSystemAudioTrack(track) {
    const previousTrack = this.systemAudioTrack;
    this.systemAudioTrack = track;
    if (!track) this.captureMode = 'limited';
    try {
      if (this.usesScreenRelay) await this.relay.updateAudio(this.captureMode === 'combined' ? track : null);
      else await Promise.all([...this.peers].map(async ([peerId, peer]) => {
        try { await peer.systemAudioSender?.replaceTrack(this.captureMode === 'combined' ? track : null); }
        catch (error) { if (this.peers.get(peerId) === peer) throw error; }
      }));
    } finally {
      if (previousTrack && previousTrack !== track) previousTrack.stop();
      this.publishMediaState();
    }
  }

  queueMicrophoneUpdate(update) {
    const result = this.microphoneQueue.then(update);
    this.microphoneQueue = result.catch(() => {});
    return result;
  }

  syncMicrophoneSender(peer, sender) {
    return this.queueMicrophoneUpdate(() => {
      if (this.peers.get(peer.peerId) === peer && peer.voiceSender === sender && sender.track !== this.microphoneTrack) {
        return sender.replaceTrack(this.microphoneTrack);
      }
    });
  }

  assertMicrophoneGeneration(generation) {
    if (generation !== this.microphoneGeneration) {
      throw Object.assign(new Error('麦克风采集已取消。'), { code: 'CAPTURE_CANCELLED' });
    }
  }

  cancelMicrophoneCapture() {
    this.microphoneGeneration += 1;
    for (const pending of this.pendingMicrophones) pending.release();
  }

  async setMicrophoneTrack(track, { generation = this.microphoneGeneration, sending = () => true, onCommit = () => {} } = {}) {
    if (track && track !== this.microphoneTrack) track.enabled = false;
    return this.queueMicrophoneUpdate(async () => {
      const previous = this.microphoneTrack;
      const replaced = new Map();
      const isCurrent = (sender, peer) => this.peers.get(peer.peerId) === peer && peer.voiceSender === sender;
      try {
        for (;;) {
          this.assertMicrophoneGeneration(generation);
          if (track?.readyState === 'ended') throw new Error('所选麦克风已停止工作。');
          const waiting = [...this.peers.values()].filter(peer => peer.voiceSender && !replaced.has(peer.voiceSender));
          if (!waiting.length) break;
          const results = await Promise.allSettled(waiting.map(async peer => {
            const sender = peer.voiceSender;
            try {
              await sender.replaceTrack(track);
              replaced.set(sender, peer);
            } catch (error) {
              if (isCurrent(sender, peer)) throw error;
            }
          }));
          this.assertMicrophoneGeneration(generation);
          if (results.some(result => result.status === 'rejected')) {
            throw Object.assign(new Error('部分成员未能切换麦克风，已恢复原来的麦克风状态。'), { code: 'MIC_SWITCH_FAILED' });
          }
        }
      } catch (error) {
        // A cancelled room or explicit mute may already have cleared the old track.
        const restore = this.microphoneTrack;
        let lostPeer = false;
        await Promise.all([...replaced].map(async ([sender, peer]) => {
          if (!isCurrent(sender, peer)) return;
          try { await sender.replaceTrack(restore); }
          catch {
            if (!isCurrent(sender, peer)) return;
            lostPeer = true;
            void this.closePeer(peer.peerId).catch(() => {});
          }
        }));
        if (lostPeer && error.code !== 'CAPTURE_CANCELLED') {
          throw Object.assign(new Error('切换失败，已保留原麦克风。部分成员连接未能恢复，请重新加入房间。'), { code: 'MIC_SWITCH_FAILED' });
        }
        throw error;
      }
      this.microphoneTrack = track;
      if (previous !== track) previous?.stop?.();
      if (track) track.enabled = sending();
      onCommit();
      this.publishMediaState();
    });
  }

  stopMicrophone() {
    this.cancelMicrophoneCapture();
    const previous = this.microphoneTrack;
    this.microphoneTrack = null;
    if (previous) {
      previous.enabled = false;
      previous.stop();
    }
    this.publishMediaState();
    for (const peer of this.peers.values()) {
      if (peer.voiceSender) void this.syncMicrophoneSender(peer, peer.voiceSender).catch(() => {});
    }
  }

  async setMicrophoneFromCapture(capturePromise, sending) {
    const generation = this.microphoneGeneration;
    const stream = await capturePromise;
    const track = stream.getAudioTracks?.()[0];
    let released = false, committed = false;
    const pending = { release() {
      if (released) return;
      released = true;
      stream.getTracks?.().forEach(item => item.stop());
    } };
    try {
      this.assertMicrophoneGeneration(generation);
      if (!track || track.readyState === 'ended') throw new Error('麦克风没有返回可用的音频轨道。');
      this.pendingMicrophones.add(pending);
      await this.setMicrophoneTrack(track, { generation, sending, onCommit: () => {
        committed = true;
        this.pendingMicrophones.delete(pending);
      } });
      this.assertMicrophoneGeneration(generation);
      return { stream, track };
    } catch (error) {
      if (!committed) pending.release();
      throw error;
    } finally {
      this.pendingMicrophones.delete(pending);
    }
  }

  setAudioIsolationState(state) { this.isolation = state; this.publishMediaState(); }

  startScreenFromGesture(mode = 'limited') {
    if (this.captureAttempt) return Promise.reject(Object.assign(new Error('正在等待屏幕选择或共享授权，请稍候。'), { code:'PENDING_SCREEN_CAPTURE' }));
    const attempt = {};
    this.captureAttempt = attempt;
    this.onState({ state:'capture_pending' });
    // The inner call invokes getDisplayMedia before its first await.
    return this.captureScreenFromGesture(mode).finally(() => {
      if (this.captureAttempt === attempt) { this.captureAttempt = null; this.onState({state:'capture_idle'}); }
    });
  }

  async captureScreenFromGesture(mode = 'limited') {
    if (this.pendingScreenStream) throw Object.assign(new Error('请先选择仅共享画面与房间语音，或取消当前共享。'), { code: 'PENDING_SCREEN_CAPTURE' });
    const captureGeneration = this.captureGeneration;
    if (!navigator.mediaDevices?.getDisplayMedia) throw Object.assign(new Error('屏幕采集不可用'), { code: 'SYSTEM_AUDIO_UNSUPPORTED' });
    const supported = navigator.mediaDevices.getSupportedConstraints?.() ?? {};
    const captureAudio = supported.restrictOwnAudio ? { restrictOwnAudio: true } : true;
    const constraints = {
      video: captureVideoConstraints(this.quality, this.shareCursor),
      audio: mode === 'combined' ? captureAudio : false,
      systemAudio: 'include',
      windowAudio: 'exclude',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
    };
    const capturePromise = navigator.mediaDevices.getDisplayMedia(constraints);
    const stream = await capturePromise;
    if (captureGeneration !== this.captureGeneration) {
      stream.getTracks().forEach((track) => track.stop());
      throw Object.assign(new Error('本机信令已关闭，屏幕捕获已取消。'), { code: 'CAPTURE_CANCELLED' });
    }
    const videoTrack = stream.getVideoTracks()[0];
    const displaySurface = videoTrack?.getSettings?.().displaySurface;
    const { allowed, state, message } = inspectDisplaySurface(displaySurface);
    if (!allowed) {
      stream.getTracks().forEach((track) => track.stop());
      this.onState({ state, message });
      throw Object.assign(new Error(message), { code: state });
    }
    const systemAudioTrack = stream.getAudioTracks()[0];
    try { videoTrack.contentHint = 'motion'; } catch { /* Optional browser hint. */ }
    this.isolation = { state: 'unverified', label: '未验证', verified: false };
    if (displaySurface === 'window') {
      // The picker option is advisory. Never send a window's audio even if the
      // browser ignored it or included a track in the returned stream.
      stream.getAudioTracks().forEach(track => { track.stop(); stream.removeTrack?.(track); });
      mode = 'limited';
      this.isolation = { state: 'unverified', label: '应用窗口仅共享画面', verified: false };
      this.recordSystemAudioDiagnostics(describeSilentCapture(displaySurface, 'window_video_only', supported.restrictOwnAudio));
    } else if (mode !== 'combined') {
      this.recordSystemAudioDiagnostics(describeSilentCapture(displaySurface, 'video_only', supported.restrictOwnAudio));
    }
    if (mode === 'combined' && (!systemAudioTrack || systemAudioTrack.readyState === 'ended')) {
      this.pendingScreenStream = stream;
      this.isolation = isolationStatus({ supported: !!supported.restrictOwnAudio, requested: true, settings: {}, missingAudio: true });
      this.recordSystemAudioDiagnostics(describeSilentCapture(displaySurface, 'missing_audio', supported.restrictOwnAudio));
      this.onState({ state: 'missing_audio', message: '未获取所选内容的声音。画面尚未共享，请确认仅共享画面与房间语音，或取消。' });
      videoTrack.addEventListener('ended', () => {
        if (this.pendingScreenStream === stream) void this.discardPendingScreen({ended:true});
      }, {once:true});
      return { stream, mode: 'pending', captureState: 'missing_audio', isolation: this.isolation, hasSystemAudio: false };
    }
    if (mode === 'combined') {
      this.preparingScreenStream = stream;
      let result;
      try { result = await prepareSystemAudioIsolation(systemAudioTrack, !!supported.restrictOwnAudio, { displaySurface }); }
      finally { if (this.preparingScreenStream === stream) this.preparingScreenStream = null; }
      if (captureGeneration !== this.captureGeneration || videoTrack.readyState === 'ended') {
        stream.getTracks().forEach((track) => track.stop());
        throw Object.assign(new Error('房间已离开，已取消声音隔离检查。'), { code: 'CAPTURE_CANCELLED' });
      }
      this.isolation = result.isolation;
      this.recordSystemAudioDiagnostics(result.diagnostics);
    }
    await this.setScreenStream(stream, { mode, isolation: this.isolation });
    if (captureGeneration !== this.captureGeneration) {
      stream.getTracks().forEach((track) => track.stop());
      throw Object.assign(new Error('本机信令已关闭，屏幕捕获已取消。'), { code: 'CAPTURE_CANCELLED' });
    }
    return { stream, mode, captureState: 'ready', isolation: this.isolation, hasSystemAudio: mode === 'combined' && !!this.systemAudioTrack };
  }

  recordSystemAudioDiagnostics(diagnostics) {
    this.systemAudioDiagnostics = diagnostics;
    this.onState({ state: 'audio_isolation', diagnostics });
  }

  async setQuality(quality) {
    if (!QUALITY[quality]) return false;
    this.quality = quality;
    await this.refreshVideoQuality();
    return true;
  }

  async refreshVideoQuality() {
    const generation = this.captureGeneration;
    await this.applyCaptureQuality();
    if (generation !== this.captureGeneration) return;
    const senders = [...this.peers.values()].map((peer) => peer.screenSender).filter(Boolean);
    if (this.usesScreenRelay && this.relay.source?.videoSender) senders.push(this.relay.source.videoSender);
    await Promise.all(senders.map((sender) => this.applyVideoQuality(sender)));
    this.publishQualityState();
  }

  publishQualityState() {
    this.onState({ state: 'quality', target: this.quality, targetText: `目标 ${this.quality} · 码率上限 ${QUALITY[this.quality].bitrate / 1_000_000} Mbps · 实际效果以统计为准` });
  }

  async applyVideoQuality(sender, { confirm = false } = {}) {
    if (!sender?.getParameters || !sender?.setParameters) return false;
    try {
      const selected = QUALITY[this.quality];
      const limit = this.relay?.source?.videoSender === sender && this.relay.source.qualityLimit;
      const target = limit ? {
        width:Math.min(selected.width, limit.width), height:Math.min(selected.height, limit.height),
        fps:Math.min(selected.fps, limit.fps), bitrate:Math.min(selected.bitrate, limit.bitrate),
      } : selected;
      const parameters = sender.getParameters();
      const source = this.screenVideoTrack?.getSettings?.() ?? {};
      const scale = Math.max(1, (source.width ?? target.width) / target.width, (source.height ?? target.height) / target.height);
      const current = parameters.encodings?.[0];
      const useNetworkPriority = !!current && 'networkPriority' in current && !this.noNetworkPriority.has(sender);
      if (parameters.degradationPreference === 'maintain-resolution' && current?.maxBitrate === target.bitrate
        && current.maxFramerate === target.fps && current.scaleResolutionDownBy === scale
        && (!useNetworkPriority || current.networkPriority === 'high')) return true;
      const apply = (params, resolution, priority) => {
        if (resolution) params.degradationPreference = 'maintain-resolution';
        if (!params.encodings?.length) params.encodings = [{}];
        const encoding = params.encodings[0];
        Object.assign(encoding, {maxBitrate:target.bitrate, maxFramerate:target.fps, scaleResolutionDownBy:scale});
        if (priority) encoding.networkPriority = 'high';
        else delete encoding.networkPriority;
        return sender.setParameters(params);
      };
      const applyWithoutPriority = async params => {
        try { await apply(params, true, false); return true; }
        catch { return false; }
      };
      let appliedResolution;
      if (useNetworkPriority) {
        try { await apply(parameters, true, true); appliedResolution = true; }
        catch {
          appliedResolution = await applyWithoutPriority(sender.getParameters());
          if (appliedResolution) this.noNetworkPriority.add(sender);
        }
      } else appliedResolution = await applyWithoutPriority(parameters);
      if (!appliedResolution) {
        // Retry with fresh parameters, retaining the browser's original resolution policy.
        await apply(sender.getParameters(), false, false);
        if (useNetworkPriority) this.noNetworkPriority.add(sender);
        this.onState({ state: 'quality_preference_unsupported', message: '浏览器未接受清晰度优先策略，已保留基本画质设置；请以实际统计为准。' });
      }
      if (!confirm) return true;
      const applied = sender.getParameters().encodings?.[0];
      return applied?.maxBitrate === target.bitrate && applied.maxFramerate === target.fps
        && (!limit || applied.scaleResolutionDownBy === scale);
    } catch {
      this.onState({ state: 'quality_unsupported', message: '浏览器不支持应用部分发送质量目标；仍显示实际统计。' });
      return false;
    }
  }

  async applyCaptureQuality() {
    const track = this.screenVideoTrack ?? this.pendingScreenStream?.getVideoTracks?.()[0];
    if (!track) return true;
    try {
      track.contentHint = 'motion';
      if (typeof track.applyConstraints !== 'function') return false;
      const constraints = captureVideoConstraints(this.quality, this.shareCursor);
      const current = track.getConstraints?.();
      if (current?.cursor === constraints.cursor && ['width', 'height', 'frameRate'].every(key => current[key]?.ideal === constraints[key].ideal && current[key]?.max === constraints[key].max)) return true;
      await track.applyConstraints(constraints);
      return true;
    } catch {
      this.onState({ state: 'capture_quality_unsupported', message: '浏览器未能应用部分采集画质设置，仍按当前采集设置共享；请查看采集与实际发送帧率。' });
      return false;
    }
  }

  async setShareCursor(value) {
    this.shareCursor = !!value;
    return this.applyCaptureQuality();
  }

  setAudioControl(peerId, role, { muted, volume } = {}) {
    const audio = this.audioElements.get(`${peerId}:${role}`);
    if (!audio) return false;
    if (volume != null) audio.volume = Math.max(0, Math.min(1, Number(volume)));
    if (muted != null) {
      audio.userMuted = !!muted;
      audio.muted = !!muted || (role === 'systemAudio' && !this.canHearSharedAudio(peerId));
      if (!audio.muted && audio.paused) void this.playAudio(audio);
    }
    return true;
  }

  attachAudio(peerId, role, track) {
    const key = `${peerId}:${role}`;
    let audio = this.audioElements.get(key);
    if (!audio) {
      const control = this.audioControlFor(peerId, role);
      audio = document.createElement('audio');
      audio.autoplay = true;
      audio.playsInline = true;
      audio.userMuted = control?.muted === true;
      audio.muted = audio.userMuted || (role === 'systemAudio' && !this.canHearSharedAudio(peerId));
      if (control) audio.volume = control.volume;
      audio.dataset.sourcePeerId = peerId;
      audio.dataset.trackRole = role;
      audio.addEventListener?.('playing', () => this.setAudioBlocked(audio, false));
      this.audioElements.set(key, audio);
      document.body.append(audio);
    }
    audio.srcObject = new MediaStream([track]);
    if (role !== 'systemAudio' || this.canHearSharedAudio(peerId)) void this.playAudio(audio);
    this.onAudioSource({ peerId, role, audio });
    track.addEventListener('ended', () => {
      if (this.audioElements.get(key) === audio && audio.srcObject?.getAudioTracks().includes(track)) {
        this.removeAudio(peerId, role);
      }
    }, { once: true });
  }

  setAudioBlocked(audio, blocked) {
    const wasBlocked = this.blockedAudio.size > 0;
    if (blocked) this.blockedAudio.add(audio);
    else this.blockedAudio.delete(audio);
    if (wasBlocked !== (this.blockedAudio.size > 0)) {
      this.onState({ state: this.blockedAudio.size ? 'autoplay_blocked' : 'autoplay_resumed' });
    }
  }

  async playAudio(audio) {
    const attempt = {};
    audio.playAttempt = attempt;
    const stream = audio.srcObject;
    const key = `${audio.dataset.sourcePeerId}:${audio.dataset.trackRole}`;
    const isCurrent = () => this.audioElements.get(key) === audio && audio.playAttempt === attempt &&
      audio.srcObject === stream && (audio.dataset.trackRole !== 'systemAudio' || this.canHearSharedAudio(audio.dataset.sourcePeerId));
    try {
      await audio.play();
      if (isCurrent()) this.setAudioBlocked(audio, false);
    } catch (error) {
      if (isCurrent() && error?.name === 'NotAllowedError') this.setAudioBlocked(audio, true);
    }
  }

  removeAudio(peerId, role) {
    const key = `${peerId}:${role}`, audio = this.audioElements.get(key);
    if (!audio) return;
    this.audioElements.delete(key);
    audio.pause?.();
    audio.remove();
    this.setAudioBlocked(audio, false);
    this.onState({ state: 'audio_source_ended', peerId, role });
  }

  async resumeAudio() {
    await Promise.all([...this.blockedAudio].map(audio => this.playAudio(audio)));
    return this.blockedAudio.size === 0;
  }

  publishMediaState() {
    if (!this.ownsPresentation) return;
    this.client.sendUnacknowledged('media.state', {
      screenSharing: !!this.screenVideoTrack,
      hasScreenVideo: !!this.screenVideoTrack,
      hasSystemAudio: this.captureMode === 'combined' && !!this.systemAudioTrack,
      isolationStatus: this.isolation.state,
    });
    if (!this.screenVideoTrack) this.ownsPresentation = false;
  }

  canHearSharedAudio(peerId) { return this.hasSystemAudio && !this.voiceOnly && peerId === this.presenterPeerId; }

  setPresenter(peerId, hasSystemAudio = this.client.room?.hasSystemAudio ?? this.hasSystemAudio) {
    this.presenterPeerId = peerId ?? '';
    this.hasSystemAudio = hasSystemAudio === true;
    if (this.usesScreenRelay) this.relay.syncPresenter(this.presenterPeerId, this.hasSystemAudio);
    for (const audio of this.audioElements.values()) if (audio.dataset?.trackRole === 'systemAudio') {
      const available = this.canHearSharedAudio(audio.dataset.sourcePeerId);
      const wasMuted = audio.muted;
      audio.muted = audio.userMuted === true || !available;
      if (!available) this.setAudioBlocked(audio, false);
      else if (wasMuted && !audio.muted && audio.paused) void this.playAudio(audio);
    }
  }

  setVoiceOnly(value) {
    this.voiceOnly = !!value;
    this.setPresenter(this.presenterPeerId);
    for (const stream of this.remoteScreens.values()) for (const track of stream.getVideoTracks()) track.enabled = !this.voiceOnly;
  }

  async getStatsSnapshot({ peerIds = null, videoOnly = false, isCurrent = () => true } = {}) {
    const snapshots = [];
    const currentPeers = () => this.usesScreenRelay && videoOnly ? this.relay.statsPeers() : this.peers;
    const available = currentPeers();
    const peers = peerIds === null ? [...available] : [...new Set(peerIds)].filter(id => available.has(id)).map(id => [id, available.get(id)]);
    const readings = await Promise.all(peers.map(async ([peerId, peer]) => {
      try { return { peerId, peer, reports: await peer.pc.getStats() }; }
      catch (error) { if (currentPeers().get(peerId) !== peer) return null; throw error; }
    }));
    if (!isCurrent()) return snapshots;
    for (const reading of readings) {
      if (!reading || currentPeers().get(reading.peerId) !== reading.peer) continue;
      const { peerId, reports } = reading;
      const remoteInboundByLocalId = new Map([...reports.values()]
        .filter(report => report.type === 'remote-inbound-rtp' && report.localId).map(report => [report.localId, report]));
      for (const report of reports.values()) {
        if (report.type !== 'outbound-rtp' && report.type !== 'inbound-rtp') continue;
        const role = report.kind === 'video' || report.mediaType === 'video' ? 'screenVideo' : 'audio';
        if (videoOnly && role !== 'screenVideo') continue;
        const key = `${peerId}:${report.id}`;
        const now = report.timestamp ?? performance.now();
        const bytes = report.bytesSent ?? report.bytesReceived;
        const last = this.statsPrevious.get(key);
        const sameStream = last?.peer === reading.peer && last.report.ssrc === report.ssrc && last.report.codecId === report.codecId;
        // A replacement stream can reuse a report ID. Do not bridge its first
        // sample to the retired stream, or turn a counter reset into zero Mbps.
        const previous = sameStream && now > last.time && !(bytes < last.bytes) ? last : null;
        const elapsed = previous ? (now - previous.time) / 1000 : null;
        const priorReport = previous?.report;
        const outbound = report.type === 'outbound-rtp';
        const frames = outbound ? report.framesSent ?? report.framesEncoded : report.framesDecoded;
        const qpFrameField = outbound ? 'framesEncoded' : 'framesDecoded';
        const qpFramesDelta = counterDelta(report[qpFrameField], priorReport?.[qpFrameField]);
        const qpSumDelta = counterDelta(report.qpSum, priorReport?.qpSum);
        const averageQp = qpFramesDelta > 0 && qpSumDelta !== null ? qpSumDelta / qpFramesDelta : null;
        const remote = outbound && (reports.get(report.remoteId) ?? remoteInboundByLocalId.get(report.id));
        const packetsLost = outbound ? remote?.packetsLost : report.packetsLost;
        // RTP loss is signed. Late packets can reduce net loss within the
        // same stream even while all packet and byte counters keep advancing.
        const sameLossReport = previous && remote?.id === previous.remoteId;
        const packetsLostDelta = sameLossReport && Number.isFinite(packetsLost) && Number.isFinite(previous.packetsLost)
          ? packetsLost - previous.packetsLost : null;
        const measuredFrames = counterDelta(frames, previous?.frames);
        const measuredFps = measuredFrames !== null ? measuredFrames / elapsed : null;
        const bytesDelta = counterDelta(bytes, previous?.bytes);
        const bitrate = bytesDelta !== null ? bytesDelta * 8 / elapsed : null;
        const source = report.mediaSourceId ? reports.get(report.mediaSourceId) : null;
        const sourceTime = source?.timestamp ?? now;
        const sourceDelta = previous && report.mediaSourceId === priorReport.mediaSourceId && sourceTime > previous.sourceTime && Number.isFinite(source?.frames) && Number.isFinite(previous.sourceFrames) && source.frames >= previous.sourceFrames
          ? (source.frames - previous.sourceFrames) * 1000 / (sourceTime - previous.sourceTime) : null;
        const encodedFramesDelta = outbound ? qpFramesDelta : null;
        const encodeTimeDelta = counterDelta(report.totalEncodeTime, priorReport?.totalEncodeTime);
        const qualityLimitationDurations = {}, qualityLimitationDurationsDelta = {};
        for (const reason of ['none', 'cpu', 'bandwidth', 'other']) {
          const duration = report.qualityLimitationDurations?.[reason];
          if (!Number.isFinite(duration) || duration < 0) continue;
          qualityLimitationDurations[reason] = duration;
          const delta = counterDelta(duration, priorReport?.qualityLimitationDurations?.[reason]);
          if (delta !== null) qualityLimitationDurationsDelta[reason] = delta;
        }
        const cpuDelta = qualityLimitationDurationsDelta.cpu;
        const frameSize = report.frameWidth > 0 && report.frameHeight > 0
          ? { width: report.frameWidth, height: report.frameHeight } : previous?.frameSize;
        if (!sameStream || now >= last.time) this.statsPrevious.set(key, {
          peer: reading.peer, report, time: now, bytes, frames, sourceTime, sourceFrames: source?.frames, frameSize, packetsLost, remoteId: remote?.id,
        });
        const codec = report.codecId ? reports.get(report.codecId) : null;
        const transport = report.transportId ? reports.get(report.transportId) : null;
        const pair = transport?.selectedCandidatePairId ? reports.get(transport.selectedCandidatePairId) : null;
        const rtt = pair?.currentRoundTripTime;
        snapshots.push({ peerId, localRelay:reading.peer.localRelay === true, direction: report.type, role, width: report.frameWidth, height: report.frameHeight, lastFrameSize: frameSize, fps: report.framesPerSecond ?? measuredFps, bitrate, droppedFrames: report.framesDropped ?? report.framesDiscarded,
          keyFramesEncoded: outbound ? report.keyFramesEncoded : undefined,
          keyFramesDecoded: outbound ? undefined : report.keyFramesDecoded,
          averageQp, packetsLost, packetsLostDelta,
          keyFramesEncodedDelta: counterDelta(report.keyFramesEncoded, priorReport?.keyFramesEncoded),
          keyFramesDecodedDelta: counterDelta(report.keyFramesDecoded, priorReport?.keyFramesDecoded),
          nackCount: report.nackCount, nackCountDelta: counterDelta(report.nackCount, priorReport?.nackCount),
          pliCount: report.pliCount, pliCountDelta: counterDelta(report.pliCount, priorReport?.pliCount),
          firCount: report.firCount, firCountDelta: counterDelta(report.firCount, priorReport?.firCount),
          retransmittedPacketsSent: report.retransmittedPacketsSent,
          retransmittedPacketsSentDelta: counterDelta(report.retransmittedPacketsSent, priorReport?.retransmittedPacketsSent),
          sourceFps: source?.framesPerSecond ?? sourceDelta,
          intervalFps: measuredFps, sourceIntervalFps: sourceDelta, sampleIntervalSeconds: elapsed,
          ...videoCodecStats(codec),
          encoderImplementation: outbound && typeof report.encoderImplementation === 'string' ? report.encoderImplementation : undefined,
          decoderImplementation: !outbound && typeof report.decoderImplementation === 'string' ? report.decoderImplementation : undefined,
          powerEfficientEncoder: outbound && typeof report.powerEfficientEncoder === 'boolean' ? report.powerEfficientEncoder : undefined,
          powerEfficientDecoder: !outbound && typeof report.powerEfficientDecoder === 'boolean' ? report.powerEfficientDecoder : undefined,
          averageEncodeMs: Number.isFinite(report.totalEncodeTime) && report.framesEncoded > 0 ? report.totalEncodeTime * 1000 / report.framesEncoded : null,
          encodedFramesDelta, intervalEncodeMs: encodedFramesDelta > 0 && encodeTimeDelta !== null ? encodeTimeDelta * 1000 / encodedFramesDelta : null,
          encodeTimeRatio: elapsed && encodeTimeDelta !== null ? encodeTimeDelta / elapsed : null,
          cpuLimitedRatio: Number.isFinite(cpuDelta) ? Math.min(1, cpuDelta / elapsed) : null,
          qualityLimitationReason: ['none', 'cpu', 'bandwidth', 'other'].includes(report.qualityLimitationReason) ? report.qualityLimitationReason : null,
          qualityLimitationDurations, qualityLimitationDurationsDelta,
          targetBitrate: outbound && Number.isFinite(report.targetBitrate) ? report.targetBitrate : null,
          availableOutgoingBitrate: pair?.availableOutgoingBitrate ?? null,
          currentRoundTripTime: rtt ?? null,
          currentRoundTripTimeMs: Number.isFinite(rtt) ? rtt * 1000 : null,
        });
      }
    }
    return snapshots;
  }

  async closePeer(peerId) {
    // Media reconnects close the transport while the member still owns a seat.
    const departed = !this.client.room?.members?.some(member => member.peerId === peerId);
    const peer = this.peers.get(peerId);
    if (!peer) {
      if (this.usesScreenRelay && departed) this.relay.removePeer(peerId);
      return;
    }
    this.closeVoicePeer(peer, peerId);
    let sourceClosed;
    if (this.usesScreenRelay) { this.relay.removePeer(peerId, departed); if (!this.peers.size) sourceClosed = this.relay.stopTransport(); }
    this.onState({ state: 'peer_closed', peerId });
    await sourceClosed;
  }

  async closeAll() {
    this.captureGeneration += 1;
    this.cancelMicrophoneCapture();
    const relayClosed = this.relay.close();
    this.statsPrevious.clear();
    const captured = new Set([this.claimingStream,this.preparingScreenStream,this.screenStream,this.pendingScreenStream].flatMap(stream => stream?.getTracks?.() ?? []));
    if (this.microphoneTrack) captured.add(this.microphoneTrack);
    this.claimingStream = null;
    this.preparingScreenStream = null;
    this.captureAttempt = null;
    this.screenStream = null; this.pendingScreenStream = null; this.screenVideoTrack = null; this.systemAudioTrack = null; this.microphoneTrack = null;
    this.captureMode = 'limited';
    this.ownsPresentation = false;
    this.presenterPeerId = '';
    this.hasSystemAudio = false;
    this.remoteScreens.clear();
    this.voiceOnly = false;
    this.isolation = { state: 'unverified', label: '未验证', verified: false };
    // Release capture synchronously and clear ownership before any network wait.
    // Reentrant leave/close events cannot stop a track twice or clear a new room.
    const peersClosed = [...this.peers.keys()].map((peerId) => this.closePeer(peerId));
    captured.forEach(track => track.stop?.());
    this.onState({ state: 'closed', isolation: this.isolation });
    await Promise.all([...peersClosed,relayClosed]);
  }
}
