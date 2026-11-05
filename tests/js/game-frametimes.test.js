import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, summarizeFrames, compareRuns } from '../../scripts/compare-game-frametimes.mjs';

const csv = (times, { application = 'game.exe', chain = '0x1', pid = 123 } = {}) => 'Application,ProcessID,SwapChainAddress,MsBetweenPresents\r\n'
  + times.map(time => `${application},${pid},${chain},${time}`).join('\r\n');
const summarize = text => summarizeFrames(text, { minSeconds: 0, minFrames: 1 });

test('frame parsing handles quoted fields, BOM and CRLF without confusing comma-containing game names', () => {
  const [record] = parseCSV('\uFEFFApplication,ProcessID,SwapChainAddress,CPUFrameTime\r\n"game, ""test"".exe",1,0x1,5\r\n');
  assert.equal(record.application, 'game, "test".exe');
  assert.throws(() => parseCSV('a,b\n"unterminated,2'), /unterminated/);
  assert.throws(() => parseCSV('a,a\n1,2'), /duplicate/);
  assert.throws(() => parseCSV('a,b\n1'), /number of fields/);
});

test('low FPS measures the slowest frame-time tail and retains long stutters', () => {
  const run = summarize(csv([...Array(990).fill(5), ...Array(9).fill(25), 100]));
  assert.ok(Math.abs(run.onePercentLowFps - 1000 / 32.5) < 1e-9);
  assert.equal(run.pointOnePercentLowFps, 10);
  assert.equal(run.p99FrameTimeMs, 5); assert.equal(run.p999FrameTimeMs, 25);
  assert.equal(run.maxFrameTimeMs, 100); assert.equal(run.framesOver50ms, 1);
});

test('missing interior frames and mixed processes cannot falsely pass a performance gate', () => {
  assert.throws(() => summarize(csv([5, 'NA', 5])), /invalid or missing/);
  assert.throws(() => summarize(csv([5, 0, 5])), /invalid or missing/);
  assert.throws(() => summarize(csv([5, -1, 5])), /invalid or missing/);
  const boundary = summarize(csv(['NA', 5, 10, 0]));
  assert.equal(boundary.frames, 2); assert.equal(boundary.unavailableBoundaryFrames, 2);
  const mixed = csv([5, 5]) + '\r\nother.exe,456,0x2,5';
  assert.throws(() => summarize(mixed), /Multiple/);
  assert.equal(summarizeFrames(mixed, { processName: 'game.exe', minSeconds: 0, minFrames: 1 }).frames, 2);
  assert.throws(() => summarizeFrames(csv(Array(100).fill(5))), /too short/);
});

test('paired gate uses three runs, both lows and tail latency; any regressed pair fails even if averages improve', () => {
  const before = summarize(csv(Array(1000).fill(10)));
  const after = summarize(csv([...Array(990).fill(9), ...Array(10).fill(20)]));
  assert.ok(after.averageFps > before.averageFps);
  const failed = compareRuns([before, before, before], [before, after, before]);
  assert.equal(failed.status, 'regression'); assert.equal(failed.pairs[1].passes, false);
  assert.equal(compareRuns([before, before, before], [before, before, before]).status, 'pass');
  assert.throws(() => compareRuns([before], [before]), /3 matched/);
  assert.throws(() => compareRuns([before, before, before], [before, before, { ...before, metric: 'cpuframetime' }]), /same game/);
  assert.throws(() => compareRuns([before, before, before], [before, before, { ...before, seconds: 1 }]), /durations/);
});
