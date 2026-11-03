import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomClient } from '../../internal/web/assets/client.js';
import { MeshMedia } from '../../internal/web/assets/media.js';
import { bindLocalConnectionLifecycle } from '../../internal/web/assets/connection-lifecycle.js';

class FakeWebSocket {
  static OPEN = 1;
  static instances = [];
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeWebSocket.instances.push(this); }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  respond(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
  drop() { this.readyState = 3; this.onclose?.(); }
  close() { this.readyState = 3; this.onclose?.(); }
}

async function connectedClient(role = 'viewer') {
  FakeWebSocket.instances = [];
  globalThis.location = { protocol: 'http:', host: '127.0.0.1:41000', href: 'http://127.0.0.1:41000/' };
  const client = new RoomClient({
    fetchImpl: async () => ({ ok: true, json: async () => ({ localWsPath: '/ws/v1', ...(role === 'host' ? { hostControlToken: 'host-token' } : {}) }) }),
    WebSocketImpl: FakeWebSocket,
  });
  const opening = client.connect({ role });
  await new Promise((resolve) => setImmediate(resolve));
  const socket = FakeWebSocket.instances[0];
  socket.open();
  const auth = socket.sent[0];
  socket.respond({ v: 1, type: 'room.state', requestId: auth.requestId, payload: { members: [] } });
  await opening;
  return { client, socket };
}

function makeTrack() {
  return { stopCount: 0, stop() { this.stopCount += 1; } };
}

test('local websocket loss closes media and clears the production room lifecycle', async (t) => {
  const { client, socket } = await connectedClient();
  t.after(() => client.close());
  client.room = { roomId: 'room-1', members: [] };
  client.peerId = 'viewer-1';
  client.resumeToken = 'resume-1';
  client.joinDetails = { hostIPv4: '192.168.1.4', hostPort: 45678, roomCode: 'ABCDEFGH' };
  client.reconnectWanted = true;
  const media = new MeshMedia(client);
  const screenTrack = makeTrack();
  const pendingTrack = makeTrack();
  const microphoneTrack = makeTrack();
  let peerCloseCount = 0;
  media.screenStream = { getTracks: () => [screenTrack] };
  media.pendingScreenStream = { getTracks: () => [pendingTrack] };
  media.microphoneTrack = microphoneTrack;
  media.peers.set('host-1', { peerId: 'host-1', role: 'host', pc: { close() { peerCloseCount += 1; } } });
  let uiReset = false;
  const uiClosed = new Promise((resolve) => bindLocalConnectionLifecycle(client, media, () => { uiReset = true; resolve(); }));

  socket.drop();
  await uiClosed;

  assert.equal(screenTrack.stopCount, 1);
  assert.equal(pendingTrack.stopCount, 1);
  assert.equal(microphoneTrack.stopCount, 1);
  assert.equal(peerCloseCount, 1);
  assert.equal(media.peers.size, 0);
  assert.equal(client.room, null);
  assert.equal(client.peerId, '');
  assert.equal(client.resumeToken, '');
  assert.equal(client.joinDetails, null);
  assert.equal(client.reconnectWanted, false);
  assert.equal(client.ws, null);
  assert.equal(uiReset, true);
});

test('recoverable LAN bridge loss keeps the local room and media for resume', async (t) => {
  const { client, socket } = await connectedClient();
  t.after(() => client.close());
  client.room = { roomId: 'room-2', members: [] };
  client.peerId = 'viewer-2';
  client.resumeToken = 'resume-2';
  client.joinDetails = { hostIPv4: '192.168.1.4', hostPort: 45678, roomCode: 'ABCDEFGH' };
  client.reconnectWanted = true;
  const media = new MeshMedia(client);
  const microphoneTrack = makeTrack();
  media.microphoneTrack = microphoneTrack;
  let uiResetCount = 0;
  bindLocalConnectionLifecycle(client, media, () => { uiResetCount += 1; });

  socket.respond({ v: 1, type: 'error', payload: { code: 'SIGNAL_CONNECTION_LOST', retryable: true, message: 'bridge lost' } });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(microphoneTrack.stopCount, 0);
  assert.equal(client.room.roomId, 'room-2');
  assert.equal(client.resumeToken, 'resume-2');
  assert.equal(client.reconnectWanted, true);
  assert.equal(uiResetCount, 0);
});

test('host local websocket loss stops screen capture and closes every peer', async (t) => {
  const { client, socket } = await connectedClient('host');
  t.after(() => client.close());
  client.room = { roomId: 'room-host', members: [] };
  client.peerId = 'host-1';
  const media = new MeshMedia(client);
  const screenTrack = makeTrack();
  const systemAudioTrack = makeTrack();
  let peerCloseCount = 0;
  media.screenStream = { getTracks: () => [screenTrack, systemAudioTrack] };
  media.peers.set('viewer-1', { peerId: 'viewer-1', role: 'viewer', pc: { close() { peerCloseCount += 1; } } });
  const cleaned = new Promise((resolve) => bindLocalConnectionLifecycle(client, media, resolve));

  socket.drop();
  await cleaned;

  assert.equal(screenTrack.stopCount, 1);
  assert.equal(systemAudioTrack.stopCount, 1);
  assert.equal(peerCloseCount, 1);
  assert.equal(media.screenStream, null);
  assert.equal(client.room, null);
});
