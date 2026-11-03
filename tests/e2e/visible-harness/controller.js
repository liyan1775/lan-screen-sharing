import { activeRtpPeerConnections, activeRtpReceivedTracks, assertActiveMeshConnections, assertAudioSignaturesMatch, correlateReceivedTracks, expectedScreenFlows, installRtpStatsSamplers, mapPeerAliases, publicAudioCalibrationDiagnostics, publicAudioSignatureDiagnostics, publicDeltaRows, publicQualityDiagnostics, publicStopBaselineDiagnostics, signatureMatches, verifyAutomaticResumeEvidence, verifyPerPairDeltas, verifyQualityEvidence, verifyStoppedScreenEvidence, videoFrameProgressed } from './assertions.js';

const TESTS = [
  ['mesh', '1 · 三人轨道/MID映射与每对 RTP'],
  ['full', '2 · 满房拒绝与观众冒用主播操作拒绝'],
  ['denied', '3 · 麦克风拒绝后仍可接收'],
  ['stop', '4 · 停止屏幕后语音继续'],
  ['viewer-mesh', '5 · 两位观众语音双向 RTP'],
  ['resume', '6 · 主机桥接故障后自动恢复身份'],
  ['isolation', '7 · 合成设置仍标注未实机验证'],
  ['quality', '8 · 实际解码统计与可见画面一致'],
];

const safeRole = (role) => role === 'host' ? 'host' : 'viewer';
const pageState = () => window.__lanScreenTest;
const descriptions = () => [...pageState().sent, ...pageState().incoming]
  .filter((message) => message.type === 'rtc.description')
  .map((message) => ({ peerId: message.peerId, sdp: message.payload?.description?.sdp ?? '', tracks: message.payload?.tracks ?? [], direction: message.direction }));

function descMatches(pcId, state, all) {
  const local = state.localDescriptions.filter((item) => item.pcId === pcId).map((item) => item.sdp).filter(Boolean);
  const remote = state.remoteDescriptions.filter((item) => item.pcId === pcId).map((item) => item.sdp).filter(Boolean);
  return all.filter((item) => (item.direction === 'outgoing' ? local : remote).includes(item.sdp));
}

const SAFE_PROTOCOL_CODES = new Set([
  'AUTH_REQUIRED', 'HOST_ONLY', 'ROOM_NOT_FOUND', 'ROOM_EXPIRED', 'ROOM_FULL', 'INVALID_INVITE',
  'INVALID_HOST_ADDRESS', 'INVALID_PORT', 'SIGNAL_TARGET_NOT_MEMBER', 'MESSAGE_TOO_LARGE',
  'UNSUPPORTED_PROTOCOL', 'ICE_FAILED', 'MIC_PERMISSION_DENIED', 'CAPTURE_CANCELLED',
  'DISPLAY_NOT_MONITOR', 'SYSTEM_AUDIO_UNSUPPORTED', 'SYSTEM_AUDIO_UNVERIFIED', 'PORT_IN_USE',
  'SERVICE_START_FAILED', 'INVALID_ROLE', 'INVALID_MESSAGE', 'ROOM_ALREADY_JOINED', 'ROOM_EXISTS',
  'INVALID_SIGNAL_PATH', 'RATE_LIMITED', 'SIGNAL_CONNECTION_LOST',
]);
const SAFE_SIGNAL_TYPES = new Set([
  'auth.hello', 'heartbeat', 'host.createRoom', 'viewer.join', 'viewer.leave', 'host.endRoom',
  'rtc.description', 'rtc.candidate', 'media.state', 'signal.leave', 'signal.join',
]);
const SAFE_ROLES = new Set(['screenVideo', 'systemAudio', 'microphone']);
const safeRoleName = (value) => SAFE_ROLES.has(value) ? value : 'unknown';
const safeMID = (value) => /^\d{1,3}$/.test(String(value ?? '')) ? String(value) : 'other';
const safeKind = (value) => value === 'audio' || value === 'video' ? value : 'other';
const safeTrackState = (value) => value === 'live' || value === 'ended' ? value : 'other';
const safeDescriptionType = (value) => value === 'offer' || value === 'answer' ? value : value ? 'other' : 'none';

function aliasIndex({ role, alias, ownPeerId, members, viewerJoinOrder }) {
  try { return mapPeerAliases({ role, alias, ownPeerId, members, viewerJoinOrder }); }
  catch { return new Map(ownPeerId ? [[ownPeerId, alias]] : []); }
}

export function safeMediaDiagnostics({ role, alias, ownPeerId, members = [], viewerJoinOrder = [], state }) {
  const aliases = aliasIndex({ role, alias, ownPeerId, members, viewerJoinOrder });
  const all = [...(state.sent ?? []), ...(state.incoming ?? [])]
    .filter((message) => message.type === 'rtc.description')
    .map((message) => ({
      peerId: message.peerId, direction: message.direction,
      sdp: message.payload?.description?.sdp ?? '',
      descriptionType: safeDescriptionType(message.payload?.description?.type),
      tracks: Array.isArray(message.payload?.tracks) ? message.payload.tracks : [],
    }));
  return (state.pcs ?? []).map((pc, pcId) => {
    const matched = descMatches(pcId, state, all);
    const peers = [...new Set(matched.map((item) => item.peerId).filter(Boolean))];
    const localDescription = matched.find((item) => item.direction === 'outgoing');
    const remoteDescription = matched.find((item) => item.direction === 'incoming');
    const remoteRoles = new Map((remoteDescription?.tracks ?? []).map((item) => [String(item.mid), safeRoleName(item.role)]));
    let transceivers = [];
    try {
      transceivers = pc.getTransceivers().map((transceiver) => ({
        mid: safeMID(transceiver.mid), role: safeRoleName(transceiver.__trackRole),
        direction: ['sendrecv', 'sendonly', 'recvonly', 'inactive'].includes(transceiver.direction) ? transceiver.direction : 'unknown',
        senderTrackKind: transceiver.sender?.track ? safeKind(transceiver.sender.track.kind) : 'none',
        receiverTrackKind: transceiver.receiver?.track ? safeKind(transceiver.receiver.track.kind) : 'none',
        receiverReadyState: safeTrackState(transceiver.receiver?.track?.readyState),
        receiverMuted: transceiver.receiver?.track ? transceiver.receiver.track.muted === true : null,
      }));
    } catch { /* Keep a safe empty list if native transceiver inspection is unavailable. */ }
    const received = (state.received ?? []).filter((item) => item.pcId === pcId).map((item) => ({
      mid: safeMID(item.mid), role: remoteRoles.get(String(item.mid)) ?? 'unknown',
      kind: safeKind(item.kind), state: safeTrackState(item.state), muted: item.muted === true,
    }));
    return {
      alias, peerAlias: peers.length === 1 ? (aliases.get(peers[0]) ?? 'unmapped') : 'unmapped',
      pcState: ['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed'].includes(pc.connectionState) ? pc.connectionState : 'unknown',
      signalingState: ['stable', 'have-local-offer', 'have-remote-offer', 'have-local-pranswer', 'have-remote-pranswer', 'closed'].includes(pc.signalingState) ? pc.signalingState : 'unknown',
      iceState: ['new', 'checking', 'connected', 'completed', 'disconnected', 'failed', 'closed'].includes(pc.iceConnectionState) ? pc.iceConnectionState : 'unknown',
      localDescriptionType: localDescription?.descriptionType ?? 'none',
      remoteDescriptionType: remoteDescription?.descriptionType ?? 'none',
      localRoleMids: (localDescription?.tracks ?? []).map((item) => ({ mid: safeMID(item.mid), role: safeRoleName(item.role) })),
      remoteRoleMids: (remoteDescription?.tracks ?? []).map((item) => ({ mid: safeMID(item.mid), role: safeRoleName(item.role) })),
      transceivers, received,
    };
  });
}

export function safeProtocolDiagnostics({ role, alias, ownPeerId, members = [], viewerJoinOrder = [], state }) {
  const aliases = aliasIndex({ role, alias, ownPeerId, members, viewerJoinOrder });
  const sent = new Map((state.sent ?? []).filter((message) => message.requestId).map((message) => [message.requestId, message]));
  return (state.incoming ?? []).filter((message) => message.type === 'error').map((message) => {
    const request = message.requestId ? sent.get(message.requestId) : null;
    const code = SAFE_PROTOCOL_CODES.has(message.payload?.code) ? message.payload.code : 'OTHER';
    const target = request?.payload?.toPeerId ?? request?.peerId ?? '';
    const description = request?.payload?.description;
    const sdp = typeof description?.sdp === 'string' ? description.sdp : '';
    const candidate = request?.payload?.candidate;
    return {
      alias,
      requestType: SAFE_SIGNAL_TYPES.has(request?.type) ? request.type : 'other',
      targetAlias: target ? (aliases.get(target) ?? 'unmapped') : 'none',
      code, retryable: message.payload?.retryable === true,
      wireBytes: Number.isSafeInteger(request?.wireBytes) ? request.wireBytes : null,
      descriptionType: safeDescriptionType(description?.type),
      sdpBytes: sdp ? new TextEncoder().encode(sdp).length : 0,
      trackRoleCount: Array.isArray(request?.payload?.tracks) ? request.payload.tracks.length : 0,
      candidateFieldsPresent: candidate && typeof candidate === 'object'
        ? ['candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment'].filter((key) => Object.hasOwn(candidate, key)).length
        : 0,
    };
  });
}

export function classifyHarnessFailure(error) {
  const message = String(error?.message ?? '');
  const rules = [
    [/^received RTCTrackEvent is missing/, 'track_event_incomplete'],
    [/^received track refers to missing PC/, 'track_pc_missing'],
    [/^PC \d+ has no authenticated peer SDP correlation$/, 'peer_sdp_missing'],
    [/^PC \d+ has ambiguous authenticated peer SDP correlation\b/, 'peer_sdp_ambiguous'],
    [/^received MID .* has no unique authenticated remote role mapping$/, 'mid_role_missing_or_ambiguous'],
    [/^production sink is missing received track/, 'production_sink_missing'],
    [/^production sink correlation is ambiguous/, 'production_sink_ambiguous'],
    [/^production sink peer .* does not match authenticated peer/, 'production_sink_peer_mismatch'],
    [/^production sink role does not match authenticated remote MID/, 'production_sink_role_mismatch'],
    [/^authenticated room member is missing or ambiguous/, 'authenticated_member_missing_or_ambiguous'],
    [/^production sink role .* does not match received/, 'production_sink_kind_mismatch'],
    [/^an authenticated peer is missing a required production sink role$/, 'expected_track_role_missing'],
    [/^an authenticated peer is missing or ambiguous/, 'expected_track_role_ambiguous'],
    [/^own authenticated member missing$/, 'own_authenticated_member_missing'],
    [/^mesh PC count incomplete$/, 'mesh_pc_count_incomplete'],
    [/^received role not expected from authenticated peer role$/, 'received_role_unexpected_for_peer'],
    [/^host must receive only viewer microphones$/, 'host_received_role_invalid'],
    [/^viewer is missing host screen\/system audio or microphone$/, 'viewer_host_role_missing'],
    [/^a native mesh PC is not connected$/, 'native_pc_not_connected'],
    [/^RTP baseline not saved$/, 'rtp_baseline_missing'],
    [/^.+ stats missing or ambiguous$/, 'rtp_row_missing_or_ambiguous'],
    [/^.+ RTP delta is not positive$/, 'rtp_delta_not_positive'],
    [/^decoded production sink PCM signature/, 'pcm_signature_mismatch'],
    [/^production audio element capture/, 'pcm_capture_unavailable'],
    [/^decoded screen frame\/dimensions\/content missing$/, 'screen_frame_missing'],
    [/^production audio sink is not routed/, 'production_sink_not_silent'],
    [/^latest native production audio play/, 'production_audio_playback_not_advancing'],
    [/ continued after screen stop$/, 'screen_flow_continued_after_stop'],
    [/ actual inbound receiver is missing or ambiguous$/, 'screen_stop_receiver_missing'],
    [/ post-stop RTP row disappeared/, 'screen_stop_stats_disappeared'],
    [/senders still have a track$/, 'screen_stop_sender_attached'],
    [/getDisplayMedia video\/audio tracks are not both ended$/, 'screen_stop_capture_live'],
    [/^every authenticated host-viewer link needs native frames/, 'video_link_frames_missing'],
    [/^actual stats UI does not match/, 'actual_stats_ui_mismatch'],
    [/^external resource observed$/, 'external_resource_observed'],
  ];
  return rules.find(([pattern]) => pattern.test(message))?.[1] ?? 'assertion_unclassified';
}

async function waitForExpectedReceivedTracks(state, role, alias, timeoutMs = 8000) {
  const expected = () => {
    const own = ownPeerId();
    const members = authenticatedMembers();
    if (!own || !members.length) return false;
    const input = correlationInput();
    const tracks = input.received;
    const mapped = [];
    for (const event of tracks) {
      const pc = input.pcs.find((item) => item.id === event.pcId);
      if (!pc) continue;
      const descriptionsForPC = descMatches(event.pcId, state, input.all);
      const peerIDs = new Set(descriptionsForPC.map((item) => item.peerId).filter(Boolean));
      if (peerIDs.size !== 1) continue;
      const [peerId] = peerIDs;
      const remote = descriptionsForPC.find((item) => item.direction === 'incoming');
      const roleForMid = remote?.tracks?.find((item) => String(item.mid) === String(event.mid))?.role;
      if (roleForMid) mapped.push({ peerId, role: roleForMid });
    }
    for (const member of members.filter((item) => item.peerId !== own)) {
      const required = member.role === 'host' ? ['screenVideo', 'systemAudio', 'microphone'] : ['microphone'];
      if (required.some((requiredRole) => !mapped.some((item) => item.peerId === member.peerId && item.role === requiredRole))) return false;
    }
    return true;
  };
  const deadline = performance.now() + timeoutMs;
  while (!expected() && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  return expected();
}

export function latestAuthenticatedMembers(messages) {
  let members = [];
  let haveSnapshot = false;
  for (const message of messages ?? []) {
    if (message.type === 'room.created' && typeof message.peerId === 'string' && message.peerId) {
      members = [{ peerId: message.peerId, role: 'host', state: 'connected' }];
      haveSnapshot = true;
      continue;
    }
    if (message.type === 'room.joined' && Array.isArray(message.payload?.members)) {
      members = message.payload.members.map((member) => ({ ...member }));
      haveSnapshot = true;
      continue;
    }
    if (message.type === 'room.ended') {
      members = [];
      haveSnapshot = false;
      continue;
    }
    if (message.type === 'room.state' && haveSnapshot && Array.isArray(message.payload?.members)) {
      members = message.payload.members.map((member) => ({ ...member }));
      continue;
    }
    if (!haveSnapshot) continue;
    if (message.type === 'peer.left' && typeof message.payload?.peerId === 'string') {
      members = members.filter((member) => member.peerId !== message.payload.peerId);
    }
    if (message.type === 'peer.joined' && typeof message.peerId === 'string' && message.peerId) {
      const joined = { peerId: message.peerId, role: message.payload?.role === 'host' ? 'host' : 'viewer', state: 'connected' };
      members = [...members.filter((member) => member.peerId !== joined.peerId), joined];
    }
  }
  return members;
}

function authenticatedMembers() {
  return latestAuthenticatedMembers(pageState().incoming);
}

function authenticatedViewerJoinOrder() {
  return [...new Set(pageState().incoming
    .filter((message) => message.type === 'peer.joined' && message.payload?.role === 'viewer')
    .map((message) => message.peerId)
    .filter(Boolean))];
}

function ownPeerId() {
  const messages = [...pageState().incoming, ...pageState().sent];
  const joined = messages.filter((message) => message.type === 'room.joined').at(-1);
  if (joined?.peerId) return joined.peerId;
  return messages.filter((message) => message.type === 'room.created').at(-1)?.peerId ?? '';
}

function currentPeerAliases(role, alias, state) {
  const map = mapPeerAliases({
    role, alias, ownPeerId: ownPeerId(), members: authenticatedMembers(),
    viewerJoinOrder: authenticatedViewerJoinOrder(), previousAliases: state.viewerAliasAssignments ?? new Map(),
  });
  if (role === 'host') state.viewerAliasAssignments = new Map([...map].filter(([, value]) => value === 'viewer-1' || value === 'viewer-2'));
  return map;
}

function productionSinks() {
  const sinks = [];
  for (const audio of document.querySelectorAll('audio[data-source-peer-id][data-track-role]')) {
    for (const track of audio.srcObject?.getTracks?.() ?? []) sinks.push({ trackId: track.id, peerId: audio.dataset.sourcePeerId, role: audio.dataset.trackRole });
  }
  const screen = document.querySelector('#remote-screen');
  const hostPeerId = authenticatedMembers().find((member) => member.role === 'host')?.peerId ?? '';
  for (const track of screen?.srcObject?.getTracks?.() ?? []) sinks.push({ trackId: track.id, peerId: hostPeerId, role: 'screenVideo' });
  return sinks;
}

function correlationInput() {
  const state = pageState();
  const all = descriptions();
  const activePCs = activeRtpPeerConnections(state.pcs);
  const pcs = activePCs.map(({ pcId }) => ({
    id: pcId,
    localDescription: { sdp: state.localDescriptions.filter((item) => item.pcId === pcId).at(-1)?.sdp ?? '' },
    remoteDescription: { sdp: state.remoteDescriptions.filter((item) => item.pcId === pcId).at(-1)?.sdp ?? '' },
  }));
  return { state, all, pcs, members: authenticatedMembers(), received: activeRtpReceivedTracks(state.pcs, state.received) };
}

export function collectActualRTP() {
  const { state, all, pcs, members } = correlationInput();
  const aggregated = new Map();
  for (const { pc, pcId } of activeRtpPeerConnections(state.pcs)) {
    const pcDescriptions = descMatches(pcId, state, all);
    const peerIds = new Set(pcDescriptions.map((item) => item.peerId).filter(Boolean));
    if (peerIds.size !== 1) throw new Error(`PC${pcId} authenticated SDP peer ambiguous`);
    const [peerId] = peerIds;
    for (const report of (awaitStats(pc))) {
      if (report.type !== 'inbound-rtp' && report.type !== 'outbound-rtp') continue;
      if (report.mid == null) throw new Error(`PC${pcId} RTP report has no MID`);
      const descriptionDirection = report.type === 'outbound-rtp' ? 'outgoing' : 'incoming';
      const source = pcDescriptions.find((item) => item.direction === descriptionDirection && item.tracks.some((track) => track.mid === report.mid));
      const role = source?.tracks.find((track) => track.mid === report.mid)?.role;
      if (!role) throw new Error(`PC${pcId} MID ${report.mid} lacks negotiated role mapping`);
      const direction = report.type === 'outbound-rtp' ? 'outbound' : 'inbound';
      const key = `${peerId}\u0000${role}\u0000${direction}`;
      const row = aggregated.get(key) ?? { peerId, role, direction, bytes: 0, packets: 0, frames: 0, width: 0, height: 0, audioLevel: 0, pcId };
      row.bytes += report.bytesSent ?? report.bytesReceived ?? 0;
      row.packets += report.packetsSent ?? report.packetsReceived ?? 0;
      row.frames += report.framesEncoded ?? report.framesDecoded ?? report.framesSent ?? report.framesReceived ?? 0;
      row.width = Math.max(row.width, report.frameWidth ?? 0);
      row.height = Math.max(row.height, report.frameHeight ?? 0);
      row.audioLevel = Math.max(row.audioLevel, report.audioLevel ?? 0);
      aggregated.set(key, row);
    }
  }
  const rows = [...aggregated.values()];
  for (const row of rows) {
    if (!members.some((member) => member.peerId === row.peerId)) throw new Error(`RTP peer ${row.peerId} is absent from authenticated room roster`);
  }
  return rows;
}

// Wrapper avoids exposing browser-native getStats results as serializable state.
function awaitStats(pc) {
  return pc.__lanScreenHarnessReports ?? [];
}

function installStatsSampler() {
  const state = pageState();
  installRtpStatsSamplers(state.pcs);
}

function statsBaseline() { return pageState().lastRTPBaseline ?? []; }

function expectedVoiceFlows(members) {
  const own = ownPeerId();
  return members.filter((member) => member.peerId !== own).flatMap((member) => [
    { peerId: member.peerId, role: 'microphone', direction: 'inbound' },
    { peerId: member.peerId, role: 'microphone', direction: 'outbound' },
  ]);
}

function localScreenSenderTrackNull() {
  const roles = new Set(); const active = new Set();
  for (const { pc } of activeRtpPeerConnections(pageState().pcs)) for (const transceiver of pc.getTransceivers()) {
    if (transceiver.__trackRole !== 'screenVideo' && transceiver.__trackRole !== 'systemAudio') continue;
    roles.add(transceiver.__trackRole);
    if (transceiver.sender.track !== null) active.add(transceiver.__trackRole);
  }
  return { screenVideo: roles.has('screenVideo') && !active.has('screenVideo'), systemAudio: roles.has('systemAudio') && !active.has('systemAudio') };
}

function capturedDisplayTracks() {
  return pageState().captures.filter((capture) => capture.type === 'display').flatMap((capture) => capture.tracks ?? []);
}

export function receiverStopEvidence(screenFlows, state = pageState()) {
  return new Map(screenFlows.map((flow) => {
    const mappings = (state.mappedTracks ?? []).filter((item) => item.peerId === flow.peerId && item.role === flow.role);
    const receivedMatches = mappings.length === 1 ? state.received.filter((item) => item.trackId === mappings[0].trackId) : [];
    const received = receivedMatches.length === 1 ? receivedMatches[0] : null;
    const track = received?.track;
    return [`${flow.peerId}\u0000${flow.role}\u0000${flow.direction}`, {
      mapped: !!received,
      muted: !!received && (track?.muted === true || received.muted === true),
      ended: !!received && (track?.readyState === 'ended' || received.state === 'ended'),
    }];
  }));
}

function nextPresentedVideoFrame(video, deadline) {
  if (typeof video?.requestVideoFrameCallback !== 'function') return Promise.resolve(null);
  const remaining = Math.max(0, deadline - performance.now());
  if (!remaining) return Promise.resolve(null);
  return new Promise((resolve) => {
    let callbackId = null;
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      if (callbackId != null) video.cancelVideoFrameCallback?.(callbackId);
      resolve(null);
    }, remaining);
    callbackId = video.requestVideoFrameCallback((_now, metadata) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve(Number.isFinite(metadata?.presentedFrames) && Number.isFinite(metadata?.mediaTime)
        ? { presentedFrames: metadata.presentedFrames, mediaTime: metadata.mediaTime }
        : null);
    });
  });
}

async function visibleFrameEvidence() {
  const video = document.querySelector('#role-label')?.textContent === '主播'
    ? document.querySelector('#local-preview')
    : document.querySelector('#remote-screen');
  if (!video) return { ok: false, readyState: null, width: null, height: null, varied: false, variedPixelsDelta: null, presentedFrameProgressed: false };
  const readyState = video.readyState;
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (readyState < HTMLMediaElement.HAVE_CURRENT_DATA || width < 1 || height < 1) return { ok: false, readyState, width, height, varied: false, variedPixelsDelta: null, presentedFrameProgressed: false };
  const deadline = performance.now() + 5000;
  const firstPresentedFrame = await nextPresentedVideoFrame(video, deadline);
  if (!firstPresentedFrame) return { ok: false, readyState, width, height, varied: false, variedPixelsDelta: null, presentedFrameProgressed: false };
  const canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 8;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(video, 0, 0, 8, 8);
  const first = context.getImageData(0, 0, 8, 8).data.slice();
  let nextFrame = null;
  while (performance.now() < deadline) {
    nextFrame = await nextPresentedVideoFrame(video, deadline);
    if (!nextFrame) break;
    if (videoFrameProgressed(firstPresentedFrame, nextFrame)) break;
  }
  const presentedFrameProgressed = videoFrameProgressed(firstPresentedFrame, nextFrame);
  if (!presentedFrameProgressed) return { ok: false, readyState, width, height, varied: false, variedPixelsDelta: null, presentedFrameProgressed: false };
  context.drawImage(video, 0, 0, 8, 8);
  const next = context.getImageData(0, 0, 8, 8).data;
  let difference = 0;
  for (let i = 0; i < first.length; i += 4) difference += Math.abs(first[i] - next[i]) + Math.abs(first[i + 1] - next[i + 1]) + Math.abs(first[i + 2] - next[i + 2]);
  return { ok: true, readyState, width, height, varied: difference > 12, variedPixelsDelta: difference, presentedFrameProgressed };
}

async function decodedAudioSignatures(tracks, aliases, silentOutput) {
  const results = [];
  for (const item of tracks.filter((track) => track.kind === 'audio')) {
    const element = [...document.querySelectorAll('audio[data-source-peer-id][data-track-role]')]
      .find((audio) => audio.dataset.sourcePeerId === item.peerId && audio.dataset.trackRole === item.role && audio.srcObject?.getTracks?.().some((track) => track.id === item.trackId));
    if (!element) throw new Error('production audio sink missing for the mapped track');
    const playback = silentOutput.snapshot(element);
    if (!playback || playback.outputGain !== 0 || playback.contextState !== 'running') throw new Error('production audio sink is not routed through the zero-gain native graph');
    if (playback.nativePlayCalls < 1 || playback.lastPlayState !== 'resolved' || !playback.playing || playback.paused || !(playback.currentTime > 0)) throw new Error('latest native production audio play did not resolve and advance');
    const sample = await silentOutput.sampleCapturedElement(element);
    const bins = sample.bins;
    let peak = -Infinity, peakBin = 0;
    for (let i = 1; i < bins.length; i += 1) if (bins[i] > peak) { peak = bins[i]; peakBin = i; }
    results.push({ trackId: item.trackId, peerId: item.peerId, role: item.role, alias: aliases.get(item.peerId) ?? '', hz: Math.round(peakBin * sample.sampleRate / sample.fftSize), peakDb: peak, sampleRate: sample.sampleRate, fftSize: sample.fftSize, contextState: sample.contextState, signal: Number.isFinite(peak) && peak > -100, nativePlayResolved: playback.nativePlayResolved, playing: playback.playing, currentTime: playback.currentTime, outputGain: playback.outputGain, mediaMuted: playback.mediaMuted, mediaVolume: playback.mediaVolume });
  }
  return results;
}

function safeResult(target, pass, message) {
  target.dataset.state = pass ? 'PASS' : 'FAIL';
  target.textContent = `${pass ? 'PASS' : 'FAIL'} · ${message}`;
}

function assertLocalRuntimeHealthy() {
  const network = pageState().network;
  if (network.externalResources !== 0) throw new Error('external resource observed');
  if (network.pageErrors || network.unhandledRejections || network.policyViolations || network.httpErrors || network.wsErrors) throw new Error('page/runtime/network diagnostic counter is nonzero');
}

function addButton(parent, label, action) {
  const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
  button.style.cssText = 'padding:6px 10px;border:1px solid #8290a2;border-radius:5px;background:#fff;cursor:pointer';
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    try { await action(); } finally { button.disabled = false; }
  });
  parent.append(button); return button;
}

function addCaseRow(list, id, title) {
  const li = document.createElement('li'); li.dataset.testCase = id; li.style.cssText = 'margin:3px 0;font-size:12px';
  const result = document.createElement('span'); result.id = `visible-case-${id}`; result.dataset.state = 'NOT RUN'; result.textContent = `NOT RUN · ${title}`;
  li.append(result); list.append(li); return result;
}

function addNestedCaseRow(parent, id, title) {
  let nested = parent.closest('li').querySelector(':scope > ul');
  if (!nested) {
    nested = document.createElement('ul'); nested.style.cssText = 'padding-left:20px;margin:2px 0';
    parent.closest('li').append(nested);
  }
  return addCaseRow(nested, id, title);
}

function updateCompositeCase(parent, subresults) {
  const states = Object.values(subresults).map((item) => item.dataset.state);
  if (states.includes('FAIL')) safeResult(parent, false, '一个或多个独立子检查失败');
  else if (states.every((state) => state === 'PASS')) safeResult(parent, true, 'track/sink/PCM 与 RTP 子检查均通过');
  else {
    parent.dataset.state = states.includes('RUNNING') ? 'RUNNING' : 'NOT RUN';
    parent.textContent = `${parent.dataset.state} · track/sink/PCM 与 RTP 子检查均需完成`;
  }
}

export async function installVisibleHarness({ role, alias, denyMic = false, silentOutput } = {}) {
  const state = pageState();
  if (!state) throw new Error('Synthetic adapter was not installed before the product app.');
  const parsedRole = safeRole(role);
  const hostChoice = document.querySelector('#choose-host');
  const viewerChoice = document.querySelector('#choose-viewer');
  if (hostChoice) hostChoice.disabled = parsedRole !== 'host';
  if (viewerChoice) viewerChoice.disabled = parsedRole !== 'viewer';
  const params = new URLSearchParams(location.search);
  const localBootstrap = await fetch('/api/v1/bootstrap').then((response) => response.ok ? response.json() : null).catch(() => null);
  const panel = document.createElement('aside'); panel.id = 'visible-media-harness'; panel.setAttribute('aria-label', '合成媒体浏览器验证面板');
  panel.style.cssText = 'position:fixed;z-index:10000;right:8px;bottom:8px;width:min(620px,48vw);max-height:70vh;overflow:auto;padding:10px;background:#f3f6fa;border:2px solid #32465f;border-radius:8px;box-shadow:0 3px 14px #0004;color:#182333;font:13px/1.35 system-ui,sans-serif';
  const heading = document.createElement('strong'); heading.textContent = `测试 harness · ${alias} · ${parsedRole}${denyMic || params.get('deny-mic') === '1' ? ' · 麦克风拒绝' : ''} · 合成媒体/非实机验证`;
  const warning = document.createElement('p'); warning.textContent = '所有本页 audio/video sink 均经原生 WebAudio 零增益输出；仍执行原生 play 并检查解码/播放状态。不会采集真实设备，也不代表物理听感、音频隔离或性能验收。';
  const denyLabel = document.createElement('label'); denyLabel.style.cssText = 'display:block;margin:5px 0';
  const denyToggle = document.createElement('input'); denyToggle.type = 'checkbox'; denyToggle.checked = !!state.denyMicrophone;
  denyToggle.addEventListener('change', () => { state.denyMicrophone = denyToggle.checked; });
  denyLabel.append(denyToggle, document.createTextNode(' 模拟拒绝麦克风（仅影响后续采集请求）'));
  const list = document.createElement('ol'); list.style.cssText = 'padding-left:20px';
  const results = Object.fromEntries(TESTS.map(([id, title]) => [id, addCaseRow(list, id, title)]));
  const meshSubresults = Object.fromEntries([
    ['tracks', 'track/MID/认证 peer/生产 sink'],
    ['pcm', '生产 sink 原生播放/PCM 音签/静音路由'],
    ['rtp', '逐 alias/role/direction RTP delta'],
  ].map(([key, title]) => [key, addNestedCaseRow(results.mesh, `mesh-${key}`, title)]));
  const seatRejoinResult = addCaseRow(list, 'seat-rejoin', '2b · 普通离房/重加入后旧 peer 清理与别名稳定');
  results['seat-rejoin'] = seatRejoinResult;
  const controls = document.createElement('div'); controls.style.cssText = 'display:flex;gap:5px;flex-wrap:wrap;margin:8px 0';
  const evidence = document.createElement('pre'); evidence.id = 'visible-evidence'; evidence.setAttribute('aria-label', '安全合成媒体计数'); evidence.style.cssText = 'white-space:pre-wrap;margin:4px 0;padding:6px;background:#fff;max-height:110px;overflow:auto';
  panel.append(heading, warning, denyLabel, controls, list, evidence); document.body.append(panel);

  const run = async (id, operation, subkey = '') => {
    const result = subkey ? meshSubresults[subkey] : results[id];
    result.dataset.state = 'RUNNING'; result.textContent = `运行中 · ${result.id}`;
    try { safeResult(result, true, await operation()); }
    catch (error) {
      const reason = error?.name === 'NotAllowedError' ? 'synthetic_permission_denied' : classifyHarnessFailure(error);
      safeResult(result, false, `ASSERTION_FAILED · ${id} · ${reason}`);
      updateEvidence({ lastSafeFailure: { case: id, reason } });
    }
    if (subkey) updateCompositeCase(results[id], meshSubresults);
    updateEvidence();
  };

  async function safeStats() {
    installStatsSampler();
    await Promise.all(activeRtpPeerConnections(state.pcs).map(({ pc }) => pc.getStats()));
    return collectActualRTP();
  }

  function updateEvidence(extra = {}) {
    let aliases = new Map();
    try { aliases = currentPeerAliases(parsedRole, alias, state); } catch { /* no authenticated room yet */ }
    const audioSinks = [...document.querySelectorAll('audio[data-source-peer-id][data-track-role]')].map((element) => {
      const playback = silentOutput?.snapshot(element);
      return { alias: aliases.get(element.dataset.sourcePeerId) ?? 'unknown', role: safeRoleName(element.dataset.trackRole), direction: 'inbound', nativePlayCalls: playback?.nativePlayCalls ?? 0, successfulPlayCalls: playback?.successfulPlayCalls ?? 0, rejectedPlayCalls: playback?.rejectedPlayCalls ?? 0, latestPlayState: ['not-called', 'resolved', 'rejected'].includes(playback?.lastPlayState) ? playback.lastPlayState : 'unknown', playing: playback?.playing === true, paused: playback?.paused === true, currentTime: Number.isFinite(playback?.currentTime) ? Math.round(playback.currentTime * 100) / 100 : null, outputGain: Number.isFinite(playback?.outputGain) ? playback.outputGain : null, muted: typeof playback?.mediaMuted === 'boolean' ? playback.mediaMuted : null, volume: Number.isFinite(playback?.mediaVolume) ? Math.round(playback.mediaVolume * 1000) / 1000 : null };
    });
    const counts = {
      pcs: state.pcs.length, receivedTracks: state.received.filter((item) => item.state === 'live').length,
      activeMembers: authenticatedMembers().length, receivedVideoTracks: state.received.filter((item) => item.kind === 'video' && item.state === 'live').length,
      syntheticMicDenied: !!state.denyMicrophone, pageErrors: state.network.pageErrors,
      unhandledRejections: state.network.unhandledRejections, httpErrors: state.network.httpErrors,
      websocketErrors: state.network.wsErrors, externalResources: state.network.externalResources,
      websocketCloseCount: state.network.wsCloses.length,
      websocketCloseCodes: [...new Set(state.network.wsCloses.map((item) => item.code))].join(','),
      capturedBridges: state.bridgeCloseCount ?? 0,
      silentOutputPrepared: !!state.silentOutputPrepared,
      everyMediaSinkRoutedAtZeroGain: !!silentOutput?.auditSinks(),
      mediaSinkCount: silentOutput?.sinkCount ?? 0,
      pcmMeasurementMethod: 'HTMLMediaElement.captureStream + native FFT',
      productionAudioPlayback: audioSinks,
      audioSignatureDiagnostics: publicAudioSignatureDiagnostics(state.audioSignatures, {
        sourceContexts: state.sources.map((source) => ({
          alias, role: source.label, contextState: source.audio?.state,
          trackState: source.track?.readyState, trackEnabled: source.track?.enabled, trackMuted: source.track?.muted,
        })),
      }),
      nativeAudioCalibration: publicAudioCalibrationDiagnostics(state.nativeAudioCalibration),
      stopBaselineDiagnostics: publicStopBaselineDiagnostics(state.stopBaselineDiagnostic),
      qualityDiagnostics: publicQualityDiagnostics(state.qualityDiagnostics),
      peerRoleDirectionRTPDeltas: state.publicRTPRows ?? [],
      protocolErrorDiagnostics: safeProtocolDiagnostics({ role: parsedRole, alias, ownPeerId: ownPeerId(), members: authenticatedMembers(), viewerJoinOrder: authenticatedViewerJoinOrder(), state }),
      nativeMediaDiagnostics: safeMediaDiagnostics({ role: parsedRole, alias, ownPeerId: ownPeerId(), members: authenticatedMembers(), viewerJoinOrder: authenticatedViewerJoinOrder(), state }),
      ...extra,
    };
    evidence.textContent = Object.entries(counts).map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`).join('\n');
  }

  addButton(controls, '准备本页静音原生播放测量', async () => {
    const contextRunning = await silentOutput?.prepareFromUserGesture();
    state.silentOutputPrepared = contextRunning === true && !!silentOutput && silentOutput.auditSinks();
    updateEvidence();
    if (!state.silentOutputPrepared) throw new Error('one or more production media sinks bypassed the zero-gain graph');
  });
  addButton(controls, '校准本页静音音频测量链', async () => {
    try { state.nativeAudioCalibration = await silentOutput?.calibrateNativeTone(); }
    catch { state.nativeAudioCalibration = { available: false }; }
    updateEvidence();
  });
  addButton(controls, '记录当前 RTP 基线', async () => {
    try { state.lastRTPBaseline = await safeStats(); updateEvidence({ rtpBaselineRows: state.lastRTPBaseline.length }); }
    catch { updateEvidence({ rtpBaseline: '不可用' }); }
  });
  addButton(controls, '检查 track/MID/peer/生产 sink', () => run('mesh', async () => {
    assertLocalRuntimeHealthy();
    await waitForExpectedReceivedTracks(state, parsedRole, alias);
    if (!silentOutput?.auditSinks()) throw new Error('a production audio/video element bypassed the zero-gain graph');
    const input = correlationInput();
    const tracks = correlateReceivedTracks({ pcs: input.pcs, received: input.received, descriptions: input.all, sinks: productionSinks(), members: input.members });
    const own = ownPeerId();
    if (!own || !input.members.some((member) => member.peerId === own)) throw new Error('own authenticated member missing');
    const aliases = currentPeerAliases(parsedRole, alias, state);
    const expectedPeerCount = Math.max(0, input.members.length - 1);
    assertActiveMeshConnections(state.pcs, expectedPeerCount);
    for (const member of input.members.filter((item) => item.peerId !== own)) {
      const roles = new Set(tracks.filter((item) => item.peerId === member.peerId).map((item) => item.role));
      const expectedRoles = member.role === 'host' ? ['screenVideo', 'systemAudio', 'microphone'] : ['microphone'];
      if (expectedRoles.some((role) => !roles.has(role))) throw new Error('an authenticated peer is missing a required production sink role');
      for (const role of roles) if (!expectedRoles.includes(role)) throw new Error('received role not expected from authenticated peer role');
    }
    if (parsedRole === 'host') {
      if (tracks.some((item) => item.role !== 'microphone') || !tracks.some((item) => item.role === 'microphone')) throw new Error('host must receive only viewer microphones');
    } else if (!tracks.some((item) => item.role === 'screenVideo') || !tracks.some((item) => item.role === 'systemAudio') || !tracks.some((item) => item.role === 'microphone')) {
      throw new Error('viewer is missing host screen/system audio or microphone');
    }
    state.mappedTracks = tracks; state.trackAliases = aliases;
    if (!state.initialMembers) {
      state.initialOwnPeerId = own;
      state.initialMembers = input.members.map((member) => ({ peerId: member.peerId, role: member.role }));
      state.initialAliasAssignments = new Map(aliases);
    }
    updateEvidence({ mappedTracks: tracks.length, distinctAuthenticatedPeers: new Set(tracks.map((item) => item.peerId)).size });
    return `${tracks.length} 个实收 track 的 MID、认证成员和生产 sink 唯一匹配`;
  }, 'tracks'));
  addButton(controls, '检查生产 sink 原生播放与PCM音签', () => run('mesh', async () => {
    if (!state.mappedTracks?.length || !state.trackAliases) throw new Error('track/MID/sink mapping must pass first');
    if (!state.silentOutputPrepared || !silentOutput?.auditSinks()) throw new Error('zero-gain sink graph was not prepared and audited');
    const signature = await decodedAudioSignatures(state.mappedTracks, state.trackAliases, silentOutput);
    const matchedSignatures = signature.map((item) => ({ ...item, matches: signatureMatches({ ...item, aliases: state.trackAliases }) }));
    state.audioSignatures = matchedSignatures;
    updateEvidence();
    assertAudioSignaturesMatch(matchedSignatures);
    return `${matchedSignatures.length} 个真实生产 audio sink 原生播放已推进；元素 captureStream 音签匹配认证别名；零增益静音`;
  }, 'pcm'));
  addButton(controls, '检查逐 peer/role RTP 增量', () => run('mesh', async () => {
    assertLocalRuntimeHealthy();
    await new Promise((resolve) => setTimeout(resolve, 800));
    const current = await safeStats();
    if (!statsBaseline().length) throw new Error('RTP baseline not saved');
    const members = authenticatedMembers(); const own = ownPeerId();
    const required = [];
    for (const member of members.filter((item) => item.peerId !== own)) {
      required.push({ peerId: member.peerId, role: 'microphone', direction: 'inbound' }, { peerId: member.peerId, role: 'microphone', direction: 'outbound' });
      if (parsedRole === 'host' && member.role === 'viewer') required.push({ peerId: member.peerId, role: 'screenVideo', direction: 'outbound' }, { peerId: member.peerId, role: 'systemAudio', direction: 'outbound' });
      if (parsedRole === 'viewer' && member.role === 'host') required.push({ peerId: member.peerId, role: 'screenVideo', direction: 'inbound' }, { peerId: member.peerId, role: 'systemAudio', direction: 'inbound' });
    }
    const deltas = verifyPerPairDeltas(statsBaseline(), current, required);
    state.lastRTPCheck = current;
    const aliases = currentPeerAliases(parsedRole, alias, state);
    state.publicRTPRows = publicDeltaRows(deltas, aliases);
    updateEvidence({ peerRoleDirectionRTPDeltas: state.publicRTPRows });
    return `${deltas.length} 个认证 peer 的 role/direction 都有正 packets 与 bytes delta`;
  }, 'rtp'));
  addButton(controls, '设定屏幕停止基线', async () => {
    state.stopBaseline = null;
    state.stopBaselineDiagnostic = { stage: 'stats', failure: 'none' };
    updateEvidence();
    let rows;
    try { rows = await safeStats(); }
    catch {
      state.stopBaselineDiagnostic = { stage: 'failed', failure: 'collection_failed' };
      updateEvidence();
      return;
    }
    state.stopBaseline = rows;
    const failProjection = (failedStep) => {
      state.stopBaselineDiagnostic = { stage: 'failed', failure: 'projection_failed', failedStep, rows, aliases: new Map() };
      updateEvidence();
    };
    let members;
    try { members = authenticatedMembers(); }
    catch { failProjection('authenticated_members'); return; }
    let expected;
    try { expected = expectedScreenFlows(members, parsedRole); }
    catch { failProjection('expected_screen_flows'); return; }
    state.stopBaselineDiagnostic = { stage: 'projection', failure: 'none', failedStep: 'none', expected, rows, aliases: new Map() };
    updateEvidence();
    let aliases;
    try { aliases = currentPeerAliases(parsedRole, alias, state); }
    catch { failProjection('peer_aliases'); return; }
    state.stopBaselineDiagnostic = { stage: 'saved', failure: 'none', failedStep: 'none', expected, rows, aliases };
    updateEvidence({ stopBaselineRows: rows.length });
  });
  addButton(controls, '检查停止屏幕后语音', () => run('stop', async () => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // The pre-stop baseline proves those sources were active. Packets sent
    // between that UI action and stopping are valid; measure cessation over a
    // separate settled post-stop window, with a strict zero-delta requirement.
    const settledBefore = await safeStats();
    const stopWindowStart = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const current = await safeStats();
    const stopWindowMs = performance.now() - stopWindowStart;
    const required = expectedVoiceFlows(authenticatedMembers());
    if (!state.stopBaseline?.length) throw new Error('stop baseline missing');
    const screenRequired = expectedScreenFlows(authenticatedMembers(), parsedRole);
    if (parsedRole === 'host' && !document.querySelector('#stop-share')?.disabled) throw new Error('product stop-share control is still active');
    if (parsedRole === 'viewer' && !document.querySelector('#share-panel:not([hidden])')) throw new Error('viewer left the production room before checking inbound screen stop');
    const capturedTracks = capturedDisplayTracks();
    const screenSenderTrackNull = parsedRole === 'host' ? localScreenSenderTrackNull() : null;
    const stopReceiverEvidence = receiverStopEvidence(screenRequired, state);
    const missingStatsEvidence = new Map([...stopReceiverEvidence].map(([key, evidence]) => [key, evidence.muted || evidence.ended]));
    const result = verifyStoppedScreenEvidence({ before: state.stopBaseline, settledBefore, after: current, voiceRequired: required, screenRequired, participantRole: parsedRole, senderTrackNull: screenSenderTrackNull, capturedTracks: capturedTracks.map((track) => ({ kind: track.kind, readyState: track.readyState })), allowStatsRowsMissing: parsedRole === 'host', requireCaptureEnded: parsedRole === 'host', receiverEvidence: stopReceiverEvidence, missingStatsEvidence });
    if (parsedRole === 'host' && capturedTracks.length < 2) throw new Error('host getDisplayMedia capture track references are missing');
    const aliases = currentPeerAliases(parsedRole, alias, state);
    const signatures = await decodedAudioSignatures((state.mappedTracks ?? []).filter((track) => track.role === 'microphone'), aliases, silentOutput);
    if (signatures.length !== required.filter((flow) => flow.direction === 'inbound').length) throw new Error('post-stop microphone sink mapping is incomplete');
    state.audioSignatures = signatures.map((item) => ({ ...item, matches: signatureMatches({ ...item, aliases }) }));
    assertAudioSignaturesMatch(state.audioSignatures);
    state.publicRTPRows = publicDeltaRows(result.voiceDeltas, aliases);
    updateEvidence({
      voiceRTPDirectionsAfterStop: state.publicRTPRows,
      stopMeasurementWindowMs: Math.round(stopWindowMs),
      stoppedScreenFlows: screenRequired.map((flow) => { const baseline = state.stopBaseline.find((item) => item.peerId === flow.peerId && item.role === flow.role && item.direction === flow.direction); const settled = settledBefore.find((item) => item.peerId === flow.peerId && item.role === flow.role && item.direction === flow.direction); const after = current.find((item) => item.peerId === flow.peerId && item.role === flow.role && item.direction === flow.direction); const receiver = stopReceiverEvidence.get(`${flow.peerId}\u0000${flow.role}\u0000${flow.direction}`); return { alias: aliases.get(flow.peerId), role: flow.role, direction: flow.direction, baselineBytes: baseline?.bytes ?? 0, settledBytes: settled?.bytes ?? null, postStopBytes: after?.bytes ?? null, baselineFrames: baseline?.frames ?? null, settledFrames: settled?.frames ?? null, postStopFrames: after?.frames ?? null, postStopStatsMissing: !after, receiverMapped: receiver?.mapped ?? false, receiverMutedEvidence: receiver?.muted ?? false, receiverEndedEvidence: receiver?.ended ?? false }; }),
      localScreenSendersHaveNoTrack: parsedRole === 'host' ? screenSenderTrackNull : 'not applicable to viewer inbound flow',
      getDisplayMediaTracksEnded: capturedTracks.map((track) => ({ kind: track.kind, ended: track.readyState === 'ended' })),
    });
    return `${state.publicRTPRows.length} 个逐 peer 语音方向继续增长且音签匹配；所有 screenVideo 与 systemAudio 在停止后观察窗口内零增量`;
  }));
  addButton(controls, '验证观众双向语音', () => run('viewer-mesh', async () => {
    if (parsedRole !== 'viewer') throw new Error('viewer role required');
    await new Promise((resolve) => setTimeout(resolve, 800));
    const current = await safeStats(); const peers = authenticatedMembers().filter((item) => item.peerId !== ownPeerId() && item.role === 'viewer');
    if (peers.length !== 1) throw new Error('other authenticated viewer missing');
    const deltas = verifyPerPairDeltas(statsBaseline(), current, [{ peerId: peers[0].peerId, role: 'microphone', direction: 'inbound' }, { peerId: peers[0].peerId, role: 'microphone', direction: 'outbound' }]);
    const aliases = currentPeerAliases(parsedRole, alias, state);
    state.publicRTPRows = publicDeltaRows(deltas, aliases);
    updateEvidence({ viewerVoicePeerRoleDirectionDeltas: state.publicRTPRows }); return '观众间 mic inbound/outbound 均有 RTP 增量';
  }));
  addButton(controls, '注入真实 host bridge TCP 断开', async () => {
    if (parsedRole !== 'host' || !localBootstrap?.localControlToken) { updateEvidence({ bridgeFault: '仅host本机授权可用' }); return; }
    try {
      const response = await fetch('/__visible_test__/fault/drop-bridges', { method: 'POST', headers: { 'X-Local-Control-Token': localBootstrap.localControlToken } });
      const result = response.ok ? await response.json() : null;
      state.bridgeCloseCount = result?.closed ?? 0;
      updateEvidence({ capturedBridgesClosed: state.bridgeCloseCount });
      if (!result?.closed) safeResult(results.resume, false, '没有捕获到本测试 host 的 bridge TCP');
      else { results.resume.dataset.state = 'WAITING'; results.resume.textContent = `等待 viewer 自动恢复 · 已关闭 ${result.closed} 个本测试 bridge`; }
    } catch { safeResult(results.resume, false, 'FAULT_REQUEST_FAILED'); }
  });
  addButton(controls, '等待并检查自动恢复与身份轮换', () => run('resume', async () => {
    if (parsedRole !== 'viewer') throw new Error('viewer role required to verify its automatic resume credential');
    const deadline = performance.now() + 20_000;
    const recoveryObserved = () => {
      const loss = state.incoming.findLast((message) => message.type === 'error' && message.payload?.code === 'SIGNAL_CONNECTION_LOST' && message.payload?.retryable === true);
      return !!loss && state.incoming.some((message) => message.type === 'room.joined' && message.observedAt > loss.observedAt);
    };
    while (!recoveryObserved() && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    const result = verifyAutomaticResumeEvidence({
      joins: state.incoming.filter((message) => message.type === 'room.joined').map((message) => ({ peerId: message.peerId, resumeToken: message.payload?.resumeToken, socketId: message.socketId, observedAt: message.observedAt })),
      losses: state.incoming.filter((message) => message.type === 'error').map((message) => ({ code: message.payload?.code, retryable: message.payload?.retryable, socketId: message.socketId, observedAt: message.observedAt })),
      localSockets: state.localSockets,
      members: authenticatedMembers(),
    });
    state.resumeEvidence = result;
    updateEvidence({ automaticResume: { peerIdentityPreserved: true, resumeTokenRotated: result.tokenRotated, sameLocalWebSocket: result.localSocketPreserved, elapsedMs: result.elapsedMs, uniqueSeat: true } });
    return `自动恢复保留当前 peer 与本机WS，凭证轮换，耗时 ${result.elapsedMs} ms`;
  }));
  addButton(controls, '检查观众越权和满房错误', () => run('full', async () => {
    if (parsedRole !== 'viewer') throw new Error('viewer role required');
    assertLocalRuntimeHealthy();
    const roomFull = state.incoming.some((message) => message.type === 'error' && message.payload?.code === 'ROOM_FULL');
    const hostOnly = await probeViewerHostEnd();
    if (!roomFull || !hostOnly) throw new Error('ROOM_FULL or HOST_ONLY protocol evidence missing');
    return '生产协议拒绝 ROOM_FULL 与 viewer host.endRoom (HOST_ONLY)';
  }));
  addButton(controls, '检查普通离房/重加入后的 peer 与席位', () => run('seat-rejoin', async () => {
    if (!state.initialMembers?.length || state.initialMembers.length !== 3) throw new Error('initial three-member mesh check must pass first');
    const current = authenticatedMembers();
    const ids = current.map((member) => member.peerId);
    if (current.length !== 3 || new Set(ids).size !== 3) throw new Error('three unique authenticated room seats are not restored');
    const initialViewers = [...(state.initialAliasAssignments ?? new Map())].filter(([, assigned]) => assigned === 'viewer-1' || assigned === 'viewer-2');
    const oldViewer2 = initialViewers.find(([, assigned]) => assigned === 'viewer-2')?.[0];
    const aliases = currentPeerAliases(parsedRole, alias, state);
    if (!oldViewer2 || ids.includes(oldViewer2)) throw new Error('old viewer2 peer remains in the room roster');
    const viewer1Old = initialViewers.find(([, assigned]) => assigned === 'viewer-1')?.[0];
    if (aliases.get(viewer1Old) !== 'viewer-1' || !ids.includes(viewer1Old)) throw new Error('viewer1 authenticated peer or assigned alias changed');
    const viewer2Current = [...aliases].find(([, assigned]) => assigned === 'viewer-2')?.[0];
    if (!viewer2Current || viewer2Current === oldViewer2 || !ids.includes(viewer2Current)) throw new Error('new viewer2 peer did not reclaim the freed seat/alias');
    if (parsedRole !== 'host' && ownPeerId() !== (alias === 'viewer-1' ? viewer1Old : viewer2Current)) throw new Error('current local peer does not match its configured alias');
    return '旧 viewer2 peer 已移除；新 peer 重加入并取得 viewer2 席位/别名，viewer1 映射稳定';
  }));
  addButton(controls, '检查麦克风拒绝接收模式', () => run('denied', async () => {
    if (!state.denyMicrophone) throw new Error('fixture was not configured to deny mic');
    if (parsedRole !== 'viewer') throw new Error('viewer role required');
    if (!document.querySelector('#share-panel:not([hidden])')) throw new Error('viewer is not joined');
    if (!state.captures.some((item) => item.type === 'microphone-request' && item.denied === true)) throw new Error('synthetic mic-denial action was not exercised');
    const liveReceived = activeRtpReceivedTracks(state.pcs, state.received);
    if (!liveReceived.some((item) => item.kind === 'video') || !liveReceived.some((item) => item.kind === 'audio')) throw new Error('remote receive-only tracks missing');
    if (activeRtpPeerConnections(state.pcs).some(({ pc }) => pc.getSenders().some((sender) => sender.track?.kind === 'audio'))) throw new Error('mic-denied viewer still has an active local audio sender');
    const sinks = [...document.querySelectorAll('audio[data-source-peer-id][data-track-role]')];
    if (!sinks.length || !silentOutput?.auditSinks() || sinks.some((audio) => { const evidence = silentOutput.snapshot(audio); return !evidence || evidence.outputGain !== 0 || evidence.lastPlayState !== 'resolved' || !evidence.playing || evidence.paused || !(evidence.currentTime > 0); })) throw new Error('receive-only audio was not natively playing through all silent production sinks');
    return `合成mic拒绝，已接收远端轨道；${sinks.length} 个原生音频 sink 正在零增益播放`;
  }));
  addButton(controls, '检查音频隔离仍未实机确认', () => run('isolation', async () => {
    const status = document.querySelector('#isolation-status');
    if (!state.syntheticReportedIsolation || !status || status.dataset.state === 'manual_pass' || !/浏览器|未|未知|报告/.test(status.textContent)) throw new Error('synthetic settings must remain explicitly unverified in the product UI');
    return '仅为 synthetic setting；UI 未标成人耳或真实隔离通过';
  }));
  addButton(controls, '检查实际接收帧和统计UI', () => run('quality', async () => {
    state.qualityDiagnostics = { stage: 'runtime' };
    assertLocalRuntimeHealthy();
    const frame = await visibleFrameEvidence();
    state.qualityDiagnostics = { stage: 'frame', frame };
    updateEvidence();
    if (!frame.ok || !frame.presentedFrameProgressed || !frame.varied) throw new Error('decoded screen frame/dimensions/content missing');
    const videoElement = document.querySelector(parsedRole === 'host' ? '#local-preview' : '#remote-screen');
    const playEvidence = silentOutput?.snapshot(videoElement);
    state.qualityDiagnostics = { ...state.qualityDiagnostics, stage: 'play', play: playEvidence };
    updateEvidence();
    if (!silentOutput?.auditSinks() || !playEvidence || playEvidence.outputGain !== 0 || playEvidence.lastPlayState !== 'resolved' || !playEvidence.playing || playEvidence.paused || !(playEvidence.currentTime > 0)) throw new Error('latest native product video play/decode did not advance through the zero-gain sink graph');
    const stats = await safeStats();
    const members = authenticatedMembers(); const own = ownPeerId();
    const expectedPeers = members.filter((member) => member.peerId !== own && (parsedRole === 'host' ? member.role === 'viewer' : member.role === 'host')).map((member) => member.peerId);
    const direction = parsedRole === 'host' ? 'outbound' : 'inbound';
    const candidateLinks = stats.filter((row) => row.role === 'screenVideo' && row.direction === direction && expectedPeers.includes(row.peerId));
    const shown = document.querySelector('#actual-stats')?.textContent ?? '';
    const uiMatchesReportedResolution = candidateLinks.some((row) => row.width > 0 && row.height > 0 && String(shown).includes(`${row.width}×${row.height}`));
    state.qualityDiagnostics = { ...state.qualityDiagnostics, stage: 'stats', stats: candidateLinks, aliases: new Map(), uiMatchesReportedResolution };
    updateEvidence();
    const aliases = currentPeerAliases(parsedRole, alias, state);
    state.qualityDiagnostics = { ...state.qualityDiagnostics, stage: 'alias' };
    state.qualityDiagnostics.aliases = aliases;
    updateEvidence();
    const actual = verifyQualityEvidence({ rows: stats, expectedPeers, direction, uiText: shown });
    const publicLinks = actual.links.map((row) => ({ alias: aliases.get(row.peerId) ?? 'unknown', role: row.role, direction: row.direction, frames: row.frames, width: row.width, height: row.height }));
    state.qualityDiagnostics = { ...state.qualityDiagnostics, stage: 'ui', stats: actual.links, uiMatchesReportedResolution: true };
    updateEvidence();
    updateEvidence({ videoLinkEvidence: publicLinks, actualVideoFrame: { width: frame.width, height: frame.height, variedPixels: frame.varied }, nativePlay: { resolved: playEvidence.nativePlayResolved, playing: playEvidence.playing, currentTime: playEvidence.currentTime, zeroGain: playEvidence.outputGain === 0 } });
    state.qualityDiagnostics = { ...state.qualityDiagnostics, stage: 'complete' };
    updateEvidence();
    return `${publicLinks.length} 个每 peer screenVideo ${direction} native统计有帧/尺寸，页面画面变化且实际统计UI相符`;
  }));

  async function probeViewerHostEnd() {
    const wsURL = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/v1`;
    return new Promise((resolve) => {
      const socket = new WebSocket(wsURL); const timer = setTimeout(() => { socket.close(); resolve(false); }, 3000);
      socket.addEventListener('open', () => socket.send(JSON.stringify({ v: 1, type: 'auth.hello', requestId: 'visible-probe-auth', payload: { role: 'viewer' } })));
      socket.addEventListener('message', (event) => {
        let message; try { message = JSON.parse(String(event.data)); } catch { return; }
        if (message.type === 'room.state') socket.send(JSON.stringify({ v: 1, type: 'host.endRoom', requestId: 'visible-probe-forged-end', payload: {} }));
        if (message.type === 'error' && message.payload?.code === 'HOST_ONLY') { clearTimeout(timer); socket.close(); resolve(true); }
      });
      socket.addEventListener('error', () => { clearTimeout(timer); resolve(false); });
    });
  }

  updateEvidence();
  return { panel, run, updateEvidence };
}
