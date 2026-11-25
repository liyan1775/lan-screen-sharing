import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshMedia } from '../../internal/web/assets/media.js';

class PeerConnection {
  static sequence = 0;
  id = ++PeerConnection.sequence;
  signalingState = 'stable';
  connectionState = 'new';
  iceConnectionState = 'new';
  transceivers = [];
  addedCandidates = [];
  addTransceiver(kind, { direction }) {
    const sender = { track: null, async replaceTrack(track) { this.track = track; } };
    const tx = { sender, receiver: { track: { kind } }, direction, mid: null };
    this.transceivers.push(tx);
    return tx;
  }
  getTransceivers() { return this.transceivers; }
  createDataChannel() { return { label: 'lan-room-text-v1', close() {} }; }
  sdp() {
    return `v=0\r\na=ice-ufrag:user${this.id}\r\n` + this.transceivers.map(tx => `m=${tx.receiver.track.kind} 9 UDP/TLS/RTP/SAVPF 1\r\n`).join('');
  }
  async createOffer() {
    this.transceivers.forEach((tx, index) => { tx.mid = String(index); });
    return { type: 'offer', sdp: this.sdp() };
  }
  async createAnswer() {
    if (this.stallAnswer) return new Promise(resolve => { this.finishAnswer = resolve; });
    return { type: 'answer', sdp: this.sdp() };
  }
  async setLocalDescription(description) {
    assert.equal(this.signalingState, description.type === 'offer' ? 'stable' : 'have-remote-offer');
    this.localDescription = { toJSON: () => ({ ...description }) };
    this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable';
    this.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: 'candidate:1', usernameFragment: `user${this.id}` }) } });
  }
  async setRemoteDescription(description) {
    assert.doesNotMatch(description.sdp, /x-lan-voice-attempt/);
    if (this.rejectDescription) throw new Error('bad SDP');
    assert.equal(this.signalingState, description.type === 'offer' ? 'stable' : 'have-local-offer');
    this.remoteDescription = description;
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
    if (description.type === 'offer') [...description.sdp.matchAll(/^m=(video|audio)/gm)].forEach(([, kind], index) => {
      this.addTransceiver(kind, { direction: 'recvonly' }).mid = String(index);
    });
  }
  async addIceCandidate(candidate) {
    assert.ok(this.remoteDescription);
    assert.ok(this.remoteDescription.sdp.includes(`a=ice-ufrag:${candidate.usernameFragment}\r\n`));
    this.addedCandidates.push(candidate);
  }
  close() { this.closed = true; this.signalingState = 'closed'; }
  connect() {
    assert.equal(this.signalingState, 'stable');
    this.connectionState = 'connected';
    this.onconnectionstatechange();
  }
}

function fixture(t, members, { screenRelay = false } = {}) {
  const original = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = PeerConnection;
  t.after(() => { globalThis.RTCPeerConnection = original; });
  let time = 0;
  const timers = new Map(), signals = [], pending = [], endpoints = new Map();
  const room = { roomId: 'room', members: Object.entries(members).map(([peerId, role]) => ({ peerId, role })) };
  const net = { drop: () => false };
  function endpoint(id) {
    const states = [];
    const media = new MeshMedia({
      room, bootstrap: { screenRelay },
      sendSignal(type, to, payload) {
        const message = { type, from: id, to, payload: structuredClone(payload) };
        signals.push(message);
        if (!net.drop(message)) pending.push(message);
      },
    }, {
      now: () => time,
      setTimer(fn, delay) { const timer = {}; timers.set(timer, { fn, at: time + delay }); return timer; },
      clearTimer: timer => timers.delete(timer),
      onState: state => states.push(state),
    });
    media.setIdentity(id, members[id]);
    media.microphoneTrack = { kind: 'audio', enabled: true, stop() { assert.fail('retry must keep the local microphone'); } };
    endpoints.set(id, { media, states });
    return media;
  }
  const media = Object.fromEntries(Object.keys(members).map(id => [id, endpoint(id)]));
  function start() {
    for (const [id, endpoint] of Object.entries(media)) {
      for (const [other, role] of Object.entries(members)) if (other !== id) endpoint.addPeer(other, role);
    }
  }
  async function drain() {
    do {
      for (const message of pending.splice(0)) {
        void media[message.to].handleSignal(message.type, { ...message.payload, fromPeerId: message.from });
      }
      await new Promise(resolve => setImmediate(resolve));
    } while (pending.length);
  }
  async function advance(ms) {
    const end = time + ms;
    await drain();
    for (;;) {
      const next = [...timers].sort(([, a], [, b]) => a.at - b.at)[0];
      if (!next || next[1].at > end) break;
      const [timer, { fn, at }] = next;
      time = at;
      timers.delete(timer);
      fn();
      await drain();
    }
    time = end;
  }
  const peer = (from, to) => media[from].peers.get(to);
  const connect = (a, b) => { peer(a, b).pc.connect(); peer(b, a).pc.connect(); };
  const offers = (from, to) => signals.filter(s => s.from === from && s.to === to && s.payload.description?.type === 'offer');
  return { media, endpoints, net, start, drain, advance, peer, connect, offers, signals, timers };
}

test('host offer stuck in have-local-offer is replaced on both endpoints after a timeout', async t => {
  const f = fixture(t, { 'z-host': 'host', 'a-viewer': 'viewer' });
  f.net.drop = s => s.payload.description?.type === 'answer';
  f.start();
  await f.drain();
  const old = f.peer('z-host', 'a-viewer'), oldAnswerer = f.peer('a-viewer', 'z-host');
  const host = f.media['z-host'], video = { kind: 'video' }, audio = { kind: 'audio' };
  host.screenVideoTrack = video;
  host.systemAudioTrack = audio;
  host.captureMode = 'combined';
  assert.equal(old.pc.signalingState, 'have-local-offer');
  const staleAnswer = f.signals.find(s => s.payload.description?.type === 'answer');
  f.net.drop = () => false;
  await f.advance(4000);
  assert.equal(old.voiceStatus, 'retrying');
  assert.equal(old.pc.closed, undefined, 'the designated offerer uses a backoff');
  await f.advance(350);
  const replacement = f.peer('z-host', 'a-viewer');
  assert.notEqual(replacement.pc, old.pc);
  assert.ok(old.pc.closed && oldAnswerer.pc.closed);
  assert.equal(f.offers('z-host', 'a-viewer').length, 2);
  assert.equal(f.offers('a-viewer', 'z-host').length, 0);
  assert.equal(replacement.voiceSender.track, host.microphoneTrack);
  assert.equal(replacement.screenSender.track, video);
  assert.equal(replacement.systemAudioSender.track, audio);
  assert.equal(f.peer('a-viewer', 'z-host').voiceSender.track, f.media['a-viewer'].microphoneTrack);
  assert.notEqual(replacement.attempt, old.attempt);
  const before = replacement.pc.remoteDescription;
  await host.handleSignal('rtc.description', { ...staleAnswer.payload, fromPeerId: 'a-viewer' });
  await host.handleSignal('rtc.candidate', { fromPeerId: 'a-viewer', candidate: { usernameFragment: `user${oldAnswerer.pc.id}` } });
  assert.equal(replacement.pc.remoteDescription, before);
  assert.equal(replacement.pc.addedCandidates.length, 1);
  f.connect('z-host', 'a-viewer');
  await f.advance(30_000);
  assert.equal(replacement.voiceStatus, 'connected');
  assert.equal(f.offers('z-host', 'a-viewer').length, 2);
});

test('an answerer stuck in have-remote-offer retires its PC and stale async answers cannot be sent', async t => {
  const f = fixture(t, { host: 'host', viewer: 'viewer' });
  f.start();
  const oldAnswerer = f.peer('viewer', 'host');
  oldAnswerer.pc.stallAnswer = true;
  await f.drain();
  assert.equal(oldAnswerer.pc.signalingState, 'have-remote-offer');
  await f.advance(4000);
  assert.ok(oldAnswerer.pc.closed, 'an answerer retires the stuck transport even before the new offer arrives');
  assert.equal(f.peer('viewer', 'host').voiceStatus, 'retrying');
  await f.advance(350);
  oldAnswerer.pc.finishAnswer({ type: 'answer', sdp: 'obsolete' });
  await f.drain();
  assert.equal(f.signals.filter(s => s.payload.description?.type === 'answer').length, 1);
  f.connect('host', 'viewer');
});

test('in a three-member room only the failed viewer-viewer pair is rebuilt, even if ICE fails only at the answerer', async t => {
  const f = fixture(t, { host: 'host', ann: 'viewer', ben: 'viewer' }, { screenRelay: true });
  f.start();
  await f.drain();
  f.connect('host', 'ann'); f.connect('host', 'ben'); f.connect('ann', 'ben');
  const hostAnn = f.peer('host', 'ann'), annHost = f.peer('ann', 'host');
  const hostBen = f.peer('host', 'ben'), benHost = f.peer('ben', 'host');
  const annBen = f.peer('ann', 'ben'), benAnn = f.peer('ben', 'ann');
  const relay = f.media.ben.relay;
  const activeView = {};
  relay.views.set('ann', activeView);
  relay.removePeer = () => assert.fail('voice retry must not remove a screen view');
  relay.stopTransport = () => assert.fail('voice retry must not stop screen transport');
  benAnn.pc.iceConnectionState = 'failed';
  benAnn.pc.oniceconnectionstatechange();
  assert.ok(benAnn.pc.closed);
  await f.advance(350);
  assert.ok(annBen.pc.closed);
  assert.equal(f.peer('host', 'ann'), hostAnn);
  assert.equal(f.peer('ann', 'host'), annHost);
  assert.equal(f.peer('host', 'ben'), hostBen);
  assert.equal(f.peer('ben', 'host'), benHost);
  assert.equal(relay.views.get('ann'), activeView);
  assert.equal(f.offers('ann', 'ben').length, 2);
  assert.equal(f.offers('ben', 'ann').length, 0);
  f.connect('ann', 'ben');
  assert.equal(f.peer('ben', 'ann').voiceSender.track, f.media.ben.microphoneTrack);
  assert.equal(f.peer('ann', 'ben').voiceSender.track, f.media.ann.microphoneTrack);
});

test('the first viewer-viewer handshake can time out in a three-member room without interrupting either host link', async t => {
  const f = fixture(t, { host: 'host', ann: 'viewer', ben: 'viewer' });
  f.net.drop = s => s.from === 'ben' && s.to === 'ann' && s.payload.description?.type === 'answer';
  f.start();
  await f.drain();
  f.connect('host', 'ann'); f.connect('host', 'ben');
  const hostLinks = [f.peer('host', 'ann'), f.peer('host', 'ben'), f.peer('ann', 'host'), f.peer('ben', 'host')];
  const annBen = f.peer('ann', 'ben'), benAnn = f.peer('ben', 'ann');
  assert.equal(annBen.pc.signalingState, 'have-local-offer');
  f.net.drop = () => false;
  await f.advance(4350);
  assert.ok(annBen.pc.closed && benAnn.pc.closed);
  assert.ok(hostLinks.every(peer => !peer.pc.closed && peer.voiceStatus === 'connected'));
  assert.equal(f.offers('ann', 'ben').length, 2);
  f.connect('ann', 'ben');
});

test('signaling errors trigger pair replacement without waiting for the timeout', async t => {
  const f = fixture(t, { host: 'host', viewer: 'viewer' });
  f.start();
  const viewer = f.peer('viewer', 'host');
  viewer.pc.rejectDescription = true;
  await f.drain();
  assert.ok(viewer.pc.closed);
  assert.equal(f.peer('host', 'viewer').voiceStatus, 'retrying');
  await f.advance(350);
  f.connect('host', 'viewer');
  assert.equal(f.offers('host', 'viewer').length, 2);
});

for (const retryBy of ['host', 'viewer']) {
  test(`automatic backoff is capped at three retries and the ${retryBy} can explicitly restart after exhaustion`, async t => {
    const f = fixture(t, { host: 'host', viewer: 'viewer' });
    f.net.drop = s => s.payload.description?.type === 'answer';
    f.start();
    await f.advance(50_000);
    assert.equal(f.offers('host', 'viewer').length, 4, 'one initial offer and three automatic retries');
    assert.equal(f.peer('host', 'viewer').voiceStatus, 'failed');
    assert.equal(f.peer('viewer', 'host').voiceStatus, 'failed');
    assert.equal(f.timers.size, 0);

    const oldHost = f.peer('host', 'viewer'), waitingViewer = f.peer('viewer', 'host');
    assert.equal(waitingViewer.pc.signalingState, 'stable', 'the answerer already discarded the failed connection');
    assert.equal(waitingViewer.receivedOffer, undefined);
    f.net.drop = () => false;
    f.media[retryBy].retryVoiceConnections();
    await f.advance(0);
    assert.ok(oldHost.pc.closed);
    if (retryBy === 'viewer') assert.ok(waitingViewer.pc.closed);
    else assert.equal(f.peer('viewer', 'host'), waitingViewer, 'the new offer can use the clean waiting connection');
    assert.equal(f.offers('host', 'viewer').length, 5);
    assert.equal(f.offers('viewer', 'host').length, 0);
    f.connect('host', 'viewer');
    await f.advance(30_000);
    assert.equal(f.timers.size, 0);
  });
}

test('leaving during retry backoff cancels pending attempts', async t => {
  const f = fixture(t, { host: 'host', viewer: 'viewer' });
  f.net.drop = () => true;
  f.start();
  await f.advance(4000);
  const old = f.peer('host', 'viewer');
  await f.media.host.closePeer('viewer');
  await f.advance(20_000);
  assert.ok(old.pc.closed);
  assert.equal(f.media.host.peers.size, 0);
  assert.equal(f.offers('host', 'viewer').length, 1);
});
