import test from 'node:test';
import assert from 'node:assert/strict';
import { bindPlayerPointer } from '../../internal/web/assets/player-pointer.js';

test('the local viewing cursor hides after idle, wakes on movement, and keeps keyboard controls accessible', () => {
  const classes = new Set(), listeners = new Map(); let callback, clears = 0;
  const stage = { classList: { add: value => classes.add(value), remove: value => classes.delete(value) }, addEventListener: (name, fn) => listeners.set(name, fn) };
  const fire = () => { const fn = callback; callback = null; fn(); };
  const pointer = bindPlayerPointer({stage, setTimeoutImpl: fn => {callback = fn; return 1;}, clearTimeoutImpl: () => {callback = null; clears++;}});
  pointer.setAvailable(true); const first = callback; pointer.setAvailable(true); assert.equal(callback, first, 'room status refresh must not reset the idle delay');
  fire(); assert.equal(classes.has('pointer-idle'), true);
  listeners.get('pointermove')({target:{closest:()=>null}}); assert.equal(classes.has('pointer-idle'), false);
  fire(); listeners.get('focusin')(); assert.equal(classes.has('pointer-idle'), false);
  listeners.get('pointermove')({}); assert.equal(callback, null, 'keyboard-focused controls must stay visible');
  listeners.get('focusout')(); assert.equal(typeof callback, 'function');
  pointer.setAvailable(false); assert.equal(classes.has('pointer-idle'), false); assert.ok(clears > 0);
});
