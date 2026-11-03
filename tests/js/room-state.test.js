import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canStopScreen,
  applyMicrophonePermission,
  inspectDisplaySurface,
  isolationStatus,
} from '../../internal/web/assets/state.js';

test('screenStopStateRetainsRoomAndVoice', () => {
  const state = { roomId: 'room-1', screenSharing: true, voiceConnected: true };
  const next = canStopScreen(state);
  assert.equal(next.screenSharing, false);
  assert.equal(next.voiceConnected, true);
  assert.equal(next.roomId, 'room-1');
});

test('viewerCanJoinWithoutMicrophone', () => {
  const next = applyMicrophonePermission({ joined: true, microphone: 'requesting' }, false);
  assert.deepEqual(next, { joined: true, microphone: 'denied', receiveOnly: true, code: 'MIC_PERMISSION_DENIED' });
});

test('displayModeRequiresMonitor', () => {
  assert.deepEqual(inspectDisplaySurface('monitor'), { allowed: true, state: 'ready', message: '' });
  assert.deepEqual(inspectDisplaySurface('window'), { allowed: false, state: 'DISPLAY_NOT_MONITOR', message: '检测到所选内容不是整块显示器，请重新选择显示器。' });
  assert.equal(inspectDisplaySurface('browser').allowed, false);
});

test('isolationNeverAutoPromotesFromSettings', () => {
  assert.equal(isolationStatus({ supported: true, requested: true, settings: { restrictOwnAudio: true } }).state, 'browser_reported');
  assert.equal(isolationStatus({ supported: true, requested: true, settings: { restrictOwnAudio: true } }).label, '浏览器报告约束已应用·实机未验证');
  assert.equal(isolationStatus({ supported: true, requested: true, settings: { restrictOwnAudio: true } }).verified, false);
  assert.equal(isolationStatus({ supported: true, requested: true, settings: { restrictOwnAudio: true }, manualResult: 'pass' }).verified, true);
  assert.equal(isolationStatus({ supported: false, requested: false, settings: {} }).state, 'unsupported');
  assert.equal(isolationStatus({ supported: true, requested: true, settings: {} }).state, 'not_applied');
  assert.deepEqual(isolationStatus({ supported: true, requested: true, settings: {}, missingAudio: true }), { state: 'missing_audio', label: '未捕获屏幕音频', verified: false });
});
