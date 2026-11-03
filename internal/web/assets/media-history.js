const finite = value => Number.isFinite(value) && value >= 0 && value <= 10000 ? value : null;
const fps = value => Number.isFinite(value) ? value.toFixed(1) : '未报告';

export class MediaDiagnosticsHistory {
  constructor(limit = 120) { this.limit = Math.max(1, Math.min(120, limit)); this.samples = []; }
  record({ rows = [], visibility = '', target = '', time = Date.now() }) {
    const video = rows.filter(row => row.role === 'screenVideo').slice(0, 2).map(row => ({
      direction: row.direction === 'outbound-rtp' ? '发送' : '接收',
      fps: finite(row.fps), sourceFps: finite(row.sourceFps), intervalFps: finite(row.intervalFps), sourceIntervalFps: finite(row.sourceIntervalFps), seconds: finite(row.sampleIntervalSeconds),
      limit: { cpu: '编码性能', bandwidth: '带宽', other: '其他', none: '无' }[row.qualityLimitationReason] || '未报告',
      codec: ['VP8', 'VP9', 'H264', 'AV1'].includes(row.codec) ? row.codec : '未报告',
    }));
    if (!video.length) return;
    this.samples.push({ time, visibility: visibility === 'hidden' ? '页面后台' : visibility === 'visible' ? '页面前台' : '页面状态未知', target: ['720p30', '720p60', '1080p60'].includes(target) ? target : '未报告', video });
    if (this.samples.length > this.limit) this.samples.splice(0, this.samples.length - this.limit);
  }
  format() {
    if (!this.samples.length) return '尚无视频传输历史。';
    return ['最近的视频统计历史（仅在内存保留；切回网页后仍可查看全屏期间的区间平均值）：', ...this.samples.map(sample => {
      const time = new Date(sample.time).toISOString();
      const rows = sample.video.map(row => `${row.direction} ${fps(row.fps)} FPS / 实际采集 ${fps(row.sourceFps)} FPS / ${fps(row.seconds)} 秒区间平均：发送或接收 ${fps(row.intervalFps)} FPS、采集 ${fps(row.sourceIntervalFps)} FPS / ${row.codec} / 限制 ${row.limit}`).join('；');
      return `${time} · ${sample.visibility} · 目标 ${sample.target} · ${rows}`;
    })].join('\n');
  }
}
