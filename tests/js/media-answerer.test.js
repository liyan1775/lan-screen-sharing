import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshMedia } from '../../internal/web/assets/media.js';

class FakeSender {
  track = null;
  async replaceTrack(track) { this.track = track; }
}

// Models the WebRTC offer path where setRemoteDescription creates the
// transceivers associated with the offered m-lines. Transceivers pre-created
// by addTransceiver remain unassociated and keep mid=null.
class OfferMatchingPC {
  static instances = [];
  signalingState = 'stable';
  transceivers = [];
  constructor() { OfferMatchingPC.instances.push(this); }
  addTransceiver(kind, init) {
    const tx = { kind, direction: init.direction, mid: null, sender: new FakeSender(), receiver: { track: { kind } } };
    this.transceivers.push(tx);
    return tx;
  }
  getTransceivers() { return this.transceivers; }
  async createOffer() { return { type: 'offer', sdp: 'offer' }; }
  async setRemoteDescription(description) {
    this.remoteDescription = description;
    for (const section of description.sections) {
      const tx = { kind: section.kind, direction: 'recvonly', mid: section.mid, sender: new FakeSender(), receiver: { track: { kind: section.kind } } };
      this.transceivers.push(tx);
    }
  }
  async createAnswer() { return { type: 'answer', sdp: 'answer' }; }
  async setLocalDescription(description) {
    if (description.type === 'offer') {
      this.transceivers.forEach((tx, index) => { if (tx.mid == null) tx.mid = String(index); });
    }
    this.localDescription = { ...description, toJSON: () => description };
  }
  close() {}
}

const offerTracks = {
  hostViewer: [
    { mid: '0', role: 'screenVideo' },
    { mid: '1', role: 'systemAudio' },
    { mid: '2', role: 'microphone' },
  ],
  viewerViewer: [{ mid: '0', role: 'microphone' }],
};

function offerSections(tracks) {
  return tracks.map(({ mid, role }) => ({
    mid,
    kind: role === 'screenVideo' ? 'video' : 'audio',
    answerDirection: 'sendrecv',
  }));
}

async function answerAsViewer({ selfId, fromId, fromRole, tracks, microphoneBeforePeer }) {
  const sent = [];
  const media = new MeshMedia({
    sendSignal(type, toPeerId, payload) { sent.push({ type, toPeerId, payload }); },
    sendUnacknowledged() { return true; },
  });
  media.setIdentity(selfId, 'viewer');
  const mic = { kind: 'audio', id: 'local-mic' };
  if (microphoneBeforePeer) await media.setMicrophoneTrack(mic);
  const peer = media.addPeer(fromId, fromRole);
  if (!microphoneBeforePeer) await media.setMicrophoneTrack(mic);
  await media.handleSignal('rtc.description', {
    fromPeerId: fromId,
    description: { type: 'offer', sdp: 'offer', sections: offerSections(tracks) },
    tracks,
  });
  return { media, peer, mic, answer: sent.find((message) => message.type === 'rtc.description') };
}

test('answerer attaches local microphone to negotiated MID for host-viewer and viewer-viewer in both peer orders', async (t) => {
  const originalPC = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = OfferMatchingPC;
  t.after(() => {
    if (originalPC) globalThis.RTCPeerConnection = originalPC;
    else delete globalThis.RTCPeerConnection;
    OfferMatchingPC.instances = [];
  });

  const cases = [
    { name: 'viewer answers host offer, mic pre-enabled', selfId: 'viewer-z', fromId: 'host-a', fromRole: 'host', tracks: offerTracks.hostViewer, microphoneBeforePeer: true, micMid: '2' },
    { name: 'viewer answers host offer, mic enabled after peer creation', selfId: 'viewer-a', fromId: 'host-z', fromRole: 'host', tracks: offerTracks.hostViewer, microphoneBeforePeer: false, micMid: '2' },
    { name: 'higher viewer ID answers lower viewer offer', selfId: 'viewer-z', fromId: 'viewer-a', fromRole: 'viewer', tracks: offerTracks.viewerViewer, microphoneBeforePeer: true, micMid: '0' },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const { peer, mic, answer } = await answerAsViewer(scenario);
      const negotiatedMic = peer.pc.getTransceivers().find((tx) => tx.mid === scenario.micMid);
      assert.ok(negotiatedMic, 'the browser-created microphone m-line exists');
      assert.equal(negotiatedMic.sender.track, mic, 'local microphone sender is attached to negotiated microphone m-line');
      assert.equal(negotiatedMic.direction, 'sendrecv');
      assert.equal(peer.voiceSender, negotiatedMic.sender, 'peer voice sender references the negotiated m-line');
      assert.deepEqual(answer.payload.tracks, scenario.tracks);
      for (const tx of peer.pc.getTransceivers()) {
        if (tx !== negotiatedMic) {
          assert.equal(tx.sender.track, null, 'viewer does not attach microphone to another role or unassociated transceiver');
          assert.equal(tx.direction, 'sendrecv', 'screen slots must also be ready when this member later shares');
        }
      }
      assert.equal(peer.pc.getTransceivers().filter((tx) => tx.mid == null && tx.sender.track).length, 0, 'no unassociated sender carries the microphone');
    });
  }
});

test('lower viewer ID remains the viewer-viewer offerer with its mic on the offered MID', async (t) => {
  const originalPC = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = OfferMatchingPC;
  t.after(() => {
    if (originalPC) globalThis.RTCPeerConnection = originalPC;
    else delete globalThis.RTCPeerConnection;
    OfferMatchingPC.instances = [];
  });
  const sent = [];
  const media = new MeshMedia({ sendSignal(type, toPeerId, payload) { sent.push({ type, toPeerId, payload }); }, sendUnacknowledged() { return true; } });
  media.setIdentity('viewer-a', 'viewer');
  const mic = { kind: 'audio', id: 'local-mic' };
  await media.setMicrophoneTrack(mic);
  const peer = media.addPeer('viewer-z', 'viewer');
  await peer.negotiation;

  assert.equal(peer.pc.getTransceivers().filter((tx) => tx.mid == null).length, 0);
  assert.equal(peer.voiceSender.track, mic);
  assert.deepEqual(sent[0].payload.tracks, [{ mid: '0', role: 'screenVideo' }, { mid: '1', role: 'systemAudio' }, { mid: '2', role: 'microphone' }]);
  assert.equal(peer.screenSender.track, null);
  assert.equal(peer.systemAudioSender.track, null);
});

test('only the member holding the presentation slot publishes screen state, independently of room ownership', async () => {
  const published = [];
  const media = new MeshMedia({ sendUnacknowledged(type, payload) { published.push({ type, payload }); return true; } });
  media.setIdentity('viewer-id', 'viewer');
  await media.setMicrophoneTrack({ kind: 'audio' });
  assert.deepEqual(published, []);

  media.setIdentity('host-id', 'host');
  media.publishMediaState();
  assert.equal(published.length, 0);
  media.setIdentity('viewer-id', 'viewer');
  media.ownsPresentation = true;
  media.screenVideoTrack = { kind: 'video' };
  media.publishMediaState();
  assert.equal(published.length, 1);
  assert.equal(published[0].type, 'media.state');
});
