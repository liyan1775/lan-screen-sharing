export function resetShareControls({ start, stop, verify, checklist, manualCheck }) {
  start.disabled = false;
  start.textContent = '选择显示器并开始共享';
  stop.disabled = true;
  stop.textContent = '停止屏幕共享';
  verify.hidden = false;
  verify.disabled = false;
  checklist.hidden = true;
  manualCheck.hidden = false;
}
