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
  assert.ok(encodings.every(encoding => encoding.maxFramerate === 60 && encoding.maxBitrate === 8_000_000));
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
