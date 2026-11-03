import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshMedia } from '../../internal/web/assets/media.js';
import { RoomClient } from '../../internal/web/assets/client.js';

const track = (kind) => ({ kind, readyState: 'live', stopped: false, getSettings: () => ({}), addEventListener() {}, stop() { this.stopped = true; this.readyState = 'ended'; } });
const stream = (video) => ({ getVideoTracks: () => [video], getAudioTracks: () => [], getTracks: () => [video] });

test('an ordinary member can claim and share without touching microphone or peer connection', async () => {
  const messages = [];
  let claimed = 0;
  const media = new MeshMedia({ async claimPresentation() { claimed++; }, sendUnacknowledged(type, payload) { messages.push({type,payload}); } });
  media.setIdentity('ordinary-member','viewer');
  const mic = track('audio'); media.microphoneTrack = mic;
  const sent = [];
  media.peers.set('other-member', { role:'viewer', screenSender:{async replaceTrack(t) {sent.push(t);}}, systemAudioSender:{async replaceTrack() {}}, pc:{close() {assert.fail('sharing must preserve voice PC');}} });
  const video = track('video');
  await media.setScreenStream(stream(video));
  assert.equal(claimed,1);
  assert.equal(sent[0],video);
  assert.equal(messages.at(-1).payload.screenSharing,true);
  await media.setScreenStream(null);
  assert.equal(sent.at(-1),null);
  assert.equal(mic.stopped,false);
  assert.equal(media.microphoneTrack,mic);
  assert.equal(video.stopped,true);
  assert.equal(messages.at(-1).payload.screenSharing,false);
});

test('a busy sharing slot closes the declined capture and leaves voice intact', async () => {
  const media = new MeshMedia({ async claimPresentation() {throw Object.assign(new Error('busy'),{code:'SHARE_BUSY'});},sendUnacknowledged() {assert.fail('busy member cannot publish');} });
  media.setIdentity('member','viewer');
  const video=track('video'); const mic=track('audio'); media.microphoneTrack=mic;
  await assert.rejects(media.setScreenStream(stream(video)),{code:'SHARE_BUSY'});
  assert.equal(video.stopped,true);
  assert.equal(media.screenStream,null);
  assert.equal(mic.stopped,false);
});

test('late presentation grant after leaving is released and cannot resurrect capture', async () => {
  let resolveClaim, released=0;
  const media=new MeshMedia({ claimPresentation:()=>new Promise(resolve=>{resolveClaim=resolve;}),async releasePresentation(){released++;},sendUnacknowledged(){} });
  media.setIdentity('member','viewer');
  const video=track('video'); const sharing=media.setScreenStream(stream(video));
  await media.closeAll();
  assert.equal(video.stopped,true,'leaving must stop capture immediately, before a delayed grant arrives');
  resolveClaim();
  await assert.rejects(sharing,{code:'CAPTURE_CANCELLED'});
  assert.equal(video.stopped,true); assert.equal(media.screenStream,null); assert.equal(released,1);
});

test('bridge loss rejects a pending presentation grant even without a correlated request ID', () => {
  const client=new RoomClient(); let failure;
  client.pending.set('claim',{type:'share.claim',reject(error){failure=error;}});
  client.receive(JSON.stringify({v:1,type:'error',payload:{code:'SIGNAL_CONNECTION_LOST',retryable:true}}));
  assert.equal(failure.code,'SIGNAL_CONNECTION_LOST'); assert.equal(client.pending.size,0);
});

test('a sender failure closes captured tracks and releases the share slot while preserving voice', async () => {
  let released=0;
  const media=new MeshMedia({ async claimPresentation(){}, async releasePresentation(){released++;},sendUnacknowledged(){} });
  media.setIdentity('member','viewer');
  const video=track('video'), mic=track('audio'); media.microphoneTrack=mic;
  media.peers.set('peer',{screenSender:{async replaceTrack(value){if(value)throw new Error('sender failed');}},systemAudioSender:{async replaceTrack(){}}});
  await assert.rejects(media.setScreenStream(stream(video)), /sender failed/);
  assert.equal(video.stopped,true); assert.equal(media.screenStream,null); assert.equal(released,1); assert.equal(mic.stopped,false);
});

test('voice-only mutes game audio and video but retains participant voices and user mute preferences', () => {
  const media=new MeshMedia({sendUnacknowledged(){}});
  const game={dataset:{trackRole:'systemAudio',sourcePeerId:'presenter'},muted:false,userMuted:false};
  const voice={dataset:{trackRole:'microphone',sourcePeerId:'presenter'},muted:false};
  const video=track('video');
  media.audioElements.set('presenter:systemAudio',game); media.audioElements.set('presenter:microphone',voice);
  media.remoteScreens.set('presenter',stream(video)); media.setPresenter('presenter');
  media.setVoiceOnly(true); assert.equal(game.muted,true); assert.equal(voice.muted,false); assert.equal(video.enabled,false);
  media.setVoiceOnly(false); assert.equal(game.muted,false); assert.equal(video.enabled,true);
  media.setAudioControl('presenter','systemAudio',{muted:true}); media.setVoiceOnly(true); media.setVoiceOnly(false); assert.equal(game.muted,true);
});
