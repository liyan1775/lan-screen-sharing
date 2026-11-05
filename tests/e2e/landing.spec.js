import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {startSitePreview} from '../../scripts/preview-site.mjs';

test('product introduction supports mobile, keyboard, comparison, reduced motion and accessible content', {timeout:90000},async t=>{
  assert.ok(process.env.LANSW_BROWSER_PATH,'provide an installed Chromium browser');
  const preview=await startSitePreview('website');
  const browser=await chromium.launch({headless:true,executablePath:process.env.LANSW_BROWSER_PATH});
  const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1});
  const errors=[],external=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(new URL(request.url()).origin!==preview.url)external.push(request.url());});
  t.after(async()=>{await browser.close();await preview.close();});
  const directory=path.resolve('.superpowers/sdd/lan-screen-sharing/build/landing-0.5.0');await mkdir(directory,{recursive:true});
  const evidence={completed:false,viewports:[],axe:[],errors,external};
  await page.goto(preview.url);await page.locator('h1').waitFor();
  assert.match(await page.title(),/LAN \/ 分享/);
  assert.equal(await page.locator('a[href*="releases/download/v0.5.0"]').count(),2);
  for(const tab of ['voice','text','screen']){await page.locator('#tab-'+tab).click();assert.equal(await page.locator('#panel-'+tab).isVisible(),true);assert.equal(await page.locator('[role="tabpanel"]:visible').count(),1);}
  await page.locator('#tab-screen').focus();await page.keyboard.press('ArrowRight');assert.equal(await page.locator('#tab-voice').evaluate(node=>document.activeElement===node),true);await page.keyboard.press('End');assert.equal(await page.locator('#panel-text').isVisible(),true);
  await page.locator('[data-compare="before"]').click();assert.equal(await page.locator('.encoder.duplicate').isVisible(),true);
  await page.locator('[data-compare="after"]').click();assert.equal(await page.locator('.encoder.duplicate').isVisible(),false);
  await page.locator('.faq details').first().locator('summary').click();assert.equal(await page.locator('.faq details').first().evaluate(node=>node.open),true);
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.addScriptTag({path:path.resolve('node_modules/axe-core/axe.min.js')});
  for(const [width,height] of [[1440,1000],[768,1024],[390,844],[320,720]]){
    await page.setViewportSize({width,height});await page.evaluate(()=>scrollTo(0,0));await page.waitForTimeout(200);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`no horizontal overflow at ${width}`);
    assert.ok(await page.locator('img').evaluateAll(images=>images.filter(image=>image.closest('[hidden]')===null).every(image=>image.complete&&image.naturalWidth>0)),'visible product assets load');
    await page.screenshot({path:path.join(directory,`${width}.png`),fullPage:true});
    const axe=await page.evaluate(async()=>{const result=await window.axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','best-practice']}});return{violations:result.violations.map(item=>({id:item.id,impact:item.impact,nodes:item.nodes.map(node=>({target:node.target,summary:node.failureSummary}))})),incomplete:result.incomplete.length};});
    evidence.viewports.push(width);evidence.axe.push({width,...axe});
    await writeFile(path.join(directory,'evidence.json'),JSON.stringify(evidence,null,2));
    assert.deepEqual(axe.violations,[],`accessibility at ${width}`);
  }
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  evidence.completed=true;await writeFile(path.join(directory,'evidence.json'),JSON.stringify(evidence,null,2));
  t.diagnostic('Product page checked at 1440 / 768 / 390 / 320 px; keyboard tabs, comparison, FAQ, reduced motion and axe passed.');
});
