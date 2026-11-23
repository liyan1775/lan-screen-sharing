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
      stage = kind;
      target = quality;
      const own = kind === 'share';
      pill.hidden = !kind;
      observer.hidden = kind !== 'watch';
      trigger.hidden = !own;
      if (own) {
        const label = options.get(quality)?.label ?? '';
        if (summary.textContent !== label) {
          summary.textContent = label;
          trigger.setAttribute('aria-label', `共享画质目标 ${label}`);
        }
        for (const [value, {button}] of options) button.setAttribute('aria-pressed', String(value === quality));
      } else if (kind === 'watch') {
        const label = formatReceivedQuality(rows, presenter);
        if (received.textContent !== label) received.textContent = label;
      }
    },
  };
}
