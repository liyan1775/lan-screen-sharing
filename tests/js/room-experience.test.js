import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { createRoomExperience } from '../../internal/web/assets/room-experience.js';

async function fixture() {
  const {document, window} = parseHTML(await readFile(new URL('../../internal/web/assets/index.html',import.meta.url),'utf8'));
  document.querySelectorAll('dialog').forEach(dialog => {
    dialog.showModal = () => {dialog.open=true;dialog.setAttribute('open','');};
    dialog.close = value => {dialog.returnValue=value || '';dialog.open=false;dialog.removeAttribute('open');dialog.dispatchEvent(new window.Event('close'));};
  });
  const experience = createRoomExperience(document);
  return {document,window,experience,$:selector=>document.querySelector(selector)};
}

test('volume updates leave an audio row in place and mode changes preserve the player and controls',async()=>{
  const f=await fixture(), {document,experience,$}=f;
  const video=$('#remote-screen'), mic=$('#toggle-mic');
  const seat=document.createElement('article');seat.className='member-seat';seat.dataset.peerId='friend';seat.dataset.seat='left';
  seat.innerHTML='<span class="member-avatar">成</span><strong>朋友</strong><small class="member-status"></small><div class="seat-audio"></div>';
  $('#members').append(seat);
  const row=document.createElement('div');row.className='audio-source';row.dataset.peerId='friend';row.dataset.role='microphone';
  row.innerHTML='<strong>朋友的语音</strong><output></output><input type="range" value="0.35"><button aria-pressed="true">取消静音</button>';
  $('#audio-sources').append(row);
  const state={stage:'voice',memberCount:2,roomName:'房间',microphone:false};
  experience.sync(state);
  let removals=0;
  const remove=row.parentNode.removeChild.bind(row.parentNode);
  row.parentNode.removeChild=node=>{if(node===row)removals++;return remove(node);};
  experience.syncAudio();experience.syncAudio();
  assert.equal(removals,0,'dragging a slider must not detach the active audio row');
  experience.sync({...state,stage:'watch',presenterPeerId:'friend'});
  experience.open('sound-dialog');
  assert.equal($('#audio-sources .audio-source'),row);
  assert.equal(row.querySelector('input').value,'0.35');
  assert.equal(row.querySelector('button').getAttribute('aria-pressed'),'true');
  assert.equal($('#remote-screen'),video);assert.equal($('#toggle-mic'),mic);
});

test('destructive confirmation is cancellable and uses explicit safe and destructive labels',async()=>{
  const {experience,$}=await fixture();
  assert.equal(typeof experience.confirm,'function');
  const result=experience.confirm({title:'结束房间？',description:'所有成员将断开连接。',action:'结束房间'},$('#end-room'));
  assert.equal($('#confirm-dialog').open,true);
  assert.equal($('#confirm-accept').textContent,'结束房间');
  $('#confirm-dialog').close('cancel');assert.equal(await result,false);
});
