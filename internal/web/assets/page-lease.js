export class PageLease {
  constructor({
    pageId = globalThis.crypto.randomUUID(),
    token,
    fetchImpl = globalThis.fetch?.bind(globalThis),
    WebSocketImpl = globalThis.WebSocket,
    locationRef = globalThis.location,
    intervalMs = 2000,
    setIntervalImpl = globalThis.setInterval.bind(globalThis),
    clearIntervalImpl = globalThis.clearInterval.bind(globalThis),
  }) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(pageId)) throw new Error('本机页面标识无效。');
    this.pageId = pageId;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.locationRef = locationRef;
    this.intervalMs = intervalMs;
    this.setIntervalImpl = setIntervalImpl;
    this.clearIntervalImpl = clearIntervalImpl;
    this.timer = null;
    this.inFlight = null;
    this.socket = null;
  }

  connectPresence() {
    if (!this.WebSocketImpl || !this.locationRef) return;
    if (this.socket && this.socket.readyState < this.WebSocketImpl.CLOSING) return;
    const protocol = this.locationRef.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket;
    try { socket = new this.WebSocketImpl(`${protocol}//${this.locationRef.host}/ws/page`); }
    catch { this.socket = null; return; }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      socket.send(JSON.stringify({ type: 'page.hello', pageId: this.pageId, token: this.token }));
    };
    socket.onclose = () => { if (this.socket === socket) this.socket = null; };
    socket.onerror = () => { try { socket.close(); } catch { /* retry on the next page timer */ } };
  }

  async beat() {
    if (!this.token || !this.fetchImpl) return false;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetchImpl('/api/v1/page-lease', {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      headers: { 'Content-Type': 'application/json', 'X-Local-Control-Token': this.token },
      body: JSON.stringify({ pageId: this.pageId }),
    }).then((response) => response.ok).catch(() => false).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async start() {
    if (this.timer !== null) return;
    this.connectPresence();
    this.timer = this.setIntervalImpl(() => { this.connectPresence(); void this.beat(); }, this.intervalMs);
    await this.beat();
  }

  stop() {
    if (this.timer !== null) this.clearIntervalImpl(this.timer);
    this.timer = null;
    this.socket?.close();
    this.socket = null;
  }
}
