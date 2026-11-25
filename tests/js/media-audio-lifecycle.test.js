import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshMedia } from '../../internal/web/assets/media.js';

test('an old remote track ending cannot remove its replacement audio source', t => {
  const previousDocument=globalThis.document, previousStream=globalThis.MediaStream, states=[];
  globalThis.MediaStream=class {constructor(tracks){this.tracks=tracks;}getAudioTracks(){return this.tracks;}};
  globalThis.document={body:{append(){}},createElement(){return {dataset:{},play:()=>Promise.resolve(),remove(){this.removed=true;}};}};
  t.after(()=>{globalThis.document=previousDocument;globalThis.MediaStream=previousStream;});
  const track=()=>({listeners:new Map(),addEventListener(type,callback){this.listeners.set(type,callback);}});
  const a=track(), b=track(), media=new MeshMedia({}, {onState:s=>states.push(s)});
  media.attachAudio('friend','microphone',a);const audio=media.audioElements.get('friend:microphone');
  media.attachAudio('friend','microphone',b);
  a.listeners.get('ended')();assert.equal(media.audioElements.get('friend:microphone'),audio);assert.notEqual(audio.removed,true);
  b.listeners.get('ended')();assert.equal(media.audioElements.size,0);assert.equal(audio.removed,true);assert.equal(states.at(-1).state,'audio_source_ended');
});

test('only NotAllowedError calls for activation and successful playback clears it', async t => {
  const previousDocument = globalThis.document, previousStream = globalThis.MediaStream;
  const states = [], elements = [];
  let initialError = 'AbortError';
  const track = { addEventListener() {} };
  globalThis.MediaStream = class { constructor(tracks) { this.tracks = tracks; } getAudioTracks() { return this.tracks; } };
  globalThis.document = {
    body: { append: audio => elements.push(audio) },
    createElement: () => ({
      dataset: {},
      error: initialError,
      play() { return this.error ? Promise.reject(Object.assign(new Error('play failed'), { name: this.error })) : Promise.resolve(); },
      remove() {},
    }),
  };
  t.after(() => { globalThis.document = previousDocument; globalThis.MediaStream = previousStream; });
  const media = new MeshMedia({}, { onState: s => states.push(s.state) });
  media.attachAudio('friend', 'microphone', track);
  await Promise.resolve();
  assert.deepEqual(states, []);
  initialError = 'NotAllowedError';
  media.attachAudio('other-friend', 'microphone', track);
  await Promise.resolve();
  const audio = elements.at(-1);
  assert.equal(media.blockedAudio.size, 1);
  assert.deepEqual(states, ['autoplay_blocked']);
  assert.equal(await media.resumeAudio(), false);
  audio.error = '';
  assert.equal(await media.resumeAudio(), true);
  assert.deepEqual(states, ['autoplay_blocked', 'autoplay_resumed']);
});
