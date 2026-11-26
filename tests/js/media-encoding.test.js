import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshMedia } from '../../internal/web/assets/media.js';


test('identical capture and sender settings do not restart capture or reconfigure the encoder', async () => {
  const media = new MeshMedia({ sendUnacknowledged() {} });
  let captureChanges = 0, encoderChanges = 0;
  let constraints = {}, parameters = { encodings: [{}] };
  const track = { getSettings: () => ({ width: 1920, height: 1080 }), getConstraints: () => constraints,
    applyConstraints: async value => { constraints = structuredClone(value); captureChanges++; } };
  const sender = { getParameters: () => structuredClone(parameters), setParameters: async value => { parameters = structuredClone(value); encoderChanges++; } };
  media.screenVideoTrack = track; media.peers.set('peer', { screenSender: sender });
  await media.setQuality('1080p60'); await media.setQuality('1080p60');
  assert.equal(captureChanges, 1); assert.equal(encoderChanges, 1);
  await media.setShareCursor(true);
  assert.equal(captureChanges, 2, 'a real cursor request still reaches capture');
  await media.setQuality('720p60');
  assert.equal(captureChanges, 3); assert.equal(encoderChanges, 2);
  assert.equal(parameters.encodings[0].maxFramerate, 60);
});

test('background preview preference preserves selected capture resolution, framerate and bitrate on every sender', async () => {
  const media = new MeshMedia({ sendUnacknowledged() {} });
  const constraints = [], encodings = [];
  const microphone = { kind: 'audio' }, systemAudio = { kind: 'audio' };
  media.microphoneTrack = microphone; media.systemAudioTrack = systemAudio; media.ownsPresentation = true;
  media.screenVideoTrack = { applyConstraints: async value => constraints.push(value), getSettings: () => ({ width: 1280, height: 720 }) };
  const pcs = [{}, {}];
  pcs.forEach((pc, index) => media.peers.set(String(index), { pc, screenSender: {
    getParameters: () => ({ encodings: [{}] }), setParameters: async value => encodings.push(value.encodings[0]),
  } }));
  await media.setQuality('1080p60');
  assert.equal(constraints.at(-1).width.max, 1920); assert.equal(constraints.at(-1).height.max, 1080);
  assert.equal(constraints.at(-1).frameRate.max, 60); assert.equal(encodings.length, 2);
  assert.ok(encodings.every(encoding => encoding.maxFramerate === 60 && encoding.maxBitrate === 25_000_000));
  assert.equal(media.microphoneTrack, microphone); assert.equal(media.systemAudioTrack, systemAudio);
  assert.ok(media.ownsPresentation); assert.deepEqual([...media.peers.values()].map(peer => peer.pc), pcs);
  media.pauseBackgroundPreview = false; media.pauseBackgroundPreview = true;
  assert.equal(media.quality, '1080p60'); assert.equal(constraints.length, 1); assert.equal(encodings.length, 2);
});

test('stats compute interval encoding and CPU limitation from counter deltas and ignore resets', async () => {
  const media = new MeshMedia({});
  let timestamp = 1000, framesEncoded = 60, totalEncodeTime = 0.3, cpu = 0;
  media.peers.set('peer', { pc: { getStats: async () => new Map([['video', {
    id: 'video', type: 'outbound-rtp', kind: 'video', timestamp, framesEncoded, totalEncodeTime, bytesSent: timestamp,
    qualityLimitationDurations: { cpu },
  }]]) } });
  assert.equal((await media.getStatsSnapshot())[0].intervalEncodeMs, null);
  timestamp += 2000; framesEncoded += 120; totalEncodeTime += 0.24; cpu += 0.5;
  const [sample] = await media.getStatsSnapshot();
  assert.ok(Math.abs(sample.intervalEncodeMs - 2) < 1e-9);
  assert.ok(Math.abs(sample.encodeTimeRatio - 0.12) < 1e-9); assert.equal(sample.cpuLimitedRatio, 0.25);
  timestamp += 2000; framesEncoded = 0; totalEncodeTime = 0; cpu = 0;
  const [reset] = await media.getStatsSnapshot();
  assert.equal(reset.encodedFramesDelta, null); assert.equal(reset.encodeTimeRatio, null); assert.equal(reset.cpuLimitedRatio, null);
});

test('active streams report negotiated profiles, selected transport estimates and separate directional interval counters', async () => {
  const media = new MeshMedia({});
  let reports;
  media.peers.set('friend', { pc: { getStats: async () => reports } });
  function sample(timestamp, out, incoming) {
    const rtp = { kind: 'video', timestamp, transportId: 'video-transport' };
    reports = new Map([
      ['wrong-pair', { type: 'candidate-pair', nominated: true, availableOutgoingBitrate: 500, currentRoundTripTime: 1 }],
      ['video-transport', { type: 'transport', selectedCandidatePairId: 'selected' }],
      ['selected', { type: 'candidate-pair', availableOutgoingBitrate: 35_000_000, currentRoundTripTime: 0.007 }],
      ['encoder', { type: 'codec', mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=1; PROFILE-LEVEL-ID = 64002A' }],
      ['decoder', { type: 'codec', mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=42e01f;packetization-mode=1' }],
      ['out', { ...rtp, id: 'out', type: 'outbound-rtp', codecId: 'encoder', ...out }],
      ['remote', { id: 'remote', type: 'remote-inbound-rtp', localId: 'out', packetsLost: out.loss }],
      ['in', { ...rtp, id: 'in', type: 'inbound-rtp', codecId: 'decoder', ...incoming }],
    ]);
    return media.getStatsSnapshot();
  }
  const [first] = await sample(1000, {
    bytesSent: 1000, nackCount: 6, pliCount: 2, firCount: 0, retransmittedPacketsSent: 10, loss: 2, keyFramesEncoded: 1,
    qualityLimitationDurations: { cpu: 1.25, bandwidth: 2, none: 3, other: 0 },
  }, { bytesReceived: 500, nackCount: 30, pliCount: 0, packetsLost: 4, keyFramesDecoded: 10 });
  assert.equal(first.bitrate, null);
  assert.equal(first.pliCountDelta, null);
  assert.deepEqual(first.qualityLimitationDurationsDelta, {});
  const [send, receive] = await sample(3000, {
    bytesSent: 3_001_000, nackCount: 9, pliCount: 4, firCount: 0, retransmittedPacketsSent: 28, loss: 3, keyFramesEncoded: 3,
    targetBitrate: 19_000_000, qualityLimitationReason: 'bandwidth', qualityLimitationDurations: { cpu: 1.5, bandwidth: 2.75, none: 4, other: 0 },
  }, { bytesReceived: 2_000_500, nackCount: 31, pliCount: 1, packetsLost: 4, keyFramesDecoded: 11 });
  assert.equal(send.bitrate, 12_000_000);
  assert.equal(receive.bitrate, 8_000_000);
  assert.equal(send.targetBitrate, 19_000_000);
  assert.equal(receive.targetBitrate, null);
  assert.equal(send.availableOutgoingBitrate, 35_000_000);
  assert.equal(send.currentRoundTripTimeMs, 7);
  assert.equal(send.codecProfile, 'H264 High L4.2');
  assert.equal(send.profileLevelId, '64002A');
  assert.equal(receive.codecProfile, 'H264 Constrained Baseline L3.1');
  assert.equal(receive.profileLevelId, '42e01f');
  assert.equal(send.qualityLimitationReason, 'bandwidth');
  assert.deepEqual(send.qualityLimitationDurations, { cpu: 1.5, bandwidth: 2.75, none: 4, other: 0 });
  assert.deepEqual(send.qualityLimitationDurationsDelta, { cpu: 0.25, bandwidth: 0.75, none: 1, other: 0 });
  assert.deepEqual([send.nackCountDelta, send.pliCountDelta, send.firCountDelta, send.retransmittedPacketsSentDelta,
    send.packetsLostDelta, send.keyFramesEncodedDelta], [3, 2, 0, 18, 1, 2]);
  assert.deepEqual([receive.nackCountDelta, receive.pliCountDelta, receive.firCountDelta, receive.retransmittedPacketsSentDelta,
    receive.packetsLostDelta, receive.keyFramesDecodedDelta], [1, 1, null, null, 0, 1]);

  const [reset, recovered] = await sample(4000, {
    bytesSent: 10, nackCount: 15, qualityLimitationDurations: { cpu: 2 },
  }, { bytesReceived: 2_100_500, packetsLost: 1 });
  assert.equal(reset.bitrate, null);
  assert.equal(reset.nackCountDelta, null);
  assert.deepEqual(reset.qualityLimitationDurationsDelta, {});
  assert.equal(recovered.packetsLostDelta, -3, 'late arrivals reduce interval net loss');
});

test('H264 diagnostics keep the raw id for unrecognized profiles and never infer missing profile or bandwidth', async () => {
  const media = new MeshMedia({});
  let sdpFmtpLine;
  media.peers.set('friend', { pc: { getStats: async () => new Map([
    ['in', { id: 'in', type: 'inbound-rtp', kind: 'video', codecId: 'active' }],
    ['active', { type: 'codec', mimeType: 'video/H264', sdpFmtpLine }],
    ['inactive', { type: 'codec', mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=64002a' }],
    ['unused-pair', { type: 'candidate-pair', availableOutgoingBitrate: 36_000_000, currentRoundTripTime: 0.123 }],
  ]) } });
  for (const [fmtp, profile, raw] of [
    [undefined, 'H264', null], ['profile-level-id=x42e01f', 'H264', null],
    ['profile-level-id=4d002a', 'H264 Main L4.2', '4d002a'],
    ['profile-level-id=640c2a', 'H264 Constrained High L4.2', '640c2a'],
    ['profile-level-id=42f00b', 'H264 Constrained Baseline L1b', '42f00b'],
    ['profile-level-id=fe002a', 'H264 L4.2', 'fe002a'],
  ]) {
    sdpFmtpLine = fmtp;
    const [row] = await media.getStatsSnapshot();
    assert.deepEqual([row.codecProfile, row.profileLevelId], [profile, raw]);
    assert.equal(row.availableOutgoingBitrate, null);
    assert.equal(row.currentRoundTripTimeMs, null);
  }
});
