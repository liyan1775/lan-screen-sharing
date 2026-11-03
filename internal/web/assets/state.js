export function canStopScreen(state) {
  return { ...state, screenSharing: false };
}

export function applyMicrophonePermission(state, granted) {
  return granted
    ? { ...state, microphone: 'ready', receiveOnly: false, code: '' }
    : { ...state, joined: true, microphone: 'denied', receiveOnly: true, code: 'MIC_PERMISSION_DENIED' };
}

export function inspectDisplaySurface(surface) {
  if (surface === 'monitor') return { allowed: true, state: 'ready', message: '' };
  return {
    allowed: false,
    state: 'DISPLAY_NOT_MONITOR',
    message: '检测到所选内容不是整块显示器，请重新选择显示器。',
  };
}

export function isolationStatus({ supported, requested, settings = {}, manualResult = '', missingAudio = false }) {
  if (manualResult === 'pass') return { state: 'manual_pass', label: '本房间用户手工确认', verified: true };
  if (manualResult === 'fail') return { state: 'manual_fail', label: '本房间用户手工未通过', verified: false };
  if (missingAudio) return { state: 'missing_audio', label: '未捕获屏幕音频', verified: false };
  if (!supported) return { state: 'unsupported', label: '浏览器不支持', verified: false };
  if (!requested || settings.restrictOwnAudio !== true) return { state: 'not_applied', label: '约束未应用', verified: false };
  return { state: 'browser_reported', label: '浏览器报告约束已应用·实机未验证', verified: false };
}

export const isolationLabels = Object.freeze({
  unverified: '未验证',
  unsupported: '浏览器不支持',
  not_applied: '约束未应用',
  browser_reported: '浏览器报告约束已应用·实机未验证',
  manual_pass: '本房间用户手工确认',
  manual_fail: '本房间用户手工未通过',
});

export function roomSummary(snapshot, selfPeerId = '') {
  const members = snapshot?.members ?? [];
  return members.map((member) => ({
    ...member,
    self: member.peerId === selfPeerId,
    label: `${member.role === 'host' ? '房主' : '成员'}${member.peerId === snapshot?.presenterPeerId ? ' · 正在共享' : ''}`,
    stateLabel: member.state === 'reconnecting' ? '重连中' : '已连接',
  }));
}
