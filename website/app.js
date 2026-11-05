const tabs = [...document.querySelectorAll('[role="tab"]')];
function selectTab(tab, focus = false) {
  for (const item of tabs) {
    const active = item === tab;
    item.setAttribute('aria-selected', String(active));
    item.tabIndex = active ? 0 : -1;
    document.getElementById(item.getAttribute('aria-controls')).hidden = !active;
  }
  if (focus) tab.focus();
}
for (const [index, tab] of tabs.entries()) {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', event => {
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
    if (next !== null) { event.preventDefault(); selectTab(tabs[next], true); }
  });
}
const flow = document.querySelector('.flow');
for (const button of document.querySelectorAll('[data-compare]')) button.addEventListener('click', () => {
  const before = button.dataset.compare === 'before';
  for (const item of document.querySelectorAll('[data-compare]')) item.setAttribute('aria-pressed', String(item === button));
  flow.dataset.state = before ? 'before' : 'after';
  flow.setAttribute('aria-label', before ? '升级前为两位观众分别编码，共编码两次' : '0.5.0 只编码一次，将同一份编码画面发送给两位观众');
  document.getElementById('encoding-caption').textContent = before ? '分别为两位观众编码' : '同一份编码画面';
  document.querySelector('.compare-description').textContent = before ? '两位观众，两路视频编码。相同的画面，被重复处理。' : '编码一次，将相同的画面分别发送给两位观众。不解码、不重新压缩。';
});
if ('IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  document.documentElement.classList.add('motion-ready');
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) { entry.target.classList.add('is-visible'); observer.unobserve(entry.target); }
  }, { threshold: 0.06 });
  for (const node of document.querySelectorAll('.reveal')) observer.observe(node);
}
