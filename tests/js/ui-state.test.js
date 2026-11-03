import test from 'node:test';
import assert from 'node:assert/strict';
import { resetShareControls } from '../../internal/web/assets/ui-state.js';

test('resetShareControls restores default labels and clears manual verification UI', () => {
  const makeButton = (text, disabled=false, hidden=false) => ({ textContent:text, disabled, hidden });
  const ui = {
    start: makeButton('选择无游戏声音模式后继续', true),
    stop: makeButton('取消待处理画面', false),
    verify: makeButton('开始三人声音隔离人工验证模式', true, true),
    checklist: { hidden:false }, manualCheck: { hidden:true },
  };
  resetShareControls(ui);
  assert.equal(ui.start.textContent, '选择显示器并开始共享');
  assert.equal(ui.start.disabled, false);
  assert.equal(ui.stop.textContent, '停止屏幕共享');
  assert.equal(ui.stop.disabled, true);
  assert.equal(ui.verify.hidden, false);
  assert.equal(ui.verify.disabled, false);
  assert.equal(ui.checklist.hidden, true);
  assert.equal(ui.manualCheck.hidden, false);
});
