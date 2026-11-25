import { isolationStatus } from './state.js';

export const WINDOW_VIDEO_ONLY_NOTE = '此窗口未共享声音，房间语音不受影响。';
export const CAPTURE_SOURCE_NOTE = '打游戏选整个屏幕，看 B 站或网页视频选单个浏览器标签页，展示单个软件可直接选应用窗口（仅画面，房间语音不受影响）。';

export function describeSilentCapture(displaySurface, reason, recognized) {
  return { displaySurface, reason, recognized: !!recognized, audioAvailable: false };
}

const setting = (track) => {
  try { const value = track.getSettings?.().restrictOwnAudio; return typeof value === 'boolean' ? value : null; }
  catch { return null; }
};

// Isolation is best-effort metadata, not permission to share captured audio.
// Never wait on an exact constraint that can block or interrupt system sound.
export async function prepareSystemAudioIsolation(track, recognized, { displaySurface } = {}) {
  const initial = setting(track);
  let capability = 'unknown';
  try {
    const values = track.getCapabilities?.().restrictOwnAudio;
    if (Array.isArray(values) && values.length) capability = values.includes(true) ? 'available' : 'unavailable';
  } catch { /* A browser may omit capabilities; still verify the resulting setting. */ }
  const final = setting(track);
  const isolation = isolationStatus({ supported: recognized, requested: true, settings: { restrictOwnAudio: final === true && track.readyState !== 'ended' } });
  const diagnostics = { recognized: !!recognized, initial, capability, final, isolationConfirmed: isolation.state === 'browser_reported', audioAvailable: track.readyState !== 'ended', displaySurface };
  return { isolation, diagnostics };
}

export function formatSystemAudioDiagnostics(d, userAgent = '') {
  if (!d) return '尚未尝试屏幕系统声音。';
  const value = input => input === true ? 'true' : input === false ? 'false' : '未报告';
  const capability = { available: '允许启用', unavailable: '当前音轨不支持', unknown: '未报告' }[d.capability] || '未报告';
  const browser = /(?:Edg|Chrome)\/\d+(?:\.\d+)*/g;
  const lines = [
    `浏览器：${(String(userAgent).match(browser) || []).join(' · ') || '未报告'}`,
  ];
  if (d.displaySurface === 'window') {
    return lines.concat(['采集来源：单个应用窗口', '本次未共享声音：应用窗口仅传送画面，房间语音单独传送。']).join('\n');
  }
  if (d.displaySurface === 'browser' && d.audioAvailable) {
    lines.push('采集来源：单个浏览器标签页（仅采集所选标签页声音，不混入房间语音）');
  }
  if (d.reason) {
    const source = d.displaySurface === 'browser' ? '单个浏览器标签页' : '整个屏幕';
    const reason = d.reason === 'missing_audio' ? '浏览器未返回可用的共享音轨。' : '已选择不共享系统声音。';
    return lines.concat([`采集来源：${source}`, `本次未共享声音：${reason}`]).join('\n');
  }
  return lines.concat([
    `隔离接口识别：${value(d.recognized)}；初始音轨设置：${value(d.initial)}`,
    `当前音轨隔离能力：${capability}；隔离不作为系统声音共享的前提`,
    `最终隔离设置：${value(d.final)}；本次屏幕声音：${d.audioAvailable ? '已捕获' : '已结束或未捕获'}`,
    '未施加额外强制隔离约束；当前是否发送以页面状态为准。',
  ]).join('\n');
}
