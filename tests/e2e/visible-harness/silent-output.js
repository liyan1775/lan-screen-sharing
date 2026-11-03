const sinks = new WeakMap();

function sampleAnalyser(analyser, context) {
  const bins = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(bins);
  return { sampleRate: context.sampleRate, fftSize: analyser.fftSize, contextState: context.state, bins };
}

function peakMeasurement(spectrum) {
  let peakDb = -Infinity, peakBin = 0;
  for (let i = 1; i < spectrum.bins.length; i += 1) {
    if (spectrum.bins[i] > peakDb) { peakDb = spectrum.bins[i]; peakBin = i; }
  }
  return {
    observedPeakHz: Number.isFinite(peakDb) ? Math.round(peakBin * spectrum.sampleRate / spectrum.fftSize) : null,
    peakDb: Number.isFinite(peakDb) ? peakDb : null,
    signal: Number.isFinite(peakDb) && peakDb > -100,
    sampleRate: spectrum.sampleRate, fftSize: spectrum.fftSize, contextState: spectrum.contextState,
  };
}

async function fillAnalyserWindow(analyser, context) {
  // A newly connected analyser has no samples yet, even when the context and
  // media element have already been playing. Wait for this graph's FFT window.
  const milliseconds = Math.max(300, Math.ceil(analyser.fftSize / context.sampleRate * 1000) + 50);
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function installSilentMediaOutput({ documentRef = window.document, AudioContextClass = window.AudioContext } = {}) {
  const context = new AudioContextClass();
  const records = new Set();
  const prepare = (element) => {
    if (!(element instanceof Object) || sinks.has(element)) return;
    const source = context.createMediaElementSource(element);
    const analyser = context.createAnalyser();
    analyser.fftSize = 8192;
    const gain = context.createGain();
    gain.gain.value = 0;
    source.connect(analyser);
    analyser.connect(gain);
    gain.connect(context.destination);
    const record = { context, source, analyser, gain, playCalls: 0, successfulPlayCalls: 0, rejectedPlayCalls: 0, lastPlayState: 'not-called', playing: false };
    records.add(record);
    sinks.set(element, record);
    for (const [event, value] of [['playing', true], ['pause', false], ['ended', false]]) {
      element.addEventListener(event, () => { record.playing = value; });
    }
    const nativePlay = element.play.bind(element);
    element.play = (...args) => {
      record.playCalls += 1;
      const attempt = record.playCalls;
      let promise;
      try { promise = nativePlay(...args); }
      catch (error) { record.rejectedPlayCalls += 1; if (attempt === record.playCalls) record.lastPlayState = 'rejected'; throw error; }
      Promise.resolve(promise).then(() => { record.successfulPlayCalls += 1; if (attempt === record.playCalls) record.lastPlayState = 'resolved'; }, () => { record.rejectedPlayCalls += 1; if (attempt === record.playCalls) record.lastPlayState = 'rejected'; });
      return promise;
    };
  };
  for (const element of documentRef.querySelectorAll('audio,video')) prepare(element);
  const nativeCreate = documentRef.createElement.bind(documentRef);
  documentRef.createElement = (tag, options) => {
    const element = nativeCreate(tag, options);
    if (/^(audio|video)$/i.test(tag)) prepare(element);
    return element;
  };
  return {
    get sinkCount() { return records.size; },
    async prepareFromUserGesture() { await context.resume(); return context.state === 'running'; },
    isSilenced(targetContext = context) { return targetContext === context && [...records].every((item) => item.gain.gain.value === 0); },
    auditSinks() { return [...documentRef.querySelectorAll('audio,video')].every((element) => sinks.has(element) && sinks.get(element).gain.gain.value === 0); },
    snapshot(element) {
      const item = sinks.get(element);
      if (!item) return null;
      return { nativePlayCalls: item.playCalls, successfulPlayCalls: item.successfulPlayCalls, rejectedPlayCalls: item.rejectedPlayCalls, lastPlayState: item.lastPlayState, nativePlayResolved: item.successfulPlayCalls > 0, nativePlayRejected: item.rejectedPlayCalls > 0, playing: item.playing, currentTime: element.currentTime, paused: element.paused, outputGain: item.gain.gain.value, contextState: item.context.state, mediaMuted: element.muted === true, mediaVolume: element.volume };
    },
    sample(element) {
      const item = sinks.get(element);
      if (!item) return null;
      return sampleAnalyser(item.analyser, item.context);
    },
    async sampleCapturedElement(element) {
      const record = sinks.get(element);
      if (!record || record.gain.gain.value !== 0 || context.state !== 'running') throw new Error('production audio sink is not routed through the zero-gain native graph');
      if (record.lastPlayState !== 'resolved' || !record.playing || element.paused || !(element.currentTime > 0)) throw new Error('latest native production audio play did not resolve and advance');
      if (typeof element.captureStream !== 'function') throw new Error('production audio element capture is unavailable');
      let measurementStream, source, analyser, gain;
      try {
        // Capture the actual authenticated production element, rather than
        // reading its incoming stream directly or relying on the unsupported
        // MediaElementAudioSource path for MediaStream resources in Chromium.
        const captured = element.captureStream();
        const audioTracks = captured.getAudioTracks();
        if (audioTracks.length !== 1 || audioTracks[0].readyState !== 'live') throw new Error('production audio element capture has no unique live audio track');
        // A MediaStream-backed element can return wrappers sharing the original
        // receiver track. Only stop tracks explicitly cloned for this sample.
        // Object identity alone cannot establish ownership of captured tracks.
        if (typeof captured.clone !== 'function') throw new Error('production audio element capture cloning is unavailable');
        measurementStream = captured.clone();
        source = context.createMediaStreamSource(measurementStream);
        analyser = context.createAnalyser();
        analyser.fftSize = 8192;
        gain = context.createGain();
        gain.gain.value = 0;
        source.connect(analyser).connect(gain).connect(context.destination);
        await fillAnalyserWindow(analyser, context);
        return sampleAnalyser(analyser, context);
      } finally {
        try { source?.disconnect(); } catch { /* release all temporary nodes */ }
        try { analyser?.disconnect(); } catch { /* release all temporary nodes */ }
        try { gain?.disconnect(); } catch { /* release captured tracks as well */ }
        const tracks = measurementStream?.getTracks?.() ?? [];
        for (const track of tracks) {
          try { track.stop(); } catch { /* only explicitly owned clones */ }
        }
      }
    },
    async calibrateNativeTone(frequency = 523) {
      let sourceContext, oscillator, sourceGain, oscillatorAnalyser, destination, track;
      let streamSource, streamAnalyser, streamGain, element;
      let postAttachElement, postAttachSource, postAttachAnalyser, postAttachGain, postAttachPlaying = false;
      let capturedStreamSource, capturedAnalyser, capturedGain, captureStreamApiAvailable = false, captureStreamAvailable = false;
      let capturedTracks = [], capturedAudioTrackCount = 0, capturedLiveAudioTrackCount = 0;
      let capturedElementPath = { available: false, failure: 'capture_stream_unsupported' };
      let capturedSinkClockStart = null, capturedSinkClockAdvance = null;
      let unwrappedElement, unwrappedStreamSource, unwrappedAnalyser, unwrappedGain;
      let unwrappedCaptureTracks = [], unwrappedPlaying = false, unwrappedPlayStart = null;
      let unwrappedCaptureApiAvailable = false, unwrappedCaptureAvailable = false;
      let unwrappedCaptureTrackCount = 0, unwrappedLiveCaptureTrackCount = 0;
      let unwrappedMutedElementCapturePath = { available: false, failure: 'capture_stream_unsupported' };
      let unwrappedMutedElementPlayback = null, unwrappedSinkClockStart = null, unwrappedSinkClockAdvance = null;
      try {
        sourceContext = new AudioContextClass();
        oscillator = sourceContext.createOscillator();
        sourceGain = sourceContext.createGain();
        oscillatorAnalyser = sourceContext.createAnalyser();
        oscillatorAnalyser.fftSize = 8192;
        destination = sourceContext.createMediaStreamDestination();
        track = destination.stream.getAudioTracks()[0];
        streamSource = context.createMediaStreamSource(destination.stream);
        streamAnalyser = context.createAnalyser();
        streamAnalyser.fftSize = 8192;
        streamGain = context.createGain();
        streamGain.gain.value = 0;
        element = documentRef.createElement('audio');
        const record = sinks.get(element);
        if (!record || record.gain.gain.value !== 0) throw new Error('Calibration sink must be connected at zero gain before playback');
        const sourceClockStart = sourceContext.currentTime;
        const sinkClockStart = context.currentTime;
        capturedGain = context.createGain();
        capturedGain.gain.value = 0;
        const sourceResume = sourceContext.resume();
        const sinkResume = context.resume();
        oscillator.frequency.value = frequency;
        sourceGain.gain.value = 0.025;
        oscillator.connect(sourceGain).connect(oscillatorAnalyser).connect(destination);
        streamSource.connect(streamAnalyser).connect(streamGain).connect(context.destination);
        element.muted = false;
        element.volume = 1;
        element.hidden = true;
        element.srcObject = destination.stream;
        element.dataset.visibleCalibration = 'true';
        documentRef.body?.append(element);
        postAttachElement = nativeCreate('audio');
        postAttachElement.muted = false;
        postAttachElement.volume = 1;
        postAttachElement.hidden = true;
        postAttachElement.srcObject = destination.stream;
        postAttachElement.dataset.visibleCalibration = 'true';
        postAttachSource = context.createMediaElementSource(postAttachElement);
        postAttachAnalyser = context.createAnalyser();
        postAttachAnalyser.fftSize = 8192;
        postAttachGain = context.createGain();
        postAttachGain.gain.value = 0;
        postAttachSource.connect(postAttachAnalyser).connect(postAttachGain).connect(context.destination);
        postAttachElement.addEventListener('playing', () => { postAttachPlaying = true; });
        postAttachElement.addEventListener('pause', () => { postAttachPlaying = false; });
        documentRef.body?.append(postAttachElement);
        unwrappedElement = nativeCreate('audio');
        unwrappedElement.muted = true;
        unwrappedElement.volume = 1;
        unwrappedElement.hidden = true;
        unwrappedElement.srcObject = destination.stream;
        unwrappedElement.dataset.visibleCalibration = 'true';
        unwrappedGain = context.createGain();
        unwrappedGain.gain.value = 0;
        unwrappedElement.addEventListener('playing', () => { unwrappedPlaying = true; });
        unwrappedElement.addEventListener('pause', () => { unwrappedPlaying = false; });
        documentRef.body?.append(unwrappedElement);
        const mediaTimeStart = element.currentTime;
        const postAttachPlayStart = postAttachElement.currentTime;
        unwrappedPlayStart = unwrappedElement.currentTime;
        oscillator.start();
        const playPromise = element.play();
        const postAttachPlayPromise = postAttachElement.play();
        const unwrappedPlayPromise = unwrappedElement.play();
        const settled = await Promise.allSettled([sourceResume, sinkResume, playPromise, postAttachPlayPromise, unwrappedPlayPromise]);
        await new Promise((resolve) => setTimeout(resolve, 300));
        captureStreamApiAvailable = typeof element.captureStream === 'function';
        if (settled[2].status !== 'fulfilled') {
          capturedElementPath = { available: false, failure: 'native_play_not_resolved' };
        } else if (captureStreamApiAvailable) {
          try {
            const capturedStream = element.captureStream();
            capturedTracks = capturedStream?.getAudioTracks?.() ?? [];
            capturedAudioTrackCount = capturedTracks.length;
            capturedLiveAudioTrackCount = capturedTracks.filter((item) => item?.readyState === 'live').length;
            if (capturedAudioTrackCount > 0) {
              captureStreamAvailable = true;
              capturedStreamSource = context.createMediaStreamSource(capturedStream);
              capturedAnalyser = context.createAnalyser();
              capturedAnalyser.fftSize = 8192;
              capturedSinkClockStart = context.currentTime;
              capturedStreamSource.connect(capturedAnalyser).connect(capturedGain).connect(context.destination);
              await fillAnalyserWindow(capturedAnalyser, context);
              capturedElementPath = peakMeasurement(sampleAnalyser(capturedAnalyser, context));
              capturedSinkClockAdvance = context.currentTime - capturedSinkClockStart;
            } else {
              capturedElementPath = { available: false, failure: 'capture_stream_has_no_audio_track' };
            }
          } catch {
            captureStreamAvailable = false;
            capturedElementPath = { available: false, failure: 'capture_stream_failed' };
          }
        }
        const playback = this.snapshot(element);
        const oscillatorPath = peakMeasurement(sampleAnalyser(oscillatorAnalyser, sourceContext));
        const streamPath = peakMeasurement(sampleAnalyser(streamAnalyser, context));
        const elementPath = peakMeasurement(this.sample(element));
        const postAttachElementPath = peakMeasurement(sampleAnalyser(postAttachAnalyser, context));
        unwrappedCaptureApiAvailable = typeof unwrappedElement.captureStream === 'function';
        if (settled[4].status !== 'fulfilled') {
          unwrappedMutedElementCapturePath = { available: false, failure: 'native_play_not_resolved' };
        } else if (unwrappedCaptureApiAvailable) {
          try {
            const unwrappedCapturedStream = unwrappedElement.captureStream();
            unwrappedCaptureTracks = unwrappedCapturedStream?.getAudioTracks?.() ?? [];
            unwrappedCaptureTrackCount = unwrappedCaptureTracks.length;
            unwrappedLiveCaptureTrackCount = unwrappedCaptureTracks.filter((item) => item?.readyState === 'live').length;
            if (unwrappedCaptureTrackCount > 0) {
              unwrappedCaptureAvailable = true;
              unwrappedStreamSource = context.createMediaStreamSource(unwrappedCapturedStream);
              unwrappedAnalyser = context.createAnalyser();
              unwrappedAnalyser.fftSize = 8192;
              unwrappedSinkClockStart = context.currentTime;
              unwrappedStreamSource.connect(unwrappedAnalyser).connect(unwrappedGain).connect(context.destination);
              await fillAnalyserWindow(unwrappedAnalyser, context);
              unwrappedMutedElementCapturePath = peakMeasurement(sampleAnalyser(unwrappedAnalyser, context));
              unwrappedSinkClockAdvance = context.currentTime - unwrappedSinkClockStart;
            } else {
              unwrappedMutedElementCapturePath = { available: false, failure: 'capture_stream_has_no_audio_track' };
            }
          } catch {
            unwrappedCaptureAvailable = false;
            unwrappedMutedElementCapturePath = { available: false, failure: 'capture_stream_failed' };
          }
        }
        unwrappedMutedElementPlayback = {
          nativePlayResolved: settled[4].status === 'fulfilled', playing: unwrappedPlaying,
          currentTime: unwrappedElement.currentTime, timeAdvance: unwrappedElement.currentTime - unwrappedPlayStart,
          muted: unwrappedElement.muted === true, volume: unwrappedElement.volume,
          outputGain: unwrappedGain.gain.value,
          captureStreamApiAvailable: unwrappedCaptureApiAvailable,
          captureStreamAvailable: unwrappedCaptureAvailable,
          capturedAudioTrackCount: unwrappedCaptureTrackCount,
          capturedLiveAudioTrackCount: unwrappedLiveCaptureTrackCount,
          sinkClockAdvance: unwrappedSinkClockAdvance,
        };
        const sourceClockAdvance = sourceContext.currentTime - sourceClockStart;
        const sinkClockAdvance = context.currentTime - sinkClockStart;
        const mediaTimeAdvance = playback.currentTime - mediaTimeStart;
        const postAttachPlayback = {
          nativePlayResolved: settled[3].status === 'fulfilled', playing: postAttachPlaying,
          currentTime: postAttachElement.currentTime, timeAdvance: postAttachElement.currentTime - postAttachPlayStart,
          outputGain: postAttachGain.gain.value,
          mediaMuted: postAttachElement.muted === true, mediaVolume: postAttachElement.volume,
        };
        return {
          available: true, expectedHz: frequency,
          observedPeakHz: elementPath.observedPeakHz, peakDb: elementPath.peakDb, signal: elementPath.signal,
          sampleRate: elementPath.sampleRate, fftSize: elementPath.fftSize,
          measurements: { oscillatorPath, streamPath, elementPath, postAttachElementPath, capturedElementPath, unwrappedMutedElementCapturePath },
          captureStreamApiAvailable, captureStreamAvailable, capturedAudioTrackCount, capturedLiveAudioTrackCount, capturedSinkClockAdvance,
          postAttachPlayback,
          unwrappedMutedElementPlayback,
          sourceClockAdvance, sinkClockAdvance, mediaTimeAdvance,
          sourceContextState: sourceContext.state, sinkContextState: context.state,
          mediaMuted: element.muted === true, mediaVolume: element.volume,
          nativePlayResolved: playback.nativePlayResolved, playing: playback.playing,
          currentTime: playback.currentTime, outputGain: playback.outputGain,
        };
      } finally {
        try { oscillator?.stop?.(); } catch { /* the calibration source may not have started */ }
        for (const capturedTrack of new Set(capturedTracks)) {
          if (capturedTrack !== track) { try { capturedTrack?.stop?.(); } catch { /* continue releasing capture tracks */ } }
        }
        for (const capturedTrack of new Set(unwrappedCaptureTracks)) {
          if (capturedTrack !== track) { try { capturedTrack?.stop?.(); } catch { /* continue releasing comparison capture tracks */ } }
        }
        try { track?.stop?.(); } catch { /* continue releasing the remaining resources */ }
        try { oscillator?.disconnect?.(); } catch { /* continue disconnecting the calibration source */ }
        try { sourceGain?.disconnect?.(); } catch { /* continue disconnecting the calibration source */ }
        try { oscillatorAnalyser?.disconnect?.(); } catch { /* continue disconnecting the calibration source */ }
        try { destination?.disconnect?.(); } catch { /* continue releasing the calibration source */ }
        try { streamSource?.disconnect?.(); } catch { /* continue disconnecting the stream probe */ }
        try { streamAnalyser?.disconnect?.(); } catch { /* continue disconnecting the stream probe */ }
        try { streamGain?.disconnect?.(); } catch { /* continue disconnecting the stream probe */ }
        try { element?.pause?.(); } catch { /* continue releasing the remaining resources */ }
        try { if (element) element.srcObject = null; } catch { /* continue releasing the remaining resources */ }
        try { element?.remove?.(); } catch { /* continue releasing the remaining resources */ }
        try { postAttachElement?.pause?.(); } catch { /* continue releasing the comparison element */ }
        try { if (postAttachElement) postAttachElement.srcObject = null; } catch { /* continue releasing the comparison element */ }
        try { postAttachElement?.remove?.(); } catch { /* continue releasing the comparison element */ }
        try { unwrappedElement?.pause?.(); } catch { /* continue releasing the unwrapped muted element */ }
        try { if (unwrappedElement) unwrappedElement.srcObject = null; } catch { /* continue releasing the unwrapped muted element */ }
        try { unwrappedElement?.remove?.(); } catch { /* continue releasing the unwrapped muted element */ }
        try { postAttachSource?.disconnect?.(); } catch { /* continue disconnecting the comparison path */ }
        try { postAttachAnalyser?.disconnect?.(); } catch { /* continue disconnecting the comparison path */ }
        try { postAttachGain?.disconnect?.(); } catch { /* continue releasing the comparison path */ }
        try { capturedStreamSource?.disconnect?.(); } catch { /* continue disconnecting the captured-element path */ }
        try { capturedAnalyser?.disconnect?.(); } catch { /* continue disconnecting the captured-element path */ }
        try { capturedGain?.disconnect?.(); } catch { /* continue releasing the captured-element path */ }
        try { unwrappedStreamSource?.disconnect?.(); } catch { /* continue disconnecting the unwrapped muted capture path */ }
        try { unwrappedAnalyser?.disconnect?.(); } catch { /* continue disconnecting the unwrapped muted capture path */ }
        try { unwrappedGain?.disconnect?.(); } catch { /* continue releasing the unwrapped muted capture path */ }
        const record = element && sinks.get(element);
        if (record) {
          try { record.source.disconnect(); } catch { /* continue disconnecting the remaining nodes */ }
          try { record.analyser.disconnect(); } catch { /* continue disconnecting the remaining nodes */ }
          try { record.gain.disconnect(); } catch { /* continue releasing the remaining resources */ }
          records.delete(record);
        }
        if (element) sinks.delete(element);
        try { await sourceContext?.close?.(); } catch { /* only the calibration source context is owned here */ }
      }
    },
  };
}
