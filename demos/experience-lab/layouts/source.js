(function () {
  'use strict';
  var D = window.LanDemo = window.LanDemo || {};
  D.layouts = D.layouts || {};

  function roomRows(s, h) {
    if (s.discovery === 'ready' && s.rooms.length) {
      return '<ul class="so-rooms">' + s.rooms.map(function (room) {
        var full = !!room.full || Number(room.count) >= 3;
        return '<li class="so-room-row"><div class="so-room-copy"><strong>' + h.e(room.name) + '</strong><span>' + h.e(room.count) + ' / 3 人 · ' + (room.sharing ? '正在共享' : '语音房间') + '</span></div>' + h.button('join', full ? '房间已满' : '加入房间', { value: room.id, kind: full ? 'quiet' : 'primary', disabled: full }) + '</li>';
      }).join('') + '</ul>';
    }
    var text = s.discovery === 'searching' ? '正在寻找附近的房间…' : s.discovery === 'blocked' ? '暂时无法发现房间。你仍可以创建房间或手动加入。' : '附近还没有房间。可以创建一个，或手动加入朋友的房间。';
    return '<div class="so-empty-list"><p>' + text + '</p>' + h.button('refresh', '重新查找', { icon: 'refresh', disabled: s.discovery === 'searching' }) + '</div>';
  }

  function entry(s, h) {
    return '<section class="source-entry so-entry">' + h.header(s) + '<main class="so-entry-main"><div class="so-entry-intro"><p class="so-kicker">局域网 · 最多三人</p><h1>找到朋友，<br>一起看点什么。</h1><p>先加入同一个房间，需要分享时再打开画面。</p></div><section class="so-discovery" aria-labelledby="so-discovery-title"><div class="so-discovery-heading"><div><h2 id="so-discovery-title">附近的房间</h2><p>每个人都在自己的电脑运行程序。</p></div>' + h.button('refresh', '刷新', { icon: 'refresh', disabled: s.discovery === 'searching' }) + '</div>' + h.notice(s) + roomRows(s, h) + '<div class="so-entry-actions">' + h.button('create', '创建房间', { icon: 'plus', kind: 'primary' }) + h.button('manual', '手动加入', { icon: 'link' }) + '</div><p class="so-footnote">加入后麦克风默认关闭，由你决定何时开启。</p></section></main></section>';
  }

  function otherPeople(s, h) {
    var others = s.members.filter(function (person) { return person.id !== s.presenter; });
    var free = Math.max(0, 3 - s.members.length);
    return '<aside class="so-people" aria-label="房间成员"><div class="so-people-heading"><h2>房间成员</h2><span>' + h.e(s.members.length) + ' / 3</span></div><div class="so-person-list">' + others.map(function (person) { return '<div class="so-person">' + h.person(s, person.id, { compact: true }) + '</div>'; }).join('') + '</div>' + (free ? '<p class="so-free">还可加入 ' + free + ' 人</p>' : '') + '</aside>';
  }

  function mic(s, h) {
    return h.button('mic', s.mic ? '关闭麦克风' : s.micDenied ? '重试麦克风' : '开启麦克风', { icon: s.mic ? 'mic' : 'mic-off', attrs: 'aria-pressed="' + String(!!s.mic) + '"' });
  }

  function source(s, h, watching) {
    if (!s.presenter) {
      if (s.connection !== 'connected') return '<div class="so-idle"><div class="so-idle-mark" aria-hidden="true">' + h.icon('screen') + '</div><p class="so-overline">画面状态等待确认</p><h1>正在等待连接恢复</h1><p>连接恢复后，再确认房间里的共享状态。</p></div>';
      return '<div class="so-idle"><div class="so-idle-mark" aria-hidden="true">' + h.icon('screen') + '</div><p class="so-overline">画面暂时空着</p><h1>现在在房间里</h1><p>先聊着。想分享时，任何成员都可以打开画面。</p><div class="so-idle-actions">' + (watching ? mic(s, h) : '') + h.shareButton(s) + '</div></div>';
    }
    var label = h.memberLabel(s, s.presenter);
    var connected = s.connection === 'connected';
    var status = connected ? (s.presenter === 'self' ? '你正在共享' : label + '正在共享') : '正在等待连接恢复';
    var detail = !connected ? '连接恢复前不会把旧画面当成直播。' : s.presenter === 'self' ? (s.systemShared ? '系统声音正在共享；隔离状态未确认。只聊语音会停止你的共享。' : '当前没有共享系统声音。只聊语音会停止你的共享。') : !s.systemShared ? '这次没有共享系统声音。' : watching ? '可分别调整此人的语音和共享声音。' : '只聊语音中，本机不播放画面和共享声音。';
    var action = s.presenter === 'self' ? h.shareButton(s) + (watching ? h.button('voice', '只聊语音', { icon: 'headphones' }) : '') : watching ? h.button('voice', '只聊语音', { icon: 'headphones' }) : h.button('watch', '观看画面', { icon: 'eye', kind: 'primary', disabled: !connected });
    var screen = watching ? '<div class="so-screen">' + h.screen(s, { demoOnly: true }) + '</div>' : '<div class="so-voice-space"><span aria-hidden="true">' + h.icon('screen') + '</span><p>' + (connected ? '当前保留语音；画面由你决定是否观看。' : '房间仍可查看，连接恢复后可继续。') + '</p></div>';
    if (watching) {
      var inlineStatus = !connected ? '等待连接恢复' : s.presenter === 'self' ? (s.systemShared ? '你正在共享 · 系统声音隔离未确认' : '你正在共享 · 没有系统声音') : (s.systemShared ? '正在共享 · 点按调整声音' : '正在共享 · 没有系统声音');
      var ownWarning = s.presenter === 'self' ? '<p class="so-own-warning">选择只聊语音会停止你的共享。</p>' : '';
      return '<div class="so-active"><div class="so-source-head so-watch-head"><div class="so-watch-source"><div class="so-source-caption">画面来源</div>' + h.person(s, s.presenter, { compact: true }) + '<span class="so-source-status">' + h.e(inlineStatus) + '</span></div><div class="so-source-actions">' + mic(s, h) + action + (connected ? h.button('fullscreen', '全屏观看', { icon: 'fullscreen' }) : '') + '</div>' + ownWarning + '</div>' + screen + '</div>';
    }
    return '<div class="so-active"><div class="so-source-head"><div class="so-source-identity"><p class="so-overline">画面来源</p>' + h.person(s, s.presenter, { compact: true }) + '<h1>' + h.e(status) + '</h1><p>' + h.e(detail) + '</p></div><div class="so-source-actions">' + action + '</div></div>' + screen + '</div>';
  }

  function room(s, h, watching) {
    var intro = watching ? '' : '<div class="so-room-top"><div><p class="so-kicker">' + h.e(s.roomName) + '</p><h2>和朋友在一起</h2></div><div class="so-quick">' + mic(s, h) + h.button('sound', '声音', { icon: 'speaker' }) + '</div></div>';
    var footer = watching ? '' : '<div class="so-room-end"><p>音量只影响你在本机听到的声音。</p></div>';
    return '<section class="source-' + (watching ? 'watch' : 'voice') + ' so-room">' + h.header(s, { compact: true }) + '<main class="so-main">' + h.notice(s) + intro + '<div class="so-stage">' + otherPeople(s, h) + '<section class="so-content" aria-label="当前共享">' + source(s, h, watching) + '</section></div>' + footer + '</main></section>';
  }

  D.layouts.source = { entry: entry, voice: function (s, h) { return room(s, h, false); }, watch: function (s, h) { return room(s, h, true); } };
}());
