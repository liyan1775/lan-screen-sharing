import { QUALITY } from './media.js';

function dimensions(width, height) {
  const standard = new Map([[640,360],[854,480],[1280,720],[1920,1080],[2560,1440],[3840,2160]]);
  return standard.get(width) === height ? `${height}p` : `${width}×${height}`;
}

export function formatReceivedQuality(rows, presenter) {
  const row = rows.find(item => item.peerId === presenter && item.direction === 'inbound-rtp' &&
    item.role === 'screenVideo' && item.width > 0 && item.height > 0);
  if (!row) return '测量中…';
  const size = dimensions(row.width, row.height);
  return Number.isFinite(row.fps) && row.fps >= 0 ? `${size} · ${Math.round(row.fps)}fps` : size;
}

export function formatSharedQualityStatus(rows, quality, targetLabel) {
  const target = QUALITY[quality];
  const normal = { label: targetLabel, degraded: false };
  if (!target) return normal;

  // Chromium can omit size on a reading with no new encoded frame. Keep the
  // current stream's last measured size until it reports another one.
  const outbound = rows.filter(row => row.direction === 'outbound-rtp' && row.role === 'screenVideo')
    .map(row => {
      const size = row.width > 0 && row.height > 0 ? row : row.lastFrameSize;
      return { width: size?.width, height: size?.height, localRelay: row.localRelay };
    }).filter(row => row.width > 0 && row.height > 0);
  const relay = outbound.find(row => row.localRelay);
  const active = relay ? [relay] : outbound;
  const alignmentMargin = 16;
  const reduced = active.filter(row => row.width < target.width - alignmentMargin ||
    row.height < target.height - alignmentMargin);
  if (!reduced.length) return normal;

  const lowest = reduced.reduce((smallest, row) =>
    row.width * row.height < smallest.width * smallest.height ? row : smallest);
  const prefix = reduced.length < active.length ? '部分' : '实发';
  return { label: `${prefix} ${dimensions(lowest.width, lowest.height)} · 目标 ${target.height}p`, degraded: true };
}

export function bindQualityHUD({ document, select, onSelect }) {
  const $ = selector => document.querySelector(selector);
  const pill = $('#quality-pill'), trigger = $('#quality-trigger'), summary = trigger.querySelector('span');
  const picker = $('#quality-picker'), observer = $('#quality-observer'), received = $('#quality-received');
  const options = new Map([...select.querySelectorAll('option')].map(option => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button quality-option';
    button.textContent = option.textContent + (option.value === '1080p60' ? '（默认）' : '');
    button.addEventListener('click', () => {
      close(true);
      onSelect(option.value);
    });
    picker.append(button);
    return [option.value, {button, label: option.textContent.replace(' FPS', 'fps')}];
  }));
  let stage = '', target = select.value;
  let lastSharedRows, rowsBeforeTargetChange;
  function close(restoreFocus = false) {
    if (picker.hidden) return;
    picker.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus && !trigger.hidden) trigger.focus({preventScroll:true});
  }
  trigger.addEventListener('click', () => {
    if (!picker.hidden) { close(); return; }
    picker.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    options.get(target)?.button.focus({preventScroll:true});
  });
  pill.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !picker.hidden) {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  });
  pill.addEventListener('focusout', event => { if (event.relatedTarget && !pill.contains(event.relatedTarget)) close(); });
  document.addEventListener('pointerdown', event => { if (!pill.contains(event.target)) close(); });
  return {
    sync({kind, quality, rows, presenter}) {
      if (stage !== kind) close();
      const own = kind === 'share';
      const watching = kind === 'watch';
      if (pill.hidden !== !kind) pill.hidden = !kind;
      if (observer.hidden !== !watching) observer.hidden = !watching;
      if (trigger.hidden !== !own) trigger.hidden = !own;
      if (own) {
        // The caller reuses the latest stats array until the next poll.
        if (stage === kind && target !== quality) rowsBeforeTargetChange = lastSharedRows;
        lastSharedRows = rows;
        if (rows !== rowsBeforeTargetChange) rowsBeforeTargetChange = undefined;
      } else {
        lastSharedRows = rowsBeforeTargetChange = undefined;
      }
      if (own || stage === 'share') {
        const currentRows = own && rows !== rowsBeforeTargetChange ? rows : [];
        const { label, degraded } = formatSharedQualityStatus(currentRows,
          quality, options.get(quality)?.label ?? '');
        if (summary.textContent !== label) summary.textContent = label;
        const ariaLabel = degraded ? `共享画质 ${label}` : `共享画质目标 ${label}`;
        if (trigger.getAttribute('aria-label') !== ariaLabel) trigger.setAttribute('aria-label', ariaLabel);
        if (degraded) {
          if (trigger.getAttribute('data-degraded') !== 'true') trigger.setAttribute('data-degraded', 'true');
        } else if (trigger.hasAttribute('data-degraded')) {
          trigger.removeAttribute('data-degraded');
        }
      }
      if (own) {
        for (const [value, {button}] of options) {
          const pressed = String(value === quality);
          if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed', pressed);
        }
      } else if (watching) {
        const label = formatReceivedQuality(rows, presenter);
        if (received.textContent !== label) received.textContent = label;
      }
      stage = kind;
      target = quality;
    },
  };
}
