import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenRelay } from '../../internal/web/assets/screen-relay.js';

class PC {
  static instances = [];
  iceGatheringState = 'complete';
  senders = [];
  constructor() { PC.instances.push(this); }
  addTransceiver() { const sender={track:null,async replaceTrack(track){this.track=track;}}; this.senders.push(sender); return {sender}; }
  getSenders() { return this.senders; }
  async createOffer() { return {type:'offer',sdp:'synthetic-offer'}; }
  async setLocalDescription(value) { this.localDescription={...value,toJSON:()=>value}; }
  async setRemoteDescription(value) { this.remoteDescription=value; }
  async getStats() { return new Map([['local',{type:'candidate-pair',state:'succeeded',nominated:true,availableOutgoingBitrate:16_000_000}]]); }
  close() { this.closed=true; }
}
function fixture(t, request) {
  const original=globalThis.RTCPeerConnection; globalThis.RTCPeerConnection=PC; PC.instances=[];
  t.after(()=>{if(original)globalThis.RTCPeerConnection=original;else delete globalThis.RTCPeerConnection;});
  const signals=[],calls=[],closed=[];
  const client={sendSignal:(...args)=>signals.push(args),async requestScreenRelay(payload,options){calls.push(payload);return request?.(payload,options)??{sessionId:'session',description:{type:'answer',sdp:'synthetic-answer'}};}};
  const relay=new ScreenRelay(client,{peerIds:()=>['presenter','viewer'],presenter:()=>'presenter',applyQuality:async()=>{},onTrack(){},onViewClosed:id=>closed.push(id),onError(){}});
  return {relay,signals,calls,closed};
}
test('two viewers share one publisher; stopping detaches senders but never stops borrowed capture tracks',async t=>{
  const {relay,signals,calls}=fixture(t);
  const video={kind:'video',stop(){assert.fail('relay must not stop the capture track');}},audio={kind:'audio'};
  await Promise.all([relay.start(video,audio),relay.start(video,audio)]);
  assert.equal(PC.instances.length,1); assert.equal(calls.filter(call=>call.action==='start').length,1);
  assert.equal(PC.instances[0].senders[0].track,video);
  relay.announce();assert.equal(signals.length,2);assert.ok(signals.every(signal=>signal[0]==='screen.ready'));
  await relay.updateAudio(null);assert.equal(PC.instances[0].senders[1].track,null);
  await relay.close();assert.ok(PC.instances[0].closed);assert.ok(PC.instances[0].senders.every(sender=>sender.track===null));
  assert.equal(calls.at(-1).action,'stop');
});

test('a publisher waits for the local transport budget before attaching its capture tracks',async t=>{
  const {relay}=fixture(t);
  const original=PC.prototype.getStats;
  let hasBudget=false,queried=false;
  PC.prototype.getStats=async function(){queried=true;return hasBudget?original.call(this):new Map();};
  t.after(()=>{PC.prototype.getStats=original;});
  const video={kind:'video'},audio={kind:'audio'};
  const started=relay.start(video,audio);
  while(!queried)await new Promise(resolve=>setImmediate(resolve));
  assert.ok(PC.instances[0].senders.every(sender=>sender.track===null),'capture stays detached while the transport has no bandwidth feedback');
  hasBudget=true;await started;
  assert.equal(PC.instances[0].senders[0].track,video);assert.equal(PC.instances[0].senders[1].track,audio);
  await relay.close();
});
test('receiver negotiation is restricted to the authenticated presenter and current epoch',async t=>{
  const {relay,signals,closed}=fixture(t);
  await relay.handle('screen.ready',{fromPeerId:'stranger',epoch:'one'});await relay.handle('screen.ready',{fromPeerId:'viewer',epoch:'one'});
  assert.equal(PC.instances.length,0);
  await relay.handle('screen.ready',{fromPeerId:'presenter',epoch:'one'});await relay.handle('screen.ready',{fromPeerId:'presenter',epoch:'one'});
  assert.equal(PC.instances.length,1);assert.equal(signals.length,1);
  await relay.handle('screen.description',{fromPeerId:'presenter',epoch:'old',description:{type:'answer',sdp:'stale'}});
  assert.equal(PC.instances[0].remoteDescription,undefined);
  await relay.handle('screen.description',{fromPeerId:'presenter',epoch:'one',description:{type:'answer',sdp:'current'}});
  assert.equal(PC.instances[0].remoteDescription.sdp,'current');relay.syncPresenter('');assert.deepEqual(closed,['presenter']);
});
test('leaving during a publisher request aborts it and cannot resurrect its local PC',async t=>{
  let resolveRequest, signal;
  const {relay,calls}=fixture(t,(payload,options)=>payload.action==='start'?new Promise(resolve=>{resolveRequest=resolve;signal=options.signal;}):undefined);
  const start=relay.start({kind:'video'},null);
  while(!resolveRequest)await new Promise(resolve=>setImmediate(resolve));
  await relay.stopSource();assert.ok(signal.aborted);assert.ok(PC.instances[0].closed);
  resolveRequest({sessionId:'late',description:{type:'answer',sdp:'late'}});await start;
  assert.equal(relay.source,null);assert.equal(PC.instances[0].remoteDescription,undefined);assert.equal(calls.at(-1).sessionId,'late');
});

test('a failed local transport cannot report a successfully started publisher',async t=>{
  const {relay}=fixture(t);
  const original=PC.prototype.getStats;
  PC.prototype.getStats=async function(){this.connectionState='failed';this.onconnectionstatechange();return new Map();};
  t.after(()=>{PC.prototype.getStats=original;});
  await assert.rejects(relay.start({kind:'video'},null),/本机媒体连接中断/);
  assert.equal(relay.source,null);assert.ok(PC.instances[0].closed);
});
