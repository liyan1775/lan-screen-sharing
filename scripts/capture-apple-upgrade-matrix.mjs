import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startSitePreview } from './preview-site.mjs';

const output = resolve('docs/design-research/apple-upgrade');
const sizes = { wide: { width: 1440, height: 1000 }, narrow: { width: 390, height: 844 } };

export async function settleCapture(page) {
  await page.bringToFront();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(resolve));
    const finite = document.getAnimations().filter(animation =>
      animation.playState === 'running' && animation.effect.getComputedTiming().endTime < Infinity);
    await Promise.allSettled(finite.map(animation => animation.finished));
  });
}

export function captureAppleUpgradeMatrix(browser) {
  const errors = [];
  const external = [];
  const evidence = {
    browser: browser.version(),
    media: 'native WebRTC with synthetic capture',
    mdnsHostObfuscationDisabled: process.env.LANSW_TEST_DISABLE_MDNS === '1',
    screenshots: [],
    checks: {},
    darkSiteAxe: [],
    privacyContrast: [],
  };

  function track(page, origin) {
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      const url = new URL(request.url());
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== origin) external.push(url.href);
    });
  }

  async function fit(page, label) {
    const result = await page.evaluate(() => ({width: innerWidth, documentWidth: document.documentElement.scrollWidth}));
    assert.ok(result.documentWidth <= result.width + 1, label + ' overflows horizontally');
    evidence.checks[label] = result;
  }

  async function capture(page, name, fullPage = false) {
    await settleCapture(page);
    await fit(page, name);
    const file = name + '.png';
    await page.screenshot({ path: resolve(output, file), fullPage, scale: 'css' });
    evidence.screenshots.push(file);
  }

  async function byAppearance(page, prefix) {
    const viewport = page.viewportSize();
    try {
      for (const [size, dimensions] of Object.entries(sizes)) {
        await page.setViewportSize(dimensions);
        for (const colorScheme of ['light', 'dark']) {
          await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
          await capture(page, prefix + '-' + colorScheme + '-' + size, true);
        }
      }
    } finally {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    }
  }

  async function checkWidths(page, label) {
    const viewport = page.viewportSize();
    for (const width of [320, 3840]) {
      await page.setViewportSize({ width, height: 844 });
      await fit(page, label + ' ' + width);
    }
    await page.setViewportSize(viewport);
  }

  async function entry(host) {
    await mkdir(output, { recursive: true });
    await host.locator('#empty-rooms').waitFor();
    await byAppearance(host, 'app-entry');
    await checkWidths(host, 'app entry');
    await host.emulateMedia({ forcedColors: 'active', colorScheme: 'light', reducedMotion: 'reduce' });
    await host.keyboard.press('Tab');
    const refresh = host.locator('#refresh-rooms');
    await refresh.focus();
    assert.ok(await refresh.evaluate(button => {
      const style = getComputedStyle(button);
      return button.matches(':focus-visible') && style.outlineStyle === 'solid' && parseFloat(style.outlineWidth) > 0;
    }));
    evidence.checks.forcedColorsFocusRing = true;
    await refresh.blur();
    await host.emulateMedia({ forcedColors: 'none', colorScheme: 'dark', reducedMotion: 'reduce' });
  }

  async function room(host) {
    await host.locator('.member-seat[data-speaking=true]').first().waitFor();
    evidence.checks.remoteSpeakingIndicator = true;
    await byAppearance(host, 'app-room');
    await host.setViewportSize(sizes.wide);
    await host.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await host.locator('#open-settings').click();
    await capture(host, 'app-settings-light-wide');
    const session = await host.context().newCDPSession(host);
    try {
      await session.send('Emulation.setEmulatedMedia', { features: [{name: 'prefers-reduced-transparency', value: 'reduce'}] });
      assert.equal(await host.locator('#settings-dialog').evaluate(dialog => getComputedStyle(dialog, '::backdrop').backdropFilter), 'blur(10px) saturate(1.4)');
      evidence.checks.sheetBlurWithReducedTransparency = true;
    } finally {
      await session.send('Emulation.setEmulatedMedia', { features: [] });
      await session.detach();
    }
    await host.locator('#settings-dialog [data-close-dialog]').click();
    await host.locator('#settings-dialog').waitFor({state: 'hidden'});
    await host.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await host.setViewportSize({ width: 1440, height: 720 });
  }

  async function text(host, other) {
    const unread = other.locator('#room-text');
    await other.waitForFunction(() => document.querySelector('#room-text').dataset.unread === 'true');
    assert.equal(await unread.locator('.ui-icon svg').count(), 1);
    assert.match(await unread.textContent(), /^文字 · [1-9][0-9]?$/);
    evidence.checks.chatIconAndUnread = true;
    await host.setViewportSize(sizes.wide);
    await host.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await capture(host, 'app-text-light-wide');
    await host.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await host.setViewportSize({ width: 1440, height: 720 });
  }

  async function showControls(page) {
    const {x, y, width, height} = await page.locator('.screen-stage').boundingBox();
    await page.mouse.move(x + width / 2, y + height / 2);
  }

  async function watch(viewer) {
    await viewer.setViewportSize(sizes.wide);
    const player = viewer.locator('#share-panel');
    const fullscreen = viewer.locator('#fullscreen-screen');
    assert.equal(await fullscreen.textContent(), '全屏观看');
    assert.equal(await fullscreen.locator('.ui-icon svg').count(), 1);
    await showControls(viewer);
    await player.waitFor({ state: 'visible' });
    await viewer.waitForFunction(() => {
      const player = document.querySelector('#share-panel');
      return player.classList.contains('pointer-idle') && getComputedStyle(player.querySelector('.room-controls')).opacity === '0';
    });
    await viewer.mouse.move(1, 1);
    await showControls(viewer);
    await viewer.waitForFunction(() => getComputedStyle(document.querySelector('#share-panel .room-controls')).opacity === '1');
    evidence.checks.playerControlsIdleAndReturn = true;
    await capture(viewer, 'app-watch-dark-wide');

    await viewer.locator('#watch-sound').click();
    const row = viewer.locator('#audio-sources .audio-source[data-role=microphone]').first();
    const slider = row.locator('input');
    await slider.press('ArrowLeft');
    const fill = await slider.evaluate(range => getComputedStyle(range).getPropertyValue('--slider-fill'));
    assert.equal(fill, '95%');
    await row.locator('button').click();
    assert.equal(await row.getAttribute('data-muted'), 'true');
    assert.equal(await slider.evaluate(range => getComputedStyle(range).getPropertyValue('--slider-fill')), fill);
    await row.locator('button').click();
    evidence.checks.sliderFillAndMute = true;
    await capture(viewer, 'app-sound-dark-wide');
    await viewer.locator('#sound-dialog [data-close-dialog]').click();
    await viewer.setViewportSize(sizes.narrow);
    await showControls(viewer);
    await capture(viewer, 'app-watch-dark-narrow');
  }

  async function measurePrivacyContrast(page) {
    const section = page.locator('#privacy');
    const text = await section.evaluate(async node => {
      await document.fonts.ready;
      const bounds = node.getBoundingClientRect();
      return [...node.querySelectorAll('.connection-copy h2, .connection-copy > p:last-child')].map(element => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return {
          color: getComputedStyle(element).color.match(/[.\d]+/g).slice(0, 3).map(Number),
          rects: [...range.getClientRects()].filter(rect => rect.width && rect.height).map(rect => ({
            x: Math.floor(rect.left - bounds.left), y: Math.floor(rect.top - bounds.top),
            width: Math.ceil(rect.width), height: Math.ceil(rect.height),
          })),
        };
      });
    });
    const hidden = await page.addStyleTag({content: '.connection-copy { visibility: hidden; }'});
    const background = await section.screenshot({scale: 'css'});
    await hidden.evaluate(style => style.remove());
    return page.evaluate(async ({png, text}) => {
      const image = await createImageBitmap(new Blob([Uint8Array.from(atob(png), byte => byte.charCodeAt(0))], {type: 'image/png'}));
      const canvas = new OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext('2d', {willReadFrequently: true});
      context.drawImage(image, 0, 0);
      image.close();
      const luminance = rgb => rgb.map(value => value / 255)
        .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
        .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
      return text.map(({color, rects}) => {
        let brightest = 0;
        for (const {x, y, width, height} of rects) {
          const pixels = context.getImageData(x, y, width, height).data;
          for (let offset = 0; offset < pixels.length; offset += 4) {
            brightest = Math.max(brightest, luminance([pixels[offset], pixels[offset + 1], pixels[offset + 2]]));
          }
        }
        return (luminance(color) + .05) / (brightest + .05);
      });
    }, {png: background.toString('base64'), text});
  }

  async function site() {
    const preview = await startSitePreview('website');
    const page = await browser.newPage({ viewport: sizes.wide, reducedMotion: 'reduce' });
    try {
      track(page, preview.url);
      await page.goto(preview.url);
      await page.locator('.connection-art img').evaluate(async image => {
        image.loading = 'eager';
        await image.decode();
      });
      for (const reveal of await page.locator('.reveal').all()) await reveal.scrollIntoViewIfNeeded();
      await page.waitForFunction(() => [...document.querySelectorAll('.reveal')].every(node => node.classList.contains('is-visible')));
      await page.evaluate(() => scrollTo({top: 0, behavior: 'instant'}));
      await byAppearance(page, 'site');
      await checkWidths(page, 'site');

      await page.locator('.nav-links a[href="#performance"]').click();
      await page.waitForFunction(() => document.querySelector('.nav-links a[aria-current=location]')?.hash === '#performance');
      await page.locator('#tab-voice').click();
      assert.equal(await page.locator('.gallery-tabs').evaluate(tabList => tabList.style.getPropertyValue('--segment-index')), '1');
      await page.locator('[data-compare=before]').click();
      assert.equal(await page.locator('.wires-before').evaluate(node => getComputedStyle(node).display), 'inline');
      assert.equal(await page.locator('.flow-pulse').first().evaluate(node => getComputedStyle(node).animationName), 'none');
      await page.locator('[data-compare=after]').click();
      await page.locator('#tab-screen').click();
      evidence.checks.siteScrollSpyAndReducedMotion = true;

      await page.addScriptTag({path:resolve('node_modules/axe-core/axe.min.js')});
      for (const [width, height] of [[1440,1000], [768,1024], [390,844], [320,720]]) {
        await page.setViewportSize({width, height});
        await page.evaluate(() => scrollTo({top: 0, behavior: 'instant'}));
        await settleCapture(page);
        const result = await page.evaluate(async () => {
          const report = await window.axe.run(document, {runOnly: {type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice']}});
          return { violations: report.violations.map(({id, nodes}) => ({id, targets: nodes.map(node => node.target)})), incomplete: report.incomplete.length };
        });
        evidence.darkSiteAxe.push({width, ...result});
        assert.deepEqual(result.violations, [], 'Dark promotional site at ' + width + ' px');
        // The privacy section uses the same dark color scheme in both page themes.
        const [heading, body] = await measurePrivacyContrast(page);
        evidence.privacyContrast.push({width, heading: Number(heading.toFixed(2)), body: Number(body.toFixed(2))});
        assert.ok(heading >= 4.5 && body >= 7, 'Privacy copy contrast at ' + width + ' px');
      }
      await page.goto(pathToFileURL(resolve('website/index.html')).href);
      await page.locator('#tab-text').click();
      await page.locator('#panel-text img').evaluate(image => image.decode());
      assert.equal(await page.locator('#panel-text').isVisible(), true);
      evidence.checks.offlineFilePreview = true;
    } finally {
      await page.close();
      await preview.close();
    }
    evidence.errors = errors;
    evidence.externalRequests = external;
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    evidence.buildSHA256 = createHash('sha256').update(await readFile(process.env.LANSW_EXE || resolve('dist/局域网屏幕共享.exe'))).digest('hex');
    evidence.completed = true;
    await writeFile(resolve(output, 'visual-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    console.log('Saved ' + evidence.screenshots.length + ' matrix screenshots. Dark site axe passed at 1440 / 768 / 390 / 320 px.');
  }

  return { track, entry, room, text, watch, site };
}
