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

test('sound settings ignore a reserved system slot during silent sharing and restore it when audio is published', async () => {
  const { document, experience, $ } = await fixture();
  for (const role of ['microphone', 'systemAudio']) {
    const row = document.createElement('div');
    row.className = 'audio-source';
    Object.assign(row.dataset, { role, peerId: 'friend' });
    $('#audio-stash').append(row);
  }
  const state = { stage: 'watch', roomId: 'room', presenterPeerId: 'friend', screenSharing: true };
  const system = $('.audio-source[data-role=systemAudio]');
  experience.sync({ ...state, hasSystemAudio: false });
  experience.open('sound-dialog');
  assert.equal(system.hidden, true);
  assert.equal(system.parentElement.id, 'audio-stash');
  assert.equal($('#audio-filter').hidden, true);
  assert.equal($('#audio-sources').children.length, 1);

  experience.sync({ ...state, hasSystemAudio: true });
  assert.equal(system.hidden, false);
  assert.equal(system.parentElement.id, 'audio-sources');
  assert.equal($('#audio-filter').hidden, false);
  $('[data-audio-filter=systemAudio]').click();
  assert.equal($('[data-audio-filter=systemAudio]').getAttribute('aria-pressed'), 'true');

  experience.sync({ ...state, hasSystemAudio: false });
  assert.equal(system.hidden, true);
  assert.equal($('#audio-filter').hidden, true);
  assert.equal($('[data-audio-filter=systemAudio]').getAttribute('aria-pressed'), 'true', 'a temporarily unavailable source must not reset the saved filter');
  assert.equal($('.audio-source[data-role=microphone]').hidden, false);
  experience.sync({ ...state, hasSystemAudio: true });
  assert.equal($('.audio-source[data-role=microphone]').hidden, true);
});

test('room notices distinguish voice retry, name one failed member, and clear once connected', async () => {
  const { experience, $ } = await fixture();
  const state = { stage: 'voice', roomId: 'room', memberCount: 3 };
  experience.sync(state);
  assert.equal($('#voice-connection').hidden, true, 'a healthy join is quiet');
  experience.sync({ ...state, voiceConnection: 'connecting' });
  assert.equal($('#voice-connection').hidden, false);
  assert.equal($('#voice-connection-message').textContent, '正在连接语音…');
  assert.equal($('#retry-voice').hidden, true);
  assert.equal($('#topbar-room-count').textContent, '3 人');
  const failedVoicePeers = [{peerId:'friend', name:'小夏'}];
  experience.sync({ ...state, voiceConnection: 'failed', needsAudioActivation: true, failedVoicePeers });
  assert.equal($('#voice-connection-message').textContent, '与 小夏 的语音未连上，你仍在房间内。');
  assert.equal($('#retry-voice').hidden, false);
  assert.equal($('#retry-voice').textContent, '重试语音连接');
  assert.equal($('#enable-audio').hidden, false);
  experience.sync({ ...state, voiceConnection:'failed', failedVoicePeers:[...failedVoicePeers, {peerId:'friend-two', name:'阿立'}] });
  assert.equal($('#voice-connection-message').textContent, '部分成员的语音未连上，你仍在房间内。');
  assert.equal($('#start-share').hidden, false);
  experience.sync(state);
  assert.equal($('#enable-audio').hidden, true);
  assert.equal($('#voice-connection').hidden, true);
  assert.equal($('#voice-connection-message').textContent, '');
});

test('voice member controls precede the sharing area in reading and keyboard order',async()=>{
  const {document,experience,$}=await fixture();
  for (const name of ['left','right','near']) {
    const seat=document.createElement('article');seat.className='member-seat';seat.dataset.seat=name;
    seat.dataset.empty='true';seat.innerHTML='<span class="member-avatar">+</span><strong>空位</strong><small class="member-status"></small><div class="seat-audio"></div>';
    $('#members').append(seat);
  }
  experience.sync({stage:'voice',memberCount:1,roomName:'房间',microphone:false});
  assert.deepEqual([...$('#members').children].map(node=>node.dataset.seat || node.id),['left','right','near','voice-activity']);
  assert.equal($('#voice-activity #start-share')?.id,'start-share');
});

test('invitation focus wraps through visible controls when connection details are collapsed or expanded',async()=>{
  const {document,window,experience,$}=await fixture();
  experience.sync({stage:'voice',memberCount:1,roomName:'房间',microphone:false});
  $('.manual-invite').setAttribute('open','');
  const dialog=$('#invite-dialog'), close=dialog.querySelector('[data-close-dialog]');
  let focused=close;
  Object.defineProperty(document,'activeElement',{configurable:true,get:()=>focused});
  for (const control of dialog.querySelectorAll('button,input,summary')) {
    Object.defineProperty(control,'tabIndex',{configurable:true,value:0});
    control.getClientRects=()=>[{}]; control.focus=()=>{focused=control;};
  }
  const tab=shiftKey=>{
    const event=new window.Event('keydown',{bubbles:true,cancelable:true});
    Object.assign(event,{key:'Tab',shiftKey});dialog.dispatchEvent(event);
  };
  tab(true);assert.ok(focused===$('.invite-details > summary'),'closed connection fields are excluded even if they report rectangles');
  tab(false);assert.ok(focused===close);
  $('.invite-details').setAttribute('open','');
  tab(true);assert.ok(focused===$('#host-port'),'expanded connection fields remain keyboard accessible');
  tab(false);assert.ok(focused===close);
});
