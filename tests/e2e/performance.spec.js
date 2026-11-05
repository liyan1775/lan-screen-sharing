import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { installSyntheticMedia } from './fixtures/synthetic-media.js';
import { startOwnedService, shutdownOwnedServices } from './fixtures/services.js';

// Count product work, not the calls made by the test's own transport assertions.
function observeBackgroundWork() {
  const work = { stats: 0, roomRequests: 0, diagnosticsMutations: 0 };
  window.__performanceWork = work;
  const nativeStats = RTCPeerConnection.prototype.getStats;
  RTCPeerConnection.prototype.getStats = function (...args) {
    work.stats++;
    return nativeStats.apply(this, args);
  };
  const nativeFetch = window.fetch;
  window.fetch = function (...args) {
    if (new URL(args[0], location.href).pathname === '/api/v1/rooms') work.roomRequests++;
    return nativeFetch.apply(this, args);
  };
  document.addEventListener('DOMContentLoaded', () => {
    const observer = new MutationObserver(records => { work.diagnosticsMutations += records.length; });
    for (const id of ['actual-stats', 'capture-stats', 'performance-hint']) {
      observer.observe(document.getElementById(id), { childList: true, characterData: true, subtree: true });
    }
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
  browser = await chromium.launch({ headless: true, executablePath: process.env.LANSW_BROWSER_PATH, args: ['--mute-audio'] });
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
  await Promise.all(pages.map(page => page.locator('#toggle-mic').click()));
  const voice = await measure('voice');
  if (!baseline) assert.ok(voice.every(row => row.stats === 0 && row.roomRequests === 0 && row.diagnosticsMutations === 0), 'voice-only rooms do not poll video stats or hidden discovery');

  await host.locator('#start-share').click();
  await Promise.all(pages.map(page => page.waitForFunction(() => document.querySelector('#remote-screen').videoWidth > 0)));
  measurements.activePlayers = await Promise.all(pages.map(page => page.evaluate(() => [...document.querySelectorAll('video')].filter(video => video.srcObject && !video.paused).length)));
  const sharing = await measure('sharingDiagnosticsClosed', 11_000);
  if (!baseline) {
    assert.deepEqual(measurements.activePlayers, [1, 1, 1], 'each participant plays the screen in one video element');
    assert.ok(sharing.every(row => row.roomRequests === 0 && row.diagnosticsMutations === 0));
    assert.ok(sharing[0].stats > 0 && sharing[0].stats <= 2, 'host samples its one encoding connection at low frequency');
    assert.ok(sharing.slice(1).every(row => row.stats > 0 && row.stats <= 2), 'viewers sample only the presenter link');
  }
  await Promise.all(pages.map(async page => {
    await page.locator('#open-settings').click();
    await page.locator('.settings-section > summary').click();
    await page.waitForFunction(() => /实际 \d+×\d+/.test(document.querySelector('#actual-stats').textContent));
  }));
  const diagnostics = await measure('sharingDiagnosticsOpen');
  if (!baseline) {
    assert.ok(diagnostics[0].stats >= 2 && diagnostics[0].stats <= 4, 'open diagnostics keep responsive two-second sampling');
    assert.ok(diagnostics.slice(1).every(row => row.stats >= 2 && row.stats <= 4));
  }
  await Promise.all(pages.map(page => page.locator('#settings-dialog [data-close-dialog]').click()));
  await host.locator('#stop-share').click();
  await Promise.all(pages.map(page => page.waitForFunction(() => document.querySelector('#app').dataset.stage === 'voice')));
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
