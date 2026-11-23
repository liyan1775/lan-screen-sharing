// Product screenshots use actual UI and native WebRTC with clearly labelled
// synthetic media. No personal screen, microphone or existing browser profile.
import {chromium} from 'playwright-core';
import {installSyntheticMedia} from '../tests/e2e/fixtures/synthetic-media.js';
import {startOwnedService,shutdownOwnedServices} from '../tests/e2e/fixtures/services.js';
import {resolve} from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
import {captureAppleUpgradeMatrix,settleCapture} from './capture-apple-upgrade-matrix.mjs';
import {startSitePreview} from './preview-site.mjs';

const services=[];
const matrix = process.argv.includes('--matrix') ? captureAppleUpgradeMatrix : null;
const artworkPNG=await readFile(resolve('website/assets/hero-flow.png'),'base64');
const profiles=[['阿岚','teal'],['小雨','pink'],['阿澄','indigo']];
const args=['--mute-audio'];
if(process.env.LANSW_TEST_DISABLE_MDNS==='1')args.push('--disable-features=WebRtcHideLocalIpsWithMdns');
const browser=await chromium.launch({executablePath:process.env.LANSW_BROWSER_PATH,headless:true,args});

async function captureLanding() {
  const preview=await startSitePreview('website');
  try {
    for (const [size,viewport] of Object.entries({wide:{width:1440,height:1000},narrow:{width:390,height:844}})) {
      const page=await browser.newPage({viewport,colorScheme:'dark',reducedMotion:'reduce'});
      try {
        await page.goto(preview.url);
        await page.locator('img:visible').evaluateAll(images=>Promise.all(images.map(image=>image.decode())));
        await page.evaluate(()=>document.documentElement.classList.add('capture-all-visible'));
        await page.evaluate(()=>scrollTo({top:0,behavior:'instant'}));
        await page.waitForFunction(()=>document.querySelector('.hero').dataset.intro==='complete');
        await settleCapture(page);
        await page.screenshot({path:resolve(`docs/design-research/apple-upgrade/site-dark-${size}.png`),fullPage:true});
      } finally { await page.close(); }
    }
  } finally { await preview.close(); }
}

try {
  const pages=[];
  const screenshots=new Map();
  const checks = matrix?.(browser);
  for(let i=0;i<3;i++){
    const service=await startOwnedService();services.push(service);
    const context=await browser.newContext({viewport:{width:1440,height:720},deviceScaleFactor:2,colorScheme:'dark',reducedMotion:'reduce'});
    await context.addInitScript(installSyntheticMedia,{participantAlias:i?'viewer-'+i:'host',artworkPNG:i?'':artworkPNG,captureWidth:1920,captureHeight:1080,captureFps:60});
    const page=await context.newPage();pages.push(page);
    checks?.track(page, new URL(service.baseURL).origin);
    await page.goto(service.baseURL);
  }
  const [host,viewer,other]=pages;
  await checks?.entry(host);
  for (const [i,page] of pages.entries()) {
    const [nickname,color]=profiles[i];
    await page.locator('#entry-identity').click();
    await page.locator('#nickname').fill(nickname);
    await page.locator(`input[name=avatar-color][value=${color}]`).check();
    await page.locator('#settings-dialog [data-close-dialog]').click();
  }
  await host.locator('#quick-create-room').click();await host.locator('#room-name').fill('周末一起玩');await host.locator('#create-room').click();
  await host.locator('#invite-room').click();const invite=await host.locator('#invite-text').inputValue();await host.locator('#invite-dialog [data-close-dialog]').click();
  for(const page of [viewer,other]){await page.locator('#quick-manual-join').click();await page.locator('#join-invite').fill(invite);await page.locator('#join-room').click();}
  await Promise.all(pages.map(page=>page.waitForFunction(()=>window.__lanScreenTest.pcs.length===2&&window.__lanScreenTest.pcs.every(pc=>pc.connectionState==='connected'))));
  for(const page of pages)await page.locator('#toggle-mic').click();
  await host.waitForFunction(()=>document.querySelectorAll('#audio-sources audio').length>=2||document.querySelectorAll('.audio-source').length>=2);
  async function capture(page,name){
    await page.evaluate(()=>document.activeElement?.blur());
    await page.mouse.move(1, 1);
    if (name === 'screen') {
      const stage = await page.locator('.screen-stage').boundingBox();
      await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
    }
    await settleCapture(page);
    const pixels = await page.screenshot();
    if (pixels.readUInt32BE(16) !== 2880 || pixels.readUInt32BE(20) !== 1440) throw new Error(name + ' is not 2880 × 1440');
    screenshots.set(name,pixels);
  }
  await capture(host,'room');
  await checks?.room(host);
  await host.locator('#room-text').click();await host.waitForFunction(()=>!document.querySelector('#send-text').disabled);
  await host.locator('#text-input').fill('房间开好了，一会儿一起看。');await host.locator('#send-text').click();
  await viewer.locator('#room-text').click();
  await viewer.locator('#text-log .text-message').getByText('房间开好了，一会儿一起看。').waitFor();
  await viewer.locator('#text-input').fill('好，项目主页也发给你：https://liyan1775.github.io/lan-screen-sharing/');await viewer.locator('#send-text').click();
  await host.locator('#text-log a').waitFor();
  await capture(host,'text');
  await checks?.text(host, other);
  await host.locator('#close-text').click();
  await host.locator('#start-share').click();await viewer.waitForFunction(()=>document.querySelector('#remote-screen').videoWidth>0);
  await viewer.waitForFunction(()=>/\d+p/.test(document.querySelector('#quality-received').textContent));
  await viewer.locator('#close-text').click();await capture(viewer,'screen');
  for (const [name,pixels] of screenshots) await writeFile(resolve(`website/assets/${name}.png`),pixels);
  console.log('Saved three actual product screenshots with synthetic media.');
  if (checks) {
    await checks.watch(viewer);
    await checks.site();
  } else {
    await Promise.all(pages.map(page=>page.context().close()));
    await captureLanding();
    console.log('Saved the wide and narrow dark landing page screenshots.');
  }
}finally{await browser.close();await shutdownOwnedServices(services);}
