import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareSystemAudioIsolation, formatSystemAudioDiagnostics } from '../../internal/web/assets/system-audio-isolation.js';

test('a browser reported isolation setting is observed without claiming human verification', async () => {
  const track = { getSettings: () => ({ restrictOwnAudio: true }), getCapabilities: () => ({ restrictOwnAudio: [false, true] }), async applyConstraints() { assert.fail('isolation must not add a mandatory constraint'); } };
  const result = await prepareSystemAudioIsolation(track, true);
  assert.equal(result.diagnostics.final, true); assert.equal(result.diagnostics.isolationConfirmed, true);
  assert.equal(result.isolation.state, 'browser_reported'); assert.equal(result.isolation.verified, false);
});

test('API recognition does not imply support by the source or Windows version', async () => {
  let calls = 0;
  const track = { getSettings: () => ({ restrictOwnAudio: false }), getCapabilities: () => ({ restrictOwnAudio: [false] }), async applyConstraints() { calls++; } };
  const result = await prepareSystemAudioIsolation(track, true);
  assert.equal(calls, 0); assert.equal(result.diagnostics.capability, 'unavailable'); assert.equal(result.diagnostics.isolationConfirmed, false); assert.equal(result.diagnostics.audioAvailable, true);
});

test('unknown restriction settings are honest metadata and do not make captured audio unavailable', async () => {
  const track = { getSettings: () => ({}), async applyConstraints() { assert.fail('must not wait on a mandatory retry'); } };
  const result = await prepareSystemAudioIsolation(track, true);
  assert.equal(result.diagnostics.final, null); assert.equal(result.diagnostics.isolationConfirmed, false); assert.equal(result.diagnostics.audioAvailable, true);
});

test('diagnostics exclude capability errors and injected secrets without describing unconfirmed audio as blocked', async () => {
  const track = { getSettings: () => ({ restrictOwnAudio: false }), getCapabilities() { throw new Error('secret-token'); } };
  const result = await prepareSystemAudioIsolation(track, true);
  const text = formatSystemAudioDiagnostics({ ...result.diagnostics, token: 'another-secret' }, 'Mozilla private-profile Chrome/141.0 Edg/141.1');
  assert.match(text, /本次屏幕声音：已捕获/); assert.match(text, /Edg\/141.1/); assert.doesNotMatch(text, /secret|private-profile|未发送/);
});
