import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const requireQA = createRequire(import.meta.url);
const { parseHTML } = requireQA('linkedom');
const bundled = process.argv.includes('--bundle');
let html = fs.readFileSync(path.join(here, bundled ? '../下一版体验.html' : 'index.html'), 'utf8');
// DOM/state tests do not decode images. Keep the bundle's embedded-resource assertion,
// but substitute a tiny data URL in the test DOM to avoid repeatedly parsing megabytes
// of image text for every layout combination. The real asset is checked in a browser.
if (bundled) {
  const embeddedImages = new Set([...html.matchAll(/data:image\/png;base64,([A-Za-z0-9+/=]{1024,})/g)].map(match => match[1]));
  for (const name of ['game-scene.png', 'room-arcs-v1.png', 'table-arc-v1.png', 'screen-illustration-v3.png']) {
    const expected = fs.readFileSync(path.join(here, '../frontend-lab/assets', name)).toString('base64');
    assert.ok(embeddedImages.has(expected), `standalone must embed the exact ${name} asset`);
  }
  html = html.replace(/data:image\/png;base64,[A-Za-z0-9+/=]{1024,}/g, 'data:image/png;base64,AA==');
}
const { window } = parseHTML(html);
const { document } = window;
let forbidden = [];
const deny = name => () => { forbidden.push(name); throw new Error('Forbidden real API: ' + name); };
const navigator = { mediaDevices: { getUserMedia: deny('getUserMedia'), getDisplayMedia: deny('getDisplayMedia') }, clipboard: { writeText: async () => {} } };
const context = vm.createContext({ window, document, navigator, console, Event: window.Event, setTimeout: fn => { queueMicrotask(fn); return 1; }, clearTimeout: () => {}, queueMicrotask, fetch: deny('fetch'), WebSocket: deny('WebSocket'), RTCPeerConnection: deny('RTCPeerConnection') });
window.navigator.mediaDevices = navigator.mediaDevices;
window.fetch = context.fetch;
window.WebSocket = context.WebSocket;
window.RTCPeerConnection = context.RTCPeerConnection;
window.setTimeout = fn => { queueMicrotask(fn); return 1; };
window.clearTimeout = () => {};
for (const [, src, inline] of html.matchAll(/<script(?:\s+src="([^"]+)")?\s*>([\s\S]*?)<\/script\s*>/g)) {
  vm.runInContext(src ? fs.readFileSync(path.join(here, src), 'utf8') : inline, context, { filename: src || 'standalone-inline.js' });
}
const app = window.LanDemo.app;
assert.ok(app && app.getState && app.dispatch && app.setScenario, 'public app API');
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
const state = () => app.getState();
const act = async (action, value) => { app.dispatch(action, value); await tick(); };
const scenario = async key => { app.setScenario(key); await tick(); };
function select(id, value) {
  const el = document.querySelector('#' + id);
  assert.ok(el, `missing #${id}`);
  const option = [...el.querySelectorAll('option')].find(o => o.value === value);
  assert.ok(option, `missing option ${id}=${value}`);
  for (const item of el.querySelectorAll('option')) item.selected = false;
  option.selected = true;
  el.dispatchEvent(new window.Event('change', { bubbles: true }));
}
const surface = () => document.querySelector('#demo-surface');
const routes = ['portal', 'orbit', 'edge', 'channel', 'source', 'relay'];
const hasAction = action => !!document.querySelector(`[data-action="${action}"]`);
async function click(selector) {
  const node = document.querySelector(selector); assert.ok(node, `missing ${selector}`); assert.ok(!node.disabled, `disabled ${selector}`);
  node.dispatchEvent(new window.Event('click', { bubbles: true })); await tick();
}
function input(id, value) {
  const node = document.querySelector('#' + id); assert.ok(node, `missing #${id}`);
  node.value = value; node.dispatchEvent(new window.Event('input', { bubbles: true }));
}
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('PASS', name); }
  catch (e) { failed++; console.error('FAIL', name, e.stack || e); }
}

await test('all independent layout/theme combinations render all phases', async () => {
  for (const theme of ['cinema', 'lounge', 'precision', 'clearblue']) for (const entry of routes) for (const voice of routes) for (const watch of routes) {
    select('theme-choice', theme); select('layout-entry', entry); select('layout-voice', voice); select('layout-watch', watch);
    for (const [key, route, phase] of [['nearby', entry, 'entry'], ['chat', voice, 'voice'], ['watching', watch, 'watch']]) {
      await scenario(key);
      assert.ok(surface().querySelector(`.${route}-${phase}`), `${theme}/${entry}/${voice}/${watch}: ${phase}`);
    }
    assert.equal(state().theme, theme);
    assert.deepEqual(JSON.parse(JSON.stringify(state().layout)), { entry, voice, watch });
  }
});
await test('join starts muted and mic toggles', async () => {
  await scenario('nearby');
  const join = surface().querySelector('[data-action="join"][data-value="game"]'); assert.ok(join);
  join.dispatchEvent(new window.Event('click', { bubbles: true })); await tick();
  assert.equal(state().scene, 'room'); assert.equal(state().mic, false);
  await act('mic'); assert.equal(state().mic, true);
});
await test('own stop returns to voice and preserves the microphone', async () => {
  await scenario('broadcasting'); assert.equal(state().mic, true);
  await act('stop-share'); assert.equal(state().presenter, null); assert.equal(state().mic, true);
  assert.equal(state().view, 'voice');
});
await test('other presenter cannot be displaced', async () => {
  await scenario('watching'); await act('share'); assert.equal(state().presenter, 'owner');
});
await test('cancel source picker does not start sharing', async () => {
  await scenario('handoff'); await act('share'); assert.ok(hasAction('confirm-share'), 'picker opened');
  await act('close'); assert.equal(state().presenter, null);
});
await test('source confirmation starts simulated sharing', async () => {
  await scenario('handoff'); await act('share'); await act('confirm-share');
  assert.equal(state().presenter, 'self'); assert.equal(state().view, 'watch');
});
await test('full rooms are disabled', async () => {
  for (const route of routes) {
    select('layout-entry', route); await scenario('full');
    const join = surface().querySelector('[data-action="join"]'); assert.ok(join && join.disabled, route);
    assert.match(surface().textContent, /已满/);
    await act('join', 'full'); assert.equal(state().scene, 'entry');
  }
});
await test('blocked discovery can retry', async () => {
  for (const route of routes) {
    await click('[data-preset="' + route + '"]'); await scenario('blocked');
    const retry = surface().querySelector('[data-action="refresh"], [data-action="retry"]'); assert.ok(retry, route);
    await act(retry.getAttribute('data-action')); assert.notEqual(state().discovery, 'blocked', route);
  }
  for (const [route, selector] of [['edge', '.edge-list-message [data-action="retry"]'], ['relay', '.re-discovery-state [data-action="retry"]']]) {
    await click('[data-preset="' + route + '"]'); await scenario('blocked');
    await click(selector);
    assert.equal(state().discovery, 'ready', route + ' inline retry should restart discovery');
    assert.ok(state().rooms.length, route + ' inline retry should restore results');
  }
});
await test('theme and layout changes preserve room state', async () => {
  await scenario('broadcasting'); await act('voice');
  const before = state(); select('theme-choice', 'cinema'); select('layout-voice', 'portal'); await tick();
  const after = state();
  for (const key of ['scene', 'view', 'presenter', 'mic', 'roomName']) assert.equal(after[key], before[key], key);
  assert.equal(after.theme, 'cinema'); assert.equal(after.layout.voice, 'portal');
});
await test('settings changes survive theme switching', async () => {
  await scenario('broadcasting'); await act('settings');
  const cursor = document.querySelector('#settings-cursor'); assert.ok(cursor);
  cursor.checked = true; cursor.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(state().cursor, true); await act('close');
  select('theme-choice', 'precision'); await tick();
  assert.equal(state().cursor, true); assert.equal(state().presenter, 'self');
});
await test('member volume input changes only local volume', async () => {
  select('layout-voice', 'orbit'); await scenario('chat'); await act('member','owner');
  const input = document.querySelector('#person-audio-owner'); assert.ok(input);
  input.value = '0.35'; input.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(state().volumes.owner, 0.35); assert.equal(state().volumes.friend, 1);
});
await test('every voice route exposes viewing while share is occupied', async () => {
  for (const route of routes) {
    select('layout-voice', route); await scenario('watching'); await act('voice');
    assert.ok(surface().querySelector('[data-action="watch"]'), route + ' must expose watch');
    await act('share'); assert.equal(state().presenter, 'owner');
    assert.equal(state().view, 'voice');
  }
});
await test('stop own system audio without stopping picture or mic', async () => {
  await scenario('broadcasting'); await act('settings');
  assert.equal(document.querySelector('#overlay-layer [data-volume="system"]'), null, 'own output is not shown as local playback');
  await click('#overlay-layer [data-action="stop-system"]');
  assert.equal(state().systemShared, false); assert.equal(state().presenter, 'self');
  assert.equal(state().view, 'watch'); assert.equal(state().mic, true);
});
await test('mic denied allows viewing and permission retry', async () => {
  await scenario('denied');
  assert.match(surface().textContent, /麦克风/);
  await click('[data-world="start"]'); await act('watch');
  assert.equal(state().view, 'watch'); assert.equal(state().mic, false);
  await act('retry'); assert.ok(document.querySelector('#overlay-layer [data-action="retry-mic"]'));
  await click('#overlay-layer [data-action="retry-mic"]');
  assert.equal(state().mic, true); assert.equal(state().view, 'watch');
});
await test('create and end room via dialogs', async () => {
  await scenario('nearby'); await act('create'); input('create-name', '测试房间');
  await click('#overlay-layer [data-action="confirm-create"]');
  assert.equal(state().scene, 'room'); assert.equal(state().roomName, '测试房间'); assert.equal(state().owner, true); assert.equal(state().mic, false);
  await act('leave'); await click('#overlay-layer [data-action="confirm-leave"]');
  assert.equal(state().scene, 'entry');
});
await test('manual join rejects invalid IPv4 then accepts valid address', async () => {
  await scenario('nearby'); await act('manual'); input('manual-address', '192.168.1.999');
  await click('#overlay-layer [data-action="confirm-manual"]');
  assert.equal(state().scene, 'entry'); assert.ok(document.querySelector('#overlay-layer [role="alert"]'));
  input('manual-address', '192.168.1.20'); input('manual-port', '45678'); input('manual-code', 'DEMO2026');
  await click('#overlay-layer [data-action="confirm-manual"]');
  assert.equal(state().scene, 'room'); assert.equal(state().mic, false);
});
await test('sound panel values survive layout and theme changes; source cancellation leaves share empty', async () => {
  await scenario('handoff'); await act('sound');
  let slider = document.querySelector('#overlay-layer [data-volume="owner"]'); assert.ok(slider);
  slider.value = '0.4'; slider.dispatchEvent(new window.Event('input', { bubbles: true }));
  select('theme-choice', 'lounge'); select('layout-voice', 'edge'); await tick();
  slider = document.querySelector('#overlay-layer [data-volume="owner"]'); assert.ok(slider);
  assert.equal(Number(slider.value), 0.4); assert.equal(state().volumes.owner, 0.4);
  await act('close'); await act('share'); await act('close');
  assert.equal(state().presenter, null); assert.equal(state().volumes.owner, 0.4);
});
await test('world controls start and stop friend sharing without taking over own share', async () => {
  await scenario('chat'); await click('[data-world="start"]');
  assert.ok(state().presenter && state().presenter !== 'self'); assert.equal(state().view, 'voice');
  await click('[data-world="stop"]'); assert.equal(state().presenter, null);
  await scenario('broadcasting');
  assert.ok(document.querySelector('[data-world="start"]').disabled);
  assert.ok(document.querySelector('[data-world="stop"]').disabled);
  assert.equal(state().presenter, 'self');
});
await test('style shortcuts preserve state independently of layout presets', async () => {
  await scenario('broadcasting');const before=state();
  await click('[data-style="cinema"]');
  assert.equal(state().theme,'cinema');assert.equal(state().presenter,'self');assert.equal(state().mic,before.mic);
  await click('[data-preset="portal"]');assert.equal(state().theme,'cinema');assert.equal(state().presenter,'self');
  await click('[data-preset="mix"]');assert.equal(state().theme,'cinema');assert.equal(state().view,'watch');
});
await test('muted member shows matching text and pressed state', async () => {
  await scenario('chat');await act('member','owner');await act('mute','owner');
  const row=document.querySelector('#person-audio-owner').closest('.d-audio-row');
  assert.equal(row.querySelector('output').textContent,'已静音');
  assert.equal(row.querySelector('[data-action="mute"]').getAttribute('aria-pressed'),'true');
});
await test('late clipboard failure after closing dialog is handled', async () => {
  let rejectCopy;
  navigator.clipboard.writeText=()=>new Promise((_,reject)=>{rejectCopy=reject;});
  await scenario('nearby');await click('[data-lab="copy"]');await act('copy-config');await act('close');
  rejectCopy(new Error('clipboard unavailable'));await tick();
  assert.equal(document.querySelector('#combo-text'),null);
  assert.match(document.querySelector('#demo-toast').textContent,/复制未完成/);
  navigator.clipboard.writeText=async()=>{};
});
await test('switching my own broadcast to voice stops sharing but preserves the microphone', async () => {
  await scenario('broadcasting');
  const mic = state().mic;
  await act('voice');
  assert.equal(state().view, 'voice');
  assert.equal(state().presenter, null);
  assert.equal(state().systemShared, false);
  assert.equal(state().mic, mic);
});
await test('presenter controls expose only that person and the shared sound', async () => {
  await scenario('watching');await act('member','owner');
  assert.ok(document.querySelector('#person-audio-owner'));
  assert.ok(document.querySelector('#person-audio-system'));
  assert.equal(document.querySelector('#person-audio-friend'),null);
  await act('close');await act('member','friend');
  assert.ok(document.querySelector('#person-audio-friend'));
  assert.equal(document.querySelector('#person-audio-system'),null);
});
await test('room sound panel lists each real source once and explains local-only volume', async () => {
  await scenario('watching'); await act('sound');
  const labels = [...document.querySelectorAll('#overlay-layer .d-audio-row label')].map(node => node.textContent);
  assert.deepEqual(labels, ['房主的语音', '成员的语音', '共享的游戏声音']);
  assert.equal(document.querySelectorAll('#overlay-layer .d-audio-note').length, 1);
  await act('close'); await scenario('silent'); await act('sound');
  assert.equal(document.querySelector('#overlay-layer [data-volume="system"]'), null);
  assert.match(document.querySelector('#overlay-layer').textContent, /没有.*游戏声音/);
});
await test('unavailable voice sources do not expose a fake volume control', async () => {
  await scenario('waiting-audio');await act('member','owner');
  assert.equal(document.querySelector('#person-audio-owner'),null);
  assert.match(document.querySelector('#overlay-layer').textContent,/等待.*语音/);
});
await test('own member controls do not offer remote self-listening', async () => {
  await scenario('broadcasting');await act('member','self');
  assert.equal(document.querySelector('#overlay-layer input[type=range]'),null);
  assert.match(document.querySelector('#overlay-layer').textContent,/系统声音/);
});
await test('joining a live room uses the same initial watching choice in every structure', async () => {
  for (const route of routes) {
    await click('[data-preset="'+route+'"]');
    await scenario('nearby');await act('join','game');
    assert.equal(state().view,'watch',route+' cannot change initial viewing behavior');
    assert.equal(state().mic,false);
  }
});
await test('a reconnecting presenter never exposes available full-screen playback', async () => {
  for (const route of routes) {
    await click('[data-preset="'+route+'"]');await scenario('reconnecting');
    const fullscreen=surface().querySelector('[data-action="fullscreen"]');
    assert.ok(!fullscreen||fullscreen.disabled,route+' must wait for its picture');
  }
});
await test('Escape exits browser full-screen before leaving focused preview', async () => {
  await scenario('watching');
  document.body.classList.add('lab-focus');
  document.fullscreenElement=document.querySelector('#product-canvas');
  let exits=0;
  document.exitFullscreen=async()=>{exits++;document.fullscreenElement=null;};
  const escape=new window.Event('keydown',{bubbles:true,cancelable:true});escape.key='Escape';
  document.dispatchEvent(escape);await tick();
  assert.equal(exits,1);
  assert.ok(document.body.classList.contains('lab-focus'));
  delete document.exitFullscreen;
});
await test('room card keeps its identity through joining and return', async () => {
  await click('[data-preset="portal"]'); await scenario('nearby');
  const card = surface().querySelector('[data-room-id="game"]');
  assert.match(card.textContent, /今晚一起玩/);
  card.querySelector('[data-action="join"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.equal(state().joiningRoom, 'game');
  assert.ok(surface().querySelector('[data-room-id="game"][data-joining="true"] #portal-joining-status'));
  await tick();
  assert.equal(state().roomId, 'game'); assert.equal(state().joiningRoom, '');
  assert.match(surface().querySelector('.portal-room-shell').textContent, /今晚一起玩/);
  await act('confirm-leave'); assert.ok(surface().querySelector('[data-room-id="game"]'));
});
await test('table keeps personal controls at the matching seat', async () => {
  await click('[data-preset="orbit"]'); await scenario('chat');
  for (const id of ['owner', 'friend']) assert.ok(surface().querySelector(`[data-volume="${id}"]`).closest('.orbit-seat'));
  assert.ok(surface().querySelector('.orbit-seat-self [data-action="mic"]'));
  await scenario('waiting-audio');
  assert.ok(surface().querySelector('[data-volume="owner"]').disabled);
  assert.match(surface().querySelector('[data-volume="owner"]').closest('.orbit-seat').textContent, /等待该成员语音/);
});
await test('table microphone status follows the local setting', async () => {
  await click('[data-preset="orbit"]'); await scenario('chat');
  assert.match(surface().querySelector('.orbit-seat-self').textContent, /麦克风已开启/);
  await act('mic');
  assert.match(surface().querySelector('.orbit-seat-self').textContent, /麦克风已关闭/);
  assert.equal(surface().querySelector('.orbit-seat-self [data-action="mic"]').getAttribute('aria-pressed'), 'false');
});
await test('picture-first stop leads to a nearby voluntary share action', async () => {
  await click('[data-preset="edge"]'); await scenario('watching');
  assert.ok(surface().querySelector('.edge-stage .d-screen-image'));
  assert.ok(surface().querySelector('.edge-action-bar [data-action="mic"]'));
  const mic = state().mic;
  await click('[data-world="stop"]');
  assert.equal(state().view, 'voice'); assert.equal(state().mic, mic);
  assert.ok(surface().querySelector('.edge-voice-hint + [data-action="share"]'));
  await act('share'); await act('close');
  assert.equal(state().presenter, null); assert.equal(state().mic, mic);
});
await test('relay keeps the activity and next action in the same leading region', async () => {
  await click('[data-preset="relay"]'); await scenario('watching');
  assert.match(surface().querySelector('.re-watch-copy').textContent, /房主正在分享/);
  assert.ok(surface().querySelector('.re-watch-bar [data-action="sound"]'));
  await click('[data-world="stop"]');
  const main = surface().querySelector('.relay-voice .re-main');
  assert.ok(main.querySelector('.re-activity [data-action="share"]'));
  assert.ok([...main.children].indexOf(main.querySelector('.re-activity')) < [...main.children].indexOf(main.querySelector('.re-bar')));
  assert.equal(state().presenter, null);
});
await test('disconnected empty source waits for confirmed room state', async () => {
  await click('[data-preset="source"]'); await scenario('chat');
  await click('[data-world="drop"]');
  assert.equal(state().presenter, null);
  assert.match(surface().querySelector('.so-idle').textContent, /等待连接恢复/);
  assert.doesNotMatch(surface().querySelector('.so-idle').textContent, /先聊着|可以打开画面/);
  assert.ok(surface().querySelector('.d-notice [data-action="retry"]'));
});
await test('silent sharing explains the available source in channel and relay', async () => {
  await click('[data-preset="channel"]'); await scenario('silent');
  assert.match(surface().querySelector('.ch-presenter').textContent, /没有共享系统声音/);
  await scenario('broadcasting');
  assert.match(surface().querySelector('.ch-presenter').textContent, /系统声音.*隔离状态未确认/);
  await click('[data-preset="relay"]'); await scenario('silent'); await act('voice');
  const activity = surface().querySelector('.re-activity');
  assert.match(activity.textContent, /没有共享系统声音/);
  assert.match(activity.querySelector('.re-source').textContent, /可调整语音/);
  assert.doesNotMatch(activity.querySelector('.re-source').textContent, /共享声音/);
});
await test('source-led viewing keeps the presenter actionable and labels the simulated picture once', async () => {
  await click('[data-preset="source"]'); await scenario('watching');
  assert.ok(surface().querySelector('.so-watch-source [data-action="member"][data-value="owner"]'));
  assert.equal(surface().querySelector('.so-screen .d-screen-caption').textContent.trim(), '演示画面');
  await click('.so-watch-source [data-action="member"]');
  assert.ok(document.querySelector('#person-audio-owner'));
  assert.ok(document.querySelector('#person-audio-system'));
  await act('close');
});
await test('no real capture or network calls', async () => { assert.deepEqual(forbidden, []); });
console.log(`\n${passed} passed; ${failed} failed (${bundled?'standalone bundle':'source'} offline DOM/state only; no browser or CSS verification)`);
if (failed) process.exitCode = 1;
