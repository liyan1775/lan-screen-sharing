export function bindLocalConnectionLifecycle(client, media, onDisconnected, {
  onRecovering = () => {}, onRecovered = () => {},
  windowMs = 30_000, now = Date.now,
  setTimeoutImpl = globalThis.setTimeout.bind(globalThis), clearTimeoutImpl = globalThis.clearTimeout.bind(globalThis),
} = {}) {
  let timer = null, running = false, startedAt = 0, attempt = 0, generation = 0;
  function cancel() {
    generation += 1;
    if (timer !== null) clearTimeoutImpl(timer);
    timer = null; running = false;
  }
  async function finish() {
    cancel(); client.cancelRecovery();
    client.close?.();
    client.room = null; client.peerId = ''; client.resumeToken = ''; client.joinDetails = null;
    await Promise.resolve(media.closeAll()).catch(() => {});
    onDisconnected();
  }
  function schedule() {
    if (!client.reconnectWanted || client.explicitlyLeaving) { cancel(); return; }
    if (now() - startedAt >= windowMs) { void finish(); return; }
    const current = generation;
    timer = setTimeoutImpl(async () => {
      timer = null;
      if (current !== generation || !client.reconnectWanted || client.explicitlyLeaving) return;
      attempt += 1; onRecovering(attempt);
      try {
        await client.recoverRoom();
        if (current !== generation || !client.reconnectWanted) return;
        running = false; onRecovered();
      } catch (error) {
        if (current !== generation || !client.reconnectWanted || error.code === 'RECOVERY_CANCELLED') return;
        if (['ROOM_EXPIRED','INVALID_INVITE','AUTH_REQUIRED','HOST_ONLY'].includes(error.code) || (error.code === 'ROOM_NOT_FOUND' && !error.retryable)) { await finish(); return; }
        schedule();
      }
    }, Math.min(attempt ? 500 * 2 ** Math.min(attempt, 3) : 250, Math.max(0, windowMs - (now() - startedAt))));
  }
  function recover() {
    if (running || client.explicitlyLeaving || !client.reconnectWanted || !client.room) return;
    running = true; startedAt = now(); attempt = 0; generation += 1; onRecovering(0); schedule();
  }
  client.addEventListener('disconnected', () => {
    if (client.explicitlyLeaving) return;
    if (client.reconnectWanted && client.room) recover();
    else if (!running) void finish();
  });
  client.addEventListener('errorMessage', event => {
    if (event.detail.code === 'SIGNAL_CONNECTION_LOST' && event.detail.retryable) recover();
  });
  return {recover, cancel};
}
