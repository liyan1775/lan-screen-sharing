import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomClient } from '../../internal/web/assets/client.js';
import { MeshMedia } from '../../internal/web/assets/media.js';
import { PageLease } from '../../internal/web/assets/page-lease.js';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';

class FakeElement {
  constructor(id = '') {
    this.id = id; this.dataset = {}; this.attributes = new Map(); this.listeners = new Map();
    this.classList = { add() {}, remove() {}, toggle() {} };
    this.hidden = false; this.disabled = false; this.textContent = ''; this.value = '';
    this.children = [];
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  async click() { return this.listeners.get('click')?.({ currentTarget: this }); }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  remove() {}
  closest() { return new FakeElement('invite-card'); }
  querySelectorAll() { return []; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  play() { return Promise.resolve(); }
  pause() {}
}

class FakeWebSocket {
  static OPEN = 1;
  static instances = [];
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeWebSocket.instances.push(this); }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  respond(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}

async function until(predicate) {
  for (let i = 0; i < 30 && !predicate(); i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(predicate(), true, 'expected lifecycle action did not reach the fake websocket');
}

test('member UI joins a discovered room in one click and preserves mic across sharing, leave/rejoin and recovery', async (t) => {
  const previous = {
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    location: globalThis.location, fetch: globalThis.fetch, WebSocket: globalThis.WebSocket,
    setInterval: globalThis.setInterval, setTimeout: globalThis.setTimeout,
  };
  const microphones = [];
  let nextSystemAudio = null;
  let displayConstraints;
  const { document, window } = parseHTML(await readFile(new URL('../../internal/web/assets/index.html', import.meta.url), 'utf8'));
  // Exercise the production DOM, retaining an awaitable click for asynchronous app handlers.
  const clicks = new WeakMap();
  const addListener = window.HTMLElement.prototype.addEventListener;
  window.HTMLElement.prototype.addEventListener = function(type, listener, options) {
    if (type === 'click') {
      const listeners = clicks.get(this) || []; listeners.push(listener); clicks.set(this, listeners);
    } else addListener.call(this, type, listener, options);
  };
  window.HTMLElement.prototype.click = async function() {
    if (this.disabled) return;
    for (const listener of clicks.get(this) || []) await listener({ currentTarget: this, target: this, preventDefault() {} });
  };
  window.HTMLElement.prototype.play = () => Promise.resolve();
  window.HTMLElement.prototype.pause = () => {};
  document.querySelectorAll('form').forEach(form => { form.reportValidity = () => true; });
  document.querySelectorAll('select').forEach(select => Object.defineProperty(select, 'value', { configurable: true, writable: true, value: select.querySelector('option[selected],option')?.value || '' }));
  document.querySelectorAll('dialog').forEach(dialog => {
    dialog.showModal = () => { dialog.open = true; dialog.setAttribute('open', ''); };
    dialog.close = () => { dialog.open = false; dialog.removeAttribute('open'); dialog.dispatchEvent(new window.Event('close')); };
  });
  let mediaInstance;
  let appClient;
  const originalCloseAll = MeshMedia.prototype.closeAll;
  const originalSetMicrophoneFromCapture = MeshMedia.prototype.setMicrophoneFromCapture;
  const originalLoadLocalControl = RoomClient.prototype.loadLocalControl;
  const originalLeaseStart = PageLease.prototype.start;
  PageLease.prototype.start = async () => {}; // Page presence is independently tested; this test only uses fake room sockets.
  MeshMedia.prototype.closeAll = function (...args) { mediaInstance = this; return originalCloseAll.apply(this, args); };
  MeshMedia.prototype.setMicrophoneFromCapture = function (...args) { mediaInstance = this; return originalSetMicrophoneFromCapture.apply(this, args); };
  RoomClient.prototype.loadLocalControl = function (...args) { appClient = this; return originalLoadLocalControl.apply(this, args); };
  globalThis.document = document;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: {
    calls: 0,
    getUserMedia() {
      this.calls += 1;
      const microphone = { stopCount: 0, stop() { this.stopCount += 1; } };
      microphones.push(microphone);
      return Promise.resolve({ getAudioTracks: () => [microphone], getTracks: () => [microphone] });
    },
    getDisplayMedia(constraints) {
      displayConstraints = constraints;
      const video = { readyState:'live', stopped:false, getSettings:()=>({displaySurface:'monitor',width:1920,height:1080,frameRate:60}), addEventListener(){}, stop(){this.stopped=true;this.readyState='ended';} };
      return Promise.resolve({getVideoTracks:()=>[video],getAudioTracks:()=>nextSystemAudio?[nextSystemAudio]:[],getTracks:()=>nextSystemAudio?[video,nextSystemAudio]:[video]});
    },
  } } });
  globalThis.location = { protocol: 'http:', host: '127.0.0.1:41000', href: 'http://127.0.0.1:41000/' };
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/api/v1/rooms')) return {ok:true,json:async()=>({available:true,rooms:[{id:'found-room',name:'一起玩',hostIPv4:'192.168.1.20',hostPort:45678,roomCode:'ABCD2345',members:1,capacity:3}]})};
    return { ok: true, json: async () => ({ localWsPath: '/ws/v1',localControlToken:'test-local-control' }) };
  };
  let statsTick, copiedReport;
  globalThis.navigator.clipboard = { async writeText(text) { copiedReport = text; } };
  globalThis.setInterval = (callback, ms) => { if (ms === 2000) statsTick = callback; return 1; };
  globalThis.setTimeout = () => 1;
  t.after(() => {
    MeshMedia.prototype.closeAll = originalCloseAll;
    MeshMedia.prototype.setMicrophoneFromCapture = originalSetMicrophoneFromCapture;
    RoomClient.prototype.loadLocalControl = originalLoadLocalControl;
    PageLease.prototype.start = originalLeaseStart;
    for (const [key, value] of Object.entries(previous)) {
      if (key === 'document' || key === 'navigator') {
        if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key];
      } else globalThis[key] = value;
    }
  });

  await import(`../../internal/web/assets/app.js?mic-lifecycle=${Date.now()}`);
  assert.ok(appClient);
  const toggle = document.querySelector('#toggle-mic');
  toggle.textContent = '开启麦克风'; toggle.dataset.enabled = 'false';
  const choose = document.querySelector('#choose-viewer');
  await until(() => document.querySelector('#discovered-rooms').children.length === 1);
  const foundCard=document.querySelector('#discovered-rooms').children[0];
  assert.equal(foundCard.children[0].textContent,'一起玩');
  const failedJoin = foundCard.lastElementChild.click();
  await until(() => FakeWebSocket.instances.length === 1);
  const socket = FakeWebSocket.instances[0];
  socket.open();
  await until(() => socket.sent.some((message) => message.type === 'auth.hello'));
  const auth = socket.sent.find((message) => message.type === 'auth.hello');
  socket.respond({ v: 1, type: 'room.state', requestId: auth.requestId, payload: { members: [] } });
  await until(() => socket.sent.some((message) => message.type === 'viewer.join'));
  const rejectedJoin = socket.sent.findLast((message) => message.type === 'viewer.join');
  socket.respond({v:1,type:'error',requestId:rejectedJoin.requestId,payload:{code:'ROOM_FULL',retryable:false}});
  await failedJoin;
  assert.equal(document.querySelector('#discovery-panel').hidden,false,'a stale/full discovered room must return to the room list');
  assert.equal(document.querySelector('#room-panel').hidden,true);
  assert.match(document.querySelector('#error-message').textContent,/满/);
  const join = foundCard.lastElementChild.click();
  await until(() => socket.sent.filter((message) => message.type === 'viewer.join').length === 2);
  const firstJoin = socket.sent.findLast((message) => message.type === 'viewer.join');
  assert.equal(firstJoin.payload.hostIPv4,'192.168.1.20');
  assert.equal(firstJoin.payload.roomCode,'ABCD2345','one click must use the discovery invitation without typing');
  socket.respond({ v: 1, type: 'room.joined', requestId: firstJoin.requestId, roomId: 'room-one', peerId: 'viewer-one', payload: { members: [], peerId: 'viewer-one', resumeToken: 'resume-one' } });
  await join;
  await toggle.click();
  assert.equal(globalThis.navigator.mediaDevices.calls, 1);
  const firstMicrophone = microphones[0];
  assert.equal(mediaInstance.microphoneTrack, firstMicrophone);
  assert.equal(toggle.textContent, '关闭麦克风');
  assert.equal(toggle.dataset.enabled, 'true');



  const leave = document.querySelector('#leave-room').click();
  await until(() => socket.sent.some((message) => message.type === 'viewer.leave'));
  const leaveRequest = socket.sent.findLast((message) => message.type === 'viewer.leave');
  socket.respond({ v: 1, type: 'peer.left', requestId: leaveRequest.requestId, roomId: 'room-one', peerId: 'viewer-one', payload: { peerId: 'viewer-one' } });
  await leave;
  assert.equal(firstMicrophone.stopCount, 1);
  assert.equal(mediaInstance.microphoneTrack, null);

  await choose.click();
  document.querySelector('#join-invite').value = 'ABCD2345';
  await document.querySelector('#join-room').click();
  assert.equal(socket.sent.filter(message => message.type === 'viewer.join').length, 2, 'incomplete invitation must not send a join request');
  assert.equal(document.querySelector('#join-invite').getAttribute('aria-invalid'), 'true');
  document.querySelector('#join-address').setAttribute('aria-invalid', 'true');
  document.querySelector('#join-invite').value = '192.168.1.20:45678  房间码 abcd2345';
  const rejoin = document.querySelector('#join-room').click();
  await until(() => socket.sent.filter((message) => message.type === 'viewer.join').length === 3);
  const secondJoin = socket.sent.findLast((message) => message.type === 'viewer.join');
  assert.equal(secondJoin.payload.hostIPv4, '192.168.1.20');
  assert.equal(secondJoin.payload.hostPort, 45678);
  assert.equal(secondJoin.payload.roomCode, 'ABCD2345', 'one pasted invitation supplies all three connection fields');
  assert.equal(document.querySelector('#join-address').hasAttribute('aria-invalid'), false, 'a valid invitation clears errors left by the manual fallback');
  socket.respond({ v: 1, type: 'room.joined', requestId: secondJoin.requestId, roomId: 'room-two', peerId: 'viewer-one', payload: { members: [], peerId: 'viewer-one', resumeToken: 'resume-two' } });
  await rejoin;
  assert.equal(globalThis.navigator.mediaDevices.calls, 1, 'rejoining must not implicitly recapture the microphone');
  assert.equal(mediaInstance.microphoneTrack, null);
  assert.equal(toggle.textContent, '开启麦克风');
  assert.equal(toggle.dataset.enabled, 'false');
  await document.querySelector('#copy-invite').click();
  assert.equal(copiedReport, '192.168.1.20:45678  房间码 ABCD2345', 'a joined member can copy the complete invitation');

  await toggle.click();
  assert.equal(globalThis.navigator.mediaDevices.calls, 2);
  const secondMicrophone = microphones[1];
  assert.equal(mediaInstance.microphoneTrack, secondMicrophone);
  assert.equal(toggle.textContent, '关闭麦克风');
  assert.equal(toggle.dataset.enabled, 'true');

  const sharedAudio = {kind:'audio',readyState:'live',stopped:false,getSettings:()=>({restrictOwnAudio:false}),stop(){this.stopped=true;},addEventListener(){}};
  nextSystemAudio = sharedAudio;
  assert.equal(document.querySelector('#share-mode').value, 'combined', 'system audio must be included by default without opening settings');
  const startSharing = document.querySelector('#start-share').click();
  await until(() => socket.sent.some(message => message.type === 'share.claim'));
  const claim = socket.sent.findLast(message => message.type === 'share.claim');
  assert.equal(claim.roomId, 'room-two', 'ordinary member claims within the joined room');
  socket.respond({v:1,type:'room.state',requestId:claim.requestId,roomId:'room-two',payload:{members:[],presenterPeerId:'viewer-one',screenSharing:false,presentationRevision:1}});
  await startSharing;
  assert.equal(displayConstraints.audio, true, 'default sharing requests an audio track');
  assert.equal(displayConstraints.systemAudio, 'include', 'default sharing asks the browser to include system audio');
  const capturedVideo = mediaInstance.screenVideoTrack;
  assert.ok(capturedVideo, 'ordinary member can use the actual app sharing handler');
  socket.respond({v:1,type:'room.state',roomId:'room-two',payload:{members:[],presenterPeerId:'viewer-one',screenSharing:true,presentationRevision:2}});
  assert.equal(document.querySelector('#app').dataset.stage,'watch');
  assert.equal(document.querySelector('#voice-only-warning').hidden,false);
  assert.equal(document.querySelector('#stop-share').disabled, false);
  assert.equal(mediaInstance.systemAudioTrack, sharedAudio, 'normal combined start must not require a manual verification pass');
  assert.equal(sharedAudio.stopped,false);
  assert.equal(document.querySelector('#manual-verify-start').disabled,false,'optional hearing check remains available while sharing');
  await document.querySelector('#manual-verify-start').click();
  await document.querySelector('#manual-verify-fail').click();
  assert.equal(mediaInstance.systemAudioTrack,sharedAudio,'a reported echo cannot silently remove the prioritized system sound');
  assert.equal(sharedAudio.stopped,false);
  assert.equal(mediaInstance.isolation.state,'manual_fail');
  await document.querySelector('#stop-system-audio').click();
  assert.equal(sharedAudio.stopped,true,'only the explicit user action stops system audio');
  assert.equal(mediaInstance.systemAudioTrack,null);
  assert.equal(capturedVideo.stopped,false,'stopping system sound retains the picture');
  assert.equal(mediaInstance.microphoneTrack,secondMicrophone,'stopping system sound retains voice');
  const originalGetStats = mediaInstance.getStatsSnapshot;
  let videoRow = {role:'screenVideo',direction:'outbound-rtp',width:1920,height:1080,fps:25,sourceFps:25,intervalFps:25,sourceIntervalFps:25,sampleIntervalSeconds:2};
  mediaInstance.peers.set('stats-only',{pc:{close(){}}});
  mediaInstance.getStatsSnapshot = async () => [videoRow];
  document.visibilityState = 'hidden'; document.querySelector('#quality-target').value = '1080p60';
  statsTick(); await until(() => document.querySelector('#actual-stats').textContent.includes('25.0 FPS'));
  document.visibilityState = 'visible'; videoRow = {...videoRow,fps:59,sourceFps:59};
  statsTick(); await until(() => document.querySelector('#actual-stats').textContent.includes('59.0 FPS'));
  await document.querySelector('#copy-media-diagnostics').click();
  assert.match(copiedReport,/页面后台.*25.0/,'the app must preserve fullscreen-era samples after foreground rates recover');
  assert.match(copiedReport,/页面前台.*59.0/);
  globalThis.location.href = 'http://127.0.0.1:41000/?private=test-only';
  await document.querySelector('#copy-background-site').click();
  assert.equal(copiedReport,'http://127.0.0.1:41000/','the Edge site exception address must exclude queries and control information');
  mediaInstance.peers.delete('stats-only'); mediaInstance.getStatsSnapshot = originalGetStats;
  await document.querySelector('#voice-only').click();
  assert.equal(capturedVideo.stopped,true);
  assert.equal(mediaInstance.microphoneTrack,secondMicrophone,'voice-only action retains the microphone');
  assert.equal(secondMicrophone.stopCount,0);
  assert.equal(mediaInstance.voiceOnly,true);
  assert.equal(document.querySelector('#app').dataset.stage,'voice');
  socket.respond({v:1,type:'room.state',roomId:'room-two',payload:{members:[],presenterPeerId:'',screenSharing:false,presentationRevision:3}});
  socket.respond({v:1,type:'room.state',roomId:'room-two',payload:{members:[],presenterPeerId:'viewer-one',screenSharing:true,presentationRevision:2}});
  assert.equal(appClient.room.screenSharing,false,'a late old snapshot cannot resurrect the stopped presentation');
  assert.equal(appClient.room.presenterPeerId,'');

  socket.respond({ v: 1, type: 'error', payload: { code: 'SIGNAL_CONNECTION_LOST', retryable: true, message: 'private bridge diagnostic' } });
  assert.equal(mediaInstance.microphoneTrack, secondMicrophone);
  assert.equal(firstMicrophone.stopCount, 1);
  assert.equal(secondMicrophone.stopCount, 0, 'recoverable signal loss keeps the active capture');
  assert.equal(toggle.textContent, '关闭麦克风');
  assert.equal(toggle.dataset.enabled, 'true');

  await document.querySelector('#stop-share').click();
  assert.equal(mediaInstance.microphoneTrack, secondMicrophone);
  assert.equal(toggle.textContent, '关闭麦克风');
  assert.equal(toggle.dataset.enabled, 'true');
});
