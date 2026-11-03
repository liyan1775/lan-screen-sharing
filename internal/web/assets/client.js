export const ERROR_TEXT = Object.freeze({
  SHARE_BUSY: '其他成员正在共享，请等对方停止后再开始。',
  INVALID_ROOM_NAME: '房间名请使用 32 个字以内的普通文字。',
  SHARE_NOT_OWNER: '当前不是你在共享，不能修改其他成员的画面。',
  AUTH_REQUIRED: '身份验证失败，请刷新本机页面后重试。',
  HOST_ONLY: '只有房主可以执行此操作。',
  ROOM_NOT_FOUND: '房间不存在或已结束。',
  ROOM_EXPIRED: '房间已过期，请让房主重新创建房间。',
  ROOM_FULL: '房间已满，最多三位成员。',
  INVALID_INVITE: '房间码无效，请核对房主提供的信息。',
  INVALID_HOST_ADDRESS: '房主地址必须是局域网 IPv4 地址。',
  INVALID_PORT: '信令端口无效，请核对房主提供的信息。',
  SIGNAL_TARGET_NOT_MEMBER: '目标成员已离开房间。',
  SIGNAL_CONNECTION_LOST: '与房主的信令连接中断，正在尝试恢复房间。',
  MIC_PERMISSION_DENIED: '麦克风权限未授予；你仍可观看并听取房间语音。',
  CAPTURE_CANCELLED: '已取消屏幕选择。',
  DISPLAY_NOT_MONITOR: '请选择整块显示器；窗口或浏览器标签页不能作为游戏画面。',
  SYSTEM_AUDIO_UNSUPPORTED: '当前浏览器无法提供所需的屏幕采集。请使用桌面版 Edge 或 Chrome，检查采集权限。',
  SYSTEM_AUDIO_UNVERIFIED: '声音隔离未确认；系统声音仍可共享，可能包含房间语音。',
  ICE_FAILED: '点对点连接失败；请确认设备位于同一局域网并允许浏览器本地连接。',
  RATE_LIMITED: '房间码尝试次数已达上限，请等待 60 秒后重试。',
  PORT_IN_USE: '房间信令端口已被占用。请关闭占用端口的程序，或用 --signal-port 指定其他端口后重试。',
  SERVICE_START_FAILED: '无法启动房间信令服务，请检查绑定地址和端口后重试。',
});

export class RoomClient extends EventTarget {
  constructor({ fetchImpl, WebSocketImpl = globalThis.WebSocket, storageImpl = globalThis.sessionStorage } = {}) {
    super();
    this.fetchImpl = fetchImpl === undefined ? globalThis.fetch?.bind(globalThis) : fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.ws = null;
    this.role = '';
    this.hostControlToken = '';
    this.bootstrap = null;
    this.room = null;
    this.peerId = '';
    this.resumeToken = '';
    this.joinDetails = null;
    this.pending = new Map();
    this.sequence = 0;
    this.explicitlyLeaving = false;
    this.reconnectWanted = false;
    this.heartbeatTimer = null;
    this.storage = storageImpl;
    this.sessionEpoch = 0;
    this.recovering = false;
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  async loadLocalControl() {
    const url = new URL('/api/v1/bootstrap', location.href);
    const response = await this.fetchImpl(url, { credentials: 'same-origin', headers: { Accept: 'application/json' }, signal:AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('本机服务暂不可用。');
    const bootstrap = await response.json();
    this.bootstrap = { ...bootstrap, ...(this.bootstrap ?? {}), localControlToken: bootstrap.localControlToken ?? '' };
    return this.bootstrap;
  }

  requestId() { this.sequence += 1; return `req-${Date.now().toString(36)}-${this.sequence.toString(36)}-${crypto.randomUUID()}`; }

  async connect({ role, hostControlToken, resumeRoomId = '' } = {}) {
    if (!['host', 'viewer'].includes(role)) throw new Error('请选择角色。');
    if (this.role && this.role !== role) this.close();
    this.role = role;
    this.hostControlToken = role === 'host' ? (hostControlToken ?? '') : '';
    const url = new URL('/api/v1/bootstrap', location.href);
    if (role === 'host') url.searchParams.set('role', 'host');
    const response = await this.fetchImpl(url, { credentials: 'same-origin', headers: { Accept: 'application/json' }, signal:AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('本机服务暂不可用，请确认程序已启动后刷新页面。');
    this.bootstrap = await response.json();
    if (!this.bootstrap.localWsPath || this.bootstrap.localWsPath !== '/ws/v1') throw new Error('本机服务返回了无效的信令地址。');
    if (role === 'host' && !this.hostControlToken) this.hostControlToken = this.bootstrap.hostControlToken ?? '';
    if (role === 'host' && !this.hostControlToken) throw new Error('无法取得主播控制凭证，请从本机打开页面。');
    return this.openLocalSocket(resumeRoomId);
  }

  async refreshBootstrap(role = this.role) {
    const url = new URL('/api/v1/bootstrap', location.href);
    if (role === 'host') url.searchParams.set('role', 'host');
    const response = await this.fetchImpl(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('无法刷新本机房间连接信息。');
    this.bootstrap = await response.json();
    if (role === 'host' && this.bootstrap.hostControlToken) this.hostControlToken = this.bootstrap.hostControlToken;
    return this.bootstrap;
  }

  openLocalSocket(resumeRoomId = '') {
    if (this.ws?.readyState === this.WebSocketImpl.OPEN) return Promise.resolve();
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socketURL = `${protocol}//${location.host}${this.bootstrap.localWsPath}`;
    this.ws = new this.WebSocketImpl(socketURL);
    return new Promise((resolve, reject) => {
      const socket = this.ws;
      let settled = false;
      const openingTimeout = setTimeout(() => {
        if (settled) return;
        settled = true; socket.close();
        reject(Object.assign(new Error('本机连接超时，稍后会重试。'), {code:'SIGNAL_CONNECTION_LOST', retryable:true}));
      }, 5000);
      socket.onopen = () => {
        const payload = this.role === 'host' ? { role: 'host', hostToken: this.hostControlToken, ...(resumeRoomId ? {roomId:resumeRoomId} : {}) } : { role: 'viewer' };
        this.request('auth.hello', payload, { expected: 'room.state' }).then(() => {
          clearTimeout(openingTimeout);
          settled = true;
          if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = setInterval(() => this.sendUnacknowledged('heartbeat', {}), 12_000);
          this.emit('connected', { role: this.role }); resolve();
        }, (error) => { clearTimeout(openingTimeout); settled = true; socket.close(); reject(error); });
      };
      socket.onmessage = (event) => { if (this.ws === socket) this.receive(event.data); };
      socket.onerror = () => { if (!settled) { clearTimeout(openingTimeout); settled = true; reject(new Error('本机信令连接失败。')); } };
      socket.onclose = () => {
        if (this.ws !== socket) return;
        this.ws = null;
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
        clearTimeout(openingTimeout);
        const error = Object.assign(new Error('本机信令连接已关闭。'), {code:'SIGNAL_CONNECTION_LOST', retryable:true});
        if (!settled) { settled = true; reject(error); }
        for (const [id, pending] of this.pending) { pending.reject(error); this.pending.delete(id); }
        this.emit('disconnected', {});
      };
    });
  }

  request(type, payload = {}, { roomId, expected = type } = {}) {
    if (!this.ws || this.ws.readyState !== this.WebSocketImpl.OPEN) return Promise.reject(new Error('本机信令连接未就绪。'));
    const requestId = this.requestId();
    const envelope = { v: 1, type, requestId, payload };
    if (roomId) envelope.roomId = roomId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(Object.assign(new Error('房间连接暂未响应，正在等待恢复。'), {code:'SIGNAL_CONNECTION_LOST',retryable:true}));
      }, 5000);
      this.pending.set(requestId, {
        resolve: (message) => { clearTimeout(timeout); resolve(message); },
        reject: error => { clearTimeout(timeout); reject(error); },
        expected,
        type,
      });
      this.ws.send(JSON.stringify(envelope));
    });
  }

  receive(raw) {
    let message;
    try { message = JSON.parse(raw); } catch { this.emit('protocolError', {}); return; }
    if (message.type === 'room.state' && this.room?.roomId === message.roomId &&
      Number.isSafeInteger(message.payload?.presentationRevision) && message.payload.presentationRevision < (this.room.presentationRevision ?? 0)) {
      // Concurrent member/roster updates may arrive after a newer presenter.
      // Keep membership updates, but never rewind presentation ownership.
      for (const key of ['presenterPeerId','presentationRevision','screenSharing','hasSystemAudio','isolationStatus']) message.payload[key] = this.room[key];
    }
    const pending = message.requestId ? this.pending.get(message.requestId) : null;
    if (!pending && !this.reconnectWanted && (message.type === 'room.joined' || message.payload?.resumed === true)) return;
    if (this.recovering && this.recoveryEpoch !== this.sessionEpoch && message.roomId && (message.type === 'room.joined' || message.type === 'room.state')) {
      if (pending) { this.pending.delete(message.requestId); pending.reject(Object.assign(new Error('重连已取消。'), {code:'RECOVERY_CANCELLED'})); }
      return;
    }
    message.recovered = this.recovering && (message.type === 'room.joined' || message.payload?.resumed === true);
    if (message.type === 'error') {
      if (message.payload?.code === 'SIGNAL_CONNECTION_LOST') {
        for (const [id, action] of this.pending) if (action.type === 'share.claim' || action.type === 'share.release') {
          this.pending.delete(id);
          action.reject(Object.assign(new Error('共享授权连接已中断，请等待房间恢复后重试。'), {code:'SIGNAL_CONNECTION_LOST', retryable:true}));
        }
      }
      if (pending) { this.pending.delete(message.requestId); pending.reject(Object.assign(new Error(ERROR_TEXT[message.payload?.code] ?? '操作未能完成。'), { code: message.payload?.code, retryable: !!message.payload?.retryable })); }
      this.emit('errorMessage', { code: message.payload?.code ?? 'UNKNOWN', retryable: !!message.payload?.retryable, text: ERROR_TEXT[message.payload?.code] ?? '操作未能完成。', requestId: message.requestId });
      return;
    }
    if (pending && message.type === pending.expected) {
      this.pending.delete(message.requestId);
      pending.resolve(message);
    }
    if (message.type === 'room.created') {
      this.room = { roomId: message.roomId, name:message.payload?.name || '', roomCode: message.payload?.roomCode, expiresAt: message.payload?.expiresAt, members: [{ peerId: message.peerId, role: 'host', state: 'connected' }], screenSharing: false };
      this.peerId = message.peerId; this.reconnectWanted = true;
    }
    if (message.type === 'room.joined') {
      this.room = { roomId: message.roomId, name:message.payload?.name || '', members: message.payload?.members ?? [], screenSharing: message.payload?.screenSharing === true, presenterPeerId: message.payload?.presenterPeerId ?? '', hasSystemAudio: message.payload?.hasSystemAudio === true, presentationRevision: message.payload?.presentationRevision ?? 0 };
      this.peerId = message.peerId ?? message.payload?.peerId ?? '';
      this.resumeToken = message.payload?.resumeToken ?? this.resumeToken;
      this.reconnectWanted = true;
    }
    if (message.type === 'room.state' && message.roomId) this.room = { ...(this.room ?? {}), roomId: message.roomId, ...(message.payload ?? {}) };
    if (message.type === 'room.state' && message.payload?.resumed) { this.peerId = message.peerId; this.reconnectWanted = true; }
    if (message.type === 'room.ended') {
      this.room = null;
      this.peerId = '';
      this.resumeToken = '';
      this.joinDetails = null;
      this.reconnectWanted = false;
      this.cancelRecovery();
    }
    if (message.type === 'peer.left') {
      const departedPeerId = message.payload?.peerId ?? message.peerId;
      message.selfLeft = departedPeerId === this.peerId;
      if (this.room) this.room.members = (this.room.members ?? []).filter((member) => member.peerId !== departedPeerId);
      if (message.selfLeft) { this.room = null; this.peerId = ''; this.resumeToken = ''; this.joinDetails = null; this.cancelRecovery(); }
    }
    if (message.type === 'peer.joined' && this.room) this.room.members = [...(this.room.members ?? []).filter((member) => member.peerId !== message.peerId), { peerId: message.peerId, role: message.payload?.role ?? 'viewer', state: 'connected' }];
    if (message.type === 'peer.state' && this.room) this.room.members = (this.room.members ?? []).map((member) => member.peerId === message.peerId ? { ...member, state: message.payload?.state } : member);
    if (message.type === 'room.state' && this.room) this.room = { ...this.room, ...(message.payload ?? {}) };
    if (this.room && this.reconnectWanted) this.saveSession();
    this.emit('message', message);
  }

  async createRoom(options = {}) {
    if (this.role !== 'host' || !this.hostControlToken) throw Object.assign(new Error(ERROR_TEXT.HOST_ONLY), { code: 'HOST_ONLY' });
    const message = await this.request('host.createRoom', options, { expected: 'room.created' });
    await this.refreshBootstrap('host').catch(() => {});
    return { roomId: message.roomId, ...message.payload };
  }

  async joinRoom({ hostIPv4, hostPort, roomCode, resumeToken = '', restartMedia = false }) {
    const payload = { hostIPv4: hostIPv4.trim(), hostPort: Number(hostPort), roomCode: roomCode.trim().toUpperCase() };
    if (resumeToken) payload.resumeToken = resumeToken;
    if (restartMedia) payload.restartMedia = true;
    this.joinDetails = {...payload};
    const message = await this.request('viewer.join', payload, { expected: 'room.joined' });
    this.joinDetails = { ...payload, resumeToken: message.payload?.resumeToken ?? resumeToken };
    this.saveSession();
    return { roomId: message.roomId, peerId: message.peerId, ...message.payload };
  }

  async leaveRoom() {
    this.explicitlyLeaving = true;
    this.cancelRecovery();
    const roomId = this.room?.roomId;
    if (!roomId) { this.room = null; this.resumeToken = ''; this.joinDetails = null; this.explicitlyLeaving = false; return null; }
    try {
      const message = await this.request('viewer.leave', {}, { roomId, expected: 'peer.left' });
      return { roomId, peerId: message.payload?.peerId ?? this.peerId, left: true };
    } finally {
      this.explicitlyLeaving = false;
    }
  }

  async endRoom() {
    if (this.role !== 'host' || !this.hostControlToken) throw Object.assign(new Error(ERROR_TEXT.HOST_ONLY), { code: 'HOST_ONLY' });
    const roomId = this.room?.roomId;
    if (!roomId) return null;
    this.cancelRecovery();
    const message = await this.request('host.endRoom', {}, { roomId, expected: 'room.ended' });
    this.room = null;
    return { roomId, ...message.payload };
  }

  send(type, payload = {}, options = {}) { return this.request(type, payload, options); }

  async loadRooms() {
    const token = this.bootstrap?.localControlToken;
    if (!token) throw new Error('本机程序尚未连接。');
    const response = await this.fetchImpl(new URL('/api/v1/rooms', location.href), {
      credentials: 'same-origin', headers: { Accept: 'application/json', 'X-Local-Control-Token': token },
    });
    if (!response.ok) throw new Error('房间列表暂不可用。');
    return response.json();
  }

  claimPresentation() {
    if (!this.room?.roomId) return Promise.reject(new Error('请先创建或加入房间。'));
    return this.request('share.claim', {}, { roomId: this.room.roomId, expected: 'room.state' });
  }

  releasePresentation(roomId = this.room?.roomId) {
    if (!roomId || roomId !== this.room?.roomId) return Promise.resolve();
    return this.request('share.release', {}, { roomId, expected: 'room.state' });
  }

  sendUnacknowledged(type, payload = {}) {
    if (!this.ws || this.ws.readyState !== this.WebSocketImpl.OPEN) return false;
    this.ws.send(JSON.stringify({ v: 1, type, requestId: this.requestId(), payload }));
    return true;
  }

  sendSignal(type, toPeerId, payload) {
    if (!this.sendUnacknowledged(type, { ...payload, toPeerId })) this.emit('errorMessage', { code: 'SIGNAL_CONNECTION_LOST', text: ERROR_TEXT.SIGNAL_CONNECTION_LOST, retryable: true });
  }

  retryJoin() {
    if (!this.reconnectWanted || this.explicitlyLeaving || !this.joinDetails || !this.resumeToken) return Promise.reject(new Error('重连已取消。'));
    return this.joinRoom({ ...this.joinDetails, resumeToken: this.resumeToken, restartMedia:true });
  }

  saveSession() {
    if (!this.bootstrap?.serviceId || !this.room?.roomId || !this.reconnectWanted) return;
    if (this.role === 'viewer' && (!this.joinDetails || !this.resumeToken)) return;
    try {
      this.storage?.setItem('lan-screen-sharing.room', JSON.stringify({v:1, serviceId:this.bootstrap.serviceId, role:this.role, roomId:this.room.roomId, peerId:this.peerId,
        ...(this.role === 'viewer' ? {joinDetails:{...this.joinDetails, resumeToken:this.resumeToken}} : {})}));
    } catch { /* Storage may be disabled; live-page reconnection still works. */ }
  }

  prepareRestore() {
    try {
      const raw = this.storage?.getItem('lan-screen-sharing.room');
      if (!raw || raw.length > 4096) return false;
      const saved = JSON.parse(raw);
      if (saved.v !== 1 || !this.bootstrap?.serviceId || saved.serviceId !== this.bootstrap.serviceId || !['host','viewer'].includes(saved.role) || !/^[a-zA-Z0-9_-]{1,64}$/.test(saved.roomId)) { this.cancelRecovery(); return false; }
      if (saved.role === 'viewer' && (!saved.joinDetails?.resumeToken || typeof saved.joinDetails.hostIPv4 !== 'string' || typeof saved.joinDetails.roomCode !== 'string')) { this.cancelRecovery(); return false; }
      this.role = saved.role; this.room = {roomId:saved.roomId, members:[]}; this.peerId = saved.peerId || '';
      this.joinDetails = saved.joinDetails || null; this.resumeToken = saved.joinDetails?.resumeToken || ''; this.reconnectWanted = true;
      return true;
    } catch { this.cancelRecovery(); return false; }
  }

  cancelRecovery() {
    this.reconnectWanted = false; this.sessionEpoch += 1;
    try { this.storage?.removeItem('lan-screen-sharing.room'); } catch { /* Optional browser storage. */ }
  }

  async recoverRoom() {
    if (!this.reconnectWanted || !this.room?.roomId || this.explicitlyLeaving) throw Object.assign(new Error('重连已取消。'), {code:'RECOVERY_CANCELLED'});
    const roomId = this.room.roomId;
    this.recovering = true; this.recoveryEpoch = this.sessionEpoch;
    try {
      if (this.ws?.readyState !== this.WebSocketImpl.OPEN) await this.connect({role:this.role, resumeRoomId:this.role === 'host' ? roomId : ''});
      if (this.recoveryEpoch !== this.sessionEpoch || !this.reconnectWanted) throw Object.assign(new Error('重连已取消。'), {code:'RECOVERY_CANCELLED'});
      if (this.role === 'viewer') await this.retryJoin();
      this.saveSession();
    } finally { this.recovering = false; }
  }

  close() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    const socket = this.ws;
    this.ws = null;
    socket?.close?.();
    for (const [id, pending] of this.pending) { this.pending.delete(id); pending.reject(Object.assign(new Error('连接已取消。'), {code:'RECOVERY_CANCELLED'})); }
  }
}
