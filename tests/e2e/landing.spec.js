import assert from 'node:assert/strict';
import test from 'node:test';
import {checkLiquidGlass} from './fixtures/liquid-glass.js';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright-core';
import {startSitePreview} from '../../scripts/preview-site.mjs';

function samplePixels(canvas) {
  const sample = new OffscreenCanvas(72, 48).getContext('2d');
  sample.drawImage(canvas, 0, 0, 72, 48);
  return Array.from(sample.getImageData(0, 0, 72, 48).data);
}

async function privacyContrast(page) {
  const section=page.locator('#privacy');
  await section.scrollIntoViewIfNeeded();
  const text=await section.evaluate(async node=>{
    await document.fonts.ready;
    const bounds=node.getBoundingClientRect();
    return [...node.querySelectorAll('.connection-copy > *')].map(element=>{
      const range=document.createRange();
      range.selectNodeContents(element);
      return {
        color:getComputedStyle(element).color.match(/\d+/g).slice(0,3).map(Number),
        rects:[...range.getClientRects()].filter(rect=>rect.width&&rect.height).map(rect=>[
          Math.floor(rect.left-bounds.left),Math.floor(rect.top-bounds.top),Math.ceil(rect.width),Math.ceil(rect.height),
        ]),
      };
    });
  });
  const hideCopy=await page.addStyleTag({content:'.connection-copy { visibility: hidden; }'});
  const png=await section.screenshot({scale:'css'});
  await hideCopy.evaluate(node=>node.remove());
  return page.evaluate(async ({png,text})=>{
    const bytes=Uint8Array.from(atob(png),character=>character.charCodeAt(0));
    const image=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
    const context=new OffscreenCanvas(image.width,image.height).getContext('2d',{willReadFrequently:true});
    context.drawImage(image,0,0);image.close();
    const linear=Array.from({length:256},(_,value)=>value<=10?value/3294.6:((value/255+.055)/1.055)**2.4);
    const luminance=(red,green,blue)=>.2126*linear[red]+.7152*linear[green]+.0722*linear[blue];
    return text.map(({color,rects})=>{
      let brightest=0;
      for(const rect of rects){
        const pixels=context.getImageData(...rect).data;
        for(let offset=0;offset<pixels.length;offset+=4)brightest=Math.max(brightest,luminance(pixels[offset],pixels[offset+1],pixels[offset+2]));
      }
      return Number(((luminance(...color)+.05)/(brightest+.05)).toFixed(2));
    });
  },{png:png.toString('base64'),text});
}

test('offline Apple Pro landing: synchronized stage, keyboard, simulator and accessibility', {timeout:120000},async t=>{
  assert.ok(process.env.LANSW_BROWSER_PATH,'provide an installed Chromium browser');
  const preview=await startSitePreview('website');
  const browser=await chromium.launch({headless:true,executablePath:process.env.LANSW_BROWSER_PATH});
  const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1,reducedMotion:'reduce'});
  const errors=[],external=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  page.on('request',request=>{if(new URL(request.url()).origin!==preview.url)external.push(request.url());});
  t.after(async()=>{await browser.close();await preview.close();});
  const evidence={completed:false,browser:browser.version(),viewports:[],firstFoldAxe:[],axe:[],privacyContrast:[],errors,external};
  await page.goto(preview.url);await page.locator('h1').waitFor();
  const hero=page.locator('.hero');
  const settled=()=>page.waitForFunction(()=>document.querySelector('.hero').dataset.intro==='complete');
  const aura=page.locator('#heroAuraCanvas');
  await page.waitForFunction(()=>{
    const canvas=document.querySelector('#heroAuraCanvas');
    return canvas.width===canvas.clientWidth && canvas.height===canvas.clientHeight && canvas.width>=1440;
  });
  await settled();
  const auraFrame=await aura.evaluate(samplePixels);
  assert.ok(auraFrame.some((value,index)=>index%4===3&&value>20),'the optical rings actually paint the aura');
  await page.waitForFunction(previous=>{
    const canvas=document.querySelector('#heroAuraCanvas');
    const sample=new OffscreenCanvas(72,48).getContext('2d');
    sample.drawImage(canvas,0,0,72,48);
    return sample.getImageData(0,0,72,48).data.some((value,index)=>index%4===3&&Math.abs(value-previous[index])>2);
  },auraFrame);
  await page.locator('#heroReplay').click();
  assert.equal(await hero.getAttribute('data-intro'),'playing');
  assert.equal(await page.locator('.hero-stage').evaluate(node=>node.getAnimations().some(animation=>animation.animationName==='stage-rise')),true);
  assert.ok(await page.locator('.host-live').evaluate(node=>Number(getComputedStyle(node).opacity)<1));
  await settled();
  assert.equal(await page.locator('.host-live').evaluate(node=>getComputedStyle(node).opacity),'1');
  assert.deepEqual(await page.locator('.device-viewer .device-screen').evaluateAll(nodes=>nodes.map(node=>getComputedStyle(node).filter)),['none','none']);
  assert.ok(await page.locator('.beam-path').evaluateAll(paths=>paths.every(path=>path.getTotalLength()>40&&parseFloat(getComputedStyle(path).strokeDashoffset)===0)));
  const contrast=await page.evaluate(()=>{
    const tokens=getComputedStyle(document.documentElement);
    const luminance=token=>{
      const hex=tokens.getPropertyValue(token).trim()||token;
      const rgb=hex.slice(1).match(/../g).map(channel=>parseInt(channel,16)/255);
      const [r,g,b]=rgb.map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4);
      return .2126*r+.7152*g+.0722*b;
    };
    return Object.fromEntries([
      ['button','#ffffff','--accent'],['buttonHover','#ffffff','--accent-hover'],
      ['mutedOnPage','--text-3','--bg'],['mutedOnCard','--text-3','--surface'],
      ['linkOnPage','--accent-text','--bg'],['linkOnCard','--accent-text','--surface'],
    ].map(([name,foreground,background])=>[name,(luminance(foreground)+.05)/(luminance(background)+.05)]));
  });
  for(const [name,ratio] of Object.entries(contrast)) assert.ok(ratio>=4.5,`${name} contrast: ${ratio.toFixed(2)}:1`);
  evidence.paletteContrast=Object.fromEntries(Object.entries(contrast).map(([name,ratio])=>[name,Number(ratio.toFixed(2))]));
  evidence.intro={auraRenders:true,changesAcrossFrames:true,replayComplete:true,viewersLit:true,transmissionComplete:true};
  await page.addScriptTag({path:path.resolve('node_modules/axe-core/axe.min.js')});
  const audit=tags=>page.evaluate(async values=>{
    const result=await window.axe.run(document,{runOnly:{type:'tag',values}});
    const describe=items=>items.map(item=>({id:item.id,nodes:item.nodes.map(node=>({target:node.target,summary:node.failureSummary}))}));
    return {violations:describe(result.violations),incomplete:result.incomplete.map(item=>({id:item.id,targets:item.nodes.map(node=>node.target)}))};
  },tags);
  const firstFold=await audit(['wcag2aa']);
  evidence.firstFoldAxe.push({width:1440,...firstFold});
  assert.deepEqual(firstFold.violations,[],'first-fold contrast before any scroll');
  assert.equal(await page.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches),true);
  assert.match(await page.title(),/LAN \/ 分享 v1\.2\.0/);
  const release='https://github.com/liyan1775/lan-screen-sharing/releases';
  const downloadLinks=await page.locator('a[href*="/releases/download/"]').evaluateAll(links=>links.map(link=>link.href));
  const zip=`${release}/download/v1.2.0/lan-screen-sharing-1.2.0-windows-x64.zip`;
  assert.deepEqual(downloadLinks,[zip,zip]);
  assert.equal(await page.locator(`a[href="${release}/tag/v1.2.0"]`).count(),1);
  assert.match(await page.getByRole('row').filter({hasText:'视频画质目标'}).textContent(),/1080p60，码率上限 15 Mbps/);
  const refreshFAQ=page.locator('details').filter({hasText:'停止共享、短暂断线或刷新，会怎样？'});
  assert.match(await refreshFAQ.textContent(),/音量、静音.*原设备开启.*房内提示.*重新选择内容/);
  const screens=['heroHostCanvas','heroViewerACanvas','heroViewerBCanvas'];
  const snapshots=await page.evaluate(ids=>ids.map(id=>{
    const source=document.getElementById(id);
    const {width,height}=source;
    const pixels=source.getContext('2d').getImageData(0,0,width,height).data;
    const expected=new OffscreenCanvas(width,height).getContext('2d',{alpha:false});
    expected.drawImage(document.getElementById(ids[0]),0,0,width,height);
    const hostPixels=expected.getImageData(0,0,width,height).data;
    return {width,height,nonblank:pixels.some((value,index)=>index%4!==3&&value>130),
      meanError:pixels.reduce((total,value,index)=>total+Math.abs(value-hostPixels[index]),0)/pixels.length};
  }),screens);
  const motion=await page.evaluate(async()=>{
    const canvas=document.querySelector('#heroHostCanvas');
    const before=canvas.toDataURL();
    for(let frame=0;frame<12;frame++)await new Promise(requestAnimationFrame);
    return canvas.toDataURL()!==before;
  });
  assert.equal(motion,true,'hero keeps drawing with reduced motion');
  assert.ok(snapshots.every(frame=>frame.width>100&&frame.height>80&&frame.nonblank),'three nonblank canvases');
  for(const viewer of snapshots.slice(1)){
    assert.ok(viewer.meanError<.2,`viewer matches the host frame at the same pixel size (mean difference ${viewer.meanError.toFixed(2)})`);
  }
  const firstLine=page.locator('.story-line').first();
  const secondLine=page.locator('.story-line').last();
  assert.equal(await firstLine.evaluate(node=>node.classList.contains('lit')),false);
  await firstLine.evaluate(node=>scrollBy({top:node.getBoundingClientRect().top-innerHeight*.71,behavior:'instant'}));
  await page.waitForFunction(()=>document.querySelector('.story-line').classList.contains('lit'));
  assert.equal(await secondLine.evaluate(node=>node.classList.contains('lit')),false,'story illuminates one line at a time');
  await secondLine.evaluate(node=>scrollBy({top:node.getBoundingClientRect().top-innerHeight*.52,behavior:'instant'}));
  await page.waitForFunction(()=>document.querySelectorAll('.story-line.lit').length===2);
  assert.ok(Number(await page.locator('#heroShowcase').evaluate(node=>node.style.getPropertyValue('--stage-scale')))>1);
  for(const tab of ['voice','text','screen']){await page.locator('#tab-'+tab).click();assert.equal(await page.locator('#panel-'+tab).isVisible(),true);assert.equal(await page.locator('[role="tabpanel"]:visible').count(),1);}
  await page.locator('#tab-screen').focus();await page.keyboard.press('ArrowRight');assert.equal(await page.locator('#tab-voice').evaluate(node=>document.activeElement===node),true);await page.keyboard.press('End');assert.equal(await page.locator('#panel-text').isVisible(),true);
  await page.keyboard.press('Home');assert.equal(await page.locator('#panel-screen').isVisible(),true);
  await page.keyboard.press('ArrowLeft');assert.equal(await page.locator('#panel-text').isVisible(),true);
  await page.keyboard.press('Home');
  const stage=page.locator('.live-screen-stage');
  const galleryCanvas=stage.locator('canvas');
  const showGalleryStage=async()=>{
    await stage.waitFor();
    await stage.evaluate(async node=>{
      const ancestors=[node.closest('figure'),node.closest('.gallery')];
      await Promise.allSettled(ancestors.flatMap(element=>element.getAnimations()).map(animation=>animation.finished));
      node.scrollIntoView({block:'center',behavior:'instant'});
    });
    await page.waitForFunction(()=>!document.querySelector('.live-screen-stage').hasAttribute('data-paused'));
  };
  await showGalleryStage();
  const before=await galleryCanvas.evaluate(samplePixels);
  await galleryCanvas.evaluate(async()=>{for(let i=0;i<8;i++)await new Promise(requestAnimationFrame);});
  assert.notDeepEqual(await galleryCanvas.evaluate(samplePixels),before,'the shared desktop changes pixels across frames');
  await page.locator('#tab-voice').click();
  await page.waitForFunction(()=>document.querySelector('.live-screen-stage').hasAttribute('data-paused'));
  const hiddenFrame=await galleryCanvas.evaluate(samplePixels);
  await galleryCanvas.evaluate(async()=>{for(let i=0;i<8;i++)await new Promise(requestAnimationFrame);});
  assert.deepEqual(await galleryCanvas.evaluate(samplePixels),hiddenFrame,'the hidden gallery stops drawing');
  await page.locator('#tab-screen').click();
  await showGalleryStage();
  const zoomReset=page.locator('#galleryZoomReset');
  const waitForScale=scale=>page.waitForFunction(expected=>{
    const transform=getComputedStyle(document.querySelector('#galleryScreenCanvas')).transform;
    return new DOMMatrixReadOnly(transform==='none'?'':transform).a===expected;
  },scale);
  await page.locator('#galleryZoomIn').click();
  await waitForScale(1.5);
  assert.equal(await zoomReset.textContent(),'1.5×');
  await page.locator('#galleryZoomIn').click();
  await waitForScale(2);
  await page.locator('#galleryZoomOut').click();
  await waitForScale(1.5);
  await zoomReset.click();
  await waitForScale(1);
  await page.locator('#galleryReaction').click();
  await stage.locator('.screen-reactions span').filter({hasText:'👏'}).waitFor();
  const downloads=[];
  page.on('download',download=>downloads.push(download.suggestedFilename()));
  await page.locator('#galleryCapture').click();
  assert.equal(await stage.getByRole('status').textContent(),'已演示原画截屏');
  assert.equal(await stage.locator('.screen-flash').evaluate(node=>node.getAnimations().length),1);
  await stage.getByRole('button',{name:'画中画'}).click();
  assert.equal(await stage.getByRole('status').textContent(),'画中画可在房间内使用');
  await stage.getByRole('button',{name:'全屏观看'}).click();
  assert.equal(await stage.getByRole('status').textContent(),'全屏观看可在房间内使用');
  assert.deepEqual(downloads,[]);
  await stage.locator('.screen-reactions span').filter({hasText:'🔥'}).waitFor({timeout:7500});
  await page.locator('h1').scrollIntoViewIfNeeded();
  await page.waitForFunction(()=>document.querySelector('.live-screen-stage').hasAttribute('data-paused'));
  const offscreenFrame=await galleryCanvas.evaluate(samplePixels);
  await galleryCanvas.evaluate(async()=>{for(let i=0;i<8;i++)await new Promise(requestAnimationFrame);});
  assert.deepEqual(await galleryCanvas.evaluate(samplePixels),offscreenFrame,'the offscreen gallery stops drawing');
  evidence.gallery={changingPixels:true,pausedWhenHidden:true,pausedOffscreen:true,zoom:true,manualReaction:true,automaticReaction:true,captureWithoutDownload:true,toolTips:true};
  const clarity=page.locator('#compareBox');
  await clarity.scrollIntoViewIfNeeded();
  const overlay=page.locator('#compareOverlay');
  const clipPath=()=>overlay.evaluate(node=>getComputedStyle(node).clipPath);
  const initialClip=await clipPath();
  const box=await clarity.boundingBox();
  const middle=box.y+box.height/2;
  await page.mouse.move(box.x+box.width*.58,middle);await page.mouse.down();
  await page.mouse.move(box.x+box.width*.24,middle,{steps:8});await page.mouse.up();
  assert.notEqual(await clipPath(),initialClip);
  const handle=page.locator('#compareHandle');
  const dragged=Number(await handle.inputValue());
  assert.ok(dragged>=22&&dragged<=26);
  await handle.press('ArrowRight');assert.equal(Number(await handle.inputValue()),dragged+1);
  await page.locator('[data-clarity="light"]').click();assert.equal(await clarity.getAttribute('data-quality'),'light');
  await page.locator('[data-clarity="full"]').click();
  await handle.evaluate(node=>{node.value=58;node.dispatchEvent(new Event('input'));});
  await page.locator('.nav-links a[href="#performance"]').click();
  await page.waitForFunction(()=>document.querySelector('.nav-links [aria-current="location"]')?.hash==='#performance');
  await page.evaluate(()=>history.replaceState(null,'',location.pathname));
  const comparison=page.locator('.compare-toggle');
  await comparison.scrollIntoViewIfNeeded();
  const travel=await comparison.evaluate(control=>{
    const position=()=>parseFloat(getComputedStyle(control,'::before').translate);
    const from=position();
    control.querySelector('[data-compare=before]').click();
    position();
    const transition=document.getAnimations().find(animation=>animation.transitionProperty==='translate' &&
      (animation.effect.target===control || animation.effect.target?.element===control));
    transition.pause();
    transition.currentTime=95;
    const midway=position();
    transition.finish();
    return {from,midway,to:position()};
  });
  assert.equal(travel.from,100);
  assert.ok(travel.midway>0 && travel.midway<100,'the compare capsule travels between its two positions');
  assert.equal(travel.to,0);
  assert.equal(await page.locator('.encoder.duplicate').isVisible(),true);
  assert.equal(await page.locator('.compare-toggle').evaluate(node=>node.style.getPropertyValue('--compare-index')),'0');
  await page.waitForFunction(()=>parseFloat(getComputedStyle(document.querySelector('.compare-toggle'),'::before').translate)===0);
  await page.locator('[data-compare="after"]').click();assert.equal(await page.locator('.encoder.duplicate').isVisible(),false);
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('.compare-toggle'),'::before').translate==='100%');
  await page.locator('.flow').scrollIntoViewIfNeeded();
  await page.waitForFunction(()=>document.querySelector('.wires-after .flow-pulse').getAnimations().some(animation=>animation.playState==='running'&&animation.currentTime>0));
  assert.equal(await page.locator('.product-header').getAttribute('data-scrolled'),'true');
  const share=page.locator('#toggleShareBtn');
  await share.click();
  assert.equal(await share.textContent(),'停止共享');
  assert.equal(await page.locator('#hostStatusText').textContent(),'正在局域网共享');
  assert.equal(await page.locator('#receiverStandby').evaluate(node=>node.inert),true);
  assert.equal(await page.locator('#telEncoding').textContent(),'1 次复用');
  assert.equal(await page.locator('#telQuality').textContent(),'1080p · 60fps');
  assert.equal(await page.locator('#telConnection').textContent(),'局域网直连');
  await page.locator('[data-mode="720p30"]').click();
  assert.equal(await page.locator('#telQuality').textContent(),'720p · 30fps');
  await page.locator('#simSurface').click({position:{x:50,y:45}});
  await page.waitForFunction(()=>{
    const canvas=document.querySelector('#simReceiverCanvas');
    return getComputedStyle(canvas).opacity==='1'&&canvas.getContext('2d').getImageData(20,20,1,1).data[2]>20;
  });
  await page.context().grantPermissions(['clipboard-read','clipboard-write']);
  await page.locator('#copyInviteBtn').click();
  await page.waitForFunction(()=>document.querySelector('#copyInviteBtn').textContent==='已复制');
  assert.equal(await page.locator('#copyInviteBtn').textContent(),'已复制');
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'192.168.1.20:45678  房间码 ABCD2345');
  await share.click();
  assert.equal(await share.textContent(),'开始共享屏幕');
  assert.equal(await page.locator('#receiverStandby').evaluate(node=>node.inert),false);
  assert.equal(await page.locator('#telConnection').textContent(),'未连接');
  assert.equal(await page.locator('#telQuality').textContent(),'—');
  await page.locator('[data-mode="1080p60"]').click();
  const faq=page.locator('.faq details').first();
  const summary=faq.locator('summary');
  await summary.click();assert.equal(await faq.evaluate(node=>node.open),true);
  const answer=faq.locator('.faq-answer');
  assert.equal(await answer.evaluate(node=>node.getAnimations().length),1);
  await summary.press('Enter');
  assert.deepEqual(await faq.evaluate(node=>({
    open:node.open,
    inert:node.querySelector('.faq-answer').inert,
    animations:node.querySelector('.faq-answer').getAnimations().length
  })),{open:false,inert:true,animations:1});
  await summary.press('Enter');
  assert.equal(await faq.evaluate(node=>node.open),true,'reversing a closing animation immediately reopens the answer');
  await answer.evaluate(node=>node.getAnimations().forEach(animation=>animation.finish()));
  for(const opening of [false,true]){
    const heights=await faq.evaluate(node=>{
      node.querySelector('summary').click();
      const answer=node.querySelector('.faq-answer');
      const [animation]=answer.getAnimations();
      animation.pause();
      const sample=time=>{
        animation.currentTime=time;
        return answer.getBoundingClientRect().height;
      };
      const duration=animation.effect.getTiming().duration;
      return {open:node.open,from:sample(0),midway:sample(duration/2),to:sample(duration)};
    });
    assert.equal(heights.open,opening);
    assert.ok(opening ? heights.from<heights.midway&&heights.midway<heights.to
      : heights.from>heights.midway&&heights.midway>heights.to,'FAQ height transitions through an intermediate value');
    await answer.evaluate(node=>node.getAnimations().forEach(animation=>animation.finish()));
  }
  await page.locator('.connection-art').scrollIntoViewIfNeeded();
  await checkLiquidGlass(page, ['.product-header','.hero-version','.stage-status'], '.connection-art');
  evidence.liquidGlass={increasedContrast:true,reducedTransparency:true,privacyArtVisible:true};
  await page.emulateMedia({reducedMotion:'reduce'});
  evidence.motion={compareSegment:true,flowPulses:true,stickyHeader:true,faqOpenCloseReverse:true,animationsWithReducedMotion:true,heroCanvasSync:true,storyIllumination:true,clarityDragAndKeyboard:true,simulatorAndClipboard:true};
  await summary.press('Enter');
  for(const [width,height] of [[1440,1000],[768,1024],[390,844],[320,720]]){
    await page.setViewportSize({width,height});
    await page.reload();
    await page.addScriptTag({path:path.resolve('node_modules/axe-core/axe.min.js')});
    await settled();
    if(width!==1440){
      const topAudit=await audit(['wcag2aa']);
      evidence.firstFoldAxe.push({width,...topAudit});
      assert.deepEqual(topAudit.violations,[],`first-fold contrast at ${width}`);
    }
    // Audit bidirectional scroll reveals and then settle full-page reading state for axe/screenshots.
    for(const reveal of await page.locator('.reveal').all())await reveal.scrollIntoViewIfNeeded();
    await page.evaluate(()=>scrollTo({top:0,behavior:'instant'}));
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await settled();
    assert.equal(await page.locator('.story-line.lit').count(),0,`story lines dim back when scrolling to top at ${width}`);
    await page.evaluate(()=>document.documentElement.classList.add('capture-all-visible'));
    await page.locator('.reveal,.story-line').evaluateAll(nodes=>Promise.all(
      nodes.flatMap(node=>node.getAnimations()).map(animation=>animation.finished),
    ));
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth===innerWidth),`no horizontal overflow at ${width}`);
    assert.ok(await page.locator('img').evaluateAll(images=>images.filter(image=>image.closest('[hidden]')===null).every(image=>image.complete&&image.naturalWidth>0)),'visible product assets load');
    const layout=await stage.evaluate(node=>{
      const image=node.previousElementSibling.getBoundingClientRect();
      const frame=node.getBoundingClientRect();
      const imagePixel=(distance,actual,natural)=>Math.round(distance*natural/actual);
      const buttons=[...node.querySelectorAll('button')].map(button=>button.getBoundingClientRect());
      const signal=node.querySelector('.screen-signal').getBoundingClientRect();
      const tools=node.querySelector('.screen-tools').getBoundingClientRect();
      const dock=node.querySelector('.screen-dock').getBoundingClientRect();
      return {
        inset:[imagePixel(frame.top-image.top,image.height,1440),imagePixel(frame.left-image.left,image.width,2880),
          imagePixel(image.bottom-frame.bottom,image.height,1440),imagePixel(image.right-frame.right,image.width,2880)],
        controlsFit:buttons.every(button=>button.left>=frame.left&&button.right<=frame.right&&
          button.top>=frame.top&&button.bottom<=frame.bottom&&button.width>=24&&button.height>=24),
        groupsFit:signal.right<tools.left&&tools.bottom<dock.top,
      };
    });
    assert.ok(layout.inset.every((value,index)=>Math.abs(value-[134,46,26,46][index])<=1),`fits the original viewer border at ${width}`);
    assert.ok(layout.controlsFit&&layout.groupsFit,`the controls fit with 24px touch targets at ${width}`);
    const axe=await audit(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa','best-practice']);
    evidence.viewports.push(width);evidence.axe.push({width,...axe});
    const [label,heading,body]=await privacyContrast(page);
    evidence.privacyContrast.push({width,label,heading,body});
    assert.ok(Math.min(label,heading,body)>=7,`privacy cinema contrast at ${width}: ${label}, ${heading}, ${body} (minimum 7:1)`);
    assert.deepEqual(axe.violations,[],`accessibility at ${width}`);
    assert.deepEqual(errors,[],`page and console errors at ${width}`);
    assert.deepEqual(external,[],`external requests at ${width}`);
    const beamEnds=await page.locator('.beam-path').evaluateAll(paths=>paths.map((path,index)=>{
      const length=path.getTotalLength();
      const offset=parseFloat(getComputedStyle(path).strokeDashoffset);
      const end=path.getPointAtLength(length);
      const viewer=path.closest('.devices').querySelector(index===0?'.viewer-a':'.viewer-b');
      return length>16&&offset===0&&end.x>viewer.offsetLeft&&end.x<viewer.offsetLeft+viewer.offsetWidth&&
        end.y>viewer.offsetTop&&end.y<viewer.offsetTop+viewer.firstElementChild.offsetHeight;
    }));
    assert.deepEqual(beamEnds,[true,true],`both light paths reach their viewer at ${width}`);
    if(process.env.LANSW_CAPTURE_LANDING==='1'&&(width===1440||width===390)){
      await page.evaluate(()=>scrollTo({top:0,behavior:'instant'}));
      await page.waitForFunction(()=>document.querySelector('#heroShowcase').style.getPropertyValue('--stage-scale')==='1.0000');
      await page.waitForFunction(()=>parseFloat(document.querySelector('.beam-particle').style.opacity)>.5);
      const size=width===1440?'wide':'narrow';
      await page.screenshot({path:`docs/design-research/apple-upgrade/site-dark-${size}.png`,fullPage:true});
    }
  }
  const offline=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:2,hasTouch:true,offline:true});
  offline.on('pageerror',error=>errors.push(error.message));
  offline.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  offline.on('request',request=>{if(!request.url().startsWith('file:'))external.push(request.url());});
  await offline.goto(pathToFileURL(path.resolve('website/index.html')).href);
  await offline.waitForFunction(()=>{
    const canvas=document.querySelector('#heroHostCanvas');
    const aura=document.querySelector('#heroAuraCanvas');
    return Math.abs(canvas.width-canvas.clientWidth*2)<=2&&canvas.width>380&&aura.width===aura.clientWidth*2;
  });
  await offline.locator('.live-screen-stage').scrollIntoViewIfNeeded();
  await offline.waitForFunction(()=>{
    const canvas=document.querySelector('#galleryScreenCanvas');
    return !canvas.parentElement.hasAttribute('data-paused')&&Math.abs(canvas.width-canvas.clientWidth*2)<=2&&canvas.width>550;
  });
  await offline.locator('#galleryZoomIn').tap();
  assert.equal(await offline.locator('#galleryZoomReset').textContent(),'1.5×');
  await offline.locator('#tab-text').tap();
  await offline.locator('#panel-text img').evaluate(image=>image.decode());
  const touchSlider=offline.locator('#compareHandle');
  await touchSlider.scrollIntoViewIfNeeded();
  await offline.waitForFunction(()=>document.querySelector('#compareBox').closest('.reveal').classList.contains('is-visible'));
  await touchSlider.evaluate(node=>Promise.allSettled(node.closest('.reveal').getAnimations().map(animation=>animation.finished)));
  const touchBox=await touchSlider.boundingBox();
  const touch=await offline.context().newCDPSession(offline);
  const touchAt=percentage=>[{x:touchBox.x+touchBox.width*percentage,y:touchBox.y+touchBox.height/2}];
  await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:touchAt(.58)});
  await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:touchAt(.76)});
  await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  assert.ok(Math.abs(Number(await touchSlider.inputValue())-76)<=2,'touch drag works in the offline file preview');
  await touch.detach();
  await offline.close();
  evidence.offlineFile={gallery:true,hiDPI:true,touchZoom:true,touchDrag:true};
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  evidence.completed=true;
  const summarizeAudits=results=>results.map(({width,violations,incomplete})=>({
    width, violations:violations.length, manualReview:incomplete.map(({id})=>id),
  }));
  t.diagnostic(JSON.stringify({...evidence,firstFoldAxe:summarizeAudits(evidence.firstFoldAxe),axe:summarizeAudits(evidence.axe)}));
  t.diagnostic('1440 / 768 / 390 / 320 px: axe, zero overflow/errors/external requests, synchronized Canvas and accessible controls.');
});
