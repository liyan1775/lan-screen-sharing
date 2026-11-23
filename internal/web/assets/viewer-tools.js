const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const retryMode = '请再点一次切换观看模式。';

export function clampVideoView({scale, x, y}, {width, height, videoWidth, videoHeight}) {
  scale = clamp(scale, 1, 3);
  if (scale === 1 || !videoWidth || !videoHeight) return {scale, x: 0, y: 0};
  const fit = Math.min(width / videoWidth, height / videoHeight);
  const maxX = Math.max(0, (videoWidth * fit * scale - width) / 2);
  const maxY = Math.max(0, (videoHeight * fit * scale - height) / 2);
  return {scale, x: clamp(x, -maxX, maxX) || 0, y: clamp(y, -maxY, maxY) || 0};
}

export function canPictureInPicture(documentRef, video) {
  return !!documentRef.pictureInPictureEnabled && !video.disablePictureInPicture &&
    typeof video.requestPictureInPicture === 'function';
}

export function captureFilename(date) {
  const pad = value => String(value).padStart(2, '0');
  const day = [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join('');
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()].map(pad).join('');
  return `LAN分享-${day}-${time}.png`;
}

export async function downloadVideoFrame({documentRef, video, url = URL, date = new Date()}) {
  if (!video.videoWidth || !video.videoHeight || video.readyState < 2) return false;
  const canvas = documentRef.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return false;
  const link = documentRef.createElement('a');
  const objectURL = url.createObjectURL(blob);
  try {
    link.href = objectURL;
    link.download = captureFilename(date);
    link.click();
  } finally {
    // Give the browser time to start the download before releasing the PNG.
    setTimeout(() => url.revokeObjectURL(objectURL), 1000);
  }
  return true;
}

export function bindViewerTools({documentRef = document, stage, video, pip, capture, smaller, reset, larger,
  onNotice = () => {}, onDrag = () => {}, onPipChange = () => {}, ResizeObserverImpl = globalThis.ResizeObserver}) {
  let view = {scale: 1, x: 0, y: 0};
  let presentation = '', available = false, generation = 0;
  let drag = null, pendingPip = false, exitingPip = null;
  let capturing = false;
  const activePip = () => documentRef.pictureInPictureElement === video;
  const hasFrame = () => available && video.videoWidth > 0 && video.videoHeight > 0 && video.readyState >= 2;
  const setUnavailable = (button, disabled) => {
    // Keep focused controls reachable when a frame is lost or a zoom limit is reached.
    button.setAttribute('aria-disabled', String(disabled));
  };
  const update = () => {
    const active = activePip();
    const supported = canPictureInPicture(documentRef, video);
    const label = pip.querySelector('.button-label') || pip;
    label.textContent = active ? '退出画中画' : '画中画';
    pip.setAttribute('aria-pressed', String(active));
    pip.title = active ? '退出画中画' : !supported ? '当前浏览器不支持画中画' : !hasFrame() ? '画面就绪后可使用画中画' : '在悬浮小窗中观看';
    setUnavailable(pip, !active && (!supported || !hasFrame()));
    setUnavailable(capture, !hasFrame() || capturing);
    setUnavailable(smaller, !hasFrame() || view.scale <= 1);
    setUnavailable(reset, !hasFrame() || view.scale === 1);
    setUnavailable(larger, !hasFrame() || view.scale >= 3);
    const value = Number(view.scale.toFixed(2)) + '×';
    if (reset.textContent !== value) reset.textContent = value;
    reset.setAttribute('aria-label', `当前 ${value}，重置缩放`);
  };

  function apply(next, refresh = false) {
    const previousScale = view.scale;
    view = clampVideoView(next, {width: video.clientWidth, height: video.clientHeight, videoWidth: video.videoWidth, videoHeight: video.videoHeight});
    if (view.scale === 1) video.style.removeProperty('transform');
    else video.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    const zoomed = view.scale > 1 && available;
    stage.classList.toggle('is-zoomed', zoomed);
    if (zoomed) video.tabIndex = 0;
    else video.removeAttribute('tabindex');
    if (refresh || view.scale !== previousScale) update();
  }
  function zoom(scale, anchor = {x: 0, y: 0}) {
    if (!hasFrame()) return;
    scale = Math.round(clamp(scale, 1, 3) * 100) / 100;
    if (scale === view.scale) return;
    const ratio = scale / view.scale;
    apply({
      scale,
      x: anchor.x - (anchor.x - view.x) * ratio,
      y: anchor.y - (anchor.y - view.y) * ratio,
    });
    if (scale === 1) endDrag();
  }

  function endDrag() {
    if (!drag) return;
    const {id} = drag;
    drag = null;
    if (stage.hasPointerCapture?.(id)) stage.releasePointerCapture(id);
    stage.classList.remove('is-panning');
    onDrag(false);
  }
  function exitPip() {
    if (!activePip()) return Promise.resolve();
    if (!exitingPip) {
      exitingPip = Promise.resolve(documentRef.exitPictureInPicture()).finally(() => { exitingPip = null; });
    }
    return exitingPip;
  }
  async function togglePip() {
    if (pendingPip) return;
    if (activePip()) {
      try { await exitPip(); }
      catch { onNotice('暂时无法关闭画中画，请再点一次。'); }
      return;
    }
    if (!hasFrame() || !canPictureInPicture(documentRef, video)) return;
    const requestGeneration = generation;
    pendingPip = true;
    try {
      if (documentRef.fullscreenElement) await documentRef.exitFullscreen();
      if (requestGeneration !== generation || !hasFrame()) return;
      // In the usual path this call runs directly in the click's activation.
      await video.requestPictureInPicture();
      if (requestGeneration !== generation || !available) await exitPip();
    } catch (error) {
      if (requestGeneration === generation) {
        onNotice(error.name === 'NotAllowedError' ? retryMode : '暂时无法打开画中画，请稍后重试。');
      }
    } finally {
      pendingPip = false;
      update();
      onPipChange();
    }
  }

  pip.addEventListener('click', togglePip);
  for (const name of ['enterpictureinpicture', 'leavepictureinpicture']) {
    video.addEventListener(name, () => { update(); onPipChange(); });
  }
  for (const name of ['loadedmetadata', 'loadeddata', 'emptied', 'playing', 'resize']) {
    video.addEventListener(name, () => apply(view, true));
  }
  if (ResizeObserverImpl) new ResizeObserverImpl(() => apply(view)).observe(stage);

  smaller.addEventListener('click', () => zoom(view.scale - .25));
  reset.addEventListener('click', () => zoom(1));
  larger.addEventListener('click', () => zoom(view.scale + .25));
  stage.addEventListener('wheel', event => {
    if (event.target !== video || event.ctrlKey || event.metaKey || !event.deltaY || !hasFrame()) return;
    const bounds = stage.getBoundingClientRect();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1);
    event.preventDefault();
    zoom(view.scale - Math.sign(delta) * clamp(Math.abs(delta) / 600, .01, .25), {
      x: event.clientX - bounds.left - bounds.width / 2,
      y: event.clientY - bounds.top - bounds.height / 2,
    });
  }, {passive: false});
  stage.addEventListener('pointerdown', event => {
    if (drag || view.scale <= 1 || !available || event.target !== video || event.button !== 0) return;
    drag = {id: event.pointerId, x: event.clientX, y: event.clientY};
    stage.setPointerCapture(event.pointerId);
    stage.classList.add('is-panning');
    onDrag(true);
    event.preventDefault();
  });
  stage.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    apply({scale: view.scale, x: view.x + event.clientX - drag.x, y: view.y + event.clientY - drag.y});
    drag.x = event.clientX;
    drag.y = event.clientY;
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    stage.addEventListener(name, event => { if (drag?.id === event.pointerId) endDrag(); });
  }
  video.addEventListener('keydown', event => {
    if (view.scale <= 1 || !hasFrame() || event.altKey || event.ctrlKey || event.metaKey) return;
    const step = event.shiftKey ? 96 : 32;
    const offsets = {ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step]};
    if (!Object.hasOwn(offsets, event.key)) return;
    event.preventDefault();
    const [x, y] = offsets[event.key];
    apply({scale: view.scale, x: view.x + x, y: view.y + y});
  });
  capture.addEventListener('click', async () => {
    if (!hasFrame() || capturing) return;
    capturing = true;
    update();
    try {
      if (!await downloadVideoFrame({documentRef, video})) throw new Error('No frame exported');
      onNotice('已保存当前画面截图');
    } catch { onNotice('截图未能保存，请在画面就绪后重试。'); }
    finally { capturing = false; update(); }
  });
  update();
  return {
    canDoubleClick: () => view.scale === 1 && !drag,
    keepsPreview: () => pendingPip || activePip(),
    setPresentation(nextPresentation, nextAvailable) {
      available = !!nextAvailable;
      if (presentation !== nextPresentation) {
        presentation = nextPresentation;
        generation++;
        endDrag();
        apply({scale: 1, x: 0, y: 0}, true);
        if (activePip()) void exitPip().catch(() => {});
      } else {
        if (!available) {
          endDrag();
          if (activePip()) void exitPip().catch(() => {});
        }
        apply(view, true);
      }
    },
    beforeFullscreen() {
      if (pendingPip) return Promise.reject(new Error(retryMode));
      return activePip() ? exitPip() : null;
    },
  };
}
