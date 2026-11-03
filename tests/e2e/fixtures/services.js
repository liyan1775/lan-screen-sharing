import { spawn } from 'node:child_process';
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
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) if (address.family === 'IPv4' && !address.internal && isPrivateIPv4(address.address)) return address.address;
  }
  throw new Error('No RFC1918 IPv4 address found; set LANSW_LAN_IP for the isolated test services.');
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

export async function startOwnedService({ lanIP, signalPort, executablePath } = {}) {
  const exePath = path.resolve(executablePath ?? process.env.LANSW_EXE ?? path.join(projectRoot, 'dist', '局域网屏幕共享.exe'));
  const port = await availablePort('127.0.0.1');
  const args = ['--open-browser=false', `--port=${port}`, `--lan-ip=${lanIP ?? selectedLANIPv4()}`, `--signal-port=${signalPort ?? await availablePort(lanIP ?? selectedLANIPv4())}`];
  const child = spawn(exePath, args, { cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
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
    throw error;
  }
  let stopped = false;
  return {
    child, baseURL, bootstrap, port, signalPort: args.at(-1).slice('--signal-port='.length),
    async shutdown() {
      if (stopped) return { status: 202, exitCode: child.exitCode, pid: child.pid };
      stopped = true;
      let status = 0;
      try {
        const response = await fetch(`${baseURL}/api/v1/shutdown`, {
          method: 'POST',
          headers: { Origin: baseURL, 'X-Local-Control-Token': bootstrap.localControlToken },
        });
        status = response.status;
      } catch { /* exact child PID below is the only fallback target */ }
      const exited = await Promise.race([
        new Promise((resolve) => child.once('exit', () => resolve(true))),
        new Promise((resolve) => setTimeout(() => resolve(false), 3000)),
      ]);
      if (!exited && child.exitCode === null) child.kill();
      return { status, exitCode: child.exitCode, pid: child.pid };
    },
  };
}

export async function shutdownOwnedServices(services) {
  await Promise.allSettled([...services].reverse().map((service) => service.shutdown()));
}

export function projectDirectory() { return projectRoot; }
