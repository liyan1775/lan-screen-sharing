// Product screenshots use actual UI and native WebRTC with clearly labelled
// synthetic media. No personal screen, microphone or existing browser profile.
import {chromium} from 'playwright-core';
import {installSyntheticMedia} from '../tests/e2e/fixtures/synthetic-media.js';
import {startOwnedService,shutdownOwnedServices} from '../tests/e2e/fixtures/services.js';
import {resolve} from 'node:path';

const services=[];
const browser=await chromium.launch({executablePath:process.env.LANSW_BROWSER_PATH,headless:true,args:['--mute-audio']});
try {
  const pages=[];
  for(let i=0;i<3;i++){
    const service=await startOwnedService();services.push(service);
    const context=await browser.newContext({viewport:{width:1440,height:1000},colorScheme:'dark',reducedMotion:'reduce'});
    await context.addInitScript(installSyntheticMedia,{participantAlias:i?'viewer-'+i:'host'});
    const page=await context.newPage();pages.push(page);await page.goto(service.baseURL);
  }
  const [host,viewer,other]=pages;
  await host.locator('#quick-create-room').click();await host.locator('#room-name').fill('周末一起玩');await host.locator('#create-room').click();
  await host.locator('#invite-room').click();const invite=await host.locator('#invite-text').inputValue();await host.locator('#invite-dialog [data-close-dialog]').click();
  for(const page of [viewer,other]){await page.locator('#quick-manual-join').click();await page.locator('#join-invite').fill(invite);await page.locator('#join-room').click();}
  await Promise.all(pages.map(page=>page.waitForFunction(()=>window.__lanScreenTest.pcs.length===2&&window.__lanScreenTest.pcs.every(pc=>pc.connectionState==='connected'))));
  for(const page of pages)await page.locator('#toggle-mic').click();
  await host.waitForFunction(()=>document.querySelectorAll('#audio-sources audio').length>=2||document.querySelectorAll('.audio-source').length>=2);
  async function capture(page,name){
    await page.locator('.topbar').count().then(async count=>{if(count)await page.locator('.topbar').click({position:{x:600,y:30}});});
    await page.evaluate(()=>document.activeElement?.blur());
    await page.screenshot({path:resolve('website/assets/'+name+'.png')});
  }
  await capture(host,'room');
  await host.locator('#room-text').click();await host.waitForFunction(()=>!document.querySelector('#send-text').disabled);
  await host.locator('#text-input').fill('这个画面，一起看看？');await host.locator('#send-text').click();
  await viewer.locator('#room-text').click();await viewer.locator('#text-input').fill('看到了。声音也在，一起开始吧。');await viewer.locator('#send-text').click();
  await host.waitForFunction(()=>document.querySelector('#text-log').textContent.includes('声音也在'));
  await capture(host,'text');await host.locator('#close-text').click();
  await host.locator('#start-share').click();await viewer.waitForFunction(()=>document.querySelector('#remote-screen').videoWidth>0);
  await viewer.locator('#close-text').click();await capture(viewer,'screen');
  console.log('Saved three actual product screenshots with synthetic media.');
}finally{await browser.close();await shutdownOwnedServices(services);}
