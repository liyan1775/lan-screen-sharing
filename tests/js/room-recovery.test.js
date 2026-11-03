import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomClient} from '../../internal/web/assets/client.js';

function storage() {const values=new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};}
function joined(role,cache) {
  const client=new RoomClient({storageImpl:cache});client.bootstrap={serviceId:'service-one'};client.role=role;
  client.room={roomId:'original-room'};client.peerId='original-peer';client.reconnectWanted=true;
  if(role==='viewer') {client.resumeToken='current-token';client.joinDetails={hostIPv4:'192.168.1.20',hostPort:45678,roomCode:'ABCD2345'};}
  return client;
}

test('refresh restores only the same local service and stores no host control credential',()=>{
  for(const role of ['host','viewer']) {
    const cache=storage(),before=joined(role,cache);before.hostControlToken='never-store-this';before.saveSession();
    const raw=cache.getItem('lan-screen-sharing.room');assert.ok(raw);assert.equal(raw.includes('never-store-this'),false);
    const after=new RoomClient({storageImpl:cache});after.bootstrap={serviceId:'service-one'};
    assert.equal(after.prepareRestore(),true);assert.equal(after.role,role);assert.equal(after.room.roomId,'original-room');assert.equal(after.peerId,'original-peer');
    if(role==='viewer')assert.equal(after.resumeToken,'current-token');
    const restarted=new RoomClient({storageImpl:cache});restarted.bootstrap={serviceId:'different-process'};assert.equal(restarted.prepareRestore(),false);assert.equal(cache.getItem('lan-screen-sharing.room'),null);
  }
});

test('explicit leave intent removes the refresh session and delayed recovery cannot restore it',async()=>{
  const cache=storage(),client=joined('host',cache);client.saveSession();
  let complete;
  client.connect=()=>new Promise(resolve=>{complete=resolve;});
  const pending=client.recoverRoom();client.cancelRecovery();complete();
  await assert.rejects(pending,error=>error.code==='RECOVERY_CANCELLED');assert.equal(client.reconnectWanted,false);assert.equal(cache.getItem('lan-screen-sharing.room'),null);
  client.room=null;
  client.receive(JSON.stringify({v:1,type:'room.joined',requestId:'expired-request',roomId:'original-room',peerId:'original-peer',payload:{members:[],resumeToken:'late-token'}}));
  assert.equal(client.room,null,'a late acknowledgement after cancellation cannot restore the room');
});

test('corrupted or blocked browser storage does not break normal application startup',()=>{
  const cache=storage();cache.setItem('lan-screen-sharing.room','{bad json');
  const client=new RoomClient({storageImpl:cache});client.bootstrap={serviceId:'service-one'};
  assert.equal(client.prepareRestore(),false);
  const blocked=joined('host',{setItem(){throw new Error('blocked');},getItem(){throw new Error('blocked');},removeItem(){throw new Error('blocked');}});
  assert.doesNotThrow(()=>blocked.saveSession());assert.equal(blocked.prepareRestore(),false);
});
