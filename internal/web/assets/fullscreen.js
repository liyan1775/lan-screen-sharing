export function bindScreenFullscreen({ documentRef = document, stage, gestureTarget = stage, button, onError = () => {} }) {
  let available = false;
  const supported = typeof stage?.requestFullscreen === 'function';
  const update = () => {
    const active = documentRef.fullscreenElement === stage;
    button.disabled = !supported || (!available && !active);
    button.textContent = active ? '退出全屏' : '全屏观看';
    button.setAttribute('aria-pressed', String(active));
    button.title = active ? '退出全屏（也可按 Esc）' : supported ? '全屏观看（也可双击画面）' : '当前浏览器不支持全屏';
  };
  const toggle = async () => {
    if (button.disabled) return;
    try {
      if (documentRef.fullscreenElement === stage) await documentRef.exitFullscreen();
      else await stage.requestFullscreen({ navigationUI: 'hide' });
    } catch { onError('无法进入全屏，请在 Chrome 或 Edge 中点击“全屏观看”重试。'); }
    update();
  };
  button.addEventListener('click', toggle);
  gestureTarget?.addEventListener('dblclick', (event) => {
    if (event.target === button || event.target?.closest?.('button')) return;
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
