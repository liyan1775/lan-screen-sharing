(function () {
  'use strict';
  var D = window.LanDemo;

  function seats(count) {
    var n = Math.max(0, Math.min(3, Number(count) || 0));
    return '<span class="portal-seats" aria-hidden="true">' + [0, 1, 2].map(function (i) {
      return '<i class="' + (i < n ? 'portal-seat-filled' : '') + '"></i>';
    }).join('') + '</span>';
  }
  function occupancy(count) {
    var n = Math.max(0, Math.min(3, Number(count) || 0));
    return '<div class="portal-occupancy"><span>' + n + ' / 3 人</span>' + seats(n) + '</div>';
  }
  function roomObject(room, h, s) {
    var count = Math.max(0, Math.min(3, Number(room.count) || 0));
    var full = !!room.full || count >= 3;
    var joining = s.joiningRoom != null && String(s.joiningRoom) === String(room.id);
    return '<article class="portal-object" data-sharing="' + String(!!room.sharing) + '" data-full="' + String(full) + '" data-room-id="' + h.e(room.id) + '"' + (joining ? ' data-joining="true" tabindex="-1" aria-busy="true"' : '') + '><div class="portal-object-body">' +
      '<h2>' + h.e(room.name) + '</h2>' + occupancy(count) +
      '<p class="portal-sharing">' + h.icon('screen') + '<span>' + (room.sharing ? '正在共享画面' : '语音房间 · 暂无画面') + '</span></p>' +
      '<div class="portal-object-foot">' + (joining ? '<span id="portal-joining-status" class="portal-joining" role="status" tabindex="-1">正在加入这个房间…</span>' : h.button('join', full ? '房间已满' : '加入房间', {icon:'arrow-right', kind:room.sharing && !full?'primary':'quiet', disabled:full, value:room.id})) +
      '<span>' + (full ? '已满 3 人' : '还有 ' + (3 - count) + ' 个位置') + '</span></div></div></article>';
  }
  function identity(s, h) {
    var connected = s.connection === 'connected';
    var state = !connected ? '等待连接恢复' : !s.presenter ? '语音房间 · 暂无画面' : h.memberLabel(s,s.presenter) + '正在共享画面';
    return '<div class="portal-identity"><span class="portal-identity-tab" aria-hidden="true"></span><div class="portal-identity-main">' +
      '<div class="portal-identity-copy"><span class="portal-object-kicker">已加入的房间</span><h1>' + h.e(s.roomName) + '</h1><p class="portal-sharing">' + h.icon('screen') + '<span>' + h.e(state) + '</span></p></div>' + occupancy(s.members.length) + '</div></div>';
  }
  function microphone(s,h) {
    return h.button('mic',s.mic ? '关闭麦克风' : s.micDenied ? '重试麦克风' : '开启麦克风', {icon:s.mic?'mic':'mic-off',attrs:'aria-pressed="'+String(!!s.mic)+'"'});
  }
  function roomControls(s,h) {
    return '<div class="portal-controls" aria-label="房间操作">' + microphone(s,h) + h.button('sound','声音',{icon:'speaker'}) + '</div>';
  }
  function members(s,h) {
    return '<div class="portal-room-presence"><span class="portal-presence-caption">房间里的 ' + s.members.length + ' 人</span><div class="portal-presence-list">' +
      s.members.map(function (member) { return typeof h.person === 'function' ? h.person(s,member.id,{compact:true}) : '<span>' + h.e(h.memberLabel(s,member.id)) + (member.self ? ' · 本机' : '') + '</span>'; }).join('') + '</div></div>'; 
  }
  function activity(s,h) {
    if (s.connection !== 'connected') return '<div class="portal-voice-copy"><h2>正在等待连接恢复</h2><p>连接恢复后，可以继续查看房间的共享状态。</p></div>';
    if (!s.presenter) return '<div class="portal-voice-copy"><h2>先聊着，随时分享</h2><p>任何成员都可以开始共享画面。</p></div><div class="portal-voice-action">' + h.shareButton(s) + '</div>';
    var self = s.presenter === 'self';
    return '<div class="portal-voice-copy"><h2>' + h.e(h.memberLabel(s,s.presenter)) + '正在共享</h2><p>' + (self ? '你的画面正在分享给朋友。' : '只聊语音时，本机不播放画面和共享声音。') + '</p></div><div class="portal-voice-action">' + h.button('watch','观看画面',{icon:'eye',kind:'primary'}) + (self ? h.shareButton(s) : '') + '</div>';
  }
  D.layouts.portal = {
    entry: function (s,h) {
      var rooms = s.discovery === 'ready' && Array.isArray(s.rooms) ? s.rooms : [];
      var status = {ready:'发现 ' + rooms.length + ' 个房间',searching:'正在查找同一局域网',empty:'暂未发现房间',blocked:'附近房间暂不可用'}[s.discovery] || '';
      var content = rooms.length ? '<div class="portal-objects">' + rooms.map(function(room){return roomObject(room,h,s);}).join('') + '</div>' :
        '<div class="portal-empty"><div class="portal-empty-mark" aria-hidden="true">' + h.icon(s.discovery==='blocked'?'warning':'people') + '</div><div><h2>' + (s.discovery==='searching'?'正在寻找房间':s.discovery==='blocked'?'附近房间暂不可用':'附近还没有房间') + '</h2><p>' + (s.discovery==='searching'?'发现结果会显示在这里。':'可以创建房间，或通过地址手动加入。') + '</p><div class="portal-empty-actions">' + h.button('create','创建房间',{icon:'plus',kind:'primary'}) + h.button('manual','手动加入',{icon:'link'}) + (s.discovery==='blocked'?h.button('refresh','重新查找',{icon:'refresh'}):'') + '</div></div></div>';
      return '<section class="portal-entry">' + h.header(s) + '<main class="portal-entry-main"><div class="portal-entry-heading"><div><h1>附近的房间</h1><p class="portal-discovery">' + h.e(status) + '</p></div>' + h.button('refresh','刷新',{icon:'refresh',disabled:s.discovery==='searching'}) + '</div>' + h.notice(s) + content + '<div class="portal-entry-help"><span>没有找到朋友的房间？</span>' + h.button('manual','手动加入',{icon:'arrow-right'}) + '</div></main></section>';
    },
    voice: function (s,h) {
      return '<section class="portal-voice">' + h.header(s,{compact:true}) + '<main class="portal-room-main">' + h.notice(s) + '<div class="portal-room-shell">' + identity(s,h) + '<div class="portal-room-content"><div class="portal-activity">' + activity(s,h) + '</div>' + members(s,h) + '</div></div>' + roomControls(s,h) + '</main></section>';
    },
    watch: function (s,h) {
      var connected = s.connection === 'connected';
      var content = s.presenter ? '<div class="portal-screen-wrap">' + h.screen(s) + '</div>' : '<div class="portal-watch-empty"><h2>现在没有共享画面</h2><p>房间还在，语音可以继续。</p>' + (connected ? h.shareButton(s) : '') + '</div>';
      var presenterControl = s.presenter && typeof h.person === 'function' ? '<div class="portal-presenter-control"><span>' + (s.presenter === 'self' ? '我的声音' : '分享者的声音') + '</span>' + h.person(s,s.presenter,{compact:true}) + '</div>' : '';
      var actions = s.presenter ? h.button('voice',s.presenter==='self'?'停止共享并只聊语音':'只聊语音',{icon:'headphones'}) + (s.presenter==='self'?h.shareButton(s):'') + h.button('fullscreen','全屏观看',{icon:'fullscreen',disabled:!connected}) : h.button('voice','回到语音',{icon:'arrow-left'});
      return '<section class="portal-watch">' + h.header(s,{compact:true}) + '<main class="portal-room-main portal-watch-main">' + h.notice(s) + '<div class="portal-room-shell portal-room-shell-watch">' + identity(s,h) + '<div class="portal-watch-actions">' + presenterControl + actions + '</div>' + content + '</div>' + roomControls(s,h) + (s.presenter==='self'?'<p class="portal-impact">选择只聊语音会停止你的共享，麦克风状态不变。</p>':'') + '</main></section>';
    }
  };
}());
