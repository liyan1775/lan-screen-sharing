import assert from 'node:assert/strict';
import test from 'node:test';
import { installSilentMediaOutput } from './silent-output.js';

function fakeStream(tracks) {
  return {
    getAudioTracks: () => tracks,
    getTracks: () => tracks,
    clone() { return fakeStream(tracks.map((track) => ({ ...track, stopped: false, stop() { this.stopped = true; this.readyState = 'ended'; } }))); },
  };
}

function fakeElement(tag) {
  const listeners = new Map();
  const capturedTrack = { readyState: 'live', enabled: true, muted: false, stopped: false, stop() { this.stopped = true; this.readyState = 'ended'; } };
  return {
    tagName: tag.toUpperCase(), paused: true, currentTime: 0, srcObject: null, muted: false, volume: 1, dataset: {},
    addEventListener(name, callback) { listeners.set(name, callback); },
    emit(name, event = {}) { listeners.get(name)?.(event); },
    playCalls: 0,
    nativePromise: null,
    playResult: null,
    play() { this.playCalls += 1; this.mutedAtPlay = this.muted; this.nativePromise = this.playResult ?? Promise.resolve('native-play-result'); this.paused = false; this.currentTime = 0.5; queueMicrotask(() => this.emit('playing')); return this.nativePromise; },
    pause() { this.paused = true; this.emit('pause'); },
    capturedTrack,
    captureStreamCalls: 0,
    captureStream() { this.captureStreamCalls += 1; return this.capturedStream ?? fakeStream([capturedTrack]); },
    remove() { this.removed = true; },
  };
}

function fakeAudioContext({ startThrows = false, oscillatorCreationThrows = false, bufferedAnalysis = false } = {}) {
  const connected = [];
  const createdGains = [];
  const elementSourceBindings = [];
  let disconnectCalls = 0;
  let clockOffset = 0, clockStartedAt = 0;
  const node = (name) => ({ name, connect(target) { connected.push([name, target.name, this.gain?.value ?? null]); return target; }, disconnect() { disconnectCalls += 1; } });
  return {
    state: 'suspended', sampleRate: 48000, destination: { name: 'destination' }, connected, createdGains, elementSourceBindings,
    get currentTime() { return clockOffset + (this.state === 'running' ? (performance.now() - clockStartedAt) / 1000 : 0); },
    get disconnectCalls() { return disconnectCalls; },
    createMediaElementSource(element) { elementSourceBindings.push(element.srcObject != null); return node(`source:${element.tagName}`); },
    createMediaStreamSource(stream) { this.mediaStreamSources ??= []; this.mediaStreamSources.push(stream); return node('stream-source'); },
    createAnalyser() {
      const createdAt = performance.now();
      const analyser = Object.assign(node('analyser'), { fftSize: 0, getFloatFrequencyData(array) {
        array.fill(-Infinity);
        if (!bufferedAnalysis || performance.now() - createdAt >= this.fftSize / 48000 * 1000) array[89] = -28;
      } });
      Object.defineProperty(analyser, 'frequencyBinCount', { get() { return this.fftSize / 2; } });
      return analyser;
    },
    createGain() { const gain = Object.assign(node('gain'), { gain: { value: 1 } }); createdGains.push(gain); return gain; },
    createOscillator() { if (oscillatorCreationThrows) throw new Error('oscillator creation failed'); const oscillator = Object.assign(node('oscillator'), { frequency: { value: 440 }, started: false, stopped: false, start() { if (startThrows) throw new Error('oscillator start failed'); this.started = true; }, stop() { this.stopped = true; } }); this.oscillator = oscillator; return oscillator; },
    createMediaStreamDestination() { const track = { stopped: false, stop() { this.stopped = true; } }; this.track = track; return { ...node('stream-destination'), stream: { getAudioTracks: () => [track] }, track }; },
    resume() { clockOffset = this.currentTime + 0.25; clockStartedAt = performance.now(); this.state = 'running'; return Promise.resolve(); },
    close() { clockOffset = this.currentTime; this.state = 'closed'; return Promise.resolve(); },
  };
}

function fakeDocument(staticElements) {
  return {
    created: [],
    createdHistory: [],
    outside: [],
    querySelectorAll() { return [...staticElements, ...this.created, ...this.outside]; },
    body: { append(element) { element.attached = true; } },
    createElement(tag) { const element = fakeElement(tag); this.created.push(element); this.createdHistory.push(element); const remove = element.remove.bind(element); element.remove = () => { remove(); this.created = this.created.filter((item) => item !== element); }; return element; },
  };
}

test('silent output routes existing and later production audio/video sinks through zero gain while preserving native play', async () => {
  const existingVideo = fakeElement('video');
  const documentRef = fakeDocument([existingVideo]);
  const contexts = [];
  const controller = installSilentMediaOutput({
    documentRef, AudioContextClass: class extends Object { constructor() { super(); const context = fakeAudioContext(); contexts.push(context); return context; } },
  });
  const audio = documentRef.createElement('audio');
  const laterVideo = documentRef.createElement('video');
  assert.equal(controller.sinkCount, 3);
  assert.equal(contexts.length, 1);
  for (const context of contexts) {
    assert.equal(context.connected.some(([from, to]) => from === 'analyser' && to === 'gain'), true);
    assert.equal(context.connected.some(([from, to]) => from === 'gain' && to === 'destination'), true);
    assert.equal(context.connected.some(([from, to]) => from.startsWith('source:') && to === 'destination'), false);
    assert.equal(controller.isSilenced(context), true);
  }
  assert.equal(await controller.prepareFromUserGesture(), true);
  const nativePromise = audio.play();
  assert.equal(nativePromise, audio.nativePromise, 'wrapper must preserve the native play promise');
  assert.equal(await nativePromise, 'native-play-result');
  audio.emit('playing');
  audio.currentTime = 1.25;
  const observed = controller.snapshot(audio);
  assert.equal(audio.playCalls, 1);
  assert.equal(observed.nativePlayResolved, true);
  assert.equal(observed.playing, true);
  assert.equal(observed.currentTime, 1.25);
  assert.equal(observed.outputGain, 0);
  assert.equal(existingVideo.playCalls, 0);
  assert.equal(laterVideo.playCalls, 0);
  assert.equal(controller.auditSinks(), true);
  documentRef.outside.push(fakeElement('audio'));
  assert.equal(controller.auditSinks(), false, 'an uninstrumented receive sink must fail closed');
});

test('native autoplay rejection remains observable and does not bypass zero-gain routing', async () => {
  const audio = fakeElement('audio');
  const rejection = Promise.reject(new DOMException('native autoplay blocked', 'NotAllowedError'));
  audio.playResult = rejection;
  const documentRef = fakeDocument([audio]);
  const controller = installSilentMediaOutput({ documentRef, AudioContextClass: class { constructor() { return fakeAudioContext(); } } });
  const returned = audio.play();
  assert.equal(returned, rejection);
  await assert.rejects(returned, { name: 'NotAllowedError' });
  await Promise.resolve();
  assert.equal(controller.snapshot(audio).nativePlayRejected, true);
  assert.equal(controller.snapshot(audio).outputGain, 0);
});

test('silent output preparation fails when the native AudioContext remains suspended', async () => {
  const context = fakeAudioContext();
  context.resume = () => Promise.resolve();
  const controller = installSilentMediaOutput({ documentRef: fakeDocument([]), AudioContextClass: class { constructor() { return context; } } });
  assert.equal(await controller.prepareFromUserGesture(), false);
});

test('native tone calibration traverses the zero-gain media-element analyser path without becoming a production sink', async () => {
  const documentRef = fakeDocument([]);
  const contexts = [];
  const controller = installSilentMediaOutput({
    documentRef, AudioContextClass: class { constructor() { const context = fakeAudioContext(); contexts.push(context); return context; } },
  });
  const before = controller.sinkCount;
  const result = await controller.calibrateNativeTone();

  assert.equal(result.expectedHz, 523);
  assert.equal(result.observedPeakHz, 521);
  assert.equal(result.peakDb, -28);
  assert.equal(result.signal, true);
  assert.equal(result.sourceContextState, 'running');
  assert.equal(result.sinkContextState, 'running');
  assert.equal(result.mediaMuted, false);
  assert.equal(result.mediaVolume, 1);
  assert.equal(result.nativePlayResolved, true);
  assert.equal(result.playing, true);
  assert.equal(result.outputGain, 0);
  assert.deepEqual(result.measurements, {
    oscillatorPath: { observedPeakHz: 521, peakDb: -28, signal: true, sampleRate: 48000, fftSize: 8192, contextState: 'running' },
    streamPath: { observedPeakHz: 521, peakDb: -28, signal: true, sampleRate: 48000, fftSize: 8192, contextState: 'running' },
    elementPath: { observedPeakHz: 521, peakDb: -28, signal: true, sampleRate: 48000, fftSize: 8192, contextState: 'running' },
    postAttachElementPath: { observedPeakHz: 521, peakDb: -28, signal: true, sampleRate: 48000, fftSize: 8192, contextState: 'running' },
    capturedElementPath: { observedPeakHz: 521, peakDb: -28, signal: true, sampleRate: 48000, fftSize: 8192, contextState: 'running' },
    unwrappedMutedElementCapturePath: { observedPeakHz: 521, peakDb: -28, signal: true, sampleRate: 48000, fftSize: 8192, contextState: 'running' },
  });
  assert.equal(result.captureStreamAvailable, true);
  assert.equal(result.captureStreamApiAvailable, true);
  assert.equal(result.capturedAudioTrackCount, 1);
  assert.equal(result.capturedLiveAudioTrackCount, 1);
  assert.ok(result.capturedSinkClockAdvance >= 0.25);
  assert.equal(contexts[0].mediaStreamSources.some((stream) => stream.getAudioTracks()[0] === documentRef.createdHistory[0].capturedTrack), true);
  const unwrappedElement = documentRef.createdHistory[2];
  assert.equal(unwrappedElement.muted, true);
  assert.equal(unwrappedElement.mutedAtPlay, true);
  assert.equal(unwrappedElement.volume, 1);
  assert.equal(unwrappedElement.playCalls, 1);
  assert.equal(unwrappedElement.captureStreamCalls, 1);
  assert.equal(result.unwrappedMutedElementPlayback.nativePlayResolved, true);
  assert.equal(result.unwrappedMutedElementPlayback.muted, true);
  assert.equal(result.unwrappedMutedElementPlayback.volume, 1);
  assert.equal(result.unwrappedMutedElementPlayback.outputGain, 0);
  assert.equal(result.unwrappedMutedElementPlayback.captureStreamApiAvailable, true);
  assert.equal(result.unwrappedMutedElementPlayback.captureStreamAvailable, true);
  assert.equal(result.unwrappedMutedElementPlayback.capturedAudioTrackCount, 1);
  assert.ok(result.unwrappedMutedElementPlayback.sinkClockAdvance >= 0.25);
  assert.deepEqual(result.postAttachPlayback, { nativePlayResolved: true, playing: true, currentTime: 0.5, timeAdvance: 0.5, outputGain: 0, mediaMuted: false, mediaVolume: 1 });
  assert.ok(result.sourceClockAdvance >= 0.25);
  assert.ok(result.sinkClockAdvance >= 0.25);
  assert.equal(result.mediaTimeAdvance, 0.5);
  assert.equal(contexts[1].connected.some(([from, to]) => from === 'oscillator' && to === 'gain'), true);
  assert.equal(contexts[1].connected.some(([from, to]) => from === 'gain' && to === 'analyser'), true);
  assert.equal(contexts[1].connected.some(([from, to]) => from === 'analyser' && to === 'stream-destination'), true);
  assert.equal(contexts[0].connected.some(([from, to]) => from === 'stream-source' && to === 'analyser'), true);
  assert.equal(contexts[0].connected.some(([from, to]) => from === 'analyser' && to === 'gain'), true);
  assert.equal(contexts[0].connected.some(([from, to]) => from === 'gain' && to === 'destination'), true);
  assert.equal(contexts[0].connected.some(([from, to]) => from === 'analyser' && to === 'gain'), true);
  assert.equal(contexts[0].connected.some(([from, to]) => from === 'gain' && to === 'destination'), true);
  assert.equal(contexts[0].connected.some(([from, to]) => from === 'source:AUDIO' && to === 'destination'), false);
  assert.deepEqual(contexts[0].createdGains.map((item) => item.gain.value), [0, 0, 0, 0, 0], 'each sink-context physical output branch has zero gain');
  assert.equal(contexts[0].connected.filter(([from, to]) => from === 'gain' && to === 'destination').every(([, , gain]) => gain === 0), true, 'every calibration audio route connects only after its gain is zero');
  assert.deepEqual(contexts[0].elementSourceBindings, [false, true], 'the comparison source is created both before and after srcObject assignment');
  assert.equal(contexts[0].elementSourceBindings.length, 2, 'the unwrapped element is never connected to MediaElementAudioSource');
  assert.equal(contexts[1].connected.some(([, to]) => to === 'destination'), false, 'source context has no physical output connection');
  assert.equal(controller.sinkCount, before);
  assert.equal(contexts[0].disconnectCalls, 15, 'all five temporary sink branches must be disconnected');
  assert.equal(contexts[1].disconnectCalls, 4, 'source-context nodes must be disconnected');
  assert.equal(contexts[1].oscillator.stopped, true);
  assert.equal(contexts[1].track.stopped, true);
  assert.equal(documentRef.createdHistory[0].capturedTrack.stopped, true);
  assert.equal(unwrappedElement.capturedTrack.stopped, true);
  assert.equal(contexts[1].state, 'closed');
  assert.equal(documentRef.created.length, 0);
  assert.equal(documentRef.createdHistory.length, 3);
  assert.equal(documentRef.createdHistory[0].hidden, true);
  assert.equal(documentRef.createdHistory[0].dataset.visibleCalibration, 'true');
  assert.equal('sourcePeerId' in documentRef.createdHistory[0].dataset, false);
  assert.equal('trackRole' in documentRef.createdHistory[0].dataset, false);
  assert.equal(controller.snapshot(documentRef.createdHistory[0]), null, 'calibration element record must be released');
  assert.equal(controller.auditSinks(), true);
});

test('capture probes wait for their own analyser buffers instead of sampling just-connected graphs', async () => {
  const controller = installSilentMediaOutput({
    documentRef: fakeDocument([]),
    AudioContextClass: class { constructor() { return fakeAudioContext({ bufferedAnalysis: true }); } },
  });
  const result = await controller.calibrateNativeTone();
  const fftSeconds = 8192 / 48000;
  assert.equal(result.measurements.capturedElementPath.signal, true, 'the captured element analyser must receive a full FFT window');
  assert.equal(result.measurements.unwrappedMutedElementCapturePath.signal, true, 'the later-created muted element analyser needs its own window');
  assert.ok(result.capturedSinkClockAdvance >= fftSeconds);
  assert.ok(result.unwrappedMutedElementPlayback.sinkClockAdvance >= fftSeconds);
});

test('production PCM samples the played element capture, waits for audio and preserves its original track', async () => {
  const documentRef = fakeDocument([]);
  const context = fakeAudioContext({ bufferedAnalysis: true });
  const controller = installSilentMediaOutput({ documentRef, AudioContextClass: class { constructor() { return context; } } });
  const audio = documentRef.createElement('audio');
  const originalTrack = { stopped: false, stop() { this.stopped = true; } };
  audio.srcObject = { getTracks: () => [originalTrack] };
  audio.capturedStream = fakeStream([audio.capturedTrack]);
  audio.capturedTrack.stop = () => { originalTrack.stop(); throw new Error('borrowed capture track must never be stopped'); };
  await controller.prepareFromUserGesture();
  await audio.play();
  const sample = await controller.sampleCapturedElement(audio);
  assert.equal(sample.bins[89], -28);
  assert.notEqual(context.mediaStreamSources.at(-1), audio.capturedStream, 'sample an owned clone of the element capture');
  assert.notEqual(context.mediaStreamSources.at(-1), audio.srcObject, 'never substitute the raw srcObject');
  assert.equal(context.mediaStreamSources.at(-1).getTracks()[0].stopped, true);
  assert.equal(audio.capturedTrack.stopped, false);
  assert.equal(originalTrack.stopped, false);
  assert.equal(audio.playCalls, 1, 'sampling must preserve native production playback');
  assert.equal(audio.paused, false);
  assert.equal(context.state, 'running');
  assert.equal(context.disconnectCalls, 3, 'only the temporary measurement nodes are disconnected');
  assert.equal(controller.sinkCount, 1);
  assert.equal(controller.auditSinks(), true);
  assert.equal(context.connected.filter(([, to]) => to === 'destination').every(([, , gain]) => gain === 0), true);
});

test('unavailable element capture fails without substituting the raw stream', async () => {
  const context = fakeAudioContext();
  const documentRef = fakeDocument([]);
  const controller = installSilentMediaOutput({ documentRef, AudioContextClass: class { constructor() { return context; } } });
  const audio = documentRef.createElement('audio');
  delete audio.captureStream;
  await controller.prepareFromUserGesture();
  await audio.play();
  await assert.rejects(controller.sampleCapturedElement(audio), /capture is unavailable/);
  assert.equal(context.mediaStreamSources, undefined);
  assert.equal(audio.paused, false);
});

test('failed capture graph construction releases owned clones without ending borrowed production audio', async () => {
  const documentRef = fakeDocument([]);
  const context = fakeAudioContext();
  const controller = installSilentMediaOutput({ documentRef, AudioContextClass: class { constructor() { return context; } } });
  const audio = documentRef.createElement('audio');
  const originalTrack = { stopped: false, stop() { this.stopped = true; } };
  audio.srcObject = { getTracks: () => [originalTrack] };
  await controller.prepareFromUserGesture();
  await audio.play();
  context.createAnalyser = () => { throw new Error('analyser creation failed'); };
  await assert.rejects(controller.sampleCapturedElement(audio), /analyser creation failed/);
  assert.equal(audio.capturedTrack.stopped, false);
  assert.equal(context.mediaStreamSources.at(-1).getTracks()[0].stopped, true);
  assert.equal(originalTrack.stopped, false);
  assert.equal(audio.paused, false);
  assert.equal(context.state, 'running');
  assert.equal(context.disconnectCalls, 1);
  assert.equal(controller.auditSinks(), true);
});

test('native tone calibration reports captureStream unavailable without treating it as a signal', async () => {
  const documentRef = fakeDocument([]);
  const nativeCreate = documentRef.createElement.bind(documentRef);
  documentRef.createElement = (tag) => {
    const element = nativeCreate(tag);
    delete element.captureStream;
    return element;
  };
  const controller = installSilentMediaOutput({ documentRef, AudioContextClass: class { constructor() { return fakeAudioContext(); } } });
  const result = await controller.calibrateNativeTone();
  assert.deepEqual(result.measurements.capturedElementPath, { available: false, failure: 'capture_stream_unsupported' });
  assert.equal(result.captureStreamAvailable, false);
  assert.equal(result.captureStreamApiAvailable, false);
  assert.equal(result.capturedAudioTrackCount, 0);
  assert.equal(result.capturedLiveAudioTrackCount, 0);
});

test('native tone calibration skips element capture when native playback rejects', async () => {
  const documentRef = fakeDocument([]);
  const rejection = Promise.reject(new DOMException('native playback rejected', 'NotAllowedError'));
  const nativeCreate = documentRef.createElement.bind(documentRef);
  documentRef.createElement = (tag) => {
    const element = nativeCreate(tag);
    if (tag === 'audio') element.playResult = rejection;
    return element;
  };
  const controller = installSilentMediaOutput({ documentRef, AudioContextClass: class { constructor() { return fakeAudioContext(); } } });
  const result = await controller.calibrateNativeTone();
  const element = documentRef.createdHistory[0];
  assert.equal(element.captureStreamCalls, 0);
  assert.deepEqual(result.measurements.capturedElementPath, { available: false, failure: 'native_play_not_resolved' });
  assert.equal(result.nativePlayResolved, false);
});

for (const failure of ['start', 'play']) {
  test(`native tone calibration releases every resource when ${failure} throws synchronously`, async () => {
    const documentRef = fakeDocument([]);
    const contexts = [];
    const controller = installSilentMediaOutput({
      documentRef, AudioContextClass: class { constructor() { const context = fakeAudioContext({ startThrows: failure === 'start' }); contexts.push(context); return context; } },
    });
    if (failure === 'play') {
      const nativeCreate = documentRef.createElement.bind(documentRef);
      documentRef.createElement = (tag) => {
        const element = nativeCreate(tag);
        element.play = () => { throw new Error('element play failed'); };
        return element;
      };
    }
    const before = controller.sinkCount;
    await assert.rejects(controller.calibrateNativeTone(), new RegExp(failure === 'start' ? 'oscillator start failed' : 'element play failed'));
    assert.equal(controller.sinkCount, before);
    assert.equal(contexts[0].disconnectCalls, 11);
    assert.equal(contexts[1].disconnectCalls, 4);
    assert.equal(contexts[1].oscillator.stopped, true);
    assert.equal(contexts[1].track.stopped, true);
    assert.equal(contexts[1].state, 'closed');
    assert.equal(contexts[0].state, 'running', 'shared sink context must stay open');
    assert.equal(documentRef.created.length, 0);
    assert.equal(controller.snapshot(documentRef.createdHistory[0]), null);
  });
}

test('native tone calibration tolerates failure before all resources are created', async () => {
  const documentRef = fakeDocument([]);
  const contexts = [];
  const controller = installSilentMediaOutput({
    documentRef, AudioContextClass: class { constructor() { const context = fakeAudioContext({ oscillatorCreationThrows: true }); contexts.push(context); return context; } },
  });
  await assert.rejects(controller.calibrateNativeTone(), /oscillator creation failed/);
  assert.equal(contexts[1].state, 'closed');
  assert.equal(contexts[0].state, 'suspended');
  assert.equal(controller.sinkCount, 0);
  assert.equal(documentRef.created.length, 0);
});
