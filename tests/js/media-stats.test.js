import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCaptureStats, formatVideoLinks, formatMediaDiagnostics, formatPerformanceHint } from '../../internal/web/assets/media-stats.js';

test('capture configuration and observed source rate are explicitly separated', () => {
  const text = formatCaptureStats({ getSettings: () => ({width:1920,height:1080,frameRate:60}) }, [{direction:'outbound-rtp',sourceFps:30}]);
  assert.match(text,/60.0 FPS（设置值，非实测）/);
  assert.match(text,/实际采集 30.0 FPS/);
  assert.equal(formatCaptureStats(null), '');
});

test('actual links expose each receiver and browser-reported limit instead of picking one arbitrary stream', () => {
  const text = formatVideoLinks([
    {peerId:'one',direction:'outbound-rtp',role:'screenVideo',width:1280,height:720,fps:30,qualityLimitationReason:'bandwidth'},
    {peerId:'two',direction:'outbound-rtp',role:'screenVideo',width:1920,height:1080,fps:60,qualityLimitationReason:'cpu'},
  ], id => id==='one'?'成员1':'成员2');
  assert.match(text,/发送给成员1.*30.0 FPS.*带宽限制/);
  assert.match(text,/发送给成员2.*60.0 FPS.*编码性能限制/);
  assert.equal(text.split('\n').length,2);
});

test('the snapshot distinguishes measured rates, profile, interval counters and cumulative counters', () => {
  const rows = [{
    role:'screenVideo', direction:'outbound-rtp', codec:'H264', codecProfile:'H264 High L4.2', profileLevelId:'64002a',
    bitrate:9_100_000, targetBitrate:14_000_000, availableOutgoingBitrate:30_000_000,
    powerEfficientEncoder:true, qualityLimitationReason:'cpu', qualityLimitationDurations:{none:40,cpu:3,bandwidth:0,other:1},
    qualityLimitationDurationsDelta:{none:0,cpu:1.25,bandwidth:0,other:0}, currentRoundTripTimeMs:7.25,
    intervalEncodeMs:5.75, averageEncodeMs:3, nackCount:8, nackCountDelta:2, pliCount:3, pliCountDelta:1,
    firCount:0, firCountDelta:0, retransmittedPacketsSent:7, retransmittedPacketsSentDelta:0,
  }];
  const report = formatMediaDiagnostics({rows, target:'720p60'});
  for (const text of ['实际发送 9.1 Mbps / 编码目标 14.0 Mbps / 可用带宽估计 30.0 Mbps / 用户上限 8.0 Mbps',
    'H264 High L4.2（profile-level-id=64002a）', '高能效编码（浏览器报告）', 'RTT 7.3 ms',
    '本区间编码 5.75 ms/帧 / 累计平均编码 3.00 ms/帧', '本区间时长：编码性能 1.25 s、带宽 0.00 s',
    '累计限制时长：编码性能 3.00 s、带宽 0.00 s、其他 1.00 s、无 40.00 s',
    '本区间增量：NACK 2、PLI 1、FIR 0、丢包 未报告、重传包 0',
    '累计计数：NACK 8、PLI 3、FIR 0、丢包 未报告、重传包 7']) assert.ok(report.includes(text), text);
  const summary = formatVideoLinks(rows);
  const multiLinkReport = formatMediaDiagnostics({rows:[...rows, ...rows], target:'720p60'});
  assert.equal(multiLinkReport.match(/突发关键帧时，短区间的平均码率可能高于用户上限/g)?.length, 1);
  assert.doesNotMatch(summary, /短区间的平均码率/);
  assert.match(summary, /H264 High L4.2.*可用带宽估计 30.0 Mbps/);
  assert.doesNotMatch(summary, /NACK|profile-level-id|累计/);
});

test('acceleration wording follows the directional browser report and capture advice covers GPU headroom', () => {
  for (const [direction, flag, impl, expected] of [
    ['outbound-rtp',true,'Native','硬件编码'], ['inbound-rtp',true,'Native','硬件解码'],
    ['inbound-rtp',true,'','高能效解码（浏览器报告）'], ['outbound-rtp',false,'','软件或未加速编码'],
    ['inbound-rtp',false,'Native','软件或未加速解码'], ['outbound-rtp',undefined,'Native','编码加速 未报告'],
  ]) {
    const row = {role:'screenVideo', direction, powerEfficientEncoder:flag, powerEfficientDecoder:flag,
      encoderImplementation:impl, decoderImplementation:impl};
    const report = formatMediaDiagnostics({rows:[row]});
    assert.ok(report.includes(expected), report);
    assert.doesNotMatch(report + formatVideoLinks([row]), /节能[编解]码/);
  }
  const hint = formatPerformanceHint([{direction:'outbound-rtp',role:'screenVideo',fps:25,sourceFps:25}],60);
  assert.match(hint,/独占全屏与无边框窗口（继续共享整个显示器）.*限制游戏帧率留出显卡余量/);
});
