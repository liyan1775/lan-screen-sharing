import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rmdir, unlink } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function isPrivateIPv4(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168);
}

export function selectedLANIPv4(explicit = process.env.LANSW_LAN_IP) {
  if (explicit) {
    if (!isPrivateIPv4(explicit)) throw new Error('LANSW_LAN_IP must be an RFC1918 IPv4 address.');
    return explicit;
  }
  const [address] = availableLANIPv4s();
  if (address) return address;
  throw new Error('No RFC1918 IPv4 address found; set LANSW_LAN_IP for the isolated test services.');
}

export function availableLANIPv4s() {
  return [...new Set(Object.values(os.networkInterfaces()).flatMap(addresses => (addresses ?? [])
    .filter(address => address.family === 'IPv4' && !address.internal && isPrivateIPv4(address.address))
    .map(address => address.address)))];
}

export async function createTestPreferences() {
  const testRoot = path.join(projectRoot, '.superpowers', 'sdd', 'lan-screen-sharing', 'build');
  await mkdir(testRoot, {recursive: true});
  const dir = await mkdtemp(path.join(testRoot, 'test-preferences-'));
  const preferencesPath = path.join(dir, 'preferences.json');
  return {preferencesPath, async cleanup() {
    try { await unlink(preferencesPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rmdir(dir);
  }};
}

async function availablePort(host) {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, host, resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForBootstrap(baseURL, child, log) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Test-owned service exited (${child.exitCode}): ${log.join('')}`);
    try {
      const response = await fetch(`${baseURL}/api/v1/bootstrap`, { headers: { Origin: baseURL } });
      if (response.ok) {
        const bootstrap = await response.json();
        if (bootstrap.localControlToken) return bootstrap;
      }
    } catch { /* service is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for the test-owned service bootstrap: ${log.join('')}`);
}

export async function startOwnedService({ lanIP = selectedLANIPv4(), autoLAN = false, signalPort, executablePath, preferencesPath, excludePort } = {}) {
  const exePath = path.resolve(executablePath ?? process.env.LANSW_EXE ?? path.join(projectRoot, 'dist', '局域网屏幕共享.exe'));
  let port;
  do { port = await availablePort('127.0.0.1'); } while (port === excludePort);
  const args = ['--open-browser=false', `--port=${port}`, ...(!autoLAN ? [`--lan-ip=${lanIP}`] : []), `--signal-port=${signalPort ?? await availablePort(lanIP)}`];
  const ownPreferences = preferencesPath ? null : await createTestPreferences();
  const child = spawn(exePath, args, { cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, LANSW_PREFERENCES_PATH: preferencesPath ?? ownPreferences.preferencesPath} });
  const exited = new Promise(resolve => {
    child.once('exit', resolve);
    child.once('error', () => resolve(null));
  });
  const log = [];
  child.on('error', error => log.push(error.message));
  child.stdout.setEncoding('utf8').on('data', (chunk) => log.push(chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk) => log.push(chunk));
  const baseURL = `http://localhost:${port}`;
  let bootstrap;
  try {
    bootstrap = await waitForBootstrap(baseURL, child, log);
  } catch (error) {
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 3000))]);
      if (child.exitCode === null) child.kill();
    }
    await ownPreferences?.cleanup();
    throw error;
  }
  let stopped = false;
  return {
    child, baseURL, bootstrap, port, signalPort: args.at(-1).slice('--signal-port='.length),
    async shutdown() {
      if (stopped) return { status: 202, exitCode: child.exitCode, pid: child.pid };
      stopped = true;
      let status = child.exitCode === 0 ? 202 : 0;
      if (child.exitCode === null) {
        try {
          const response = await fetch(`${baseURL}/api/v1/shutdown`, {
            method: 'POST', signal: AbortSignal.timeout(1500),
            headers: { Origin: baseURL, 'X-Local-Control-Token': bootstrap.localControlToken },
          });
          status = response.status;
        } catch { /* exact child PID below is the only fallback target */ }
        const finished = await Promise.race([exited.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 3000))]);
        if (!finished && child.exitCode === null) {
          child.kill();
          await exited;
        }
      }
      await ownPreferences?.cleanup();
      return { status, exitCode: child.exitCode, pid: child.pid };
    },
  };
}

export async function shutdownOwnedServices(services) {
  await Promise.allSettled([...services].reverse().map((service) => service.shutdown()));
}

export function projectDirectory() { return projectRoot; }
