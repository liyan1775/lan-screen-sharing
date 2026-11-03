import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomText } from '../../internal/web/assets/room-text.js';

function channel() { return {label:'lan-room-text-v1',readyState:'open',bufferedAmount:0,sent:[],send(value){this.sent.push(value);},close(){this.readyState='closed';}}; }
test('room text uses the authenticated peer connection without any media capture and rejects unavailable recipients',()=>{
  const received=[],room=new RoomText({onMessage:message=>received.push(message)}),out=channel();
  const pc={createDataChannel(label,options){assert.equal(label,'lan-room-text-v1');assert.equal(options.ordered,true);return out;}};
  room.addPeer('friend',pc,true);
  const result=room.send(' 不开麦也能聊 ');
  assert.equal(result.sent,1);assert.equal(result.failed,0);assert.equal(JSON.parse(out.sent[0]).text,'不开麦也能聊');
  assert.equal(received.length,0,'only incoming messages are announced as remote');
  out.readyState='connecting';assert.throws(()=>room.send('test'),/连接/);assert.equal(out.sent.length,1);
  room.removePeer('friend');assert.throws(()=>room.send('test'),/加入/);
});
test('incoming text is bounded, attributed to its authenticated channel and safely represented as text',()=>{
  const received=[],room=new RoomText({onMessage:message=>received.push(message)}),pc={},input=channel();
  room.addPeer('actual-peer',pc,false);pc.ondatachannel({channel:input});
  input.onmessage({data:JSON.stringify({v:1,id:'one',text:'<img src=x onerror=alert(1)>',peerId:'forged'})});
  input.onmessage({data:JSON.stringify({v:1,id:'one',text:'duplicate'})});
  input.onmessage({data:JSON.stringify({v:1,id:'two',text:'x'.repeat(501)})});
  input.onmessage({data:'not json'});
  assert.equal(received.length,1);assert.equal(received[0].peerId,'actual-peer');assert.match(received[0].text,/<img/);
  const unexpected=channel();unexpected.label='unknown';pc.ondatachannel({channel:unexpected});assert.equal(unexpected.readyState,'closed');
  room.removePeer('actual-peer');input.onmessage?.({data:JSON.stringify({v:1,id:'three',text:'late'})});assert.equal(received.length,1);
});
