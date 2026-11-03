import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaDiagnosticsHistory } from '../../internal/web/assets/media-history.js';

test('background fullscreen rates survive a return to foreground 59 FPS without exposing peer identities', () => {
  const history = new MediaDiagnosticsHistory();
  const row = {role:'screenVideo',direction:'outbound-rtp',fps:25,sourceFps:25,intervalFps:25,sourceIntervalFps:25,sampleIntervalSeconds:2,peerId:'private-peer',roomCode:'secret-code'};
  history.record({rows:[row],visibility:'hidden',target:'1080p60',time:1000});
  history.record({rows:[{...row,fps:59,sourceFps:59,intervalFps:26,sourceIntervalFps:26,sampleIntervalSeconds:60}],visibility:'visible',target:'1080p60',time:61000});
  const text = history.format();
  assert.match(text,/页面后台.*25.0/); assert.match(text,/页面前台.*59.0.*60.0 秒.*26.0/); assert.doesNotMatch(text,/private-peer|secret-code/);
});

test('history is bounded and missing native measurements never become configured 60 FPS', () => {
  const history = new MediaDiagnosticsHistory(2);
  for(let i=0;i<3;i++)history.record({rows:[{role:'screenVideo',direction:'inbound-rtp',fps:30}],target:'1080p60',time:i*1000});
  assert.equal(history.samples.length,2); assert.match(history.format(),/实际采集 未报告/);
  assert.doesNotMatch(history.format(),/实际采集 60/);
});
