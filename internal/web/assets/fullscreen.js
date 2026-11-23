export function bindScreenFullscreen({ documentRef = document, stage, gestureTarget = stage, button, onError = () => {}, onModeRetry = onError, beforeEnter = () => null, canDoubleClick = () => true }) {
  let available = false;
  const supported = typeof stage?.requestFullscreen === 'function';
  const update = () => {
    const active = documentRef.fullscreenElement === stage;
    button.disabled = !supported || (!available && !active);
    const label = button.querySelector?.('.button-label') || button;
    label.textContent = active ? '退出全屏' : '全屏观看';
    button.setAttribute('aria-pressed', String(active));
    button.title = active ? '退出全屏（Esc 或聚焦时按 F）' : supported ? '双击画面，或聚焦此按钮后按 F 全屏观看' : '当前浏览器不支持全屏';
  };
  const toggle = async () => {
    if (button.disabled) return;
    try {
      if (documentRef.fullscreenElement === stage) await documentRef.exitFullscreen();
      else {
        const switching = beforeEnter();
        if (switching) {
          try {
            await switching;
            if (!available) return;
            await stage.requestFullscreen({ navigationUI: 'hide' });
          } catch { onModeRetry('请再点一次切换观看模式。'); }
        } else await stage.requestFullscreen({ navigationUI: 'hide' });
      }
    } catch { onError('无法进入全屏，请在 Chrome 或 Edge 中点击“全屏观看”重试。'); }
    update();
  };
  button.addEventListener('click', toggle);
  button.addEventListener('keydown', event => {
    if (event.key.toLowerCase() !== 'f' || event.repeat || event.isComposing ||
        event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    event.preventDefault();
    void toggle();
  });
  gestureTarget?.addEventListener('dblclick', (event) => {
    if (!canDoubleClick() || event.target === button || event.target?.closest?.('button')) return;
    return toggle();
  });
  documentRef.addEventListener?.('fullscreenchange', update);
  update();
  return { setAvailable(value) {
    available = !!value;
    if (!available && documentRef.fullscreenElement === stage) Promise.resolve(documentRef.exitFullscreen()).catch(() => {});
    update();
  } };
}
