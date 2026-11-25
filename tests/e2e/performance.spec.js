import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { installSyntheticMedia } from './fixtures/synthetic-media.js';
import { startOwnedService, shutdownOwnedServices } from './fixtures/services.js';

// Count product work, not the calls made by the test's own transport assertions.
function observeBackgroundWork() {
  const work = { stats: 0, voiceLinkStats: 0, roomRequests: 0, discoveryProbes: 0, diagnosticsMutations: 0, qualityMutations: 0, replayedSizes: 0, omittedSizes: 0 };
  window.__performanceWork = work;
  const nativeStats = RTCPeerConnection.prototype.getStats;
  RTCPeerConnection.prototype.getStats = function (...args) {
    work.stats++;
    if (!this.getTransceivers().some(transceiver => transceiver.receiver.track.kind === 'video')) work.voiceLinkStats++;
    const sample = nativeStats.apply(this, args);
    if (!window.__repeatOutboundDimensions) return sample;
    return sample.then(reports => {
      const replay = new Map(reports);
      for (const [id, report] of reports) {
        if (report.type !== 'outbound-rtp' || (report.kind ?? report.mediaType) !== 'video' || !report.framesEncoded) continue;
        const omitSize = work.replayedSizes === 1 && work.omittedSizes === 0;
        if (omitSize) work.omittedSizes++;
        else work.replayedSizes++;
        replay.set(id, { ...report, frameWidth: omitSize ? undefined : 1280, frameHeight: omitSize ? undefined : 720 });
      }
      return replay;
    });
  };
  const nativeFetch = window.fetch;
  window.fetch = function (...args) {
    const path = new URL(args[0], location.href).pathname;
    if (path === '/api/v1/rooms') work.roomRequests++;
    if (path === '/api/v1/discovery/refresh') work.discoveryProbes++;
    return nativeFetch.apply(this, args);
  };
  document.addEventListener('DOMContentLoaded', () => {
    const observer = new MutationObserver(records => { work.diagnosticsMutations += records.length; });
    for (const id of ['actual-stats', 'capture-stats', 'performance-hint']) {
      observer.observe(document.getElementById(id), { childList: true, characterData: true, subtree: true });
    }
    window.__qualityMutations = [];
    const qualityObserver = new MutationObserver(records => {
      work.qualityMutations += records.length;
      const trigger = document.getElementById('quality-trigger');
      window.__qualityMutations.push(...records.map(record => ({
        type: record.type, attribute: record.attributeName, old: record.oldValue,
        label: trigger.textContent, degraded: trigger.dataset.degraded, hidden: trigger.hidden,
        sample: work.replayedSizes + work.omittedSizes,
      })));
    });
    qualityObserver.observe(document.getElementById('quality-trigger'), {
      attributes: true, attributeOldValue: true, childList: true, characterData: true, subtree: true,
    });
  });
}

test('idle, voice and screen sessions only perform the background work they need', { timeout: 120_000 }, async t => {
  assert.ok(process.env.LANSW_EXE, 'Set LANSW_EXE to the candidate executable');
  assert.ok(process.env.LANSW_BROWSER_PATH, 'Set LANSW_BROWSER_PATH to Edge or Chromium');
  const baseline = process.env.LANSW_PERF_BASELINE === '1';
  const services = [], pages = [], measurements = {};
  let browser;
  t.after(async () => {
    try { await browser?.close(); }
    finally { await shutdownOwnedServices(services); }
  });
  const args = ['--mute-audio'];
  if (process.env.LANSW_TEST_DISABLE_MDNS === '1') args.push('--disable-features=WebRtcHideLocalIpsWithMdns');
  browser = await chromium.launch({ headless: true, executablePath: process.env.LANSW_BROWSER_PATH, args });
  for (let i = 0; i < 3; i++) {
    const service = await startOwnedService();
    services.push(service);
    const context = await browser.newContext();
    await context.addInitScript(installSyntheticMedia, { participantAlias: ['host', 'viewer-1', 'viewer-2'][i] });
    await context.addInitScript(observeBackgroundWork);
    const page = await context.newPage();
    pages.push(page);
    await page.goto(service.baseURL);
    await page.waitForFunction(() => document.querySelector('#connection-status').textContent.includes('就绪'));
  }
  async function measure(name, duration = 6500) {
    const before = await Promise.all(pages.map(page => page.evaluate(() => ({ ...window.__performanceWork }))));
    await new Promise(resolve => setTimeout(resolve, duration));
    const after = await Promise.all(pages.map(page => page.evaluate(() => ({ ...window.__performanceWork }))));
    const result = after.map((counters, i) => Object.fromEntries(Object.entries(counters).map(([key, value]) => [key, value - before[i][key]])));
    measurements[name] = { milliseconds: duration, pages: result };
    return result;
  }
  const idle = await measure('idle');
  if (!baseline) {
    assert.ok(idle.every(row => row.stats === 0 && row.diagnosticsMutations === 0), 'idle pages do not poll media or rewrite diagnostics');
    assert.ok(idle.every(row => row.roomRequests > 0), 'visible room lists still refresh');
    assert.ok(idle.every(row => row.discoveryProbes === 0), 'automatic room polling stays read-only');
  }
  const [host, ...viewers] = pages;
  await host.locator('#quick-create-room').click();
  await host.locator('#create-room').click();
  await host.locator('#invite-room').click();
  const invite = await host.locator('#invite-text').inputValue();
  await host.locator('#invite-dialog [data-close-dialog]').click();
  for (const page of viewers) {
    await page.locator('#quick-manual-join').click();
    await page.locator('#join-invite').fill(invite);
    await page.locator('#join-room').click();
  }
  await Promise.all(pages.map(page => page.waitForFunction(() => window.__lanScreenTest.pcs.length === 2 && window.__lanScreenTest.pcs.every(pc => pc.connectionState === 'connected'))));
  await Promise.all(pages.map(page=>page.locator('#connection-status').filter({hasText:'媒体已连接'}).waitFor()));
  await Promise.all(pages.map(page => page.locator('#toggle-mic').click()));
  const voice = await measure('voice');
  if (!baseline) assert.ok(voice.every(row => row.stats === 0 && row.roomRequests === 0 && row.diagnosticsMutations === 0), 'voice-only rooms do not poll video stats or hidden discovery');

  await host.locator('#start-share').click();
  await Promise.all(pages.map(page => page.waitForFunction(() => document.querySelector('#remote-screen').videoWidth > 0)));
  measurements.activePlayers = await Promise.all(pages.map(page => page.evaluate(() => [...document.querySelectorAll('video')].filter(video => video.srcObject && !video.paused).length)));
  await host.locator('#connection-status').filter({hasText:'正在共享屏幕'}).waitFor();
  const sharing = await measure('sharingDiagnosticsClosed', 11_000);
  if (!baseline) {
    assert.deepEqual(measurements.activePlayers, [1, 1, 1], 'each participant plays the screen in one video element');
    assert.ok(sharing.every(row => row.roomRequests === 0 && row.diagnosticsMutations === 0));
    assert.ok(sharing[0].stats > 0 && sharing[0].stats <= 2, 'host samples its one encoding connection at low frequency');
    assert.ok(sharing.slice(1).every(row => row.stats >= 4 && row.stats <= 6 && row.voiceLinkStats === 0),
      `visible viewers refresh their incoming quality capsule every two seconds without sampling voice links: ${JSON.stringify(sharing)}`);
  }
  await Promise.all(pages.map(async page => {
    await page.locator('#open-settings').click();
    await page.locator('.settings-section > summary').click();
    await page.waitForFunction(() => /实际 \d+×\d+/.test(document.querySelector('#actual-stats').textContent));
  }));
  assert.match(await host.locator('#quality-target-text').textContent(), /1080p60 · 码率上限 15 Mbps/);
  await host.waitForFunction(()=>/编码关键帧 [1-9]\d* · QP \d+\.\d/.test(document.querySelector('#actual-stats').textContent));
  await Promise.all(viewers.map(page=>page.waitForFunction(()=>
    /解码关键帧 [1-9]\d*/.test(document.querySelector('#actual-stats').textContent))));
  if (!baseline) {
    // Keep native sampling. Replay one size and a short gap where Chromium
    // omits dimensions, so both cases must keep the same capsule stable.
    await host.evaluate(() => { window.__repeatOutboundDimensions = true; });
    await host.waitForFunction(() => window.__performanceWork.replayedSizes === 1 &&
      document.querySelector('#quality-trigger').dataset.degraded === 'true' &&
      document.querySelector('#quality-trigger span').textContent.includes('实发 720p · 目标 1080p'));
  }
  const diagnostics = await measure('sharingDiagnosticsOpen');
  if (!baseline) {
    assert.ok(diagnostics[0].stats >= 2 && diagnostics[0].stats <= 4, 'open diagnostics keep responsive two-second sampling');
    assert.ok(diagnostics.slice(1).every(row => row.stats >= 2 && row.stats <= 4 && row.voiceLinkStats === 0));
    assert.ok(diagnostics[0].replayedSizes >= 1 && diagnostics[0].omittedSizes === 1, 'the capsule was fed a repeated size and a single missing-size reading');
    const writes = await host.evaluate(count => count ? window.__qualityMutations.slice(-count) : [], diagnostics[0].qualityMutations);
    assert.deepEqual(writes, [], 'repeated outbound sizes and a short gap never rewrite the sharing capsule');
    await host.evaluate(() => { window.__repeatOutboundDimensions = false; });
  }
  await Promise.all(pages.map(page => page.locator('#settings-dialog [data-close-dialog]').click()));
  if (!baseline) assert.equal(await host.locator('#voice-only').isVisible(), false);
  await host.getByRole('button', { name: '停止共享', exact: true }).click();
  await Promise.all(pages.map(page => page.waitForFunction(() => document.querySelector('#app').dataset.stage === 'voice')));
  assert.equal(await host.locator('#toggle-mic').getAttribute('aria-pressed'), 'true', 'stopping the screen keeps the microphone on');
  if (!baseline) assert.equal(await host.locator('#quality-trigger').getAttribute('data-degraded'), null);
  const stopped = await measure('screenStopped');
  if (!baseline) assert.ok(stopped.every(row => row.stats === 0 && row.roomRequests === 0 && row.diagnosticsMutations === 0));
  await viewers[0].locator('#leave-room').click();
  await viewers[0].waitForFunction(() => document.querySelector('#app').dataset.stage === 'entry');
  const returned = await measure('returnedToRooms', 3500);
  assert.ok(returned[1].roomRequests > 0, 'leaving a room resumes room discovery');
  for (const page of pages) {
    const errors = await page.evaluate(() => ({ errors: window.__lanScreenTest.network.pageErrors, rejections: window.__lanScreenTest.network.unhandledRejections }));
    assert.deepEqual(errors, { errors: 0, rejections: 0 });
  }
  if (process.env.LANSW_PERF_OUTPUT) await writeFile(process.env.LANSW_PERF_OUTPUT, JSON.stringify({ baseline, measurements }, null, 2) + '\n');
  t.diagnostic(JSON.stringify(measurements));
});
