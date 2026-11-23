import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { MeshMedia } from '../../internal/web/assets/media.js';
import { bindPushToTalk, captureMicrophone } from '../../internal/web/assets/voice-controls.js';

const microphone = () => ({readyState:'live', enabled:true, stops:0, stop() { this.stops++; this.readyState = 'ended'; }});
const stream = track => ({getTracks: () => [track], getAudioTracks: () => [track]});
const makeMedia = () => new MeshMedia({sendUnacknowledged: () => true});

function addSender(media, peerId, replace = () => {}) {
  const sender = {track:media.microphoneTrack, async replaceTrack(track) {
    await replace(track);
    this.track = track;
  }};
  media.peers.set(peerId, {peerId, voiceSender:sender, pc:{close() {}}});
  return sender;
}

test('a failed microphone swap rolls back every successful sender, including slow senders', async () => {
  const media = makeMedia();
  const old = microphone(), next = microphone();
  await media.setMicrophoneFromCapture(stream(old));
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const slow = addSender(media, 'slow', track => {
    if (track !== next) return;
    assert.equal(track.enabled, false, 'a replacement is muted until all senders confirm');
    started();
    return new Promise(resolve => { release = resolve; });
  });
  const reject = addSender(media, 'reject', track => {
    if (track === next) throw new Error('codec mismatch');
  });
  const switching = media.setMicrophoneFromCapture(stream(next));
  await waiting;
  assert.equal(old.stops, 0);
  release();
  await assert.rejects(switching, {code:'MIC_SWITCH_FAILED'});
  assert.equal(slow.track, old);
  assert.equal(reject.track, old);
  assert.equal(media.microphoneTrack, old);
  assert.equal(old.enabled, true);
  assert.equal(old.stops, 0);
  assert.equal(next.stops, 1);
});

test('a sender that joins during the swap also confirms the new track before the old track is released', async () => {
  const media = makeMedia();
  const old = microphone(), next = microphone();
  await media.setMicrophoneFromCapture(stream(old));
  let newcomer;
  const existing = addSender(media, 'first', track => {
    if (track === next) newcomer = addSender(media, 'new', joiningTrack => {
      assert.equal(joiningTrack, next);
      assert.equal(old.stops, 0);
    });
  });
  await media.setMicrophoneFromCapture(stream(next), () => false);
  assert.equal(existing.track, next);
  assert.equal(newcomer.track, next);
  assert.equal(next.enabled, false, 'press-to-talk remains muted after a swap');
  assert.equal(old.stops, 1);
});

test('leaving during sender updates stops the candidate immediately and does not commit after the update settles', async () => {
  const media = makeMedia();
  const old = microphone(), next = microphone();
  await media.setMicrophoneFromCapture(stream(old));
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  addSender(media, 'slow', track => {
    if (track !== next) return;
    started();
    return new Promise(resolve => { release = resolve; });
  });
  const switching = media.setMicrophoneFromCapture(stream(next));
  await waiting;
  await media.closeAll();
  assert.equal(next.stops, 1);
  assert.equal(old.stops, 1);
  release();
  await assert.rejects(switching, {code:'CAPTURE_CANCELLED'});
  assert.equal(media.microphoneTrack, null);
  assert.equal(next.stops, 1);
});

test('missing saved device falls back only for the current request and never retries a permission denial', async () => {
  const tracks = stream(microphone());
  const calls = [];
  const devices = {async getUserMedia(constraints) {
    calls.push(constraints);
    if (typeof constraints.audio === 'object') throw Object.assign(new Error(), {name:'NotFoundError'});
    return tracks;
  }};
  assert.deepEqual(await captureMicrophone(devices, 'unplugged', () => true), {stream:tracks, deviceId:''});
  assert.deepEqual(calls, [{audio:{deviceId:{exact:'unplugged'}},video:false}, {audio:true,video:false}]);
  await assert.rejects(captureMicrophone(devices, 'unplugged', () => false), {name:'NotFoundError'});
  assert.equal(calls.length, 3);
  devices.getUserMedia = async constraints => {
    calls.push(constraints);
    throw Object.assign(new Error(), {name:'NotAllowedError'});
  };
  await assert.rejects(captureMicrophone(devices, 'unplugged', () => true), {name:'NotAllowedError'});
  assert.equal(calls.length, 4);
});

test('a changed localhost origin recovers a unique remembered device after permission without sending the default track', async () => {
  const temporary = microphone(), preferred = microphone();
  const calls = [];
  const devices = {
    async getUserMedia({audio}) {
      const id = audio?.deviceId?.exact ?? '';
      calls.push(id);
      if (!id) return stream(temporary);
      if (id === 'new-origin-id') return stream(preferred);
      throw Object.assign(new Error(), {name:'NotFoundError'});
    },
    async enumerateDevices() {
      assert.equal(temporary.readyState, 'live', 'permission has revealed device labels');
      return [{kind:'audioinput',deviceId:'new-origin-id',label:'桌面麦克风'}];
    },
  };
  const result = await captureMicrophone(devices, 'old-origin-id', () => true, {label:'桌面麦克风'});
  assert.deepEqual(calls, ['old-origin-id', '', 'new-origin-id']);
  assert.equal(result.deviceId, 'new-origin-id');
  assert.equal(result.stream.getAudioTracks()[0], preferred);
  assert.equal(temporary.stops, 1);
});

test('cancelling a device lookup instantly releases the temporary permission stream', async () => {
  const temporary = microphone(), controller = new AbortController();
  let completeList, listing;
  const started = new Promise(resolve => { listing = resolve; });
  const devices = {
    async getUserMedia({audio}) {
      if (audio === true) return stream(temporary);
      throw Object.assign(new Error(), {name:'NotFoundError'});
    },
    enumerateDevices() {
      listing();
      return new Promise(resolve => { completeList = resolve; });
    },
  };
  const capture = captureMicrophone(devices, 'old-origin-id', () => !controller.signal.aborted,
    {label:'桌面麦克风', signal:controller.signal});
  await started;
  controller.abort();
  assert.equal(temporary.stops, 1);
  completeList([{kind:'audioinput',deviceId:'new-origin-id',label:'桌面麦克风'}]);
  await assert.rejects(capture, {code:'CAPTURE_CANCELLED'});
  assert.equal(temporary.stops, 1);
});

test('push-to-talk releases on keyup, blur and visibility, and leaves editing and native keyboard controls alone', () => {
  const {document, window} = parseHTML('<html><body><button id="ptt">按住说话</button><button id="other"></button><input><textarea></textarea><select></select><div contenteditable><span></span></div><dialog></dialog></body></html>');
  let enabled = true;
  const changes = [];
  const button = document.querySelector('#ptt');
  const controller = bindPushToTalk({document, window, button, canTalk:() => enabled, onChange:value => changes.push(value)});
  function key(type, target = document.body, init = {}) {
    const event = Object.assign(new window.Event(type, {bubbles:true, cancelable:true}), {code:'Space', key:' ', ...init});
    target.dispatchEvent(event);
    return event.defaultPrevented;
  }
  assert.equal(key('keydown'), true);
  assert.equal(key('keyup'), true);
  assert.deepEqual(changes, [true, false]);
  for (const selector of ['#other', 'input', 'textarea', 'select', '[contenteditable] span']) {
    assert.equal(key('keydown', document.querySelector(selector)), false, selector);
  }
  assert.equal(key('keydown', document.body, {isComposing:true}), false);
  assert.equal(key('keydown', document.body, {keyCode:229}), false);
  document.querySelector('dialog').setAttribute('open', '');
  assert.equal(key('keydown'), false);
  document.querySelector('dialog').removeAttribute('open');
  assert.deepEqual(changes, [true, false]);
  key('keydown'); window.dispatchEvent(new window.Event('blur'));
  assert.deepEqual(changes.slice(-2), [true, false]);
  assert.equal(key('keydown', document.body, {repeat:true}), false);
  key('keydown'); document.visibilityState = 'hidden'; document.dispatchEvent(new window.Event('visibilitychange'));
  assert.deepEqual(changes.slice(-2), [true, false]);
  enabled = false; key('keydown'); controller.release();
  enabled = true; document.visibilityState = 'visible';
  assert.equal(key('keydown', document.body, {repeat:true}), false);
  assert.equal(key('keydown', button), false, 'the focused hold button keeps native Space behavior');
  assert.equal(changes.at(-1), true);
  key('keyup', button);
  assert.equal(changes.at(-1), false);
});
