import { icon } from './icons.js';

export function createRoomBrowser({ documentRef = document, list, status, refreshButton, load, onJoin, onDiagnostics = () => {}, onRooms = () => {}, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval }) {
  let timer = null, loading = false, joining = false, stopped = false;
  const cards = new Map();
  const setStatus = text => { if (status.textContent !== text) status.textContent = text; };
  function roomCard(room) {
    const key = room.id || `${room.hostIPv4}:${room.hostPort}:${room.roomCode}`;
    let entry = cards.get(key);
    if (!entry) {
      const card = documentRef.createElement('article'); card.className = 'discovered-room'; card.dataset.roomId = key;
      const name = documentRef.createElement('h2');
      const details = documentRef.createElement('p'); details.className = 'room-occupancy';
      const activity = documentRef.createElement('p'); activity.className = 'room-sharing';
      const join = documentRef.createElement('button'); join.type = 'button';
      entry = { card, name, details, activity, join, room }; cards.set(key, entry);
      join.addEventListener('click', async () => {
        if (join.disabled || joining || stopped) return;
        joining = true; join.disabled = true; join.textContent = '正在加入…'; card.dataset.joining = 'true'; card.setAttribute('aria-busy', 'true');
        try { await onJoin(entry.room); }
        catch { setStatus('未能加入，请刷新房间列表后再试，也可以手动加入。'); }
        finally { joining = false; card.dataset.joining = 'false'; card.setAttribute('aria-busy', 'false'); updateCard(entry, entry.room); }
      });
      card.append(name, details, activity, join);
    }
    updateCard(entry, room);
    return entry.card;
  }
  function updateCard(entry, room) {
    const { card, name, details, activity, join } = entry;
    entry.room = room; card.dataset.sharing = String(!!room.screenSharing);
    name.textContent = String(room.name || '朋友的房间');
    const count = Math.max(0, Math.min(3, Number(room.members) || 0));
    details.textContent = `${count} / 3 人`;
    const seats = documentRef.createElement('span'); seats.className = 'room-seats'; seats.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 3; i++) { const seat = documentRef.createElement('i'); seat.className = i < count ? 'filled' : ''; seats.append(seat); }
    details.append(seats);
    const mark = documentRef.createElement('span'); mark.className = 'ui-icon'; mark.setAttribute('aria-hidden', 'true'); mark.innerHTML = icon('screen');
    const text = documentRef.createElement('span'); text.textContent = room.screenSharing ? '正在共享画面' : '语音房间 · 暂无画面';
    activity.replaceChildren(mark, text);
    const label = room.own ? '我的房间' : count >= 3 ? '房间已满' : '加入房间';
    join.textContent = label; join.className = `button ${room.screenSharing && count < 3 && !room.own ? 'button-primary' : ''}`;
    join.setAttribute('aria-label', `${label} ${room.name}`); join.disabled = !!room.own || count >= 3;
  }
  async function refresh() {
    if (stopped || loading || joining) return;
    loading = true; refreshButton.disabled = true;
    try {
      const result = await load();
      if (stopped) return;
      onDiagnostics(formatDiscoveryDiagnostics(result.diagnostics));
      const rooms = Array.isArray(result.rooms) ? result.rooms.slice(0, 64) : [];
      onRooms({ count: rooms.length, available: !!result.available });
      const nextCards = rooms.map(roomCard);
      const existing = [...list.children];
      if (nextCards.length !== existing.length || nextCards.some((card, index) => existing[index] !== card)) {
        const focused = documentRef.activeElement;
        list.replaceChildren(...nextCards);
        if (nextCards.some(card => card.contains?.(focused))) focused.focus?.({ preventScroll: true });
      }
      for (const [key, entry] of cards) if (!nextCards.includes(entry.card)) cards.delete(key);
      setStatus(rooms.length ? `发现 ${rooms.length} 个房间` : result.available
        ? '还没有发现房间。请让朋友先创建房间，稍等几秒或点击刷新。'
        : result.message || '自动发现暂不可用，可以使用手动加入。');
    } catch { if (!stopped) { onRooms({ count: 0, available: false }); setStatus('暂时无法读取房间列表，请稍后刷新或使用手动加入。'); } }
    finally { loading = false; refreshButton.disabled = false; }
  }
  refreshButton.addEventListener('click', refresh);
  return {
    refresh,
    start() { if (timer !== null || stopped) return; void refresh(); timer = setIntervalImpl(() => void refresh(), 3000); },
    stop() { stopped = true; if (timer !== null) clearIntervalImpl(timer); timer = null; },
  };
}

export function formatDiscoveryDiagnostics(d = {}) {
  const number = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const mode = { 'multicast+broadcast': '组播 + 广播', multicast: '组播', broadcast: '广播' }[d.transport] || '尚未启动';
  const errors = { NO_PRIVATE_NETWORK: '未检测到局域网', NETWORK_INTERFACE_UNAVAILABLE: '所选网卡不可用', NETWORK_PERMISSION_DENIED: '系统拒绝网络权限', DISCOVERY_PORT_IN_USE: '查找端口被占用', PACKET_TOO_LARGE: '已丢弃超长网络包', DISCOVERY_SOCKET_ERROR: '网络读写失败' };
  return [
    `网卡：${String(d.interfaceName || '未检测到').slice(0, 128)} · ${String(d.localIPv4 || '无 IPv4').slice(0, 64)}`,
    `查找方式：${mode} · ${d.running ? '运行中（不代表网络已放行）' : '未运行'} · UDP 49877`,
    `发出查找包：${number(d.queriesSent)}；收到其他程序查找包：${number(d.queriesReceived)}`,
    `发出房间回复：${number(d.repliesSent)}；收到有效房间回复：${number(d.repliesReceived)}`,
    `发送错误：${number(d.sendErrors)}；接收错误：${number(d.readErrors)}；最近错误：${errors[d.lastError] || '无'}`,
  ].join('\n');
}
