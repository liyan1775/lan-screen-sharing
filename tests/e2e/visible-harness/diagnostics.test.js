import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyHarnessFailure, latestAuthenticatedMembers, safeMediaDiagnostics, safeProtocolDiagnostics } from './controller.js';
import { activeRtpPeerConnections, activeRtpReceivedTracks, assertActiveMeshConnections, assertAudioSignaturesMatch, correlateReceivedTracks, expectedScreenFlows, installRtpStatsSamplers, publicAudioCalibrationDiagnostics, publicAudioSignatureDiagnostics, publicQualityDiagnostics, publicStopBaselineDiagnostics, signatureMatches, videoFrameProgressed } from './assertions.js';

test('PCM mismatch remains a failure while safe evidence retains every sampled signature', () => {
  const aliases = new Map([['peer-a', 'host'], ['peer-b', 'viewer-1']]);
  const signatures = [
    { peerId: 'peer-a', role: 'systemAudio', alias: 'host', hz: 440, peakDb: -31.24, signal: true, matches: true, sampleRate: 48000, fftSize: 8192, contextState: 'running', nativePlayResolved: true, playing: true, currentTime: 2.345, outputGain: 0 },
    { peerId: 'peer-b', role: 'microphone', alias: 'viewer-1', hz: 733, peakDb: -48.26, signal: true, matches: false, sampleRate: 44100, fftSize: 8192, contextState: 'suspended', nativePlayResolved: true, playing: true, currentTime: 1.234, outputGain: 0 },
  ].map((item) => ({ ...item, matches: signatureMatches({ ...item, aliases }) }));

  assert.equal(signatures[0].matches, true);
  assert.equal(signatures[1].matches, false);
  assert.throws(() => assertAudioSignaturesMatch(signatures), /decoded production sink PCM signature/);
  assert.deepEqual(publicAudioSignatureDiagnostics(signatures), { signatures: [
    { alias: 'host', role: 'systemAudio', expectedHz: 440, observedPeakHz: 440, peakDb: -31.2, signal: true, matches: true, sampleRate: 48000, fftSize: 8192, senderSourceContextState: 'not_observable', sampleContextState: 'running', nativePlayResolved: true, playing: true, currentTime: 2.35, outputGain: 0, mediaMuted: null, mediaVolume: null },
    { alias: 'viewer-1', role: 'microphone', expectedHz: 617, observedPeakHz: 733, peakDb: -48.3, signal: true, matches: false, sampleRate: 44100, fftSize: 8192, senderSourceContextState: 'not_observable', sampleContextState: 'suspended', nativePlayResolved: true, playing: true, currentTime: 1.23, outputGain: 0, mediaMuted: null, mediaVolume: null },
  ], sourceContexts: [] });
});

test('PCM safe diagnostics allowlist unknown metadata and never serialize injected secrets', () => {
  const secret = 'injected-secret-token-peer-track-error';
  const result = publicAudioSignatureDiagnostics([
    { peerId: secret, trackId: secret, alias: secret, role: secret, hz: Infinity, peakDb: NaN, signal: false, matches: false, sampleRate: NaN, fftSize: Infinity, contextState: secret, error: secret },
  ], { sourceContexts: [{ alias: secret, role: secret, contextState: secret, trackState: secret, trackEnabled: secret, trackMuted: secret }] });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(secret), false);
  assert.deepEqual(result, { signatures: [
    { alias: 'other', role: 'other', expectedHz: null, observedPeakHz: null, peakDb: null, signal: false, matches: false, sampleRate: null, fftSize: null, senderSourceContextState: 'not_observable', sampleContextState: 'unknown', nativePlayResolved: false, playing: false, currentTime: null, outputGain: null, mediaMuted: null, mediaVolume: null },
  ], sourceContexts: [{ alias: 'other', role: 'other', sourceContextState: 'unknown', sourceTrackState: 'other', sourceTrackEnabled: null, sourceTrackMuted: null }] });
});

test('normal all-match PCM assertion remains successful and source context states are safe', () => {
  const match = { alias: 'host', role: 'microphone', hz: 523, signal: true, matches: true };
  assert.doesNotThrow(() => assertAudioSignaturesMatch([match]));
  assert.deepEqual(publicAudioSignatureDiagnostics([match], { sourceContexts: [
    { alias: 'host', role: 'microphone', contextState: 'suspended', trackState: 'live', trackEnabled: true, trackMuted: false },
    { alias: 'host', role: 'systemAudio', contextState: 'unexpected-private-state' },
  ] }).sourceContexts, [
    { alias: 'host', role: 'microphone', sourceContextState: 'suspended', sourceTrackState: 'live', sourceTrackEnabled: true, sourceTrackMuted: false },
    { alias: 'host', role: 'systemAudio', sourceContextState: 'unknown', sourceTrackState: 'other', sourceTrackEnabled: null, sourceTrackMuted: null },
  ]);
});

test('native audio calibration projection shows safe same-pipeline measures and filters injected fields', () => {
  const secret = 'private-peer-track-room-token';
  const diagnostic = publicAudioCalibrationDiagnostics({
    available: true, expectedHz: 523, observedPeakHz: 521, peakDb: -22.26, signal: true,
    sampleRate: 48000, fftSize: 8192, sourceContextState: 'running', sinkContextState: 'running',
    mediaMuted: false, mediaVolume: 1, nativePlayResolved: true, playing: true,
    currentTime: 0.567, outputGain: 0, sourceClockAdvance: 0.249, sinkClockAdvance: 0.311, mediaTimeAdvance: 0.567,
    captureStreamApiAvailable: true, captureStreamAvailable: true, capturedAudioTrackCount: 1, capturedLiveAudioTrackCount: 1, capturedSinkClockAdvance: 0.233,
    measurements: {
      oscillatorPath: { observedPeakHz: 521, peakDb: -22.26, signal: true, sampleRate: 48000, fftSize: 8192, contextState: 'running', peerId: secret },
      streamPath: { observedPeakHz: 520, peakDb: -31.14, signal: true, sampleRate: 48000, fftSize: 8192, contextState: 'running', token: secret },
      elementPath: { observedPeakHz: null, peakDb: null, signal: false, sampleRate: 48000, fftSize: 8192, contextState: 'running', bins: [secret] },
      postAttachElementPath: { observedPeakHz: 521, peakDb: -25.34, signal: true, sampleRate: 48000, fftSize: 8192, contextState: 'running', peerId: secret },
      capturedElementPath: { observedPeakHz: 521, peakDb: -26.24, signal: true, sampleRate: 48000, fftSize: 8192, contextState: 'running', peerId: secret },
      unwrappedMutedElementCapturePath: { observedPeakHz: 521, peakDb: -27.2, signal: true, sampleRate: 48000, fftSize: 8192, contextState: 'running', peerId: secret },
    },
    postAttachPlayback: { nativePlayResolved: true, playing: true, currentTime: 0.456, timeAdvance: 0.234, outputGain: 0, mediaMuted: false, mediaVolume: 1, token: secret },
    unwrappedMutedElementPlayback: { nativePlayResolved: true, playing: true, currentTime: 0.456, timeAdvance: 0.234, muted: true, volume: 1, outputGain: 0, captureStreamApiAvailable: true, captureStreamAvailable: true, capturedAudioTrackCount: 1, capturedLiveAudioTrackCount: 1, sinkClockAdvance: 0.311, token: secret },
    peerId: secret, bins: [secret], error: secret,
  });
  assert.deepEqual(diagnostic, {
    available: true, expectedHz: 523, observedPeakHz: 521, peakDb: -22.3, signal: true,
    matches: true, sampleRate: 48000, fftSize: 8192, sourceContextState: 'running', sinkContextState: 'running',
    mediaMuted: false, mediaVolume: 1, nativePlayResolved: true, playing: true,
    currentTime: 0.57, outputGain: 0, sourceClockAdvance: 0.249, sinkClockAdvance: 0.311, mediaTimeAdvance: 0.567,
    measurements: {
      oscillatorPath: { observedPeakHz: 521, peakDb: -22.3, signal: true, sampleRate: 48000, fftSize: 8192, contextState: 'running' },
      streamPath: { observedPeakHz: 520, peakDb: -31.1, signal: true, sampleRate: 48000, fftSize: 8192, contextState: 'running' },
      elementPath: { observedPeakHz: null, peakDb: null, signal: false, sampleRate: 48000, fftSize: 8192, contextState: 'running' },
      postAttachElementPath: { observedPeakHz: 521, peakDb: -25.3, signal: true, sampleRate: 48000, fftSize: 8192, contextState: 'running' },
      capturedElementPath: { observedPeakHz: 521, peakDb: -26.2, signal: true, sampleRate: 48000, fftSize: 8192, contextState: 'running' },
      unwrappedMutedElementCapturePath: { observedPeakHz: 521, peakDb: -27.2, signal: true, sampleRate: 48000, fftSize: 8192, contextState: 'running' },
    },
    captureStreamApiAvailable: true, captureStreamAvailable: true, capturedAudioTrackCount: 1, capturedLiveAudioTrackCount: 1, capturedSinkClockAdvance: 0.233,
    postAttachPlayback: { nativePlayResolved: true, playing: true, currentTime: 0.46, timeAdvance: 0.234, outputGain: 0, mediaMuted: false, mediaVolume: 1 },
    unwrappedMutedElementPlayback: { nativePlayResolved: true, playing: true, currentTime: 0.46, timeAdvance: 0.234, muted: true, volume: 1, outputGain: 0, captureStreamApiAvailable: true, captureStreamAvailable: true, capturedAudioTrackCount: 1, capturedLiveAudioTrackCount: 1, sinkClockAdvance: 0.311 },
  });
  assert.equal(JSON.stringify(diagnostic).includes(secret), false);
  assert.deepEqual(publicAudioCalibrationDiagnostics({ available: false, error: secret }), { available: false });
  assert.deepEqual(publicAudioCalibrationDiagnostics({ available: true, measurements: { capturedElementPath: { available: false, failure: secret } } }).measurements.capturedElementPath, { available: false, failure: 'unknown' });
});

test('quality frame failure leaves safe stage evidence before the fixed assertion still fails', () => {
  const frame = { ok: false, readyState: 1, width: 0, height: 0, varied: false, variedPixelsDelta: null };
  const evidence = publicQualityDiagnostics({ stage: 'frame', frame });
  assert.deepEqual(evidence, {
    stage: 'frame', frame: { readyState: 'metadata', width: 0, height: 0, variedPixelsDelta: null, presentedFrameProgressed: null },
    play: null, videoLinks: null, uiMatchesReportedResolution: null,
  });
  assert.equal(classifyHarnessFailure(new Error('decoded screen frame/dimensions/content missing')), 'screen_frame_missing');
  assert.throws(() => { if (!frame.ok || !frame.varied) throw new Error('decoded screen frame/dimensions/content missing'); }, /decoded screen frame/);
});

test('quality stats and playback evidence expose only allowlisted aliases, values, and enum states', () => {
  const secret = 'private-peer-track-sdp-token';
  const evidence = publicQualityDiagnostics({
    stage: 'ui', frame: { readyState: 4, width: 1280, height: 720, variedPixelsDelta: 543 },
    play: { nativePlayResolved: true, playing: true, paused: false, currentTime: 3.256, outputGain: 0, contextState: 'suspended', error: secret },
    stats: [
      { peerId: 'peer-safe', role: 'screenVideo', direction: 'outbound', frames: 10, width: 1280, height: 720 },
      { peerId: secret, role: secret, direction: secret, frames: NaN, width: Infinity, height: 2 },
    ], aliases: new Map([['peer-safe', 'viewer-1']]), uiMatchesReportedResolution: false,
  });
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes(secret), false);
  assert.deepEqual(evidence, {
    stage: 'ui', frame: { readyState: 'enough_data', width: 1280, height: 720, variedPixelsDelta: 543, presentedFrameProgressed: null },
    play: { resolved: true, playing: true, paused: false, currentTime: 3.26, zeroGain: true, contextState: 'suspended' },
    videoLinks: [
      { alias: 'viewer-1', role: 'screenVideo', direction: 'outbound', frames: 10, width: 1280, height: 720 },
      { alias: 'other', role: 'other', direction: 'other', frames: null, width: null, height: 2 },
    ],
    uiMatchesReportedResolution: false,
  });
});

test('quality frame progression requires an actually presented later frame or advancing media time', () => {
  assert.equal(videoFrameProgressed({ presentedFrames: 8, mediaTime: 1 }, { presentedFrames: 9, mediaTime: 1 }), true);
  assert.equal(videoFrameProgressed({ presentedFrames: 8, mediaTime: 1 }, { presentedFrames: 8, mediaTime: 1.2 }), true);
  assert.equal(videoFrameProgressed({ presentedFrames: 8, mediaTime: 1 }, { presentedFrames: 8, mediaTime: 1 }), false);
  assert.equal(videoFrameProgressed(null, { presentedFrames: 9, mediaTime: 1.2 }), false);
});

test('stop baseline projection retains safe per-flow counts while filtering raw identities and errors', () => {
  const secret = 'secret-peer-track-sdp-room';
  const expected = [
    { peerId: 'peer-a', role: 'screenVideo', direction: 'outbound' },
    { peerId: 'peer-a', role: 'systemAudio', direction: 'outbound' },
  ];
  const evidence = publicStopBaselineDiagnostics({
    stage: 'saved', expected, aliases: new Map([['peer-a', 'viewer-1']]),
    rows: [
      { peerId: 'peer-a', role: 'screenVideo', direction: 'outbound', bytes: 300, packets: 5, frames: 4, width: 1280, height: 720, audioLevel: 0, pcId: 2 },
      { peerId: secret, role: secret, direction: secret, bytes: Infinity, packets: NaN },
    ], failure: 'none', error: secret,
  });
  assert.deepEqual(evidence, {
    stage: 'saved', failure: 'none', failedStep: 'none', videoFlows: [
      { alias: 'viewer-1', role: 'screenVideo', direction: 'outbound', rowCount: 1, rowState: 'present', bytes: 300, packets: 5, frames: 4, width: 1280, height: 720 },
      { alias: 'viewer-1', role: 'systemAudio', direction: 'outbound', rowCount: 0, rowState: 'missing', bytes: null, packets: null, frames: null, width: null, height: null },
    ],
  });
  assert.equal(JSON.stringify(evidence).includes(secret), false);
  assert.deepEqual(publicStopBaselineDiagnostics({ stage: 'projection_failed', failure: 'injected-free-text-error', rows: [secret] }), {
    stage: 'failed', failure: 'projection_failed', failedStep: 'none', videoFlows: null,
  });
  assert.deepEqual(publicStopBaselineDiagnostics({ stage: 'failed', failure: 'projection_failed', failedStep: 'expected_screen_flows', rows: [secret] }), {
    stage: 'failed', failure: 'projection_failed', failedStep: 'expected_screen_flows', videoFlows: null,
  });
  assert.equal(publicStopBaselineDiagnostics({ stage: 'failed', failedStep: secret }).failedStep, 'none');
});

test('expected stop screen flows use the explicit role and only remote active roster members', () => {
  const members = [
    { peerId: 'host', role: 'host', state: 'connected' },
    { peerId: 'viewer-1', role: 'viewer', state: 'connected' },
    { peerId: 'viewer-2', role: 'viewer', state: 'connected' },
    { peerId: 'stale', role: 'viewer', state: 'disconnected' },
    { peerId: 'other', role: 'moderator', state: 'connected' },
  ];
  const activeMembers = members.filter((member) => member.state === 'connected');
  assert.deepEqual(expectedScreenFlows(activeMembers, 'host'), [
    { peerId: 'viewer-1', role: 'screenVideo', direction: 'outbound' },
    { peerId: 'viewer-1', role: 'systemAudio', direction: 'outbound' },
    { peerId: 'viewer-2', role: 'screenVideo', direction: 'outbound' },
    { peerId: 'viewer-2', role: 'systemAudio', direction: 'outbound' },
  ]);
  assert.deepEqual(expectedScreenFlows(activeMembers, 'viewer'), [
    { peerId: 'host', role: 'screenVideo', direction: 'inbound' },
    { peerId: 'host', role: 'systemAudio', direction: 'inbound' },
  ]);
  assert.deepEqual(expectedScreenFlows(activeMembers, 'viewer'), [
    { peerId: 'host', role: 'screenVideo', direction: 'inbound' },
    { peerId: 'host', role: 'systemAudio', direction: 'inbound' },
  ]);
  assert.throws(() => expectedScreenFlows(activeMembers, 'viewer-extra'), /invalid participant role/);
});

test('RTP sampling installs once per current PC, refreshes new PCs and skips closed history', async () => {
  const makePC = (label, signalingState = 'stable', reports = []) => {
    let calls = 0;
    const reportMap = new Map(reports.map((row) => [row.id, row]));
    const pc = {
      signalingState,
      get callCount() { return calls; },
      async getStats() { calls += 1; return reportMap; },
    };
    pc.label = label;
    return { pc, reportMap };
  };
  const firstA = makePC('first-a', 'stable', [{ id: 'old-a', bytesSent: 11 }]);
  const firstB = makePC('first-b', 'stable', [{ id: 'old-b', bytesReceived: 12 }]);
  const initial = [firstA.pc, firstB.pc];
  installRtpStatsSamplers(initial);
  const firstWrapper = firstA.pc.getStats;
  installRtpStatsSamplers(initial);
  assert.equal(firstA.pc.getStats, firstWrapper, 'repeat installation must not stack wrappers');
  assert.equal(await firstA.pc.getStats(), firstA.reportMap, 'wrapped getStats preserves its native result');
  assert.deepEqual(firstA.pc.__lanScreenHarnessReports, [{ id: 'old-a', bytesSent: 11 }]);

  firstA.pc.signalingState = 'closed';
  const nextA = makePC('next-a', 'stable', [{ id: 'new-a', bytesSent: 31 }]);
  const nextB = makePC('next-b', 'stable', [{ id: 'new-b', bytesReceived: 32 }]);
  const all = [...initial, nextA.pc, nextB.pc];
  installRtpStatsSamplers(all);
  assert.equal(firstA.pc.getStats, firstWrapper, 'closed historical PCs are not rewrapped');
  assert.equal(nextA.pc.__lanScreenHarnessReports, undefined, 'new reports are not assumed to exist before sampling');
  const current = activeRtpPeerConnections(all);
  assert.deepEqual(current.map(({ pc }) => pc.label), ['first-b', 'next-a', 'next-b']);
  await Promise.all(current.map(({ pc }) => pc.getStats()));
  assert.deepEqual(nextA.pc.__lanScreenHarnessReports, [{ id: 'new-a', bytesSent: 31 }]);
  assert.deepEqual(nextB.pc.__lanScreenHarnessReports, [{ id: 'new-b', bytesReceived: 32 }]);
  assert.equal(firstA.pc.callCount, 1, 'closed historical PCs are not sampled again');
  assert.equal(nextA.pc.callCount, 1, 'first fresh baseline samples the new PC directly');

  const failure = new Error('native stats failed');
  const broken = { signalingState: 'stable', getStats: async () => { throw failure; } };
  installRtpStatsSamplers([broken]);
  await assert.rejects(broken.getStats(), (error) => error === failure, 'native getStats exceptions remain visible');
});

test('rejoin correlation excludes closed PC history but keeps strict matching and open failures', () => {
  const pcs = [
    { signalingState: 'closed', connectionState: 'closed' },
    { signalingState: 'closed', connectionState: 'closed' },
    { signalingState: 'stable', connectionState: 'connected' },
    { signalingState: 'stable', connectionState: 'connected' },
  ];
  const currentPCs = assertActiveMeshConnections(pcs, 2);
  const current = currentPCs.map(({ pc, pcId }) => ({
    id: pcId,
    localDescription: { sdp: `local-${pcId}` },
    remoteDescription: { sdp: `remote-${pcId}` },
  }));
  const descriptions = [
    { peerId: 'departed-peer', direction: 'incoming', sdp: 'old-remote', tracks: [{ mid: 'old-mid', role: 'microphone' }] },
    { peerId: 'departed-peer', direction: 'outgoing', sdp: 'old-local', tracks: [{ mid: 'old-mid', role: 'microphone' }] },
    { peerId: 'host-current', direction: 'incoming', sdp: 'remote-2', tracks: [{ mid: '0', role: 'microphone' }] },
    { peerId: 'host-current', direction: 'outgoing', sdp: 'local-2', tracks: [{ mid: '0', role: 'microphone' }] },
    { peerId: 'viewer-1-current', direction: 'incoming', sdp: 'remote-3', tracks: [{ mid: '1', role: 'microphone' }] },
    { peerId: 'viewer-1-current', direction: 'outgoing', sdp: 'local-3', tracks: [{ mid: '1', role: 'microphone' }] },
  ];
  const received = [
    { pcId: 0, mid: 'old-mid', trackId: 'removed-track', kind: 'audio', state: 'live' },
    { pcId: 2, mid: '0', trackId: 'host-track', kind: 'audio', state: 'live' },
    { pcId: 3, mid: '1', trackId: 'viewer-track', kind: 'audio', state: 'live' },
  ];
  const activeReceived = activeRtpReceivedTracks(pcs, received);
  assert.deepEqual(activeReceived.map((event) => event.trackId), ['host-track', 'viewer-track']);
  const members = [
    { peerId: 'viewer-2-current', role: 'viewer' },
    { peerId: 'host-current', role: 'host' },
    { peerId: 'viewer-1-current', role: 'viewer' },
  ];
  const sinks = [
    { trackId: 'host-track', peerId: 'host-current', role: 'microphone' },
    { trackId: 'viewer-track', peerId: 'viewer-1-current', role: 'microphone' },
  ];
  assert.deepEqual(correlateReceivedTracks({ pcs: current, received: activeReceived, descriptions, sinks, members }).map((item) => item.peerId), ['host-current', 'viewer-1-current']);
  const failedOpenPC = { signalingState: 'stable', connectionState: 'failed' };
  assert.throws(() => assertActiveMeshConnections([...pcs, failedOpenPC], 3), /a native mesh PC is not connected/);
});

test('authenticated roster reads the join acknowledgment snapshot and accepts newer state snapshots', () => {
  const joinSnapshot = [{ peerId: 'private-host', role: 'host' }, { peerId: 'private-viewer', role: 'viewer' }];
  assert.deepEqual(latestAuthenticatedMembers([
    { type: 'room.state', payload: { members: [] } },
    { type: 'room.joined', observedAt: 10, payload: { members: joinSnapshot } },
  ]), joinSnapshot);

  const updatedSnapshot = [...joinSnapshot, { peerId: 'private-viewer-2', role: 'viewer' }];
  assert.deepEqual(latestAuthenticatedMembers([
    { type: 'room.joined', observedAt: 10, payload: { members: joinSnapshot } },
    { type: 'room.state', observedAt: 11, payload: { members: updatedSnapshot } },
  ]), updatedSnapshot);
});

test('authenticated roster applies terminal, leave, and resumed join events in order', () => {
  const host = { peerId: 'private-host', role: 'host' };
  const viewer1 = { peerId: 'private-viewer-1', role: 'viewer' };
  const viewer2 = { peerId: 'private-viewer-2', role: 'viewer' };
  const afterJoin = [host, viewer1, viewer2];
  assert.deepEqual(latestAuthenticatedMembers([
    { type: 'room.joined', payload: { members: [host, viewer1] } },
    { type: 'room.state', payload: { members: afterJoin } },
    { type: 'room.ended', payload: {} },
    { type: 'room.state', payload: { members: afterJoin } },
  ]), []);

  assert.deepEqual(latestAuthenticatedMembers([
    { type: 'room.joined', payload: { members: afterJoin } },
    { type: 'peer.left', peerId: 'private-host', payload: { peerId: 'private-viewer-2' } },
  ]), [host, viewer1]);

  const rejoined = [{ ...viewer2, state: 'connected' }];
  assert.deepEqual(latestAuthenticatedMembers([
    { type: 'room.joined', payload: { members: afterJoin } },
    { type: 'peer.left', payload: { peerId: 'private-viewer-2' } },
    { type: 'room.joined', payload: { members: [host, viewer1, ...rejoined] } },
  ]), [host, viewer1, ...rejoined]);
});

test('authenticated host room-created acknowledgment seeds only its actual host identity', () => {
  assert.deepEqual(latestAuthenticatedMembers([
    { type: 'room.state', payload: { members: [] } },
    { type: 'room.created', peerId: 'private-host', payload: { roomCode: 'private-code' } },
    { type: 'peer.joined', peerId: 'private-viewer', payload: { role: 'viewer' } },
  ]), [
    { peerId: 'private-host', role: 'host', state: 'connected' },
    { peerId: 'private-viewer', role: 'viewer', state: 'connected' },
  ]);
});

test('safe protocol diagnostics correlate internally and expose only allowlisted metadata', () => {
  const state = {
    sent: [{
      requestId: 'private-request-id', type: 'rtc.description', peerId: 'private-peer-v2',
      wireBytes: 744,
      payload: { toPeerId: 'private-peer-v2', description: { type: 'offer', sdp: 'private-secret-sdp' }, tracks: [{ mid: '0', role: 'microphone' }] },
    }],
    incoming: [{
      requestId: 'private-request-id', type: 'error', peerId: 'private-peer-v1',
      payload: { code: 'SIGNAL_TARGET_NOT_MEMBER', retryable: true, message: 'private server detail' },
    }],
  };
  const result = safeProtocolDiagnostics({
    role: 'viewer', alias: 'viewer-1', ownPeerId: 'private-peer-v1',
    members: [
      { peerId: 'private-peer-host', role: 'host' },
      { peerId: 'private-peer-v1', role: 'viewer' },
      { peerId: 'private-peer-v2', role: 'viewer' },
    ],
    viewerJoinOrder: ['private-peer-v1', 'private-peer-v2'], state,
  });

  assert.deepEqual(result, [{
    alias: 'viewer-1', requestType: 'rtc.description', targetAlias: 'viewer-2',
    code: 'SIGNAL_TARGET_NOT_MEMBER', retryable: true, wireBytes: 744,
    descriptionType: 'offer', sdpBytes: 18, trackRoleCount: 1, candidateFieldsPresent: 0,
  }]);
  const serialized = JSON.stringify(result);
  for (const secret of ['private-request-id', 'private-peer-v1', 'private-peer-v2', 'private-secret-sdp', 'private server detail']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('safe media diagnostics report per-alias MID roles and track state without raw identities or SDP', () => {
  const pc = {
    connectionState: 'connected', signalingState: 'stable',
    localDescription: { type: 'offer', sdp: 'private-local-sdp' },
    remoteDescription: { type: 'answer', sdp: 'private-remote-sdp' },
    getTransceivers: () => [{
      mid: '0', __trackRole: 'microphone', direction: 'sendrecv',
      sender: { track: { kind: 'audio', id: 'private-sender-track' } },
      receiver: { track: { kind: 'audio', readyState: 'live', muted: false } },
    }],
  };
  const state = {
    pcs: [pc],
    localDescriptions: [{ pcId: 0, sdp: 'private-local-sdp' }],
    remoteDescriptions: [{ pcId: 0, sdp: 'private-remote-sdp' }],
    sent: [{ type: 'rtc.description', direction: 'outgoing', peerId: 'private-peer-v2', payload: { description: { type: 'offer', sdp: 'private-local-sdp' }, tracks: [{ mid: '0', role: 'microphone' }] } }],
    incoming: [{ type: 'rtc.description', direction: 'incoming', peerId: 'private-peer-v2', payload: { description: { type: 'answer', sdp: 'private-remote-sdp' }, tracks: [{ mid: '0', role: 'microphone' }] } }],
    received: [{ pcId: 0, mid: '0', trackId: 'private-receiver-track', kind: 'audio', state: 'live', muted: false }],
  };

  const result = safeMediaDiagnostics({
    role: 'viewer', alias: 'viewer-1', ownPeerId: 'private-peer-v1',
    members: [
      { peerId: 'private-peer-host', role: 'host' },
      { peerId: 'private-peer-v1', role: 'viewer' },
      { peerId: 'private-peer-v2', role: 'viewer' },
    ],
    viewerJoinOrder: ['private-peer-v1', 'private-peer-v2'], state,
  });

  assert.deepEqual(result, [{
    alias: 'viewer-1', peerAlias: 'viewer-2', pcState: 'connected', signalingState: 'stable', iceState: 'unknown',
    localDescriptionType: 'offer', remoteDescriptionType: 'answer',
    localRoleMids: [{ mid: '0', role: 'microphone' }], remoteRoleMids: [{ mid: '0', role: 'microphone' }],
    transceivers: [{ mid: '0', role: 'microphone', direction: 'sendrecv', senderTrackKind: 'audio', receiverTrackKind: 'audio', receiverReadyState: 'live', receiverMuted: false }],
    received: [{ mid: '0', role: 'microphone', kind: 'audio', state: 'live', muted: false }],
  }]);
  const serialized = JSON.stringify(result);
  for (const secret of ['private-peer-v1', 'private-peer-v2', 'private-local-sdp', 'private-remote-sdp', 'private-sender-track', 'private-receiver-track']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('assertion failure classifier never returns the underlying error text', () => {
  assert.equal(classifyHarnessFailure(new Error('production sink is missing received track private-track-id')), 'production_sink_missing');
  assert.equal(classifyHarnessFailure(new Error('PC 7 has ambiguous authenticated peer SDP correlation; private-sdp')), 'peer_sdp_ambiguous');
  assert.equal(classifyHarnessFailure(new Error('unrecognized private failure payload')), 'assertion_unclassified');
});

test('assertion failure classifier covers fixed mesh and authenticated-role failures', () => {
  const cases = [
    ['mesh PC count incomplete', 'mesh_pc_count_incomplete'],
    ['own authenticated member missing', 'own_authenticated_member_missing'],
    ['received role not expected from authenticated peer role', 'received_role_unexpected_for_peer'],
    ['host must receive only viewer microphones', 'host_received_role_invalid'],
    ['viewer is missing host screen/system audio or microphone', 'viewer_host_role_missing'],
  ];
  for (const [message, expected] of cases) {
    assert.equal(classifyHarnessFailure(new Error(message)), expected);
  }
  assert.equal(classifyHarnessFailure(new Error('host must receive only viewer microphones; secret-peer')), 'assertion_unclassified');
});
