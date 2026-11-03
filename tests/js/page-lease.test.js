import test from 'node:test';
import assert from 'node:assert/strict';
import { PageLease } from '../../internal/web/assets/page-lease.js';

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];
  constructor(url) { this.url = url; this.readyState = FakeWebSocket.CONNECTING; this.sent = []; this.closeCount = 0; FakeWebSocket.instances.push(this); }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  close() { this.readyState = FakeWebSocket.CLOSED; this.closeCount += 1; this.onclose?.(); }
}

function leaseHarness(fetchImpl) {
  const calls = [];
  let beat;
  let cleared = false;
  FakeWebSocket.instances = [];
  const lease = new PageLease({
    pageId: 'page-unique-1',
    token: 'local-secret',
    WebSocketImpl: FakeWebSocket,
    locationRef: { protocol: 'http:', host: 'localhost:41000' },
    fetchImpl: async (url, options) => { calls.push({ url: new URL(url, 'http://localhost:41000'), options }); return fetchImpl ? fetchImpl(url, options) : { ok: true }; },
    setIntervalImpl: (callback, ms) => { beat = callback; assert.equal(ms, 2000); return 7; },
    clearIntervalImpl: (id) => { assert.equal(id, 7); cleared = true; },
  });
  return { lease, calls, get beat() { return beat; }, get cleared() { return cleared; } };
}

test('page presence authenticates the persistent management socket in its first frame', async () => {
  const h = leaseHarness();
  await h.lease.start();
  const socket = FakeWebSocket.instances[0];
  assert.equal(socket.url, 'ws://localhost:41000/ws/page');
  assert.equal(socket.url.includes('local-secret'), false);
  socket.open();
  assert.deepEqual(socket.sent, [{ type: 'page.hello', pageId: 'page-unique-1', token: 'local-secret' }]);
  h.lease.stop();
  assert.equal(socket.closeCount, 1);
});

test('page presence reconnects after its management socket closes', async () => {
  const h = leaseHarness();
  await h.lease.start();
  const first = FakeWebSocket.instances[0];
  first.close();
  h.beat();
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.equal(FakeWebSocket.instances[1].url, 'ws://localhost:41000/ws/page');
  h.lease.stop();
});

test('each document gets an independent in-memory page identifier', () => {
  const first = new PageLease({ token: 'local-secret', fetchImpl: async () => ({ ok: true }) });
  const second = new PageLease({ token: 'local-secret', fetchImpl: async () => ({ ok: true }) });
  assert.match(first.pageId, /^[A-Za-z0-9_-]{1,64}$/);
  assert.notEqual(first.pageId, second.pageId);
});

test('page lease immediately registers a unique page without putting token in the URL', async () => {
  const h = leaseHarness();
  await h.lease.start();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url.pathname, '/api/v1/page-lease');
  assert.equal(h.calls[0].url.search, '');
  assert.equal(h.calls[0].options.credentials, 'same-origin');
  assert.equal(h.calls[0].options.headers['X-Local-Control-Token'], 'local-secret');
  assert.deepEqual(JSON.parse(h.calls[0].options.body), { pageId: 'page-unique-1' });
  assert.equal(h.calls[0].options.keepalive, true);
});

test('page lease renews periodically and stops its timer when explicitly stopped', async () => {
  const h = leaseHarness();
  await h.lease.start();
  await h.beat();
  assert.equal(h.calls.length, 2);
  h.lease.stop();
  assert.equal(h.cleared, true);
});

test('page lease retries after a transient request failure', async () => {
  let attempt = 0;
  const h = leaseHarness(async () => {
    attempt += 1;
    if (attempt === 1) throw new Error('offline');
    return { ok: true };
  });
  await h.lease.start();
  await h.beat();
  assert.equal(attempt, 2);
});
