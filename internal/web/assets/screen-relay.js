// One browser encoder feeds the local packet relay. Microphones/text stay on
// the room mesh; received screen tracks still carry the authenticated peer ID.
const CODEC_MISMATCH = 'SCREEN_RELAY_CODEC_MISMATCH';

function h264Config(codec) {
  if (codec.mimeType?.toLowerCase() !== 'video/h264') return null;
  const params = new Map((codec.sdpFmtpLine ?? '').toLowerCase().split(';').map(entry => entry.split('=').map(part => part.trim())));
  const profile = params.get('profile-level-id') ?? '42e01f';
  if (params.get('packetization-mode') !== '1' || !/^(42|4d|64)[0-9a-f]{4}$/.test(profile)) return null;
  const fullRate = parseInt(profile.slice(4), 16) >= 0x2a || (Number(params.get('max-fs')) >= 8160 && Number(params.get('max-mbps')) >= 489600);
  const tier = fullRate ? 0 : params.get('level-asymmetry-allowed') === '1' ? 1 : 2;
  return { profile, tier, rank:tier * 3 + ['64','4d','42'].indexOf(profile.slice(0, 2)) };
}

// This is a hint for one encoder restart. The relay independently validates
// the next offer against the actual upstream codec before forwarding any RTP.
function viewerH264Profiles(sdp) {
  const video = sdp.split(/(?:^|\r?\n)m=/).find(section => /^video [1-9]/i.test(section));
  if (!video) return [];
  const formats = video.split(/\r?\n/, 1)[0].trim().split(/\s+/).slice(3);
  const fmtps = new Map(Array.from(video.matchAll(/^a=fmtp:(\d+) (.+)$/gmi), ([, pt, params]) => [pt, params]));
  const h264 = new Set(Array.from(video.matchAll(/^a=rtpmap:(\d+) H264\/90000\s*$/gmi), ([, pt]) => pt));
  const profiles = new Set();
  for (const pt of formats) {
    if (!h264.has(pt)) continue;
    const config = h264Config({ mimeType:'video/h264', sdpFmtpLine:fmtps.get(pt) });
    if (config) profiles.add(config.profile);
  }
  return [...profiles];
}

// Conservative encoder limits within H.264 Annex A for a viewer that cannot
// decode the original stream. These apply only to the replacement sender.
function compatibleQuality(profile) {
  const level = parseInt(profile.slice(4), 16);
  if (level >= 42) return null;
  if (level >= 40) return { width:1920, height:1080, fps:30, bitrate:20_000_000 };
  if (level >= 32) return { width:1280, height:720, fps:60, bitrate:20_000_000 };
  if (level >= 31) return { width:1280, height:720, fps:30, bitrate:14_000_000 };
  if (level >= 30) return { width:640, height:480, fps:30, bitrate:8_000_000 };
  if (level >= 20) return { width:352, height:288, fps:15, bitrate:768_000 };
  return { width:176, height:144, fps:15, bitrate:64_000 };
}

function negotiatedProfile(codecProfile, viewerProfiles) {
  const sameProfile = viewerProfiles.filter(profile => profile.slice(0, 4) === codecProfile.slice(0, 4)).sort();
  if (!sameProfile.length) return null;
  return codecProfile < sameProfile.at(-1) ? codecProfile : sameProfile.at(-1);
}

function constrainLocalOffer(description, viewerProfiles) {
  const sections = description.sdp.split(/(?=^m=)/m);
  const videoIndex = sections.findIndex(section => /^m=video /.test(section));
  const offered = videoIndex >= 0 && viewerH264Profiles(sections[videoIndex])[0];
  const profile = offered && negotiatedProfile(offered, viewerProfiles);
  if (!profile) throw new Error(CODEC_MISMATCH);
  // Negotiate the lower level with the actual browser encoder before it sees
  // any capture frames. Never rewrite downstream SDP or forwarded RTP.
  sections[videoIndex] = sections[videoIndex].replace(/^(a=fmtp:\d+ )([^\r\n]+)/gmi, (line, prefix, params) =>
    h264Config({mimeType:'video/h264',sdpFmtpLine:params})?.profile === offered
      ? prefix + 'packetization-mode=1;level-asymmetry-allowed=0;profile-level-id=' + profile
      : line);
  return { description:{ ...description, sdp:sections.join('') }, profile };
}

export function preferScreenCodecs(transceiver, capabilities, mode, viewerProfiles = null) {
  try {
    if (typeof transceiver.setCodecPreferences !== 'function') return false;
    const codecs = capabilities?.getCapabilities('video')?.codecs;
    if (!codecs?.length) return false;
    const mime = codec => codec.mimeType?.toLowerCase();
    const ranked = codecs.map(codec => {
      const config = mode === 'h264' ? h264Config(codec) : null;
      let rank = mime(codec) === 'video/vp9' ? 10 : mime(codec) === 'video/vp8' ? 11 : 12;
      if (mode === 'vp8' && mime(codec) === 'video/vp8') rank = 0;
      if (config && (viewerProfiles
        ? negotiatedProfile(config.profile, viewerProfiles)
        : config.tier < 2)) rank = config.rank;
      return { codec, rank };
    });
    if (!ranked.some(item => item.rank < 10)) return 'unavailable';
    ranked.sort((a, b) => a.rank - b.rank);
    if (viewerProfiles) {
      const repair = codecs.filter(codec => ['video/rtx','video/red','video/ulpfec','video/flexfec-03'].includes(mime(codec)));
      transceiver.setCodecPreferences([ranked[0].codec, ...repair]);
    } else transceiver.setCodecPreferences(ranked.map(item => item.codec));
    return true;
  } catch { return false; }
}

export class ScreenRelay {
  constructor(client, { peerIds, presenter, applyQuality, onTrack, onViewClosed, onError, onCodecChange = () => {}, onSourceClosed = () => {} }) {
    Object.assign(this, { client, peerIds, presenter, applyQuality, onTrack, onViewClosed, onError, onCodecChange, onSourceClosed });
    this.share = null;
    this.source = null;
    this.views = new Map();
    this.presenterHasAudio = false;
    this.retiredViewEpochs = new Map();
  }

  async start(video, audio) {
    if (this.share?.video === video) {
      const share = this.share;
      if (!this.source?.started) await (share.operation ?? this.maybeRestore(share) ?? this.runSource(share));
      if (this.share === share) await this.updateAudio(audio);
      return;
    }
    const previous = this.stopSource();
    const share = { video, audio, mode:'h264', incompatibleH264Peers:new Set(), restored:false };
    this.share = share;
    await this.runSource(share, previous);
  }

  runSource(share, previous = this.stopTransport()) {
    const operation = this.openSource(share, previous);
    share.operation = operation;
    const clear = () => { if (share.operation === operation) share.operation = null; };
    void operation.then(clear, clear);
    return operation;
  }

  async openSource(share, previous) {
    if (this.share !== share) return;
    const pc = new RTCPeerConnection({ iceServers: [] });
    const source = { pc, video:share.video, epoch:crypto.randomUUID(), sessionId:'', localRelay:true, abort:new AbortController() };
    this.source = source;
    pc.onconnectionstatechange = () => {
      if (this.source === source && pc.connectionState === 'failed') {
        source.failure = new Error('本机媒体连接中断，请停止后重新共享。');
        if (source.started) {
          void this.stopTransport();
          this.onError(source.failure);
        }
      }
    };
    source.ready = (async () => {
      await previous;
      if (this.source !== source) return;
      const video = pc.addTransceiver('video', { direction:'sendonly' });
      const preference = preferScreenCodecs(video, globalThis.RTCRtpSender, share.mode, share.viewerProfiles);
      if (preference === 'unavailable' || (share.viewerProfiles && preference !== true)) {
        if (share.mode === 'h264') throw new Error(CODEC_MISMATCH);
        throw new Error('当前浏览器无法使用兼容编码 VP8。');
      }
      if (preference === true || share.mode === 'vp8') source.codecMode = share.mode;
      source.videoSender = video.sender;
      source.audioSender = pc.addTransceiver('audio', { direction: 'sendonly' }).sender;
      await this.applyQuality(source.videoSender);
      let description = await completeOffer(pc);
      if (share.viewerProfiles) {
        const constrained = constrainLocalOffer(description, share.viewerProfiles);
        description = constrained.description;
        source.compatibilityProfile = constrained.profile;
        source.qualityLimit = compatibleQuality(constrained.profile);
      }
      if (this.source !== source) return;
      const result = await this.client.requestScreenRelay({ action:'start', description },{signal:source.abort.signal});
      source.sessionId = result.sessionId;
      if (this.source !== source) { await this.client.requestScreenRelay({ action:'stop', sessionId:source.sessionId }); return; }
      await pc.setRemoteDescription(result.description);
      // A new browser transport starts with an Internet-sized bandwidth estimate.
      // Wait for the local receiver's budget before attaching the capture track,
      // so its first frames do not trigger resolution adaptation at startup.
      await waitForLocalBudget(pc, source.abort.signal);
      if (this.source !== source) return;
      if (source.qualityLimit && await this.applyQuality(source.videoSender, {confirm:true}) === false) throw new Error(CODEC_MISMATCH);
      await source.videoSender.replaceTrack(share.video);
      const quality = await this.applyQuality(source.videoSender, { confirm:true });
      if (this.source !== source) return;
      if (quality === false) throw new Error('浏览器未能确认屏幕共享的码率和帧率上限。');
      if (source.codecMode) await confirmEncoder(source);
      if (this.source !== source) return;
      await source.audioSender.replaceTrack(share.audio);
    })();
    try {
      await source.ready;
      if (source.failure) throw source.failure;
      source.started = true;
    } catch (error) {
      if (this.source !== source) return;
      if (share.mode === 'h264' && !share.viewerProfiles && (source.codecMode === 'h264' || error.message === CODEC_MISMATCH)) {
        await this.fallback(share, source);
        return;
      }
      await this.stopTransport();
      throw source.failure ?? error;
    }
  }

  async fallback(share, source, peerId = '', profiles = []) {
    if (this.share !== share || (this.source !== source && share.fallbackSource !== source)) return;
    if (peerId && !this.peerIds().includes(peerId)) return;
    if (peerId) share.incompatibleH264Peers.add(peerId);
    if (share.mode !== 'h264' || share.fallbackSource) return;
    share.fallbackReason = peerId ? 'peer' : 'sharer';
    share.fallbackSource = source;
    const change = { reason:share.fallbackReason, peerId };
    try {
      if (profiles.length && !share.viewerProfiles) {
        share.viewerProfiles = profiles;
        try {
          await this.runSource(share);
          if (this.share === share && this.source?.started) this.announce();
          return;
        } catch {
          if (this.share !== share) return;
          // The browser could not start a common H264 profile. Try VP8 once.
        }
      }
      share.viewerProfiles = null;
      share.mode = 'vp8';
      await this.runSource(share);
      if (this.share !== share || !this.source?.started) return;
      this.publishCodecChange(change);
    } finally {
      delete share.fallbackSource;
      void this.maybeRestore(share)?.catch(this.onError);
    }
  }

  maybeRestore(share) {
    if (this.share !== share || share.video.readyState === 'ended' || !this.peerIds().length
      || share.fallbackSource || share.incompatibleH264Peers.size || share.fallbackReason !== 'peer'
      || share.restored || !share.departedPeerId) return;
    share.restored = true; // One recovery attempt per capture, even if another viewer fails.
    share.mode = 'h264';
    share.viewerProfiles = null;
    const peerId = share.departedPeerId;
    return this.runSource(share).then(() => {
      if (this.share === share && this.source?.started && this.source.codecMode === 'h264') this.publishCodecChange({ reason:'restored', peerId });
    });
  }

  publishCodecChange(change) {
    this.onCodecChange(change);
    this.announce(undefined, change);
  }

  announce(peerId, change) {
    const source = this.source;
    if (!source?.started || source.video.readyState === 'ended') return;
    const payload = { epoch:source.epoch, codecMode:change?.reason === 'restored' ? 'h264' : change ? 'vp8' : source.codecMode };
    if (change) {
      payload.codecChange = change.reason;
      if (change.peerId) payload.codecPeerId = change.peerId;
    }
    for (const id of peerId ? [peerId] : this.peerIds()) this.client.sendSignal('screen.ready', id, payload);
  }

  async updateAudio(track) {
    if (this.share) this.share.audio = track;
    if (this.source?.started) await this.source.audioSender.replaceTrack(track);
  }

  async stopSource() {
    this.share = null;
    await this.stopTransport();
  }

  async stopTransport() {
    const source = this.source; this.source = null;
    if (!source) return;
    this.onSourceClosed();
    source.abort.abort();
    await Promise.allSettled(source.pc.getSenders().map(sender => sender.replaceTrack(null)));
    source.pc.close();
    if (source.sessionId) await this.client.requestScreenRelay({action:'stop',sessionId:source.sessionId}).catch(() => {});
  }

  async handle(type, payload) {
    const peerId = payload.fromPeerId;
    if (!this.peerIds().includes(peerId)) return;
    if (type === 'screen.ready') {
      if (this.presenter() !== peerId) return;
      if (this.views.get(peerId)?.epoch === payload.epoch || this.retiredViewEpochs.get(peerId)?.includes(payload.epoch)) return;
      if (payload.codecChange) this.onCodecChange({ reason:payload.codecChange, peerId:payload.codecPeerId });
      await this.startView(peerId,payload.epoch,payload.codecMode);
      return;
    }
    if (type !== 'screen.description') return;
    if (payload.description.type === 'offer') {
      const source = this.source;
      if (!source || source.epoch !== payload.epoch) return;
      const share = this.share;
      if (payload.codecMismatch) {
        if (source.codecMode === 'h264') await this.fallback(share, source, peerId);
        return;
      }
      await source.ready;
      if (this.source !== source || !source.sessionId || !this.peerIds().includes(peerId)) return;
      let result;
      try {
        result = await this.client.requestScreenRelay({ action:'receiver',sessionId:source.sessionId,peerId,description:payload.description });
      } catch (error) {
        if (source.codecMode === 'h264' && error.code === CODEC_MISMATCH) {
          await this.fallback(share, source, peerId, viewerH264Profiles(payload.description.sdp));
          return;
        }
        if (this.source !== source || !this.peerIds().includes(peerId)) return;
        throw error;
      }
      if (this.source === source && this.peerIds().includes(peerId)) this.client.sendSignal(type,peerId,{epoch:source.epoch,description:result.description});
    } else {
      const view = this.views.get(peerId);
      if (view?.epoch === payload.epoch) await view.pc.setRemoteDescription(payload.description);
    }
  }

  async startView(peerId, epoch, codecMode) {
    const previous = this.views.get(peerId);
    if (previous?.epoch === epoch) return;
    if (previous) {
      const retired = this.retiredViewEpochs.get(peerId) ?? [];
      this.retiredViewEpochs.set(peerId, [...retired.slice(-7), previous.epoch]);
    }
    this.closeView(peerId);
    const pc = new RTCPeerConnection({iceServers:[]});
    const view = {pc,epoch}; this.views.set(peerId,view);
    const video = pc.addTransceiver('video',{direction:'recvonly'});
    if (codecMode) preferScreenCodecs(video, globalThis.RTCRtpReceiver, codecMode);
    pc.addTransceiver('audio',{direction:'recvonly'});
    pc.ontrack = event => {
      if (this.views.get(peerId) !== view) return;
      const isVideo = event.track.kind === 'video';
      if (isVideo && codecMode === 'h264') {
        view.firstFrameCheck = setTimeout(() => void this.checkFirstFrame(peerId, view), 4000);
      }
      if (isVideo) this.onTrack(peerId, 'screenVideo', event.track);
      else {
        // The relay always negotiates an audio slot, even during silent sharing.
        view.audioTrack = event.track;
        this.publishViewAudio(peerId, view);
      }
    };
    pc.onconnectionstatechange = () => {
      if (this.views.get(peerId) === view && pc.connectionState === 'failed') {
        this.closeView(peerId);
        this.onError(new Error('与分享者的媒体连接失败，请停止后重新共享。'));
      }
    };
    try {
      const description = await completeOffer(pc);
      if (this.views.get(peerId) === view && this.presenter() === peerId) this.client.sendSignal('screen.description',peerId,{epoch,description});
    } catch (error) { if (this.views.get(peerId) === view) { this.closeView(peerId); throw error; } }
  }

  async checkFirstFrame(peerId, view) {
    if (this.views.get(peerId) !== view || this.presenter() !== peerId || view.pc.connectionState !== 'connected') return;
    const reports = await view.pc.getStats().catch(() => null);
    if (!reports || this.views.get(peerId) !== view || view.pc.connectionState !== 'connected') return;
    const video = [...reports.values()].find(report => report.type === 'inbound-rtp'
      && (report.kind ?? report.mediaType) === 'video' && report.packetsReceived > 0
      && reports.get(report.codecId)?.mimeType?.toLowerCase() === 'video/h264');
    if (video?.framesDecoded === 0) this.client.sendSignal('screen.description', peerId, {
      epoch:view.epoch, codecMismatch:true, description:{ type:'offer', sdp:'' },
    });
  }

  closeView(peerId) {
    const view = this.views.get(peerId);
    if (!view) return;
    this.views.delete(peerId); clearTimeout(view.firstFrameCheck); view.pc.close(); this.onViewClosed(peerId);
  }

  publishViewAudio(peerId, view) {
    const track = view?.audioTrack;
    if (!this.presenterHasAudio || peerId !== this.presenter() || !track || track.readyState === 'ended' || view.publishedAudio === track) return;
    view.publishedAudio = track;
    this.onTrack(peerId, 'systemAudio', track);
  }

  syncPresenter(peerId, hasSystemAudio = false) {
    this.presenterHasAudio = hasSystemAudio;
    for (const id of this.views.keys()) if (id !== peerId) this.closeView(id);
    for (const id of this.retiredViewEpochs.keys()) if (id !== peerId) this.retiredViewEpochs.delete(id);
    this.publishViewAudio(peerId, this.views.get(peerId));
  }

  removePeer(peerId, departed = true) {
    this.closeView(peerId);
    this.retiredViewEpochs.delete(peerId);
    if (this.source?.sessionId) void this.client.requestScreenRelay({action:'remove',sessionId:this.source.sessionId,peerId}).catch(() => {});
    if (departed && this.share?.incompatibleH264Peers.delete(peerId)) {
      this.share.departedPeerId = peerId;
      void this.maybeRestore(this.share)?.catch(this.onError);
    }
  }

  statsPeers() {
    const peers = new Map(this.views);
    if (this.source?.sessionId) peers.set('$screen-relay',this.source);
    return peers;
  }

  async close() {
    for (const id of this.views.keys()) this.closeView(id);
    this.retiredViewEpochs.clear();
    await this.stopSource();
  }
}

async function completeOffer(pc) {
  await pc.setLocalDescription(await pc.createOffer());
  if (pc.iceGatheringState !== 'complete') await new Promise((resolve,reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error('本机媒体候选收集超时。')); },5000);
    const changed = () => { if (pc.iceGatheringState === 'complete') { cleanup(); resolve(); } };
    const cleanup = () => { clearTimeout(timeout); pc.removeEventListener('icegatheringstatechange',changed); };
    pc.addEventListener('icegatheringstatechange',changed); changed();
  });
  return pc.localDescription.toJSON();
}

async function confirmEncoder(source) {
  // A startup check only. Normal diagnostics use the existing media stats sampler.
  const { width, height } = source.video.getSettings?.() ?? {};
  const scale = source.videoSender.getParameters?.().encodings?.[0]?.scaleResolutionDownBy ?? 1;
  // Chromium can start at full resolution and adapt after its first feedback
  // window. Allow that window to settle for large H264 captures.
  const highResolution = source.codecMode === 'h264' && width * height / (scale * scale) > 1280 * 720;
  for (const delay of highResolution ? [1700, 850] : [350, 1400]) {
    await new Promise(resolve => setTimeout(resolve, delay));
    if (source.abort.signal.aborted) return;
    const reports = await source.pc.getStats();
    for (const report of reports.values()) {
      if (report.type !== 'outbound-rtp' || (report.kind ?? report.mediaType) !== 'video' || !report.framesEncoded) continue;
      const codec = reports.get(report.codecId);
      if (codec?.mimeType?.toLowerCase() !== `video/${source.codecMode}`) {
        throw new Error('浏览器未能启动所选的视频编码。');
      }
      if (source.compatibilityProfile) {
        const actual = h264Config(codec);
        if (!actual || negotiatedProfile(actual.profile, [source.compatibilityProfile]) !== actual.profile) throw new Error(CODEC_MISMATCH);
        if (source.qualityLimit && (report.frameWidth > source.qualityLimit.width || report.frameHeight > source.qualityLimit.height)) continue;
        if (report.frameWidth > 0 && report.frameHeight > 0) return;
        continue;
      }
      if (source.codecMode !== 'h264' || !width || !height
        || (report.frameWidth >= width / scale - 2 && report.frameHeight >= height / scale - 2)) return;
    }
  }
  throw new Error('浏览器未能启动所选的视频编码。');
}

export async function waitForLocalBudget(pc, signal) {
  const deadline = performance.now() + 5000;
  let missingSince;
  while (!signal.aborted && performance.now() < deadline) {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') throw new Error('本机媒体连接已断开，请重新共享。');
    const stats = await pc.getStats();
    const nominated = [...stats.values()].filter(report => report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated);
    if (nominated.some(report => report.availableOutgoingBitrate >= 8_000_000)) return;
    if (nominated.length && nominated.every(report => !Number.isFinite(report.availableOutgoingBitrate))) {
      missingSince ??= performance.now();
      if (performance.now() - missingSince >= 350) return;
    } else missingSince = undefined;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!signal.aborted) throw new Error('本机媒体连接未就绪，请重新共享。');
}
