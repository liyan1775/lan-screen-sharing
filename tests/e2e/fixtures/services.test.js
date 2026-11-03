import assert from 'node:assert/strict';
import test from 'node:test';
import { selectedLANIPv4, shutdownOwnedServices, startOwnedService } from './services.js';

test('three isolated EXE fixtures expose distinct local control tokens and shut down by owned token', async (t) => {
  const services = [];
  t.after(() => shutdownOwnedServices(services));
  const lanIP = selectedLANIPv4();
  for (let i = 0; i < 3; i += 1) services.push(await startOwnedService({ lanIP }));
  assert.equal(new Set(services.map((service) => service.port)).size, 3, 'each test role has its own localhost service port');
  assert.equal(new Set(services.map((service) => service.bootstrap.localControlToken)).size, 3, 'process shutdown tokens are distinct');
  assert.ok(services.every((service) => service.bootstrap.localControlToken && service.bootstrap.localControlToken !== service.bootstrap.hostControlToken));

  const results = await Promise.all(services.map((service) => service.shutdown()));
  assert.ok(results.every((result) => result.status === 202), `all service-owned shutdown POSTs must return 202: ${JSON.stringify(results)}`);
  assert.ok(results.every((result) => result.pid > 0 && result.exitCode === 0), `only the fixture child processes exit: ${JSON.stringify(results)}`);
});
