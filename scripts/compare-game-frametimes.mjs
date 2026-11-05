import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function parseCSV(text) {
  const records = [];
  let row = [], value = '', quoted = false;
  const input = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === '"') {
      if (quoted && input[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) { row.push(value); value = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      row.push(value); if (row.some(field => field !== '')) records.push(row);
      row = []; value = ''; if (char === '\r' && input[i + 1] === '\n') i++;
    } else value += char;
  }
  if (quoted) throw new Error('CSV has an unterminated quoted field');
  row.push(value); if (row.some(field => field !== '')) records.push(row);
  if (records.length < 2) throw new Error('CSV contains no frame records');
  const headers = records.shift().map(header => header.trim().toLowerCase());
  if (new Set(headers).size !== headers.length) throw new Error('CSV contains duplicate column names');
  return records.map((fields, index) => {
    if (fields.length !== headers.length) throw new Error(`CSV row ${index + 2} has the wrong number of fields`);
    return Object.fromEntries(headers.map((header, i) => [header, fields[i]]));
  });
}

export function summarizeFrames(csv, { processName, processId, swapChain, metric, minSeconds = 60, minFrames = 1000 } = {}) {
  const records = parseCSV(csv);
  const columns = Object.keys(records[0]);
  const chosenMetric = metric?.toLowerCase() ?? ['msbetweenpresents', 'cpuframetime', 'frametime'].find(key => columns.includes(key));
  if (!chosenMetric || !columns.includes(chosenMetric)) throw new Error('CSV lacks a supported frame-time column (MsBetweenPresents / CPUFrameTime / FrameTime)');
  if (!columns.includes('application') || !columns.includes('processid') || !columns.includes('swapchainaddress')) throw new Error('CSV must identify application, ProcessID and SwapChainAddress');
  const selected = records.filter(row => (!processName || row.application.toLowerCase() === processName.toLowerCase())
    && (processId == null || row.processid === String(processId))
    && (!swapChain || row.swapchainaddress.toLowerCase() === swapChain.toLowerCase()));
  if (!selected.length) throw new Error('No frames match the requested game process');
  const streams = new Set(selected.map(row => JSON.stringify([row.application.toLowerCase(), row.processid, row.swapchainaddress.toLowerCase()])));
  if (streams.size !== 1) throw new Error('Multiple processes or swap chains are present; select --process, --pid and/or --swapchain explicitly');
  const times = [];
  let unavailableBoundaryFrames = 0;
  for (const [index, row] of selected.entries()) {
    const text = row[chosenMetric].trim();
    const milliseconds = text && text !== 'NA' ? Number(text) : NaN;
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
      if ((index === 0 || index === selected.length - 1) && (text === 'NA' || text === '' || milliseconds === 0)) { unavailableBoundaryFrames++; continue; }
      throw new Error(`Frame ${index + 1} has an invalid or missing frame time; cannot discard it and claim low FPS passed`);
    }
    // Keep every positive interval, including very long stalls and dropped presents.
    times.push(milliseconds);
  }
  const total = times.reduce((sum, time) => sum + time, 0), seconds = total / 1000;
  if (times.length < minFrames || seconds < minSeconds) throw new Error(`Recording too short: ${times.length} frames / ${seconds.toFixed(1)} seconds; need ${minFrames} frames and ${minSeconds} seconds`);
  const sorted = [...times].sort((a, b) => a - b);
  const percentile = fraction => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
  const low = fraction => {
    const count = Math.ceil(sorted.length * fraction), tail = sorted.slice(-count);
    return 1000 / (tail.reduce((sum, time) => sum + time, 0) / count);
  };
  return { application: selected[0].application, processId: selected[0].processid, swapChain: selected[0].swapchainaddress,
    metric: chosenMetric, frames: times.length, seconds, unavailableBoundaryFrames,
    averageFps: times.length * 1000 / total, onePercentLowFps: low(0.01), pointOnePercentLowFps: low(0.001),
    p99FrameTimeMs: percentile(0.99), p999FrameTimeMs: percentile(0.999), maxFrameTimeMs: sorted.at(-1),
    framesOver33ms: times.filter(time => time > 33.333).length, framesOver50ms: times.filter(time => time > 50).length,
  };
}

export function compareRuns(baseline, streaming, { tolerancePercent = 0, minPairs = 3 } = {}) {
  if (!Number.isFinite(tolerancePercent) || tolerancePercent < 0 || tolerancePercent > 20) throw new Error('Tolerance must be between 0 and 20 percent');
  if (baseline.length !== streaming.length || baseline.length < minPairs) throw new Error(`Provide at least ${minPairs} matched baseline / streaming pairs`);
  const pairs = baseline.map((before, index) => {
    const after = streaming[index];
    if (before.application.toLowerCase() !== after.application.toLowerCase() || before.metric !== after.metric) throw new Error('Each pair must measure the same game and frame-time metric');
    if (Math.abs(after.seconds / before.seconds - 1) > 0.1) throw new Error('Paired recordings must have durations within 10 percent');
    const change = key => (after[key] / before[key] - 1) * 100;
    const delta = { onePercentLow: change('onePercentLowFps'), pointOnePercentLow: change('pointOnePercentLowFps'), p99FrameTime: change('p99FrameTimeMs'), p999FrameTime: change('p999FrameTimeMs') };
    const passes = delta.onePercentLow >= -tolerancePercent - 1e-9 && delta.pointOnePercentLow >= -tolerancePercent - 1e-9
      && delta.p99FrameTime <= tolerancePercent + 1e-9 && delta.p999FrameTime <= tolerancePercent + 1e-9;
    return { pair: index + 1, passes, changePercent: delta, baseline: before, streaming: after };
  });
  return { status: pairs.every(pair => pair.passes) ? 'pass' : 'regression', tolerancePercent,
    scope: 'Only these recorded runs; verify identical game scene, resolution, FPS cap, power mode and viewer devices. Not a guarantee for other games or hardware.',
    lowDefinition: '1000 / arithmetic mean of the slowest ceil(N × 1%) or ceil(N × 0.1%) frame times; no long-frame outlier removal', pairs };
}

async function main(args) {
  const options = { baseline: [], stream: [] };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, ''), value = args[i + 1];
    if (!['baseline', 'stream', 'process', 'pid', 'swapchain', 'metric', 'tolerance-percent', 'output'].includes(key) || value == null) throw new Error('Usage: node scripts/compare-game-frametimes.mjs --baseline A1.csv --stream B1.csv (repeat for 3 pairs) [--process game.exe] [--output report.json]');
    if (key === 'baseline' || key === 'stream') options[key].push(value);
    else options[key] = value;
  }
  async function load(file) {
    const data = await readFile(file);
    return { file: resolve(file), sha256: createHash('sha256').update(data).digest('hex'),
      ...summarizeFrames(data.toString('utf8'), { processName: options.process, processId: options.pid, swapChain: options.swapchain, metric: options.metric }) };
  }
  const [baseline, streaming] = await Promise.all([Promise.all(options.baseline.map(load)), Promise.all(options.stream.map(load))]);
  const report = compareRuns(baseline, streaming, { tolerancePercent: options['tolerance-percent'] == null ? 0 : Number(options['tolerance-percent']) });
  if (options.output) await writeFile(options.output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'pass') process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 3; });
}
