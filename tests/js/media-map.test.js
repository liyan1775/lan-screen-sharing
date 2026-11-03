import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshMedia, mapRemoteTrack, formatActualStats } from '../../internal/web/assets/media.js';

test('screenAudioAndMicRemainSeparate', () => {
  const stream = { id: 'random-stream-id' };
  const video = { kind: 'video' };
  const system = { kind: 'audio', id: 'system' };
  const mic = { kind: 'audio', id: 'mic' };
  const mappedVideo = mapRemoteTrack({ fromPeerId: 'p-screen', mid: '0', role: 'screenVideo', track: video, stream });
  assert.equal(mappedVideo.target, 'screen');
  assert.equal(mappedVideo.sourcePeerId, 'p-screen');
  assert.deepEqual(mappedVideo.stream.getTracks(), [video]);
  assert.equal(mapRemoteTrack({ fromPeerId: 'p-screen', mid: '1', role: 'systemAudio', track: system, stream }).target, 'system-audio');
  assert.equal(mapRemoteTrack({ fromPeerId: 'p-mic', mid: '2', role: 'microphone', track: mic, stream }).sourcePeerId, 'p-mic');
});

test('hostCanStopScreenWithoutEndingVoice', async () => {
  class FakeSender {
    track = null;
    async replaceTrack(track) { this.track = track; }
  }
  class FakePC {
    closed = false;
    signalingState = 'stable';
    transceivers = [];
    addTransceiver(kind, init) {
      const tx = { kind, direction: init.direction, sender: new FakeSender(), mid: String(this.transceivers.length) };
      this.transceivers.push(tx); return tx;
    }
    getTransceivers() { return this.transceivers; }
    async createOffer() { return { type: 'offer', sdp: 'fake' }; }
    async setLocalDescription(description) { this.localDescription = { ...description, toJSON: () => description }; }
    close() { this.closed = true; }
  }
  const originalPC = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = FakePC;
  try {
    const media = new MeshMedia({ sendSignal() {}, sendUnacknowledged() { return Promise.resolve(true); } });
    media.setIdentity('host-peer', 'host');
    const peer = media.addPeer('viewer-peer', 'viewer');
    const voiceSender = peer.voiceSender;
    const micTrack = { kind: 'audio' };
    await media.setMicrophoneTrack(micTrack);
    const screenTrack = { kind: 'video', addEventListener() {}, stop() {} };
    const stream = { getVideoTracks: () => [screenTrack], getAudioTracks: () => [], getTracks: () => [screenTrack] };
    await media.setScreenStream(stream);
    await media.setScreenStream(null);
    assert.equal(peer.pc.closed, false);
    assert.equal(peer.voiceSender, voiceSender);
    assert.equal(peer.pc.transceivers.find((tx) => tx.__trackRole === 'microphone').sender.track, micTrack);
    const viewer = new MeshMedia({ sendSignal() {}, sendUnacknowledged() { return Promise.resolve(true); } });
    viewer.setIdentity('viewer-peer', 'viewer');
    const viewerPeer = viewer.addPeer('z-viewer', 'viewer');
    assert.equal(viewerPeer.voiceSender.track, null);
    assert.equal(viewerPeer.pc.transceivers[0].direction, 'sendrecv');
    assert.equal(viewerPeer.pc.transceivers.length, 3);
    media.setAudioIsolationState({ state: 'manual_pass', label: '本房间用户手工确认', verified: true });
    await media.closeAll();
    assert.deepEqual(media.isolation, { state: 'unverified', label: '未验证', verified: false });
  } finally {
    if (originalPC) globalThis.RTCPeerConnection = originalPC;
    else delete globalThis.RTCPeerConnection;
  }
});

test('statsShowActualResolutionFpsAndBitrate', () => {
  const text = formatActualStats({ width: 1920, height: 1080, fps: 59.8, bitrate: 8123456, droppedFrames: 4 });
  assert.equal(text, '实际 1920×1080 · 59.8 FPS · 8.1 Mbps · 丢帧 4');
});
