import { MeshMedia } from './media.js';
import { applyMicrophonePermission, isolationStatus, roomSummary } from './state.js';
import { RoomClient, ERROR_TEXT } from './client.js';
import { resetShareControls } from './ui-state.js';
import { bindLocalConnectionLifecycle } from './connection-lifecycle.js';
import { setPreviewStream } from './preview-playback.js';
import { PageLease } from './page-lease.js';
import { bindScreenFullscreen } from './fullscreen.js';
import { formatCaptureStats, formatVideoLinks, formatPerformanceHint, formatMediaDiagnostics } from './media-stats.js';
import { createRoomBrowser } from './room-browser.js';
import { formatSystemAudioDiagnostics } from './system-audio-isolation.js';
import { bindPlayerPointer } from './player-pointer.js';
import { MediaDiagnosticsHistory } from './media-history.js';
import { createMediaStatsPoller } from './media-stats-poller.js';
import { createRoomExperience } from './room-experience.js';
import { createRoomTextUI } from './room-text-ui.js';
import { formatRoomInvite, parseRoomInvite } from './room-invite.js';

const $ = (selector) => document.querySelector(selector);
const ui = {
  app: $('#app'), roleChooser: $('#role-chooser'), roomPanel: $('#room-panel'), role: $('#role-label'), status: $('#connection-status'),
  error: $('#error-message'), hostPanel: $('#host-panel'), viewerPanel: $('#viewer-panel'), roomCode: $('#room-code'), hostAddress: $('#host-address'), hostPort: $('#host-port'),
  members: $('#members'), sharePanel: $('#share-panel'), remoteScreen: $('#remote-screen'), shareMode: $('#share-mode'),
  isolation: $('#isolation-status'), quality: $('#quality-target'), targetText: $('#quality-target-text'), actualStats: $('#actual-stats'), audioSources: $('#audio-sources'),
  manualCheck: $('#manual-check'),
  settings: $('#settings-dialog'), diagnostics: $('.settings-section'), captureStats: $('#capture-stats'), performanceHint: $('#performance-hint'),
};

const client = new RoomClient();
const screenFullscreen = bindScreenFullscreen({ stage: ui.sharePanel, gestureTarget: document.querySelector('.screen-stage'), button: $('#fullscreen-screen'), onError: showError });
const playerPointer = bindPlayerPointer({ stage: document.querySelector('.screen-stage') });
let pageLease = null;
const localControlReady = client.loadLocalControl().then((bootstrap) => {
  pageLease = new PageLease({ token: bootstrap.localControlToken });
  void pageLease.start();
  return true;
}).catch(() => false);
let textUI = null;
const media = new MeshMedia(client, {
  onRemoteTrack: (mapped) => {
    if (mapped.role === 'screenVideo') updatePresentation();
  },
  onAudioSource: ({ peerId, role }) => { addAudioControl(peerId, role); updatePresentation(); },
  onState: (state) => handleMediaState(state),
  onText: message => textUI?.receive(message),
});
const experience = createRoomExperience(document);
textUI = createRoomTextUI({ documentRef:document, transport:media.text, nameForPeer:peerId => memberNames().find(member => member.peerId === peerId)?.displayName || '成员' });


let activeRole = '';
let currentRoomName = '';
let awaitingRecoveredPeers = false;
let latestMediaRows = [];
let statsInFlight = false;
let statsUnavailable = false;
let statsContext = '';
const mediaHistory = new MediaDiagnosticsHistory();
const statsPoller = createMediaStatsPoller({ sample: sampleStats, getState: () => ({
  active: !!client.room?.screenSharing && media.peers.size > 0,
  diagnosticsVisible: ui.settings.open && ui.diagnostics.open,
  hidden: document.visibilityState === 'hidden',
  context: `${client.room?.roomId ?? ''}:${client.room?.presenterPeerId ?? ''}`,
}) });
const nearbyRooms = createRoomBrowser({
  list: $('#discovered-rooms'), status: $('#discovery-status'), refreshButton: $('#refresh-rooms'),
  onDiagnostics: (text) => { $('#discovery-diagnostics').textContent = text; },
  onRooms: ({ count, available }) => { $('#empty-rooms').hidden = !available || count > 0; },
  load: async () => { await localControlReady; return client.loadRooms(); },
  onJoin: async (room) => {
    currentRoomName = String(room.name || '');
    try {
      if (!await chooseRole('viewer')) throw new Error('本机服务连接失败，请稍后再试。');
      ui.viewerPanel.hidden = true;
      setJoinInvite(room);
      await joinRoomFromInputs();
    } catch (error) {
      showRoomList(); showError(error.message); throw error;
    }
  },
});
void localControlReady.then((ready) => {
  if (ready) {
    nearbyRooms.start();
    if (client.prepareRestore()) connectionLifecycle.recover();
    else if (!activeRole) setStatus('本机程序已就绪', 'neutral');
  } else {
    $('#discovery-status').textContent = '本机服务尚未连接，请确认程序仍在运行后刷新页面。';
    if (!activeRole) setStatus('本机服务暂不可用', 'error');
  }
});

const connectionLifecycle = bindLocalConnectionLifecycle(client, media, () => {
  ui.roomPanel.hidden = true; ui.roleChooser.hidden = false; ui.sharePanel.hidden = true;
  ui.hostPanel.hidden = true; ui.viewerPanel.hidden = true; activeRole = '';
  $('#discovery-panel').hidden = false;
  ui.roomCode.textContent = '—'; ui.hostAddress.value = ''; ui.hostPort.value = '';
  const inviteCard = ui.hostAddress.closest('.invite-card');
  if (inviteCard) inviteCard.hidden = true;
  $('#create-room').disabled = false;
  $('#toggle-mic').textContent = '开启麦克风'; $('#toggle-mic').dataset.enabled = 'false';
  clearAudioControls();
  updateMembers(null);
  setStatus('房间未能恢复，请重新加入', 'error');
  showError('30 秒内未能恢复连接，或原房间已结束。采集已停止，请重新加入房间。');
}, {
  onRecovering: () => setStatus('连接暂时中断，正在自动恢复房间…', 'connecting'),
  onRecovered: () => { showError(''); setStatus('房间已恢复', 'connected'); },
});

function showError(text) {
  ui.error.textContent = text; ui.error.hidden = !text;
  document.querySelectorAll('.dialog-feedback').forEach(node => { node.textContent = text; node.hidden = !text || !node.closest('dialog').open; });
}
function syncPresentationStage() {
  const joined = !ui.roomPanel.hidden && !!client.room;
  const watching = joined && !!client.room.screenSharing && !media.voiceOnly;
  textUI?.sync(joined ? client.room.roomId || client.room.id : '');
  ui.app.dataset.stage = joined ? (watching ? 'watch' : 'voice') : (ui.roomPanel.hidden ? 'entry' : 'setup');
  $('#room-heading-title').textContent = joined ? (client.room?.name || currentRoomName || (activeRole === 'host' ? $('#room-name').value.trim() : '') || '房间') : (activeRole === 'host' ? '创建房间' : '手动加入');
  $('#leave-room').hidden = !joined || activeRole !== 'viewer';
  $('#end-room').hidden = !joined || activeRole !== 'host';
  $('#voice-only-warning').hidden = !(media.screenVideoTrack || media.pendingScreenStream);
  $('#voice-stage-message').textContent = media.voiceOnly && client.room?.screenSharing
    ? '只聊语音中；你可以随时恢复观看。' : '先聊着，准备好时可以共享画面。';
  let invite = '';
  try { invite = formatRoomInvite({ hostIPv4: ui.hostAddress.value, hostPort: ui.hostPort.value, roomCode: ui.roomCode.textContent }); }
  catch { /* A complete invitation is available only after creating or joining a room. */ }
  if ($('#invite-text').value !== invite) $('#invite-text').value = invite;
  experience.sync({ stage: ui.app.dataset.stage, roomName: $('#room-heading-title').textContent, memberCount: client.room?.members?.length || 0,
    roomId: client.room?.roomId || '',
    presenterPeerId: client.room?.presenterPeerId || '', presenterName: memberNames().find(member => member.peerId === client.room?.presenterPeerId)?.displayName,
    microphone: !!media.microphoneTrack, voiceOnly: media.voiceOnly, screenSharing: !!client.room?.screenSharing });
  syncBackgroundWork();
}
function setStatus(text, state = 'neutral') { if (ui.status.textContent !== text) ui.status.textContent = text; ui.status.dataset.state = state; syncPresentationStage(); }
function showRoom() { ui.roleChooser.hidden = true; ui.roomPanel.hidden = false; ui.role.textContent = activeRole === 'host' ? '房主' : '成员'; }
function showRoomList() {
  if (client.room) return;
  activeRole = ''; currentRoomName = '';
  ui.roomPanel.hidden = true; ui.roleChooser.hidden = false; ui.sharePanel.hidden = true;
  ui.hostPanel.hidden = true; ui.viewerPanel.hidden = true;
  $('#discovery-panel').hidden = false;
  syncPresentationStage();
}
function memberNames(snapshot = client.room) {
  let viewerNumber = 0;
  return roomSummary(snapshot, client.peerId || snapshot?.members?.[0]?.peerId || '').map((member) => ({
    ...member,
    displayName: member.role === 'host' ? '房主' : '成员 ' + (++viewerNumber),
  }));
}

function audioLabel(peerId, role, snapshot = client.room) {
  const name = memberNames(snapshot).find((member) => member.peerId === peerId)?.displayName || '成员';
  return name + ' · ' + (role === 'microphone' ? '语音' : '共享声音');
}

function updateMembers(snapshot = client.room) {
  const members = memberNames(snapshot);
  const existing = [...ui.members.querySelectorAll('.member-seat')];
  const others = members.filter(member => !member.self);
  const seats = [others[0], others[1], members.find(member => member.self)];
  const nodes = [];
  for (let i = 0; i < 3; i += 1) {
    const member = seats[i];
    const position = ['left', 'right', 'near'][i];
    let li = existing.find(node => member ? node.dataset.peerId === member.peerId : node.dataset.empty === 'true' && node.dataset.seat === position);
    if (!li) {
      li = document.createElement('article'); li.className = 'member-seat';
      const avatar = document.createElement('span'); avatar.className = 'member-avatar'; avatar.setAttribute('aria-hidden', 'true');
      const name = document.createElement('strong');
      const status = document.createElement('small'); status.className = 'member-status';
      const slot = document.createElement('div'); slot.className = member?.self ? 'seat-mic' : 'seat-audio';
      if (member && !member.self) { const waiting = document.createElement('p'); waiting.className = 'seat-audio-state'; waiting.textContent = '等待语音来源'; slot.append(waiting); }
      li.append(avatar, name, status, slot);
    }
    li.dataset.empty = String(!member); li.dataset.seat = position;
    if (member) { li.dataset.peerId = member.peerId; li.dataset.self = String(member.self); li.dataset.role = member.role; }
    li.querySelector('.member-avatar').textContent = member ? (member.self ? '我' : member.role === 'host' ? '房' : '成') : '+';
    li.querySelector('strong').textContent = member ? member.displayName + (member.self ? ' · 本机' : '') : '空位';
    li.querySelector('.member-status').textContent = member ? member.stateLabel + (member.peerId === snapshot?.presenterPeerId ? ' · 正在共享' : '') : '等待朋友加入';
    nodes.push(li);
  }
  const activity = $('#voice-activity');
  if (activity.parentElement === ui.members) nodes.splice(1, 0, activity);
  [...ui.members.children].filter(node => !nodes.includes(node)).forEach(node => {
    node.querySelectorAll('.audio-source').forEach(row => $('#audio-stash').append(row));
    if (node.contains($('#toggle-mic'))) $('#mic-home').append($('#toggle-mic'));
    node.remove();
  });
  nodes.forEach((node,index) => { if (ui.members.children[index] !== node) ui.members.insertBefore(node, ui.members.children[index] || null); });
  document.querySelectorAll('.audio-source').forEach((row) => {
    const label = audioLabel(row.dataset.peerId, row.dataset.role, snapshot);
    const title = row.querySelector?.('strong'); if (title) title.textContent = label;
    const volume = row.querySelector?.('input'); if (volume) volume.setAttribute('aria-label', label + '音量');
    const mute = row.querySelector?.('button'); if (mute) mute.setAttribute('aria-label', (mute.getAttribute('aria-pressed') === 'true' ? '取消静音' : '静音') + label);
  });
  syncPresentationStage();
}

function clearAudioControls() { document.querySelectorAll('.audio-source').forEach(row => row.remove()); }

function addAudioControl(peerId, role) {
  if ([...document.querySelectorAll('.audio-source')].some(row => row.dataset.peerId === peerId && row.dataset.role === role)) return;
  const row = document.createElement('div'); row.className = 'audio-source'; row.dataset.peerId = peerId; row.dataset.role = role;
  const title = document.createElement('strong'); title.textContent = audioLabel(peerId, role);
  const mute = document.createElement('button'); mute.type = 'button'; mute.textContent = '静音'; mute.setAttribute('aria-pressed', 'false'); mute.setAttribute('aria-label', '静音' + title.textContent);
  mute.addEventListener('click', () => { const next = mute.getAttribute('aria-pressed') !== 'true'; media.setAudioControl(peerId, role, { muted: next }); mute.setAttribute('aria-pressed', String(next)); mute.textContent = next ? '取消静音' : '静音'; mute.setAttribute('aria-label', mute.textContent + title.textContent); experience.syncAudio(); });
  const volume = document.createElement('input'); volume.type = 'range'; volume.min = '0'; volume.max = '1'; volume.step = '0.05'; volume.value = '1'; volume.setAttribute('aria-label', title.textContent + '音量');
  volume.addEventListener('input', () => { media.setAudioControl(peerId, role, { volume: volume.value }); experience.syncAudio(); });
  const output = document.createElement('output'); output.textContent = '100%';
  row.append(title, output, volume, mute); ui.audioSources.append(row); experience.syncAudio();
}

function handleMediaState(state) {
  if (state.state === 'autoplay_blocked') $('#enable-audio').hidden = false;
  if (state.state === 'audio_source_ended') document.querySelectorAll('.audio-source').forEach(row => { if (row.dataset.peerId === state.peerId && row.dataset.role === state.role) row.remove(); });
  if (state.state === 'audio_isolation') $('#system-audio-diagnostics').textContent = formatSystemAudioDiagnostics(state.diagnostics, navigator.userAgent);
  if (['remote_screen_ended','screen_started','capture_pending','capture_idle'].includes(state.state)) updatePresentation();
  if (state.state === 'screen_stopped') {
    resetShareControls({ start: $('#start-share'), stop: $('#stop-share'), verify: $('#manual-verify-start'), checklist: $('#manual-checklist'), manualCheck: ui.manualCheck });
    updatePresentation();
  }
  if (state.state === 'closed') { screenFullscreen.setAvailable(false); playerPointer.setAvailable(false); latestMediaRows = []; }
  if (state.state === 'closed') { $('#voice-only').textContent = '只聊语音'; $('#voice-only').setAttribute('aria-pressed', 'false'); }
  if (state.state === 'quality') ui.targetText.textContent = state.targetText;
  else if (state.state === 'capture_quality_unsupported') showError(state.message);
  else if (state.state === 'quality_unsupported' || state.state === 'quality_preference_unsupported' || state.state === 'screen_relay_error' || state.state === 'autoplay_blocked' || state.state === 'ICE_FAILED' || state.state === 'DISPLAY_NOT_MONITOR' || state.state === 'missing_audio') showError(state.message);
  else if (state.state === 'peer_closed') document.querySelectorAll('.audio-source').forEach((row) => { if (row.dataset.peerId === state.peerId) row.remove(); });
  else if (state.state === 'closed') { $('#toggle-mic').textContent = '开启麦克风'; $('#toggle-mic').dataset.enabled = 'false'; clearAudioControls(); ui.isolation.textContent = state.isolation.label; ui.isolation.dataset.state = state.isolation.state; document.querySelector('.screen-stage')?.classList.remove('has-video'); setPreviewStream(ui.remoteScreen, null); ui.shareMode.value = 'combined'; resetShareControls({ start: $('#start-share'), stop: $('#stop-share'), verify: $('#manual-verify-start'), checklist: $('#manual-checklist'), manualCheck: ui.manualCheck }); updateSystemAudioUI(); }
  else if (state.state === 'connected') setStatus('媒体已连接', 'connected');
  syncPresentationStage();
}

function showSharedCapture(result) {
  media.setVoiceOnly(false);
  $('#voice-only').textContent = '只聊语音'; $('#voice-only').setAttribute('aria-pressed', 'false');
  screenFullscreen.setAvailable(true);
  playerPointer.setAvailable(true);
  ui.remoteScreen.muted = true; setPreviewStream(ui.remoteScreen, result.stream);
  ui.isolation.textContent = result.isolation.label; ui.isolation.dataset.state = result.isolation.state;
  document.querySelector('.screen-stage').classList.add('has-video');
  $('#start-share').disabled = true;
  $('#stop-share').disabled = false; $('#stop-share').textContent = '停止屏幕共享';
  updateSystemAudioUI();
  updatePresentation();
}

function updateSystemAudioUI() {
  const active = !!media.systemAudioTrack && media.systemAudioTrack.readyState !== 'ended' && media.captureMode === 'combined';
  $('#stop-system-audio').disabled = !active;
  $('#manual-verify-start').disabled = !active;
  $('#system-audio-note').textContent = active
    ? media.isolation.state === 'browser_reported' || media.isolation.state === 'manual_pass'
      ? '系统声音正在共享；隔离状态见下方，听感检查为可选。'
      : '系统声音正在共享；隔离未确认，可能包含房间语音。需要时可单独停止系统声音。'
    : ui.shareMode.value === 'combined'
      ? '共享时将包含系统声音；请在浏览器选择显示器并允许共享系统音频。'
      : '当前选择不共享系统声音；画面与房间语音仍可正常共享。';
}

function showPendingAudioChoice() {
  ui.isolation.textContent = media.isolation.label; ui.isolation.dataset.state = media.isolation.state;
  $('#stop-share').disabled = false; $('#stop-share').textContent = '取消待处理画面';
  ui.shareMode.value = 'limited';
  $('#start-share').textContent = '继续共享画面与语音（无游戏声）'; $('#manual-verify-start').hidden = true;
  $('#manual-checklist').hidden = true;
  showError('未捕获屏幕音频。画面尚未共享；点击“继续共享画面与语音（无游戏声）”即可继续，或取消本次捕获。');
  setStatus('系统声音不可用，等待你的选择', 'error');
}

async function chooseRole(role) {
  showError('');
  activeRole = role;
  setStatus('正在连接本机服务…', 'connecting');
  try {
    await client.connect({ role });
    showRoom();
    $('#discovery-panel').hidden = true;
    ui.hostPanel.hidden = role !== 'host'; ui.viewerPanel.hidden = role !== 'viewer';
    $('#host-share-controls').hidden = false;
    $('#browse-rooms').hidden = !!client.room;
    updateMembers();
    setStatus('本机信令已连接', 'connected');
    if (role === 'host') {
      if (!client.room) { $('#room-name').disabled = false; $('#room-discoverable').disabled = false; }
      const endpoint = client.bootstrap;
      if (endpoint.lanIPv4 && endpoint.signalPort) { ui.hostAddress.value = endpoint.lanIPv4; ui.hostPort.value = endpoint.signalPort; }
    }
    return true;
  } catch (error) { showError(error.message); setStatus('连接失败', 'error'); return false; }
}

$('#choose-viewer').addEventListener('click', () => chooseRole('viewer'));
$('#quick-create-room').addEventListener('click', () => chooseRole('host'));
$('#empty-create-room').addEventListener('click', () => chooseRole('host'));
$('#quick-manual-join').addEventListener('click', () => { currentRoomName = ''; void chooseRole('viewer'); });
$('#copy-discovery-diagnostics').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#discovery-diagnostics').textContent); $('#copy-discovery-diagnostics').textContent = '已复制'; }
  catch { showError('无法自动复制，请选中查找诊断文字后手动复制。'); }
});
$('#browse-rooms').addEventListener('click', () => { showRoomList(); void nearbyRooms.refresh(); });
$('#host-panel').addEventListener('submit', event => event.preventDefault());
$('#create-room').addEventListener('click', async event => {
  event.preventDefault();
  $('#create-room').disabled = true;
  showError(''); setStatus('正在创建房间…', 'connecting');
  $('#browse-rooms').disabled = true;
  try {
    const room = await client.createRoom({ name: $('#room-name').value.trim(), discoverable: $('#room-discoverable').checked !== false });
    if (room.name) $('#room-name').value = room.name;
    currentRoomName = room.name || $('#room-name').value.trim();
    ui.roomCode.textContent = room.roomCode;
    ui.hostAddress.value = client.bootstrap.lanIPv4 ?? '';
    ui.hostPort.value = client.bootstrap.signalPort ?? '';
    const inviteCard = ui.hostAddress.closest('.invite-card');
    if (inviteCard) inviteCard.hidden = !ui.hostAddress.value || !ui.hostPort.value;
    if (!ui.hostAddress.value || !ui.hostPort.value) showError('没有可用的局域网信令地址。请检查网络或用 --lan-ip 选择有效的私网 IPv4 后重启程序。');
    media.setIdentity(client.peerId || client.room?.members?.[0]?.peerId || '', 'host');
    updateMembers(); setStatus('房间已创建，等待朋友加入', 'connected'); ui.sharePanel.hidden = false;
    $('#host-share-controls').hidden = false;
    $('#create-room').disabled = true;
  } catch (error) { showError(error.message); setStatus('房间创建失败', 'error'); }
  finally { $('#browse-rooms').disabled = false; if (!client.room) $('#create-room').disabled = false; }
});

$('#copy-invite').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#invite-text').value);
    $('#copy-invite').textContent = '已复制'; setTimeout(() => { $('#copy-invite').textContent = '复制邀请信息'; }, 1500);
  } catch {
    $('#invite-text').focus(); $('#invite-text').select();
    showError('无法自动复制，已选中完整邀请信息，请按 Ctrl+C 复制。');
  }
});

function setJoinInvite(details) {
  const invite = formatRoomInvite(details);
  const normalized = parseRoomInvite(invite);
  $('#join-invite').value = invite;
  $('#join-address').value = normalized.hostIPv4;
  $('#join-port').value = String(normalized.hostPort);
  $('#join-code').value = normalized.roomCode;
  for (const id of ['join-invite', 'join-address', 'join-port', 'join-code']) $(`#${id}`).removeAttribute('aria-invalid');
}
$('#join-invite').addEventListener('input', () => { $('#join-invite').removeAttribute('aria-invalid'); });
for (const id of ['join-address', 'join-port', 'join-code']) {
  $(`#${id}`).addEventListener('input', () => {
    $('#join-invite').value = ''; $('#join-invite').removeAttribute('aria-invalid');
    $(`#${id}`).removeAttribute('aria-invalid');
  });
}
$('#viewer-panel').addEventListener('submit', event => event.preventDefault());
$('#join-room').addEventListener('click', async event => {
  event.preventDefault();
  const pasted = $('#join-invite').value.trim();
  const manual = !pasted && $('#join-manual-fields').open;
  if (manual && !ui.viewerPanel.reportValidity()) return;
  try {
    setJoinInvite(manual
      ? { hostIPv4: $('#join-address').value, hostPort: $('#join-port').value, roomCode: $('#join-code').value }
      : parseRoomInvite(pasted));
  } catch (error) {
    showError(error.message);
    const field = manual ? $('#join-address') : $('#join-invite');
    field.setAttribute('aria-invalid', 'true'); field.focus();
    return;
  }
  try { await joinRoomFromInputs(); } catch { /* The shared action already shows the error. */ }
});
async function joinRoomFromInputs() {
  $('#join-room').disabled = true;
  showError(''); setStatus('正在加入房间…', 'connecting');
  $('#browse-rooms').disabled = true;
  try {
    const snapshot = await client.joinRoom({ hostIPv4: $('#join-address').value, hostPort: $('#join-port').value, roomCode: $('#join-code').value });
    media.setIdentity(snapshot.peerId, 'viewer');
    ui.roomCode.textContent = $('#join-code').value; ui.hostAddress.value = $('#join-address').value; ui.hostPort.value = $('#join-port').value;
    const inviteCard = ui.hostAddress.closest('.invite-card'); if (inviteCard) inviteCard.hidden = false;
    updateMembers({ ...snapshot, members: snapshot.members ?? [] });
    ui.sharePanel.hidden = false; ui.viewerPanel.hidden = true;
    setStatus('已加入房间，正在连接媒体…', 'connected');
  } catch (error) { showError(error.message); setStatus('加入失败', 'error'); throw error; }
  finally { $('#browse-rooms').disabled = false; $('#join-room').disabled = false; }
}

$('#toggle-mic').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  if (media.microphoneTrack) {
    media.microphoneTrack.stop(); await media.setMicrophoneTrack(null); button.textContent = '开启麦克风'; button.dataset.enabled = 'false'; syncPresentationStage(); return;
  }
  try {
    const capture = navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    await media.setMicrophoneFromCapture(capture); button.textContent = '关闭麦克风'; button.dataset.enabled = 'true'; showError('');
  } catch (error) {
    if (error.code === 'CAPTURE_CANCELLED') return;
    const state = applyMicrophonePermission({ joined: !!client.room, microphone: 'requesting' }, false);
    showError(ERROR_TEXT[state.code]); button.textContent = '重试麦克风';
  }
  syncPresentationStage();
});

$('#start-share').addEventListener('click', async () => {
  showError('');
  const mode = ui.shareMode.value;
  if (media.pendingScreenStream) {
    if (mode !== 'limited') { showError('未捕获屏幕音频。当前画面尚未共享；请明确选择“画面 + 语音（无游戏声音）”，或取消捕获。'); return; }
    try {
      const result = await media.acceptPendingScreenAsLimited();
      showSharedCapture(result);
      $('#start-share').textContent = '选择显示器并开始共享';
      $('#manual-checklist').hidden = true;
      setStatus('仅共享画面与房间语音', 'connected');
      showError('已按你的选择共享画面与语音；当前没有游戏声音。');
    } catch (error) { showError(error.message); }
    return;
  }
  // startScreenFromGesture calls getDisplayMedia before its first await, preserving the click activation.
  try {
    const result = await media.startScreenFromGesture(mode);
    if (result.captureState === 'missing_audio') { showPendingAudioChoice(); return; }
    showSharedCapture(result);
    $('#start-share').textContent = '选择显示器并开始共享';
    setStatus('正在共享屏幕', 'connected');
  } catch (error) {
    if (error.code === 'CAPTURE_CANCELLED') return;
    if (error.name === 'NotAllowedError') showError('已取消屏幕选择。');
    else showError(ERROR_TEXT[error.code] ?? '屏幕采集未能开始。');
  }
});

$('#stop-share').addEventListener('click', async () => {
  screenFullscreen.setAvailable(false);
  setPreviewStream(ui.remoteScreen, null);
  if (media.pendingScreenStream) {
    await media.discardPendingScreen();
    $('#stop-share').disabled = true; $('#stop-share').textContent = '停止屏幕共享';
    $('#start-share').disabled = false; $('#start-share').textContent = '选择显示器并开始共享'; $('#manual-verify-start').hidden = false; $('#manual-verify-start').disabled = false;
    ui.isolation.textContent = media.isolation.label; ui.isolation.dataset.state = media.isolation.state;
    setStatus('已取消待处理的屏幕捕获', 'connected'); showError('已取消屏幕捕获，画面未共享。');
    return;
  }
  await media.setScreenStream(null);
  setPreviewStream(ui.remoteScreen, null); document.querySelector('.screen-stage').classList.remove('has-video');
  ui.isolation.textContent = media.isolation.label; ui.manualCheck.hidden = false; $('#manual-checklist').hidden = true;
  $('#stop-share').disabled = true; $('#start-share').disabled = false; $('#manual-verify-start').hidden = false; $('#manual-verify-start').disabled = false; setStatus('屏幕已停止，成员语音仍保持连接', 'connected');
  updateSystemAudioUI();
});

$('#share-mode').addEventListener('change', () => {
  updateSystemAudioUI();
  if (!media.pendingScreenStream) return;
  $('#start-share').textContent = ui.shareMode.value === 'limited' ? '仅共享画面与语音' : '选择无游戏声音模式后继续';
});

$('#quality-target').addEventListener('change', async () => {
  const quality = ui.quality.value; await media.setQuality(quality);
});
$('#pause-background-preview').addEventListener('change', () => {
  media.pauseBackgroundPreview = $('#pause-background-preview').checked;
  updatePresentation();
});
$('#share-cursor').addEventListener('change', async () => { await media.setShareCursor($('#share-cursor').checked); });
$('#copy-media-diagnostics').addEventListener('click', async () => {
  await sampleStats();
  const report = [formatMediaDiagnostics({ track: media.screenVideoTrack, rows: latestMediaRows, target: ui.quality.value, shareCursor: media.shareCursor,
    visibility: document.visibilityState,
    audio: formatSystemAudioDiagnostics(media.systemAudioDiagnostics, navigator.userAgent) }), mediaHistory.format()].join('\n\n');
  try { await navigator.clipboard.writeText(report); $('#copy-media-diagnostics').textContent = '媒体诊断已复制'; }
  catch { showError('无法自动复制，请手动复制画质统计与系统声音兼容性诊断。'); }
});
$('#copy-background-site').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(new URL('/', location.href).href);
    $('#copy-background-site').textContent = '已复制，可粘贴到 Edge 的站点例外';
  } catch { showError('无法自动复制，请复制浏览器地址栏中的 localhost 地址。'); }
});

$('#voice-only').addEventListener('click', async () => {
  const voiceOnly = !media.voiceOnly;
  if (voiceOnly && (media.screenVideoTrack || media.pendingScreenStream)) await media.setScreenStream(null);
  media.setVoiceOnly(voiceOnly);
  $('#voice-only').textContent = voiceOnly ? '恢复观看' : '只聊语音';
  $('#voice-only').setAttribute('aria-pressed', String(voiceOnly));
  updatePresentation();
});

$('#enable-audio').addEventListener('click', async () => {
  const ok = await media.resumeAudio(); if (!ok) showError('仍有音频播放被浏览器阻止，请检查网站声音权限。'); else showError('');
  $('#enable-audio').hidden = ok;
});

$('#stop-system-audio').addEventListener('click', async () => {
  try {
    await media.setSystemAudioTrack(null);
    ui.shareMode.value = 'limited'; $('#manual-checklist').hidden = true;
    showError(''); setStatus('系统声音已停止，画面与成员语音继续', 'connected');
  } catch { showError('系统声音采集已停止，但部分连接未确认；如仍有异常，请停止共享后重新加入。'); }
  updateSystemAudioUI();
});

$('#manual-verify-start').addEventListener('click', () => {
  if (!media.systemAudioTrack || media.captureMode !== 'combined') return;
  showError('');
  $('#manual-checklist').hidden = false;
  $('#manual-check-status').textContent = '可让成员轮流说话，听游戏声音是否正常、语音是否重复。结果仅记录听感，不会自动停止系统声音；你可以随时点击“停止共享系统声音”。';
});
$('#manual-verify-pass').addEventListener('click', () => finishManualCheck('pass'));
$('#manual-verify-fail').addEventListener('click', async () => finishManualCheck('fail'));
async function finishManualCheck(result) {
  if (!media.systemAudioTrack || media.captureMode !== 'combined') return;
  media.isolation = isolationStatus({ supported: true, requested: true, settings: { restrictOwnAudio: true }, manualResult: result });
  ui.isolation.textContent = media.isolation.label; ui.isolation.dataset.state = media.isolation.state;
  $('#manual-checklist').hidden = true;
  if (result === 'fail') showError('已记录可能存在回声，系统声音继续共享；需要时请点“停止共享系统声音”。');
  else showError('');
  media.publishMediaState();
  updateSystemAudioUI();
}

$('#leave-room').addEventListener('click', async () => {
  setPreviewStream(ui.remoteScreen, null);
  client.reconnectWanted = false;
  connectionLifecycle.cancel();
  showError(''); setStatus('正在离开房间…', 'connecting');
  try { await client.leaveRoom(); }
  catch (error) {
    client.close(); client.room = null; client.peerId = ''; client.resumeToken = ''; client.joinDetails = null;
    showError('未能确认离开房间，已断开本机连接。' + error.message);
  }
  await media.closeAll();
  showRoomList();
  setStatus('已离开房间', 'neutral'); updateMembers(null);
});

$('#end-room').addEventListener('click', async () => {
  if (!await experience.confirm({title:'结束这个房间？', description:'所有成员的语音、画面和文字连接都会断开。朋友需要新的邀请才能再次加入。', action:'结束房间'}, $('#end-room'))) return;
  connectionLifecycle.cancel();
  setPreviewStream(ui.remoteScreen, null);
  showError(''); setStatus('正在结束房间…', 'connecting');
  try {
    await client.endRoom(); await media.closeAll();
    showRoomList();
    setStatus('房间已结束', 'neutral');
  } catch {
    client.cancelRecovery(); client.close(); client.room = null; client.peerId = '';
    await media.closeAll(); showRoomList(); updateMembers(null);
    setStatus('已退出本机房间', 'neutral');
    showError('未能向其他成员确认结束。本机已停止采集并退出；如果房主连接没有恢复，房间将在保留期后关闭。');
  }
});

$('#exit-program').addEventListener('click', async () => {
  if (!await experience.confirm({title:'退出本机程序？', description:client.room && activeRole === 'host' ? '你是房主。退出将结束房间，所有成员都会断开连接。' : '本机的语音、画面和文字连接会停止。再次使用时需要重新运行程序。', action:'退出程序'}, $('#exit-program'))) return;
  nearbyRooms.stop();
  statsPoller.stop();
  setPreviewStream(ui.remoteScreen, null);
  await localControlReady;
  client.reconnectWanted = false;
  client.explicitlyLeaving = true;
  connectionLifecycle.cancel();
  try {
    if (client.room && client.role === 'viewer') await client.leaveRoom();
    else if (client.room && client.role === 'host') await client.endRoom();
  } catch { /* Local shutdown still ends this process's rooms. */ }
  await media.closeAll();
  client.close();
  try {
    const result = await fetch('/api/v1/shutdown', { method: 'POST', credentials: 'same-origin', headers: { 'X-Local-Control-Token': client.bootstrap?.localControlToken ?? '' } });
    if (!result.ok) throw new Error('shutdown rejected');
    setStatus('本机程序正在退出；本页即将断开。', 'neutral');
  } catch {
    showError('退出请求未能发送。请重试；关闭最后一个项目页面后程序也会自动退出。');
    setStatus('本机程序仍在运行', 'error');
  }
});

client.addEventListener('message', (event) => {
  const message = event.detail;
  if (message.recovered) {
    activeRole = client.role; currentRoomName = client.room?.name || '';
    showRoom(); ui.hostPanel.hidden = true; ui.viewerPanel.hidden = true; ui.sharePanel.hidden = false;
    media.setIdentity(client.peerId, client.role);
    for (const peerId of [...media.peers.keys()]) void media.closePeer(peerId);
    awaitingRecoveredPeers = true;
    const invite = client.role === 'host'
      ? {hostIPv4:client.bootstrap?.lanIPv4, hostPort:client.bootstrap?.signalPort, roomCode:client.room?.roomCode}
      : client.joinDetails;
    if (invite) {
      ui.hostAddress.value = invite.hostIPv4 || ''; ui.hostPort.value = invite.hostPort || ''; ui.roomCode.textContent = invite.roomCode || '';
      const card = ui.hostAddress.closest('.invite-card'); if (card) card.hidden = !ui.hostAddress.value;
    }
    if (client.room?.presenterPeerId === client.peerId) {
      if (!media.screenVideoTrack) void client.releasePresentation().catch(() => {});
      else media.publishMediaState();
    }
  }
  if (message.type === 'room.created') {
    $('#room-name').disabled = true; $('#room-discoverable').disabled = true;
    const peerId = message.peerId;
    client.peerId = peerId; media.setIdentity(peerId, 'host');
    ui.roomCode.textContent = message.payload?.roomCode ?? '—';
    ui.hostAddress.value = client.bootstrap?.lanIPv4 ?? ''; ui.hostPort.value = client.bootstrap?.signalPort ?? '';
    const card = ui.hostAddress.closest('.invite-card'); if (card) card.hidden = !ui.hostAddress.value || !ui.hostPort.value;
    ui.sharePanel.hidden = false; $('#create-room').disabled = true; updateMembers();
  } else if (message.type === 'room.joined') {
    const snapshot = { members: message.payload?.members ?? [] };
    updateMembers(snapshot); media.setIdentity(client.peerId, 'viewer');
    if (!awaitingRecoveredPeers) for (const member of snapshot.members) if (member.peerId !== client.peerId) media.addPeer(member.peerId, member.role);
    if (client.room?.presenterPeerId === client.peerId) {
      if (!media.screenVideoTrack && !media.captureAttempt) void client.releasePresentation().catch(() => {});
      else media.publishMediaState();
    }
    setStatus('已加入房间，正在建立语音连接', 'connected');
  } else if (message.type === 'peer.joined') {
    if (message.peerId !== client.peerId) media.addPeer(message.peerId, message.payload?.role ?? 'viewer');
    updateMembers();
  } else if (message.type === 'peer.left') {
    // Always clear local membership/media state, even when the leave request already rejected.
    const departed = message.payload?.peerId ?? message.peerId;
    void media.closePeer(departed);
    if (message.selfLeft || departed === client.peerId) {
      setPreviewStream(ui.remoteScreen, null);
      void media.closeAll(); showRoomList();
      setStatus('已离开房间', 'neutral');
    }
    updateMembers();
  } else if (message.type === 'room.state') {
    if (!message.payload?.resumed) awaitingRecoveredPeers = false;
    updateMembers();
    if (!awaitingRecoveredPeers) for (const member of message.payload?.members ?? []) if (member.peerId !== client.peerId) media.addPeer(member.peerId, member.role);
  } else if (message.type === 'peer.state' && message.payload?.restartMedia && message.peerId !== client.peerId) {
    void media.closePeer(message.peerId);
    const member = client.room?.members?.find(member => member.peerId === message.peerId);
    if (member) media.addPeer(member.peerId, member.role);
  } else if (message.type === 'room.ended') {
    setPreviewStream(ui.remoteScreen, null);
    void media.closeAll(); showRoomList();
    $('#create-room').disabled = false;
    setStatus(message.payload?.reason === 'session_replaced' ? '房间已在另一个页面恢复，本页已退出' : '房间已结束，可以加入其他房间', 'neutral'); showError('');
  } else if (message.type === 'rtc.description' || message.type === 'rtc.candidate' || message.type.startsWith('screen.')) {
    media.handleSignal(message.type, message.payload ?? {}).catch(() => showError('媒体协商失败，请重新加入房间。'));
  }
  if (message.type.startsWith('room.') || message.type.startsWith('peer.')) updatePresentation();
});

function updatePresentation() {
  syncPresentationStage();
  $('#discovery-panel').hidden = !!client.room || (!!activeRole && !ui.roomPanel.hidden);
  $('#browse-rooms').hidden = !!client.room;
  const presenter = client.room?.presenterPeerId ?? '';
  media.setPresenter(presenter);
  const own = presenter === client.peerId && !!presenter;
  const occupiedByOther = !!presenter && !own;
  document.querySelectorAll('.audio-source').forEach((row) => { row.hidden = row.dataset.role === 'systemAudio' && row.dataset.peerId !== presenter; });
  const stream = !media.voiceOnly && client.room?.screenSharing
    ? (own ? media.screenStream : media.remoteScreens.get(presenter)) : null;
  const hasVideo = !!stream?.getVideoTracks?.().some((track) => track.readyState !== 'ended');
  const pauseLocalPreview = own && media.pauseBackgroundPreview && (document.visibilityState === 'hidden' || document.hasFocus?.() === false);
  const playing = hasVideo && !pauseLocalPreview;
  if (ui.remoteScreen.srcObject !== (playing ? stream : null)) setPreviewStream(ui.remoteScreen, playing ? stream : null, () => showError('浏览器阻止画面播放，请点击“启用声音”后重试。'));
  document.querySelector('.screen-stage')?.classList.toggle('has-video', playing);
  screenFullscreen.setAvailable(playing);
  playerPointer.setAvailable(playing);
  if (!own || !media.screenVideoTrack) { $('#performance-hint').hidden = true; $('#performance-hint').textContent = ''; }
  ui.role.textContent = activeRole === 'host' ? '房主' : '成员';
  $('#host-share-controls').hidden = !client.room;
  $('#start-share').disabled = occupiedByOther || !!media.screenVideoTrack || !!media.captureAttempt;
  $('#stop-share').disabled = !media.screenVideoTrack && !media.pendingScreenStream;
  updateSystemAudioUI();
  $('#sharing-permission').textContent = occupiedByOther ? '其他成员正在共享。等对方停止后，你就可以开始；现在仍可一起语音聊天。' : '任何成员都能共享；同一时间共享一块画面。停止共享后仍可继续语音。';
  $('#presentation-status').textContent = pauseLocalPreview ? '正在共享 · 已暂停本机预览' : media.voiceOnly ? '只聊语音 · 画面与游戏声音已在本机暂停' : occupiedByOther ? '正在连接成员共享的画面' : '语音房间 · 还没有人共享画面';
  syncPresentationStage();
}

client.addEventListener('errorMessage', (event) => {
  const error = event.detail;
  showError(error.text);
  if (error.code === 'MIC_PERMISSION_DENIED') $('#toggle-mic').textContent = '重试麦克风';
});
client.addEventListener('connected', () => setStatus('本机信令已连接', 'connected'));

async function sampleStats() {
  if (statsInFlight) return;
  statsInFlight = true;
  try {
    statsUnavailable = false;
    if (!media.peers.size || !client.room?.screenSharing) {
      latestMediaRows = [];
      return;
    }
    const roomId = client.room?.roomId;
    const presenter = client.room?.presenterPeerId;
    const own = presenter === client.peerId;
    const snapshots = await media.getStatsSnapshot({ peerIds: own ? null : [presenter], videoOnly: true });
    if (roomId !== client.room?.roomId || presenter !== client.room?.presenterPeerId || !client.room?.screenSharing) return;
    const activeVideo = snapshots.filter(row => own ? row.direction === 'outbound-rtp' : row.direction === 'inbound-rtp');
    latestMediaRows = activeVideo;
    mediaHistory.record({ rows: activeVideo, visibility: document.visibilityState, target: ui.quality.value });
  } catch { statsUnavailable = true; }
  finally { statsInFlight = false; renderStats(); }
}

function renderStats() {
  if (document.visibilityState === 'hidden' || !ui.settings.open || !ui.diagnostics.open) return;
  const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };
  const rows = client.room?.screenSharing ? latestMediaRows : [];
  const memberName = peerId => {
    const members = client.room?.members ?? [];
    const member = members.find(item => item.peerId === peerId);
    return member?.role === 'host' ? '房主' : `成员${Math.max(1, members.findIndex(item => item.peerId === peerId))}`;
  };
  const text = !client.room ? '实际统计：等待媒体连接' : !media.peers.size ? '等待其他成员；可以先开启麦克风聊天'
    : !client.room.screenSharing ? '当前没有画面传输，可继续语音聊天' : statsUnavailable ? '实际统计暂不可用'
      : formatVideoLinks(rows, memberName) || '等待画面传输统计';
  setText(ui.actualStats, text);
  ui.captureStats.hidden = !media.screenVideoTrack;
  setText(ui.captureStats, formatCaptureStats(media.screenVideoTrack, rows));
  const hint = media.screenVideoTrack ? formatPerformanceHint(rows, Number.parseInt(ui.quality.value.slice(-2), 10)) : '';
  setText(ui.performanceHint, hint);
  ui.performanceHint.hidden = !hint;
}

function syncBackgroundWork() {
  const context = `${client.room?.roomId ?? ''}:${client.room?.presenterPeerId ?? ''}:${!!client.room?.screenSharing}`;
  if (context !== statsContext) { statsContext = context; latestMediaRows = []; statsUnavailable = false; }
  nearbyRooms.setActive(ui.app.dataset.stage === 'entry' && document.visibilityState !== 'hidden');
  statsPoller.sync();
  renderStats();
}

ui.settings.addEventListener('toggle', syncBackgroundWork);
ui.diagnostics.addEventListener('toggle', syncBackgroundWork);
document.addEventListener('visibilitychange', () => { updatePresentation(); syncBackgroundWork(); });
globalThis.addEventListener?.('blur', () => { if (media.screenVideoTrack) updatePresentation(); });
globalThis.addEventListener?.('focus', () => { if (media.screenVideoTrack) updatePresentation(); });
syncBackgroundWork();
