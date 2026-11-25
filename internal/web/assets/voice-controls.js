const space = event => event.code === 'Space' || event.key === ' ';
const composing = event => event.isComposing || event.keyCode === 229;
const interactive = 'button, input, textarea, select, option, label, summary, a[href], audio[controls], video[controls], [role="button"], [role="slider"], [role="switch"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="combobox"], [role="textbox"], [role="spinbutton"], [contenteditable]:not([contenteditable="false"])';

export function bindPushToTalk({ document, window, button, canTalk, onChange }) {
  const held = new Set();
  function hold(source, down) {
    const wasHeld = held.size > 0;
    if (down) held.add(source);
    else held.delete(source);
    if (wasHeld !== (held.size > 0)) onChange(held.size > 0);
  }
  function release() {
    if (!held.size) return;
    held.clear();
    onChange(false);
  }
  function blocked(event) {
    return composing(event) || event.ctrlKey || event.metaKey || event.altKey ||
      document.querySelector('dialog[open]') ||
      [event.target, document.activeElement].some(node => node?.isContentEditable || node?.closest?.(interactive));
  }
  document.addEventListener('keydown', event => {
    if (!space(event) || event.defaultPrevented || blocked(event) || !canTalk()) return;
    if (event.repeat && !held.has('space')) return;
    event.preventDefault();
    hold('space', true);
  });
  document.addEventListener('keyup', event => {
    if (!space(event) || !held.has('space')) return;
    if (!blocked(event)) event.preventDefault();
    hold('space', false);
  });
  document.addEventListener('compositionstart', release);
  document.addEventListener('focusin', event => {
    if (blocked(event)) hold('space', false);
  });
  window.addEventListener?.('blur', release);
  window.addEventListener?.('pagehide', release);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') release(); });

  button.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !canTalk()) return;
    button.setPointerCapture?.(event.pointerId);
    hold(event.pointerId, true);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    button.addEventListener(type, event => hold(event.pointerId, false));
  }
  button.addEventListener('contextmenu', event => { if (held.size) event.preventDefault(); });
  const buttonKey = event => space(event) ? 'button-space' : event.key === 'Enter' ? 'button-enter' : '';
  button.addEventListener('keydown', event => {
    const key = buttonKey(event);
    if (!key || composing(event) || !canTalk()) return;
    if (!event.repeat) hold(key, true);
  });
  button.addEventListener('keyup', event => {
    const key = buttonKey(event);
    if (key) hold(key, false);
  });
  button.addEventListener('blur', release);
  return { release };
}

const audioInputs = list => list.filter(input => input.kind === 'audioinput' && input.deviceId && !['default', 'communications'].includes(input.deviceId));
const deviceLabel = label => Array.from((label || '').replace(/\p{Cc}/gu, '').trim()).slice(0,160).join('');
const restorePermissionMessage = '麦克风已关闭，请在浏览器中允许麦克风后再开启。';
const restoreDeviceMessage = '未能自动恢复麦克风，请检查设备连接和浏览器权限，再点击开启麦克风。';
function rememberedDevice(inputs, label) {
  if (!label) return null;
  const matches = inputs.filter(input => deviceLabel(input.label) === label);
  return matches.length === 1 ? matches[0] : null;
}

export async function captureMicrophone(devices, deviceId, isCurrent, {label = '', signal, allowFallback = true} = {}) {
  const request = id => devices.getUserMedia({ audio: id ? { deviceId: { exact: id } } : true, video: false });
  try {
    return { stream: await request(deviceId), deviceId };
  } catch (error) {
    if (!allowFallback || !deviceId || !['NotFoundError', 'OverconstrainedError'].includes(error.name) || !isCurrent()) throw error;
  }
  const stream = await request('');
  if (!label || !isCurrent()) return {stream, deviceId:''};

  // A new localhost port can have new device IDs and hide labels until capture.
  // Keep the permission track local while resolving a uniquely named device.
  let released = false;
  function release() {
    if (released) return;
    released = true;
    stream.getTracks().forEach(track => track.stop());
  }
  signal?.addEventListener('abort', release, {once:true});
  try {
    const inputs = audioInputs(await devices.enumerateDevices?.() ?? []);
    const match = rememberedDevice(inputs, label);
    if (match && isCurrent()) {
      const replacement = await request(match.deviceId);
      release();
      return {stream:replacement, deviceId:match.deviceId, label:deviceLabel(match.label)};
    }
  } catch { /* The system default is already available if the remembered device cannot be opened. */ }
  finally { signal?.removeEventListener('abort', release); }
  if (released) throw Object.assign(new Error('麦克风采集已取消。'), {code:'CAPTURE_CANCELLED'});
  return {stream, deviceId:''};
}

function createLevelMeter({ window, meter }) {
  let current;
  return function sync(stream) {
    if (current?.stream === stream) return;
    if (current) {
      window.cancelAnimationFrame(current.frame);
      void current.context.close().catch(() => {});
      current = null;
    }
    meter.style.setProperty('--mic-level', '0');
    meter.dataset.active = 'false';
    if (!stream || !window.AudioContext) return;
    let context;
    try {
      context = new window.AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const state = current = { stream, context, frame: 0 };
      let level = 0;
      function measure() {
        if (current !== state) return;
        analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
        const next = Math.min(1, Math.sqrt(rms * 5));
        level += (next - level) * (next > level ? 0.42 : 0.16);
        meter.style.setProperty('--mic-level', level.toFixed(3));
        state.frame = window.requestAnimationFrame(measure);
      }
      meter.dataset.active = 'true';
      void context.resume().catch(() => {});
      state.frame = window.requestAnimationFrame(measure);
    } catch {
      current = null;
      meter.dataset.active = 'false';
      void context?.close().catch(() => {});
    }
  };
}

export function createVoiceControls({ document, window, devices, permissions, media, preferences, canUseRoom, onError, onNotice, onChange,
  onRestoreFeedback = () => {},
  onActiveChange = () => {} }) {
  const $ = selector => document.querySelector(selector);
  const device = $('#mic-device'), mode = $('#mic-mode'), toggle = $('#toggle-mic');
  const test = $('#test-mic'), note = $('#mic-note'), settings = $('#settings-dialog'), ptt = $('#push-to-talk');
  const setMeter = createLevelMeter({ window, meter: $('#mic-level') });
  let roomStream, activeDeviceId, testStream, testDeviceId, roomRequest, testRequest, retry = false;
  let listing = 0, seenIds = new Set(), inputs = [], held = false;
  const values = preferences.values;
  const pttMode = () => values.micMode === 'ptt';
  const sending = () => !testRequest && (!pttMode() || (canUseRoom() && held && document.visibilityState !== 'hidden'));
  const pushToTalk = bindPushToTalk({ document, window, button: ptt,
    canTalk: () => pttMode() && !!media.microphoneTrack && !testRequest && canUseRoom() && document.visibilityState !== 'hidden',
    onChange: value => { held = value; onChange(); },
  });

  function sync() {
    const track = media.microphoneTrack;
    const talking = !!track && pttMode() && sending();
    if (track) track.enabled = sending();
    toggle.disabled = (!!roomRequest && !track) || !canUseRoom();
    const label = roomRequest && !track ? '正在开启麦克风…' : track ? '关闭麦克风' : retry ? '重试麦克风' : '开启麦克风';
    if (toggle.textContent !== label) toggle.textContent = label;
    toggle.dataset.enabled = String(!!track);
    mode.value = values.micMode;
    device.disabled = !!roomRequest;
    test.disabled = !!roomRequest;
    test.textContent = testRequest ? '停止试音' : '测试麦克风';
    test.setAttribute('aria-pressed', String(!!testRequest));
    ptt.hidden = !pttMode() || !track;
    ptt.disabled = !!testRequest || !canUseRoom();
    ptt.setAttribute('aria-pressed', String(talking));
    setMeter(settings.open && document.visibilityState !== 'hidden'
      ? (testRequest ? testStream : track && roomStream) || null : null);
  }

  function notify(message) { if (note.textContent !== message) note.textContent = message; }
  function selectDevice(id, label = deviceLabel(inputs.find(input => input.deviceId === id)?.label)) {
    preferences.set({micDeviceId:id, micDeviceLabel:label || (id === values.micDeviceId ? values.micDeviceLabel : '')});
    device.value = id;
  }
  function stopTest() {
    if (!testRequest) return;
    testRequest.abort();
    testRequest = null;
    testStream?.getTracks().forEach(track => track.stop());
    testStream = null;
    testDeviceId = '';
    notify('');
    sync();
  }
  function cancelRoomRequest() {
    if (!roomRequest) return;
    roomRequest.abort();
    roomRequest = null;
    media.cancelMicrophoneCapture();
    device.value = values.micDeviceId;
  }
  function suspend({ close = false } = {}) {
    cancelRoomRequest();
    pushToTalk.release();
    if (close) {
      roomStream = null; activeDeviceId = ''; retry = false;
      if (media.microphoneTrack) media.stopMicrophone();
      onRestoreFeedback('');
      notify('');
    }
    stopTest();
    sync();
  }

  function renderDevices() {
    const option = (value, label) => Object.assign(document.createElement('option'), {value, textContent: label});
    const options = [option('', '系统默认麦克风'), ...inputs.map((input, index) =>
      option(input.deviceId, input.label || `麦克风 ${index + 1}`))];
    if (values.micDeviceId && !inputs.some(input => input.deviceId === values.micDeviceId)) {
      options.push(option(values.micDeviceId, values.micDeviceLabel || '已保存的麦克风'));
    }
    device.replaceChildren(...options);
    device.value = values.micDeviceId;
  }
  async function refreshDevices() {
    const revision = ++listing;
    let all;
    try { all = await devices?.enumerateDevices?.(); } catch { return; }
    if (!all || revision !== listing) return;
    const audio = all.filter(input => input.kind === 'audioinput');
    inputs = audioInputs(audio);
    const ids = new Set(inputs.map(input => input.deviceId));
    const saved = values.micDeviceId;
    // Before permission the browser can redact IDs, even for a plugged-in device.
    const hasLabels = audio.some(input => input.label);
    const missing = id => id && !ids.has(id) && (hasLabels || inputs.length > 0 || (!audio.length && seenIds.has(id)));
    if (missing(testDeviceId)) {
      stopTest();
      notify('试音麦克风已断开。');
      onChange();
    }
    const knownList = hasLabels || (!audio.length && seenIds.has(saved));
    if (missing(saved) && (!values.micDeviceLabel || knownList) && !roomRequest && !testRequest) {
      const match = seenIds.has(saved) ? null : rememberedDevice(inputs, values.micDeviceLabel);
      selectDevice(match?.deviceId || '');
      if (!match) {
        const message = '已选麦克风不可用，已改用系统默认麦克风。';
        onNotice(message);
      }
    } else if (saved && ids.has(saved)) {
      const label = deviceLabel(inputs.find(input => input.deviceId === saved)?.label);
      if (label) preferences.set({micDeviceLabel:label});
    }
    if (missing(activeDeviceId) && media.microphoneTrack && !roomRequest) {
      media.stopMicrophone();
      onActiveChange(false);
      pushToTalk.release();
      roomStream = null; activeDeviceId = '';
      const message = '麦克风已断开，请重新开启麦克风。';
      notify(message);
      if (!settings.open) onNotice(message);
      onChange();
    }
    for (const id of ids) seenIds.add(id);
    if (!roomRequest) renderDevices();
  }

  async function openRoomMicrophone(id, { automatic = false } = {}) {
    const request = new AbortController();
    roomRequest = request;
    stopTest();
    notify('');
    onError('');
    sync();
    const isCurrent = () => roomRequest === request && canUseRoom();
    const label = id === values.micDeviceId && !seenIds.has(id) ? values.micDeviceLabel : '';
    let selectedId = id, selectedLabel;
    try {
      if (automatic) {
        let permission;
        try { permission = await permissions?.query({name:'microphone'}); }
        catch { /* The browser may not support querying this permission. Try capture. */ }
        if (!isCurrent()) return null;
        if (permission?.state === 'denied') return { active:false, message:restorePermissionMessage };
      }
      const capture = captureMicrophone(devices, id, isCurrent, {label, signal:request.signal, allowFallback:!automatic}).then(result => {
        selectedId = result.deviceId;
        selectedLabel = result.label;
        return result.stream;
      });
      const {stream, track} = await media.setMicrophoneFromCapture(capture, sending);
      if (!isCurrent()) return null;
      if (track.readyState === 'ended') {
        media.stopMicrophone();
        throw new Error('麦克风音轨已结束。');
      }
      roomStream = stream;
      activeDeviceId = selectedId;
      selectDevice(selectedId, selectedLabel);
      if (id && !selectedId) onNotice('所选麦克风不可用，已使用系统默认麦克风。');
      track.addEventListener?.('ended', () => {
        if (media.microphoneTrack !== track) return;
        cancelRoomRequest();
        media.stopMicrophone();
        onActiveChange(false);
        pushToTalk.release();
        roomStream = null; activeDeviceId = '';
        const message = '麦克风已断开，请重新开启麦克风。';
        notify(message);
        if (automatic) onRestoreFeedback(message);
        if (!settings.open) onNotice(message);
        onChange();
        void refreshDevices();
      }, {once:true});
      retry = false;
      onRestoreFeedback('');
      onActiveChange(true);
      void refreshDevices();
      return { active:true };
    } catch (error) {
      if (!isCurrent()) return null;
      device.value = values.micDeviceId;
      if (automatic) return { active:false, message:['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(error.name)
        ? restorePermissionMessage : restoreDeviceMessage };
      if (error.code === 'CAPTURE_CANCELLED') return null;
      retry = !media.microphoneTrack;
      const message = error.code === 'MIC_SWITCH_FAILED' ? error.message
        : media.microphoneTrack ? '无法使用所选麦克风，仍在使用原来的麦克风。'
          : error.name === 'NotAllowedError' ? '麦克风权限未开启，请在浏览器中允许后重试。'
            : '无法开启麦克风，请检查设备连接和浏览器权限后重试。';
      onError(message);
    } finally {
      if (roomRequest === request) { roomRequest = null; onChange(); }
    }
  }

  toggle.addEventListener('click', async () => {
    if (!canUseRoom()) return;
    if (!media.microphoneTrack) {
      if (!roomRequest) return openRoomMicrophone(values.micDeviceId);
      return;
    }
    cancelRoomRequest();
    pushToTalk.release();
    roomStream = null; activeDeviceId = ''; retry = false;
    notify('');
    onError('');
    media.stopMicrophone();
    onActiveChange(false);
    onChange();
  });
  device.addEventListener('change', async () => {
    const id = device.value;
    if (roomRequest || id === values.micDeviceId) return;
    stopTest();
    notify('');
    if (media.microphoneTrack && canUseRoom()) return openRoomMicrophone(id);
    selectDevice(id);
  });
  mode.addEventListener('change', () => {
    const selected = mode.value;
    pushToTalk.release();
    preferences.set({micMode: selected});
    onChange();
  });
  test.addEventListener('click', async () => {
    if (testRequest) { stopTest(); onChange(); return; }
    if (!settings.open || roomRequest) return;
    const request = testRequest = new AbortController();
    pushToTalk.release();
    const isCurrent = () => testRequest === request && settings.open;
    notify('正在开启试音…');
    onChange();
    try {
      const id = values.micDeviceId;
      const result = await captureMicrophone(devices, id, isCurrent, {
        label:seenIds.has(id) ? '' : values.micDeviceLabel, signal:request.signal,
      });
      if (!isCurrent()) { result.stream.getTracks().forEach(track => track.stop()); return; }
      const track = result.stream.getAudioTracks()[0];
      if (!track || track.readyState === 'ended') {
        result.stream.getTracks().forEach(item => item.stop());
        throw new Error('没有可用的试音轨道');
      }
      testStream = result.stream;
      testDeviceId = result.deviceId;
      track.addEventListener?.('ended', () => {
        if (!isCurrent()) return;
        stopTest(); notify('试音麦克风已断开。'); onChange();
        void refreshDevices();
      }, {once:true});
      if (id !== result.deviceId) selectDevice(result.deviceId, result.label);
      notify(id && !result.deviceId ? '所选麦克风不可用，正在用系统默认麦克风试音。' : '试音中 · 仅本机');
      void refreshDevices();
    } catch {
      if (!isCurrent()) return;
      stopTest();
      notify('无法试音，请检查麦克风连接与浏览器权限后重试。');
    }
    onChange();
  });
  devices?.addEventListener?.('devicechange', () => void refreshDevices());
  settings.addEventListener('toggle', () => {
    if (settings.open) { pushToTalk.release(); void refreshDevices(); }
    else stopTest();
    onChange();
  });
  settings.addEventListener('close', () => { stopTest(); notify(''); onChange(); });
  window.addEventListener?.('pagehide', () => suspend({close:true}));
  return {
    sync, suspend, release: pushToTalk.release,
    restore({refresh = true} = {}) { sync(); renderDevices(); if (refresh) void refreshDevices(); },
    restoreRoomMicrophone() {
      if (!canUseRoom() || roomRequest) return null;
      if (media.microphoneTrack?.readyState === 'live') return { active:true };
      return openRoomMicrophone(values.micDeviceId, {automatic:true});
    },
    get talking() { return !!media.microphoneTrack && pttMode() && sending(); },
    get mode() { return values.micMode; },
  };
}
