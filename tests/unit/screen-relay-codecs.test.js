import assert from 'node:assert/strict';
import test from 'node:test';
import { ScreenRelay, preferScreenCodecs, waitForLocalBudget } from '../../internal/web/assets/screen-relay.js';
import { MeshMedia } from '../../internal/web/assets/media.js';
import { formatMediaDiagnostics, formatVideoLinks } from '../../internal/web/assets/media-stats.js';
import { RoomClient } from '../../internal/web/assets/client.js';

const vp8 = { mimeType:'video/VP8' };
const vp9 = { mimeType:'video/VP9' };
const h264 = { mimeType:'VIDEO/H264', sdpFmtpLine:' Profile-Level-Id = 42E02A ; PACKETIZATION-MODE = 1' };
const mode0 = { ...h264, sdpFmtpLine:'profile-level-id=42e02a;packetization-mode=0' };
const rtx = { mimeType:'video/rtx', sdpFmtpLine:'apt=102' };
const red = { mimeType:'video/red' };
const fec = { mimeType:'video/ulpfec' };
const caps = { getCapabilities:() => ({ codecs:[vp8, rtx, mode0, vp9, h264, red, fec] }) };

test('codec preferences reorder browser entries without changing RTX or FEC associations', () => {
  let chosen;
  const transceiver = { setCodecPreferences:codecs => { chosen = codecs; } };
  assert.equal(preferScreenCodecs(transceiver, caps, 'h264'), true);
  assert.deepEqual(chosen, [h264, vp9, vp8, rtx, mode0, red, fec]);
  assert.equal(chosen[3], rtx);
  assert.equal(caps.getCapabilities().codecs[0], vp8);
  assert.equal(preferScreenCodecs(transceiver, caps, 'vp8'), true);
  assert.equal(chosen[0], vp8);
  assert.ok(chosen.includes(h264));
});

test('missing, empty or throwing codec APIs leave the browser defaults enabled', () => {
  assert.equal(preferScreenCodecs({}, caps, 'h264'), false);
  assert.equal(preferScreenCodecs({setCodecPreferences:assert.fail}, undefined, 'h264'), false);
  assert.equal(preferScreenCodecs({setCodecPreferences:assert.fail}, {getCapabilities:() => ({codecs:[]})}, 'h264'), false);
  assert.equal(preferScreenCodecs({setCodecPreferences:() => { throw new Error(); }}, caps, 'h264'), false);
});

test('a nominated candidate pair can start when bitrate statistics are omitted', async () => {
  const controller = new AbortController();
  const abort = setTimeout(() => controller.abort(), 2500);
  try {
    const pc = { getStats:async () => new Map([['pair', {type:'candidate-pair',state:'succeeded',nominated:true}]]) };
    await waitForLocalBudget(pc, controller.signal);
    assert.equal(controller.signal.aborted, false);
  } finally { clearTimeout(abort); }
});

class FakePC {
  connectionState = 'connected';
  iceGatheringState = 'complete';
  senders = [];
  addTransceiver(kind) {
    const sender = { track:null, async replaceTrack(track) { this.track = track; } };
    this.senders.push(sender);
    return { sender, setCodecPreferences:codecs => { if (kind === 'video') this.codec = codecs[0]; } };
  }
  getSenders() { return this.senders; }
  async createOffer() { return {type:'offer', sdp:'mock offer'}; }
  async setLocalDescription(value) { this.localDescription = {toJSON:() => value}; }
  async setRemoteDescription() {}
  async getStats() {
    return new Map([
      ['pair',{type:'candidate-pair',state:'succeeded',nominated:true,availableOutgoingBitrate:16_000_000}],
      ['code',this.codec],
      ['video',{type:'outbound-rtp',kind:'video',framesEncoded:3,codecId:'code'}],
    ]);
  }
  close() { this.connectionState = 'closed'; }
}

function setup(t) {
  t.mock.method(globalThis, 'setTimeout', (fn, delay) => {
    queueMicrotask(fn);
    return undefined;
  });
  const globals = Object.fromEntries(['RTCPeerConnection','RTCRtpSender','RTCRtpReceiver'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { RTCPeerConnection:FakePC, RTCRtpSender:caps, RTCRtpReceiver:caps });
  t.after(() => Object.assign(globalThis, globals));
  const peers = new Set(['a','b','c']);
  const signals = [], notices = [], actions = [], pending = [];
  const client = {
    sendSignal: (...args) => signals.push(args),
    async requestScreenRelay(request) {
      actions.push(request);
      if (request.action === 'receiver') return new Promise((resolve, reject) => pending.push(reject));
      return { sessionId:crypto.randomUUID(), description:{type:'answer',sdp:'mock answer'} };
    },
  };
  const relay = new ScreenRelay(client, {
    peerIds:() => [...peers], presenter:() => 'a', applyQuality:async () => true,
    onTrack() {}, onViewClosed() {}, onError:assert.fail, onCodecChange:notice => notices.push(notice),
  });
  return { relay, peers, signals, notices, actions, pending };
}

const mismatch = () => Object.assign(new Error('mismatch'), { code:'SCREEN_RELAY_CODEC_MISMATCH' });
const offer = (fromPeerId, epoch) => ({ fromPeerId, epoch, description:{type:'offer',sdp:'mock offer'} });
const failedDecode = (fromPeerId, epoch) => ({ ...offer(fromPeerId, epoch), codecMismatch:true });

test('concurrent mismatches share one fallback; departing members trigger at most one recovery', async t => {
  const { relay, peers, signals, notices, actions, pending } = setup(t);
  const video = { kind:'video', readyState:'live' };
  const audio = { kind:'audio', readyState:'live' };
  await relay.start(video, audio);
  const initial = relay.source;
  const attempts = ['a','b'].map(id => relay.handle('screen.description', offer(id, initial.epoch)));
  while (pending.length < 2) await Promise.resolve();
  pending.forEach(reject => reject(mismatch()));
  await Promise.all(attempts);
  assert.equal(relay.source.codecMode, 'vp8');
  assert.equal(relay.source.videoSender.track, video);
  assert.equal(relay.source.audioSender.track, audio);
  assert.equal(initial.pc.connectionState, 'closed');
  assert.deepEqual([...relay.share.incompatibleH264Peers], ['a','b']);
  assert.deepEqual(notices, [{reason:'peer',peerId:'a'}]);
  assert.deepEqual(signals.map(([, to, data]) => [to,data.codecPeerId]), [['a','a'], ['b','a'], ['c','a']]);
  await relay.handle('screen.description', failedDecode('c', initial.epoch));
  assert.deepEqual([...relay.share.incompatibleH264Peers], ['a','b']);
  peers.delete('a'); relay.removePeer('a');
  assert.equal(relay.source.codecMode, 'vp8');
  peers.delete('b'); relay.removePeer('b');
  await relay.share.operation;
  assert.equal(relay.source.codecMode, 'h264');
  assert.deepEqual(notices.at(-1), {reason:'restored',peerId:'b'});
  await relay.handle('screen.description', failedDecode('c', relay.source.epoch));
  assert.equal(relay.source.codecMode, 'vp8');
  peers.delete('c'); relay.removePeer('c');
  peers.add('d');
  await relay.start(video, audio);
  assert.equal(relay.source.codecMode, 'vp8');
  assert.deepEqual(actions.filter(action => ['start','stop'].includes(action.action)).map(action => action.action),
    ['start','stop','start','stop','start','stop','start']);
  await relay.close();
});

test('a first-frame failure requires current H264 RTP on a connected viewer', async t => {
  const { relay, signals } = setup(t);
  await relay.startView('a','current','h264');
  const view = relay.views.get('a');
  let framesDecoded = 0, packetsReceived = 0;
  view.pc.getStats = async () => new Map([
    ['codec',h264],
    ['video',{type:'inbound-rtp',kind:'video',framesDecoded,packetsReceived,codecId:'codec'}],
  ]);
  await relay.checkFirstFrame('a',view);
  packetsReceived = 20;
  view.pc.connectionState = 'connecting';
  await relay.checkFirstFrame('a',view);
  view.pc.connectionState = 'connected';
  framesDecoded = 1;
  await relay.checkFirstFrame('a',view);
  assert.equal(signals.length,1);
  framesDecoded = 0;
  await relay.checkFirstFrame('a',view);
  assert.deepEqual(signals[1], ['screen.description','a',{epoch:'current',codecMismatch:true,description:{type:'offer',sdp:''}}]);
  await relay.startView('a','new','vp8');
  await relay.checkFirstFrame('a',view);
  await relay.handle('screen.ready',{fromPeerId:'a',epoch:'current',codecMode:'h264'});
  assert.equal(relay.views.get('a').epoch,'new');
  assert.equal(signals.length,3);
  await relay.close();
});

test('a failed H264 parameter confirmation uses VP8 without scheduling peer-based recovery', async t => {
  const { relay, peers, notices } = setup(t);
  let confirmed = 0;
  relay.applyQuality = async (_sender, options) => !options?.confirm || ++confirmed > 1;
  const video = { kind:'video',readyState:'live' };
  await relay.start(video,null);
  assert.equal(relay.source.codecMode,'vp8');
  assert.equal(relay.source.videoSender.track,video);
  assert.deepEqual(notices,[{reason:'sharer',peerId:''}]);
  peers.delete('a'); relay.removePeer('a');
  assert.equal(relay.source.codecMode,'vp8');
  await relay.close();
});

test('the local control fetch preserves the codec mismatch code', async t => {
  const original = globalThis.location;
  globalThis.location = {href:'http://localhost:8080/'};
  t.after(() => { globalThis.location = original; });
  const client = new RoomClient({fetchImpl:async () => ({
    ok:false,
    json:async () => ({payload:{code:'SCREEN_RELAY_CODEC_MISMATCH'}}),
  })});
  client.bootstrap = {localControlToken:'test-token'};
  await assert.rejects(client.requestScreenRelay({action:'receiver'}), {code:'SCREEN_RELAY_CODEC_MISMATCH'});
});

test('one native stats sample feeds directional, three-state diagnostics and keeps the actual stats prefix', async () => {
  const media = new MeshMedia({});
  let calls = 0;
  const base = {kind:'video', frameWidth:1920, frameHeight:1080, framesPerSecond:60, framesDropped:0, bytesSent:100};
  const native = new Map([
    ['code',{mimeType:'VIDEO/h264'}],
    ['send',{...base,id:'send',type:'outbound-rtp',codecId:'code',encoderImplementation:'Native encoder',powerEfficientEncoder:true,powerEfficientDecoder:true}],
    ['recv',{...base,id:'recv',type:'inbound-rtp',codecId:'code',decoderImplementation:'Native decoder',powerEfficientDecoder:false}],
    ['unset',{...base,id:'unset',type:'inbound-rtp',codecId:'code'}],
  ]);
  media.peers.set('member',{pc:{async getStats(){ calls++; return native; }}});
  const rows = await media.getStatsSnapshot({videoOnly:true});
  assert.equal(calls,1);
  assert.deepEqual(rows.map(row => [row.powerEfficientEncoder,row.powerEfficientDecoder]), [[true,undefined],[undefined,false],[undefined,undefined]]);
  const text = formatVideoLinks(rows.map(row => ({...row,bitrate:8_000_000})));
  assert.match(text, /实际 1920×1080 · 60\.0 FPS · 8\.0 Mbps · 丢帧 0 · H264 · 节能编码 · 编码实现 Native encoder/);
  assert.match(text, /H264 · 非节能解码 · 解码实现 Native decoder/);
  assert.ok(text.endsWith(' · H264'));
  assert.match(formatMediaDiagnostics({rows}), /解码实现 Native decoder/);
});
