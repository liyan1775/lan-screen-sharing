import { formatActualStats } from './media.js';

export function formatCaptureStats(track, rows = []) {
  if (!track) return '';
  const settings = track.getSettings?.() ?? {};
  const dimensions = settings.width && settings.height ? `${settings.width}×${settings.height}` : '分辨率未知';
  const configured = Number.isFinite(settings.frameRate) ? `${settings.frameRate.toFixed(1)} FPS` : '帧率未知';
  const source = rows.find((row) => row.direction === 'outbound-rtp' && Number.isFinite(row.sourceFps));
  return `采集设置 ${dimensions} · ${configured}（设置值，非实测）${source ? ` · 实际采集 ${source.sourceFps.toFixed(1)} FPS` : ''}`;
}

export function formatVideoLinks(rows, memberName = () => '成员') {
  return rows.filter((row) => row.role === 'screenVideo' && row.width && row.height).map((row) => {
    const direction = row.direction === 'outbound-rtp' ? `发送给${memberName(row.peerId)}` : `接收${memberName(row.peerId)}`;
    const limit = { cpu: '编码性能限制', bandwidth: '带宽限制', other: '其他限制' }[row.qualityLimitationReason];
    const codec = row.codec ? ` · ${row.codec}` : '';
    return `${direction} · ${formatActualStats(row)}${codec}${limit ? ` · 浏览器报告：${limit}` : ''}`;
  }).join('\n');
}

export function formatPerformanceHint(rows, targetFps) {
  if (!Number.isFinite(targetFps) || targetFps < 50) return '';
  const outbound = rows.filter(row => row.direction === 'outbound-rtp' && row.role === 'screenVideo' && Number.isFinite(row.fps));
  if (!outbound.some(row => row.fps < targetFps * 0.75)) return '';
  if (outbound.some(row => Number.isFinite(row.sourceFps) && row.sourceFps < targetFps * 0.75)) {
    return '实际采集帧率也偏低。若持续运动的游戏画面仍如此，可比较独占全屏与无边框窗口（继续共享整个显示器），并复制媒体诊断；当前数据不能归因为网络。';
  }
  if (outbound.some(row => row.qualityLimitationReason === 'cpu')) return '浏览器报告编码性能限制。可试 720p · 60 FPS，并复制媒体诊断比较实际采集与发送帧率。';
  if (outbound.some(row => row.qualityLimitationReason === 'bandwidth')) return '浏览器报告带宽限制。可试 720p · 60 FPS，并比较每位成员的接收统计。';
  return '实际发送未达到目标帧率，浏览器未提供明确限制原因。请复制媒体诊断，比较游戏全屏前后的实际采集与发送数据。';
}

export function formatMediaDiagnostics({ track, rows = [], target = '', shareCursor = false, visibility = '', audio = '' }) {
  const settings = track?.getSettings?.() ?? {};
  const cursor = ['never', 'always', 'motion'].includes(settings.cursor) ? settings.cursor : '未报告';
  const detail = rows.filter(row => row.role === 'screenVideo').map((row, index) => {
    const source = Number.isFinite(row.sourceFps) ? row.sourceFps.toFixed(1) : '未报告';
    const encode = Number.isFinite(row.averageEncodeMs) ? row.averageEncodeMs.toFixed(2) : '未报告';
    const efficient = typeof row.powerEfficientEncoder === 'boolean' ? String(row.powerEfficientEncoder) : '未报告';
    return `连接 ${index + 1}：实际采集 ${source} FPS；累计平均编码 ${encode} ms/帧；浏览器报告节能编码 ${efficient}`;
  });
  return [`我的共享目标：${target}（设置值，非实测） · 页面：${['visible', 'hidden'].includes(visibility) ? visibility : '未报告'}`,
    formatCaptureStats(track, rows) || '当前没有本机共享画面',
    `本机共享鼠标请求：${shareCursor ? '显示' : '隐藏'}；浏览器实际设置：${cursor}`,
    formatVideoLinks(rows) || '尚无实际视频连接统计', ...detail, audio].filter(Boolean).join('\n');
}
