const LABEL = 'lan-room-text-v1';
const validText = text => typeof text === 'string' && text.trim().length > 0 && [...text.trim()].length <= 500;

// Text travels on the same authenticated, encrypted peer connections as room media.
// No history, account, external service or microphone permission is needed.
export class RoomText {
  constructor({onMessage = () => {}, onChange = () => {}} = {}) {
    this.peers = new Map(); this.onMessage = onMessage; this.onChange = onChange;
  }
  addPeer(peerId, pc, offerer) {
    const peer = {channel:null, seen:new Set(), window:0, count:0};
    this.peers.set(peerId, peer);
    const attach = channel => {
      if (channel.label !== LABEL || peer.channel) { channel.close(); return; }
      peer.channel = channel;
      channel.onopen = channel.onclose = channel.onerror = () => this.onChange();
      channel.onmessage = event => {
        if (this.peers.get(peerId) !== peer || typeof event.data !== 'string' || event.data.length > 8192) return;
        const now = Date.now();
        if (now - peer.window > 1000) { peer.window = now; peer.count = 0; }
        if (++peer.count > 8) return;
        let message; try { message = JSON.parse(event.data); } catch { return; }
        if (message?.v !== 1 || typeof message.id !== 'string' || !message.id || message.id.length > 64 || !validText(message.text) || peer.seen.has(message.id)) return;
        peer.seen.add(message.id); if (peer.seen.size > 100) peer.seen.delete(peer.seen.values().next().value);
        this.onMessage({peerId, id:message.id, text:message.text.trim(), time:now});
      };
      this.onChange();
    };
    pc.ondatachannel = event => attach(event.channel);
    if (offerer && typeof pc.createDataChannel === 'function') attach(pc.createDataChannel(LABEL, {ordered:true}));
    this.onChange();
  }
  get ready() { return this.peers.size > 0 && [...this.peers.values()].every(peer => peer.channel?.readyState === 'open'); }
  send(text) {
    if (!validText(text)) throw new Error('请输入 1 至 500 字的消息。');
    if (!this.peers.size) throw new Error('朋友加入房间后就可以发送文字。');
    if (!this.ready) throw new Error('文字连接尚未就绪，请稍后再试。');
    const id = globalThis.crypto.randomUUID();
    const payload = JSON.stringify({v:1,id,text:text.trim()});
    let sent = 0, failed = 0;
    for (const {channel} of this.peers.values()) {
      try {
        if (channel.bufferedAmount > 65536) throw new Error('busy');
        channel.send(payload); sent++;
      } catch { failed++; }
    }
    return {id, text:text.trim(), time:Date.now(), sent, failed};
  }
  removePeer(peerId) {
    const peer = this.peers.get(peerId); if (!peer) return;
    this.peers.delete(peerId); peer.channel?.close(); this.onChange();
  }
}
