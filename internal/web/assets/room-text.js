const LABEL = 'lan-room-text-v1';
export const ROOM_REACTIONS = Object.freeze(['👏', '🔥', '😂', '👍']);
const reactionBufferLimit = 4096;
const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 64;
function remember(seen, id, limit) {
  seen.add(id);
  if (seen.size > limit) seen.delete(seen.values().next().value);
}
const validText = text => typeof text === 'string' && text.trim().length > 0 && [...text.trim()].length <= 500;

// Text travels on the same authenticated, encrypted peer connections as room media.
// No history, account, external service or microphone permission is needed.
export class RoomText {
  constructor({onMessage = () => {}, onReaction = () => {}, onChange = () => {}, now = Date.now} = {}) {
    this.peers = new Map();
    this.onMessage = onMessage;
    this.onReaction = onReaction;
    this.onChange = onChange;
    this.now = now;
    this.lastReaction = -Infinity;
  }
  addPeer(peerId, pc, offerer) {
    const peer = {channel:null, seen:new Set(), reactionIds:new Set(), lastReaction:-Infinity, window:0, count:0};
    this.peers.set(peerId, peer);
    const attach = channel => {
      if (channel.label !== LABEL || peer.channel) { channel.close(); return; }
      peer.channel = channel;
      channel.onopen = channel.onclose = channel.onerror = () => this.onChange();
      channel.onmessage = event => {
        if (this.peers.get(peerId) !== peer || typeof event.data !== 'string' || event.data.length > 8192) return;
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message?.v !== 1 || !validId(message.id)) return;
        const now = this.now();
        if (message.kind === 'reaction') {
          if (Object.hasOwn(message, 'text') || !ROOM_REACTIONS.includes(message.emoji) || peer.reactionIds.has(message.id)) return;
          remember(peer.reactionIds, message.id, 128);
          if (now - peer.lastReaction < 500) return;
          peer.lastReaction = now;
          this.onReaction({peerId, id:message.id, emoji:message.emoji});
          return;
        }
        if (message.kind !== undefined && message.kind !== 'text') return;
        if (now - peer.window > 1000) { peer.window = now; peer.count = 0; }
        if (++peer.count > 8 || !validText(message.text) || peer.seen.has(message.id)) return;
        remember(peer.seen, message.id, 100);
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
  sendReaction(emoji) {
    const now = this.now();
    if (!ROOM_REACTIONS.includes(emoji) || now - this.lastReaction < 650) return null;
    const channels = [...this.peers.values()]
      .map(peer => peer.channel)
      .filter(channel => channel?.readyState === 'open' && channel.bufferedAmount <= reactionBufferLimit);
    if (!channels.length) return null;
    this.lastReaction = now;
    const id = globalThis.crypto.randomUUID();
    const payload = JSON.stringify({v: 1, id, kind: 'reaction', emoji});
    let sent = false;
    for (const channel of channels) {
      try { channel.send(payload); sent = true; } catch { /* Ephemeral reactions are dropped. */ }
    }
    return sent ? {id, emoji} : null;
  }

  removePeer(peerId) {
    const peer = this.peers.get(peerId); if (!peer) return;
    this.peers.delete(peerId); peer.channel?.close(); this.onChange();
  }
}
