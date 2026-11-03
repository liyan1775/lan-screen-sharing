import test from 'node:test';
import assert from 'node:assert/strict';
import { bindScreenFullscreen } from '../../internal/web/assets/fullscreen.js';

function fixture() {
  const handlers = new Map();
  const documentRef = { fullscreenElement: null, addEventListener(type, fn) { handlers.set(type, fn); } };
  const button = { disabled: true, textContent: '', attrs: {}, addEventListener(type, fn) { this[type] = fn; }, setAttribute(key, value) { this.attrs[key] = value; } };
  const stage = { addEventListener(type, fn) { this[type] = fn; }, requests: 0, requestFullscreen() { this.requests++; documentRef.fullscreenElement = stage; handlers.get('fullscreenchange')?.(); return Promise.resolve(); } };
  documentRef.exitFullscreen = async () => { documentRef.fullscreenElement = null; handlers.get('fullscreenchange')?.(); };
  const errors = [];
  const control = bindScreenFullscreen({ documentRef, stage, button, onError: (message) => errors.push(message) });
  return { control, button, stage, documentRef, handlers, errors };
}

test('fullscreen needs a picture, supports the button and follows browser Esc changes', async () => {
  const { control, button, stage, documentRef, handlers } = fixture();
  await button.click();
  assert.equal(stage.requests, 0);
  control.setAvailable(true);
  await button.click();
  assert.equal(documentRef.fullscreenElement, stage);
  assert.equal(button.textContent, '退出全屏');
  documentRef.fullscreenElement = null;
  handlers.get('fullscreenchange')();
  assert.equal(button.textContent, '全屏观看');
  await stage.dblclick({ target: stage });
  assert.equal(stage.requests, 2);
  control.setAvailable(false);
  await Promise.resolve();
  assert.equal(documentRef.fullscreenElement, null);
  assert.equal(button.disabled, true);
});

test('fullscreen rejection remains visible without claiming fullscreen or breaking playback', async () => {
  const { control, button, stage, documentRef, errors } = fixture();
  stage.requestFullscreen = () => Promise.reject(new Error('permission denied'));
  control.setAvailable(true);
  await button.click();
  assert.equal(documentRef.fullscreenElement, null);
  assert.equal(button.textContent, '全屏观看');
  assert.equal(errors.length, 1);
  assert.equal(button.disabled, false);
});
