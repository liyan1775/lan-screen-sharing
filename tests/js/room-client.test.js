import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomClient } from '../../internal/web/assets/client.js';

class FakeWebSocket {
  static OPEN = 1;
  static instances = [];
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeWebSocket.instances.push(this); }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  respond(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}

function responseWithin(promise, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label} response`)), 250);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

async function connectedClient(role) {
  FakeWebSocket.instances = [];
  globalThis.location = { protocol: 'http:', host: '127.0.0.1:41000', href: 'http://127.0.0.1:41000/' };
  const bootstrapRequests = [];
  const client = new RoomClient({
    fetchImpl: async (url) => { bootstrapRequests.push(new URL(url)); return { ok: true, json: async () => ({ localWsPath: '/ws/v1', hostControlToken: role === 'host' ? 'local-host-only' : undefined }) }; },
    WebSocketImpl: FakeWebSocket,
  });
  const opening = client.connect({ role });
  await new Promise((resolve) => setImmediate(resolve));
  const socket = FakeWebSocket.instances[0];
  socket.open();
  const auth = socket.sent[0];
  socket.respond({ v: 1, type: 'room.state', requestId: auth.requestId, payload: { members: [], screenSharing: false } });
  await opening;
  return { client, socket, auth, bootstrapRequests };
}

test('roomClientUsesSameOriginSocketAndRoleScopedAuth', async (t) => {
  const host = await connectedClient('host');
  t.after(() => host.client.close());
  assert.equal(host.bootstrapRequests[0].searchParams.get('role'), 'host');
  assert.equal(host.socket.url, 'ws://127.0.0.1:41000/ws/v1');
  assert.deepEqual(host.auth.payload, { role: 'host', hostToken: 'local-host-only' });
  const viewer = await connectedClient('viewer');
  t.after(() => viewer.client.close());
  assert.equal(viewer.bootstrapRequests[0].searchParams.has('role'), false);
  assert.equal(viewer.socket.url, 'ws://127.0.0.1:41000/ws/v1');
  assert.deepEqual(viewer.auth.payload, { role: 'viewer' });
});

test('roomClientShowsActionableErrorWhenLANSignalPortIsOccupied', async (t) => {
	const { client, socket } = await connectedClient('host');
	t.after(() => client.close());
	const create = client.createRoom();
	const request = socket.sent.at(-1);
	socket.respond({ v: 1, type: 'error', requestId: request.requestId, payload: { code: 'PORT_IN_USE', message: 'LAN signaling bind failed', retryable: true } });
	await assert.rejects(create, (error) => error.code === 'PORT_IN_USE' && /端口/.test(error.message));
});

test('localProgramExitNonceLoadsBeforeAHostOrViewerRoleIsChosen', async () => {
  globalThis.location = { protocol: 'http:', host: 'localhost:41000', href: 'http://localhost:41000/' };
  const requests = [];
  const client = new RoomClient({ fetchImpl: async (url) => { requests.push(new URL(url)); return { ok: true, json: async () => ({ localControlToken: 'local-exit-only', roleOptions: ['host', 'viewer'] }) }; } });
  await client.loadLocalControl();
  assert.equal(requests[0].pathname, '/api/v1/bootstrap');
  assert.equal(requests[0].search, '');
  assert.equal(client.bootstrap.localControlToken, 'local-exit-only');
  assert.equal(client.hostControlToken, '');
});

test('roomClientReauthenticatesWhenRoleChanges', async (t) => {
  const host = await connectedClient('host');
  t.after(() => host.client.close());
  const changingRole = host.client.connect({ role: 'viewer' });
  await new Promise((resolve) => setImmediate(resolve));
  const socket = FakeWebSocket.instances.at(-1);
  assert.notEqual(socket, host.socket);
  socket.open();
  const auth = socket.sent[0];
  assert.deepEqual(auth.payload, { role: 'viewer' });
  socket.respond({ v: 1, type: 'room.state', requestId: auth.requestId, payload: { members: [], screenSharing: false } });
  await changingRole;
});

test('roomClientWaitsForServerSnapshotsAndRotatesViewerResumeToken', async (t) => {
  const host = await connectedClient('host');
  t.after(() => host.client.close());
  const creating = host.client.createRoom();
  const createEnvelope = host.socket.sent.at(-1);
  assert.equal(createEnvelope.type, 'host.createRoom');
  host.socket.respond({ v: 1, type: 'room.created', requestId: createEnvelope.requestId, roomId: 'room-1', peerId: 'host-peer', payload: { roomCode: 'ABC23456' } });
  assert.deepEqual(await responseWithin(creating, 'room.created'), { roomId: 'room-1', roomCode: 'ABC23456' });

  const viewer = await connectedClient('viewer');
  t.after(() => viewer.client.close());
  const joining = viewer.client.joinRoom({ hostIPv4: '192.168.1.20', hostPort: 45678, roomCode: 'abc23456', resumeToken: 'old-token' });
  const joinEnvelope = viewer.socket.sent.at(-1);
  assert.equal(joinEnvelope.type, 'viewer.join');
  assert.deepEqual(joinEnvelope.payload, { hostIPv4: '192.168.1.20', hostPort: 45678, roomCode: 'ABC23456', resumeToken: 'old-token' });
  viewer.socket.respond({ v: 1, type: 'room.joined', requestId: joinEnvelope.requestId, roomId: 'room-1', peerId: 'viewer-peer', payload: { roomId: 'room-1', peerId: 'viewer-peer', resumeToken: 'rotated-token', members: [] } });
  const snapshot = await responseWithin(joining, 'room.joined');
  assert.equal(snapshot.peerId, 'viewer-peer');
  assert.equal(viewer.client.resumeToken, 'rotated-token');
});

test('viewerJoinWaitsForRoomJoinedSnapshot', async (t) => {
  const viewer = await connectedClient('viewer');
  t.after(() => viewer.client.close());
  const joining = viewer.client.joinRoom({ hostIPv4: '192.168.1.20', hostPort: 45678, roomCode: 'ABC23456' });
  const envelope = viewer.socket.sent.at(-1);
  viewer.socket.respond({ v: 1, type: 'room.joined', requestId: envelope.requestId, roomId: 'room-2', peerId: 'viewer-2', payload: { roomId: 'room-2', peerId: 'viewer-2', resumeToken: 'resume-2', members: [] } });
  const snapshot = await responseWithin(joining, 'room.joined');
  assert.equal(snapshot.roomId, 'room-2');
  assert.equal(snapshot.peerId, 'viewer-2');
});

test('roomEndedClearsViewerResumeIntentBeforeBridgeClose', async (t) => {
  const viewer = await connectedClient('viewer');
  t.after(() => viewer.client.close());
  viewer.client.room = { roomId: 'room-ended' };
  viewer.client.peerId = 'viewer-peer';
  viewer.client.resumeToken = 'resume-secret';
  viewer.client.joinDetails = { hostIPv4: '192.168.1.20', hostPort: 45678, roomCode: 'ABCD2345', resumeToken: 'resume-secret' };
  viewer.client.reconnectWanted = true;
  viewer.socket.respond({ v: 1, type: 'room.ended', roomId: 'room-ended', payload: { reason: 'ended' } });
  assert.equal(viewer.client.room, null);
  assert.equal(viewer.client.peerId, '');
  assert.equal(viewer.client.resumeToken, '');
  assert.equal(viewer.client.joinDetails, null);
  assert.equal(viewer.client.reconnectWanted, false);
});

test('viewerLeaveAndHostEndPutRoomIdOnlyAtEnvelopeTopLevel', async (t) => {
  const host = await connectedClient('host');
  t.after(() => host.client.close());
  host.client.room = { roomId: 'room-host' };
  const hostEnding = host.client.endRoom();
  const endEnvelope = host.socket.sent.at(-1);
  assert.equal(endEnvelope.type, 'host.endRoom');
  assert.equal(endEnvelope.roomId, 'room-host');
  assert.deepEqual(endEnvelope.payload, {});
  host.socket.respond({ v: 1, type: 'room.ended', requestId: endEnvelope.requestId, roomId: 'room-host', payload: { reason: 'ended' } });
  await responseWithin(hostEnding, 'room.ended');

  const viewer = await connectedClient('viewer');
  t.after(() => viewer.client.close());
  viewer.client.room = { roomId: 'room-viewer' };
  viewer.client.peerId = 'viewer-peer';
  const leaving = viewer.client.leaveRoom();
  const leaveEnvelope = viewer.socket.sent.at(-1);
  assert.equal(leaveEnvelope.type, 'viewer.leave');
  assert.equal(leaveEnvelope.roomId, 'room-viewer');
  assert.deepEqual(leaveEnvelope.payload, {});
  viewer.socket.respond({ v: 1, type: 'peer.left', requestId: leaveEnvelope.requestId, roomId: 'room-viewer', peerId: 'viewer-peer', payload: { peerId: 'viewer-peer', reason: 'left' } });
  await responseWithin(leaving, 'peer.left');
  assert.equal(viewer.client.room, null);
  assert.equal(viewer.client.peerId, '');
  assert.equal(viewer.client.reconnectWanted, false);
});
