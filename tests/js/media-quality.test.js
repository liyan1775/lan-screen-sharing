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
  assert.equal(order[1][1].maxFramerate, 30);
  assert.deepEqual(order[2][1].frameRate, { ideal: 60, max: 60 });
  assert.equal(order[3][1].maxFramerate, 60);
  assert.equal(media.screenVideoTrack.contentHint, 'motion');
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
