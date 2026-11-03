import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCaptureStats, formatVideoLinks } from '../../internal/web/assets/media-stats.js';

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
