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

test('local websocket loss retains capture and resumes the same viewer identity', async (t) => {
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
  let retry, recovered = false;
  const lifecycle = bindLocalConnectionLifecycle(client, media, () => { uiReset = true; }, {
    setTimeoutImpl:callback=>{retry=callback;return 1;},clearTimeoutImpl:()=>{},onRecovered:()=>{recovered=true;},
  });
  t.after(()=>lifecycle.cancel());

  socket.drop();
  assert.equal(client.room.roomId,'room-1');
  assert.equal(uiReset,false);
  const resuming = retry();
  await new Promise(resolve=>setImmediate(resolve));
  const next=FakeWebSocket.instances.at(-1);next.open();
  next.respond({v:1,type:'room.state',requestId:next.sent[0].requestId,payload:{members:[]}});
  await new Promise(resolve=>setImmediate(resolve));
  const join=next.sent.find(message=>message.type==='viewer.join');
  assert.equal(join.payload.resumeToken,'resume-1');
  next.respond({v:1,type:'room.joined',requestId:join.requestId,roomId:'room-1',peerId:'viewer-1',payload:{members:[],resumeToken:'resume-rotated'}});
  await resuming;

  assert.equal(screenTrack.stopCount, 0);
  assert.equal(pendingTrack.stopCount, 0);
  assert.equal(microphoneTrack.stopCount, 0);
  assert.equal(peerCloseCount, 0);
  assert.equal(client.room.roomId,'room-1');
  assert.equal(client.peerId,'viewer-1');
  assert.equal(client.resumeToken,'resume-rotated');
  assert.equal(client.reconnectWanted,true);
  assert.equal(recovered,true);
  assert.equal(uiReset,false);
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
  const lifecycle=bindLocalConnectionLifecycle(client, media, () => { uiResetCount += 1; },{setTimeoutImpl:()=>1,clearTimeoutImpl:()=>{}});
  t.after(()=>lifecycle.cancel());

  socket.respond({ v: 1, type: 'error', payload: { code: 'SIGNAL_CONNECTION_LOST', retryable: true, message: 'bridge lost' } });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(microphoneTrack.stopCount, 0);
  assert.equal(client.room.roomId, 'room-2');
  assert.equal(client.resumeToken, 'resume-2');
  assert.equal(client.reconnectWanted, true);
  assert.equal(uiResetCount, 0);
});

test('host local websocket loss resumes the original room without stopping capture', async (t) => {
  const { client, socket } = await connectedClient('host');
  t.after(() => client.close());
  client.room = { roomId: 'room-host', members: [] };
  client.peerId = 'host-1';
  client.reconnectWanted = true;
  const media = new MeshMedia(client);
  const screenTrack = makeTrack();
  const systemAudioTrack = makeTrack();
  let peerCloseCount = 0;
  media.screenStream = { getTracks: () => [screenTrack, systemAudioTrack] };
  media.peers.set('viewer-1', { peerId: 'viewer-1', role: 'viewer', pc: { close() { peerCloseCount += 1; } } });
  let retry, reset=false;
  const lifecycle=bindLocalConnectionLifecycle(client,media,()=>{reset=true;},{setTimeoutImpl:callback=>{retry=callback;return 1;},clearTimeoutImpl:()=>{}});
  t.after(()=>lifecycle.cancel());

  socket.drop();
  const resuming=retry();await new Promise(resolve=>setImmediate(resolve));
  const next=FakeWebSocket.instances.at(-1);next.open();
  assert.equal(next.sent[0].payload.roomId,'room-host');
  next.respond({v:1,type:'room.state',requestId:next.sent[0].requestId,roomId:'room-host',peerId:'host-1',payload:{resumed:true,members:[]}});
  await resuming;

  assert.equal(screenTrack.stopCount, 0);
  assert.equal(systemAudioTrack.stopCount, 0);
  assert.equal(peerCloseCount, 0);
  assert.equal(client.room.roomId,'room-host');
  assert.equal(reset,false);
});

test('recovery deadline stops capture and a cancelled recovery cannot restore a room', async()=>{
  class Client extends EventTarget {
    room={roomId:'room'};reconnectWanted=true;explicitlyLeaving=false;
    cancelRecovery(){this.reconnectWanted=false;}
    close(){this.transportClosed=true;}
    async recoverRoom(){throw new Error('temporarily offline');}
  }
  const client=new Client();let time=0,retry,closed=0,reset=0;
  const lifecycle=bindLocalConnectionLifecycle(client,{closeAll:async()=>{closed++;}},()=>{reset++;},{now:()=>time,windowMs:100,setTimeoutImpl:cb=>{retry=cb;return 1;},clearTimeoutImpl:()=>{}});
  lifecycle.recover();time=101;await retry();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(closed,1);assert.equal(reset,1);assert.equal(client.room,null);
  assert.equal(client.transportClosed,true,'the recovery deadline also closes the old signaling transport');
  lifecycle.cancel();
});
