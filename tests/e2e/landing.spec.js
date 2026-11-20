import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { startSitePreview } from '../../scripts/preview-site.mjs';

const release = 'https://github.com/liyan1775/lan-screen-sharing/releases/download/v0.5.0';
const download = `${release}/lan-screen-sharing-0.5.0-windows-x64.zip`;
const viewports = [[1440, 1000], [768, 1024], [390, 844], [320, 720]];
const output = path.resolve('.superpowers/sdd/lan-screen-sharing/build/landing-first-run');

test('product introduction shows requirements before downloading and plays an accessible, on-demand demonstration', { timeout: 90000 }, async t => {
  assert.ok(process.env.LANSW_BROWSER_PATH, 'provide an installed Chromium browser');
  const preview = await startSitePreview('website');
  let browser;
  t.after(async () => {
    try { await browser?.close(); }
    finally { await preview.close(); }
  });
  browser = await chromium.launch({ headless: true, executablePath: process.env.LANSW_BROWSER_PATH });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  const errors = [];
  const external = [];
  const videoRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin !== preview.url) external.push(request.url());
    if (url.pathname.endsWith('.mp4')) videoRequests.push(request.url());
  });
  await mkdir(output, { recursive: true });
  const evidence = { completed: false, browser: browser.version(), viewports: [], axe: [], errors, external };

  await page.goto(preview.url);
  assert.match(await page.title(), /LAN \/ 分享/);
  assert.match(await page.locator('h1').textContent(), /局域网屏幕共享.*三个人一起看/);
  assert.equal(await page.locator(`a[href="${download}"]`).count(), 2);
  assert.equal(await page.locator(`#installation a[href="${release}/SHA256SUMS.txt"]`).count(), 1);
  const installation = await page.locator('#installation').textContent();
  assert.match(installation, /SmartScreen/);
  assert.match(installation, /Get-FileHash.+SHA256/);
  assert.match(installation, /先看这里\.html/);
  await page.locator('.skip-link').press('Enter');
  assert.equal(await page.locator('#main').evaluate(node => node === document.activeElement), true);
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior), 'auto');

  for (const name of ['text', 'screen', 'voice']) {
    await page.locator(`#tab-${name}`).click();
    assert.equal(await page.locator(`#panel-${name}`).isVisible(), true);
    assert.equal(await page.locator('[role="tabpanel"]:visible').count(), 1);
  }
  await page.locator('#tab-voice').press('ArrowRight');
  assert.equal(await page.locator('#tab-text').evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('End');
  assert.equal(await page.locator('#panel-screen').isVisible(), true);
  await page.keyboard.press('Home');
  assert.equal(await page.locator('#panel-voice').isVisible(), true);
  await page.locator('.faq summary').first().press('Enter');
  assert.equal(await page.locator('.faq details').first().evaluate(node => node.open), true);
  await page.locator('.faq summary').first().press('Enter');
  await page.locator('.demo summary').press('Enter');
  assert.match(await page.locator('.demo details[open]').textContent(), /另外两人继续观看/);
  await page.locator('.demo summary').press('Enter');

  await page.addScriptTag({ path: path.resolve('node_modules/axe-core/axe.min.js') });
  for (const [width, height] of viewports) {
    await page.setViewportSize({ width, height });
    await page.locator('[data-compare="before"]').click();
    assert.equal(await page.locator('.encoder.duplicate').isVisible(), true);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `comparison fits at ${width}px`);
    await page.locator('[data-compare="after"]').click();
    assert.equal(await page.locator('.encoder.duplicate').isVisible(), false);
    await page.evaluate(() => scrollTo(0, 0));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `no horizontal overflow at ${width}px`);
    const firstScreen = await page.locator('.hero h1, .requirements, .hero .button, .install-note').evaluateAll(nodes => nodes.map(node => ({
      text: node.textContent,
      bottom: Math.round(node.getBoundingClientRect().bottom),
    })));
    assert.match(firstScreen[1].text, /每位成员.*Windows x64.*同一版本.*Edge 或 Chrome.*私有 IPv4/);
    assert.match(firstScreen[3].text, /未数字签名.*SmartScreen/);
    assert.ok(firstScreen.every(({ bottom }) => bottom > 0 && bottom <= height), `essential information fits the first screen at ${width}px`);
    await page.locator('img:visible').evaluateAll(images => Promise.all(images.map(image => image.decode())));
    await page.screenshot({ path: path.join(output, `hero-${width}.png`) });
    await page.screenshot({ path: path.join(output, `page-${width}.png`), fullPage: true });
    const axe = await page.evaluate(async () => {
      const result = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'] } });
      return {
        violations: result.violations.map(({ id, nodes }) => ({ id, nodes: nodes.map(node => ({ target: node.target, summary: node.failureSummary })) })),
        incomplete: result.incomplete.map(({ id, nodes }) => ({ id, targets: nodes.map(node => node.target) })),
      };
    });
    evidence.viewports.push({ width, height });
    evidence.axe.push({ width, ...axe });
    await writeFile(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
    assert.deepEqual(axe.violations, [], `accessibility at ${width}px`);
  }
  assert.deepEqual(videoRequests, [], 'the MP4 is not requested before the viewer starts playback');

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '播放演示' }).press('Enter');
  const video = page.locator('#demo-video');
  await page.waitForFunction(() => {
    const player = document.querySelector('#demo-video');
    return player.currentTime > 0.4 && player.textTracks[0]?.cues?.length === 7;
  });
  assert.equal(await page.locator('#play-demo').isVisible(), false, 'native playback controls take over');
  assert.ok(videoRequests.length > 0);
  const media = await video.evaluate(node => ({ width: node.videoWidth, height: node.videoHeight, duration: node.duration, cues: node.textTracks[0].cues.length }));
  assert.equal(media.width, 1440);
  assert.equal(media.height, 900);
  assert.ok(media.duration >= 20 && media.duration <= 30);
  await video.evaluate(node => { node.pause(); node.currentTime = 26.5; });
  await page.waitForFunction(() => {
    const player = document.querySelector('#demo-video');
    return !player.seeking && player.currentTime === 26.5 && player.readyState >= 2;
  });
  await video.screenshot({ path: path.join(output, 'demo-handoff.png') });
  const range = await fetch(`${preview.url}/assets/first-room-demo.mp4`, { headers: { Range: 'bytes=0-15' } });
  assert.equal(range.status, 206);
  assert.match(range.headers.get('content-range'), /^bytes 0-15\/\d+$/);
  assert.equal((await range.arrayBuffer()).byteLength, 16);
  evidence.video = { ...media, startsOnRequest: true, seeking: true };
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  evidence.completed = true;
  await writeFile(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
});
