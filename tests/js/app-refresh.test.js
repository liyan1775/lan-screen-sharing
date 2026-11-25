import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { PageLease } from '../../internal/web/assets/page-lease.js';
import { MeshMedia } from '../../internal/web/assets/media.js';
import { createRoomUIState } from '../../internal/web/assets/ui-state.js';

const host = {peerId:'host-peer', role:'host', seatIndex:1};
const roomId = 'test-room';
const uiKey = 'lan-screen-sharing.room-ui';

async function refreshFixture(t, {presenting = false, micError, micPermission = 'granted', configure, role = 'host'} = {}) {
  t.after(() => new Promise(resolve => setImmediate(resolve))); // Let pending close/sync callbacks finish before restoring globals.
  const { document, window: domWindow } = parseHTML(await readFile(new URL('../../internal/web/assets/index.html', import.meta.url), 'utf8'));
  const $ = selector => document.querySelector(selector);
  for (const select of document.querySelectorAll('select')) {
    Object.defineProperty(select, 'value', { writable: true, value: select.querySelector('option[selected],option')?.value || '' });
  }
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.showModal = () => { dialog.open = true; dialog.setAttribute('open', ''); };
    dialog.close = value => {
      dialog.returnValue = value || '';
      dialog.open = false; dialog.removeAttribute('open'); dialog.dispatchEvent(new domWindow.Event('close'));
    };
  }
  const bootstrap = { localWsPath: '/ws/v1', serviceId: 'service-one', localControlToken: 'local', hostControlToken: 'host-token',
    lanIPv4: '192.168.1.2', signalPort: 55555, preferences: {micDeviceId:'saved-mic', micMode:'ptt'} };
  const peerId = role === 'host' ? host.peerId : 'visitor';
  const saved = new Map([['lan-screen-sharing.room', JSON.stringify({
    v: 1, serviceId: bootstrap.serviceId, role, roomId, peerId, presenting,
    ...(role === 'viewer' ? {joinDetails:{hostIPv4:'192.168.1.3', hostPort:55556, roomCode:'ABCD2345', resumeToken:'resume'}} : {}),
  })]]);
  const storage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
  if (configure) {
    const state = createRoomUIState(storage);
    state.begin(bootstrap.serviceId, roomId);
    configure(state);
  }
  const mic = Object.assign(new EventTarget(), {kind:'audio', readyState:'live', stop() { this.readyState = 'ended'; }});
  const micRequests = [], playback = [], localEvents = new EventTarget();
  domWindow.HTMLElement.prototype.play = function() { playback.push([this.volume, this.muted]); return Promise.resolve(); };
  domWindow.HTMLElement.prototype.pause = () => {};
  let socket, recoveryTick;
  class FakeWebSocket {
    static OPEN = 1;
    readyState = 1;
    sent = [];
    constructor() { socket = this; }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    respond(message) { this.onmessage({ data: JSON.stringify({ v: 1, ...message }) }); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const originalTimer = globalThis.setTimeout;
  const replacements = {
    document, window: new EventTarget(), WebSocket: FakeWebSocket, sessionStorage:storage,
    addEventListener: localEvents.addEventListener.bind(localEvents),
    navigator: {clipboard:{}, permissions:{async query({name}) {
      assert.equal(name, 'microphone');
      return {state:micPermission};
    }}, mediaDevices:{
      async getUserMedia(constraints) {
        micRequests.push(constraints);
        if (micError) throw Object.assign(new Error('capture rejected'), {name:micError});
        return {getTracks:() => [mic], getAudioTracks:() => [mic]};
      },
      async enumerateDevices() { return [{kind:'audioinput', deviceId:'saved-mic', label:'备用麦克风'}]; },
    }},
    MediaStream: class { constructor(tracks) { this.tracks = tracks; } getAudioTracks() { return this.tracks; } },
    location: new URL('http://127.0.0.1:41000/'),
    fetch: async url => ({ ok: true, json: async () => String(url).endsWith('/rooms') ? { available: true, rooms: [] } : bootstrap }),
    setTimeout: (fn, delay, ...args) => {
      if (delay === 250) { recoveryTick = fn; return null; }
      const timer = originalTimer(fn, delay, ...args);
      timer.unref();
      return timer;
    },
    setInterval: () => null,
  };
  for (const [key, value] of Object.entries(replacements)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else delete globalThis[key]; });
  }
  const originalLeaseStart = PageLease.prototype.start;
  PageLease.prototype.start = async () => {};
  t.after(() => { PageLease.prototype.start = originalLeaseStart; });
  let media;
  const {setIdentity, addPeer} = MeshMedia.prototype;
  MeshMedia.prototype.setIdentity = function(...args) { media = this; return setIdentity.apply(this, args); };
  MeshMedia.prototype.addPeer = function(peerId, role) {
    if (!this.peers.has(peerId)) this.peers.set(peerId, {peerId, role, pc:{close() {}, getStats:async () => new Map()}, voiceStatus:'connecting'});
    return this.peers.get(peerId);
  };
  t.after(() => { Object.assign(MeshMedia.prototype, {setIdentity, addPeer}); });
  const until = async predicate => {
    for (let i = 0; i < 20 && !predicate(); i++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(predicate(), 'expected the refreshed app to reach this step');
  };

  await import(`../../internal/web/assets/app.js?refresh=${encodeURIComponent(t.name)}`);
  await until(() => recoveryTick);
  async function openSocket() {
    const recovering = recoveryTick();
    await until(() => socket);
    socket.onopen();
    const auth = socket.sent.find(message => message.type === 'auth.hello');
    if (role === 'host') assert.equal(auth.payload.roomId, roomId);
    return {socket, auth, recovering};
  }
  async function restore(payload = {}) {
    const {socket, auth, recovering} = await openSocket();
    const snapshot = {name:'旧房间', members:[host], ...payload};
    if (role === 'host') {
      socket.respond({type:'room.state', requestId:auth.requestId, roomId, peerId, payload:{resumed:true, ...snapshot}});
    } else {
      socket.respond({type:'room.state', requestId:auth.requestId, payload:{members:[]}});
      await until(() => socket.sent.some(message => message.type === 'viewer.join'));
      const join = socket.sent.find(message => message.type === 'viewer.join');
      assert.equal(join.payload.resumeToken, 'resume');
      socket.respond({type:'room.joined', requestId:join.requestId, roomId, peerId, payload:{...snapshot, resumeToken:'resume'}});
    }
    await recovering;
    return socket;
  }
  return {$, until, saved, mic, micRequests, playback, localEvents, openSocket, restore, DOMEvent:domWindow.Event, get media() { return media; }};
}

test('a refreshed host sees a stopped-share notice and can choose content again before the old share release is acknowledged', async t => {
  const { $, restore } = await refreshFixture(t, {presenting:true});
  const event = new Event('beforeunload', { cancelable: true });
  Object.defineProperty(event, 'returnValue', { writable: true });
  window.dispatchEvent(event);
  assert.ok(event.defaultPrevented, 'backup protection starts while the app is waiting to recover the room');
  assert.equal($('#restore-share-note').hasAttribute('data-toast-state'), false, 'wait until the room actually returns before showing the reminder');
  const socket = await restore({presenterPeerId:host.peerId, screenSharing:true, hasSystemAudio:true});
  const release = socket.sent.find(message => message.type === 'share.release');
  assert.ok(release, 'the refreshed page also clears the stale share slot at the server');
  assert.equal($('#app').dataset.stage, 'voice');
  assert.equal($('#restore-share-note').dataset.toastState, 'visible');
  assert.equal($('#restore-share-note').textContent, '页面已刷新，之前的共享已停止；如需继续，请重新选择内容开始共享。');
  assert.equal($('#start-share').hidden, false);
  assert.equal($('#start-share').disabled, false);
  assert.equal($('#voice-activity-title').textContent, '还没有人共享');
  socket.respond({ type: 'room.state', requestId: release.requestId, roomId: 'test-room', payload: {
    presenterPeerId: '', screenSharing: false, hasSystemAudio: false,
  } });
});

for (const [micPermission, micError, message] of [
  ['granted', undefined, ''],
  ['denied', undefined, '麦克风已关闭，请在浏览器中允许麦克风后再开启。'],
  ['granted', 'NotAllowedError', '麦克风已关闭，请在浏览器中允许麦克风后再开启。'],
  ['granted', 'NotFoundError', '未能自动恢复麦克风，请检查设备连接和浏览器权限，再点击开启麦克风。'],
  ['granted', 'NotReadableError', '未能自动恢复麦克风，请检查设备连接和浏览器权限，再点击开启麦克风。'],
]) {
  test(`restoring a room reapplies personal controls and handles auto mic: ${micError ?? micPermission}`, async t => {
    const friend = {peerId:'friend', role:'viewer', nickname:'小夏', seatIndex:2};
    const f = await refreshFixture(t, {micPermission, micError, configure: state => {
      state.set({micActive:true, voiceOnly:true, textOpen:true, audioFilter:'systemAudio'});
      state.setAudio(friend.peerId, 'microphone', {volume:.4, muted:true});
      state.setAudio(friend.peerId, 'systemAudio', {volume:.7, muted:false});
    }});
    const { $, saved, micRequests, playback, localEvents, until } = f;
    const socket = await f.restore({members:[host, friend], screenSharing:true, presenterPeerId:friend.peerId, hasSystemAudio:true});
    assert.equal($('#app').dataset.stage, 'voice', 'restored voice-only skips the remote screen');
    assert.equal($('#voice-only').getAttribute('aria-pressed'), 'true');
    assert.equal($('#text-panel').hidden, false);
    assert.equal($('[data-audio-filter=systemAudio]').getAttribute('aria-pressed'), 'true');
    assert.equal($('#error-message').hidden, true);
    const feedback = $('#mic-restore-feedback');
    if (message) {
      await until(() => feedback.textContent === message);
      assert.equal(feedback.parentElement.hidden, false);
      assert.equal($('#toggle-mic').getAttribute('aria-describedby'), feedback.id);
    } else {
      await until(() => $('#watch-toast [role=status]').textContent === '已恢复麦克风');
      assert.equal(feedback.parentElement.hidden, true);
    }
    assert.deepEqual(micRequests, micPermission === 'denied' ? [] : [{audio:{deviceId:{exact:'saved-mic'}}, video:false}], 'no fallback may capture a different device during auto restore');
    assert.equal($('#toggle-mic').getAttribute('aria-pressed'), String(!message));
    assert.equal(JSON.parse(saved.get(uiKey)).micActive, !message);
    if (!message) {
      assert.equal(f.media.microphoneTrack, f.mic);
      assert.equal(f.mic.enabled, false, 'the restored push-to-talk microphone starts armed but silent');
      localEvents.dispatchEvent(new Event('pagehide'));
      assert.equal(f.mic.readyState, 'ended');
      assert.equal(JSON.parse(saved.get(uiKey)).micActive, true, 'unload releases the track without recording a manual mute');
    }
    const remoteTrack = () => Object.assign(new EventTarget(), {kind:'audio'});
    f.media.attachAudio('friend', 'microphone', remoteTrack());
    const firstAudio = f.media.audioElements.get('friend:microphone');
    assert.deepEqual(playback.at(-1), [.4, true], 'output settings are in place before first playback');
    assert.equal($('.audio-source[data-role=microphone] input').value, '0.4');
    assert.equal($('.audio-source[data-role=microphone] button').getAttribute('aria-pressed'), 'true');
    f.media.removeAudio('friend', 'microphone');
    f.media.attachAudio('friend', 'microphone', remoteTrack());
    assert.notEqual(f.media.audioElements.get('friend:microphone'), firstAudio);
    assert.deepEqual(playback.at(-1), [.4, true], 'a replacement audio element inherits the stored 40% and mute');
    f.media.attachAudio('friend', 'systemAudio', remoteTrack());
    const system = f.media.audioElements.get('friend:systemAudio');
    assert.deepEqual([system.volume, system.userMuted, system.muted], [.7, false, true], 'voice-only pause is separate from the saved mute');
    if (!micError) {
      const range = $('.audio-source[data-role=microphone] input');
      range.value = '0.55';
      range.dispatchEvent(new f.DOMEvent('input'));
      $('.audio-source[data-role=microphone] button').click();
      const replacedAudio = f.media.audioElements.get('friend:microphone');
      assert.deepEqual([replacedAudio.volume, replacedAudio.muted], [.55, false]);
      assert.deepEqual(JSON.parse(saved.get(uiKey)).volumes[JSON.stringify(['friend','microphone'])], {volume:.55, muted:false});
      $('#voice-only').click();
      assert.equal(JSON.parse(saved.get(uiKey)).voiceOnly, false);
      $('#watch-sound').click();
      $('[data-audio-filter=microphone]').click();
      assert.equal(JSON.parse(saved.get(uiKey)).audioFilter, 'microphone');
      $('#sound-dialog').close();
    }
    $('#close-text').click();
    assert.equal(JSON.parse(saved.get(uiKey)).textOpen, false);
    socket.respond({type:'room.ended', roomId, payload:{reason:'host_ended'}});
    assert.equal(saved.has(uiKey), false);
    assert.equal($('#text-panel').hidden, true);
    assert.equal($('#watch-toast').textContent, '', 'room notices clear on dismissal by the host');
  });
}

test('host top bar follows membership, connection and departure, and names exactly one failed voice peer', async t => {
  const f = await refreshFixture(t);
  const socket = await f.restore();
  const status = f.$('#connection-status');
  const voice = f.$('#voice-connection-message');
  const friend = {peerId:'friend', role:'viewer', nickname:'小夏', seatIndex:2};
  const other = {peerId:'other', role:'viewer', nickname:'阿立', seatIndex:3};
  const join = peer => socket.respond({type:'peer.joined', roomId, peerId:peer.peerId, payload:peer});
  const leave = peer => socket.respond({type:'peer.left', roomId, peerId:peer.peerId, payload:{peerId:peer.peerId}});
  assert.equal(status.textContent, '房间已创建，等待朋友加入');
  join(friend);
  assert.equal(status.textContent, '已有朋友加入，正在连接语音…');
  f.media.setVoiceStatus(f.media.peers.get(friend.peerId), 'failed');
  assert.equal(voice.textContent, '与 小夏 的语音未连上，你仍在房间内。');
  join(other);
  f.media.setVoiceStatus(f.media.peers.get(other.peerId), 'failed');
  assert.equal(voice.textContent, '部分成员的语音未连上，你仍在房间内。');
  leave(other);
  assert.equal(voice.textContent, '与 小夏 的语音未连上，你仍在房间内。');
  f.media.setVoiceStatus(f.media.peers.get(friend.peerId), 'connected');
  assert.equal(voice.textContent, '');
  assert.equal(status.textContent, '媒体已连接');
  leave(friend);
  assert.equal(status.textContent, '房间已创建，等待朋友加入');
});

test('expiry during recovery clears storage without auto-capturing a microphone', async t => {
  const f = await refreshFixture(t, {configure: state => state.set({micActive:true, textOpen:true})});
  assert.match(f.$('#connection-status').textContent, /正在自动恢复房间/);
  const {socket, auth, recovering} = await f.openSocket();
  socket.respond({type:'error', requestId:auth.requestId, payload:{code:'ROOM_EXPIRED'}});
  await recovering;
  assert.equal(f.saved.has(uiKey), false);
  assert.equal(f.saved.has('lan-screen-sharing.room'), false);
  assert.deepEqual(f.micRequests, []);
  assert.equal(f.$('#error-message').hidden, false);
  assert.match(f.$('#connection-status').textContent, /房间未能恢复/);
});

for (const action of ['end-room', 'exit-program']) {
  test(`${action} clears room UI as soon as the action is confirmed, before the network response`, async t => {
    const f = await refreshFixture(t, {configure: state => state.set({textOpen:true})});
    const socket = await f.restore();
    f.$(`#${action}`).click();
    f.$('#confirm-accept').click();
    await f.until(() => !f.saved.has(uiKey));
    await f.until(() => socket.sent.some(message => message.type === 'host.endRoom'));
    const ending = socket.sent.find(message => message.type === 'host.endRoom');
    socket.respond({type:'room.ended', requestId:ending.requestId, roomId, payload:{reason:'host_ended'}});
    await f.until(() => f.$('#app').dataset.stage === 'entry');
    assert.equal(f.saved.has(uiKey), false);
  });
}

test('a refreshed member keeps the saved sidebar and leaving clears its room state immediately', async t => {
  const f = await refreshFixture(t, {role:'viewer', configure:state => state.set({textOpen:true})});
  const socket = await f.restore({members:[host, {peerId:'visitor', role:'viewer', seatIndex:2}]});
  assert.equal(f.$('#text-panel').hidden, false);
  assert.deepEqual(f.micRequests, [], 'a previously muted member stays muted on reload');
  f.$('#leave-room').click();
  await f.until(() => socket.sent.some(message => message.type === 'viewer.leave'));
  assert.equal(f.saved.has(uiKey), false);
  const leaving = socket.sent.find(message => message.type === 'viewer.leave');
  socket.respond({type:'peer.left', requestId:leaving.requestId, roomId, peerId:'visitor', payload:{peerId:'visitor'}});
  await f.until(() => f.$('#app').dataset.stage === 'entry');
  assert.equal(f.saved.has(uiKey), false);
});

test('the page head references the supplied high-resolution icons and manifest', async () => {
  const {document} = parseHTML(await readFile(new URL('../../internal/web/assets/index.html', import.meta.url), 'utf8'));
  assert.deepEqual([...document.head.querySelectorAll('link[rel=icon]')].map(link =>
    ['href', 'type', 'sizes'].map(field => link.getAttribute(field))), [
    ['/favicon.ico', null, 'any'],
    ['/assets/icons/icon.svg', 'image/svg+xml', null],
    ['/assets/icons/icon-32.png', 'image/png', '32x32'],
    ['/assets/icons/icon-48.png', 'image/png', '48x48'],
  ]);
  assert.equal(document.head.querySelector('link[rel=manifest]').getAttribute('href'), '/assets/manifest.webmanifest');
  assert.match(document.querySelector('#quality-target-text').textContent, /15 Mbps/);
});

test('copy outcomes use the current settings toast without changing the long-lived room status', async t => {
  const f = await refreshFixture(t);
  await f.restore();
  const expectedStatus = f.$('#connection-status').textContent;
  f.$('#open-settings').click();
  const toast = f.$('#settings-toast [role=status]');
  let copied;
  globalThis.navigator.clipboard.writeText = async text => { copied = text; };
  f.$('#copy-background-site').click();
  await f.until(() => toast.textContent.startsWith('已复制页面地址'));
  assert.equal(copied, 'http://127.0.0.1:41000/');
  globalThis.navigator.clipboard.writeText = async () => { throw new Error('denied'); };
  f.$('#copy-background-site').click();
  await f.until(() => toast.textContent.startsWith('无法自动复制'));
  assert.equal(f.$('#error-message').hidden, true);
  assert.equal(f.$('#connection-status').textContent, expectedStatus);
  f.$('#settings-dialog').close();
  assert.equal(toast.textContent, '');
});

test('accepting a pending silent share clears the actionable banner, and the browser stop shows only a toast', async t => {
  const f = await refreshFixture(t);
  const friend = {peerId:'friend', role:'viewer', seatIndex:2};
  const socket = await f.restore({members:[host, friend]});
  const track = Object.assign(new EventTarget(), {kind:'video', readyState:'live',
    getSettings:() => ({displaySurface:'monitor', width:1920, height:1080, frameRate:60}),
    async applyConstraints() {}, stop() { this.readyState = 'ended'; },
  });
  globalThis.navigator.mediaDevices.getDisplayMedia = async () => ({
    getTracks:() => [track], getVideoTracks:() => [track], getAudioTracks:() => [],
  });
  f.$('#start-share').click();
  await f.until(() => !f.$('#error-message').hidden && f.$('#start-share').textContent.includes('继续仅共享'));
  assert.match(f.$('#connection-status').textContent, /等待你的选择/);
  f.$('#start-share').click();
  await f.until(() => socket.sent.some(message => message.type === 'share.claim'));
  const claiming = socket.sent.find(message => message.type === 'share.claim');
  socket.respond({type:'room.state', requestId:claiming.requestId, roomId, payload:{presenterPeerId:host.peerId, screenSharing:false}});
  const toast = f.$('#watch-toast [role=status]');
  await f.until(() => toast.textContent.includes('不含共享声音'));
  assert.equal(f.$('#connection-status').textContent, '正在共享屏幕');
  assert.equal(f.$('#error-message').hidden, true);
  track.readyState = 'ended';
  track.dispatchEvent(new Event('ended'));
  await f.until(() => toast.textContent.includes('已停止屏幕共享'));
  assert.equal(f.$('#error-message').hidden, true);
  assert.match(f.$('#connection-status').textContent, /正在连接语音/);
});
