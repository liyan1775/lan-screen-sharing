import { formatActualStats, QUALITY } from './media.js';

const limitNames = { cpu: '编码性能', bandwidth: '带宽', other: '其他', none: '无' };
const isSending = row => row.direction === 'outbound-rtp';
const measure = (value, digits, unit) => Number.isFinite(value) ? `${value.toFixed(digits)}${unit}` : '未报告';
const rate = value => Number.isFinite(value) ? measure(value / 1_000_000, 1, ' Mbps') : '未报告';
const codecName = row => row.codecProfile || row.codec || '未报告';

function acceleration(row) {
  const sending = isSending(row);
  const efficient = sending ? row.powerEfficientEncoder : row.powerEfficientDecoder;
  const implementation = sending ? row.encoderImplementation : row.decoderImplementation;
  const role = sending ? '编码' : '解码';
  if (efficient === false) return `软件或未加速${role}`;
  if (efficient === true) return implementation ? `硬件${role}` : `高能效${role}（浏览器报告）`;
  return '';
}

export function formatEncodingCounters(row) {
  const sending = isSending(row);
  const keyFrames = sending ? row.keyFramesEncoded : row.keyFramesDecoded;
  return [
    Number.isFinite(keyFrames) ? `${sending ? '编码' : '解码'}关键帧 ${keyFrames}` : '',
    Number.isFinite(row.averageQp) ? `QP ${row.averageQp.toFixed(1)}` : '',
    Number.isFinite(row.packetsLost) ? `丢包 ${row.packetsLost}` : '',
  ].filter(Boolean).join(' · ');
}

export function formatCaptureStats(track, rows = []) {
  if (!track) return '';
  const settings = track.getSettings?.() ?? {};
  const dimensions = settings.width && settings.height ? `${settings.width}×${settings.height}` : '分辨率未知';
  const configured = Number.isFinite(settings.frameRate) ? `${settings.frameRate.toFixed(1)} FPS` : '帧率未知';
  const source = rows.find((row) => isSending(row) && Number.isFinite(row.sourceFps));
  return `采集设置 ${dimensions} · ${configured}（设置值，非实测）${source ? ` · 实际采集 ${source.sourceFps.toFixed(1)} FPS` : ''}`;
}

export function formatVideoLinks(rows, memberName = () => '成员') {
  return rows.filter(row => row.role === 'screenVideo').map(row => {
    const direction = row.localRelay ? '本机编码 → 房间转发（编码一次）' : isSending(row) ? `发送给${memberName(row.peerId)}` : `接收${memberName(row.peerId)}`;
    const limit = row.qualityLimitationReason !== 'none' && limitNames[row.qualityLimitationReason];
    return [direction, formatActualStats(row), row.codec && codecName(row), acceleration(row),
      isSending(row) && Number.isFinite(row.availableOutgoingBitrate) && `可用带宽估计 ${rate(row.availableOutgoingBitrate)}`,
      limit && `${limit}限制`].filter(Boolean).join(' · ');
  }).join('\n');
}

export function formatPerformanceHint(rows, targetFps) {
  if (!Number.isFinite(targetFps) || targetFps < 50) return '';
  const outbound = rows.filter(row => isSending(row) && row.role === 'screenVideo' && Number.isFinite(row.fps));
  if (!outbound.some(row => row.fps < targetFps * 0.75)) return '';
  if (outbound.some(row => Number.isFinite(row.sourceFps) && row.sourceFps < targetFps * 0.75)) {
    return '实际采集帧率也偏低。游戏画面持续运动时，可比较独占全屏与无边框窗口（继续共享整个显示器），或适当限制游戏帧率留出显卡余量。';
  }
  if (outbound.some(row => row.qualityLimitationReason === 'cpu')) return '浏览器报告编码性能限制。请复制媒体诊断，比较编码格式、编码实现及本区间编码耗时。';
  if (outbound.some(row => row.qualityLimitationReason === 'bandwidth')) return '浏览器报告带宽限制。请检查局域网连接，并比较实际码率与每位成员的接收统计。';
  return '实际发送未达到目标帧率，浏览器未提供明确限制原因。请复制媒体诊断，比较游戏全屏前后的实际采集与发送数据。';
}

function durations(values) {
  const entries = Object.entries(limitNames).filter(([key]) => Number.isFinite(values?.[key]));
  return entries.map(([key, name]) => `${name} ${measure(values[key], 2, ' s')}`).join('、') || '未报告';
}

function feedback(row, delta) {
  const fields = [['NACK', 'nackCount'], ['PLI', 'pliCount'], ['FIR', 'firCount'], ['丢包', 'packetsLost']];
  if (isSending(row)) fields.push(['重传包', 'retransmittedPacketsSent']);
  if (delta) fields.push(isSending(row) ? ['编码关键帧', 'keyFramesEncoded'] : ['解码关键帧', 'keyFramesDecoded']);
  return fields.map(([label, key]) => `${label} ${measure(row[delta ? key + 'Delta' : key], 0, '')}`).join('、');
}

// Build the same measurements for a clipboard snapshot and an immutable history entry.
// Only explicitly selected media fields enter the report (no peer IDs, addresses or SDP).
export function formatVideoMeasurements(row, { history = false, firstSample = false, cap } = {}) {
  const sending = isSending(row);
  const direction = sending ? '发送' : '接收';
  const profile = row.profileLevelId ? `（profile-level-id=${row.profileLevelId}）` : '';
  const bandwidth = [`实际${direction} ${rate(row.bitrate)}`];
  if (sending) {
    bandwidth.push(`编码目标 ${rate(row.targetBitrate)}`, `${row.localRelay ? '本机转发链路' : ''}可用带宽估计 ${rate(row.availableOutgoingBitrate)}`);
    if (!history) bandwidth.push(`用户上限 ${rate(cap)}`);
  } else if (Number.isFinite(row.availableOutgoingBitrate)) {
    bandwidth.push(`本机可用出站带宽估计 ${rate(row.availableOutgoingBitrate)}`);
  }
  let interval = firstSample ? '首个样本（待下次采样计算区间均值）' : '待下次采样计算区间均值';
  if (Number.isFinite(row.sampleIntervalSeconds) && row.sampleIntervalSeconds > 0) {
    const rates = [];
    if (Number.isFinite(row.intervalFps)) rates.push(`${direction} ${measure(row.intervalFps, 1, ' FPS')}`);
    if (Number.isFinite(row.sourceIntervalFps)) rates.push(`采集 ${measure(row.sourceIntervalFps, 1, ' FPS')}`);
    interval = `${measure(row.sampleIntervalSeconds, 1, ' 秒')}区间${rates.length ? '平均：' + rates.join('、') : '帧率未报告'}`;
  }
  const lines = [
    `${direction} ${measure(row.fps, 1, ' FPS')} / 实际采集 ${measure(row.sourceFps, 1, ' FPS')} / ${interval}`,
    bandwidth.join(' / '),
    `编码格式 ${codecName(row)}${profile}`,
  ];
  if (!history) {
    const role = sending ? '编码' : '解码';
    const implementation = sending ? row.encoderImplementation : row.decoderImplementation;
    lines.push(`${role}加速 ${acceleration(row) || '未报告'} / ${role}实现 ${implementation || '未报告'}`);
  }
  if (sending) {
    lines.push(`本区间编码 ${measure(row.intervalEncodeMs, 2, ' ms/帧')} / 累计平均编码 ${measure(row.averageEncodeMs, 2, ' ms/帧')}`,
      `限制 ${limitNames[row.qualityLimitationReason] || '未报告'} / 本区间时长：${durations(row.qualityLimitationDurationsDelta)}`);
    if (!history) lines.push(`累计限制时长：${durations(row.qualityLimitationDurations)}`);
  }
  lines.push(formatEncodingCounters(row), `RTT ${measure(row.currentRoundTripTimeMs, 1, ' ms')}`,
    `本区间增量：${feedback(row, true)}`);
  if (!history) lines.push(`累计计数：${feedback(row, false)}`);
  return lines.filter(Boolean).join(history ? ' / ' : '\n  ');
}

export function formatMediaDiagnostics({ track, rows = [], target = '', shareCursor = false, visibility = '', audio = '' }) {
  const settings = track?.getSettings?.() ?? {};
  const cursor = ['never', 'always', 'motion'].includes(settings.cursor) ? settings.cursor : '未报告';
  const cap = QUALITY[target]?.bitrate;
  const detail = rows.filter(row => row.role === 'screenVideo').map((row, index) =>
    `连接 ${index + 1} · ${formatActualStats(row)}\n  ${formatVideoMeasurements(row, { cap })}`);
  return [`我的共享目标：${target}（设置值，非实测）${cap ? ` · 码率上限 ${cap / 1_000_000} Mbps` : ''} · 页面：${['visible', 'hidden'].includes(visibility) ? visibility : '未报告'}`,
    formatCaptureStats(track, rows) || '当前没有本机共享画面',
    `本机共享鼠标请求：${shareCursor ? '显示' : '隐藏'}；浏览器实际设置：${cursor}`,
    detail.length ? '当前视频快照' : '尚无实际视频连接统计', ...detail,
    '实际发送码率按采样区间内发送的字节数计算。突发关键帧时，短区间的平均码率可能高于用户上限。', audio].filter(Boolean).join('\n');
}
