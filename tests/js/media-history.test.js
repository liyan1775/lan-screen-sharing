import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaDiagnosticsHistory } from '../../internal/web/assets/media-history.js';

test('background fullscreen rates survive a return to foreground 59 FPS without exposing peer identities', () => {
  const history = new MediaDiagnosticsHistory();
  const row = {role:'screenVideo',direction:'outbound-rtp',fps:25,sourceFps:25,intervalFps:25,sourceIntervalFps:25,sampleIntervalSeconds:2,peerId:'private-peer',roomCode:'secret-code'};
  history.record({rows:[row],visibility:'hidden',target:'1080p60',time:1000});
  history.record({rows:[{...row,fps:59,sourceFps:59,intervalFps:26,sourceIntervalFps:26,sampleIntervalSeconds:60}],visibility:'visible',target:'1080p60',time:61000});
  const text = history.format();
  assert.match(text,/页面后台.*25.0/); assert.match(text,/后台→前台（跨切换区间）.*59.0.*60.0 秒.*26.0/); assert.doesNotMatch(text,/private-peer|secret-code/);
});

test('history is bounded and missing native measurements never become configured 60 FPS', () => {
  const history = new MediaDiagnosticsHistory(2);
  for(let i=0;i<3;i++)history.record({rows:[{role:'screenVideo',direction:'inbound-rtp',fps:30}],target:'1080p60',time:i*1000});
  assert.equal(history.samples.length,2); assert.match(history.format(),/实际采集 未报告/);
  assert.doesNotMatch(history.format(),/实际采集 60/);
});

test('up to 120 immutable samples preserve each background stream and its interval measurements', () => {
  const history = new MediaDiagnosticsHistory(999);
  const row = {role:'screenVideo',direction:'outbound-rtp',fps:50,intervalFps:48,sourceFps:52,sourceIntervalFps:49,sampleIntervalSeconds:2,
    bitrate:12_000_000,targetBitrate:20_000_000,availableOutgoingBitrate:30_000_000,codec:'H264',
    codecProfile:'H264 High L4.2',profileLevelId:'64002a',averageQp:27.5,intervalEncodeMs:4.25,
    averageEncodeMs:3.5,qualityLimitationReason:'bandwidth',qualityLimitationDurationsDelta:{bandwidth:1.5,cpu:0},
    packetsLostDelta:3,nackCountDelta:4,pliCountDelta:2,firCountDelta:1,retransmittedPacketsSentDelta:8,keyFramesEncodedDelta:2,currentRoundTripTimeMs:9};
  for(let i=0;i<120;i++) history.record({rows:[row,{...row,direction:'inbound-rtp',bitrate:11_000_000}],time:i,visibility:'hidden'});
  row.targetBitrate = 1_000_000;
  row.qualityLimitationDurationsDelta.bandwidth = 0;
  history.record({rows:[row],time:121,visibility:'visible'});
  const lines = history.format().split('\n');
  assert.equal(lines.length,121);
  for(const text of ['页面后台','实际发送 12.0 Mbps','编码目标 20.0 Mbps','可用带宽估计 30.0 Mbps',
    'H264 High L4.2（profile-level-id=64002a）','实际采集 52.0 FPS','发送 48.0 FPS、采集 49.0 FPS',
    'QP 27.5','本区间编码 4.25 ms/帧','限制 带宽','带宽 1.50 s','RTT 9.0 ms',
    'NACK 4、PLI 2、FIR 1、丢包 3、重传包 8、编码关键帧 2','实际接收 11.0 Mbps']) assert.ok(lines[1].includes(text),text);
  assert.match(lines.at(-1), /后台→前台（跨切换区间）.*编码目标 1.0 Mbps/);
});

test('history distinguishes both boundaries and stable intervals, and starts a new baseline after a reset', () => {
  const history = new MediaDiagnosticsHistory(1);
  const row = {role:'screenVideo', direction:'outbound-rtp'};
  const localTime = new Date(2026, 10, 26, 0, 4, 5).getTime();
  history.record({rows:[row], visibility:'visible', time:localTime});
  assert.match(history.format(), /^00:04:05 · 页面前台.*首个样本（待下次采样计算区间均值）/m);
  assert.doesNotMatch(history.format(), /未报告区间平均/);
  const measured = {...row, sampleIntervalSeconds:3.9, intervalFps:0};
  for (const [visibility, label] of [['visible','页面前台'], ['hidden','前台→后台（跨切换区间）'],
    ['hidden','页面后台'], ['visible','后台→前台（跨切换区间）'], ['visible','页面前台']]) {
    history.record({rows:[measured], visibility, time:'游戏时钟 00:04:09.021'});
    assert.ok(history.format().includes('游戏时钟 00:04:09.021 · ' + label + ' ·'));
    assert.match(history.format(), /3.9 秒区间平均：发送 0.0 FPS/);
  }
  history.resetInterval();
  history.record({rows:[row], visibility:'hidden'});
  assert.match(history.format(), /^\d{2}:\d{2}:\d{2} · 页面后台.*首个样本/m);
});
