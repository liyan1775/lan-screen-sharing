import { isolationStatus } from './state.js';
import { prepareSystemAudioIsolation } from './system-audio-isolation.js';
import { RoomText } from './room-text.js';
import { ScreenRelay } from './screen-relay.js';

const QUALITY = Object.freeze({
  '1080p60': { width: 1920, height: 1080, fps: 60, bitrate: 8_000_000 },
  '720p60': { width: 1280, height: 720, fps: 60, bitrate: 5_000_000 },
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

export class MeshMedia extends EventTarget {
  constructor(roomClient, { onRemoteTrack = () => {}, onState = () => {}, onAudioSource = () => {}, onText = () => {} } = {}) {
    super();
    this.client = roomClient;
    this.onRemoteTrack = onRemoteTrack;
    this.onState = onState;
    this.onAudioSource = onAudioSource;
    this.text = new RoomText({onMessage:onText, onChange:() => this.onState({state:'text_connection'})});
    this.selfPeerId = '';
    this.selfRole = '';
    this.peers = new Map();
    this.screenStream = null;
    this.pendingScreenStream = null;
    this.screenVideoTrack = null;
    this.systemAudioTrack = null;
    this.microphoneTrack = null;
    this.captureMode = 'limited';
    this.isolation = isolationStatus({ supported: false });
    this.quality = '1080p60';
    this.pauseBackgroundPreview = true;
    this.audioElements = new Map();
    this.statsPrevious = new Map();
    this.captureGeneration = 0;
    this.ownsPresentation = false;
    this.presenterPeerId = '';
    this.remoteScreens = new Map();
    this.voiceOnly = false;
    this.captureAttempt = null;
    this.claimingStream = null;
    this.preparingScreenStream = null;
    this.systemAudioDiagnostics = null;
    this.shareCursor = false;
    this.relay = new ScreenRelay(roomClient, {
      peerIds:() => [...this.peers.keys()], presenter:() => this.presenterPeerId,
      applyQuality:sender => this.applyVideoQuality(sender), onTrack:(id,role,track) => this.receiveTrack(id,role,track),
      onViewClosed:id => {
        this.remoteScreens.delete(id);
        const audio=this.audioElements.get(`${id}:systemAudio`); audio?.pause(); audio?.remove(); this.audioElements.delete(`${id}:systemAudio`);
        this.onState({state:'audio_source_ended',peerId:id,role:'systemAudio'});
        this.onState({state:'remote_screen_ended',peerId:id});
      },
      onError:error => this.onState({state:'screen_relay_error',message:error.message}),
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
    const shouldOffer = isHostViewerPair ? this.selfRole === 'host' : this.selfPeerId.localeCompare(peerId) < 0;
    const pc = new RTCPeerConnection({ iceServers: [] });
    const peer = { peerId, role, pc, remoteRoles: new Map(), localRoles: new Map(), candidates: [], negotiation: Promise.resolve(), offerQueued: false, state: 'connecting' };
    this.peers.set(peerId, peer);

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
      void peer.voiceSender.replaceTrack(this.microphoneTrack).catch(() => {});
      {
        void peer.screenSender.replaceTrack(this.usesScreenRelay ? null : this.screenVideoTrack).catch(() => {});
        void peer.systemAudioSender.replaceTrack(!this.usesScreenRelay && this.captureMode === 'combined' ? this.systemAudioTrack : null).catch(() => {});
        this.applyVideoQuality(peer.screenSender);
      }
    }

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.client.sendSignal('rtc.candidate', peerId, { candidate: candidate.toJSON() });
    };
    pc.ontrack = (event) => {
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
    pc.onconnectionstatechange = () => {
      peer.state = pc.connectionState;
      this.onState({ peerId, state: peer.state });
      if (pc.connectionState === 'failed') this.onState({ peerId, state: 'ICE_FAILED', message: '与成员的点对点连接失败；请确认两台设备在同一局域网。' });
    };

    this.text.addPeer(peerId, pc, shouldOffer);
    if (shouldOffer) void this.negotiate(peer);
    if (this.usesScreenRelay && this.screenVideoTrack) void this.relay.start(this.screenVideoTrack,this.systemAudioTrack).then(() => this.relay.announce(peerId)).catch(error => this.relay.onError(error));
    return peer;
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
      const track = role === 'microphone' ? this.microphoneTrack : this.usesScreenRelay ? null
        : role === 'screenVideo' ? this.screenVideoTrack
          : role === 'systemAudio' && this.captureMode === 'combined' ? this.systemAudioTrack
            : null;
      return transceiver.sender.replaceTrack(track);
    }));
    if (peer.screenSender) this.applyVideoQuality(peer.screenSender);
  }

  async negotiate(peer) {
    peer.negotiation = peer.negotiation.then(async () => {
      if (peer.pc.signalingState !== 'stable') { peer.offerQueued = true; return; }
      peer.offerQueued = false;
      try {
        if (this.peers.get(peer.peerId) !== peer) return;
        const offer = await peer.pc.createOffer();
        await peer.pc.setLocalDescription(offer);
        this.client.sendSignal('rtc.description', peer.peerId, { description: peer.pc.localDescription.toJSON(), tracks: readTrackRoleMap(peer.pc.getTransceivers()) });
      } catch (error) {
        this.onState({ peerId: peer.peerId, state: 'signaling_error', message: '无法建立媒体连接。' });
      }
    });
    return peer.negotiation;
  }

  async handleSignal(type, payload) {
    if (type.startsWith('screen.')) { if (this.usesScreenRelay) await this.relay.handle(type,payload); return; }
    const peerId = payload.fromPeerId;
    const peer = this.peers.get(peerId) ?? this.addPeer(peerId, 'viewer');
    if (!peer) return;
    if (type === 'rtc.candidate') {
      const candidate = payload.candidate;
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(candidate);
      else peer.candidates.push(candidate);
      return;
    }
    if (type !== 'rtc.description') return;
    for (const item of payload.tracks ?? []) peer.remoteRoles.set(item.mid, item.role);
    const description = payload.description;
    await peer.pc.setRemoteDescription(description);
    for (const candidate of peer.candidates.splice(0)) await peer.pc.addIceCandidate(candidate);
    if (description.type === 'offer') {
      await this.bindAnswererTransceivers(peer, payload.tracks);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      this.client.sendSignal('rtc.description', peerId, { description: peer.pc.localDescription.toJSON(), tracks: readTrackRoleMap(peer.pc.getTransceivers()) });
      if (peer.offerQueued) void this.negotiate(peer);
    }
  }

  async setScreenStream(stream, { mode = 'limited', isolation = this.isolation } = {}) {
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
    if (this.screenVideoTrack) await this.applyCaptureQuality();
    if (generation !== this.captureGeneration || this.screenStream !== stream) return;
    if (this.screenVideoTrack) {
      const capturedTrack = this.screenVideoTrack;
      capturedTrack.addEventListener('ended', () => { if (this.screenVideoTrack === capturedTrack) void this.setScreenStream(null); }, { once: true });
    }
    try {
      if (this.usesScreenRelay) {
        if (this.screenVideoTrack && this.peers.size) await this.relay.start(this.screenVideoTrack,this.systemAudioTrack);
        else await this.relay.stopSource();
      } else await Promise.all([...this.peers.values()].map(async (peer) => {
        if (!peer.screenSender) return;
        await peer.screenSender.replaceTrack(this.screenVideoTrack);
        await peer.systemAudioSender.replaceTrack(mode === 'combined' ? this.systemAudioTrack : null);
        if (this.screenVideoTrack) await this.applyVideoQuality(peer.screenSender);
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
    this.publishMediaState();
    if (this.usesScreenRelay && stream) this.relay.announce();
    this.publishQualityState();
    this.onState({ state: stream ? 'screen_started' : 'screen_stopped' });
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

  async discardPendingScreen() {
    const stream = this.pendingScreenStream;
    this.pendingScreenStream = null;
    stream?.getTracks?.().forEach((track) => track.stop());
    this.isolation = { state: 'unverified', label: '未验证', verified: false };
    return !!stream;
  }

  async setSystemAudioTrack(track) {
    const previousTrack = this.systemAudioTrack;
    this.systemAudioTrack = track;
    if (!track) this.captureMode = 'limited';
    try {
      if (this.usesScreenRelay) await this.relay.updateAudio(this.captureMode === 'combined' ? track : null);
      else await Promise.all([...this.peers.values()].filter((peer) => peer.systemAudioSender).map((peer) => peer.systemAudioSender.replaceTrack(this.captureMode === 'combined' ? track : null)));
    } finally {
      if (previousTrack && previousTrack !== track) previousTrack.stop();
      this.publishMediaState();
    }
  }

  async setMicrophoneTrack(track) {
    this.microphoneTrack = track;
    await Promise.all([...this.peers.values()].map((peer) => peer.voiceSender?.replaceTrack(track)));
    this.publishMediaState();
  }

  async setMicrophoneFromCapture(capturePromise) {
    const captureGeneration = this.captureGeneration;
    const stream = await capturePromise;
    if (captureGeneration !== this.captureGeneration) {
      stream.getTracks?.().forEach((track) => track.stop());
      throw Object.assign(new Error('本机信令已关闭，麦克风捕获已取消。'), { code: 'CAPTURE_CANCELLED' });
    }
    const track = stream.getAudioTracks?.()[0];
    if (!track) throw new Error('麦克风没有返回音频轨道。');
    await this.setMicrophoneTrack(track);
    if (captureGeneration !== this.captureGeneration) {
      stream.getTracks?.().forEach((item) => item.stop());
      throw Object.assign(new Error('本机信令已关闭，麦克风捕获已取消。'), { code: 'CAPTURE_CANCELLED' });
    }
    return { stream, track };
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
    if (this.pendingScreenStream) throw Object.assign(new Error('请先选择无游戏声音共享或取消当前屏幕捕获。'), { code: 'PENDING_SCREEN_CAPTURE' });
    const captureGeneration = this.captureGeneration;
    if (!navigator.mediaDevices?.getDisplayMedia) throw Object.assign(new Error('屏幕采集不可用'), { code: 'SYSTEM_AUDIO_UNSUPPORTED' });
    const supported = navigator.mediaDevices.getSupportedConstraints?.() ?? {};
    const constraints = mode === 'combined'
      ? { video: { displaySurface: 'monitor', ...captureVideoConstraints(this.quality, this.shareCursor) }, audio: supported.restrictOwnAudio ? { restrictOwnAudio: true } : true, systemAudio: 'include' }
      : { video: { displaySurface: 'monitor', ...captureVideoConstraints(this.quality, this.shareCursor) }, audio: false };
    const capturePromise = navigator.mediaDevices.getDisplayMedia(constraints);
    const stream = await capturePromise;
    if (captureGeneration !== this.captureGeneration) {
      stream.getTracks().forEach((track) => track.stop());
      throw Object.assign(new Error('本机信令已关闭，屏幕捕获已取消。'), { code: 'CAPTURE_CANCELLED' });
    }
    const videoTrack = stream.getVideoTracks()[0];
    const surface = videoTrack?.getSettings?.().displaySurface;
    if (surface !== 'monitor') {
      stream.getTracks().forEach((track) => track.stop());
      this.onState({ state: 'DISPLAY_NOT_MONITOR', message: '检测到窗口或浏览器标签页，请重新选择整块显示器。' });
      throw Object.assign(new Error('请选择显示器'), { code: 'DISPLAY_NOT_MONITOR' });
    }
    const systemAudioTrack = stream.getAudioTracks()[0];
    try { videoTrack.contentHint = 'motion'; } catch { /* Optional browser hint. */ }
    if (mode === 'combined' && (!systemAudioTrack || systemAudioTrack.readyState === 'ended')) {
      this.pendingScreenStream = stream;
      this.isolation = isolationStatus({ supported: !!supported.restrictOwnAudio, requested: true, settings: {}, missingAudio: true });
      this.onState({ state: 'missing_audio', message: '未捕获屏幕音频；画面尚未共享，请明确选择无游戏声音模式或取消。' });
      return { stream, mode: 'pending', captureState: 'missing_audio', isolation: this.isolation, hasSystemAudio: false };
    }
    this.isolation = { state: 'unverified', label: '未验证', verified: false };
    if (mode === 'combined') {
      this.preparingScreenStream = stream;
      let result;
      try { result = await prepareSystemAudioIsolation(systemAudioTrack, !!supported.restrictOwnAudio); }
      finally { if (this.preparingScreenStream === stream) this.preparingScreenStream = null; }
      if (captureGeneration !== this.captureGeneration || videoTrack.readyState === 'ended') {
        stream.getTracks().forEach((track) => track.stop());
        throw Object.assign(new Error('房间已离开，已取消声音隔离检查。'), { code: 'CAPTURE_CANCELLED' });
      }
      this.isolation = result.isolation;
      this.systemAudioDiagnostics = result.diagnostics;
      this.onState({ state: 'audio_isolation', diagnostics: result.diagnostics });
    }
    await this.setScreenStream(stream, { mode, isolation: this.isolation });
    if (captureGeneration !== this.captureGeneration) {
      stream.getTracks().forEach((track) => track.stop());
      throw Object.assign(new Error('本机信令已关闭，屏幕捕获已取消。'), { code: 'CAPTURE_CANCELLED' });
    }
    return { stream, mode, captureState: 'ready', isolation: this.isolation, hasSystemAudio: stream.getAudioTracks().length > 0 };
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
    this.onState({ state: 'quality', target: this.quality, targetText: `目标 ${this.quality} · 初始发送参数，实际效果以统计为准` });
  }

  async applyVideoQuality(sender) {
    if (!sender?.getParameters || !sender?.setParameters) return false;
    try {
      const target = QUALITY[this.quality];
      const parameters = sender.getParameters();
      const source = this.screenVideoTrack?.getSettings?.() ?? {};
      const scale = Math.max(1, (source.width ?? target.width) / target.width, (source.height ?? target.height) / target.height);
      const current = parameters.encodings?.[0];
      if (parameters.degradationPreference === 'maintain-framerate' && current?.maxBitrate === target.bitrate
        && current.maxFramerate === target.fps && current.scaleResolutionDownBy === scale) return true;
      parameters.degradationPreference = 'maintain-framerate';
      if (!parameters.encodings?.length) parameters.encodings = [{}];
      parameters.encodings[0].maxBitrate = target.bitrate;
      parameters.encodings[0].maxFramerate = target.fps;
      parameters.encodings[0].scaleResolutionDownBy = scale;
      try { await sender.setParameters(parameters); }
      catch {
        // Keep basic bitrate/FPS targets if the browser rejects the preference.
        const fallback = sender.getParameters();
        if (!fallback.encodings?.length) fallback.encodings = [{}];
        Object.assign(fallback.encodings[0], parameters.encodings[0]);
        await sender.setParameters(fallback);
        this.onState({ state: 'quality_preference_unsupported', message: '浏览器未接受帧率优先策略，已保留基本画质设置；请以实际统计为准。' });
      }
      return true;
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
    if (muted != null) { audio.userMuted = !!muted; audio.muted = !!muted || (role === 'systemAudio' && (this.voiceOnly || peerId !== this.presenterPeerId)); }
    if (volume != null) audio.volume = Math.max(0, Math.min(1, Number(volume)));
    return true;
  }

  attachAudio(peerId, role, track) {
    const key = `${peerId}:${role}`;
    let audio = this.audioElements.get(key);
    if (!audio) {
      audio = document.createElement('audio');
      audio.autoplay = true;
      audio.playsInline = true;
      audio.muted = role === 'systemAudio' && (this.voiceOnly || peerId !== this.presenterPeerId);
      audio.dataset.sourcePeerId = peerId;
      audio.dataset.trackRole = role;
      audio.srcObject = new MediaStream([track]);
      this.audioElements.set(key, audio);
      document.body.append(audio);
      audio.play().catch(() => this.onState({ state: 'autoplay_blocked', message: '浏览器阻止了语音播放，请点“启用声音”。' }));
      this.onAudioSource({ peerId, role, audio });
    } else audio.srcObject = new MediaStream([track]);
    track.addEventListener('ended', () => {
      if (this.audioElements.get(key) === audio && audio.srcObject?.getAudioTracks().includes(track)) {
        audio.remove(); this.audioElements.delete(key);
        this.onState({state:'audio_source_ended',peerId,role});
      }
    }, { once: true });
  }

  async resumeAudio() {
    const results = await Promise.all([...this.audioElements.values()].map((audio) => audio.play().then(() => true, () => false)));
    return results.every(Boolean);
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

  setPresenter(peerId) {
    this.presenterPeerId = peerId ?? '';
    if (this.usesScreenRelay) this.relay.syncPresenter(this.presenterPeerId);
    for (const audio of this.audioElements.values()) if (audio.dataset?.trackRole === 'systemAudio') {
      audio.muted = audio.userMuted === true || this.voiceOnly || audio.dataset.sourcePeerId !== this.presenterPeerId;
    }
  }

  setVoiceOnly(value) {
    this.voiceOnly = !!value;
    this.setPresenter(this.presenterPeerId);
    for (const stream of this.remoteScreens.values()) for (const track of stream.getVideoTracks()) track.enabled = !this.voiceOnly;
  }

  async getStatsSnapshot({ peerIds = null, videoOnly = false } = {}) {
    const snapshots = [];
    const currentPeers = () => this.usesScreenRelay && videoOnly ? this.relay.statsPeers() : this.peers;
    const available = currentPeers();
    const peers = peerIds === null ? [...available] : [...new Set(peerIds)].filter(id => available.has(id)).map(id => [id, available.get(id)]);
    const readings = await Promise.all(peers.map(async ([peerId, peer]) => {
      try { return { peerId, peer, reports: await peer.pc.getStats() }; }
      catch (error) { if (currentPeers().get(peerId) !== peer) return null; throw error; }
    }));
    for (const reading of readings) {
      if (!reading || currentPeers().get(reading.peerId) !== reading.peer) continue;
      const { peerId, reports } = reading;
      for (const report of reports.values()) {
        if (report.type !== 'outbound-rtp' && report.type !== 'inbound-rtp') continue;
        const role = report.kind === 'video' || report.mediaType === 'video' ? 'screenVideo' : 'audio';
        if (videoOnly && role !== 'screenVideo') continue;
        const key = `${peerId}:${report.id}`;
        const previous = this.statsPrevious.get(key);
        const now = report.timestamp ?? performance.now();
        const bytes = report.bytesSent ?? report.bytesReceived;
        const frames = report.type === 'outbound-rtp' ? report.framesSent ?? report.framesEncoded : report.framesDecoded;
        const elapsed = previous && now > previous.time ? (now - previous.time) / 1000 : null;
        const measuredFps = elapsed && Number.isFinite(frames) && Number.isFinite(previous.frames) && frames >= previous.frames ? (frames - previous.frames) / elapsed : null;
        const bitrate = previous && now > previous.time ? Math.max(0, ((bytes - previous.bytes) * 8 * 1000) / (now - previous.time)) : null;
        const source = report.mediaSourceId ? reports.get(report.mediaSourceId) : null;
        const sourceTime = source?.timestamp ?? now;
        const sourceDelta = previous && sourceTime > previous.sourceTime && Number.isFinite(source?.frames) && Number.isFinite(previous.sourceFrames) && source.frames >= previous.sourceFrames
          ? (source.frames - previous.sourceFrames) * 1000 / (sourceTime - previous.sourceTime) : null;
        const encodedFramesDelta = previous && Number.isFinite(previous.framesEncoded) && report.framesEncoded >= previous.framesEncoded ? report.framesEncoded - previous.framesEncoded : null;
        const encodeTimeDelta = previous && Number.isFinite(previous.totalEncodeTime) && report.totalEncodeTime >= previous.totalEncodeTime ? report.totalEncodeTime - previous.totalEncodeTime : null;
        const cpuTime = report.qualityLimitationDurations?.cpu;
        const cpuDelta = previous && Number.isFinite(previous.cpuTime) && cpuTime >= previous.cpuTime ? cpuTime - previous.cpuTime : null;
        this.statsPrevious.set(key, { time: now, bytes, frames, sourceTime, sourceFrames: source?.frames, framesEncoded: report.framesEncoded, totalEncodeTime: report.totalEncodeTime, cpuTime });
        const codec = report.codecId ? reports.get(report.codecId) : null;
        const transport = report.transportId ? reports.get(report.transportId) : null;
        const pair = transport?.selectedCandidatePairId ? reports.get(transport.selectedCandidatePairId) : null;
        snapshots.push({ peerId, localRelay:reading.peer.localRelay === true, direction: report.type, role, width: report.frameWidth, height: report.frameHeight, fps: report.framesPerSecond ?? measuredFps, bitrate, droppedFrames: report.framesDropped ?? report.framesDiscarded,
          sourceFps: source?.framesPerSecond ?? sourceDelta,
          intervalFps: measuredFps, sourceIntervalFps: sourceDelta, sampleIntervalSeconds: elapsed,
          codec: ['video/VP8', 'video/VP9', 'video/H264', 'video/AV1'].includes(codec?.mimeType) ? codec.mimeType.slice(6) : null,
          powerEfficientEncoder: typeof report.powerEfficientEncoder === 'boolean' ? report.powerEfficientEncoder : null,
          averageEncodeMs: Number.isFinite(report.totalEncodeTime) && report.framesEncoded > 0 ? report.totalEncodeTime * 1000 / report.framesEncoded : null,
          encodedFramesDelta, intervalEncodeMs: encodedFramesDelta > 0 && encodeTimeDelta !== null ? encodeTimeDelta * 1000 / encodedFramesDelta : null,
          encodeTimeRatio: elapsed && encodeTimeDelta !== null ? encodeTimeDelta / elapsed : null,
          cpuLimitedRatio: elapsed && cpuDelta !== null ? Math.min(1, cpuDelta / elapsed) : null,
          qualityLimitationReason: ['none', 'cpu', 'bandwidth', 'other'].includes(report.qualityLimitationReason) ? report.qualityLimitationReason : null,
          availableOutgoingBitrate: pair?.availableOutgoingBitrate ?? null,
        });
      }
    }
    return snapshots;
  }

  async closePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.text.removePeer(peerId);
    peer.pc.close();
    this.peers.delete(peerId);
    let sourceClosed;
    if (this.usesScreenRelay) { this.relay.removePeer(peerId); if (!this.peers.size) sourceClosed = this.relay.stopSource(); }
    this.remoteScreens.delete(peerId);
    for (const key of this.statsPrevious.keys()) if (key.startsWith(`${peerId}:`)) this.statsPrevious.delete(key);
    for (const key of [`${peerId}:microphone`, `${peerId}:systemAudio`]) {
      const audio = this.audioElements.get(key);
      audio?.pause(); audio?.remove(); this.audioElements.delete(key);
    }
    this.onState({ state: 'peer_closed', peerId });
    await sourceClosed;
  }

  async closeAll() {
    this.captureGeneration += 1;
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
