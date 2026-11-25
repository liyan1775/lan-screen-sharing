export function resetShareControls({ start, stop, verify, checklist, manualCheck }) {
  start.disabled = false;
  start.textContent = '选择内容并开始共享';
  stop.disabled = true;
  stop.textContent = '停止屏幕共享';
  verify.hidden = false;
  verify.disabled = false;
  checklist.hidden = true;
  manualCheck.hidden = false;
}

export const NOTICE_MS = 3500;
const FADE_MS = 220;

export function bindToast(node, {now = () => performance.now(), start = setTimeout, stop = clearTimeout} = {}) {
  const message = node.querySelector('[role="status"]');
  const close = node.querySelector('button');
  let timer = null, deadline = 0, remaining = 0, hovered = false, focused = false, returnFocus = null;
  function clearTimer() {
    if (timer !== null) stop(timer);
    timer = null;
  }
  function dismiss() {
    clearTimer();
    const target = focused ? returnFocus : null;
    hovered = false; focused = false; returnFocus = null;
    delete node.dataset.toastState;
    close.hidden = true;
    message.textContent = '';
    if (target?.isConnected) target.focus({preventScroll:true});
  }
  function resume() {
    if (hovered || focused || node.dataset.toastState !== 'visible' || timer !== null) return;
    deadline = now() + remaining;
    timer = start(() => {
      node.dataset.toastState = 'fading';
      remaining = 0;
      timer = start(dismiss, FADE_MS);
    }, remaining);
  }
  function pause() {
    if (timer === null) return;
    if (node.dataset.toastState === 'fading') {
      remaining = FADE_MS;
      node.dataset.toastState = 'visible';
    } else remaining = Math.max(0, deadline - now());
    clearTimer();
  }
  node.addEventListener('pointerenter', () => { hovered = true; pause(); });
  node.addEventListener('pointerleave', () => { hovered = false; resume(); });
  node.addEventListener('focusin', event => { focused = true; returnFocus = event.relatedTarget; pause(); });
  node.addEventListener('focusout', () => { focused = false; resume(); });
  close.addEventListener('click', dismiss);
  return {
    show(text) {
      clearTimer();
      node.dataset.toastState = 'visible';
      close.hidden = false;
      message.textContent = text;
      remaining = NOTICE_MS;
      resume();
    },
    dismiss,
  };
}

const ROOM_UI_KEY = 'lan-screen-sharing.room-ui';
const audioKey = (peerId, role) => JSON.stringify([peerId, role]);
const validFilters = ['all', 'microphone', 'systemAudio'];

// One active room per tab. The envelope must match both IDs before any value is read.
export function createRoomUIState(storage) {
  let active = null;
  function read() {
    try { return JSON.parse(storage?.getItem(ROOM_UI_KEY)); } catch { return null; }
  }
  function write(value) {
    try {
      if (value) storage?.setItem(ROOM_UI_KEY, JSON.stringify(value));
      else storage?.removeItem(ROOM_UI_KEY);
    } catch { /* Live controls work with storage disabled. */ }
  }
  return {
    begin(serviceId, roomId, restore = false) {
      const saved = restore && serviceId && roomId ? read() : null;
      const sameRoom = saved?.v === 1 && saved.serviceId === serviceId && saved.roomId === roomId;
      const state = sameRoom ? saved : {};
      const volumes = Object.create(null);
      for (const [key, value] of Object.entries(state.volumes ?? {})) {
        if (Number.isFinite(value?.volume) && value.volume >= 0 && value.volume <= 1) {
          volumes[key] = {volume:value.volume, muted:value.muted === true};
        }
      }
      active = {v:1, serviceId, roomId, volumes, micActive:state.micActive === true, voiceOnly:state.voiceOnly === true,
        audioFilter:validFilters.includes(state.audioFilter) ? state.audioFilter : 'all', textOpen:state.textOpen === true};
      if (serviceId && roomId) write(active);
      return active;
    },
    get current() { return active; },
    audio(peerId, role) { return active?.volumes[audioKey(peerId, role)]; },
    setAudio(peerId, role, patch) {
      if (!active) return;
      const key = audioKey(peerId, role);
      active.volumes[key] = {volume:1, muted:false, ...active.volumes[key], ...patch};
      if (active.serviceId && active.roomId) write(active);
    },
    set(patch) {
      if (!active) return;
      Object.assign(active, patch);
      if (active.serviceId && active.roomId) write(active);
    },
    clear() { active = null; write(null); },
  };
}
