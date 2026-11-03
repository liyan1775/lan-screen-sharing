import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { installSyntheticMedia } from './fixtures/synthetic-media.js';
import { selectedLANIPv4, shutdownOwnedServices, startOwnedService } from './fixtures/services.js';

const browserPath = process.env.LANSW_BROWSER_PATH;

function auditLocalRequests(context, externalRequests) {
  const checkURL = (target) => {
    let hostname;
    try { hostname = new URL(target).hostname; } catch { return; }
    if (!['localhost', '127.0.0.1', '::1'].includes(hostname)) externalRequests.push(target);
  };
  context.on('request', (request) => checkURL(request.url()));
  context.on('websocket', (socket) => checkURL(socket.url()));
}

async function createScenario({ denyViewerMic = false } = {}) {
  if (!process.env.LANSW_EXE) throw new Error('Set LANSW_EXE to the built test executable before running BrowserE2E.');
  if (!browserPath) throw new Error('Set LANSW_BROWSER_PATH to an installed Chromium or Edge executable before running BrowserE2E.');
  const lanIP = selectedLANIPv4();
  const services = [];
  const externalRequests = [];
  let browser;
  const contexts = [];
  try {
    const signalPorts = new Set();
    while (signalPorts.size < 3) {
      const service = await startOwnedService({ lanIP });
      const signalPort = Number(service.signalPort);
      if (signalPorts.has(signalPort)) { await service.shutdown(); continue; }
      signalPorts.add(signalPort);
      services.push(service);
    }
    browser = await chromium.launch({ headless: true, executablePath: browserPath, args:['--mute-audio'] });
    const context = async (denyMicrophone = false) => {
      const value = await browser.newContext();
      contexts.push(value);
      auditLocalRequests(value, externalRequests);
      await value.addInitScript(installSyntheticMedia, { denyMicrophone });
      return value;
    };
    const hostContext = await context();
    const viewer1Context = await context(denyViewerMic);
    const viewer2Context = await context();
    const host = await hostContext.newPage();
    const viewer1 = await viewer1Context.newPage();
    const viewer2 = await viewer2Context.newPage();
    await host.goto(services[0].baseURL);
    await host.locator('#quick-create-room').click();
    await host.locator('#create-room').click();
    await host.locator('#invite-room').click();
    await host.locator('.invite-card').waitFor({ state: 'visible' });
    const invite = await host.evaluate(() => ({
      hostIPv4: document.querySelector('#host-address').value,
      hostPort: Number(document.querySelector('#host-port').value),
      roomCode: document.querySelector('#room-code').textContent,
    }));
    assert.equal(invite.hostIPv4, lanIP, 'host invite must use the selected private interface');
    assert.ok(invite.hostPort > 0, 'host invite must expose the port bound after room creation');
    await host.locator('#invite-dialog [data-close-dialog]').click();

    async function join(page, service) {
      await page.goto(service.baseURL);
      await page.locator('#quick-manual-join').click();
      await page.locator('#join-address').fill(invite.hostIPv4);
      await page.locator('#join-port').fill(String(invite.hostPort));
      await page.locator('#join-code').fill(invite.roomCode);
      await page.locator('#join-room').click();
      await page.locator('#toggle-mic').waitFor({ state: 'visible' });
    }
    await join(viewer1, services[1]);
    await join(viewer2, services[2]);
    await Promise.all([host, viewer1, viewer2].map((page) => page.waitForFunction(() => document.querySelectorAll('#members .member-seat:not([data-empty="true"])').length === 3)));
    return {
      browser, contexts, services, host, viewers: [viewer1, viewer2], invite, externalRequests, auditContext: (value) => auditLocalRequests(value, externalRequests),
      async close() {
        await Promise.allSettled(contexts.map((value) => value.close()));
        await browser.close().catch(() => {});
        await shutdownOwnedServices(services);
      },
    };
  } catch (error) {
    await Promise.allSettled(contexts.map((value) => value.close()));
    await browser?.close().catch(() => {});
    await shutdownOwnedServices(services);
    throw error;
  }
}

async function withScenario(t, options, action) {
  const scenario = await createScenario(options);
  t.after(() => scenario.close());
  const result = await action(scenario);
  assert.deepEqual(scenario.externalRequests, [], 'browser contexts must not contact external network services');
  return result;
}

async function enableMic(page) { await page.locator('#toggle-mic').click(); }

async function shareSyntheticScreen(page) {
  // Use the real capture control; the fixture supplies synthetic tracks.
  await page.locator('#open-settings').click();
  await page.locator('#share-mode').selectOption('combined');
  await page.locator('#settings-dialog [data-close-dialog]').click();
  await page.locator('#start-share').click();
  await page.locator('#open-settings').click();
  await page.locator('.settings-section > summary').click();
  await page.locator('#manual-verify-start').click();
  await page.locator('#settings-dialog [data-close-dialog]').click();
}

async function openDiagnostics(page) {
  await page.locator('#open-settings').click();
  if (!await page.locator('.settings-section').evaluate(node=>node.open)) await page.locator('.settings-section > summary').click();
}

async function waitForMesh(pages) {
  await Promise.all(pages.map((page) => page.waitForFunction(() => {
    const state = window.__lanScreenTest;
    return state?.pcs.length >= 2 && state.pcs.every((pc) => pc.connectionState === 'connected');
  }, { timeout: 25_000 })));
}

async function memberIds(page) {
  return page.locator('#members .member-seat:not([data-empty="true"])').evaluateAll((seats) => seats.map((seat) => seat.dataset.peerId));
}

async function collectActualPCStats(page) {
  return page.evaluate(async () => {
    const result = [];
    for (const [index, pc] of window.__lanScreenTest.pcs.entries()) {
      const reports = await pc.getStats();
      for (const report of reports.values()) {
        if (report.type === 'outbound-rtp' || report.type === 'inbound-rtp') result.push({
          pc: index, state: pc.connectionState, type: report.type, kind: report.kind ?? report.mediaType,
          bytes: report.bytesSent ?? report.bytesReceived ?? 0,
          frames: report.framesEncoded ?? report.framesDecoded ?? report.framesSent ?? report.framesReceived ?? 0,
          width: report.frameWidth, height: report.frameHeight, fps: report.framesPerSecond,
        });
      }
    }
    return result;
  });
}

async function assertTrackRoleMapping(page, role) {
  const data = await page.evaluate(async () => {
    const messages = window.__lanScreenTest.incoming;
    const own = messages.find((message) => message.type === 'room.created' || message.type === 'room.joined');
    const memberIds = [...document.querySelectorAll('#members .member-seat:not([data-empty="true"])')].map((element) => element.dataset.peerId);
    const hostPeerId = messages.find((message) => message.type === 'room.joined')?.payload?.members?.find((member) => member.role === 'host')?.peerId ?? own?.peerId;
    const sources = new Map();
    for (const message of messages.filter((item) => item.type === 'rtc.description' && item.payload?.fromPeerId)) {
      const roles = sources.get(message.payload.fromPeerId) ?? new Set();
      for (const track of message.payload.tracks ?? []) roles.add(track.role);
      sources.set(message.payload.fromPeerId, roles);
    }
    let inboundVideoBytes=0;
    for(const pc of window.__lanScreenTest.pcs)for(const report of (await pc.getStats()).values())if(report.type==='inbound-rtp'&&(report.kind??report.mediaType)==='video')inboundVideoBytes+=report.bytesReceived??0;
    return {
      ownPeerId: own?.peerId,
      hostPeerId,
      memberIds,
      receivedKinds: window.__lanScreenTest.received.map((track) => track.kind),
      sources: [...sources].map(([peerId, roles]) => ({ peerId, roles: [...roles] })),
      inboundVideoBytes,
    };
  });
  const remoteSources = data.sources.filter((source) => source.peerId !== data.ownPeerId);
  assert.ok(data.ownPeerId && data.memberIds.includes(data.ownPeerId), 'the local identity must match an authenticated room member');
  assert.ok(remoteSources.length >= 1, 'incoming track sidecars must be attributed to remote peers');
  assert.ok(remoteSources.every((source) => data.memberIds.includes(source.peerId)), 'server-derived fromPeerId values must match authenticated room members');
  assert.ok(data.receivedKinds.includes('audio'), 'native received audio tracks must reach the browser');
  if (role === 'host') {
    assert.equal(data.inboundVideoBytes, 0, 'inactive reserved video slots must not transmit a second screen to the active presenter');
    assert.equal(remoteSources.length, 2, 'host receives tracks from both authenticated viewers');
    for (const source of remoteSources) assert.ok(source.roles.includes('microphone'), `viewer ${source.peerId} exposes the microphone MID mapping`);
  } else {
    assert.ok(data.receivedKinds.includes('video'), 'a native received video track must reach each viewer');
    const host = remoteSources.find((source) => source.peerId === data.hostPeerId);
    assert.ok(host, 'the authenticated host is the source of screen tracks');
    for (const sourceRole of ['screenVideo', 'systemAudio', 'microphone']) assert.ok(host.roles.includes(sourceRole), `host mid sidecar must map ${sourceRole}`);
    const otherViewers = remoteSources.filter((source) => source.peerId !== data.hostPeerId);
    for (const source of otherViewers) assert.deepEqual(new Set(source.roles), new Set(['screenVideo','systemAudio','microphone']), 'each member reserves slots to allow later presentation handoff');
  }
}

test('hostPlusTwoViewersExchangeSyntheticTracks', async (t) => withScenario(t, {}, async ({ host, viewers }) => {
  await Promise.all([host, ...viewers].map(enableMic));
  await shareSyntheticScreen(host);
  await waitForMesh([host, ...viewers]);
  await assertTrackRoleMapping(host, 'host');
  await Promise.all(viewers.map((page) => assertTrackRoleMapping(page, 'viewer')));
  const ids = await memberIds(host);
  assert.equal(new Set(ids).size, 3, 'the room must contain three distinct authenticated peers');
  for (const page of [host, ...viewers]) {
    const stats = await collectActualPCStats(page);
    assert.ok(stats.some((item) => item.kind === 'video' && item.bytes > 0 && item.frames > 0), 'native RTCPeerConnection video stats must show sent/received frames and bytes');
    assert.ok(stats.some((item) => item.kind === 'audio' && item.bytes > 0), 'native RTCPeerConnection audio stats must show real transport bytes');
  }
  const descriptions = await host.evaluate(() => window.__lanScreenTest.sent.filter((message) => message.type === 'rtc.description'));
  const pairTargets = new Set(descriptions.map((message) => message.payload?.toPeerId).filter(Boolean));
  assert.equal(pairTargets.size, 2, 'host must negotiate independently with each viewer');
  assert.ok(descriptions.some((message) => message.payload?.tracks?.some((track) => track.role === 'screenVideo')));
  assert.ok(descriptions.some((message) => message.payload?.tracks?.some((track) => track.role === 'systemAudio')));
  assert.ok(descriptions.some((message) => message.payload?.tracks?.some((track) => track.role === 'microphone')));
  const pairs = new Set();
  for (const page of [host, ...viewers]) {
    const pagePairs = await page.evaluate(() => {
      const connected = [...window.__lanScreenTest.incoming, ...window.__lanScreenTest.sent];
      const ownMessage = connected.findLast((message) => message.type === 'room.created' || message.type === 'room.joined');
      const ownPeerId = ownMessage?.peerId;
      return connected.filter((message) => message.type === 'rtc.description').map((message) => {
        const otherPeerId = message.payload?.toPeerId ?? message.payload?.fromPeerId;
        return [ownPeerId, otherPeerId].filter(Boolean).sort().join(':');
      });
    });
    for (const pair of pagePairs) pairs.add(pair);
  }
  assert.equal(pairs.size, 3, 'the native peer connections must cover host-viewer pairs and the viewer-viewer pair');
}));

test('thirdViewerIsRejected', async (t) => withScenario(t, {}, async ({ browser, contexts, services, invite, viewers, auditContext }) => {
  const extraService = await startOwnedService({ lanIP: invite.hostIPv4 });
  services.push(extraService);
  const context = await browser.newContext();
  contexts.push(context);
  auditContext(context);
  await context.addInitScript(installSyntheticMedia, {});
  const third = await context.newPage();
  await third.goto(extraService.baseURL);
  await third.locator('#quick-manual-join').click();
  await third.locator('#join-address').fill(invite.hostIPv4);
  await third.locator('#join-port').fill(String(invite.hostPort));
  await third.locator('#join-code').fill(invite.roomCode);
  await third.locator('#join-room').click();
  await third.locator('#error-message').waitFor({ state: 'visible' });
  assert.match(await third.locator('#error-message').textContent(), /房间已满/);
  assert.equal(await third.locator('#toggle-mic').isVisible(), false, 'rejected viewer must not enter media UI');
  const requestId = `viewer-host-control-${crypto.randomUUID()}`;
  await viewers[0].evaluate((id) => {
    const socket = window.__lanScreenTest.sockets.at(-1);
    socket.send(JSON.stringify({ v: 1, type: 'host.endRoom', requestId: id, roomId: 'forged-room', payload: {} }));
  }, requestId);
  await viewers[0].waitForFunction((id) => window.__lanScreenTest.incoming.some((message) => message.type === 'error' && message.requestId === id), requestId);
  const denied = await viewers[0].evaluate((id) => window.__lanScreenTest.incoming.find((message) => message.type === 'error' && message.requestId === id),requestId);
  assert.equal(denied.payload.code, 'HOST_ONLY', 'a joined viewer cannot forge a host room-ending command');
}));

test('viewerCanJoinWithMicDenied', async (t) => withScenario(t, { denyViewerMic: true }, async ({ host, viewers }) => {
  await shareSyntheticScreen(host);
  await enableMic(viewers[1]);
  await viewers[0].locator('#toggle-mic').click();
  await viewers[0].locator('#error-message').waitFor({ state: 'visible' });
  assert.match(await viewers[0].locator('#error-message').textContent(), /仍可观看并听取房间语音/);
  await waitForMesh([host, ...viewers]);
  await viewers[0].waitForFunction(() => window.__lanScreenTest.received.some((track) => track.kind === 'video'));
  await viewers[0].waitForFunction(() => window.__lanScreenTest.received.some((track) => track.kind === 'audio'));
  await assertTrackRoleMapping(viewers[0], 'viewer');
  const capture = await viewers[0].evaluate(() => window.__lanScreenTest.captures.find((item) => item.type === 'microphone-request'));
  assert.equal(capture.denied, true, 'microphone denial must come from the synthetic permission fixture');
  assert.equal(await viewers[0].locator('#toggle-mic').isVisible(), true);
  assert.ok((await viewers[0].locator('.audio-source[data-role="microphone"]').count()) >= 1, 'denied viewer still receives another member\'s microphone track');
}));

test('screenStopPreservesVoice', async (t) => withScenario(t, {}, async ({ host, viewers }) => {
  await Promise.all([host, ...viewers].map(enableMic));
  await shareSyntheticScreen(host);
  await waitForMesh([host, ...viewers]);
  await host.locator('#stop-share').click();
  await host.waitForFunction(() => window.__lanScreenTest.pcs.every((pc) => pc.connectionState === 'connected'));
  await new Promise((resolve) => setTimeout(resolve, 2100));
  const senders = await host.evaluate(() => window.__lanScreenTest.pcs.flatMap((pc) => pc.getSenders().map((sender) => ({ kind: sender.track?.kind ?? null }))));
  assert.ok(senders.some((sender) => sender.kind === 'audio'), 'voice sender remains attached after screen stop');
  const stats = await Promise.all([host, ...viewers].map(collectActualPCStats));
  assert.ok(stats.flat().some((item) => item.kind === 'audio' && item.bytes > 0), 'voice continues carrying native RTP bytes after screen stop');
  await openDiagnostics(host);
  assert.equal(await host.locator('#actual-stats').isVisible(), true);
}));

test('viewerViewerVoiceConnects', async (t) => withScenario(t, {}, async ({ host, viewers }) => {
  await Promise.all([host, ...viewers].map(enableMic));
  await waitForMesh([host, ...viewers]);
  const [first, second] = await Promise.all(viewers.map((page) => memberIds(page)));
  assert.equal(new Set(first).size, 3);
  assert.equal(new Set(second).size, 3);
  for (const page of viewers) {
    const descriptions = await page.evaluate(() => window.__lanScreenTest.sent.filter((message) => message.type === 'rtc.description'));
    const otherViewer = await page.locator('#members .member-seat[data-role="viewer"]:not([data-self="true"])').getAttribute('data-peer-id');
    const viewerPair = descriptions.find((message) => message.payload?.toPeerId === otherViewer);
    assert.ok(viewerPair, 'each viewer negotiates an independent connection');
    assert.deepEqual(new Set(viewerPair.payload.tracks.map((track) => track.role)), new Set(['screenVideo','systemAudio','microphone']), 'all members reserve media slots so any member can later share');
    await page.waitForFunction(() => window.__lanScreenTest.received.some((track) => track.kind === 'audio'));
  }
  let viewerStats=[], ready=false;
  const deadline=Date.now()+10000;
  while(Date.now()<deadline){
    viewerStats=await Promise.all(viewers.map(collectActualPCStats));
    ready=viewerStats.every(rows=>[0,1].every(pc=>['outbound-rtp','inbound-rtp'].every(type=>rows.some(row=>row.pc===pc&&row.type===type&&row.kind==='audio'&&row.bytes>0))));
    if(ready)break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  const diagnosis = await Promise.all(viewers.map(page=>page.evaluate(()=>({sources:window.__lanScreenTest.sources.map(s=>({label:s.label,context:s.audio.state,track:s.track.readyState})),senders:window.__lanScreenTest.pcs.map(pc=>pc.getSenders().map(s=>({kind:s.track?.kind,state:s.track?.readyState}))),error:document.querySelector('#error-message').textContent}))));
  assert.ok(ready, 'every viewer connection must send and receive native audio RTP bytes: '+JSON.stringify({viewerStats,diagnosis}));
}));

test('localSocketLossStopsMediaAndFreshJoinReclaimsSeat', async (t) => withScenario(t, {}, async ({ host, viewers, invite, services }) => {
  const viewer = viewers[0];
  const original = await viewer.evaluate(() => {
    const joined = [...window.__lanScreenTest.incoming, ...window.__lanScreenTest.sent].findLast((message) => message.type === 'room.joined');
    return { roomId: joined.roomId, peerId: joined.peerId, resumeToken: joined.payload.resumeToken };
  });
  assert.ok(original.peerId && original.resumeToken, 'initial UI join receives an authenticated identity');
  await enableMic(viewer);
  await viewer.evaluate(() => window.__lanScreenTest.sockets.findLast(socket=>new URL(socket.url).pathname==='/ws/v1'&&socket.readyState===WebSocket.OPEN).close());
  await viewer.locator('body[data-stage="entry"]').waitFor();
  assert.match(await viewer.locator('#error-message').textContent(),/采集已停止/);
  assert.equal(await viewer.evaluate(()=>window.__lanScreenTest.pcs.every(pc=>pc.connectionState==='closed')),true,'loss of the local service connection closes media');
  await host.waitForFunction((peerId) => {
    return ![...document.querySelectorAll('#members .member-seat')].some(element=>element.dataset.peerId===peerId);
  }, original.peerId, { timeout: 25000 });
  await viewer.locator('#quick-manual-join').click();
  await viewer.locator('#join-address').fill(invite.hostIPv4);await viewer.locator('#join-port').fill(String(invite.hostPort));await viewer.locator('#join-code').fill(invite.roomCode);await viewer.locator('#join-room').click();
  await viewer.locator('body[data-stage="voice"]').waitFor();
  const rejoined=await viewer.evaluate(()=>window.__lanScreenTest.incoming.findLast(message=>message.type==='room.joined'));
  assert.equal(rejoined.roomId,original.roomId);assert.notEqual(rejoined.peerId,original.peerId,'fresh rejoin retires the cleaned local identity');
  assert.equal(await viewer.locator('#toggle-mic').getAttribute('aria-pressed'),'false','fresh join cannot implicitly recapture microphone');
  const hostIds = await memberIds(host);
  assert.ok(hostIds.includes(rejoined.peerId), 'fresh viewer rejoins the same room');
  assert.equal(services.length, 3);
}));

test('isolationSettingsDoNotMarkRealValidation', async (t) => withScenario(t, {}, async ({ host }) => {
  await shareSyntheticScreen(host);
  await openDiagnostics(host);
  await host.locator('#manual-check-status').waitFor({ state: 'visible' });
  const status = await host.locator('#isolation-status').textContent();
  assert.match(status, /浏览器报告约束已应用/);
  assert.doesNotMatch(status, /实机确认|人工确认通过/);
  assert.equal(await host.locator('#manual-verify-pass').isVisible(), true, 'test does not click or synthesize the user confirmation action');
}));

test('qualityStatsAreActualNotCSS', async (t) => withScenario(t, {}, async ({ host, viewers }) => {
  await shareSyntheticScreen(host);
  await openDiagnostics(host);
  await waitForMesh([host, ...viewers]);
  await host.waitForFunction(() => /实际 \d+×\d+/.test(document.querySelector('#actual-stats').textContent));
  const uiText = await host.locator('#actual-stats').textContent();
  assert.match(uiText, /FPS|分辨率|码率/);
  const stats = await collectActualPCStats(host);
  const video = stats.find((item) => item.kind === 'video' && item.bytes > 0 && item.frames > 0 && item.width > 0 && item.height > 0);
  assert.ok(video, 'native PC stats must contain encoded video dimensions, frames and bytes');
  assert.match(uiText, new RegExp(`${video.width}×${video.height}`));
  const declaration = await host.locator('#actual-stats').evaluate((element) => getComputedStyle(element).display);
  assert.notEqual(declaration, 'none', 'actual stats are read from visible product UI as well as native PC reports');
}));
