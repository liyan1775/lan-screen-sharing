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
