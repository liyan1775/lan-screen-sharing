import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaStatsPoller } from '../../internal/web/assets/media-stats-poller.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture(sample) {
  let calls = 0, nextId = 0;
  const timers = new Map();
  const state = { active: false, diagnosticsVisible: false, hidden: false, context: 'room:presenter' };
  const poller = createMediaStatsPoller({
    getState: () => state,
    sample: async () => { calls++; await sample?.(); },
    setTimeoutImpl: (callback, delay) => { const id = nextId++; timers.set(id, { callback, delay }); return id; },
    clearTimeoutImpl: id => timers.delete(id),
  });
  return { poller, state, timers, get calls() { return calls; }, async tick() {
    const [id, timer] = timers.entries().next().value;
    timers.delete(id); timer.callback(); await settle();
  } };
}

test('idle and voice rooms have no media polling; sharing retains a low-frequency history', async () => {
  const f = fixture();
  f.poller.sync(); await settle();
  assert.equal(f.calls, 0); assert.equal(f.timers.size, 0);
  f.state.active = true; f.poller.sync(); await settle();
  assert.equal(f.calls, 1); assert.equal([...f.timers.values()][0].delay, 10000);
  for (let i = 0; i < 20; i++) f.poller.sync();
  assert.equal(f.timers.size, 1); assert.equal(f.calls, 1, 'unrelated UI updates do not trigger samples');
  await f.tick(); assert.equal(f.calls, 2);
  f.state.active = false; f.poller.sync();
  assert.equal(f.timers.size, 0);
});

test('opening diagnostics or returning from the background samples immediately and adjusts the interval', async () => {
  const f = fixture();
  f.state.active = true; f.poller.sync(); await settle();
  f.state.diagnosticsVisible = true; f.poller.sync(); await settle();
  assert.equal(f.calls, 2); assert.equal([...f.timers.values()][0].delay, 2000);
  f.state.hidden = true; f.poller.sync(); await settle();
  assert.equal([...f.timers.values()][0].delay, 10000);
  f.state.diagnosticsVisible = false; f.poller.sync(); await settle();
  const before = f.calls;
  f.state.hidden = false; f.poller.sync(); await settle();
  assert.equal(f.calls, before + 1, 'returning captures the background interval even with diagnostics collapsed');
  f.state.context = 'room:other-presenter'; f.poller.sync(); await settle();
  assert.equal(f.calls, before + 2);
});

test('slow samples cannot overlap and queued refreshes coalesce without reviving a stopped timer', async () => {
  const completions = [];
  const f = fixture(() => new Promise(resolve => completions.push(resolve)));
  f.state.active = true; f.poller.sync();
  f.state.diagnosticsVisible = true; f.poller.sync();
  f.state.context = 'new-room:presenter'; f.poller.sync();
  assert.equal(f.calls, 1); assert.equal(f.timers.size, 0);
  completions.shift()(); await settle();
  assert.equal(f.calls, 2); assert.equal(f.timers.size, 0);
  f.poller.stop(); completions.shift()(); await settle();
  assert.equal(f.timers.size, 0);
  f.poller.sync(); assert.equal(f.calls, 2);
});

test('leaving during a sample drops queued refreshes and leaves no timers', async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  f.state.active = true; f.poller.sync();
  f.state.diagnosticsVisible = true; f.poller.sync();
  f.state.active = false; f.poller.sync();
  finish(); await settle();
  assert.equal(f.calls, 1); assert.equal(f.timers.size, 0);
});
