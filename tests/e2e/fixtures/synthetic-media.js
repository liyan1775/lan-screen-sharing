/**
 * Runs in an isolated browser page before the production app loads. Replaces
 * capture APIs with deterministic canvas/WebAudio tracks and observes, without
 * faking, native peer connections, WebSockets, page errors, and local requests.
 */
const MICROPHONE_TONES = Object.freeze({ host: 523, 'viewer-1': 617, 'viewer-2': 733, 'viewer-extra': 811 });

export function syntheticToneFrequency(label, participantAlias) {
  if (label === 'systemAudio') return 440;
  return MICROPHONE_TONES[participantAlias] ?? 0;
}

export function installSyntheticMedia({ denyMicrophone = false, participantAlias = 'viewer-1', captureWidth = 1280, captureHeight = 720, captureFps = 30 } = {}) {
  // Playwright serializes this function without the module scope. Keep its
  // capture frequency lookup local as well as the exported test helper.
  const syntheticToneFrequency = (label, alias) => label === 'systemAudio' ? 440 : ({ host:523, 'viewer-1':617, 'viewer-2':733, 'viewer-extra':811 }[alias] ?? 0);
  const state = { pcs: [], sent: [], incoming: [], received: [], localDescriptions: [], remoteDescriptions: [], captures: [], sources: [], sockets: [], localSockets: [], nextSocketId: 1, denyMicrophone, participantAlias, network: { httpErrors: 0, wsErrors: 0, wsCloses: [], externalResources: 0, pageErrors: 0, unhandledRejections: 0, policyViolations: 0 } };
  Object.defineProperty(window, '__lanScreenTest', { value: state, configurable: false });

  const safeLocalURL = (value) => {
    try {
      const target = new URL(value, location.href);
      return ['http:', 'https:', 'ws:', 'wss:'].includes(target.protocol) && target.host === location.host;
    } catch { return false; }
  };
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    try {
      const response = await originalFetch(...args);
      if (!response.ok) state.network.httpErrors += 1;
      return response;
    } catch (error) {
      state.network.httpErrors += 1;
      throw error;
    }
  };
  window.addEventListener('error', () => { state.network.pageErrors += 1; }, true);
  window.addEventListener('unhandledrejection', () => { state.network.unhandledRejections += 1; });
  window.addEventListener('securitypolicyviolation', () => { state.network.policyViolations += 1; });
  if (typeof PerformanceObserver === 'function') {
    try {
      const resources = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) if (!safeLocalURL(entry.name)) state.network.externalResources += 1;
      });
      resources.observe({ type: 'resource', buffered: true });
    } catch { /* resource timing observation may be unavailable */ }
  }

  const NativePeerConnection = window.RTCPeerConnection;
  window.RTCPeerConnection = new Proxy(NativePeerConnection, {
    construct(target, args) {
      const pc = new target(...args);
      const pcId = state.pcs.length;
      state.pcs.push(pc);
      const nativeLocalDescription = pc.setLocalDescription.bind(pc);
      pc.setLocalDescription = async (...descriptionArgs) => {
        const result = await nativeLocalDescription(...descriptionArgs);
        state.localDescriptions.push({ pcId, sdp: pc.localDescription?.sdp ?? '' });
        return result;
      };
      const nativeRemoteDescription = pc.setRemoteDescription.bind(pc);
      pc.setRemoteDescription = async (...descriptionArgs) => {
        const result = await nativeRemoteDescription(...descriptionArgs);
        state.remoteDescriptions.push({ pcId, sdp: pc.remoteDescription?.sdp ?? '' });
        return result;
      };
      pc.addEventListener('track', (event) => {
        const received = { pcId, kind: event.track.kind, mid: event.transceiver.mid, trackId: event.track.id, state: event.track.readyState, muted: event.track.muted, track: event.track };
        state.received.push(received);
        event.track.addEventListener('ended', () => { received.state = event.track.readyState; }, { once: true });
        event.track.addEventListener('mute', () => { received.muted = event.track.muted; received.mutedAt = performance.now(); });
        event.track.addEventListener('unmute', () => { received.muted = event.track.muted; });
      });
      return pc;
    },
  });

  const NativeWebSocket = window.WebSocket;
  window.WebSocket = new Proxy(NativeWebSocket, {
    construct(target, args) {
      const socket = new target(...args);
      const parsedSocketURL = new URL(args[0], location.href);
      const socketId = state.nextSocketId++;
      socket.__lanScreenHarnessSocketId = socketId;
      if (!safeLocalURL(args[0])) state.network.externalResources += 1;
      if (parsedSocketURL.pathname === '/ws/v1' && parsedSocketURL.host === location.host) {
        const localRecord = { id: socketId, readyState: socket.readyState, openedAt: null, closedAt: null };
        state.localSockets.push(localRecord);
        socket.addEventListener('open', () => { localRecord.readyState = socket.readyState; localRecord.openedAt = performance.now(); });
        socket.addEventListener('close', () => { localRecord.readyState = socket.readyState; localRecord.closedAt = performance.now(); });
      }
      socket.addEventListener('error', () => { state.network.wsErrors += 1; });
      socket.addEventListener('close', (event) => state.network.wsCloses.push({ code: event.code, clean: event.wasClean }));
      return socket;
    },
  });

  const NativeSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    if (!state.sockets.includes(this)) state.sockets.push(this);
    try {
      const message = JSON.parse(String(data));
      state.sent.push({ ...message, direction: 'outgoing', peerId: message.payload?.toPeerId ?? '', wireBytes: new TextEncoder().encode(String(data)).length, socketId: this.__lanScreenHarnessSocketId ?? null, observedAt: performance.now() });
    } catch { /* app may send non-JSON */ }
    return NativeSend.call(this, data);
  };
  const messageHandler = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
  if (messageHandler?.get && messageHandler?.set) {
    Object.defineProperty(WebSocket.prototype, 'onmessage', {
      configurable: true,
      get() { return messageHandler.get.call(this); },
      set(handler) {
        return messageHandler.set.call(this, (event) => {
          try {
            const message = JSON.parse(String(event.data));
            state.incoming.push({ ...message, direction: 'incoming', peerId: message.payload?.fromPeerId ?? message.peerId ?? '', socketId: this.__lanScreenHarnessSocketId ?? null, observedAt: performance.now() });
          } catch { /* app may send non-JSON */ }
          handler?.call(this, event);
        });
      },
    });
  }

  const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  const originalGetDisplayMedia = navigator.mediaDevices.getDisplayMedia?.bind(navigator.mediaDevices);
  const originalGetSupportedConstraints = navigator.mediaDevices.getSupportedConstraints?.bind(navigator.mediaDevices);
  const originalTrackSettings = MediaStreamTrack.prototype.getSettings;

  function oscillatorTrack(label) {
    const audio = new AudioContext();
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    const destination = audio.createMediaStreamDestination();
    const tone = syntheticToneFrequency(label, state.participantAlias);
    if (!tone) throw new Error('synthetic participant alias has no microphone signature');
    oscillator.frequency.value = tone;
    gain.gain.value = 0.025;
    oscillator.connect(gain).connect(destination);
    oscillator.start();
    const track = destination.stream.getAudioTracks()[0];
    state.sources.push({ label, frequency: oscillator.frequency.value, audio, oscillator, gain, destination, track });
    return track;
  }

  function screenStream() {
    const canvas = document.createElement('canvas');
    canvas.width = captureWidth;
    canvas.height = captureHeight;
    const context = canvas.getContext('2d');
    let frame = 0;
    const draw = () => {
      frame += 1;
      context.fillStyle = `hsl(${(frame * 3) % 360} 70% 40%)`;
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = 'white';
      context.font = '48px sans-serif';
      context.fillText(`synthetic screen ${frame}`, 40, 80);
      if (frame < 100000) requestAnimationFrame(draw);
    };
    draw();
    const video = canvas.captureStream(captureFps).getVideoTracks()[0];
    const audio = oscillatorTrack('systemAudio');
    video.getSettings = () => ({ ...originalTrackSettings.call(video), displaySurface: 'monitor' });
    const audioNativeSettings = originalTrackSettings.call(audio);
    audio.getSettings = () => ({ ...audioNativeSettings, restrictOwnAudio: true });
    state.syntheticReportedIsolation = true;
    state.captures.push({ type: 'display', videoTrackId: video.id, audioTrackId: audio.id, tracks: [video, audio] });
    return new MediaStream([video, audio]);
  }

  Object.defineProperty(navigator.mediaDevices, 'getSupportedConstraints', {
    configurable: true,
    value: () => ({ ...originalGetSupportedConstraints?.(), restrictOwnAudio: true }),
  });
  Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
    configurable: true,
    value: async (constraints) => {
      state.captures.push({ type: 'display-request', constraints });
      return screenStream();
    },
  });
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
    configurable: true,
    value: async (constraints) => {
      state.captures.push({ type: 'microphone-request', constraints, denied: state.denyMicrophone });
      if (state.denyMicrophone) {
        const error = new DOMException('Synthetic microphone denial', 'NotAllowedError');
        throw error;
      }
      return new MediaStream([oscillatorTrack('microphone')]);
    },
  });

  // Keep references to the originals for easier harness diagnosis without
  // offering any production route or authentication shortcut.
  state.originalCaptureMethods = { getUserMedia: !!originalGetUserMedia, getDisplayMedia: !!originalGetDisplayMedia };
}

export function trackRolesFromProtocol(messages) {
  return messages
    .filter((message) => message.type === 'rtc.description')
    .flatMap((message) => message.payload?.tracks ?? [])
    .map(({ mid, role }) => ({ mid, role }));
}
