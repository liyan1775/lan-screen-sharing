import assert from 'node:assert/strict';
import test from 'node:test';
import { syntheticToneFrequency, trackRolesFromProtocol } from './synthetic-media.js';

test('track role extractor preserves all frozen source roles', () => {
  const messages = [
    { type: 'rtc.description', payload: { tracks: [
      { mid: '0', role: 'screenVideo' },
      { mid: '1', role: 'systemAudio' },
      { mid: '2', role: 'microphone' },
    ] } },
    { type: 'heartbeat', payload: {} },
  ];
  assert.deepEqual(trackRolesFromProtocol(messages), [
    { mid: '0', role: 'screenVideo' },
    { mid: '1', role: 'systemAudio' },
    { mid: '2', role: 'microphone' },
  ]);
});

test('viewer viewer offer roles exclude screen sources', () => {
  const [offer] = trackRolesFromProtocol([{ type: 'rtc.description', payload: { tracks: [{ mid: '0', role: 'microphone' }] } }]);
  assert.deepEqual(offer, { mid: '0', role: 'microphone' });
});

test('each runner alias receives a distinct low-frequency synthetic microphone signature', () => {
  const tones = ['host', 'viewer-1', 'viewer-2', 'viewer-extra'].map((alias) => syntheticToneFrequency('microphone', alias));
  assert.deepEqual(tones, [523, 617, 733, 811]);
  assert.equal(new Set(tones).size, 4);
  assert.equal(syntheticToneFrequency('systemAudio', 'host'), 440);
  assert.equal(syntheticToneFrequency('systemAudio', 'viewer-1'), 440);
  assert.equal(syntheticToneFrequency('microphone', 'unknown'), 0);
});
