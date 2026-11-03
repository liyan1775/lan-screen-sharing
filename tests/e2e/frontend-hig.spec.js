import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {installSyntheticMedia} from './fixtures/synthetic-media.js';
import {startOwnedService,shutdownOwnedServices,selectedLANIPv4} from './fixtures/services.js';

const output=path.resolve(process.env.LANSW_HIG_EVIDENCE || '.superpowers/sdd/lan-screen-sharing/build/hig-evidence');

test('HIG frontend flows: actual rooms, text, media controls, keyboard, appearance, zoom and errors', {timeout:180000}, async t=>{
  assert.ok(process.env.LANSW_EXE && process.env.LANSW_BROWSER_PATH,'provide the candidate executable and installed browser');
  await mkdir(output,{recursive:true});
  const services=[],contexts=[],errors=[],external=[],evidence={completed:false,environment:'Windows / isolated Edge / synthetic capture / native WebRTC',checks:[],screens:[],axe:[],ax:[],sourceHashes:{}};
  const lanIP=selectedLANIPv4();
  const browser=await chromium.launch({headless:true,executablePath:process.env.LANSW_BROWSER_PATH,args:['--mute-audio']});
  evidence.browserVersion=browser.version();
  t.after(async()=>{
    await Promise.allSettled(contexts.map(context=>context.close()));await browser.close();await shutdownOwnedServices(services);
    evidence.errors=errors;evidence.externalRequestCount=external.length;
    for(const file of ['index.html','styles.css','app.js','client.js','room-browser.js','room-experience.js','room-text.js','room-text-ui.js','media.js','fullscreen.js','preview-playback.js']) evidence.sourceHashes[file]=createHash('sha256').update(await readFile('internal/web/assets/'+file)).digest('hex');
    evidence.buildSHA256=createHash('sha256').update(await readFile(process.env.LANSW_EXE)).digest('hex');
    await writeFile(path.join(output,'evidence.json'),JSON.stringify(evidence,null,2));
  });
  const pages=[];
  for(let i=0;i<3;i++){
    const service=await startOwnedService({lanIP});services.push(service);
    const context=await browser.newContext({viewport:{width:1440,height:1000},colorScheme:'dark'});contexts.push(context);
    await context.addInitScript(installSyntheticMedia,{participantAlias:i?'viewer-'+i:'host'});
    context.on('request',request=>{if(!['localhost','127.0.0.1'].includes(new URL(request.url()).hostname))external.push('external');});
    const page=await context.newPage();pages.push(page);page.on('pageerror',error=>errors.push(error.message));await page.goto(service.baseURL);
  }
  const [host,viewer,other]=pages;
  evidence.servedHashes={};
  for(const file of ['index.html','styles.css','app.js','client.js','room-browser.js','room-experience.js','room-text.js','room-text-ui.js','media.js','fullscreen.js','preview-playback.js']) {
    const response=await fetch(services[0].baseURL+(file==='index.html'?'/':'/assets/'+file));assert.equal(response.ok,true);
    const actual=createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');const expected=createHash('sha256').update(await readFile('internal/web/assets/'+file)).digest('hex');assert.equal(actual,expected,'embedded '+file+' matches reviewed source');evidence.servedHashes[file]=actual;
  }
  async function settle(page){await page.evaluate(async()=>{await document.fonts.ready;await Promise.all(document.getAnimations().map(animation=>animation.finished.catch(()=>{})));});}
  async function capture(page,name){await settle(page);const fixedPanel=await page.locator('dialog[open]').count()>0||await page.locator('#text-panel').isVisible();await page.screenshot({path:path.join(output,name+'.png'),fullPage:!fixedPanel});evidence.screens.push(name+'.png');}
  async function ax(page,state){
    const session=await page.context().newCDPSession(page);const tree=await session.send('Accessibility.getFullAXTree');await session.detach();
    evidence.ax.push({state,nodes:tree.nodes.filter(n=>!n.ignored&&['button','slider','dialog','alertdialog','alert','log','heading','group','textbox','combobox','status'].includes(n.role?.value)).map(n=>({role:n.role.value,name:n.name?.value,value:n.role.value==='textbox'?undefined:n.value?.value,description:n.description?.value,properties:n.properties?.map(p=>({name:p.name,value:p.value?.value}))}))});
  }
  async function trap(page,id){
    const dialog=page.locator('#'+id);const first=await page.evaluateHandle(id=>[...document.querySelector('#'+id).querySelectorAll('button,input,select,summary,a[href],[tabindex="0"]')].find(n=>!n.disabled&&n.getClientRects().length),id);
    await first.asElement().focus();await page.keyboard.press('Shift+Tab');assert.equal(await dialog.evaluate(n=>n.contains(document.activeElement)),true);await page.keyboard.press('Tab');assert.equal(await page.evaluate(first=>document.activeElement===first,first),true);evidence.checks.push({check:id+' keyboard focus cycle',passed:true});
  }
  async function axe(page,state){
    await settle(page);if(!await page.evaluate(()=>!!window.axe))await page.addScriptTag({path:path.resolve('node_modules/axe-core/axe.min.js')});
    const result=await page.evaluate(async()=>{const r=await window.axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','best-practice']}});return{violations:r.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))})),incomplete:r.incomplete.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>n.target)})),passes:r.passes.length};});
    evidence.axe.push({state,...result});assert.deepEqual(result.violations,[],state+' has accessibility violations');
  }
  async function noOverflow(page,state){const result=await page.evaluate(()=>({width:innerWidth,content:document.documentElement.scrollWidth}));assert.ok(result.content<=result.width+1,state+' overflows horizontally');evidence.checks.push({check:state+' horizontal fit',...result});}
  async function settings(page){await page.locator('#open-settings').click();}
  async function closeSettings(page){await page.locator('#settings-dialog [data-close-dialog]').click();}

  await host.locator('#connection-status').filter({hasText:'已就绪'}).waitFor();
  assert.equal(await host.evaluate(()=>window.__lanScreenTest.captures.length),0,'entry must not request any capture');
  await capture(host,'01-entry-dark');await axe(host,'entry dark');
  await host.evaluate(()=>{window.__qaStatusChanges=0;window.__qaStatusObserver=new MutationObserver(()=>window.__qaStatusChanges++);window.__qaStatusObserver.observe(document.querySelector('#discovery-status'),{childList:true,characterData:true,subtree:true});});await host.waitForTimeout(6500);assert.equal(await host.evaluate(()=>window.__qaStatusChanges),0,'unchanged discovery polls do not repeat live announcements');await host.evaluate(()=>window.__qaStatusObserver.disconnect());evidence.checks.push({check:'unchanged discovery status has no repeated DOM mutation across two polls',passed:true});
  await host.emulateMedia({colorScheme:'light'});await capture(host,'02-entry-light');await axe(host,'entry light');
  await host.emulateMedia({colorScheme:'dark'});
  let fixtureRooms=[{id:'fixture-active',name:'测试 · 周末游戏',members:1,capacity:3,screenSharing:true,hostIPv4:lanIP,hostPort:Number(services[0].signalPort),roomCode:'ABCD2345'},{id:'fixture-full',name:'测试 · 已满房间',members:3,capacity:3,hostIPv4:lanIP,hostPort:Number(services[0].signalPort),roomCode:'BCDE2345'},{id:'fixture-idle',name:'测试 · 聊会儿',members:2,capacity:3,hostIPv4:lanIP,hostPort:Number(services[0].signalPort),roomCode:'CDEF2345'}];
  await host.route('**/api/v1/rooms',route=>route.fulfill({json:{available:true,rooms:fixtureRooms}}));await host.locator('#refresh-rooms').click();await host.locator('.discovered-room').nth(2).waitFor();
  assert.equal(await host.locator('[data-room-id="fixture-full"] button').isDisabled(),true);await capture(host,'15-rooms-fixture');await axe(host,'discovery populated fixture');
  await host.setViewportSize({width:390,height:844});await noOverflow(host,'room cards 390');await capture(host,'16-rooms-fixture-390');await host.setViewportSize({width:1440,height:1000});
  let releaseBootstrap;const heldBootstrap=new Promise(resolve=>releaseBootstrap=resolve);await host.route('**/api/v1/bootstrap',async route=>{await heldBootstrap;await route.continue();});
  await host.locator('[data-room-id="fixture-active"] button').click();await host.locator('[data-room-id="fixture-active"][aria-busy="true"]').waitFor();assert.equal(await host.locator('[data-room-id="fixture-active"] button').isDisabled(),true);await capture(host,'20-joining-fixture');releaseBootstrap();await host.unroute('**/api/v1/bootstrap');
  await host.locator('#error-message').waitFor({state:'visible'});await capture(host,'17-stale-room');await axe(host,'stale room failure');await ax(host,'stale room alert');
  fixtureRooms=[];await host.unroute('**/api/v1/rooms');await host.locator('#refresh-rooms').click();
  await host.locator('#quick-manual-join').click();await host.locator('#join-address').fill('invalid');await host.locator('#join-port').fill('0');await host.locator('#join-code').fill('');await host.locator('#join-room').click();assert.equal(await host.locator('#join-address').evaluate(n=>n.validity.valid),false);assert.equal(await host.locator('#join-address').evaluate(n=>n===document.activeElement),true);await capture(host,'18-invalid-join');await host.locator('#browse-rooms').click();
  await host.locator('#quick-create-room').click();await host.locator('#room-name').fill('周二游戏夜');await host.locator('#room-discoverable').uncheck();await capture(host,'03-create');await axe(host,'create');
  await host.locator('#create-room').click();await host.locator('body[data-stage="voice"]').waitFor();
  await host.locator('#invite-room').click();
  const invite=await host.evaluate(()=>({address:document.querySelector('#host-address').value,port:document.querySelector('#host-port').value,code:document.querySelector('#room-code').textContent}));
  await trap(host,'invite-dialog');await ax(host,'invite dialog');
  await host.locator('#invite-dialog [data-close-dialog]').click();
  for(const page of [viewer,other]){
    await page.locator('#quick-manual-join').click();
    await page.locator('#join-address').fill(invite.address);await page.locator('#join-port').fill(invite.port);await page.locator('#join-code').fill(invite.code);
    await page.locator('#join-code').press('Enter');await page.locator('body[data-stage="voice"]').waitFor();
    assert.equal(await page.locator('#topbar-room-name').textContent(),'周二游戏夜','manual join preserves actual room context');
  }
  await host.waitForFunction(()=>document.querySelectorAll('.member-seat[data-empty="false"]').length===3);
  await capture(host,'04-voice-three');await axe(host,'voice dark');
  await host.locator('#room-menu').click();assert.equal(await host.locator('#member-summary .member-seat').count(),3);await trap(host,'members-dialog');await ax(host,'voice members');await capture(host,'21-voice-members');await host.locator('#members-dialog [data-close-dialog]').click();
  assert.equal(await host.evaluate(()=>window.__lanScreenTest.captures.length),0,'voice entry must not implicitly enable microphone');
  await host.locator('#room-text').click();await host.waitForFunction(()=>!document.querySelector('#send-text').disabled);
  await host.locator('#text-input').fill('不开麦也可以一起聊。');await host.locator('#text-input').press('Enter');
  await Promise.all([viewer,other].map(page=>page.waitForFunction(()=>document.querySelector('#text-log').textContent.includes('不开麦也可以一起聊。'))));
  await viewer.locator('#room-text').click();await viewer.locator('#text-input').fill('<img src=x onerror=alert(1)>');await viewer.locator('#send-text').click();
  await host.waitForFunction(()=>document.querySelector('#text-log').textContent.includes('<img'));
  assert.equal(await host.locator('#text-log img').count(),0,'text messages are plain text');
  await capture(host,'05-text');await axe(host,'text');
  await ax(host,'text log and input');
  await host.locator('#text-input').press('Escape');assert.equal(await host.locator('#room-text').evaluate(n=>document.activeElement===n),true,'modeless text restores its trigger');
  await viewer.locator('#close-text').click();
  for(const page of pages)await page.locator('#toggle-mic').click();
  await host.waitForFunction(()=>document.querySelector('#toggle-mic').getAttribute('aria-pressed')==='true');
  await settings(host);assert.equal(await host.locator('.settings-section').evaluate(n=>n.open),false,'advanced diagnosis starts collapsed');await capture(host,'06-settings');await axe(host,'settings');
  await trap(host,'settings-dialog');await ax(host,'settings controls');
  await host.locator('#exit-program').click();await host.locator('#confirm-dialog').waitFor({state:'visible'});assert.equal(await host.locator('#confirm-cancel').evaluate(n=>document.activeElement===n),true);await trap(host,'confirm-dialog');await ax(host,'destructive confirmation');await capture(host,'07-exit-confirm');await host.locator('#confirm-cancel').click();
  // Native dialog close dispatches a queued event. Wait for the restored task
  // before asserting its focus; a click acknowledgment alone is too early.
  await host.locator('#settings-dialog').waitFor({state:'visible',timeout:3000});
  await host.waitForFunction(()=>document.activeElement===document.querySelector('#exit-program'),null,{timeout:3000});
  assert.equal(await host.locator('#exit-program').evaluate(n=>document.activeElement===n),true);await closeSettings(host);
  await host.locator('#end-room').click();await host.locator('#confirm-dialog').waitFor({state:'visible'});await host.locator('#confirm-cancel').press('Escape');assert.equal(await host.locator('body').getAttribute('data-stage'),'voice');
  await settings(host);await host.locator('#share-mode').selectOption('combined');await closeSettings(host);
  await settings(viewer);await viewer.locator('#quality-target').focus();await host.locator('#start-share').click();await viewer.locator('body[data-stage="watch"]').waitFor();assert.equal(await viewer.locator('#settings-dialog').isVisible(),true,'remote sharing preserves the current settings task');assert.equal(await viewer.locator('#quality-target').evaluate(n=>document.activeElement===n),true);await closeSettings(viewer);
  await viewer.locator('body[data-stage="watch"]').waitFor();await viewer.waitForFunction(()=>document.querySelector('#remote-screen').videoWidth>0);await capture(viewer,'08-watch');await axe(viewer,'watch');
  const video=await viewer.locator('#remote-screen').evaluateHandle(n=>n);
  await viewer.locator('#watch-sound').click();await trap(viewer,'sound-dialog');await ax(viewer,'sound slider and mute state');await capture(viewer,'09-sound');await axe(viewer,'sound');
  const slider=viewer.locator('#sound-dialog .audio-source[data-role="microphone"] input').first();await slider.focus();await slider.press('ArrowLeft');const volume=await slider.inputValue();
  await settings(host);await host.locator('#quality-target').selectOption('720p30');await closeSettings(host);
  await other.locator('#leave-room').click();await viewer.waitForFunction(()=>document.querySelector('#topbar-room-count').textContent==='2 人');
  await other.locator('#quick-manual-join').click();await other.locator('#join-address').fill(invite.address);await other.locator('#join-port').fill(invite.port);await other.locator('#join-code').fill(invite.code);await other.locator('#join-room').click();await viewer.waitForFunction(()=>document.querySelector('#topbar-room-count').textContent==='3 人');
  assert.equal(await slider.evaluate(n=>document.activeElement===n),true);assert.equal(await slider.inputValue(),volume);await viewer.locator('#sound-dialog [data-close-dialog]').click();
  assert.equal(await viewer.locator('#watch-sound').evaluate(n=>document.activeElement===n),true);
  await viewer.locator('#fullscreen-screen').click();assert.equal(await viewer.evaluate(()=>document.fullscreenElement?.id),'share-panel');
  for(const id of ['toggle-mic','voice-only','watch-sound','watch-text','fullscreen-screen'])assert.equal(await viewer.locator('#'+id).isVisible(),true);
  await capture(viewer,'10-fullscreen');await viewer.locator('#watch-sound').click();await viewer.locator('#sound-dialog [data-close-dialog]').click();await viewer.locator('#fullscreen-screen').click();assert.equal(await viewer.evaluate(()=>!!document.fullscreenElement),false);
  assert.equal(await viewer.locator('#remote-screen').evaluate((node,original)=>node===original,video),true,'fullscreen preserves the exact player');
  await viewer.setViewportSize({width:390,height:844});await noOverflow(viewer,'watch 390');await capture(viewer,'11-watch-390');await axe(viewer,'watch narrow');
  await viewer.locator('#voice-only').click();await viewer.emulateMedia({colorScheme:'light',reducedMotion:'reduce'});await noOverflow(viewer,'voice 390');await capture(viewer,'12-voice-light-390');await axe(viewer,'voice light narrow');
  await viewer.setViewportSize({width:720,height:500});await viewer.addStyleTag({content:':root{font-size:200% !important}'});await noOverflow(viewer,'voice 200 percent text');await capture(viewer,'13-voice-text-200');await axe(viewer,'voice 200 percent text');
  await settings(viewer);await noOverflow(viewer,'settings 200 percent text');await trap(viewer,'settings-dialog');await viewer.locator('#exit-program').focus();assert.equal(await viewer.locator('#exit-program').evaluate(node=>{const rect=node.getBoundingClientRect();return rect.top>=0&&rect.bottom<=innerHeight;}),true);await viewer.locator('#settings-dialog [data-close-dialog]').focus();await capture(viewer,'14-settings-text-200');await axe(viewer,'settings 200 percent text');await closeSettings(viewer);
  await viewer.locator('#room-text').click();await noOverflow(viewer,'text 200 percent');await viewer.waitForFunction(()=>!document.querySelector('#send-text').disabled);await viewer.locator('#send-text').focus();assert.equal(await viewer.locator('#send-text').evaluate(node=>{const r=node.getBoundingClientRect(),p=document.querySelector('#text-panel').getBoundingClientRect();return document.activeElement===node&&r.top>=p.top&&r.bottom<=Math.min(p.bottom,innerHeight);}),true,'text send remains reachable at 200 percent');await capture(viewer,'22-text-200');await axe(viewer,'text 200 percent');await viewer.locator('#close-text').click();
  await other.evaluate(()=>window.__lanScreenTest.sockets.findLast(socket=>new URL(socket.url).pathname==='/ws/v1'&&socket.readyState===WebSocket.OPEN).close());await other.locator('body[data-stage="entry"]').waitFor();await other.locator('#error-message').waitFor({state:'visible'});await capture(other,'23-local-disconnect');await ax(other,'local disconnect alert');await axe(other,'local disconnect');
  await host.waitForFunction(()=>document.querySelector('#topbar-room-count').textContent==='2 人',null,{timeout:25000});
  await other.locator('#quick-manual-join').click();await other.locator('#join-address').fill(invite.address);await other.locator('#join-port').fill(invite.port);await other.locator('#join-code').fill(invite.code);await other.locator('#join-room').click();await other.locator('body[data-stage="watch"]').waitFor();assert.equal(await other.locator('#toggle-mic').getAttribute('aria-pressed'),'false','recovery does not silently recapture microphone');evidence.checks.push({check:'actual local socket loss, seat timeout and manual recovery',passed:true});
  await viewer.locator('#leave-room').click();await viewer.locator('body[data-stage="entry"]').waitFor();assert.equal(await viewer.locator('#text-log').textContent(),'','leaving clears local message history');
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  evidence.checks.push({check:'all core paths above',passed:true,realHardwareCapture:false});
  evidence.completed=true;
});
