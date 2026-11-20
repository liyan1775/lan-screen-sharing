import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { installSyntheticMedia } from '../tests/e2e/fixtures/synthetic-media.js';
import { shutdownOwnedServices, startOwnedService } from '../tests/e2e/fixtures/services.js';
import { drawDemoDisplay } from './intro-demo-display.mjs';

const releaseHash = '3db42c3fc3d1e1e9f2795256fb5c5164dbb088518d2f31b07457650639f3b479';
assert.ok(process.env.LANSW_EXE && process.env.LANSW_BROWSER_PATH, 'Set LANSW_EXE to the published 0.5.0 EXE and LANSW_BROWSER_PATH to Edge.');
const executable = path.resolve(process.env.LANSW_EXE);
assert.equal(createHash('sha256').update(await readFile(executable)).digest('hex'), releaseHash,
  'The public demo must match the published 0.5.0 executable.');

const viewport = { width: 1440, height: 900 };
const evidenceDir = path.resolve('.superpowers/sdd/lan-screen-sharing/build/intro-demo');
await mkdir(evidenceDir, { recursive: true });
const recording = await mkdtemp(path.join(evidenceDir, 'session-'));
const assets = path.resolve('website/assets');
const services = [];
const takes = [];
const errors = [];
const externalRequests = [];
const browser = await chromium.launch({
  executablePath: process.env.LANSW_BROWSER_PATH, headless: true, args: ['--mute-audio'],
});
const browserVersion = browser.version();

async function captureTake(name, pages, seconds, actions = async () => {}) {
  const inputs = pages.map((_, index) => `${name}-${index}.webm`);
  await pages[0].bringToFront();
  try {
    await Promise.all(pages.map((page, index) => page.screencast.start({
      path: path.join(recording, inputs[index]), size: viewport, fps: 24,
    })));
    const start = performance.now();
    await actions();
    const actionSeconds = (performance.now() - start) / 1000;
    assert.ok(actionSeconds <= seconds - 0.35, `${name} exceeded its allotted time (${actionSeconds.toFixed(1)} s)`);
    await wait((seconds - actionSeconds + 0.15) * 1000);
    takes.push({ name, inputs, seconds, actionSeconds: Number(actionSeconds.toFixed(2)) });
  } finally {
    await Promise.all(pages.map(page => page.screencast.stop()));
  }
  console.log(`Recorded ${name} (${seconds} s)`);
}

async function receiveVideo(page, presenterPeerId) {
  await page.waitForFunction(async peerId => {
    const video = document.querySelector('#remote-screen');
    const { incoming, pcs } = window.__lanScreenTest;
    const room = incoming.findLast(message => message.type === 'room.state')?.payload;
    if (document.body.dataset.stage !== 'watch' || video.readyState < 2 ||
        video.getVideoPlaybackQuality().totalVideoFrames <= 2 ||
        !room?.screenSharing || !room.hasSystemAudio || room.presenterPeerId !== peerId) return false;
    const [track] = video.srcObject.getVideoTracks();
    const receiver = pcs.find(pc => pc.getReceivers().some(source => source.track === track));
    if (!receiver) return false;
    const reports = await receiver.getStats();
    return [...reports.values()].some(report =>
      report.type === 'inbound-rtp' && report.kind === 'audio' && report.packetsReceived > 0);
  }, presenterPeerId);
}

async function saveShot(page, name) {
  await page.evaluate(() => document.activeElement?.blur());
  await page.screenshot({ path: path.join(recording, `${name}.png`) });
}

try {
  const pages = [];
  for (const participantAlias of ['host', 'viewer-1', 'viewer-2']) {
    const service = await startOwnedService({ executablePath: executable });
    services.push(service);
    const context = await browser.newContext({ viewport, colorScheme: 'dark', reducedMotion: 'reduce' });
    const captureOptions = { participantAlias, captureWidth: 1600, captureHeight: 900 };
    await context.addInitScript({
      content: `(${installSyntheticMedia})(${JSON.stringify(captureOptions)}, ${drawDemoDisplay});`,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (new URL(request.url()).origin !== service.baseURL) externalRequests.push(request.url());
    });
    await page.goto(service.baseURL);
    await page.locator('#connection-status').filter({ hasText: '本机程序已就绪' }).waitFor();
    // Hide the local address and test room credential from the recording.
    // The application receives the actual unmodified invitation.
    await page.addStyleTag({ content: '#invite-text, #join-invite { -webkit-text-security: disc; }' });
    pages.push(page);
  }

  const [host, first, second] = pages;
  let invite;
  await captureTake('create', [host], 4.5, async () => {
    await wait(550);
    await host.locator('#quick-create-room').click();
    await host.locator('#room-name').pressSequentially('周末一起看', { delay: 80 });
    await host.locator('#room-discoverable').uncheck();
    await wait(550);
    await host.locator('#create-room').click();
    await host.locator('body[data-stage="voice"]').waitFor();
    await wait(350);
    await host.locator('#invite-room').click();
    invite = await host.locator('#invite-text').inputValue();
    assert.ok(invite.includes('房间码'));
  });
  await host.locator('#invite-dialog [data-close-dialog]').click();

  await captureTake('join', [first, second], 5, async () => {
    await wait(550);
    await Promise.all([first, second].map(page => page.locator('#quick-manual-join').click()));
    await Promise.all([first, second].map(page => page.locator('#join-invite').fill(invite)));
    await wait(750);
    await first.locator('#join-room').click();
    await first.locator('body[data-stage="voice"]').waitFor();
    await second.locator('#join-room').click();
    await Promise.all(pages.map(page => page.locator('#topbar-room-count').filter({ hasText: '3 人' }).waitFor()));
  });

  for (const page of pages) {
    await page.locator('#toggle-mic').click();
    await page.waitForFunction(() => document.querySelector('#toggle-mic').getAttribute('aria-pressed') === 'true');
  }
  await Promise.all(pages.map(page => page.waitForFunction(() =>
    document.querySelectorAll('.audio-source[data-role="microphone"]').length === 2)));
  const selfSeat = '#members .member-seat[data-self="true"]';
  const hostPeerId = await host.locator(selfSeat).getAttribute('data-peer-id');
  const nextPeerId = await first.locator(selfSeat).getAttribute('data-peer-id');
  assert.ok(hostPeerId && nextPeerId && hostPeerId !== nextPeerId, 'Expected two distinct presenters.');
  await saveShot(host, 'room');

  await captureTake('share', [host], 3.5, async () => {
    await wait(900);
    await host.locator('#start-share').click();
    await Promise.all([first, second].map(page => receiveVideo(page, hostPeerId)));
  });
  await saveShot(first, 'screen');
  await captureTake('watch', [first, second], 4.5);

  await captureTake('text', [first], 4.5, async () => {
    await wait(450);
    await first.locator('#watch-text').click();
    await second.locator('#watch-text').click();
    await second.locator('#text-input').fill('观景台见？我把返程路线也准备好了。');
    await second.locator('#send-text').click();
    await first.locator('#text-log').getByText('观景台见？我把返程路线也准备好了。').waitFor();
    await first.locator('#text-input').fill('可以，下一段我来分享。');
    await first.locator('#send-text').click();
    await second.locator('#text-log').getByText('可以，下一段我来分享。').waitFor();
  });
  await saveShot(first, 'text');
  for (const page of [first, second]) await page.locator('#close-text').click();

  await captureTake('stop', [host], 2.5, async () => {
    await wait(450);
    await host.locator('#stop-share').click();
    await Promise.all(pages.map(page => page.locator('body[data-stage="voice"]').waitFor()));
    await Promise.all(pages.map(page => page.waitForFunction(() =>
      document.querySelector('#topbar-room-count').textContent === '3 人' &&
      document.querySelectorAll('.audio-source[data-role="microphone"]').length === 2)));
  });

  await captureTake('handoff', [host, second], 4, async () => {
    await first.locator('#start-share').click();
    await Promise.all([host, second].map(page => receiveVideo(page, nextPeerId)));
  });
  assert.deepEqual(errors, [], 'Application page errors during the demonstration');
  assert.deepEqual(externalRequests, [], 'Application requests outside its local service');
} finally {
  try { await browser.close(); }
  finally { await shutdownOwnedServices(services); }
}

function ffmpeg(args) {
  const result = spawnSync(process.env.LANSW_FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    cwd: recording, stdio: 'inherit', windowsHide: true,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'FFmpeg could not encode the recording.');
}

for (const { name, inputs, seconds } of takes) {
  const filters = inputs.map((_, index) => `[${index}:v]fps=24,tpad=stop_mode=clone:stop_duration=${seconds},` +
    `trim=duration=${seconds},setpts=PTS-STARTPTS` +
    (inputs.length === 1 ? '[out]' : `,scale=696:435,pad=720:436:${index ? 12 : 0}:0:color=0x101a29[view${index}]`));
  if (inputs.length === 2) filters.push('[view0][view1]hstack=inputs=2,pad=1440:900:0:232:color=0x101a29[out]');
  ffmpeg([
    ...inputs.flatMap(file => ['-i', file]), '-filter_complex_threads', '2',
    '-filter_complex', filters.join(';'), '-map', '[out]', '-an',
    '-c:v', 'libx264', '-threads', '4', '-preset', 'fast', '-crf', '21', '-pix_fmt', 'yuv420p', `${name}.mp4`,
  ]);
}
await writeFile(path.join(recording, 'takes.txt'), takes.map(({ name }) => `file '${name}.mp4'`).join('\n') + '\n');
ffmpeg(['-f', 'concat', '-safe', '1', '-i', 'takes.txt', '-c', 'copy', '-movflags', '+faststart', 'first-room-demo.mp4']);
ffmpeg(['-i', 'watch.mp4', '-ss', '1', '-frames:v', '1', '-q:v', '2', 'demo-poster.jpg']);
for (const file of ['screen.png', 'room.png', 'text.png', 'demo-poster.jpg', 'first-room-demo.mp4']) {
  await copyFile(path.join(recording, file), path.join(assets, file));
}
await writeFile(path.join(recording, 'evidence.json'), JSON.stringify({
  completed: true, release: '0.5.0', executableSha256: releaseHash, browser: browserVersion,
  environment: 'One Windows computer, three native services, native WebRTC and synthetic capture',
  verified: ['Three joined seats', 'Both viewers decoded the host video and received system audio', 'Two-way room text', 'Voice stayed connected after screen stop', 'Both other members decoded the next presenter'],
  takes, pageErrors: errors.length, externalRequests: externalRequests.length,
}, null, 2) + '\n');
console.log(`Saved demo and product screenshots. Recording evidence: ${recording}`);
