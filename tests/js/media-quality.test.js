import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshMedia } from '../../internal/web/assets/media.js';
import { formatPerformanceHint, formatMediaDiagnostics } from '../../internal/web/assets/media-stats.js';

function mediaFixture() {
  const states = [];
  const media = new MeshMedia({ sendUnacknowledged() {} }, { onState: (state) => states.push(state) });
  return { media, states };
}

test('changing quality updates capture constraints before sender encoding, including 30 to 60', async () => {
  const { media } = mediaFixture();
  const order = [];
  const settings = { width: 1920, height: 1080, frameRate: 30 };
  media.screenVideoTrack = { kind: 'video', getSettings: () => settings, async applyConstraints(value) { order.push(['capture', value]); settings.frameRate = value.frameRate.ideal; } };
  media.peers.set('peer', { screenSender: { getParameters: () => ({ encodings: [{}] }), async setParameters(value) { order.push(['encoding', value.encodings[0]]); } } });
  await media.setQuality('720p30');
  await media.setQuality('720p60');
  assert.equal(order[0][0], 'capture');
  assert.deepEqual(order[0][1].frameRate, { ideal: 30, max: 30 });
  assert.deepEqual(order[0][1].width, { ideal: 1280, max: 1280 });
  assert.deepEqual(order[0][1].height, { ideal: 720, max: 720 });
  assert.equal(order[1][1].maxFramerate, 30);
  assert.deepEqual(order[2][1].frameRate, { ideal: 60, max: 60 });
  assert.equal(order[3][1].maxFramerate, 60);
  assert.equal(media.screenVideoTrack.contentHint, 'motion');
});

test('sender fallback fits both dimensions of large, ultrawide and portrait sources inside the target', async () => {
  const { media } = mediaFixture();
  let encoding;
  const sender = { getParameters: () => ({ encodings: [{}] }), async setParameters(value) { encoding = value.encodings[0]; } };
  for (const [width, height] of [[3840, 2160], [3440, 1440], [1080, 1920], [1920, 1200], [640, 480]]) {
    media.screenVideoTrack = { getSettings: () => ({ width, height }) };
    await media.applyVideoQuality(sender);
    assert.ok(width / encoding.scaleResolutionDownBy <= 1920);
    assert.ok(height / encoding.scaleResolutionDownBy <= 1080);
    assert.ok(encoding.scaleResolutionDownBy >= 1);
    assert.equal(encoding.maxFramerate, 60);
    assert.equal(encoding.maxBitrate, 8_000_000);
  }
});

test('video diagnostics skip unrelated peer connections and start requested reads concurrently', async () => {
  const { media } = mediaFixture();
  const calls = [], completions = [];
  for (const id of ['presenter', 'other']) media.peers.set(id, { pc: { getStats() {
    calls.push(id);
    return new Promise(resolve => completions.push(() => resolve(new Map([
      ['video', { id: 'video', type: 'inbound-rtp', kind: 'video', timestamp: 1000, bytesReceived: 100 }],
      ['audio', { id: 'audio', type: 'inbound-rtp', kind: 'audio', timestamp: 1000, bytesReceived: 100 }],
    ]))));
  } } });
  const selected = media.getStatsSnapshot({ peerIds: ['presenter', 'missing', 'presenter'], videoOnly: true });
  assert.deepEqual(calls, ['presenter']); completions.shift()();
  const rows = await selected;
  assert.equal(rows.length, 1); assert.equal(rows[0].peerId, 'presenter'); assert.equal(rows[0].role, 'screenVideo');
  calls.length = 0;
  const all = media.getStatsSnapshot();
  assert.deepEqual(calls, ['presenter', 'other']);
  completions.splice(0).forEach(finish => finish());
  assert.equal((await all).length, 4);
});

test('a late stats response from a replaced connection cannot repopulate its history', async () => {
  const { media } = mediaFixture();
  let finish;
  media.peers.set('peer', { pc: { getStats: () => new Promise(resolve => { finish = resolve; }) } });
  const snapshot = media.getStatsSnapshot();
  media.peers.set('peer', { pc: {} });
  finish(new Map([['video', { id: 'video', type: 'outbound-rtp', kind: 'video', timestamp: 1000, bytesSent: 100 }]]));
  assert.deepEqual(await snapshot, []);
  assert.equal(media.statsPrevious.size, 0);
});

test('video senders prefer frame rate and preserve basic targets if that preference is rejected', async () => {
  const {media,states} = mediaFixture(); const values = [];
  const sender = {getParameters:()=>({encodings:[{}]}),async setParameters(value){values.push(value);if(value.degradationPreference)throw new Error('preference unavailable');}};
  assert.equal(await media.applyVideoQuality(sender),true);
  assert.equal(values[0].degradationPreference,'maintain-framerate'); assert.equal(values[1].encodings[0].maxFramerate,60);
  assert.equal(values[1].encodings[0].maxBitrate,8_000_000); assert.ok(states.some(s=>s.state==='quality_preference_unsupported'));
});

test('source frame counts expose real capture rate when source FPS is omitted', async () => {
  const {media} = mediaFixture(); let timestamp=1000;
  media.peers.set('peer',{pc:{async getStats(){return new Map([
    ['source',{type:'media-source',kind:'video',timestamp,frames:timestamp*0.03}],
    ['video',{id:'video',type:'outbound-rtp',kind:'video',timestamp,mediaSourceId:'source',bytesSent:timestamp*1000,framesEncoded:timestamp*0.03,totalEncodeTime:timestamp*0.0003,codecId:'codec'}],
    ['codec',{mimeType:'video/VP8'}],
  ]);}}});
  await media.getStatsSnapshot(); timestamp=3000;
  const [row] = await media.getStatsSnapshot(); assert.equal(row.sourceFps,30); assert.equal(row.codec,'VP8'); assert.ok(Math.abs(row.averageEncodeMs-10)<1e-9);
  assert.match(formatPerformanceHint([row],60),/实际采集帧率也偏低/);
  assert.equal(formatPerformanceHint([row],30),'');
  const report=formatMediaDiagnostics({track:{getSettings:()=>({frameRate:60,cursor:'always'})},rows:[{...row,role:'screenVideo',width:1280,height:720}],target:'720p60',shareCursor:false,visibility:'hidden'});
  assert.match(report,/实际采集 30.0/); assert.match(report,/隐藏.*always/); assert.doesNotMatch(report,/peer/);
});

test('capture refusal keeps existing sharing and reports the capture limit honestly', async () => {
  const { media, states } = mediaFixture();
  const track = { getSettings: () => ({ width: 1280, height: 720, frameRate: 30 }), async applyConstraints() { throw new Error('unsupported'); } };
  media.screenVideoTrack = track;
  await media.setQuality('720p60');
  assert.equal(media.screenVideoTrack, track);
  assert.ok(states.some((state) => state.state === 'capture_quality_unsupported'));
});

test('stats distinguish encoded rate, capture-source rate and bandwidth/cpu limits', async () => {
  const { media } = mediaFixture();
  let reportTime = 1000;
  media.peers.set('peer', { pc: { async getStats() { return new Map([
    ['source', { id: 'source', type: 'media-source', kind: 'video', framesPerSecond: 59.9 }],
    ['video', { id: 'video', type: 'outbound-rtp', kind: 'video', timestamp: reportTime, mediaSourceId: 'source', bytesSent: reportTime * 1000, framesEncoded: reportTime * 0.03, frameWidth: 1280, frameHeight: 720, qualityLimitationReason: 'bandwidth' }],
  ]); } } });
  await media.getStatsSnapshot();
  reportTime = 3000;
  const [row] = await media.getStatsSnapshot();
  assert.equal(row.fps, 30);
  assert.equal(row.sourceFps, 59.9);
  assert.equal(row.qualityLimitationReason, 'bandwidth');
  assert.equal(row.bitrate, 8_000_000);
});
