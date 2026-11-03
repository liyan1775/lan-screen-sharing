(function () {
  'use strict';
  var D = window.LanDemo;

  function discovery(s, h) {
    var ready = s.discovery === 'ready';
    var rooms = ready && Array.isArray(s.rooms) ? s.rooms : [];
    var content = rooms.length ? '<div class="ch-room-list">' + rooms.map(function (room) {
      var count = Math.max(0, Math.min(3, Number(room.count) || 0));
      var full = !!room.full || count >= 3;
      return '<article class="ch-room"><div class="ch-room-info"><h2>' + h.e(room.name) + '</h2><p>' + count + ' / 3 人 · ' + (room.sharing ? '正在共享画面' : '语音房间') + '</p></div>' +
        h.button('join', full ? '房间已满' : '加入房间', {icon:'arrow-right', kind:full?'quiet':'primary', disabled:full, value:room.id}) + '</article>';
    }).join('') + '</div>' : '<div class="ch-discovery-empty"><div class="ch-empty-symbol" aria-hidden="true">' + h.icon(s.discovery === 'blocked' ? 'warning' : 'people') + '</div><div><h2>' +
      (s.discovery === 'searching' ? '正在寻找附近的房间' : s.discovery === 'blocked' ? '暂时无法查找房间' : '附近还没有房间') + '</h2><p>' +
      (s.discovery === 'searching' ? '找到后会显示在这里。你也可以先创建房间。' : s.discovery === 'blocked' ? '可以重试，或使用地址手动加入。' : '先创建一个房间，邀请朋友一起聊。') + '</p><div class="ch-empty-actions">' +
      h.button('create', '创建房间', {icon:'plus',kind:'primary'}) + h.button('manual', '手动加入', {icon:'link'}) + '</div></div></div>';
    return '<section class="channel-entry ch-root">' + h.header(s) + '<main class="ch-entry-main"><div class="ch-entry-heading"><div><h1>附近的房间</h1><p>找到朋友，加入后再决定是否打开麦克风。</p></div>' + h.button('refresh', s.discovery === 'searching' ? '正在查找' : '刷新', {icon:'refresh',disabled:s.discovery==='searching'}) + '</div>' + h.notice(s) + content + '<p class="ch-entry-foot">没有找到朋友？ ' + h.button('manual', '手动加入', {icon:'link'}) + '</p></main></section>';
  }

  function activity(s, h) {
    if (s.connection !== 'connected') return '<div class="ch-activity-copy"><h2>正在等待连接恢复</h2><p>连接恢复后再查看成员和共享状态。</p></div>'; 
    if (!s.presenter) return '<div class="ch-activity-copy"><h2>现在可以先聊聊</h2><p>准备好时，房间里的任何人都可以分享画面。</p></div>' + h.shareButton(s);
    var name = h.memberLabel(s, s.presenter);
    var desc = s.presenter === 'self' ? '你的画面正在分享给房间里的朋友。' : '只聊语音时，画面和共享声音不会在本机播放。';
    return '<div class="ch-activity-copy"><h2>' + h.e(name) + '正在共享</h2><p>' + h.e(desc) + '</p></div>' +
      h.button('watch', '恢复观看', {icon:'eye',kind:'primary'});
  }

  function mic(s, h) {
    return h.button('mic', s.mic ? '关闭麦克风' : s.micDenied ? '重试麦克风' : '开启麦克风', {
      icon:s.mic ? 'mic' : 'mic-off', attrs:'aria-pressed="' + String(s.mic) + '"'
    });
  }

  function people(s, h, compact, skipPresenter) {
    return s.members.filter(function (m) { return !m.self && m.id !== 'self' && (!skipPresenter || m.id !== s.presenter); }).map(function (m) {
      return '<div class="ch-member">' + h.person(s, m.id, {compact:compact}) + '</div>';
    }).join('');
  }

  function self(s, h, compact, showPerson) {
    var member = s.members.find(function (m) { return m.self || m.id === 'self'; });
    if (!member) return '';
    return '<div class="ch-self">' + (showPerson ? h.person(s, member.id, {compact:compact}) : '<span class="ch-self-label">我的麦克风</span>') + mic(s, h) + '</div>';
  }

  function voice(s, h) {
    return '<section class="channel-voice ch-root">' + h.header(s) + '<main class="ch-voice-main">' + h.notice(s) +
      '<div class="ch-room-title"><div><h1>在一起</h1><p>选择一位成员，调整你听到的声音。</p></div><span>' + s.members.length + ' / 3 人</span></div>' +
      '<section class="ch-conversation" aria-label="房间里的成员"><div class="ch-people">' + people(s, h, false, false) + self(s, h, false, true) + '</div>' +
      '<div class="ch-activity">' + activity(s, h) + '</div></section>' +
      '</main></section>';
  }

  function watch(s, h) {
    var connected = s.connection === 'connected';
    var hasPresenter = !!s.presenter;
    var own = s.presenter === 'self';
    var soundStatus = !connected ? '连接恢复后再确认声音状态。' : own ? (s.systemShared ? '系统声音正在共享；隔离状态未确认。' : '当前没有共享系统声音。') : (s.systemShared ? '选择分享者可调节语音和共享声音。' : '这次没有共享系统声音；选择分享者可调节语音。');
    var present = hasPresenter ? '<div class="ch-presenter"><span class="ch-presenter-lead">' + (connected ? '正在分享' : '等待连接') + '</span>' + h.person(s, s.presenter, {compact:true}) +
      '<span class="ch-presenter-hint">' + h.e(soundStatus) + '</span></div>' : '<div class="ch-presenter"><span class="ch-presenter-lead">房间画面</span><span class="ch-presenter-hint">当前没有人共享</span></div>';
    var actions = h.button('voice', own ? '停止共享并只聊语音' : '只聊语音', {icon:'headphones'}) +
      (own ? h.shareButton(s) : '') + (hasPresenter ? h.button('fullscreen', '全屏观看', {icon:'fullscreen',disabled:!connected}) : '');
    var others = people(s, h, false, true);
    return '<section class="channel-watch ch-root">' + h.header(s) + '<main class="ch-watch-main">' +
      '<div class="ch-watch-notice">' + h.notice(s) + '</div>' + '<div class="ch-watch-layout"><div class="ch-watch-stage"><div class="ch-watch-frame">' + h.screen(s) + '</div><div class="ch-source-actions">' + actions + '</div></div>' +
      '<aside class="ch-watch-rail" aria-label="房间成员和声音"><div class="ch-rail-heading"><h2>房间里的声音</h2><p>选择成员，调整声音</p></div>' + present + '<div class="ch-watch-people">' + (others ? '<div class="ch-watch-others"><p class="ch-people-label">其他成员</p>' + others + '</div>' : '') + self(s, h, false, !own) + '</div></aside></div>' +
      (own ? '<p class="ch-impact ch-watch-impact">只聊语音会停止你的共享，麦克风状态不变。</p>' : '') +
      '</main></section>';
  }

  D.layouts.channel = { entry:discovery, voice:voice, watch:watch };
}());
