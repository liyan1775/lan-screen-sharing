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
const html = fs.readFileSync(path.join(here, bundled ? '../前端设计实验室.html' : 'index.html'), 'utf8');
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

await test('81 independent layout/theme combinations render all phases', async () => {
  const routes = ['portal', 'orbit', 'edge'];
  for (const theme of ['cinema', 'lounge', 'precision']) for (const entry of routes) for (const voice of routes) for (const watch of routes) {
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
  for (const route of ['portal', 'orbit', 'edge']) {
    select('layout-entry', route); await scenario('full');
    const join = surface().querySelector('[data-action="join"]'); assert.ok(join && join.disabled, route);
    assert.match(surface().textContent, /已满/);
    await act('join', 'full'); assert.equal(state().scene, 'entry');
  }
});
await test('blocked discovery can retry', async () => {
  await scenario('blocked');
  const retry = surface().querySelector('[data-action="refresh"], [data-action="retry"]'); assert.ok(retry);
  await act(retry.getAttribute('data-action')); assert.notEqual(state().discovery, 'blocked');
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
  select('layout-voice', 'orbit'); await scenario('chat');
  const input = surface().querySelector('[data-volume="owner"]'); assert.ok(input);
  input.value = '0.35'; input.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(state().volumes.owner, 0.35); assert.equal(state().volumes.friend, 1);
});
await test('every voice route exposes viewing while share is occupied', async () => {
  for (const route of ['portal', 'orbit', 'edge']) {
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
  select('layout-voice','orbit');await scenario('chat');await act('mute','owner');
  const seat=surface().querySelector('#orbit-volume-owner').closest('.orbit-seat');
  assert.equal(seat.querySelector('output').textContent,'已静音');
  assert.equal(seat.querySelector('[data-action="mute"]').getAttribute('aria-pressed'),'true');
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
await test('no real capture or network calls', async () => { assert.deepEqual(forbidden, []); });
console.log(`\n${passed} passed; ${failed} failed (${bundled?'standalone bundle':'source'} offline DOM/state only; no browser or CSS verification)`);
if (failed) process.exitCode = 1;
