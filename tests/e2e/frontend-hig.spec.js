import test from 'node:test';
import {checkLiquidGlass} from './fixtures/liquid-glass.js';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {installSyntheticMedia} from './fixtures/synthetic-media.js';
import {availableLANIPv4s,createTestPreferences,startOwnedService,shutdownOwnedServices,selectedLANIPv4} from './fixtures/services.js';

const output=path.resolve(process.env.LANSW_HIG_EVIDENCE || '.superpowers/sdd/lan-screen-sharing/build/hig-evidence');
const assetFiles=['index.html','styles.css','app.js','client.js','preferences.js','connection-lifecycle.js','page-lease.js','room-browser.js','room-invite.js','room-experience.js','room-text.js','room-text-ui.js','media.js','screen-relay.js','media-stats-poller.js','media-stats.js','fullscreen.js','preview-playback.js','voice-controls.js','quality-hud.js','viewer-tools.js','room-reactions.js','sound-effects.js','icons.js','player-pointer.js'];
const microphones=[{deviceId:'desk-mic',label:'桌面麦克风'},{deviceId:'headset-mic',label:'耳机麦克风'}];

test('HIG frontend flows: actual rooms, text, media controls, keyboard, appearance, zoom and errors', {timeout:180000}, async t=>{
  assert.ok(process.env.LANSW_EXE && process.env.LANSW_BROWSER_PATH,'provide the candidate executable and installed browser');
  await mkdir(output,{recursive:true});
  const services=[],contexts=[],errors=[],external=[],browserInternal=[],testProfiles=[],evidence={completed:false,environment:'Windows / isolated Edge / synthetic capture / native WebRTC',checks:[],screens:[],axe:[],ax:[],sourceHashes:{}};
  const lanIP=selectedLANIPv4();
  const args=['--mute-audio'];
  if(process.env.LANSW_TEST_DISABLE_MDNS==='1')args.push('--disable-features=WebRtcHideLocalIpsWithMdns');
  const browser=await chromium.launch({headless:true,executablePath:process.env.LANSW_BROWSER_PATH,args});
  evidence.browserVersion=browser.version();
  evidence.mdnsHostObfuscationDisabled=process.env.LANSW_TEST_DISABLE_MDNS==='1';
  t.after(async()=>{
    await Promise.allSettled(contexts.map(context=>context.close()));await browser.close();await shutdownOwnedServices(services);
    for(const profile of testProfiles)await profile.cleanup();
    evidence.errors=errors;evidence.externalRequestCount=external.length;evidence.externalRequests=external;evidence.browserInternalRequestCount=browserInternal.length;
    for(const file of assetFiles) evidence.sourceHashes[file]=createHash('sha256').update(await readFile('internal/web/assets/'+file)).digest('hex');
    evidence.buildSHA256=createHash('sha256').update(await readFile(process.env.LANSW_EXE)).digest('hex');
    await writeFile(path.join(output,'evidence.json'),JSON.stringify(evidence,null,2));
  });
  function monitorRequests(context) {
    context.on('request', request => {
      const url = new URL(request.url());
      if (url.protocol === 'data:' || url.protocol === 'about:') return;
      // The PNG opens Edge's bundled downloads flyout. Its resources use the
      // browser's private scheme and never reach an external server.
      if (url.protocol === 'edge:' && ['downloads-hub','resources','fileicon'].includes(url.hostname)) {
        browserInternal.push(url.hostname);
        return;
      }
      const destination = url.protocol === 'blob:' && url.origin !== 'null' ? new URL(url.origin) : url;
      if (!['localhost','127.0.0.1'].includes(destination.hostname)) {
        external.push({protocol: url.protocol, hostname: destination.hostname, resource: request.resourceType()});
      }
    });
  }
  const pages=[];
  for(let i=0;i<3;i++){
    const service=await startOwnedService({lanIP});services.push(service);
    const context=await browser.newContext({viewport:{width:1440,height:1000},colorScheme:'dark',reducedMotion:'reduce'});contexts.push(context);
    await context.addInitScript(installSyntheticMedia,{participantAlias:i?'viewer-'+i:'host',microphones});
    monitorRequests(context);
    const page=await context.newPage();pages.push(page);page.on('pageerror',error=>errors.push(error.message));
    // Keep the initial live-announcement check independent of rooms appearing on the real LAN.
    if(i===0)await page.route('**/api/v1/rooms',route=>route.fulfill({json:{available:true,rooms:[]}}));
    await page.goto(service.baseURL);
  }
  const [host,viewer,other]=pages;
  evidence.servedHashes={};
  for(const file of assetFiles) {
    const response=await fetch(services[0].baseURL+(file==='index.html'?'/':'/assets/'+file));assert.equal(response.ok,true);
    const actual=createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');const expected=createHash('sha256').update(await readFile('internal/web/assets/'+file)).digest('hex');assert.equal(actual,expected,'embedded '+file+' matches reviewed source');evidence.servedHashes[file]=actual;
  }
  async function settle(page){
    await page.evaluate(async()=>{
      await document.fonts.ready;
      // A background Chromium tab can suspend the animation clock. Sample the final finite styles.
      for(const animation of document.getAnimations()){
        if(animation.effect?.getComputedTiming().endTime<Infinity&&animation.playState!=='finished')animation.finish();
      }
    });
  }
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
    await noOverflow(page, state);
    const result=await page.evaluate(async()=>{const r=await window.axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','best-practice']}});return{violations:r.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))})),incomplete:r.incomplete.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>n.target)})),passes:r.passes.length};});
    evidence.axe.push({state,...result});assert.deepEqual(result.violations,[],state+' has accessibility violations');
  }
  async function noOverflow(page,state){const result=await page.evaluate(()=>({width:innerWidth,content:document.documentElement.scrollWidth}));assert.ok(result.content<=result.width+1,state+' overflows horizontally');evidence.checks.push({check:state+' horizontal fit',...result});}
  async function settings(page){await page.locator('#open-settings').click();}
  async function closeSettings(page){await page.locator('#settings-dialog [data-close-dialog]').click();}
  const microphoneRequests=page=>page.evaluate(()=>window.__lanScreenTest.captures.filter(item=>item.type==='microphone-request').length);
  const microphoneState=page=>page.evaluate(()=>window.__lanScreenTest.sources.filter(source=>source.label==='microphone').map(source=>({
    enabled:source.track.enabled, readyState:source.track.readyState, device:source.track.getSettings().deviceId,
    senders:window.__lanScreenTest.pcs.flatMap(pc=>pc.getSenders()).filter(sender=>sender.track===source.track).length,
  })));
  async function pttSending(page, active){
    await page.waitForFunction(active=>document.querySelector('#push-to-talk').getAttribute('aria-pressed')===String(active) &&
      window.__lanScreenTest.sources.findLast(source=>source.label==='microphone')?.track.enabled===active,active);
  }
  async function stageSpring(page, selector){
    await page.waitForFunction(selector=>document.querySelector(selector).getAnimations().some(({effect})=>{
      const start=effect.getKeyframes()[0];
      return effect.getTiming().duration===460&&start.opacity==='0'&&start.translate==='0px 22px'&&start.scale==='0.975';
    }),selector);
  }

  await host.locator('#connection-status').filter({hasText:'已就绪'}).waitFor();
  assert.equal(await host.evaluate(()=>window.__lanScreenTest.captures.length),0,'entry must not request any capture');
  assert.deepEqual(await host.locator('#empty-rooms .radar-ring').evaluateAll(rings=>rings.map(ring=>getComputedStyle(ring).animationDelay)),['0s','-1.2s','-2.4s']);
  await capture(host,'01-entry-dark');await axe(host,'entry dark');
  await host.evaluate(()=>{window.__qaStatusChanges=0;window.__qaStatusObserver=new MutationObserver(()=>window.__qaStatusChanges++);window.__qaStatusObserver.observe(document.querySelector('#discovery-status'),{childList:true,characterData:true,subtree:true});});await host.waitForTimeout(6500);assert.equal(await host.evaluate(()=>window.__qaStatusChanges),0,'unchanged discovery polls do not repeat live announcements');await host.evaluate(()=>window.__qaStatusObserver.disconnect());evidence.checks.push({check:'unchanged discovery status has no repeated DOM mutation across two polls',passed:true});
  await host.emulateMedia({colorScheme:'light'});await capture(host,'02-entry-light');await axe(host,'entry light');
  await host.setViewportSize({width:390,height:844});
  await noOverflow(host,'entry light narrow');await capture(host,'02b-entry-light-390');
  await host.emulateMedia({colorScheme:'dark'});
  await noOverflow(host,'entry dark narrow');await capture(host,'01b-entry-dark-390');
  await host.setViewportSize({width:1440,height:1000});
  let fixtureRooms=[{id:'fixture-active',name:'测试 · 周末游戏',members:1,capacity:3,screenSharing:true,hostIPv4:lanIP,hostPort:Number(services[0].signalPort),roomCode:'ABCD2345'},{id:'fixture-full',name:'测试 · 已满房间',members:3,capacity:3,hostIPv4:lanIP,hostPort:Number(services[0].signalPort),roomCode:'BCDE2345'},{id:'fixture-idle',name:'测试 · 聊会儿',members:2,capacity:3,hostIPv4:lanIP,hostPort:Number(services[0].signalPort),roomCode:'CDEF2345'}];
  await host.route('**/api/v1/rooms',route=>route.fulfill({json:{available:true,rooms:fixtureRooms}}));await host.locator('#refresh-rooms').click();await host.locator('.discovered-room').nth(2).waitFor();
  const roomCard=host.locator('.discovered-room').first();
  await roomCard.hover({position:{x:24,y:24}});
  await host.waitForFunction(()=>{
    const card=document.querySelector('.discovered-room');
    return card.style.getPropertyValue('--mx')&&card.style.getPropertyValue('--my')&&getComputedStyle(card,'::before').opacity==='1';
  });
  await host.mouse.move(0,0);
  evidence.checks.push({check:'three radar phases and delegated discovery spotlight',passed:true});
  assert.equal(await host.locator('[data-room-id="fixture-full"] button').isDisabled(),true);await capture(host,'15-rooms-fixture');await axe(host,'discovery populated fixture');
  await host.emulateMedia({colorScheme:'light'});await capture(host,'15b-rooms-fixture-light');await axe(host,'discovery populated light');await host.emulateMedia({colorScheme:'dark'});
  await host.setViewportSize({width:390,height:844});await noOverflow(host,'room cards 390');await capture(host,'16-rooms-fixture-390');await host.setViewportSize({width:1440,height:1000});
  let releaseBootstrap;const heldBootstrap=new Promise(resolve=>releaseBootstrap=resolve);await host.route('**/api/v1/bootstrap',async route=>{await heldBootstrap;await route.continue();});
  await host.locator('[data-room-id="fixture-active"] button').click();await host.locator('[data-room-id="fixture-active"][aria-busy="true"]').waitFor();assert.equal(await host.locator('[data-room-id="fixture-active"] button').isDisabled(),true);await capture(host,'20-joining-fixture');releaseBootstrap();await host.unroute('**/api/v1/bootstrap');
  await host.locator('#error-message').waitFor({state:'visible'});await capture(host,'17-stale-room');await axe(host,'stale room failure');await ax(host,'stale room alert');
  fixtureRooms=[];await host.unroute('**/api/v1/rooms');await host.locator('#refresh-rooms').click();
  await host.locator('#quick-manual-join').click();
  assert.equal(await host.locator('#join-manual-fields').getAttribute('open'),null,'individual connection fields start collapsed');
  await capture(host,'22-paste-invite-dark');await axe(host,'single invitation dark');
  await host.emulateMedia({colorScheme:'light'});await capture(host,'23-paste-invite-light');await axe(host,'single invitation light');
  await host.setViewportSize({width:390,height:844});await noOverflow(host,'single invitation 390');await capture(host,'24-paste-invite-390');await host.setViewportSize({width:1440,height:1000});await host.emulateMedia({colorScheme:'dark'});
  await host.locator('#join-invite').fill('ABCD2345');await host.locator('#join-room').click();assert.equal(await host.locator('#join-invite').getAttribute('aria-invalid'),'true');assert.equal(await host.locator('#join-invite').evaluate(n=>n===document.activeElement),true);await capture(host,'18-invalid-join');
  await host.locator('#join-invite').fill('');await host.locator('#join-manual-fields > summary').click();await host.locator('#join-address').fill('invalid');await host.locator('#join-port').fill('0');await host.locator('#join-code').fill('');await host.locator('#join-room').click();assert.equal(await host.locator('#join-address').evaluate(n=>n.validity.valid),false);assert.equal(await host.locator('#join-address').evaluate(n=>n===document.activeElement),true);await host.locator('#browse-rooms').click();
  await host.locator('#entry-identity').click();
  assert.equal(await microphoneRequests(host),0,'opening entry settings never requests a microphone');
  await host.locator('#nickname').fill('小雨🌙');
  await host.locator('input[value="teal"]').check();
  await capture(host,'28-entry-identity-dark');await axe(host,'identity and network dark');
  await closeSettings(host);
  assert.equal(await host.locator('#entry-identity-name').textContent(),'小雨🌙');
  assert.equal(await host.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches),true);
  await host.locator('#quick-create-room').click();
  await stageSpring(host,'#room-panel');
  evidence.checks.push({check:'whole setup stage springs in with reduced motion enabled',passed:true});
  await host.locator('#room-name').fill('周二游戏夜');await host.locator('#room-discoverable').uncheck();await capture(host,'03-create');await axe(host,'create');
  await host.locator('#create-room').click();await host.locator('body[data-stage="voice"]').waitFor();
  await stageSpring(host,'#voice-stage');
  assert.deepEqual(await host.locator('#members > .member-seat, #members > .voice-activity').evaluateAll(nodes=>nodes.map(node=>node.getAnimations()[0]?.effect.getTiming().delay)),[0,60,120,150]);
  evidence.checks.push({check:'voice stage enters with four staggered springs',passed:true});
  await host.locator('#invite-room').click();
  const invite=await host.evaluate(()=>({address:document.querySelector('#host-address').value,port:document.querySelector('#host-port').value,code:document.querySelector('#room-code').textContent,text:document.querySelector('#invite-text').value}));
  assert.equal(invite.text,`${invite.address}:${invite.port}  房间码 ${invite.code}`);await capture(host,'25-copy-invitation-dark');await axe(host,'copy invitation dark');
  await host.emulateMedia({colorScheme:'light'});await capture(host,'26-copy-invitation-light');await axe(host,'copy invitation light');await host.emulateMedia({colorScheme:'dark'});
  await host.setViewportSize({width:390,height:844});await noOverflow(host,'copy invitation 390');await capture(host,'27-copy-invitation-390');await host.setViewportSize({width:1440,height:1000});
  await trap(host,'invite-dialog');await ax(host,'invite dialog');
  await host.locator('#invite-dialog [data-close-dialog]').click();
  for(const [page,shortcut] of [[viewer,'Enter'],[other,'Control+Enter']]){
    await page.locator('#quick-manual-join').click();
    await page.locator('#join-invite').fill(invite.text);
    await page.locator('#join-invite').press(shortcut);await page.locator('body[data-stage="voice"]').waitFor();
    assert.equal(await page.locator('#topbar-room-name').textContent(),'周二游戏夜','manual join preserves actual room context');
  }
  await host.waitForFunction(()=>document.querySelectorAll('.member-seat[data-empty="false"]').length===3);
  assert.match(await viewer.locator('#members .member-seat[data-role="host"] > strong').textContent(),/小雨🌙/);
  assert.equal(await viewer.locator('#members .member-seat[data-role="host"] .member-avatar').getAttribute('data-avatar-color'),'teal');
  await capture(host,'04-voice-three');await axe(host,'voice dark');
  await host.emulateMedia({colorScheme:'light'});
  await capture(host,'04b-voice-light');await axe(host,'voice light wide');
  await host.setViewportSize({width:390,height:844});
  await noOverflow(host,'voice light review narrow');await capture(host,'04c-voice-light-390');
  await host.emulateMedia({colorScheme:'dark'});
  await noOverflow(host,'voice dark review narrow');await capture(host,'04d-voice-dark-390');
  await host.setViewportSize({width:1440,height:1000});
  await host.locator('#room-menu').click();assert.equal(await host.locator('#member-summary .member-seat').count(),3);await trap(host,'members-dialog');await ax(host,'voice members');await capture(host,'21-voice-members');await host.locator('#members-dialog [data-close-dialog]').click();
  assert.equal(await host.evaluate(()=>window.__lanScreenTest.captures.length),0,'voice entry must not implicitly enable microphone');
  await host.locator('#room-text').click();await host.waitForFunction(()=>!document.querySelector('#send-text').disabled);
  await host.locator('#text-input').fill('不开麦也可以一起聊。');
  await Promise.all([
    viewer.waitForFunction(()=>document.querySelector('#room-text').getAnimations().some(animation=>animation.effect.getTiming().duration===360)),
    host.locator('#text-input').press('Enter'),
  ]);
  evidence.checks.push({check:'unread text animates with reduced motion enabled',passed:true});
  await Promise.all([viewer,other].map(page=>page.waitForFunction(()=>document.querySelector('#text-log').textContent.includes('不开麦也可以一起聊。'))));
  await viewer.locator('#room-text').click();await viewer.locator('#text-input').fill('我看到了，一起开始吧。');await viewer.locator('#send-text').click();
  await host.waitForFunction(()=>document.querySelector('#text-log').textContent.includes('我看到了，一起开始吧。'));await capture(host,'05a-text-conversation');
  await host.emulateMedia({colorScheme:'light'});
  await capture(host,'05b-text-light');await axe(host,'text light wide');
  await host.emulateMedia({colorScheme:'dark'});
  await viewer.locator('#text-input').fill('<img src=x onerror=alert(1)>');await viewer.locator('#send-text').click();
  await host.waitForFunction(()=>document.querySelector('#text-log').textContent.includes('<img'));
  assert.equal(await host.locator('#text-log img').count(),0,'text messages are plain text');
  await capture(host,'05-text');await axe(host,'text');
  await ax(host,'text log and input');
  await host.locator('#text-input').press('Escape');assert.equal(await host.locator('#room-text').evaluate(n=>document.activeElement===n),true,'modeless text restores its trigger');
  await viewer.locator('#close-text').click();
  await settings(host);
  assert.equal(await microphoneRequests(host),0,'opening room settings never requests a microphone');
  assert.equal(await host.locator('#mic-mode').inputValue(),'open');
  await host.locator('#mic-device').selectOption('headset-mic');
  assert.equal(await microphoneRequests(host),0,'choosing a device while muted never requests a microphone');
  await host.locator('#test-mic').click();
  await host.waitForFunction(()=>Number(document.querySelector('#mic-level').style.getPropertyValue('--mic-level'))>.05);
  assert.deepEqual(await microphoneState(host),[{enabled:true,readyState:'live',device:'headset-mic',senders:0}]);
  await capture(host,'30-microphone-test');await axe(host,'voice settings with local trial');
  await closeSettings(host);
  await host.waitForFunction(()=>window.__lanScreenTest.sources[0].track.readyState==='ended'&&document.querySelector('#mic-level').dataset.active==='false');
  await settings(host);
  await host.evaluate(()=>{
    window.__lanScreenTest.microphones=[{deviceId:'default',label:'系统默认麦克风'}];
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
  });
  await host.locator('#mic-note').filter({hasText:'已改用系统默认麦克风'}).waitFor();
  assert.equal(await host.locator('#mic-device').inputValue(),'');
  assert.equal(await microphoneRequests(host),1,'device removal does not run capture by itself');
  await host.evaluate(device=>{
    window.__lanScreenTest.microphones=[device];
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
  },microphones[0]);
  await closeSettings(host);
  evidence.checks.push({check:'settings and device selection leave capture idle; explicit local trial shows levels, has no sender and is released on close; removing a saved device falls back',passed:true});
  for(const page of pages)await page.locator('#toggle-mic').click();
  await host.waitForFunction(()=>document.querySelector('#toggle-mic').getAttribute('aria-pressed')==='true');
  await host.waitForFunction(()=>document.querySelectorAll('#members [data-speaking="true"]').length===2);
  const liveMeters=host.locator('#members .member-seat[data-speaking="true"]');
  const originalLevel=await liveMeters.evaluateAll(seats=>Math.max(...seats.map(seat=>Number(seat.style.getPropertyValue('--voice-level')))));
  assert.equal(await liveMeters.locator('.voice-meter[aria-hidden="true"] > i').count(),6);
  const setRemoteGain=level=>Promise.all([viewer,other].map(page=>page.evaluate(value=>{
    window.__lanScreenTest.sources.find(source=>source.label==='microphone').gain.gain.value=value;
  },level)));
  await setRemoteGain(.2);
  await host.waitForFunction(previous=>[...document.querySelectorAll('#members [data-speaking="true"]')].some(seat=>{
    const level=Number(seat.style.getPropertyValue('--voice-level'));
    return level>previous+.05&&level<=1;
  }),originalLevel);
  await setRemoteGain(0);
  await host.waitForFunction(()=>!document.querySelector('#members [data-speaking="true"]')&&
    [...document.querySelectorAll('#members .member-seat[data-peer-id]')].every(seat=>seat.style.getPropertyValue('--voice-level')==='0'));
  await setRemoteGain(.025);
  evidence.checks.push({check:'three decorative bars respond to native remote RTP level and return to silence',passed:true});
  await settings(host);
  await host.locator('#mic-device').selectOption('desk-mic');
  await host.waitForFunction(()=>window.__lanScreenTest.sources.filter(source=>source.label==='microphone').length===3 &&
    window.__lanScreenTest.sources.at(-2).track.readyState==='ended'&&
    window.__lanScreenTest.pcs.flatMap(pc=>pc.getSenders()).filter(sender=>sender.track===window.__lanScreenTest.sources.at(-1).track).length===2);
  assert.equal((await microphoneState(host)).at(-1).device,'desk-mic');
  await host.locator('#mic-mode').selectOption('ptt');
  await pttSending(host,false);
  await host.locator('#nickname').fill('小雨🌙');
  const settingsSpace=await host.locator('#nickname').evaluate(node=>node.dispatchEvent(new KeyboardEvent('keydown',{code:'Space',key:' ',bubbles:true,cancelable:true})));
  assert.equal(settingsSpace,true);
  await host.locator('#nickname').press('Space');
  assert.equal(await host.locator('#nickname').inputValue(),'小雨🌙 ');
  await pttSending(host,false);
  await host.locator('#nickname').fill('小雨🌙');
  await closeSettings(host);
  await host.locator('#settings-dialog').waitFor({state:'hidden'});
  await host.waitForFunction(()=>document.activeElement.id==='open-settings');
  await host.bringToFront();
  await host.evaluate(()=>document.activeElement.blur());
  const imeSpace=await host.evaluate(()=>document.body.dispatchEvent(new KeyboardEvent('keydown',{code:'Space',key:' ',isComposing:true,bubbles:true,cancelable:true})));
  assert.equal(imeSpace,true);await pttSending(host,false);
  await host.keyboard.down('Space');
  await pttSending(host,true);
  const speakingSeat=await host.evaluate(()=>{
    const seat=document.querySelector('#members .member-seat[data-self="true"]');
    return {
      speaking:seat.dataset.speaking,
      status:seat.querySelector('.member-status').textContent,
      micPressed:document.querySelector('#push-to-talk').getAttribute('aria-pressed'),
      track:window.__lanScreenTest.sources.at(-1).track.enabled,
      visible:document.visibilityState,
      focused:document.activeElement.id || document.activeElement.tagName,
    };
  });
  assert.equal(speakingSeat.speaking,'true',JSON.stringify(speakingSeat));
  await capture(host,'31-push-to-talk');await axe(host,'push-to-talk transmitting');await ax(host,'push-to-talk button and voice seat');
  await host.keyboard.up('Space');await pttSending(host,false);
  const hold=host.getByRole('button',{name:'按住说话'});
  await hold.focus();await host.keyboard.down('Space');await pttSending(host,true);
  await host.evaluate(()=>window.dispatchEvent(new Event('blur')));await pttSending(host,false);
  await host.keyboard.up('Space');await pttSending(host,false);
  await hold.hover();await host.mouse.down();await pttSending(host,true);
  await host.mouse.up();await pttSending(host,false);
  await host.locator('#room-text').click();
  await host.locator('#text-input').fill('空格');await host.locator('#text-input').press('Space');
  assert.equal(await host.locator('#text-input').inputValue(),'空格 ');
  await pttSending(host,false);await host.locator('#close-text').click();
  await settings(host);await host.locator('#mic-mode').selectOption('open');await closeSettings(host);
  evidence.checks.push({check:'host hot-swaps both native senders; PTT holds by keyboard and pointer, releases on keyup and blur, honors input, modal and IME, and has an accessible named button',passed:true});
  await settings(host);assert.equal(await host.locator('.settings-section').evaluate(n=>n.open),false,'advanced diagnosis starts collapsed');
  assert.equal(await host.locator('#settings-dialog').evaluate(node=>getComputedStyle(node,'::backdrop').backdropFilter),'blur(10px) saturate(1.4)');
  await capture(host,'06-settings');await axe(host,'settings');
  await host.emulateMedia({colorScheme:'light'});await capture(host,'06b-settings-light');
  await host.emulateMedia({colorScheme:'dark'});
  await trap(host,'settings-dialog');await ax(host,'settings controls');
  await host.locator('#exit-program').click();await host.locator('#confirm-dialog').waitFor({state:'visible'});assert.equal(await host.locator('#confirm-cancel').evaluate(n=>document.activeElement===n),true);await trap(host,'confirm-dialog');await ax(host,'destructive confirmation');await capture(host,'07-exit-confirm');await host.locator('#confirm-cancel').click();
  // Native dialog close dispatches a queued event. Wait for the restored task
  // before asserting its focus; a click acknowledgment alone is too early.
  await host.locator('#settings-dialog').waitFor({state:'visible',timeout:3000});
  await host.waitForFunction(()=>document.activeElement===document.querySelector('#exit-program'),null,{timeout:3000});
  assert.equal(await host.locator('#exit-program').evaluate(n=>document.activeElement===n),true);await closeSettings(host);
  await host.locator('#end-room').click();await host.locator('#confirm-dialog').waitFor({state:'visible'});await host.locator('#confirm-cancel').press('Escape');assert.equal(await host.locator('body').getAttribute('data-stage'),'voice');
  await settings(host);assert.equal(await host.locator('#share-mode').inputValue(),'combined','system audio is enabled by default');await closeSettings(host);
  await settings(viewer);await viewer.locator('#quality-target').focus();await host.locator('#start-share').click();await stageSpring(viewer,'.screen-stage');
  assert.equal(await viewer.locator('#settings-dialog').isVisible(),true,'remote sharing preserves the current settings task');assert.equal(await viewer.locator('#quality-target').evaluate(n=>document.activeElement===n),true);await closeSettings(viewer);
  evidence.checks.push({check:'whole watch stage springs in without disrupting an open sheet',passed:true});
  await viewer.locator('body[data-stage="watch"]').waitFor();await viewer.waitForFunction(()=>document.querySelector('#remote-screen').videoWidth>0);await checkLiquidGlass(viewer, ['.topbar', 'body[data-stage=watch] .room-controls']);
  await viewer.waitForFunction(()=>/^720p(?: · \d+fps)?$/.test(document.querySelector('#quality-received').textContent));
  assert.equal(await viewer.locator('#quality-trigger').isVisible(),false);
  evidence.checks.push({check:'toolbar and watch dock retain blur under increased contrast and reduced transparency',passed:true});
  await viewer.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'});
  await viewer.evaluate(()=>document.activeElement.blur());
  const watchingStage=viewer.locator('.screen-stage');
  await watchingStage.hover({position:{x:250,y:160}});
  await viewer.waitForFunction(()=>getComputedStyle(document.querySelector('.screen-hud')).opacity==='1');
  await capture(viewer,'08-watch');await axe(viewer,'watch');
  async function watchAppearance(theme, blur, glass, ink, live) {
    await viewer.emulateMedia({colorScheme:theme});
    const styles = await viewer.evaluate(() => {
      const dock = getComputedStyle(document.querySelector('.room-controls'));
      const label = document.querySelector('.screen-label');
      return [dock.backdropFilter, dock.backgroundColor, getComputedStyle(label).color,
        getComputedStyle(label, '::before').backgroundColor];
    });
    assert.deepEqual(styles, [`saturate(1.8) blur(${blur}px)`, glass, ink, live]);
  }
  await watchAppearance('dark', 24, 'rgba(11, 18, 26, 0.74)', 'rgb(242, 246, 249)', 'rgb(224, 60, 88)');
  await watchAppearance('light', 22, 'rgba(255, 255, 255, 0.78)', 'rgb(19, 27, 33)', 'rgb(217, 50, 80)');
  await watchingStage.hover({position:{x:255,y:165}});
  await viewer.waitForFunction(()=>getComputedStyle(document.querySelector('.screen-hud')).opacity==='1');
  await capture(viewer,'08b-watch-light');await axe(viewer,'watch light');
  await viewer.setViewportSize({width:390,height:844});
  await watchingStage.hover({position:{x:180,y:150}});
  await noOverflow(viewer,'watch light review narrow');await capture(viewer,'08c-watch-light-390');
  await viewer.emulateMedia({colorScheme:'dark'});
  await noOverflow(viewer,'watch dark review narrow');await capture(viewer,'08d-watch-dark-390');
  await viewer.setViewportSize({width:1440,height:1000});
  evidence.checks.push({check:'watch HUD and dock apply both glass palettes and the ruby live indicator',passed:true});
  await viewer.waitForFunction(()=>document.querySelector('#share-panel').classList.contains('pointer-idle')&&
    getComputedStyle(document.querySelector('.screen-hud')).opacity==='0');
  await watchingStage.hover({position:{x:260,y:170}});
  await viewer.waitForFunction(()=>!document.querySelector('#share-panel').classList.contains('pointer-idle')&&
    getComputedStyle(document.querySelector('.screen-hud')).opacity==='1');
  evidence.checks.push({check:'viewer quality capsule hides and reappears with the rest of the HUD',passed:true});
  const video=await viewer.locator('#remote-screen').evaluateHandle(n=>n);
  await viewer.locator('#watch-sound').click();await trap(viewer,'sound-dialog');await ax(viewer,'sound slider and mute state');await capture(viewer,'09-sound');await axe(viewer,'sound');
  await viewer.emulateMedia({colorScheme:'light'});
  await capture(viewer,'09b-sound-light');await axe(viewer,'sound light');
  await viewer.emulateMedia({colorScheme:'dark'});
  await viewer.locator('#audio-filter [data-audio-filter="systemAudio"]').click();
  const audioFilter=viewer.locator('#audio-filter');
  assert.equal(await audioFilter.evaluate(node=>node.style.getPropertyValue('--filter-index')),'2');
  assert.equal(await audioFilter.evaluate(node=>document.getAnimations().some(animation=>
    animation.transitionProperty==='translate' && (animation.effect.target===node || animation.effect.target?.element===node)
  )),true,'the audio filter animates its indicator');
  await viewer.waitForFunction(()=>getComputedStyle(document.querySelector('#audio-filter'),'::before').translate==='200%');
  assert.equal(await viewer.locator('#audio-sources .audio-source:visible').count(),1);
  assert.equal(await viewer.locator('#audio-sources .audio-source:visible').getAttribute('data-role'),'systemAudio');
  await viewer.locator('#audio-filter [data-audio-filter="all"]').click();
  const hostPeerId=await viewer.locator('#members [data-role="host"]').getAttribute('data-peer-id');
  const slider=viewer.locator(`#sound-dialog .audio-source[data-role="microphone"][data-peer-id="${hostPeerId}"] input`);
  await slider.focus();await slider.press('ArrowLeft');const volume=await slider.inputValue();
  const mediaGraph=page=>page.evaluate(()=>({pcs:window.__lanScreenTest.pcs.length,
    descriptions:window.__lanScreenTest.sent.filter(message=>['rtc.description','screen.description'].includes(message.type)).length}));
  const beforeProfile=await Promise.all([host,viewer,other].map(mediaGraph));
  const nextName='<b>夜航</b>';
  await settings(host);
  assert.equal(await host.locator('#network-interface').isDisabled(),true);
  assert.equal(await host.locator('#network-switch-note').isVisible(),true);
  await host.locator('#nickname').fill(nextName);
  await host.locator('input[value="pink"]').check();
  await closeSettings(host);
  await viewer.locator('#members .member-seat[data-role="host"] > strong').filter({hasText:nextName}).waitFor({state:'attached'});
  await viewer.locator('#sound-dialog .audio-source strong').filter({hasText:nextName+' · 共享声音'}).waitFor();
  assert.equal(await viewer.locator('#watch-title').textContent(),`正在观看${nextName}的共享画面`);
  assert.match(await viewer.locator('#watch-source').textContent(),/夜航/);
  assert.equal(await viewer.locator('#text-log .text-message strong').first().textContent(),nextName);
  assert.equal(await viewer.locator('#text-log .text-message strong b').count(),0,'markup in the nickname stays text');
  await viewer.locator('#members .member-seat[data-role="host"] .member-avatar[data-avatar-color="pink"]').waitFor({state:'attached'});
  assert.equal(await viewer.locator('#members .member-seat[data-role="host"] .member-avatar').getAttribute('data-avatar-color'),'pink');
  assert.deepEqual(await Promise.all([host,viewer,other].map(mediaGraph)),beforeProfile);
  assert.equal(await slider.evaluate(n=>document.activeElement===n),true);
  assert.equal(await slider.inputValue(),volume);
  evidence.checks.push({check:'authoritative nickname and color update in seats, watch, mixer and existing text without WebRTC renegotiation or focus loss',passed:true});
  const displayRequests=await host.evaluate(()=>window.__lanScreenTest.captures.filter(item=>item.type==='display-request').length);
  const connectionsBeforeQuality=await Promise.all([host,viewer,other].map(mediaGraph));
  await host.getByRole('button',{name:'共享画质目标 1080p · 60fps'}).click();
  await host.getByRole('group',{name:'共享画质快选'}).waitFor();
  await capture(host,'32-quality-quick-pick');await axe(host,'sharing quality picker');await ax(host,'quality picker choices');
  await host.getByRole('button',{name:'1080p · 60 FPS（默认）'}).press('Escape');
  assert.equal(await host.locator('#quality-trigger').evaluate(node=>document.activeElement===node),true);
  await host.locator('#quality-trigger').click();
  await host.getByRole('button',{name:'720p · 30 FPS',exact:true}).press('Enter');
  assert.match(await host.locator('#quality-trigger').textContent(),/720p · 30fps/);
  assert.equal(await host.locator('#quality-target').inputValue(),'720p30');
  await host.waitForFunction(async()=> (await (await fetch('/api/v1/bootstrap')).json()).preferences?.qualityTarget==='720p30');
  assert.equal(await host.evaluate(()=>window.__lanScreenTest.captures.filter(item=>item.type==='display-request').length),displayRequests);
  assert.deepEqual(await Promise.all([host,viewer,other].map(mediaGraph)),connectionsBeforeQuality);
  assert.equal(await viewer.locator('#remote-screen').evaluate((node,original)=>node===original,video),true);
  evidence.checks.push({check:'viewer shows real inbound dimensions; keyboard quick pick synchronizes settings and saved target while retaining native peer connections and player',passed:true});
  await other.locator('#leave-room').click();await viewer.waitForFunction(()=>document.querySelector('#topbar-room-count').textContent==='2 人');
  await other.locator('#quick-manual-join').click();await other.locator('#join-invite').fill(invite.text);await other.locator('#join-room').click();await viewer.waitForFunction(()=>document.querySelector('#topbar-room-count').textContent==='3 人');
  assert.equal(await slider.evaluate(n=>document.activeElement===n),true);assert.equal(await slider.inputValue(),volume);await viewer.locator('#sound-dialog [data-close-dialog]').click();
  assert.equal(await viewer.locator('#watch-sound').evaluate(n=>document.activeElement===n),true);
  assert.deepEqual(await viewer.locator('#sound-dialog').evaluate(node=>({
    open:node.open,
    exiting:node.getAnimations().some(animation=>animation.transitionProperty==='opacity'),
  })),{open:false,exiting:true},'close restores focus immediately while the sheet fades out');
  await viewer.locator('#sound-dialog').waitFor({state:'hidden'});
  evidence.checks.push({check:'audio filter indicator slides and native dialog restores focus during its exit',passed:true});
  await viewer.locator('#fullscreen-screen').press('f');assert.equal(await viewer.evaluate(()=>document.fullscreenElement?.id),'share-panel');
  for(const id of ['toggle-mic','voice-only','watch-sound','watch-text','fullscreen-screen'])assert.equal(await viewer.locator('#'+id).isVisible(),true);
  await capture(viewer,'10-fullscreen');await viewer.locator('#watch-sound').click();await viewer.locator('#sound-dialog [data-close-dialog]').click();await viewer.locator('#fullscreen-screen').click();assert.equal(await viewer.evaluate(()=>!!document.fullscreenElement),false);
  assert.equal(await viewer.locator('#remote-screen').evaluate((node,original)=>node===original,video),true,'fullscreen preserves the exact player');
  await host.bringToFront();
  await host.waitForFunction(()=>document.querySelector('#remote-screen').videoWidth>0);
  assert.equal(await host.locator('#voice-only').getAttribute('aria-describedby'),'voice-only-warning');
  assert.match(await host.locator('#voice-only').getAttribute('title'),/停止你的共享/);
  assert.equal(await host.locator('.room-controls #voice-only-warning').count(),0);
  const dock = await host.locator('.room-controls').evaluate(node => ({
    height:node.getBoundingClientRect().height, width:node.getBoundingClientRect().width,
    rows:new Set([...node.querySelectorAll('button')].filter(button=>button.getClientRects().length).map(button=>Math.round(button.getBoundingClientRect().y))).size,
  }));
  assert.ok(dock.rows===1 && dock.width>4*dock.height,JSON.stringify(dock));
  await capture(host,'33-phase-three-sharer-dock');await axe(host,'sharer slim dock');

  await viewer.bringToFront();
  const source = await viewer.locator('#remote-screen').evaluateHandle(node=>node.srcObject);
  const fullscreenOriginal = await viewer.locator('#fullscreen-screen').boundingBox();
  await viewer.locator('#zoom-in').press('Enter');
  await viewer.locator('#zoom-in').click();
  assert.equal(await viewer.locator('#zoom-reset').textContent(),'1.5×');
  const frame = await watchingStage.boundingBox();
  const x=frame.x+frame.width/2,y=frame.y+frame.height/2;
  await viewer.mouse.move(x,y);await viewer.mouse.wheel(0,-100);
  await viewer.waitForFunction(()=>Number.parseFloat(document.querySelector('#zoom-reset').textContent)>1.5);
  await viewer.mouse.down();await viewer.mouse.move(x+270,y+180,{steps:8});
  await viewer.waitForTimeout(1600);
  assert.equal(await watchingStage.evaluate(node=>node.classList.contains('is-panning')),true);
  assert.equal(await viewer.locator('#share-panel').evaluate(node=>node.classList.contains('pointer-idle')),false);
  const transformed=await viewer.locator('#remote-screen').evaluate(node=>node.style.transform);
  assert.match(transformed,/translate\((?!0px, 0px)/);
  await viewer.mouse.up();
  await viewer.locator('#remote-screen').focus();
  await viewer.keyboard.press('ArrowRight');
  assert.notEqual(await viewer.locator('#remote-screen').evaluate(node=>node.style.transform),transformed);
  await viewer.mouse.dblclick(x,y);
  assert.equal(await viewer.evaluate(()=>document.fullscreenElement),null);
  assert.deepEqual(await viewer.locator('#fullscreen-screen').boundingBox(),fullscreenOriginal);
  assert.equal(await viewer.locator('#remote-screen').evaluate((node,original)=>node===original,video),true);
  assert.equal(await viewer.locator('#remote-screen').evaluate((node,original)=>node.srcObject===original,source),true);

  const captureFile=viewer.waitForEvent('download');
  await viewer.locator('#capture-frame').click();
  const download=await captureFile;
  assert.match(download.suggestedFilename(),/^LAN分享-\d{8}-\d{6}\.png$/);
  const png=await readFile(await download.path());
  assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  assert.deepEqual([png.readUInt32BE(16),png.readUInt32BE(20)],await viewer.locator('#remote-screen').evaluate(node=>[node.videoWidth,node.videoHeight]));
  await viewer.locator('#watch-toast').filter({hasText:'已保存当前画面截图'}).waitFor();

  await viewer.locator('#react-toggle').press('Enter');
  await viewer.waitForFunction(()=>document.activeElement?.dataset.emoji==='👏');
  const picker = viewer.locator('#reaction-picker');
  await picker.waitFor();
  await picker.evaluate(node=>Promise.all(node.getAnimations().map(animation=>animation.finished)));
  const pickerPlacement = await picker.evaluate(node=>{
    const box=node.getBoundingClientRect();
    const hit=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2);
    return {above:box.bottom<document.querySelector('#react-toggle').getBoundingClientRect().top,
      hit:node.contains(hit),opacity:getComputedStyle(node).opacity,width:box.width,height:box.height};
  });
  assert.ok(pickerPlacement.above && pickerPlacement.hit && pickerPlacement.opacity==='1',JSON.stringify(pickerPlacement));
  evidence.checks.push({check:'reaction picker displayed above the watch dock',...pickerPlacement});
  await capture(viewer,'34-phase-three-zoom-and-reactions');await axe(viewer,'zoom plus open reaction picker');
  await viewer.keyboard.press('Escape');
  assert.equal(await viewer.locator('#reaction-picker').isHidden(),true);
  assert.equal(await viewer.locator('#react-toggle').evaluate(node=>document.activeElement===node),true);
  const roomTextBefore=await host.locator('#text-log .text-message').count();
  const hostUnreadBefore=await host.locator('#watch-text').getAttribute('data-unread-count');
  await viewer.locator('#react-toggle').click();
  await viewer.locator('#reaction-picker button[data-emoji="👏"]').press('Enter');
  await viewer.locator('.reaction-float').filter({hasText:'👏'}).waitFor();
  await host.locator('.reaction-float').filter({hasText:'👏'}).waitFor();
  await viewer.locator('.reaction-float').evaluate(async bubble=>{
    const [animation]=bubble.getAnimations();
    animation.pause();
    await animation.ready;
    animation.currentTime=460;
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  });
  await viewer.screenshot({path:path.join(output,'35-phase-three-reaction-in-flight.png')});
  evidence.screens.push('35-phase-three-reaction-in-flight.png');
  await viewer.locator('.reaction-float').evaluateAll(bubbles=>bubbles.forEach(bubble=>bubble.getAnimations()[0]?.play()));
  assert.equal(await host.locator('#text-log .text-message').count(),roomTextBefore);
  assert.equal(await host.locator('#watch-text').getAttribute('data-unread-count'),hostUnreadBefore);

  const linkMessage='看这里 https://example.com/docs?lang=zh&mode=screen。\n第二个 http://example.org/help，javascript:alert(1) <img src=x onerror=alert(1)>';
  await host.locator('#watch-text').click();
  await host.locator('#text-input').fill(linkMessage);
  await host.locator('#send-text').click();
  await host.locator('#close-text').click();
  await viewer.locator('#watch-text').click();
  const linkItem=viewer.locator('.text-message').filter({hasText:'看这里'});
  await linkItem.waitFor();
  assert.equal(await linkItem.locator('p').evaluate(node=>{
    const box=node.getBoundingClientRect();
    const view=document.querySelector('#text-log').getBoundingClientRect();
    return box.top>=view.top && box.bottom<=view.bottom;
  }),true,'newest unread message is fully in view after opening chat');
  assert.equal(await linkItem.locator('p').textContent(),linkMessage);
  assert.equal(await linkItem.locator('img').count(),0);
  assert.deepEqual(await linkItem.locator('a').evaluateAll(links=>links.map(link=>[link.href,link.target,link.rel])),[
    ['https://example.com/docs?lang=zh&mode=screen','_blank','noopener noreferrer'],
    ['http://example.org/help','_blank','noopener noreferrer'],
  ]);
  await viewer.context().grantPermissions(['clipboard-read','clipboard-write']);
  await linkItem.getByRole('button',{name:'复制消息'}).click();
  await viewer.locator('#watch-toast').filter({hasText:'已复制消息'}).waitFor();
  // The Windows clipboard serializes line endings as CRLF.
  assert.equal((await viewer.evaluate(()=>navigator.clipboard.readText())).replaceAll('\r\n','\n'),linkMessage);
  await linkItem.evaluate(node=>node.scrollIntoView({block:'end'}));
  await linkItem.locator('p').scrollIntoViewIfNeeded();
  await capture(viewer,'36-phase-three-chat-links');await axe(viewer,'chat links and message copy');
  await viewer.locator('#close-text').click();
  await viewer.locator('#zoom-reset').click();
  assert.equal(await viewer.locator('#zoom-reset').textContent(),'1×');
  assert.equal(await viewer.locator('#remote-screen').evaluate(node=>node.style.transform),'');
  await viewer.mouse.dblclick(x,y);await viewer.waitForFunction(()=>document.fullscreenElement?.id==='share-panel');
  for (const id of ['pip-screen','zoom-in','capture-frame','react-toggle']) assert.equal(await viewer.locator('#'+id).isVisible(),true);
  await axe(viewer,'fullscreen phase-three controls');
  await viewer.locator('#fullscreen-screen').click();
  await viewer.waitForFunction(()=>!document.fullscreenElement);
  evidence.checks.push({check:'wheel, bounded pan, keyboard, zoom reset, 1× double-click fullscreen, same video/stream and full-size local PNG',passed:true});
  evidence.checks.push({check:'ephemeral reactions delivered P2P without unread/log changes; safe links and real clipboard copy',passed:true});

  const pip=viewer.locator('#pip-screen');
  const nativePipSupported=await viewer.locator('#remote-screen').evaluate(node=>document.pictureInPictureEnabled && typeof node.requestPictureInPicture==='function');
  await viewer.locator('#remote-screen').evaluate(node=>{node.disablePictureInPicture=true;node.dispatchEvent(new Event('resize'));});
  assert.equal(await pip.isDisabled(),true);
  assert.match(await pip.getAttribute('title'),/不支持/);
  await viewer.locator('#remote-screen').evaluate(node=>{node.disablePictureInPicture=false;node.dispatchEvent(new Event('resize'));});
  let nativePipEntered=false;
  if (nativePipSupported) {
    await pip.click();
    await viewer.waitForFunction(()=>document.querySelector('#pip-screen').getAttribute('aria-pressed')==='true'||document.querySelector('#watch-toast').textContent.includes('画中画'));
    nativePipEntered=await pip.getAttribute('aria-pressed')==='true';
    if(nativePipEntered) {
      assert.match(await pip.textContent(),/退出画中画/);
      await pip.click();
      await viewer.waitForFunction(()=>document.querySelector('#pip-screen').getAttribute('aria-pressed')==='false');
    }
  }
  evidence.checks.push({check:'Picture-in-Picture capability, native activation or graceful runtime fallback',passed:true,nativePipSupported,nativePipEntered});

  const freshShareAnnouncements=await viewer.evaluate(()=>window.__lanScreenTest.incoming
    .filter(message=>message.type==='room.state'&&message.payload?.presentationStarted).length);
  assert.equal(freshShareAnnouncements,1);
  await viewer.setViewportSize({width:390,height:844});
  await viewer.locator('#zoom-in').click();
  const zoomStyle=await viewer.addStyleTag({content:':root{font-size:200% !important}'});
  await viewer.locator('#react-toggle').click();
  await noOverflow(viewer,'watch at 390 and 200 percent text');
  assert.equal(await viewer.locator('.room-controls').evaluate(node=>new Set(
    [...node.querySelectorAll('button')].filter(button=>button.getClientRects().length&&!button.closest('#reaction-picker'))
      .map(button=>{const box=button.getBoundingClientRect();return Math.round(box.y+box.height/2);})
  ).size),1,'watch dock stays single row with text enlarged');
  await axe(viewer,'watch 390 and 200 percent plus reactions');
  await capture(viewer,'37-phase-three-watch-390-text-200');
  await viewer.keyboard.press('Escape');
  await zoomStyle.evaluate(node=>node.remove());
  await noOverflow(viewer,'watch 390');await capture(viewer,'11-watch-390');await axe(viewer,'watch narrow');
  if (nativePipEntered) {
    await pip.click();
    await viewer.waitForFunction(()=>document.pictureInPictureElement?.id==='remote-screen');
  }
  await viewer.locator('#voice-only').click();
  await viewer.waitForFunction(()=>!document.pictureInPictureElement);
  assert.equal(await pip.getAttribute('aria-pressed'),'false');
  assert.equal(await viewer.locator('#zoom-reset').textContent(),'1×');
  assert.equal(await viewer.locator('#capture-frame').isDisabled(),true);
  assert.equal(await viewer.locator('#voice-reaction-slot #react-toggle').isVisible(),true);
  await viewer.emulateMedia({colorScheme:'light',reducedMotion:'reduce'});await noOverflow(viewer,'voice 390');await capture(viewer,'12-voice-light-390');await axe(viewer,'voice light narrow');
  await viewer.setViewportSize({width:720,height:500});await viewer.addStyleTag({content:':root{font-size:200% !important}'});await noOverflow(viewer,'voice 200 percent text');await capture(viewer,'13-voice-text-200');await axe(viewer,'voice 200 percent text');
  await settings(viewer);await noOverflow(viewer,'settings 200 percent text');await trap(viewer,'settings-dialog');await viewer.locator('#exit-program').focus();assert.equal(await viewer.locator('#exit-program').evaluate(node=>{const rect=node.getBoundingClientRect();return rect.top>=0&&rect.bottom<=innerHeight;}),true);await viewer.locator('#settings-dialog [data-close-dialog]').focus();await capture(viewer,'14-settings-text-200');await axe(viewer,'settings 200 percent text');await closeSettings(viewer);
  await viewer.locator('#room-text').click();
  await viewer.waitForFunction(()=>document.querySelector('#text-panel').getAnimations().some(animation=>animation.animationName==='text-panel-in'&&animation.effect.getTiming().duration===420));
  await viewer.waitForFunction(()=>!document.querySelector('#send-text').disabled);
  await viewer.locator('#send-text').focus();
  await viewer.locator('#text-panel').evaluate(panel=>Promise.allSettled(panel.getAnimations().map(animation=>animation.finished)));
  await noOverflow(viewer,'text 200 percent');
  const sendPlacement=await viewer.locator('#send-text').evaluate(node=>{
    const button=node.getBoundingClientRect(),panel=document.querySelector('#text-panel').getBoundingClientRect();
    return {focused:document.activeElement===node,top:button.top,bottom:button.bottom,visibleTop:Math.max(0,panel.top),visibleBottom:Math.min(panel.bottom,innerHeight)};
  });
  assert.ok(sendPlacement.focused&&sendPlacement.top>=sendPlacement.visibleTop&&sendPlacement.bottom<=sendPlacement.visibleBottom,
    'text send remains reachable at 200 percent: '+JSON.stringify(sendPlacement));
  await capture(viewer,'22-text-200');await axe(viewer,'text 200 percent');await viewer.locator('#close-text').click();
  await settings(other);await other.locator('#mic-mode').selectOption('ptt');await closeSettings(other);
  await other.locator('#settings-dialog').waitFor({state:'hidden'});
  await other.locator('#toggle-mic').click();await pttSending(other,false);
  await other.bringToFront();
  await other.evaluate(()=>document.activeElement.blur());
  await other.keyboard.down('Space');await pttSending(other,true);
  const beforeRecoveryCaptures=await microphoneRequests(other);
  const beforeRecovery=await other.evaluate(()=>window.__lanScreenTest.incoming.filter(message=>message.type==='room.joined').length);
  await other.evaluate(()=>window.__lanScreenTest.sockets.findLast(socket=>new URL(socket.url).pathname==='/ws/v1'&&socket.readyState===WebSocket.OPEN).close());
  await pttSending(other,false);
  await other.waitForFunction(count=>window.__lanScreenTest.incoming.filter(message=>message.type==='room.joined').length>count,beforeRecovery);
  await other.locator('#connection-status').filter({hasText:'房间已恢复'}).waitFor();await capture(other,'23-local-recovered');await ax(other,'local connection recovered');await axe(other,'local connection recovered');
  await pttSending(other,false);await other.keyboard.up('Space');
  assert.equal(await microphoneRequests(other),beforeRecoveryCaptures);
  assert.equal(await host.locator('#topbar-room-count').textContent(),'3 人');
  assert.equal(await other.locator('#toggle-mic').getAttribute('aria-pressed'),'true');
  evidence.checks.push({check:'actual local socket loss releases held PTT and restores the seat in silence without recapture',passed:true});
  await other.reload();
  await other.locator('#connection-status').filter({hasText:'房间已恢复'}).waitFor();
  assert.equal(await microphoneRequests(other),0,'refresh and room restoration never request a microphone');
  await axe(other,'refreshed room restoration');
  await viewer.locator('#leave-room').click();await viewer.locator('body[data-stage="entry"]').waitFor();assert.equal(await viewer.locator('#text-log').textContent(),'','leaving clears local message history');
  await host.waitForFunction(()=>document.querySelector('#members .member-seat[data-seat="left"]')?.dataset.empty==='true'&&
    document.querySelector('#members .member-seat[data-seat="right"] > strong')?.textContent==='成员 2');
  evidence.checks.push({check:'the second guest retains the original seat and default name when the first guest leaves',passed:true});
  const profile=await createTestPreferences();testProfiles.push(profile);
  const persistence=await startOwnedService({lanIP,autoLAN:true,preferencesPath:profile.preferencesPath,signalPort:0});services.push(persistence);
  const freshContext=async (service, rotated=false)=>{
    const context=await browser.newContext({viewport:{width:390,height:844},colorScheme:'light',reducedMotion:'reduce'});contexts.push(context);
    monitorRequests(context);
    await context.addInitScript(installSyntheticMedia,{participantAlias:'host',
      microphones:rotated?microphones.map(device=>({...device,deviceId:'new-'+device.deviceId})):microphones,
      hideMicrophoneDevicesUntilCapture:rotated,
    });
    const page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(service.baseURL);
    await page.locator('#connection-status').filter({hasText:'已就绪'}).waitFor();
    await page.locator('#entry-identity').click();
    return page;
  };
  const editing=await freshContext(persistence);
  const alternate=availableLANIPv4s().find(ip=>ip!==persistence.bootstrap.lanIPv4);
  const chosen=alternate ?? persistence.bootstrap.lanIPv4;
  if(alternate){
    await editing.locator('#network-interface').selectOption(chosen);
    await editing.locator('#settings-toast').filter({hasText:'已切换局域网网卡'}).waitFor();
  } else {
    assert.equal(await editing.locator('#network-interface').isVisible(),false);
    // Exercise the picker on a one-adapter test machine. Only the bootstrap
    // roster is simulated, the browser posts the real adapter to the EXE.
    const inactive='172.31.250.250';
    await editing.route('**/api/v1/bootstrap',async route=>{
      const response=await route.fetch({headers:{...route.request().headers(),origin:persistence.baseURL}});
      const state=await response.json();
      const lanInterfaces=[...state.lanInterfaces.map(face=>({...face,active:false})),
        {name:'测试虚拟网卡',ipv4:inactive,virtual:true,recommended:false,active:true}];
      await route.fulfill({response,json:{...state,lanIPv4:inactive,lanInterfaces}});
    });
    await closeSettings(editing);
    await editing.locator('#entry-identity').click();
    await editing.locator('#network-note').filter({hasText:'虚拟网卡'}).waitFor();
    const switching=editing.waitForResponse(response=>response.url().endsWith('/api/v1/network')&&response.status()===200);
    const refresh=editing.waitForRequest(request=>request.url().endsWith('/api/v1/rooms'));
    await editing.locator('#network-interface').selectOption(chosen);
    const response=await switching;
    const network=await response.json();
    assert.equal(network.lanIPv4,chosen);
    assert.ok(network.signalPort>0);
    await refresh;
    await editing.locator('#settings-toast').filter({hasText:'已切换局域网网卡'}).waitFor();
    await editing.unroute('**/api/v1/bootstrap');
  }
  assert.equal(await editing.locator('#sound-effects').isChecked(),true);
  await editing.locator('#sound-effects').uncheck();
  await editing.locator('#quality-target').selectOption('720p30');
  await editing.locator('#mic-mode').selectOption('ptt');
  await editing.locator('#mic-device').selectOption('desk-mic');
  assert.equal(await microphoneRequests(editing),0);
  await editing.locator('#share-mode').selectOption('limited');
  await editing.locator('#pause-background-preview').uncheck();
  await editing.locator('#share-cursor').check();
  await editing.locator('#nickname').fill('  日落🌇  ');
  await editing.locator('input[value="orange"]').check();
  await editing.locator('#exit-program').click();
  await Promise.all([
    editing.waitForResponse(response=>response.url().endsWith('/api/v1/shutdown')&&response.status()===202),
    editing.locator('#confirm-accept').click(),
  ]);
  assert.equal((await persistence.shutdown()).exitCode,0);
  const reopened=await startOwnedService({lanIP,autoLAN:true,preferencesPath:profile.preferencesPath,signalPort:0,excludePort:persistence.port});services.push(reopened);
  assert.notEqual(reopened.port,persistence.port);
  assert.equal(reopened.bootstrap.lanIPv4,chosen);
  assert.equal(reopened.bootstrap.preferences.preferredLanIPv4,chosen);
  const persisted=await freshContext(reopened,true);
  assert.equal(await persisted.locator('#nickname').inputValue(),'日落🌇');
  assert.equal(await persisted.locator('input[value="orange"]').isChecked(),true);
  assert.equal(await persisted.locator('#quality-target').inputValue(),'720p30');
  assert.equal(await persisted.locator('#mic-mode').inputValue(),'ptt');
  assert.equal(await persisted.locator('#mic-device').inputValue(),'desk-mic');
  assert.equal(await persisted.locator('#mic-device option:checked').textContent(),'桌面麦克风');
  assert.equal(await microphoneRequests(persisted),0);
  assert.equal(await persisted.locator('#share-mode').inputValue(),'limited');
  assert.equal(await persisted.locator('#pause-background-preview').isChecked(),false);
  assert.equal(await persisted.locator('#share-cursor').isChecked(),true);
  assert.equal(await persisted.locator('#sound-effects').isChecked(),false);
  evidence.checks.push({check:'room chime switch defaults on and restores off after the executable restarts',passed:true});
  await noOverflow(persisted,'identity settings 390');await capture(persisted,'29-reopened-identity-light-390');await axe(persisted,'reopened identity and network light narrow');
  await persisted.locator('#test-mic').click();
  await persisted.waitForFunction(()=>document.querySelector('#mic-device').value==='new-desk-mic'&&document.querySelector('#mic-level').dataset.active==='true');
  assert.deepEqual(await microphoneState(persisted),[
    {enabled:true,readyState:'ended',device:'default',senders:0},
    {enabled:true,readyState:'live',device:'new-desk-mic',senders:0},
  ]);
  await axe(persisted,'reopened light voice trial');
  await closeSettings(persisted);
  await persisted.waitForFunction(()=>window.__lanScreenTest.sources.at(-1).track.readyState==='ended');
  evidence.checks.push({check:'executable exited and restarted on a different localhost port and browser context with identity, network, sharing and microphone preferences restored',passed:true,realAlternateLAN:!!alternate});
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  evidence.checks.push({check:'all core paths above',passed:true,realHardwareCapture:false});
  evidence.completed=true;
});
