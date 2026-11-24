import test from 'node:test';
import assert from 'node:assert/strict';
import { resetShareControls } from '../../internal/web/assets/ui-state.js';

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
