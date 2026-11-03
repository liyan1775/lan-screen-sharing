(function () {
  'use strict';
  var layouts = window.LanDemo.layouts;

  function roomBar(s, h, watching, sourceText) {
    var count = (s.members || []).length;
    var status = s.connection === 'connected' ? '已连接' : s.connection === 'reconnecting' ? '正在重连' : '连接已断开';
    return '<div class="edge-room-bar"><div class="edge-room-identity"><span class="edge-brand">LAN <span>/ 分享</span></span>' +
      '<button type="button" class="d-button edge-room-pill" data-action="room-menu" aria-label="' + h.e(s.roomName + ' · ' + count + ' 人') + '"><span>' + h.e(s.roomName + ' · ' + count + ' 人') + '</span>' + h.icon('chevron-down') + '</button>' +
      '<span class="edge-status">' + h.e(sourceText || status) + '</span></div>' +
      '<div class="edge-room-actions">' + (watching && s.presenter ? h.button('fullscreen', '全屏', { icon: 'fullscreen', kind: 'quiet', disabled: s.connection !== 'connected' }) : '') + h.button('invite', '邀请', { icon: 'link', kind: 'quiet' }) +
      h.button('leave', s.owner ? '结束房间' : '离开房间', { icon: 'leave', kind: 'quiet' }) + '</div></div>';
  }

  function roomList(s, h) {
    if (s.discovery === 'searching') return '<div class="edge-list-message"><strong>正在寻找附近的房间</strong><span>请稍候，或手动加入。</span></div>';
    if (s.discovery === 'blocked') return '<div class="edge-list-message"><strong>暂时无法搜索房间</strong><span>可以重试，或使用房间地址手动加入。</span>' + h.button('retry', '重试', { icon: 'refresh', kind: 'quiet' }) + '</div>';
    if (s.discovery === 'empty' || !s.rooms || !s.rooms.length) return '<div class="edge-list-message"><strong>附近还没有房间</strong><span>创建一个房间，或通过地址加入。</span></div>';
    return '<div class="edge-room-list">' + s.rooms.map(function (room) {
      var full = !!room.full || Number(room.count) >= 3;
      var detail = room.count + ' 人' + (room.sharing ? ' · 正在共享' : ' · 语音房间') + (full ? ' · 已满' : '');
      return '<article class="edge-room-row"><div><strong>' + h.e(room.name) + '</strong><span>' + h.e(detail) + '</span></div>' +
        h.button('join', full ? '房间已满' : '加入房间', { icon: 'arrow-right', kind: full ? 'quiet' : 'primary', value: room.id, disabled: full }) + '</article>';
    }).join('') + '</div>';
  }

  layouts.edge = {
    entry: function (s, h) {
      return '<section class="edge-entry">' + h.header(s) + '<main class="edge-discovery">' +
        '<div class="edge-discovery-heading"><div><span class="edge-eyebrow">局域网房间</span><h1>找到一起玩的人</h1><p>加入附近的房间，或创建一个新房间。</p></div>' +
        h.button('refresh', '刷新', { icon: 'refresh', kind: 'quiet' }) + '</div>' +
        roomList(s, h) + '<div class="edge-entry-actions">' + h.button('create', '创建房间', { icon: 'plus', kind: 'primary' }) +
        h.button('manual', '手动加入', { icon: 'link', kind: 'quiet' }) + '</div></main></section>';
    },
    voice: function (s, h) {
      var people = (s.members || []).map(function (member) {
        var label = h.memberLabel(s, member.id);
        return '<span class="edge-person"><span class="edge-person-mark" aria-hidden="true">' + h.e(label.slice(0, 1)) + '</span><span>' + h.e(label) + (member.self ? ' · 你' : '') + '</span></span>';
      }).join('');
      return '<section class="edge-voice' + (!s.presenter && s.connection === 'connected' ? ' edge-has-offer' : '') + '">' + roomBar(s, h) + '<main class="edge-voice-main">' + h.notice(s) +
        '<div class="edge-voice-content"><span class="edge-eyebrow">语音房间</span><h1>自在聊，一起玩</h1><p>只聊语音时，本机不会播放共享画面和游戏声音。</p>' +
        '<div class="edge-people" aria-label="房间成员">' + people + '</div>' +
        (s.connection !== 'connected' ? '<p class="edge-voice-hint">连接中断，语音与画面等待恢复。</p>' : s.presenter ? '<p class="edge-voice-hint">' + h.e(h.memberLabel(s, s.presenter)) + '正在共享。你可以选择观看。</p>' + h.button('watch', '回到观看', { icon: 'eye', kind: 'primary' }) : '<p class="edge-voice-hint">现在没有画面，房间语音仍可继续。准备好时，你可以分享自己的屏幕。</p>' + h.shareButton(s)) +
        '</div></main><div class="edge-controls">' + h.controls(s, { compact: true }) + '</div></section>';
    },
    watch: function (s, h) {
      var own = s.presenter === 'self';
      var stage = s.presenter ? h.screen(s) : '<div class="edge-empty-stage"><div><h1>现在没有共享画面</h1><p>' + (s.connection === 'connected' ? '房间语音仍可继续，你可以选择分享自己的屏幕。' : '连接尚未恢复，请稍后再分享。') + '</p>' + h.shareButton(s) + '</div></div>';
      var sourceText = s.presenter ? (s.connection !== 'connected' ? '等待连接恢复' : own ? (s.systemShared ? '你的系统声音正在共享，隔离未确认' : '你正在共享画面，无系统声音') : h.memberLabel(s, s.presenter) + (s.systemShared ? '正在共享画面和声音' : '正在共享画面，无系统声音')) : '';
      var mic = h.button('mic', s.mic ? '关闭麦克风' : s.micDenied ? '重试麦克风' : '开启麦克风', {icon:s.mic?'mic':'mic-off',attrs:'aria-pressed="' + String(!!s.mic) + '"'});
      var voice = s.presenter ? h.button('voice', own ? '停止共享并只聊语音' : '只聊语音', {icon:'headphones'}) : '';
      var controls = '<div class="edge-action-left">' + mic + voice + (own ? h.shareButton(s) : '') + '</div><div class="edge-action-right">' + h.button('sound', '声音', {icon:'speaker'}) + '</div>';
      return '<section class="edge-watch">' + roomBar(s, h, true, sourceText) + '<div class="edge-notice">' + h.notice(s) + '</div>' + '<main class="edge-stage">' + stage + '</main>' + '<div class="edge-action-bar" aria-label="房间操作">' + controls + '</div></section>';

    }
  };
}());
