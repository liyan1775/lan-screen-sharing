import { isolationStatus } from './state.js';

const setting = (track) => {
  try { const value = track.getSettings?.().restrictOwnAudio; return typeof value === 'boolean' ? value : null; }
  catch { return null; }
};

// Isolation is best-effort metadata, not permission to share captured audio.
// Never wait on an exact constraint that can block or interrupt system sound.
export async function prepareSystemAudioIsolation(track, recognized) {
  const initial = setting(track);
  let capability = 'unknown';
  try {
    const values = track.getCapabilities?.().restrictOwnAudio;
    if (Array.isArray(values) && values.length) capability = values.includes(true) ? 'available' : 'unavailable';
  } catch { /* A browser may omit capabilities; still verify the resulting setting. */ }
  const final = setting(track);
  const isolation = isolationStatus({ supported: recognized, requested: true, settings: { restrictOwnAudio: final === true && track.readyState !== 'ended' } });
  const diagnostics = { recognized: !!recognized, initial, capability, final, isolationConfirmed: isolation.state === 'browser_reported', audioAvailable: track.readyState !== 'ended' };
  return { isolation, diagnostics };
}

export function formatSystemAudioDiagnostics(d, userAgent = '') {
  if (!d) return '尚未尝试屏幕系统声音。';
  const value = input => input === true ? 'true' : input === false ? 'false' : '未报告';
  const capability = { available: '允许启用', unavailable: '当前音轨不支持', unknown: '未报告' }[d.capability] || '未报告';
  const browser = /(?:Edg|Chrome)\/\d+(?:\.\d+)*/g;
  return [
    `浏览器：${(String(userAgent).match(browser) || []).join(' · ') || '未报告'}`,
    `隔离接口识别：${value(d.recognized)}；初始音轨设置：${value(d.initial)}`,
    `当前音轨隔离能力：${capability}；隔离不作为系统声音共享的前提`,
    `最终隔离设置：${value(d.final)}；本次屏幕声音：${d.audioAvailable ? '已捕获' : '已结束或未捕获'}`,
    '未施加额外强制隔离约束；当前是否发送以页面状态为准。',
  ].join('\n');
}
