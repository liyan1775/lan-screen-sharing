import { icon } from './icons.js';
import { maxPeerHosts, privatePeerHost } from './preferences.js';

export function createRoomBrowser({ documentRef = document, list, status, refreshButton, load, refreshDiscovery = async () => {}, onJoin, onDiagnostics = () => {}, onRooms = () => {}, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval }) {
  let timer = null, loading = null, joining = false, stopped = false, started = false, active = true;
  let networkGeneration = 0;
  const cards = new Map();
  const setStatus = text => { if (status.textContent !== text) status.textContent = text; };
  function roomCard(room) {
    const key = room.id || `${room.hostIPv4}:${room.hostPort}:${room.roomCode}`;
    let entry = cards.get(key);
    if (!entry) {
      const card = documentRef.createElement('article'); card.className = 'discovered-room'; card.dataset.roomId = key;
      const name = documentRef.createElement('h2');
      const details = documentRef.createElement('p'); details.className = 'room-occupancy';
      const occupancy = documentRef.createElement('span');
      const seats = documentRef.createElement('span'); seats.className = 'room-seats'; seats.setAttribute('aria-hidden', 'true');
      for (let i = 0; i < 3; i++) seats.append(documentRef.createElement('i'));
      details.append(occupancy, seats);
      const activity = documentRef.createElement('p'); activity.className = 'room-sharing';
      const mark = documentRef.createElement('span'); mark.className = 'ui-icon'; mark.setAttribute('aria-hidden', 'true'); mark.innerHTML = icon('screen');
      const activityText = documentRef.createElement('span');
      activity.append(mark, activityText);
      const join = documentRef.createElement('button'); join.type = 'button';
      entry = { card, name, occupancy, seats, activityText, join, room }; cards.set(key, entry);
      join.addEventListener('click', async () => {
        if (join.disabled || joining || stopped) return;
        joining = true; entry.rendered = null; join.disabled = true; join.textContent = '正在加入…'; card.dataset.joining = 'true'; card.setAttribute('aria-busy', 'true');
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
    const { card, name, occupancy, seats, activityText, join } = entry;
    entry.room = room;
    const title = String(room.name || '朋友的房间');
    const count = Math.max(0, Math.min(3, Number(room.members) || 0));
    const sharing = !!room.screenSharing, own = !!room.own;
    const previous = entry.rendered;
    if (previous && previous.title === title && previous.count === count && previous.sharing === sharing && previous.own === own) return;
    entry.rendered = { title, count, sharing, own };
    card.dataset.sharing = String(sharing);
    name.textContent = title;
    occupancy.textContent = `${count} / 3 人`;
    [...seats.children].forEach((seat, index) => { seat.className = index < count ? 'filled' : ''; });
    activityText.textContent = sharing ? '正在共享画面' : '语音房间 · 暂无画面';
    const label = room.own ? '我的房间' : count >= 3 ? '房间已满' : '加入房间';
    join.textContent = label; join.className = `button ${room.screenSharing && count < 3 && !room.own ? 'button-primary' : ''}`;
    join.setAttribute('aria-label', `${label} ${title}`); join.disabled = own || count >= 3;
  }
  async function refresh({reset = false, probe = false, afterSave = false} = {}) {
    if (reset) {
      networkGeneration++;
      loading = null;
      cards.clear();
      list.replaceChildren();
    }
    if (stopped || !active || joining) return;
    if (loading) {
      if (probe) networkGeneration++;
      else if (afterSave) {
        await loading;
        return refresh({afterSave});
      } else return;
    }
    const generation = networkGeneration;
    loading = readRooms(generation, probe);
    try { await loading; }
    finally { if (generation === networkGeneration) loading = null; }
  }
  async function readRooms(generation, probe) {
    try {
      if (probe) {
        try { await refreshDiscovery(); }
        catch { /* The cached list and diagnostics are still useful. */ }
      }
      if (stopped || !active || generation !== networkGeneration) return;
      const result = await load();
      if (stopped || !active || generation !== networkGeneration) return;
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
    } catch { if (!stopped && active && generation === networkGeneration) { onRooms({ count: 0, available: false }); setStatus('暂时无法读取房间列表，请稍后刷新或使用手动加入。'); } }
  }
  refreshButton.addEventListener('click', async () => {
    if (refreshButton.disabled) return;
    refreshButton.disabled = true;
    try { await refresh({probe: true}); }
    finally { refreshButton.disabled = false; }
  });
  function startTimer() {
    if (!started || !active || stopped || timer !== null) return;
    void refresh(); timer = setIntervalImpl(() => void refresh(), 3000);
  }
  return {
    refresh,
    start() { started = true; startTimer(); },
    setActive(value) {
      if (active === !!value || stopped) return;
      active = !!value;
      if (!active) { if (timer !== null) clearIntervalImpl(timer); timer = null; }
      else startTimer();
    },
    stop() { stopped = true; if (timer !== null) clearIntervalImpl(timer); timer = null; },
  };
}

export function bindPeerHosts({ form, input, list, status, getHosts, save, onSaved, ready = async () => {} }) {
  const documentRef = form.ownerDocument;
  const chips = new Map();
  let pending = Promise.resolve();
  function queue(change) {
    const result = pending.then(change);
    pending = result.catch(() => {});
    return result;
  }
  function render() {
    const hosts = getHosts();
    for (const [host, chip] of chips) {
      if (!hosts.includes(host)) { chip.remove(); chips.delete(host); }
    }
    for (const host of hosts) {
      if (chips.has(host)) continue;
      const chip = documentRef.createElement('li');
      chip.className = 'peer-host-chip';
      const address = documentRef.createElement('span');
      address.textContent = host;
      const remove = documentRef.createElement('button');
      remove.type = 'button';
      remove.setAttribute('aria-label', `移除好友 IP ${host}`);
      remove.textContent = '×';
      remove.addEventListener('click', async () => {
        const wasFocused = documentRef.activeElement === remove;
        const removed = await queue(() => getHosts().includes(host) &&
          update(getHosts().filter(value => value !== host), '已移除好友 IP。'));
        if (removed &&
            wasFocused && documentRef.activeElement === documentRef.body) input.focus();
      });
      chip.append(address, remove);
      chips.set(host, chip);
      list.append(chip);
    }
    list.hidden = hosts.length === 0;
  }
  async function update(hosts, message, quiet = false) {
    try {
      await save(hosts);
      render();
      if (!quiet) status.textContent = message;
      onSaved();
      return true;
    } catch {
      if (!quiet) status.textContent = '暂时无法保存好友 IP，请稍后重试。';
      else throw new Error('已加入房间，暂时无法记住好友 IP。');
      return false;
    }
  }
  function add(value, {quiet = false} = {}) {
    const host = privatePeerHost(value);
    return queue(async () => {
      await ready();
      const hosts = getHosts();
      if (!host || hosts.includes(host) || hosts.length >= maxPeerHosts) {
        if (!quiet) {
          status.textContent = !host ? '请输入有效的私有 IPv4 地址，例如 10.208.1.20。'
            : hosts.includes(host) ? '这个好友 IP 已保存。' : '最多保存 8 个好友 IP，请先移除一个。';
          if (!host) input.setAttribute('aria-invalid', 'true');
        }
        return false;
      }
      return update([...hosts, host], '已保存好友 IP，正在查找房间。', quiet);
    });
  }
  input.addEventListener('input', () => input.removeAttribute('aria-invalid'));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const value = input.value;
    if (await add(value) && input.value === value) input.value = '';
  });
  return {add, render};
}

export function formatDiscoveryDiagnostics(d = {}) {
  const number = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const mode = { 'multicast+broadcast': '组播 + 广播', multicast: '组播', broadcast: '广播' }[d.transport] || '尚未启动';
  const errors = { NO_PRIVATE_NETWORK: '未检测到局域网', NETWORK_INTERFACE_UNAVAILABLE: '所选网卡不可用', NETWORK_PERMISSION_DENIED: '系统拒绝网络权限', DISCOVERY_PORT_IN_USE: '查找端口被占用', PACKET_TOO_LARGE: '已丢弃超长网络包', DISCOVERY_SOCKET_ERROR: '网络读写失败' };
  return [
    `网卡：${String(d.interfaceName || '未检测到').slice(0, 128)} · ${String(d.localIPv4 || '无 IPv4').slice(0, 64)}`,
    `查找方式：${mode} · ${d.running ? '运行中（不代表网络已放行）' : '未运行'} · UDP 49877`,
    `好友 IP：${number(d.directPeers)} 个 · 直连查找包：发出 ${number(d.paths?.directUnicast?.queriesSent)}，收到 ${number(d.paths?.directUnicast?.queriesReceived)}`,
    `发出查找包：${number(d.queriesSent)}；收到其他程序查找包：${number(d.queriesReceived)}`,
    `发出房间回复：${number(d.repliesSent)}；收到有效房间回复：${number(d.repliesReceived)}`,
    `发送错误：${number(d.sendErrors)}；接收错误：${number(d.readErrors)}；最近错误：${errors[d.lastError] || '无'}`,
  ].join('\n');
}
