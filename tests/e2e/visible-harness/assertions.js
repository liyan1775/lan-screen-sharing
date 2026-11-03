const AUDIO_ROLES = new Set(['microphone', 'systemAudio']);
const MICROPHONE_TONES = Object.freeze({ host: 523, 'viewer-1': 617, 'viewer-2': 733, 'viewer-extra': 811 });
const SYSTEM_TONE = 440;
const TONE_TOLERANCE_HZ = 25;

export function mapPeerAliases({ role, alias, ownPeerId, members, viewerJoinOrder = [], previousAliases = new Map() }) {
  const allowed = new Set(Object.keys(MICROPHONE_TONES));
  if (!allowed.has(alias) || !ownPeerId || !Array.isArray(members)) throw new Error('invalid harness participant identity');
  if (new Set(members.map((member) => member.peerId)).size !== members.length) throw new Error('authenticated member IDs are duplicated');
  const own = members.filter((member) => member.peerId === ownPeerId);
  if (own.length !== 1 || own[0].role !== (alias === 'host' ? 'host' : 'viewer')) throw new Error('harness alias does not match authenticated role');
  const aliases = new Map([[ownPeerId, alias]]);
  if (alias === 'host') {
    const viewers = members.filter((member) => member.role === 'viewer').map((member) => member.peerId);
    const current = new Set(viewers);
    const order = [...new Set(viewerJoinOrder)].filter((peerId) => current.has(peerId));
    if (order.length !== viewers.length || order.length > 2) throw new Error('authenticated viewer join order is missing or ambiguous');
    const usedSlots = new Set();
    for (const peerId of viewers) {
      const previous = previousAliases.get(peerId);
      if (previous === 'viewer-1' || previous === 'viewer-2') {
        if (usedSlots.has(previous)) throw new Error('previous authenticated viewer alias assignment is ambiguous');
        aliases.set(peerId, previous); usedSlots.add(previous);
      }
    }
    const availableSlots = ['viewer-1', 'viewer-2'].filter((slot) => !usedSlots.has(slot));
    for (const peerId of order) if (!aliases.has(peerId)) aliases.set(peerId, availableSlots.shift());
  } else if (alias === 'viewer-1' || alias === 'viewer-2') {
    const hosts = members.filter((member) => member.role === 'host');
    const otherViewers = members.filter((member) => member.role === 'viewer' && member.peerId !== ownPeerId);
    if (hosts.length !== 1 || otherViewers.length > 1 || members.length < 2 || members.length > 3) throw new Error('authenticated room is incomplete or ambiguous');
    aliases.set(hosts[0].peerId, 'host');
    if (otherViewers.length === 1) aliases.set(otherViewers[0].peerId, alias === 'viewer-1' ? 'viewer-2' : 'viewer-1');
  } else {
    throw new Error('extra viewer is not a media-mesh participant');
  }
  return aliases;
}

export function signatureMatches({ peerId, role, hz, aliases }) {
  const alias = aliases.get(peerId);
  if (!alias || !Number.isFinite(hz)) return false;
  const expected = expectedSignatureHz(alias, role);
  return Number.isFinite(expected) && Math.abs(hz - expected) <= TONE_TOLERANCE_HZ;
}

const SAFE_AUDIO_ALIASES = new Set(Object.keys(MICROPHONE_TONES));
const SAFE_AUDIO_CONTEXT_STATES = new Set(['suspended', 'running', 'closed', 'interrupted']);

export function expectedSignatureHz(alias, role) {
  if (!SAFE_AUDIO_ALIASES.has(alias)) return null;
  if (role === 'systemAudio') return alias === 'host' ? SYSTEM_TONE : null;
  return role === 'microphone' ? MICROPHONE_TONES[alias] ?? null : null;
}

function safeAudioNumber(value, digits = 0) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function safeAudioAlias(value) { return SAFE_AUDIO_ALIASES.has(value) ? value : 'other'; }
function safeAudioRole(value) { return AUDIO_ROLES.has(value) ? value : 'other'; }
function safeAudioContextState(value) { return SAFE_AUDIO_CONTEXT_STATES.has(value) ? value : 'unknown'; }

export function publicAudioSignatureDiagnostics(signatures, { sourceContexts = [] } = {}) {
  const ownSourceContexts = sourceContexts.map((item) => ({
    alias: safeAudioAlias(item.alias), role: safeAudioRole(item.role),
    sourceContextState: safeAudioContextState(item.contextState),
    sourceTrackState: item.trackState === 'live' || item.trackState === 'ended' ? item.trackState : 'other',
    sourceTrackEnabled: typeof item.trackEnabled === 'boolean' ? item.trackEnabled : null,
    sourceTrackMuted: typeof item.trackMuted === 'boolean' ? item.trackMuted : null,
  }));
  const rows = (signatures ?? []).map((item) => {
    const alias = safeAudioAlias(item.alias);
    const role = safeAudioRole(item.role);
    return {
      alias, role,
      expectedHz: expectedSignatureHz(alias, role),
      observedPeakHz: safeAudioNumber(item.hz), peakDb: safeAudioNumber(item.peakDb, 1),
      signal: item.signal === true, matches: item.matches === true,
      sampleRate: safeAudioNumber(item.sampleRate), fftSize: safeAudioNumber(item.fftSize),
      senderSourceContextState: 'not_observable',
      sampleContextState: safeAudioContextState(item.contextState),
      nativePlayResolved: item.nativePlayResolved === true, playing: item.playing === true,
      currentTime: safeAudioNumber(item.currentTime, 2), outputGain: safeAudioNumber(item.outputGain, 4),
      mediaMuted: typeof item.mediaMuted === 'boolean' ? item.mediaMuted : null,
      mediaVolume: safeAudioNumber(item.mediaVolume, 3),
    };
  });
  return { signatures: rows, sourceContexts: ownSourceContexts };
}

export function publicAudioCalibrationDiagnostics(calibration) {
  if (!calibration || calibration.available !== true) return { available: false };
  const expectedHz = safeAudioNumber(calibration.expectedHz);
  const observedPeakHz = safeAudioNumber(calibration.observedPeakHz);
  const measurements = Object.fromEntries(['oscillatorPath', 'streamPath', 'elementPath', 'postAttachElementPath', 'capturedElementPath', 'unwrappedMutedElementCapturePath'].map((path) => {
    const item = calibration.measurements?.[path];
    return [path, item?.available === false ? {
      available: false,
      failure: ['capture_stream_unsupported', 'capture_stream_has_no_audio_track', 'capture_stream_failed', 'native_play_not_resolved'].includes(item.failure) ? item.failure : 'unknown',
    } : item ? {
      observedPeakHz: safeAudioNumber(item.observedPeakHz), peakDb: safeAudioNumber(item.peakDb, 1),
      signal: item.signal === true, sampleRate: safeAudioNumber(item.sampleRate),
      fftSize: safeAudioNumber(item.fftSize), contextState: safeAudioContextState(item.contextState),
    } : null];
  }));
  return {
    available: true,
    expectedHz, observedPeakHz, peakDb: safeAudioNumber(calibration.peakDb, 1),
    signal: calibration.signal === true,
    matches: expectedHz != null && observedPeakHz != null && Math.abs(expectedHz - observedPeakHz) <= 25,
    measurements,
    captureStreamApiAvailable: calibration.captureStreamApiAvailable === true,
    captureStreamAvailable: calibration.captureStreamAvailable === true,
    capturedAudioTrackCount: safeAudioNumber(calibration.capturedAudioTrackCount),
    capturedLiveAudioTrackCount: safeAudioNumber(calibration.capturedLiveAudioTrackCount),
    capturedSinkClockAdvance: safeAudioNumber(calibration.capturedSinkClockAdvance, 3),
    postAttachPlayback: calibration.postAttachPlayback ? {
      nativePlayResolved: calibration.postAttachPlayback.nativePlayResolved === true,
      playing: calibration.postAttachPlayback.playing === true,
      currentTime: safeAudioNumber(calibration.postAttachPlayback.currentTime, 2),
      timeAdvance: safeAudioNumber(calibration.postAttachPlayback.timeAdvance, 3),
      outputGain: safeAudioNumber(calibration.postAttachPlayback.outputGain, 4),
      mediaMuted: typeof calibration.postAttachPlayback.mediaMuted === 'boolean' ? calibration.postAttachPlayback.mediaMuted : null,
      mediaVolume: safeAudioNumber(calibration.postAttachPlayback.mediaVolume, 3),
    } : null,
    unwrappedMutedElementPlayback: calibration.unwrappedMutedElementPlayback ? {
      nativePlayResolved: calibration.unwrappedMutedElementPlayback.nativePlayResolved === true,
      playing: calibration.unwrappedMutedElementPlayback.playing === true,
      currentTime: safeAudioNumber(calibration.unwrappedMutedElementPlayback.currentTime, 2),
      timeAdvance: safeAudioNumber(calibration.unwrappedMutedElementPlayback.timeAdvance, 3),
      muted: calibration.unwrappedMutedElementPlayback.muted === true,
      volume: safeAudioNumber(calibration.unwrappedMutedElementPlayback.volume, 3),
      outputGain: safeAudioNumber(calibration.unwrappedMutedElementPlayback.outputGain, 4),
      captureStreamApiAvailable: calibration.unwrappedMutedElementPlayback.captureStreamApiAvailable === true,
      captureStreamAvailable: calibration.unwrappedMutedElementPlayback.captureStreamAvailable === true,
      capturedAudioTrackCount: safeAudioNumber(calibration.unwrappedMutedElementPlayback.capturedAudioTrackCount),
      capturedLiveAudioTrackCount: safeAudioNumber(calibration.unwrappedMutedElementPlayback.capturedLiveAudioTrackCount),
      sinkClockAdvance: safeAudioNumber(calibration.unwrappedMutedElementPlayback.sinkClockAdvance, 3),
    } : null,
    sourceClockAdvance: safeAudioNumber(calibration.sourceClockAdvance, 3),
    sinkClockAdvance: safeAudioNumber(calibration.sinkClockAdvance, 3),
    mediaTimeAdvance: safeAudioNumber(calibration.mediaTimeAdvance, 3),
    sampleRate: safeAudioNumber(calibration.sampleRate), fftSize: safeAudioNumber(calibration.fftSize),
    sourceContextState: safeAudioContextState(calibration.sourceContextState),
    sinkContextState: safeAudioContextState(calibration.sinkContextState),
    mediaMuted: typeof calibration.mediaMuted === 'boolean' ? calibration.mediaMuted : null,
    mediaVolume: safeAudioNumber(calibration.mediaVolume, 3),
    nativePlayResolved: calibration.nativePlayResolved === true,
    playing: calibration.playing === true,
    currentTime: safeAudioNumber(calibration.currentTime, 2),
    outputGain: safeAudioNumber(calibration.outputGain, 4),
  };
}

export function assertAudioSignaturesMatch(signatures) {
  if (!signatures.length || signatures.some((item) => !item.signal || !item.matches)) {
    throw new Error('decoded production sink PCM signature does not match its authenticated peer alias');
  }
}

const SAFE_QUALITY_STAGES = new Set(['runtime', 'frame', 'play', 'stats', 'alias', 'ui', 'complete']);
const SAFE_VIDEO_READY_STATES = new Map([[0, 'have_nothing'], [1, 'metadata'], [2, 'current_data'], [3, 'future_data'], [4, 'enough_data']]);
const SAFE_RTP_DIRECTIONS = new Set(['inbound', 'outbound']);
const safeQualityNumeric = (value) => Number.isFinite(value) ? Math.round(value) : null;
const SAFE_STOP_BASELINE_STAGES = new Set(['idle', 'stats', 'projection', 'saved', 'failed']);
const SAFE_STOP_BASELINE_STEPS = new Set(['none', 'authenticated_members', 'expected_screen_flows', 'peer_aliases']);
const RTP_STATS_SAMPLERS = new WeakMap();

export function activeRtpPeerConnections(pcs = []) {
  return pcs.map((pc, pcId) => ({ pc, pcId })).filter(({ pc }) => pc && pc.signalingState !== 'closed');
}

export function activeRtpReceivedTracks(pcs = [], received = []) {
  const activePCIds = new Set(activeRtpPeerConnections(pcs).map(({ pcId }) => pcId));
  return received.filter((event) => event.state === 'live' && activePCIds.has(event.pcId));
}

export function assertActiveMeshConnections(pcs, expectedCount) {
  const active = activeRtpPeerConnections(pcs);
  if (active.length !== expectedCount) throw new Error('mesh PC count incomplete');
  if (active.some(({ pc }) => pc.connectionState !== 'connected')) throw new Error('a native mesh PC is not connected');
  return active;
}

export function installRtpStatsSamplers(pcs = []) {
  for (const { pc, pcId } of activeRtpPeerConnections(pcs)) {
    if (RTP_STATS_SAMPLERS.has(pc)) continue;
    const nativeGetStats = pc.getStats.bind(pc);
    const wrappedGetStats = async (...args) => {
      const reports = await nativeGetStats(...args);
      pc.__lanScreenHarnessReports = [...reports.values()];
      return reports;
    };
    pc.__lanScreenHarnessId = pcId;
    pc.getStats = wrappedGetStats;
    RTP_STATS_SAMPLERS.set(pc, wrappedGetStats);
  }
}

export function expectedScreenFlows(members, participantRole) {
  if (!Array.isArray(members) || (participantRole !== 'host' && participantRole !== 'viewer')) {
    throw new Error('invalid participant role for expected screen flows');
  }
  const direction = participantRole === 'host' ? 'outbound' : 'inbound';
  const remoteRole = participantRole === 'host' ? 'viewer' : 'host';
  return members.filter((member) => member.role === remoteRole)
    .flatMap((member) => [
      { peerId: member.peerId, role: 'screenVideo', direction },
      { peerId: member.peerId, role: 'systemAudio', direction },
    ]);
}

export function publicQualityDiagnostics(input = {}) {
  const aliases = input.aliases instanceof Map ? input.aliases : new Map();
  return {
    stage: SAFE_QUALITY_STAGES.has(input.stage) ? input.stage : 'runtime',
    frame: {
      readyState: SAFE_VIDEO_READY_STATES.get(input.frame?.readyState) ?? 'unknown',
      width: safeQualityNumeric(input.frame?.width), height: safeQualityNumeric(input.frame?.height),
      variedPixelsDelta: safeQualityNumeric(input.frame?.variedPixelsDelta),
      presentedFrameProgressed: typeof input.frame?.presentedFrameProgressed === 'boolean' ? input.frame.presentedFrameProgressed : null,
    },
    play: input.play ? {
      resolved: input.play.nativePlayResolved === true, playing: input.play.playing === true,
      paused: input.play.paused === true, currentTime: safeAudioNumber(input.play.currentTime, 2),
      zeroGain: input.play.outputGain === 0, contextState: safeAudioContextState(input.play.contextState),
    } : null,
    videoLinks: Array.isArray(input.stats) ? input.stats.map((row) => ({
      alias: safeAudioAlias(aliases.get(row.peerId)),
      role: row.role === 'screenVideo' ? 'screenVideo' : 'other',
      direction: SAFE_RTP_DIRECTIONS.has(row.direction) ? row.direction : 'other',
      frames: safeQualityNumeric(row.frames), width: safeQualityNumeric(row.width), height: safeQualityNumeric(row.height),
    })) : null,
    uiMatchesReportedResolution: typeof input.uiMatchesReportedResolution === 'boolean' ? input.uiMatchesReportedResolution : null,
  };
}

export function videoFrameProgressed(previous, current) {
  if (!previous || !current) return false;
  const presentedFramesAdvanced = Number.isFinite(previous.presentedFrames) && Number.isFinite(current.presentedFrames)
    && current.presentedFrames > previous.presentedFrames;
  const mediaTimeAdvanced = Number.isFinite(previous.mediaTime) && Number.isFinite(current.mediaTime)
    && current.mediaTime > previous.mediaTime;
  return presentedFramesAdvanced || mediaTimeAdvanced;
}

export function publicStopBaselineDiagnostics({ stage = 'idle', failure = 'none', failedStep = 'none', expected, rows, aliases } = {}) {
  const safeFailure = ['none', 'collection_failed', 'projection_failed'].includes(failure) ? failure : 'projection_failed';
  const rowsAvailable = Array.isArray(rows) && Array.isArray(expected);
  const peerAliases = aliases instanceof Map ? aliases : new Map();
  const videoFlows = rowsAvailable ? expected.map((flow) => {
    const matches = rows.filter((row) => row.peerId === flow.peerId && row.role === flow.role && row.direction === flow.direction);
    const row = matches.length === 1 ? matches[0] : null;
    return {
      alias: safeAudioAlias(peerAliases.get(flow.peerId)),
      role: flow.role === 'screenVideo' || flow.role === 'systemAudio' ? flow.role : 'other',
      direction: SAFE_RTP_DIRECTIONS.has(flow.direction) ? flow.direction : 'other',
      rowCount: matches.length, rowState: matches.length === 1 ? 'present' : matches.length === 0 ? 'missing' : 'ambiguous',
      bytes: safeQualityNumeric(row?.bytes), packets: safeQualityNumeric(row?.packets),
      frames: safeQualityNumeric(row?.frames), width: safeQualityNumeric(row?.width), height: safeQualityNumeric(row?.height),
    };
  }) : null;
  return {
    stage: SAFE_STOP_BASELINE_STAGES.has(stage) ? stage : 'failed',
    failure: safeFailure, failedStep: SAFE_STOP_BASELINE_STEPS.has(failedStep) ? failedStep : 'none', videoFlows,
  };
}

function requireUniquePeer(pc, descriptions) {
  const pcSdps = new Set([pc.localDescription?.sdp, pc.remoteDescription?.sdp].filter(Boolean));
  const peerIds = new Set(descriptions.filter((item) => pcSdps.has(item.sdp)).map((item) => item.peerId).filter(Boolean));
  if (peerIds.size !== 1) throw new Error(`PC ${pc.id} has ${peerIds.size ? 'ambiguous' : 'no'} authenticated peer SDP correlation`);
  return [...peerIds][0];
}

export function correlateReceivedTracks({ pcs, received, descriptions, sinks, members }) {
  const results = [];
  for (const event of received) {
    if (!Number.isInteger(event.pcId) || !event.mid || !event.trackId || !event.kind || event.state !== 'live') throw new Error('received RTCTrackEvent is missing its PC, MID, live track ID, or kind');
    const pc = pcs.find((item) => item.id === event.pcId);
    if (!pc) throw new Error(`received track refers to missing PC ${event.pcId}`);
    const peerId = requireUniquePeer(pc, descriptions);
    const remoteRoles = new Set(descriptions
      .filter((item) => item.peerId === peerId && item.direction === 'incoming')
      .flatMap((item) => (item.tracks ?? []).filter((track) => track.mid === event.mid).map((track) => track.role)));
    if (remoteRoles.size !== 1) throw new Error(`received MID ${event.mid} has no unique authenticated remote role mapping`);
    const sinkMatches = sinks.filter((item) => item.trackId === event.trackId);
    if (!sinkMatches.length) throw new Error(`production sink is missing received track ${event.trackId}`);
    if (sinkMatches.length !== 1) throw new Error(`production sink correlation is ambiguous for ${event.trackId}`);
    const [sink] = sinkMatches;
    if (sink.peerId !== peerId) throw new Error(`production sink peer ${sink.peerId} does not match authenticated peer ${peerId}`);
    if (sink.role !== [...remoteRoles][0]) throw new Error(`production sink role does not match authenticated remote MID ${event.mid}`);
    const memberMatches = members.filter((item) => item.peerId === peerId);
    if (memberMatches.length !== 1) throw new Error(`authenticated room member is missing or ambiguous for ${peerId}`);
    if (AUDIO_ROLES.has(sink.role) !== (event.kind === 'audio') || (sink.role === 'screenVideo') !== (event.kind === 'video')) {
      throw new Error(`production sink role ${sink.role} does not match received ${event.kind} track`);
    }
    results.push({ pcId: event.pcId, peerId, peerRole: memberMatches[0].role, mid: event.mid, trackId: event.trackId, kind: event.kind, role: sink.role });
  }
  return results;
}
function keyOf(item) { return `${item.peerId}\u0000${item.role}\u0000${item.direction}`; }

export function verifyPerPairDeltas(before, after, required) {
  const results = [];
  for (const expected of required) {
    const key = keyOf(expected);
    const prior = before.filter((item) => keyOf(item) === key);
    const current = after.filter((item) => keyOf(item) === key);
    if (prior.length !== 1 || current.length !== 1) throw new Error(`${expected.peerId} ${expected.role} ${expected.direction} stats missing or ambiguous`);
    const bytes = current[0].bytes - prior[0].bytes;
    const packets = current[0].packets - prior[0].packets;
    if (!(bytes > 0 && packets > 0)) throw new Error(`${expected.peerId} ${expected.role} ${expected.direction} RTP delta is not positive`);
    results.push({ ...expected, bytes, packets });
  }
  return results;
}

export function publicDeltaRows(deltas, aliases) {
  return deltas.map((row) => {
    const alias = aliases.get(row.peerId);
    if (!alias) throw new Error('RTP peer has no authenticated public alias');
    return { alias, role: row.role, direction: row.direction, bytes: row.bytes, packets: row.packets };
  });
}

function uniqueStat(rows, expected, label) {
  const matches = rows.filter((row) => keyOf(row) === keyOf(expected));
  if (matches.length !== 1) throw new Error(`${expected.peerId} ${expected.role} ${expected.direction} ${label} row missing or ambiguous`);
  return matches[0];
}

export function verifyStoppedScreenEvidence({ before, settledBefore = before, after, voiceRequired, screenRequired, participantRole = 'host', senderTrackNull, capturedTracks, allowStatsRowsMissing = false, requireCaptureEnded = participantRole === 'host', receiverEvidence = new Map(), missingStatsEvidence = new Map() }) {
  if (participantRole !== 'host' && participantRole !== 'viewer') throw new Error('screen-stop participant role is required');
  if (!Array.isArray(screenRequired) || !screenRequired.length || screenRequired.some((row) => !['screenVideo', 'systemAudio'].includes(row.role))) {
    throw new Error('screen video and systemAudio flow expectations are required');
  }
  const voiceDeltas = verifyPerPairDeltas(settledBefore, after, voiceRequired);
  for (const expected of screenRequired) {
    const receiver = receiverEvidence.get(keyOf(expected));
    if (participantRole === 'viewer' && receiver?.mapped !== true) throw new Error(`${expected.role} ${expected.direction} actual inbound receiver is missing or ambiguous`);
    const prior = uniqueStat(before, expected, 'pre-stop');
    if (!(prior.bytes > 0 && prior.packets > 0) || (expected.role === 'screenVideo' && !(prior.frames > 0))) {
      throw new Error(`${expected.role} ${expected.direction} had no active pre-stop RTP/frame baseline`);
    }
    const current = after.filter((row) => keyOf(row) === keyOf(expected));
    if (current.length > 1) throw new Error(`${expected.role} ${expected.direction} post-stop RTP row is ambiguous`);
    if (current.length === 0 && !allowStatsRowsMissing && missingStatsEvidence.get(keyOf(expected)) !== true && !(participantRole === 'viewer' && (receiver?.muted === true || receiver?.ended === true))) throw new Error(`${expected.role} ${expected.direction} post-stop RTP row disappeared without receiver/capture-stop evidence`);
    if (expected.role === 'screenVideo' && current.length === 1 && !Number.isFinite(current[0].frames)) throw new Error(`${expected.role} ${expected.direction} post-stop frame count is missing`);
    if (current.length === 1) {
      const settled = uniqueStat(settledBefore, expected, 'settled post-stop');
      if (current[0].bytes !== settled.bytes || current[0].packets !== settled.packets || current[0].frames !== settled.frames) {
        throw new Error(`${expected.role} ${expected.direction} continued after screen stop`);
      }
    }
  }
  if (participantRole === 'host' && (senderTrackNull?.screenVideo !== true || senderTrackNull?.systemAudio !== true)) {
    throw new Error('screen video/systemAudio senders still have a track');
  }
  if (participantRole === 'host' && requireCaptureEnded) {
    const ended = new Set((capturedTracks ?? []).filter((track) => track.readyState === 'ended').map((track) => track.kind));
    if (!ended.has('video') || !ended.has('audio')) throw new Error('captured getDisplayMedia video/audio tracks are not both ended');
  }
  return { voiceDeltas, screenRequired: screenRequired.map((row) => ({ role: row.role, direction: row.direction })) };
}

export function verifyAutomaticResumeEvidence({ joins, losses, localSockets, members }) {
  const lossEvents = (losses ?? []).filter((item) => item.code === 'SIGNAL_CONNECTION_LOST' && item.retryable === true && Number.isFinite(item.observedAt));
  const loss = lossEvents.at(-1);
  if (!loss) throw new Error('retryable SIGNAL_CONNECTION_LOST event missing');
  const validJoins = (joins ?? []).filter((item) => item.peerId && item.resumeToken && Number.isFinite(item.observedAt) && item.socketId != null);
  const baseline = validJoins.filter((item) => item.observedAt < loss.observedAt).at(-1);
  if (!baseline) throw new Error('pre-fault room.joined baseline missing');
  if (loss.socketId !== baseline.socketId) throw new Error('bridge-loss event did not arrive on the current production local websocket');
  const resumed = validJoins.find((item) => item.observedAt > loss.observedAt);
  if (!resumed) throw new Error('post-loss automatic resume event missing');
  if (resumed.peerId !== baseline.peerId || resumed.resumeToken === baseline.resumeToken) {
    throw new Error('automatic resume did not preserve peer identity and rotate the resume token');
  }
  if (resumed.socketId !== baseline.socketId) throw new Error('automatic resume replaced the production local websocket');
  const openSockets = (localSockets ?? []).filter((socket) => socket.readyState === 1);
  if (openSockets.length !== 1 || openSockets[0].id !== baseline.socketId) {
    throw new Error('production local websocket is not still open after bridge resume');
  }
  const resumedRoster = Array.isArray(resumed.members) ? resumed.members : members ?? [];
  if (resumedRoster.filter((member) => member.peerId === resumed.peerId).length !== 1) {
    throw new Error('resumed peer seat is missing or duplicated');
  }
  const elapsedMs = resumed.observedAt - loss.observedAt;
  if (!(elapsedMs >= 0 && elapsedMs <= 20_000)) throw new Error('automatic resume exceeded 20 seconds or has invalid timing');
  return { peerIdentityPreserved: true, localSocketPreserved: true, tokenRotated: true, elapsedMs };
}

export function verifyQualityEvidence({ rows, expectedPeers, direction, uiText }) {
  const links = expectedPeers.map((peerId) => {
    const matches = (rows ?? []).filter((row) => row.peerId === peerId && row.role === 'screenVideo' && row.direction === direction);
    if (matches.length !== 1 || !(matches[0].frames > 0 && matches[0].width > 0 && matches[0].height > 0)) {
      throw new Error('every authenticated host-viewer link needs native frames and dimensions');
    }
    return matches[0];
  });
  if (!links.length || !links.some((row) => String(uiText).includes(`${row.width}×${row.height}`))) {
    throw new Error('actual stats UI does not match a native video link resolution');
  }
  return { links };
}
