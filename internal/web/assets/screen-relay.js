// One browser encoder feeds the local packet relay. Microphones/text stay on
// the room mesh; received screen tracks still carry the authenticated peer ID.
export class ScreenRelay {
  constructor(client, { peerIds, presenter, applyQuality, onTrack, onViewClosed, onError }) {
    Object.assign(this, { client, peerIds, presenter, applyQuality, onTrack, onViewClosed, onError });
    this.source = null;
    this.views = new Map();
  }

  async start(video, audio) {
    if (this.source?.video === video) { const current=this.source; await current.ready; if(current.failure) throw current.failure; if(this.source===current) await this.updateAudio(audio); return; }
    const previous = this.stopSource();
    const pc = new RTCPeerConnection({ iceServers: [] });
    const source = { pc, video, epoch: crypto.randomUUID(), sessionId: '', localRelay: true, abort:new AbortController() };
    this.source = source;
    pc.onconnectionstatechange = () => {
      if (this.source === source && pc.connectionState === 'failed') {
        source.failure = new Error('本机媒体连接中断，请停止后重新共享。');
        void this.stopSource();
        this.onError(source.failure);
      }
    };
    source.ready = (async () => {
      await previous;
      if (this.source !== source) return;
      source.videoSender = pc.addTransceiver('video', { direction: 'sendonly' }).sender;
      source.audioSender = pc.addTransceiver('audio', { direction: 'sendonly' }).sender;
      await this.applyQuality(source.videoSender);
      const description = await completeOffer(pc);
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
      await source.videoSender.replaceTrack(video);
      if (this.source !== source) return;
      await source.audioSender.replaceTrack(audio);
    })();
    try { await source.ready; if (source.failure) throw source.failure; }
    catch (error) { if (this.source === source) await this.stopSource(); throw error; }
  }

  announce(peerId) {
    const source = this.source;
    if (!source?.sessionId || source.video.readyState === 'ended') return;
    for (const id of peerId ? [peerId] : this.peerIds()) this.client.sendSignal('screen.ready', id, { epoch:source.epoch });
  }

  async updateAudio(track) { if (this.source?.audioSender) await this.source.audioSender.replaceTrack(track); }

  async stopSource() {
    const source = this.source; this.source = null;
    if (!source) return;
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
      await this.startView(peerId,payload.epoch);
      return;
    }
    if (type !== 'screen.description') return;
    if (payload.description.type === 'offer') {
      const source = this.source;
      if (!source || source.epoch !== payload.epoch) return;
      await source.ready;
      if (this.source !== source || !source.sessionId) return;
      const result = await this.client.requestScreenRelay({ action:'receiver',sessionId:source.sessionId,peerId,description:payload.description });
      if (this.source === source && this.peerIds().includes(peerId)) this.client.sendSignal(type,peerId,{epoch:source.epoch,description:result.description});
    } else {
      const view = this.views.get(peerId);
      if (view?.epoch === payload.epoch) await view.pc.setRemoteDescription(payload.description);
    }
  }

  async startView(peerId, epoch) {
    if (this.views.get(peerId)?.epoch === epoch) return;
    this.closeView(peerId);
    const pc = new RTCPeerConnection({iceServers:[]});
    const view = {pc,epoch}; this.views.set(peerId,view);
    pc.addTransceiver('video',{direction:'recvonly'});
    pc.addTransceiver('audio',{direction:'recvonly'});
    pc.ontrack = event => {
      if (this.views.get(peerId) === view) this.onTrack(peerId,event.track.kind === 'video' ? 'screenVideo' : 'systemAudio',event.track);
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

  closeView(peerId) {
    const view = this.views.get(peerId);
    if (!view) return;
    this.views.delete(peerId); view.pc.close(); this.onViewClosed(peerId);
  }

  syncPresenter(peerId) { for (const id of this.views.keys()) if (id !== peerId) this.closeView(id); }

  removePeer(peerId) {
    this.closeView(peerId);
    if (this.source?.sessionId) void this.client.requestScreenRelay({action:'remove',sessionId:this.source.sessionId,peerId}).catch(() => {});
  }

  statsPeers() {
    const peers = new Map(this.views);
    if (this.source?.sessionId) peers.set('$screen-relay',this.source);
    return peers;
  }

  async close() { for (const id of [...this.views.keys()]) this.closeView(id); await this.stopSource(); }
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

async function waitForLocalBudget(pc, signal) {
  const deadline = performance.now() + 5000;
  while (!signal.aborted && performance.now() < deadline) {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') throw new Error('本机媒体连接已断开，请重新共享。');
    const stats = await pc.getStats();
    if ([...stats.values()].some(report => report.type === 'candidate-pair' && report.state === 'succeeded'
      && report.nominated && report.availableOutgoingBitrate >= 8_000_000)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!signal.aborted) throw new Error('本机媒体连接未就绪，请重新共享。');
}
