(function () {
  'use strict';
  var D = window.LanDemo;
  function e(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function icon(name) { return '<span class="d-icon" aria-hidden="true">' + (D.icons[name] || D.icons.screen || '') + '</span>'; }
  function label(s, id) { var person = s.members.find(function (m) { return m.id === id; }); return person ? (person.self ? (s.owner ? '房主 · 我' : '我') : person.label) : '成员'; }
  D.makeHelpers = function (s) {
    function button(action, text, options) {
      var o = options || {}, unavailable = !!o.disabled || (!!s.busy && ['join', 'create', 'share', 'refresh'].indexOf(action) >= 0);
      var extra = typeof o.attrs === 'string' ? o.attrs : '';
      var val = o.value === undefined ? '' : ' data-value="' + e(o.value) + '"';
      return '<button type="button" class="d-button ' + (o.kind === 'primary' ? 'd-primary' : o.kind === 'danger' ? 'd-danger' : 'd-quiet') + '" data-action="' + e(action) + '"' + val + (unavailable ? ' disabled' : '') + (extra ? ' ' + extra : '') + '>' + (o.icon ? icon(o.icon) : '') + '<span>' + e(text) + '</span></button>';
    }
    function shareButton(x) {
      if (x.presenter === 'self') return button('stop-share', '停止共享', { icon: 'screen', kind: 'danger' });
      return button('share', x.presenter ? '其他成员共享中' : '共享我的屏幕', { icon: 'screen', kind: 'primary', disabled: !!x.presenter || x.connection !== 'connected' });
    }
    function header(x) {
      var brand = '<div class="d-brand"><span class="d-brand-mark" aria-hidden="true">L</span><span>LAN <span class="d-brand-muted">/ 分享</span></span></div>';
      var context = x.scene === 'room' ? '<span class="d-header-room" title="' + e(x.roomName) + '">' + e(x.roomName) + '</span><span class="d-header-state">' + x.members.length + ' 人 · ' + (x.connection === 'connected' ? '已在房间' : x.connection === 'reconnecting' ? '正在重连' : '连接中断') + '</span>' : '';
      var actions = x.scene === 'room' ? button('invite', '邀请朋友', {icon:'link'}) + button('settings', '设置', {icon:'settings'}) + button('leave', x.owner ? '结束房间' : '离开房间', {icon:'leave'}) : button('manual', '手动加入', {icon:'link'}) + button('create', '创建房间', {icon:'plus',kind:'primary'});
      return '<header class="d-header">' + brand + '<div class="d-header-context">' + context + '</div><div class="d-header-actions">' + actions + '</div></header>';
    }
    function notice(x) {
      var text = x.error || (x.scene === 'room' && x.connection !== 'connected' ? '连接中断（演示）：画面已暂停，语音也待恢复。可重试连接或离开。' : x.micDenied ? '麦克风未开启（演示）：权限被拒绝，仍可观看和收听。可以重试麦克风。' : '');
      if (!text) return '';
      return '<div class="d-notice" role="alert">' + icon('warning') + '<span>' + e(text) + '</span>' + button('retry', '重试', {icon:'refresh'}) + '</div>';
    }
    function screen(x, options) {
      if (!x.presenter || x.connection !== 'connected') return '<figure class="d-screen"><div class="d-screen-empty">' + icon(x.presenter ? 'refresh' : 'screen') + '<h2>' + (x.presenter ? '正在等待连接恢复' : '共享已结束') + '</h2><p>' + (x.presenter ? '不会把上一帧误当成正在直播' : '仍在房间里，可以继续语音') + '</p>' + (!x.presenter ? shareButton(x) : button('retry', '重试连接', {icon:'refresh'})) + '</div></figure>';
      var caption = options && options.demoOnly ? '演示画面' : e(label(x, x.presenter)) + '正在共享 <span>· 演示画面</span>';
      return '<figure class="d-screen"><img class="d-screen-image" src="assets/game-scene.png" alt="虚构冒险游戏场景，作为直播画面的演示素材"><figcaption class="d-screen-caption">' + icon('screen') + caption + '</figcaption></figure>';
    }
    function controls(x) {
      var mic = button('mic', x.mic ? '关闭麦克风' : x.micDenied ? '重试麦克风' : '开启麦克风', {icon:x.mic?'mic':'mic-off',attrs:'aria-pressed="' + String(x.mic) + '"'}).replace('class="d-button ', 'class="d-button d-control--mic ');
      var share = shareButton(x).replace('class="d-button ', 'class="d-button d-control--share ');
      var view = button(x.view === 'watch' ? 'voice' : 'watch', x.view === 'watch' ? '只聊语音' : '观看画面', {icon:x.view==='watch'?'headphones':'eye',disabled:x.view!=='watch'&&!x.presenter}).replace('class="d-button ', 'class="d-button d-control--view ');
      var sound = button('sound', '声音', {icon:'speaker'}).replace('class="d-button ', 'class="d-button d-control--sound ');
      var settings = button('settings', '设置', {icon:'settings'}).replace('class="d-button ', 'class="d-button d-control--settings ');
      return '<div class="d-controls">' + mic + share + view + sound + settings + '</div>';
    }
    function audio(x) {
      var entries = x.members.filter(function (m) {return !m.self;}).map(function (m) { return {id:m.id,name:m.label+'语音'}; });
      if (x.presenter && x.presenter !== 'self' && x.systemShared) entries.push({id:'system',name:'共享声音'});
      return '<div class="d-audio-list">' + entries.map(function (row) {
        var value = x.volumes[row.id] === undefined ? 1 : x.volumes[row.id], muted = !!x.muted[row.id], paused = row.id === 'system' && x.view === 'voice';
        return '<div class="d-audio-row"><label for="audio-' + e(row.id) + '">' + e(row.name) + (paused ? ' · 只聊语音时暂停' : '') + '</label><output for="audio-' + e(row.id) + '">' + (muted ? '已静音' : Math.round(value*100)+'%') + '</output><div class="d-audio-range"><input id="audio-' + e(row.id) + '" data-volume="' + e(row.id) + '" type="range" min="0" max="1" step="0.05" value="' + value + '" aria-label="' + e(row.name) + '的本机音量"' + (paused ? ' disabled' : '') + '>' + button('mute', muted?'取消静音':'静音', {icon:muted?'speaker-off':'speaker',value:row.id,disabled:paused,attrs:'aria-pressed="'+String(muted)+'"'}) + '</div></div>';
      }).join('') + '</div>' + (!entries.length ? '<p class="d-audio-note">还没有其他成员的声音。</p>' : '') + '<p class="d-audio-note">只调整你在本机听到的音量。' + (x.presenter==='self'&&x.systemShared?'你的系统声音发给朋友，本机不重复播放。':!x.presenter||!x.systemShared?'当前没有共享系统声音。':'') + '</p>';
    }
    return {e:e,icon:icon,button:button,header:header,notice:notice,screen:screen,controls:controls,audio:audio,shareButton:shareButton,memberLabel:label};
  };
}());
