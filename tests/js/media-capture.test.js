import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshMedia } from '../../internal/web/assets/media.js';

function installCapture(stream, supported = { restrictOwnAudio: true }) {
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const calls = [];
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: {
      getSupportedConstraints: () => supported,
      getDisplayMedia: (options) => { calls.push(options); return Promise.resolve(stream); },
    } },
  });
  return {
    calls,
    restore() {
      if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
      else delete globalThis.navigator;
    },
  };
}

function makeTrack(kind, settings) {
  return {
    kind,
    stopped: false,
    listeners: new Map(),
    getSettings: () => settings,
    addEventListener(name, listener) { this.listeners.set(name, listener); },
    stop() { this.stopped = true; },
  };
}

function makeStream(video, audio = []) {
  const tracks = [video, ...audio];
  return {
    getVideoTracks: () => [video],
    getAudioTracks: () => audio,
    getTracks: () => tracks,
  };
}

function createMedia() {
  const messages = [];
  const media = new MeshMedia({
    sendSignal() {},
    sendUnacknowledged(type, payload) { messages.push({ type, payload }); return true; },
  });
  media.setIdentity('host-test', 'host');
  return { media, messages };
}

test('missingSystemAudioWaitsForExplicitLimitedModeOptIn', async (t) => {
  const video = makeTrack('video', { displaySurface: 'monitor', width: 1920, height: 1080 });
  const stream = makeStream(video);
  const browser = installCapture(stream);
  t.after(browser.restore);
  const { media, messages } = createMedia();

  const result = await media.startScreenFromGesture('combined');

  assert.deepEqual(browser.calls[0], { video: { displaySurface: 'monitor', width: { ideal: 1920, max: 1920 }, height: { ideal: 1080, max: 1080 }, frameRate: { ideal: 60, max: 60 }, cursor: 'never' }, audio: { restrictOwnAudio: true }, systemAudio: 'include' });
  assert.equal(result.captureState, 'missing_audio');
  assert.equal(result.isolation.state, 'missing_audio');
  assert.equal(result.isolation.label, '未捕获屏幕音频');
  assert.equal(media.pendingScreenStream, stream);
  assert.equal(media.screenStream, null);
  assert.equal(video.stopped, false);
  assert.equal(messages.some((message) => message.type === 'media.state' && message.payload.screenSharing), false);

  const accepted = await media.acceptPendingScreenAsLimited();
  assert.equal(accepted.stream, stream);
  assert.equal(accepted.mode, 'limited');
  assert.equal(media.screenVideoTrack, video);
  assert.equal(media.systemAudioTrack, null);
  assert.equal(media.captureMode, 'limited');
  assert.equal(messages.at(-1).payload.screenSharing, true);
  assert.equal(messages.at(-1).payload.hasSystemAudio, false);
});

test('decliningLimitedModeStopsEveryPendingCaptureTrack', async (t) => {
  const video = makeTrack('video', { displaySurface: 'monitor' });
  const stream = makeStream(video);
  const browser = installCapture(stream);
  t.after(browser.restore);
  const { media, messages } = createMedia();

  await media.startScreenFromGesture('combined');
  await media.discardPendingScreen();

  assert.equal(video.stopped, true);
  assert.equal(media.pendingScreenStream, null);
  assert.equal(media.screenStream, null);
  assert.equal(messages.some((message) => message.type === 'media.state' && message.payload.screenSharing), false);
});

test('unconfirmed isolation remains advisory and captured system sound is shared directly', async (t) => {
  const video = makeTrack('video', { displaySurface: 'monitor' });
  const audio = makeTrack('audio', { restrictOwnAudio: false });
  const stream = makeStream(video, [audio]);
  const browser = installCapture(stream);
  t.after(browser.restore);
  const { media, messages } = createMedia();

  const result = await media.startScreenFromGesture('combined');

  assert.equal(result.captureState, 'ready');
  assert.equal(result.isolation.verified, false);
  assert.equal(video.stopped, false);
  assert.equal(audio.stopped, false);
  assert.equal(media.pendingScreenStream, null);
  assert.equal(media.screenStream, stream);
  assert.equal(media.screenVideoTrack, video);
  assert.equal(media.systemAudioTrack, audio);
  assert.equal(messages.at(-1).payload.hasSystemAudio, true);
});

test('browsers without the restriction API can still capture and send authorized system sound', async (t) => {
  const video = makeTrack('video', { displaySurface: 'monitor' });
  const audio = makeTrack('audio', {});
  const browser = installCapture(makeStream(video, [audio]), {}); t.after(browser.restore);
  const { media, messages } = createMedia();
  const result = await media.startScreenFromGesture('combined');
  assert.equal(result.captureState, 'ready');
  assert.equal(browser.calls[0].audio, true);
  assert.equal(browser.calls[0].systemAudio, 'include');
  assert.equal(media.systemAudioTrack, audio); assert.equal(audio.stopped, false);
  assert.equal(result.isolation.state, 'unsupported'); assert.equal(result.isolation.verified, false);
  assert.equal(messages.at(-1).payload.hasSystemAudio, true);
});

test('an ended system-audio track is reported as missing rather than a successful sound share', async (t) => {
  const video = makeTrack('video', {displaySurface:'monitor'}), audio = makeTrack('audio', {});
  audio.readyState = 'ended';
  const browser = installCapture(makeStream(video, [audio]), {}); t.after(browser.restore);
  const {media,messages} = createMedia();
  const result = await media.startScreenFromGesture('combined');
  assert.equal(result.captureState,'missing_audio'); assert.equal(media.screenStream,null);
  assert.ok(!messages.some(message=>message.payload.hasSystemAudio));
});

test('an explicit stop releases system audio even when one WebRTC sender refuses detachment', async () => {
  const {media,messages} = createMedia();
  const audio = makeTrack('audio', {}), video = makeTrack('video', {}), mic = makeTrack('audio', {});
  media.systemAudioTrack=audio;media.screenVideoTrack=video;media.microphoneTrack=mic;media.captureMode='combined';media.ownsPresentation=true;
  media.peers.set('peer',{systemAudioSender:{async replaceTrack(){throw new Error('sender already closed');}}});
  await assert.rejects(media.setSystemAudioTrack(null),/sender already closed/);
  assert.equal(audio.stopped,true);assert.equal(media.systemAudioTrack,null);assert.equal(media.captureMode,'limited');
  assert.equal(video.stopped,false);assert.equal(mic.stopped,false);
  assert.equal(messages.at(-1).payload.hasSystemAudio,false);
});

test('omitted restriction settings do not delay or drop system audio with an exact-constraint retry', async (t) => {
  const video = makeTrack('video', { displaySurface: 'monitor' }); const audio = makeTrack('audio', {});
  audio.applyConstraints = async () => assert.fail('sharing must not wait on a mandatory audio-isolation constraint');
  const browser = installCapture(makeStream(video, [audio])); t.after(browser.restore);
  const { media, messages } = createMedia();
  const result = await media.startScreenFromGesture('combined');
  assert.equal(result.captureState, 'ready'); assert.equal(media.systemAudioTrack, audio);
  assert.equal(messages.at(-1).payload.hasSystemAudio, true); assert.equal(audio.stopped, false);
});

test('captured audio with browser-reported isolation is still not marked human-verified', async (t) => {
  const video=makeTrack('video',{displaySurface:'monitor'}), settings={restrictOwnAudio:true}, audio=makeTrack('audio',settings);
  audio.getCapabilities=()=>({restrictOwnAudio:[false,true]});
  const browser=installCapture(makeStream(video,[audio]));t.after(browser.restore);
  const {media,messages}=createMedia();
  const result=await media.startScreenFromGesture('combined');
  assert.equal(result.captureState,'ready');assert.equal(result.isolation.verified,false);assert.equal(media.systemAudioTrack,audio);
  assert.equal(messages.at(-1).payload.hasSystemAudio,true);assert.equal(media.systemAudioDiagnostics.final,true);
});

test('lateDisplayCaptureIsStoppedWhenLocalRoomCloses', async (t) => {
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let resolveCapture;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: {
      getSupportedConstraints: () => ({}),
      getDisplayMedia: () => new Promise((resolve) => { resolveCapture = resolve; }),
    } },
  });
  t.after(() => {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else delete globalThis.navigator;
  });
  const { media } = createMedia();
  const lateVideo = makeTrack('video', { displaySurface: 'monitor' });
  const lateStream = makeStream(lateVideo);
  const capture = media.startScreenFromGesture('limited');
  await media.closeAll();
  resolveCapture(lateStream);

  await assert.rejects(capture, { code: 'CAPTURE_CANCELLED' });
  assert.equal(lateVideo.stopped, true);
  assert.equal(media.screenStream, null);
  assert.equal(media.pendingScreenStream, null);
});

test('lateMicrophoneCaptureIsStoppedWhenLocalRoomCloses', async () => {
  const { media } = createMedia();
  const microphone = makeTrack('audio', {});
  let resolveCapture;
  const capture = media.setMicrophoneFromCapture(new Promise((resolve) => { resolveCapture = resolve; }));
  await media.closeAll();
  resolveCapture({ getTracks: () => [microphone], getAudioTracks: () => [microphone] });

  await assert.rejects(capture, { code: 'CAPTURE_CANCELLED' });
  assert.equal(microphone.stopped, true);
  assert.equal(media.microphoneTrack, null);
});

test('stoppingScreenKeepsTheVoiceTrackAndPeerConnectionAlive', async () => {
  const { media } = createMedia();
  media.setIdentity('host-1', 'host');
  const screen = makeTrack('video', {});
  const systemAudio = makeTrack('audio', {});
  const microphone = makeTrack('audio', {});
  const replaced = [];
  let closeCount = 0;
  media.screenStream = makeStream(screen, [systemAudio]);
  media.screenVideoTrack = screen;
  media.systemAudioTrack = systemAudio;
  media.microphoneTrack = microphone;
  media.captureMode = 'combined';
  media.peers.set('viewer-1', {
    role: 'viewer',
    pc: { close() { closeCount += 1; } },
    screenSender: { replaceTrack: async (track) => replaced.push(['screen', track]) },
    systemAudioSender: { replaceTrack: async (track) => replaced.push(['systemAudio', track]) },
    voiceSender: { replaceTrack: async () => assert.fail('stopping screen must not replace the voice sender') },
  });

  await media.setScreenStream(null);

  assert.deepEqual(replaced, [['screen', null], ['systemAudio', null]]);
  assert.equal(screen.stopped, true);
  assert.equal(systemAudio.stopped, true);
  assert.equal(media.microphoneTrack, microphone);
  assert.equal(microphone.stopped, false);
  assert.equal(closeCount, 0);
  assert.equal(media.peers.size, 1);
});
