import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { bindToast, createRoomUIState, resetShareControls } from '../../internal/web/assets/ui-state.js';

test('resetShareControls restores default labels and clears manual verification UI', () => {
  const makeButton = (text, disabled=false, hidden=false) => ({ textContent:text, disabled, hidden });
  const ui = {
    start: makeButton('请选择无共享声音模式', true),
    stop: makeButton('取消待处理画面', false),
    verify: makeButton('开始三人声音隔离人工验证模式', true, true),
    checklist: { hidden:false }, manualCheck: { hidden:true },
  };
  resetShareControls(ui);
  assert.equal(ui.start.textContent, '选择内容并开始共享');
  assert.equal(ui.start.disabled, false);
  assert.equal(ui.stop.textContent, '停止屏幕共享');
  assert.equal(ui.stop.disabled, true);
  assert.equal(ui.verify.hidden, false);
  assert.equal(ui.verify.disabled, false);
  assert.equal(ui.checklist.hidden, true);
  assert.equal(ui.manualCheck.hidden, false);
});

test('toast announces its text, fades at 3.5 seconds and removes its keyboard control', () => {
  const { node, toast, advance } = toastFixture();
  toast.show('已复制');
  assert.equal(node.querySelector('[role=status]').textContent, '已复制');
  assert.equal(node.querySelector('button').hidden, false);
  advance(3499);
  assert.equal(node.dataset.toastState, 'visible');
  advance(1);
  assert.equal(node.dataset.toastState, 'fading');
  advance(220);
  assert.equal(node.hasAttribute('data-toast-state'), false);
  assert.equal(node.textContent, '');
  assert.equal(node.querySelector('button').hidden, true);
});

test('hover and keyboard focus both pause the same countdown and the close button dismisses immediately', () => {
  const { node, toast, advance, fire, timers } = toastFixture();
  toast.show('第一条提示');
  advance(2000);
  fire('pointerenter');
  advance(5000);
  fire('focusin');
  fire('pointerleave');
  advance(5000);
  assert.equal(node.dataset.toastState, 'visible');
  fire('focusout');
  advance(1499);
  assert.equal(node.dataset.toastState, 'visible');
  advance(1);
  assert.equal(node.dataset.toastState, 'fading');
  toast.show('新提示');
  assert.equal(node.textContent, '新提示');
  node.querySelector('button').click();
  assert.equal(timers.size, 0);
  assert.equal(node.hasAttribute('data-toast-state'), false);
  assert.equal(node.textContent, '');
});

function toastFixture() {
  const {document, Event} = parseHTML('<div class="toast"><span role="status"></span><button type="button" hidden></button></div>');
  const node = document.querySelector('.toast'), timers = new Map();
  let time = 0, id = 0;
  const toast = bindToast(node, {
    now: () => time,
    start: (callback, delay) => { timers.set(++id, {callback, due:time + delay}); return id; },
    stop: id => timers.delete(id),
  });
  function advance(delta) {
    const until = time + delta;
    for (const [id, timer] of timers) {
      if (timer.due > until) continue;
      timers.delete(id);
      time = timer.due;
      timer.callback();
    }
    time = until;
  }
  return {node, toast, advance, fire: name => node.dispatchEvent(new Event(name)), timers};
}

test('room UI storage is scoped to service and room, distinguishes audio roles, and forgets on exit', () => {
  const values = new Map();
  const storage = {getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)};
  const first = createRoomUIState(storage);
  first.begin('service-a', 'room-a');
  first.set({micActive:true, voiceOnly:true, audioFilter:'systemAudio', textOpen:true});
  first.setAudio('peer', 'microphone', {volume:.4});
  first.setAudio('peer', 'microphone', {muted:true});
  first.setAudio('peer', 'systemAudio', {volume:.7});
  const [key, original] = [...values][0];
  const reload = createRoomUIState(storage);
  const restored = reload.begin('service-a', 'room-a', true);
  assert.deepEqual([restored.micActive, restored.voiceOnly, restored.audioFilter, restored.textOpen], [true, true, 'systemAudio', true]);
  assert.deepEqual(reload.audio('peer', 'microphone'), {volume:.4, muted:true});
  assert.deepEqual(reload.audio('peer', 'systemAudio'), {volume:.7, muted:false});
  for (const [serviceId, roomId, restore] of [
    ['service-b', 'room-a', true], ['service-a', 'room-b', true], ['service-a', 'room-a', false],
  ]) {
    values.set(key, original);
    const fresh = reload.begin(serviceId, roomId, restore);
    assert.equal(fresh.micActive, false);
    assert.equal(fresh.audioFilter, 'all');
    assert.equal(reload.audio('peer', 'microphone'), undefined);
  }
  reload.clear();
  reload.set({textOpen:true});
  assert.equal(values.size, 0, 'late updates after exit cannot create a storage record');
});
