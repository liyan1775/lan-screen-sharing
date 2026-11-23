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

test('reaction whitelist, deduplication and rate limits are independent from text', () => {
  const messages = [], reactions = [];
  let now = 2000;
  const room = new RoomText({now: () => now, onMessage: m => messages.push(m), onReaction: r => reactions.push(r)});
  const input = channel();
  room.addPeer('actual-peer', {createDataChannel: () => input}, true);
  const incoming = data => input.onmessage({data: JSON.stringify({v: 1, ...data})});
  const react = (id, emoji, extra = {}) => incoming({id, kind: 'reaction', emoji, ...extra});
  react('bad', '🧨');
  react('old-unsafe', '🔥', {text: 'must never become a chat message'});
  react('unique', '👏', {peerId: 'spoofed'});
  react('too-fast', '👍');
  for (let i = 0; i < 12; i++) react('burst' + i, '🔥');
  incoming({id: 'unique', text: 'same ID belongs to a different packet kind'});
  assert.equal(messages.length, 1);
  assert.deepEqual(reactions, [{peerId:'actual-peer', id:'unique', emoji:'👏'}]);
  now += 700;
  react('unique', '👏');
  react('too-fast', '👍');
  react('second', '😂');
  assert.equal(reactions.length, 2);
  assert.equal(reactions[1].emoji, '😂');
  incoming({id:'unknown', kind:'unknown', text:'ignored'});
  assert.equal(messages.length, 1);
});

test('reactions drop congested or unready peers and send only the versioned emoji packet', () => {
  let now = 1000;
  const room = new RoomText({now: () => now});
  const first = channel(), second = channel();
  first.bufferedAmount = 8000;
  second.readyState = 'connecting';
  for (const [name, target] of [['first', first], ['second', second]]) room.addPeer(name, {createDataChannel: () => target}, true);
  assert.equal(room.sendReaction('👏'), null);
  second.readyState = 'open';
  const result = room.sendReaction('🔥');
  assert.deepEqual(JSON.parse(second.sent[0]), {v:1, id:result.id, kind:'reaction', emoji:'🔥'});
  assert.equal(first.sent.length, 0);
  assert.equal(room.sendReaction('👍'), null);
  assert.equal(room.send('still works').sent, 2);
  now += 700;
  assert.equal(room.sendReaction('outside whitelist'), null);
  assert.ok(room.sendReaction('👍'));
});
