import assert from 'node:assert/strict';
import test from 'node:test';
import { receiverStopEvidence } from './controller.js';
import { correlateReceivedTracks, mapPeerAliases, publicDeltaRows, signatureMatches, verifyAutomaticResumeEvidence, verifyPerPairDeltas, verifyQualityEvidence, verifyStoppedScreenEvidence } from './assertions.js';

test('received MID and track correlate through the real PC SDP and production sink', () => {
  const pc = { id: 0, localDescription: { sdp: 'local-viewer-sdp' }, remoteDescription: { sdp: 'remote-host-sdp' } };
  const result = correlateReceivedTracks({
    pcs: [pc],
    received: [{ pcId: 0, mid: '1', trackId: 'track-audio-host', kind: 'audio', state: 'live' }],
    descriptions: [{ peerId: 'host-peer', direction: 'incoming', sdp: 'remote-host-sdp', tracks: [{ mid: '1', role: 'systemAudio' }] }],
    sinks: [{ trackId: 'track-audio-host', peerId: 'host-peer', role: 'systemAudio' }],
    members: [{ peerId: 'host-peer', role: 'host' }],
  });
  assert.deepEqual(result, [{ pcId: 0, peerId: 'host-peer', peerRole: 'host', mid: '1', trackId: 'track-audio-host', kind: 'audio', role: 'systemAudio' }]);
});

test('received track mapping fails closed when SDP or product sink is ambiguous', () => {
  const pc = { id: 0, localDescription: { sdp: 'local-sdp' }, remoteDescription: { sdp: 'remote-sdp' } };
  const input = {
    pcs: [pc], received: [{ pcId: 0, mid: '0', trackId: 'track-x', kind: 'audio', state: 'live' }],
    descriptions: [{ peerId: 'peer-1', direction: 'incoming', sdp: 'remote-sdp', tracks: [{ mid: '0', role: 'microphone' }] }],
    sinks: [{ trackId: 'track-x', peerId: 'peer-1', role: 'microphone' }],
    members: [{ peerId: 'peer-1', role: 'viewer' }],
  };
  assert.throws(() => correlateReceivedTracks({ ...input, descriptions: [...input.descriptions, { ...input.descriptions[0], peerId: 'peer-2' }] }), /ambiguous/i);
  assert.throws(() => correlateReceivedTracks({ ...input, sinks: [] }), /production sink/i);
  assert.throws(() => correlateReceivedTracks({ ...input, descriptions: [{ ...input.descriptions[0], tracks: [{ mid: 'other', role: 'microphone' }] }] }), /MID/i);
  assert.throws(() => correlateReceivedTracks({ ...input, descriptions: [{ ...input.descriptions[0], tracks: [{ mid: '0', role: 'systemAudio' }] }] }), /sink role/i);
});

test('per-pair delta validation rejects a missing viewer voice direction', () => {
  const before = [
    { peerId: 'host', role: 'microphone', direction: 'inbound', bytes: 10, packets: 2 },
    { peerId: 'viewer-2', role: 'microphone', direction: 'inbound', bytes: 20, packets: 4 },
  ];
  const after = [
    { peerId: 'host', role: 'microphone', direction: 'inbound', bytes: 100, packets: 10 },
    { peerId: 'viewer-2', role: 'microphone', direction: 'inbound', bytes: 20, packets: 4 },
  ];
  assert.throws(() => verifyPerPairDeltas(before, after, [
    { peerId: 'host', role: 'microphone', direction: 'inbound' },
    { peerId: 'viewer-2', role: 'microphone', direction: 'inbound' },
  ]), /viewer-2.*microphone.*inbound/i);
});

test('per-pair delta validation accepts only positive bytes and packets for each required direction', () => {
  const before = [{ peerId: 'viewer-2', role: 'microphone', direction: 'outbound', bytes: 100, packets: 2 }];
  const after = [{ peerId: 'viewer-2', role: 'microphone', direction: 'outbound', bytes: 160, packets: 3 }];
  assert.deepEqual(verifyPerPairDeltas(before, after, [{ peerId: 'viewer-2', role: 'microphone', direction: 'outbound' }]), [
    { peerId: 'viewer-2', role: 'microphone', direction: 'outbound', bytes: 60, packets: 1 },
  ]);
});

test('authenticated room peer IDs map to fixed harness aliases using ordered viewer joins', () => {
  assert.deepEqual(mapPeerAliases({
    role: 'host', alias: 'host', ownPeerId: 'peer-host',
    members: [{ peerId: 'peer-host', role: 'host' }, { peerId: 'peer-v1', role: 'viewer' }, { peerId: 'peer-v2', role: 'viewer' }],
    viewerJoinOrder: ['peer-v1', 'peer-v2'],
  }), new Map([['peer-host', 'host'], ['peer-v1', 'viewer-1'], ['peer-v2', 'viewer-2']]));
  assert.deepEqual(mapPeerAliases({
    role: 'host', alias: 'host', ownPeerId: 'peer-host',
    members: [{ peerId: 'peer-host', role: 'host' }, { peerId: 'peer-v1', role: 'viewer' }, { peerId: 'peer-v2', role: 'viewer' }],
    viewerJoinOrder: ['peer-v2', 'peer-v1'],
  }), new Map([['peer-host', 'host'], ['peer-v2', 'viewer-1'], ['peer-v1', 'viewer-2']]));
  assert.throws(() => mapPeerAliases({
    role: 'host', alias: 'host', ownPeerId: 'peer-host',
    members: [{ peerId: 'peer-host', role: 'host' }, { peerId: 'peer-v1', role: 'viewer' }, { peerId: 'peer-v2', role: 'viewer' }],
    viewerJoinOrder: ['peer-v2', 'peer-v2'],
  }), /join order/i);
  assert.throws(() => mapPeerAliases({
    role: 'host', alias: 'host', ownPeerId: 'peer-host',
    members: [{ peerId: 'peer-host', role: 'host' }, { peerId: 'peer-v1', role: 'viewer' }, { peerId: 'peer-v1', role: 'viewer' }],
    viewerJoinOrder: ['peer-v1', 'peer-v2'],
  }), /duplicated/i);
});

test('measured received tone must match authenticated sender alias and track role', () => {
  const aliases = new Map([['peer-host', 'host'], ['peer-v1', 'viewer-1'], ['peer-v2', 'viewer-2']]);
  assert.equal(signatureMatches({ peerId: 'peer-v1', role: 'microphone', hz: 617, aliases }), true);
  assert.equal(signatureMatches({ peerId: 'peer-v1', role: 'microphone', hz: 733, aliases }), false);
  assert.equal(signatureMatches({ peerId: 'peer-host', role: 'systemAudio', hz: 440, aliases }), true);
  assert.equal(signatureMatches({ peerId: 'peer-v1', role: 'systemAudio', hz: 440, aliases }), false);
  assert.equal(signatureMatches({ peerId: 'unknown', role: 'microphone', hz: 617, aliases }), false);
});

test('leave/rejoin and duplicate join events retire old peer IDs without shifting remaining aliases', () => {
  const initial = mapPeerAliases({
    role: 'host', alias: 'host', ownPeerId: 'host',
    members: [{ peerId: 'host', role: 'host' }, { peerId: 'v1', role: 'viewer' }, { peerId: 'v2-old', role: 'viewer' }],
    viewerJoinOrder: ['v1', 'v1', 'v2-old'],
  });
  const afterLeave = mapPeerAliases({
    role: 'host', alias: 'host', ownPeerId: 'host',
    members: [{ peerId: 'host', role: 'host' }, { peerId: 'v1', role: 'viewer' }],
    viewerJoinOrder: ['v1', 'v1', 'v2-old'], previousAliases: new Map([...initial].filter(([peerId]) => peerId !== 'host')),
  });
  assert.deepEqual(afterLeave, new Map([['host', 'host'], ['v1', 'viewer-1']]));
  const afterRejoin = mapPeerAliases({
    role: 'host', alias: 'host', ownPeerId: 'host',
    members: [{ peerId: 'host', role: 'host' }, { peerId: 'v1', role: 'viewer' }, { peerId: 'v2-new', role: 'viewer' }],
    viewerJoinOrder: ['v1', 'v1', 'v2-old', 'v2-new', 'v2-new'], previousAliases: new Map([...afterLeave].filter(([peerId]) => peerId !== 'host')),
  });
  assert.deepEqual(afterRejoin, new Map([['host', 'host'], ['v1', 'viewer-1'], ['v2-new', 'viewer-2']]));
});

test('public per-peer RTP evidence uses aliases, role and direction without exposing peer IDs', () => {
  const rows = publicDeltaRows([
    { peerId: 'private-peer-one', role: 'microphone', direction: 'inbound', bytes: 50, packets: 4 },
    { peerId: 'private-peer-two', role: 'systemAudio', direction: 'outbound', bytes: 70, packets: 5 },
  ], new Map([['private-peer-one', 'viewer-1'], ['private-peer-two', 'host']]));
  assert.deepEqual(rows, [
    { alias: 'viewer-1', role: 'microphone', direction: 'inbound', bytes: 50, packets: 4 },
    { alias: 'host', role: 'systemAudio', direction: 'outbound', bytes: 70, packets: 5 },
  ]);
  assert.equal(JSON.stringify(rows).includes('private-peer'), false);
  assert.throws(() => publicDeltaRows([{ peerId: 'unknown', role: 'microphone', direction: 'inbound', bytes: 1, packets: 1 }], new Map()), /alias/i);
});

test('screen stop requires voice deltas, video and system-audio stopping, null senders and ended capture tracks', () => {
  const voice = [{ peerId: 'v1', role: 'microphone', direction: 'inbound' }];
  const screen = [
    { peerId: 'v1', role: 'screenVideo', direction: 'outbound' },
    { peerId: 'v1', role: 'systemAudio', direction: 'outbound' },
  ];
  const before = [
    { peerId: 'v1', role: 'microphone', direction: 'inbound', bytes: 100, packets: 10, frames: 0 },
    { peerId: 'v1', role: 'screenVideo', direction: 'outbound', bytes: 1000, packets: 50, frames: 40 },
    { peerId: 'v1', role: 'systemAudio', direction: 'outbound', bytes: 500, packets: 30, frames: 0 },
  ];
  const after = [
    { peerId: 'v1', role: 'microphone', direction: 'inbound', bytes: 180, packets: 18, frames: 0 },
    { peerId: 'v1', role: 'screenVideo', direction: 'outbound', bytes: 1000, packets: 50, frames: 40 },
    { peerId: 'v1', role: 'systemAudio', direction: 'outbound', bytes: 500, packets: 30, frames: 0 },
  ];
  const evidence = { before, after, voiceRequired: voice, screenRequired: screen, senderTrackNull: { screenVideo: true, systemAudio: true }, capturedTracks: [{ kind: 'video', readyState: 'ended' }, { kind: 'audio', readyState: 'ended' }] };
  assert.equal(verifyStoppedScreenEvidence(evidence).voiceDeltas.length, 1);
  assert.doesNotThrow(() => verifyStoppedScreenEvidence({ ...evidence, capturedTracks: [], requireCaptureEnded: false }));
  assert.throws(() => verifyStoppedScreenEvidence({ ...evidence, after: after.map((row) => row.role === 'systemAudio' ? { ...row, bytes: row.bytes + 1, packets: row.packets + 1 } : row) }), /systemAudio.*continued/i);
  assert.throws(() => verifyStoppedScreenEvidence({ ...evidence, after: after.filter((row) => row.role !== 'systemAudio') }), /disappeared/i);
  const systemKey = 'v1\u0000systemAudio\u0000outbound';
  assert.throws(() => verifyStoppedScreenEvidence({ ...evidence, after: after.filter((row) => row.role !== 'systemAudio'), allowStatsRowsMissing: false, missingStatsEvidence: new Map() }), /disappeared/i);
  assert.doesNotThrow(() => verifyStoppedScreenEvidence({ ...evidence, after: after.filter((row) => row.role !== 'systemAudio'), missingStatsEvidence: new Map([[systemKey, true]]) }));
  assert.doesNotThrow(() => verifyStoppedScreenEvidence({ ...evidence, after: after.filter((row) => row.role !== 'systemAudio'), allowStatsRowsMissing: true }));
  assert.throws(() => verifyStoppedScreenEvidence({ ...evidence, senderTrackNull: { screenVideo: true, systemAudio: false } }), /sender/i);
  assert.throws(() => verifyStoppedScreenEvidence({ ...evidence, capturedTracks: [{ kind: 'video', readyState: 'live' }, { kind: 'audio', readyState: 'ended' }] }), /getDisplayMedia.*tracks/i);
  assert.throws(() => verifyStoppedScreenEvidence({ ...evidence, after: after.map((row) => row.role === 'microphone' ? { ...row, bytes: 100, packets: 10 } : row) }), /microphone.*delta/i);
  const settledBefore = before.map((row) => ({ ...row, bytes: row.bytes + 50, packets: row.packets + 5, frames: row.frames + (row.role === 'screenVideo' ? 2 : 0) }));
  const settledAfter = settledBefore.map((row) => row.role === 'microphone' ? { ...row, bytes: row.bytes + 20, packets: row.packets + 2 } : row);
  assert.doesNotThrow(() => verifyStoppedScreenEvidence({ ...evidence, settledBefore, after: settledAfter }), 'pre-stop traffic must not count as continued post-stop transmission');
  assert.throws(() => verifyStoppedScreenEvidence({ ...evidence, settledBefore, after: settledAfter.map((row) => row.role === 'systemAudio' ? { ...row, bytes: row.bytes + 1 } : row) }), /systemAudio.*continued/i, 'even one new post-stop byte must fail');
  assert.throws(() => verifyStoppedScreenEvidence({ ...evidence, settledBefore, after: settledBefore }), /microphone.*delta/i, 'voice must advance within the post-stop window itself');
});

test('viewer stop accepts real inbound stop evidence without requiring local screen senders', () => {
  const before = [
    { peerId: 'host', role: 'microphone', direction: 'inbound', bytes: 100, packets: 10 },
    { peerId: 'host', role: 'screenVideo', direction: 'inbound', bytes: 1000, packets: 50, frames: 40 },
    { peerId: 'host', role: 'systemAudio', direction: 'inbound', bytes: 500, packets: 30, frames: 0 },
  ];
  const after = [
    { peerId: 'host', role: 'microphone', direction: 'inbound', bytes: 180, packets: 18 },
    { peerId: 'host', role: 'screenVideo', direction: 'inbound', bytes: 1000, packets: 50, frames: 40 },
    { peerId: 'host', role: 'systemAudio', direction: 'inbound', bytes: 500, packets: 30, frames: 0 },
  ];
  const common = {
    before, after,
    voiceRequired: [{ peerId: 'host', role: 'microphone', direction: 'inbound' }],
    screenRequired: [{ peerId: 'host', role: 'screenVideo', direction: 'inbound' }, { peerId: 'host', role: 'systemAudio', direction: 'inbound' }],
    participantRole: 'viewer',
    receiverEvidence: new Map([
      ['host\u0000screenVideo\u0000inbound', { mapped: true, muted: false, ended: false }],
      ['host\u0000systemAudio\u0000inbound', { mapped: true, muted: false, ended: false }],
    ]),
  };
  assert.equal(verifyStoppedScreenEvidence(common).screenRequired.length, 2);
  assert.throws(() => verifyStoppedScreenEvidence({ ...common, receiverEvidence: new Map() }), /actual inbound receiver/i);
  assert.throws(() => verifyStoppedScreenEvidence({ ...common, after: after.map((row) => row.role === 'screenVideo' ? { ...row, frames: row.frames + 1, bytes: row.bytes + 10 } : row) }), /screenVideo.*continued/i);
  assert.throws(() => verifyStoppedScreenEvidence({ ...common, after: after.filter((row) => row.role !== 'systemAudio') }), /systemAudio.*disappeared/i);
  assert.doesNotThrow(() => verifyStoppedScreenEvidence({ ...common, after: after.filter((row) => row.role !== 'systemAudio'), receiverEvidence: new Map([...common.receiverEvidence, ['host\u0000systemAudio\u0000inbound', { mapped: true, muted: true, ended: false }]]) }));
  assert.throws(() => verifyStoppedScreenEvidence({ ...common, after: after.map((row) => row.role === 'screenVideo' ? { peerId: row.peerId, role: row.role, direction: row.direction, bytes: row.bytes, packets: row.packets } : row) }), /frame count is missing/i);
});

test('production receiver-stop helper reads the supplied per-page capture state', () => {
  const state = {
    mappedTracks: [
      { peerId: 'host', role: 'screenVideo', trackId: 'video-1' },
      { peerId: 'host', role: 'systemAudio', trackId: 'audio-1' },
    ],
    received: [
      { trackId: 'video-1', state: 'live', muted: false, track: { muted: false, readyState: 'live' } },
      { trackId: 'audio-1', state: 'live', muted: true, track: { muted: true, readyState: 'live' } },
    ],
  };
  const evidence = receiverStopEvidence([
    { peerId: 'host', role: 'screenVideo', direction: 'inbound' },
    { peerId: 'host', role: 'systemAudio', direction: 'inbound' },
  ], state);
  assert.deepEqual(evidence.get('host\u0000screenVideo\u0000inbound'), { mapped: true, muted: false, ended: false });
  assert.deepEqual(evidence.get('host\u0000systemAudio\u0000inbound'), { mapped: true, muted: true, ended: false });
});

test('resume evidence uses the latest pre-fault join and proves production loss, local socket continuity and 20-second recovery', () => {
  const base = {
    joins: [
      { peerId: 'peer-before-leave', resumeToken: 'old-a', socketId: 7, observedAt: 100 },
      { peerId: 'peer-after-rejoin', resumeToken: 'old-b', socketId: 7, observedAt: 500 },
      { peerId: 'peer-after-rejoin', resumeToken: 'new-c', socketId: 7, observedAt: 8500 },
    ],
    losses: [{ code: 'SIGNAL_CONNECTION_LOST', retryable: true, socketId: 7, observedAt: 600 }],
    localSockets: [{ id: 7, readyState: 1 }],
    members: [{ peerId: 'peer-after-rejoin' }],
  };
  const evidence = verifyAutomaticResumeEvidence(base);
  assert.equal(evidence.peerIdentityPreserved, true);
  assert.equal(evidence.localSocketPreserved, true);
  assert.equal(evidence.elapsedMs, 7900);
  assert.throws(() => verifyAutomaticResumeEvidence({ ...base, losses: [] }), /SIGNAL_CONNECTION_LOST/i);
  assert.throws(() => verifyAutomaticResumeEvidence({ ...base, localSockets: [{ id: 7, readyState: 3 }] }), /local websocket/i);
  assert.throws(() => verifyAutomaticResumeEvidence({ ...base, localSockets: [...base.localSockets, { id: 8, readyState: 1 }] }), /local websocket/i);
  assert.throws(() => verifyAutomaticResumeEvidence({ ...base, losses: [{ ...base.losses[0], socketId: 8 }] }), /current production local websocket/i);
  assert.throws(() => verifyAutomaticResumeEvidence({ ...base, joins: [...base.joins.slice(0, 2), { ...base.joins[2], observedAt: 21000 }] }), /20 seconds/i);
  assert.throws(() => verifyAutomaticResumeEvidence({ ...base, joins: base.joins.slice(0, 2) }), /resume event/i);
});

test('quality evidence requires every authenticated host-viewer video link and actual UI resolution', () => {
  const rows = [
    { peerId: 'viewer-1-peer', role: 'screenVideo', direction: 'outbound', frames: 30, width: 1280, height: 720 },
    { peerId: 'viewer-2-peer', role: 'screenVideo', direction: 'outbound', frames: 28, width: 1280, height: 720 },
  ];
  assert.equal(verifyQualityEvidence({ rows, expectedPeers: ['viewer-1-peer', 'viewer-2-peer'], direction: 'outbound', uiText: '实际 1280×720' }).links.length, 2);
  assert.throws(() => verifyQualityEvidence({ rows: rows.slice(0, 1), expectedPeers: ['viewer-1-peer', 'viewer-2-peer'], direction: 'outbound', uiText: '实际 1280×720' }), /every authenticated/i);
  assert.throws(() => verifyQualityEvidence({ rows, expectedPeers: ['viewer-1-peer', 'viewer-2-peer'], direction: 'outbound', uiText: '实际分辨率未知' }), /actual stats UI/i);
});
