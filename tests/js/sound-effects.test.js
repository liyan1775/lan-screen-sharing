import test from 'node:test';
import assert from 'node:assert/strict';
import {createRoomSoundEvents, createSoundEffects} from '../../internal/web/assets/sound-effects.js';

test('room chimes are silent before a running context and when muted, with no queued playback', async () => {
  const tones = [], contexts = [];
  const param = () => ({value: 1, setValueAtTime(){}, exponentialRampToValueAtTime(){}});
  class AudioContext {
    state = 'suspended';
    currentTime = 0;
    constructor() { contexts.push(this); }
    createGain() { return {gain: param(), connect(){}}; }
    createOscillator() { return {frequency: param(), connect(){}, start: time => tones.push(time), stop(){}}; }
    async resume() { await Promise.resolve(); this.state = 'running'; }
  }
  const sound = createSoundEffects({AudioContextImpl: AudioContext});
  assert.equal(sound.play('joined'), false);
  sound.setEnabled(false);
  sound.unlock();
  assert.equal(contexts.length, 0);
  sound.setEnabled(true);
  sound.unlock();
  assert.equal(sound.play('joined'), false);
  await Promise.resolve();
  assert.deepEqual(tones, []);
  assert.equal(sound.play('joined'), true);
  assert.equal(tones.length, 2);
  contexts[0].currentTime++;
  assert.equal(sound.play('shared'), true);
  assert.equal(tones.length, 4);
  contexts[0].currentTime++;
  sound.setEnabled(false);
  assert.equal(sound.play('message'), false);
  sound.setEnabled(true);
  assert.equal(tones.length, 4);
  assert.equal(sound.play('message'), true);
  assert.equal(tones.length, 5);
});

test('only fresh peer joins and explicit starts chime; recovery and snapshots stay quiet', () => {
  const played = [], handle = createRoomSoundEvents(kind => played.push(kind));
  const room = {roomId: 'room', members: [{peerId: 'me'}, {peerId: 'existing'}], presentationRevision: 2};
  const signal = (type, {peerId, recovering, recovered, ...payload} = {}) =>
    handle({roomId:'room', type, peerId, recovered, payload}, room, 'me', recovering);
  signal('room.joined');
  signal('peer.joined', {peerId: 'existing'});
  signal('room.state', {screenSharing: true, presentationRevision: 3});
  signal('peer.state', {peerId: 'existing', restartMedia: true});
  signal('room.state', {resumed: true, screenSharing: true, presentationRevision: 4, presentationStarted: true});
  signal('room.state', {screenSharing: true, presentationRevision: 5, presentationStarted: true, recovering: true});
  signal('room.state', {screenSharing: true, presentationRevision: 5, presentationStarted: true});
  signal('peer.joined', {peerId: 'during-recovery', recovering: true});
  signal('peer.joined', {peerId: 'during-recovery'});
  assert.deepEqual(played, []);
  signal('peer.joined', {peerId: 'new-friend'});
  signal('peer.joined', {peerId: 'new-friend'});
  signal('room.state', {screenSharing: true, presentationRevision: 6});
  signal('room.state', {screenSharing: true, presentationRevision: 6, presentationStarted: true});
  signal('room.state', {screenSharing: true, presentationRevision: 6, presentationStarted: true});
  signal('room.state', {screenSharing: true, presentationRevision: 7});
  room.presentationRevision = 7;
  signal('room.joined', {recovered: true, presentationStarted: true});
  assert.deepEqual(played, ['joined', 'shared']);
});
