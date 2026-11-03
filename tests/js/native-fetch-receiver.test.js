import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomClient } from '../../internal/web/assets/client.js';

class FakeWebSocket {
  static OPEN = 1;
  static instances = [];
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeWebSocket.instances.push(this); }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  respond(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}

function installWindowFetchReceiverCheck(t) {
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  const calls = [];
  globalThis.location = { protocol: 'http:', host: 'localhost:59818', href: 'http://localhost:59818/' };
  globalThis.fetch = function browserBrandCheckedFetch(input) {
    if (this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    const url = new URL(input);
    calls.push(`${url.pathname}${url.search}`);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({
        serviceId: 'service-fixture',
        localWsPath: '/ws/v1',
        roleOptions: ['host', 'viewer'],
        localControlToken: 'local-control-fixture',
        ...(url.searchParams.get('role') === 'host' ? { hostControlToken: 'host-control-fixture' } : {}),
      }),
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
  });
  return calls;
}

test('default browser fetch receiver works for local-control bootstrap', async (t) => {
  const calls = installWindowFetchReceiverCheck(t);
  const client = new RoomClient();
  t.after(() => client.close());

  await client.loadLocalControl();

  assert.deepEqual(calls, ['/api/v1/bootstrap']);
  assert.equal(client.bootstrap.localControlToken, 'local-control-fixture');
});

test('default browser fetch receiver works while connecting as a viewer', async (t) => {
  const calls = installWindowFetchReceiverCheck(t);
  FakeWebSocket.instances = [];
  const client = new RoomClient({ WebSocketImpl: FakeWebSocket });
  t.after(() => client.close());

  const opening = client.connect({ role: 'viewer' });
  await new Promise((resolve) => setImmediate(resolve));
  const socket = FakeWebSocket.instances[0];
  socket.open();
  const hello = socket.sent[0];
  socket.respond({ v: 1, type: 'room.state', requestId: hello.requestId, payload: { members: [], screenSharing: false } });
  await opening;

  assert.deepEqual(calls, ['/api/v1/bootstrap']);
  assert.equal(socket.url, 'ws://localhost:59818/ws/v1');
  assert.deepEqual(hello.payload, { role: 'viewer' });
});

test('default browser fetch receiver works while refreshing host bootstrap', async (t) => {
  const calls = installWindowFetchReceiverCheck(t);
  const client = new RoomClient();

  await client.refreshBootstrap('host');

  assert.deepEqual(calls, ['/api/v1/bootstrap?role=host']);
  assert.equal(client.bootstrap.hostControlToken, 'host-control-fixture');
});
