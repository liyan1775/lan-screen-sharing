(function () {
  'use strict';
  window.LanDemo = window.LanDemo || {};
  window.LanDemo.layouts = window.LanDemo.layouts || {};

  function seat(s, h, member, position) {
    if (!member) return '<div class="orbit-seat orbit-seat-empty orbit-seat-' + position + '"><span class="orbit-avatar" aria-hidden="true">+</span><span>空位</span><small>等待加入</small></div>';
    var label = h.memberLabel(s, member.id);
    var isSelf = member.self || member.id === 'self';
    var control;
    if (isSelf) {
      control = '<div class="orbit-seat-control">' + h.button('mic', s.mic ? '关闭麦克风' : s.micDenied ? '重试麦克风' : '打开麦克风', { icon: s.mic ? 'mic' : 'mic-off', kind: 'quiet', attrs: 'aria-pressed="' + String(!!s.mic) + '"' }) + '</div>';
    } else {
      var id = member.id;
      var volume = typeof s.volumes[id] === 'number' ? s.volumes[id] : 1;
      var muted = !!s.muted[id];
      var unavailable = s.connection !== 'connected' || (s.audioAvailable && s.audioAvailable[id] === false);
      var unavailableText = s.connection === 'reconnecting' ? '正在重连' : s.connection !== 'connected' ? '连接已断开' : '等待该成员语音';
      var inputId = 'orbit-volume-' + h.e(id);
      control = '<div class="orbit-seat-control"><div class="orbit-volume-heading"><label for="' + inputId + '">我听到的语音</label><output for="' + inputId + '">' + (unavailable ? unavailableText : muted ? '已静音' : Math.round(volume * 100) + '%') + '</output></div><div class="orbit-volume-row"><input id="' + inputId + '" type="range" min="0" max="1" step="0.05" value="' + volume + '" data-volume="' + h.e(id) + '" aria-label="' + h.e(label) + '的本机语音音量"' + (unavailable ? ' disabled' : '') + '>' + h.button('mute', muted ? '取消静音' : '静音', { icon: muted ? 'speaker-off' : 'speaker', kind: 'quiet', value: id, disabled: unavailable, attrs: 'aria-pressed="' + String(muted) + '" aria-label="' + (muted ? '取消静音' : '静音') + h.e(label) + '"' }) + '</div>' + (s.presenter === id ? h.button(h.person ? 'member' : 'sound', '语音与共享声音', { icon:'sliders', value:h.person ? id : undefined }) : '') + '</div>';
    }
    var state = isSelf ? (s.mic ? '麦克风已开启' : s.micDenied ? '麦克风权限被拒绝' : '麦克风已关闭') : (s.connection === 'connected' ? '在房间中' : '等待连接');
    return '<div class="orbit-seat orbit-seat-' + position + (isSelf ? ' orbit-seat-self' : '') + '"><span class="orbit-avatar" aria-hidden="true">' + h.e(isSelf ? '我' : label.slice(0, 1)) + '</span><div class="orbit-seat-name">' + h.e(label) + (isSelf ? '<span class="orbit-you">本机</span>' : '') + '</div><small' + (isSelf && s.mic ? ' class="orbit-mic-on"' : '') + '>' + state + '</small>' + control + '</div>';
  }

  function shared(s, h) {
    var active = !!s.presenter;
    var connected = s.connection === 'connected';
    var own = s.presenter === 'self';
    var title = !connected ? '等待连接恢复' : active ? h.e(h.memberLabel(s, s.presenter)) + '正在共享' : '还没有人共享';
    var detail = !connected ? '连接恢复后再继续。' : !active ? '先聊着，任何人都可以开始共享。' : own ? '你的共享正在进行。' : '只聊语音时，本机不播放画面和共享声音。';
    var action = !connected ? h.button('retry','重试连接',{icon:'refresh'}) : !active ? h.shareButton(s) : own ? h.shareButton(s) + h.button('watch','观看画面',{icon:'eye'}) : h.button('watch','观看画面',{icon:'eye',kind:'primary'});
    var sound = active && connected ? '<p>' + (s.systemShared ? (own ? '系统声音正在发送，隔离状态未确认。' : '共享声音在只聊语音时暂停。') : '这次没有共享系统声音。') + '</p>' : '';
    return '<div class="orbit-shared"><div class="orbit-shared-mark" aria-hidden="true">' + h.icon('screen') + '</div><div><h2>' + title + '</h2><p>' + detail + '</p>' + sound + '</div><div class="orbit-shared-actions">' + action + '</div></div>';
  }

  function entry(s, h) {
    var rows = '';
    if (s.discovery === 'ready' && s.rooms.length) {
      rows = s.rooms.map(function (room) {
        var full = !!room.full || Number(room.count) >= 3;
        return '<div class="orbit-room-row"><div class="orbit-room-symbol" aria-hidden="true">' + h.icon('people') + '</div><div class="orbit-room-info"><strong>' + h.e(room.name) + '</strong><span>' + h.e(room.count) + ' / 3 人 · ' + (room.sharing ? '正在共享' : '语音中') + '</span></div>' + h.button('join', full ? '房间已满' : '加入房间', { icon: full ? undefined : 'arrow-right', kind: full ? 'quiet' : 'primary', value: room.id, disabled: full }) + '</div>';
      }).join('');
    } else {
      var message = s.discovery === 'searching' ? '正在寻找局域网中的房间…' : s.discovery === 'blocked' ? '暂时无法发现房间，请检查连接后重试。' : '还没有发现房间，创建一个或手动加入吧。';
      rows = '<div class="orbit-empty"><span class="orbit-empty-icon" aria-hidden="true">' + h.icon(s.discovery === 'blocked' ? 'warning' : 'people') + '</span><p>' + message + '</p>' + h.button('refresh', '重新查找', { icon: 'refresh', kind: 'quiet', disabled: s.discovery === 'searching' }) + '</div>';
    }
    return '<section class="orbit-entry">' + h.header(s) + '<main class="orbit-lobby"><div class="orbit-lobby-heading"><div><span class="orbit-eyebrow">局域网房间</span><h1>和朋友坐在一起</h1><p>加入房间，先聊聊天，想分享时再打开画面。</p></div><div class="orbit-lobby-actions">' + h.button('create', '创建房间', { icon: 'plus', kind: 'primary' }) + h.button('manual', '手动加入', { icon: 'link', kind: 'quiet' }) + '</div></div><div class="orbit-list-heading"><h2>附近的房间</h2>' + h.button('refresh', '刷新', { icon: 'refresh', kind: 'quiet', disabled: s.discovery === 'searching' }) + '</div><div class="orbit-room-list">' + rows + '</div><p class="orbit-lobby-note">加入后麦克风默认关闭，你可以随时打开。</p></main></section>';
  }

  function voice(s, h) {
    var self = s.members.find(function (member) { return member.self || member.id === 'self'; }) || null;
    var others = s.members.filter(function (member) { return !member.self && member.id !== 'self'; }).slice(0, 2);
    var left = others.find(function (member) { return member.id === 'owner'; }) || null;
    var right = others.find(function (member) { return member.id === 'friend'; }) || null;
    others.forEach(function (member) { if (member !== left && member !== right) { if (!left) left = member; else if (!right) right = member; } });
    return '<section class="orbit-voice">' + h.header(s) + '<main class="orbit-room"><div class="orbit-room-intro"><div><span class="orbit-eyebrow">对话中</span><h1>围坐在一起</h1></div><div class="orbit-room-tools">' + h.button('sound', '声音设置', { icon: 'headphones', kind: 'quiet' }) + h.button('settings', '设置', { icon: 'settings', kind: 'quiet' }) + '</div></div>' + h.notice(s) + '<div class="orbit-table">' + seat(s, h, left, 'left') + shared(s, h) + seat(s, h, right, 'right') + seat(s, h, self, 'near') + '</div></main></section>';
  }

  function watch(s, h) {
    var own = s.presenter === 'self';
    var connected = s.connection === 'connected';
    var presenter = s.presenter ? (h.person ? h.person(s, s.presenter, {compact:true}) : '<strong>' + h.e(h.memberLabel(s, s.presenter)) + '</strong>') : '<strong>当前没有人共享</strong>';
    var mic = h.button('mic', s.mic ? '关闭麦克风' : s.micDenied ? '重试麦克风' : '开启麦克风', {icon:s.mic?'mic':'mic-off', attrs:'aria-pressed="' + String(!!s.mic) + '"'});
    return '<section class="orbit-watch">' + h.header(s, { compact: true }) + '<main class="orbit-watch-main">' + h.notice(s) + '<div class="orbit-watch-heading"><div class="orbit-watch-presenter">' + presenter + '<span>' + (!connected ? '等待连接恢复' : s.presenter ? (own ? '正在分享' : '正在分享') : '可以开始共享') + '</span></div><div class="orbit-watch-actions">' + mic + (own ? h.shareButton(s) : '') + h.button('voice', own ? '只聊语音（停止我的共享）' : '回到对话', { icon: 'headphones', kind: 'quiet' }) + (s.presenter && connected ? h.button('fullscreen', '全屏观看', { icon: 'fullscreen', kind: 'quiet' }) : '') + h.button('sound', '声音', {icon:'speaker'}) + '</div></div><div class="orbit-screen-wrap">' + h.screen(s) + '</div></main></section>';
  }
  window.LanDemo.layouts.orbit = { entry: entry, voice: voice, watch: watch };
}());
