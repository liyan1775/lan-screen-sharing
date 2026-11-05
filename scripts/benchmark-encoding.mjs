// Controlled same-quality encoding comparison. This is a synthetic workload,
// not a measurement of a game's 1% low. The viewer browser is outside sender CPU totals.
import { chromium } from 'playwright-core';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startOwnedService, shutdownOwnedServices } from '../tests/e2e/fixtures/services.js';
import { installSyntheticMedia } from '../tests/e2e/fixtures/synthetic-media.js';

const options = {};
for (let i = 2; i < process.argv.length; i += 2) options[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
if (!options.baseline || !options.candidate || !options.browser || !options.output) throw new Error('Provide --baseline exe --candidate exe --browser exe --output report.json [--seconds 20] [--pairs 2]');
const seconds = Number(options.seconds ?? 20), pairs = Number(options.pairs ?? 2);
if (!Number.isInteger(seconds) || seconds < 10 || seconds > 120 || !Number.isInteger(pairs) || pairs < 1 || pairs > 5) throw new Error('Use 10–120 seconds and 1–5 pairs');

async function appCPU(pid) {
  if (!Number.isInteger(pid) || pid < 1) throw new Error('Expected owned service PID');
  const {stdout} = await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$sampleProcess = Get-Process -Id ${pid}; [pscustomobject]@{cpuSeconds=$sampleProcess.TotalProcessorTime.TotalSeconds; workingSetBytes=$sampleProcess.WorkingSet64; privateBytes=$sampleProcess.PrivateMemorySize64} | ConvertTo-Json -Compress`],{windowsHide:true});
  return {...JSON.parse(stdout),observedAt:performance.now()};
}

async function run(label, executablePath) {
  const startedAtUTC = new Date().toISOString();
  const services = [], browsers = [];
  try {
    const senderBrowser = await chromium.launch({ executablePath: options.browser, headless: true, args: ['--mute-audio'] });
    browsers.push(senderBrowser);
    const receiverBrowser = await chromium.launch({ executablePath: options.browser, headless: true, args: ['--mute-audio'] });
    browsers.push(receiverBrowser);
    const session = await senderBrowser.newBrowserCDPSession();
    const pages = [];
    for (let i = 0; i < 3; i++) {
      const service = await startOwnedService({ executablePath }); services.push(service);
      const context = await (i ? receiverBrowser : senderBrowser).newContext();
      await context.addInitScript(installSyntheticMedia, { captureWidth: 1920, captureHeight: 1080, captureFps: 60, participantAlias: i ? `viewer-${i}` : 'host' });
      const page = await context.newPage(); pages.push(page); await page.goto(service.baseURL);
      await page.waitForFunction(() => document.querySelector('#connection-status').textContent.includes('就绪'));
    }
    const [host, ...viewers] = pages;
    const relayEnabled = await host.evaluate(async () => (await (await fetch('/api/v1/bootstrap')).json()).screenRelay === true);
    await host.locator('#quick-create-room').click(); await host.locator('#create-room').click();
    await host.locator('#invite-room').click(); const invite = await host.locator('#invite-text').inputValue();
    await host.locator('#invite-dialog [data-close-dialog]').click();
    for (const page of viewers) {
      await page.locator('#quick-manual-join').click(); await page.locator('#join-invite').fill(invite); await page.locator('#join-room').click();
    }
    await Promise.all(pages.map(page => page.waitForFunction(() => window.__lanScreenTest.pcs.length === 2 && window.__lanScreenTest.pcs.every(pc => pc.connectionState === 'connected'))));
    await host.locator('#start-share').click();
    await Promise.all(viewers.map(page => page.waitForFunction(() => document.querySelector('#remote-screen').videoWidth === 1920)));
    await host.evaluate(() => { Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false }); window.dispatchEvent(new Event('blur')); });
    async function videoStats() {
      return host.evaluate(async () => {
        const rows = [];
        for (const [pcId, pc] of window.__lanScreenTest.pcs.entries()) {
          const reports = await pc.getStats();
          for (const report of reports.values()) if (report.type === 'outbound-rtp' && report.kind === 'video' && report.framesEncoded > 0) {
            const codec = reports.get(report.codecId), sender = pc.getSenders().find(item => item.track?.kind === 'video');
            rows.push({ key: `${pcId}:${report.id}`, codec: codec?.mimeType, fmtp: codec?.sdpFmtpLine, frames: report.framesEncoded,
              timestamp: report.timestamp, bytes:report.bytesSent, qpSum:report.qpSum ?? null,
              totalEncodeTime: report.totalEncodeTime, width: report.frameWidth, height: report.frameHeight,
              qualityLimitationReason: report.qualityLimitationReason, resolutionChanges:report.qualityLimitationResolutionChanges ?? null,
              efficientEncoder: report.powerEfficientEncoder ?? null, parameters: sender?.getParameters().encodings[0] });
          }
        }
        return rows;
      });
    }
    async function receiverStats() {
      return Promise.all(viewers.map(page=>page.evaluate(async()=>{
        for(const pc of window.__lanScreenTest.pcs) for(const report of (await pc.getStats()).values()) if(report.type==='inbound-rtp' && report.kind==='video' && report.framesDecoded>0) return {frames:report.framesDecoded,timestamp:report.timestamp,width:report.frameWidth,height:report.frameHeight};
        return null;
      })));
    }
    await new Promise(done => setTimeout(done, 5000));
    const appBefore = await appCPU(services[0].child.pid);
    const before = await videoStats(), receiversBefore = await receiverStats();
    const cpuBefore = await session.send('SystemInfo.getProcessInfo'), started = performance.now();
    await new Promise(done => setTimeout(done, seconds * 1000));
    const cpuAfter = await session.send('SystemInfo.getProcessInfo'), elapsed = (performance.now() - started) / 1000;
    const after = await videoStats();
    const receiversAfter = await receiverStats(), appAfter = await appCPU(services[0].child.pid);
    const cpu = cpuAfter.processInfo.map(process => ({ type: process.type, seconds: process.cpuTime - (cpuBefore.processInfo.find(item => item.id === process.id)?.cpuTime ?? 0) }));
    const rows = after.map(row => {
      const previous = before.find(item => item.key === row.key);
      const frames = row.frames - (previous?.frames ?? row.frames), encodeSeconds = row.totalEncodeTime - (previous?.totalEncodeTime ?? row.totalEncodeTime);
      const interval = previous ? (row.timestamp-previous.timestamp)/1000 : elapsed;
      return { ...row, intervalFrames: frames, intervalFps: frames / interval,
        intervalBitrate:(row.bytes-(previous?.bytes ?? row.bytes))*8/interval,
        intervalAverageQP:frames>0 && Number.isFinite(row.qpSum) && Number.isFinite(previous?.qpSum) ? (row.qpSum-previous.qpSum)/frames : null,
        unchangedResolution:previous?.width===1920 && previous.height===1080 && row.resolutionChanges!==null && row.resolutionChanges===previous.resolutionChanges,
        intervalEncodeMs: frames > 0 ? encodeSeconds * 1000 / frames : null };
    });
    const receivers = receiversAfter.map((row,i) => row && receiversBefore[i] ? {...row,intervalFps:(row.frames-receiversBefore[i].frames)*1000/(row.timestamp-receiversBefore[i].timestamp)} : null);
    const qualityPassed = rows.length === (relayEnabled ? 1 : 2) && rows.every(row => row.width === 1920 && row.height === 1080 && row.unchangedResolution && row.parameters.maxFramerate === 60 && row.parameters.maxBitrate === 8_000_000 && row.intervalFps >= 57)
      && receivers.every(row=>row && row.width===1920 && row.height===1080 && row.intervalFps>=57);
    const browserCPUSeconds = cpu.reduce((sum, process) => sum + process.seconds, 0);
    const appSeconds = appAfter.cpuSeconds-appBefore.cpuSeconds, appElapsed = (appAfter.observedAt-appBefore.observedAt)/1000;
    const sessionState = await Promise.all(pages.map(page=>page.evaluate(()=>({
      stage:document.querySelector('#app').dataset.stage,
      error:document.querySelector('#error-message').textContent,
      connections:window.__lanScreenTest.pcs.map(pc=>({state:pc.connectionState,tracks:pc.getSenders().map(sender=>sender.track?{kind:sender.track.kind,state:sender.track.readyState}:null)})),
      pageErrors:window.__lanScreenTest.network.pageErrors,httpErrors:window.__lanScreenTest.network.httpErrors,
      recentRoomEvents:window.__lanScreenTest.incoming.filter(message=>['room.ended','peer.left','peer.state','error'].includes(message.type)).slice(-5).map(message=>({type:message.type,code:message.payload?.code,reason:message.payload?.reason})),
    }))));
    const result = { label, startedAtUTC, browserVersion:senderBrowser.version(), relayEnabled, elapsedSeconds: elapsed, cpuSeconds: browserCPUSeconds, cpuByProcessType: cpu,
      appCPUSeconds:appSeconds, appElapsedSeconds:appElapsed, appWorkingSetBytes:appAfter.workingSetBytes,
      totalCPUEquivalentCores:browserCPUSeconds/elapsed+appSeconds/appElapsed, receivers,sessionState,serviceExitCodes:services.map(service=>service.child.exitCode),
      videoBefore:before,receiversBefore,
      activeSenderPreview: await host.locator('#remote-screen').evaluate(video => !!video.srcObject && !video.paused), qualityPassed, rows };
    console.log(JSON.stringify({label,qualityPassed,cpuEquivalentCores:result.totalCPUEquivalentCores,
      encoders:rows.map(row=>({width:row.width,height:row.height,fps:row.intervalFps,bitrate:row.intervalBitrate,averageQP:row.intervalAverageQP,unchangedResolution:row.unchangedResolution})),
      receivers,serviceExitCodes:result.serviceExitCodes,errors:sessionState.map(state=>state.error)}));
    return result;
  } finally {
    await Promise.allSettled(browsers.map(browser => browser.close()));
    await shutdownOwnedServices(services);
  }
}

const report = { scope: 'Same-machine headless Edge; synthetic 1920×1080 60 FPS source; two receivers in a separate browser process; simulated game focus. Not a real game or physical screen capture benchmark.',
  cpu: os.cpus()[0]?.model, logicalProcessors: os.cpus().length, requestedQuality: { width: 1920, height: 1080, fps: 60, bitratePerReceiver: 8_000_000 },
  cpuScope:'Sender browser processes plus sender-owned Go service. Viewer browser CPU excluded. Process CPU sampling helpers run only at boundaries, outside the product.',
  builds: {}, runs: [] };
for (const label of ['baseline', 'candidate']) report.builds[label] = { path: resolve(options[label]), sha256: createHash('sha256').update(await readFile(options[label])).digest('hex') };
for (let i = 0; i < pairs; i++) for (const label of i % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
  report.runs.push(await run(label, options[label]));
  await writeFile(options.output, JSON.stringify(report, null, 2) + '\n');
}
const baselines = report.runs.filter(run => run.label === 'baseline'), candidates = report.runs.filter(run => run.label === 'candidate');
report.qualityGate = { passed: report.runs.every(run => run.qualityPassed) && candidates.every((run, index) => run.receivers.every((row, stream) => row.intervalFps >= baselines[index].receivers[stream].intervalFps * 0.98)),
  criteria: 'Actual 1920×1080 at both boundaries without quality-driven resolution changes, unchanged 60 FPS / 8 Mbps targets, >=57 measured FPS per stream, candidate decode rate no more than 2% below its paired baseline. This is synthetic frame-rate tolerance, not a game low-FPS tolerance.' };
await writeFile(options.output, JSON.stringify(report, null, 2) + '\n');
if (!report.qualityGate.passed) process.exitCode = 2;
