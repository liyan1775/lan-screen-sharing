export function bindPlayerPointer({ stage, delayMs = 1500, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout }) {
  let available = false, timer = null, focused = false;
  const show = () => {
    if (timer !== null) clearTimeoutImpl(timer);
    timer = null; stage.classList.remove('pointer-idle');
  };
  const arm = (event) => {
    show();
    if (!available || focused || event?.target?.closest?.('button, input, select, a')) return;
    timer = setTimeoutImpl(() => { timer = null; stage.classList.add('pointer-idle'); }, delayMs);
  };
  stage.addEventListener('pointermove', arm);
  stage.addEventListener('pointerenter', arm);
  stage.addEventListener('pointerleave', show);
  stage.addEventListener('focusin', () => { focused = true; show(); });
  stage.addEventListener('focusout', () => { focused = false; arm(); });
  return { setAvailable(value) { if (available === !!value) return; available = !!value; if (available) arm(); else show(); } };
}
