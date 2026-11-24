import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { MeshMedia } from '../../internal/web/assets/media.js';
import { formatPerformanceHint, formatMediaDiagnostics } from '../../internal/web/assets/media-stats.js';
import { bindQualityHUD, formatSharedQualityStatus } from '../../internal/web/assets/quality-hud.js';

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

test('video senders prefer resolution and skip rewriting matching parameters', async () => {
  const { media } = mediaFixture();
  let applied = { degradationPreference: 'balanced', encodings: [{ maxBitrate: 8_000_000, maxFramerate: 60, scaleResolutionDownBy: 1 }] };
  let writes = 0;
  const sender = {
    getParameters: () => structuredClone(applied),
    async setParameters(value) { writes++; applied = value; },
  };
  assert.equal(await media.applyVideoQuality(sender), true);
  assert.equal(applied.degradationPreference, 'maintain-resolution');
  assert.equal(await media.applyVideoQuality(sender, { confirm: true }), true);
  assert.equal(writes, 1);
});

test('relay confirmation succeeds with basic targets when the browser rejects resolution priority', async () => {
  const { media, states } = mediaFixture();
  media.screenVideoTrack = { getSettings: () => ({ width: 3840, height: 2160 }) };
  const attempts = [];
  let applied = { encodings: [{}] };
  const sender = {
    getParameters: () => structuredClone(applied),
    async setParameters(value) {
      attempts.push(value);
      if (value.degradationPreference) throw new Error('preference unavailable');
      applied = value;
    },
  };
  assert.equal(await media.applyVideoQuality(sender, { confirm: true }), true);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].degradationPreference, 'maintain-resolution');
  assert.equal(attempts[1].degradationPreference, undefined);
  assert.deepEqual(applied.encodings[0], { maxBitrate: 8_000_000, maxFramerate: 60, scaleResolutionDownBy: 2 });
  assert.deepEqual(states, [{
    state: 'quality_preference_unsupported',
    message: '浏览器未接受清晰度优先策略，已保留基本画质设置；请以实际统计为准。',
  }]);
});

const reducedOutbound = {
  direction: 'outbound-rtp', role: 'screenVideo', width: 1280, height: 720,
  fps: 57, bitrate: 8_000_000, qualityLimitationReason: 'cpu',
};
const fullOutbound = { ...reducedOutbound, width: 1920, height: 1080 };
const fullLabel = '1080p · 60fps';
const reducedLabel = '实发 720p · 目标 1080p';

test('shared quality prioritizes valid relay stats and shows the lowest resolution of partially reduced mesh links', () => {
  const status = rows => formatSharedQualityStatus(rows, '1080p60', fullLabel);
  const normal = { label: fullLabel, degraded: false };
  assert.deepEqual(status([
    { ...reducedOutbound, direction: 'inbound-rtp' },
    { ...reducedOutbound, role: 'microphone' },
    { ...reducedOutbound, width: 0 },
  ]), normal);
  assert.deepEqual(status([{ ...fullOutbound, width: 1904, height: 1064 }]), normal);
  assert.deepEqual(status([{ ...fullOutbound, fps: 30 }]), normal);
  assert.deepEqual(status([{ ...fullOutbound, width: 2560, height: 1440 }]), normal);
  assert.deepEqual(status([{ ...fullOutbound, localRelay: true }, reducedOutbound]), normal);
  assert.deepEqual(status([fullOutbound, { ...reducedOutbound, localRelay: true }]), { label: reducedLabel, degraded: true });
  assert.deepEqual(status([{ ...fullOutbound, localRelay: true, width: 0 }, reducedOutbound]),
    { label: reducedLabel, degraded: true });
  assert.deepEqual(status([reducedOutbound, fullOutbound, { ...reducedOutbound, width: 854, height: 480 }]),
    { label: '部分 480p · 目标 1080p', degraded: true });
  assert.deepEqual(status([reducedOutbound, reducedOutbound]), { label: reducedLabel, degraded: true });
  assert.deepEqual(formatSharedQualityStatus([{ ...reducedOutbound, width: 1024, height: 576 }], '720p30', '720p · 30fps'),
    { label: '实发 1024×576 · 目标 720p', degraded: true });
});

test('shared capsule shows the measured downgrade, clears it on recovery, target change and stop, and skips redundant writes', () => {
  const { document, MutationObserver } = parseHTML(`
    <div id="quality-pill" hidden>
      <button id="quality-trigger" hidden><span></span></button>
      <div id="quality-picker" hidden></div>
      <div id="quality-observer" hidden><span id="quality-received"></span></div>
    </div>
    <select><option value="1080p60" selected>1080p · 60 FPS</option>
      <option value="720p60">720p · 60 FPS</option></select>
  `);
  const select = document.querySelector('select');
  const hud = bindQualityHUD({ document, select, onSelect() {} });
  const trigger = document.querySelector('#quality-trigger');
  const summary = trigger.querySelector('span');
  const buttons = [...document.querySelectorAll('.quality-option')];
  const observer = new MutationObserver(() => {});
  observer.observe(document.querySelector('#quality-pill'), { subtree: true, attributes: true, childList: true, characterData: true });
  const sync = (rows, quality = '1080p60', kind = 'share') => hud.sync({ kind, quality, rows });
  const assertStatus = (label, degraded) => {
    assert.equal(summary.textContent, label);
    assert.equal(trigger.getAttribute('aria-label'), degraded ? `共享画质 ${label}` : `共享画质目标 ${label}`);
    assert.equal(trigger.getAttribute('data-degraded'), degraded ? 'true' : null);
  };
  const sample = [reducedOutbound];

  sync([]);
  assertStatus(fullLabel, false);
  sync(sample);
  assertStatus(reducedLabel, true);
  assert.ok(observer.takeRecords().length > 0);
  sync(sample);
  sync([reducedOutbound]);
  assert.deepEqual(observer.takeRecords(), []);

  sync([fullOutbound]);
  assertStatus(fullLabel, false);
  sync(sample);
  assertStatus(reducedLabel, true);
  sync(sample, '720p60');
  assertStatus('720p · 60fps', false);
  assert.deepEqual(buttons.map(button => button.getAttribute('aria-pressed')), ['false', 'true']);
  sync(sample);
  sync(sample);
  assertStatus(fullLabel, false);
  sync([reducedOutbound]);
  assertStatus(reducedLabel, true);
  sync(sample, '1080p60', '');
  assertStatus(fullLabel, false);
  assert.equal(trigger.hidden, true);
  observer.disconnect();
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
