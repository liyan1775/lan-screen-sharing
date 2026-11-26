import { formatVideoMeasurements } from './media-stats.js';

const localClock = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

export class MediaDiagnosticsHistory {
  constructor(limit = 120) {
    this.limit = Number.isInteger(limit) ? Math.max(1, Math.min(120, limit)) : 120;
    this.samples = [];
    this.resetInterval();
  }

  resetInterval() { this.previousVisibility = null; }

  record({ rows = [], visibility = '', target = '', time = Date.now() }) {
    const previous = this.previousVisibility;
    const current = visibility === 'visible' ? '前台' : visibility === 'hidden' ? '后台' : '状态未知';
    const video = rows.filter(row => row.role === 'screenVideo')
      .map(row => formatVideoMeasurements(row, { history: true, firstSample: previous === null }));
    if (!video.length) return;
    this.previousVisibility = current;
    this.samples.push({
      time: typeof time === 'string' ? time : localClock.format(time), video,
      visibility: previous !== null && previous !== current ? `${previous}→${current}（跨切换区间）` : `页面${current}`,
      target: ['720p30', '720p60', '1080p60'].includes(target) ? target : '未报告',
    });
    if (this.samples.length > this.limit) this.samples.shift();
  }

  format() {
    if (!this.samples.length) return '尚无视频传输历史。';
    return ['最近的视频统计历史（本机时间，仅在内存保留）：', ...this.samples.map(sample =>
      `${sample.time} · ${sample.visibility} · 目标 ${sample.target} · ${sample.video.join('；')}`)].join('\n');
  }
}
