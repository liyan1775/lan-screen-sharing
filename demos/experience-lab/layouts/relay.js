(function () {
  'use strict';
  var layouts = window.LanDemo.layouts;

  function rooms(s, h) {
    if (s.discovery === 'searching') return '<p class="re-discovery-state">正在寻找附近的房间。你也可以创建房间或手动加入。</p>';
    if (s.discovery === 'blocked') return '<div class="re-discovery-state"><p>暂时无法搜索附近房间，可以重试或手动加入。</p>' + h.button('retry', '重试搜索', {icon:'refresh'}) + '</div>';
    if (s.discovery === 'empty' || !s.rooms || !s.rooms.length) return '<p class="re-discovery-state">附近还没有房间。创建一个，或通过地址加入朋友。</p>';
    return '<div class="re-rooms">' + s.rooms.map(function (room) {
      var full = room.full || room.count >= 3;
      var info = room.count + '/3 人 · ' + (room.sharing ? '正在分享' : '可以聊天') + (full ? ' · 已满' : '');
      return '<article class="re-room"><div><strong>' + h.e(room.name) + '</strong><span>' + h.e(info) + '</span></div>' + h.button('join', full ? '房间已满' : '加入', {icon:'arrow-right',kind:full?'quiet':'primary',value:room.id,disabled:full}) + '</article>';
    }).join('') + '</div>';
  }

  function current(s, h) {
    if (s.connection !== 'connected') return {title:'正在等待房间连接', detail:'连接恢复后再继续分享。', action:h.button('retry','重试连接',{icon:'refresh'})};
    if (!s.presenter) return {title:'现在可以分享', detail:'还没有人分享画面。你们可以继续聊天，也可以由任何成员开始。', action:h.shareButton(s)};
    if (s.presenter === 'self') return {title:'你正在分享', detail: s.systemShared ? '你的画面和共享声音正在发送。' : '当前没有共享系统声音。', action:h.shareButton(s)};
    var name = h.memberLabel(s, s.presenter);
    return {title:name + '正在分享', detail:'等对方停止后，就可以分享你的屏幕。', action:''};
  }

  function activity(s, h, mode) {
    var a = current(s,h);
    var view = '';
    if (s.presenter && s.presenter !== 'self' && s.connection === 'connected') {
      view = s.view === 'voice' ? h.button('watch','观看画面',{icon:'eye',kind:'primary'}) : h.button('voice','只聊语音',{icon:'headphones'});
    } else if (s.presenter === 'self' && s.view === 'watch') {
      view = h.button('voice','只聊语音（停止我的分享）',{icon:'headphones'});
    }
    var audio = s.presenter && s.presenter !== 'self' && s.connection === 'connected' ? '<div class="re-source">' + h.person(s,s.presenter,{compact:true}) + '<span>' + (s.systemShared ? '选择分享者可分别调整语音和共享声音，只影响你。' : '选择分享者可调整语音，只影响你。') + '</span></div>' : '';
    return '<div class="re-activity" aria-label="当前活动"><div class="re-activity-copy"><span class="re-kicker">当前活动</span><strong>' + h.e(a.title) + '</strong><span>' + h.e(a.detail) + '</span>' + (s.presenter && s.presenter !== 'self' && !s.systemShared ? '<span>当前没有共享系统声音。</span>' : '') + '</div><div class="re-activity-actions">' + view + a.action + '</div>' + audio + '</div>';
  }

  function microphone(s,h) {
    return h.button('mic',s.mic?'关闭麦克风':s.micDenied?'重试麦克风':'开启麦克风',{icon:s.mic?'mic':'mic-off',attrs:'aria-pressed="'+String(s.mic)+'"'});
  }
  function watchBar(s,h) {
    var connected=s.connection==='connected', own=s.presenter==='self';
    var state=!connected?'等待连接恢复':!s.presenter?'暂时没有共享':own?'你正在分享':h.memberLabel(s,s.presenter)+'正在分享';
    var detail=!connected?'连接恢复后再继续。':!s.presenter?'可以继续聊天，也可以开始分享。':own?(s.systemShared?'系统声音正在共享，隔离状态未确认。':'当前没有共享系统声音。'):(s.systemShared?'对方停止后，你可以分享自己的屏幕。':'这次没有共享系统声音；对方停止后可以换人。');
    var person=s.presenter?h.person(s,s.presenter,{compact:true}):'';
    var view=h.button('voice',!s.presenter?'回到语音':own?'停止共享并只聊语音':'只聊语音',{icon:'headphones'});
    return '<section class="re-watch-bar" aria-label="当前活动"><div class="re-watch-current">'+person+'<div class="re-watch-copy"><span class="re-kicker">当前活动</span><strong>'+h.e(state)+'</strong><span>'+h.e(detail)+'</span></div></div><div class="re-watch-actions">'+microphone(s,h)+h.button('sound','声音',{icon:'speaker'})+view+(own?h.shareButton(s):'')+h.button('fullscreen','全屏观看',{icon:'fullscreen',disabled:!connected||!s.presenter})+'</div></section>';
  }

  function people(s,h) {
    return '<div class="re-presence"><div><strong>在房间里</strong><span>可以一起待着，不必一直说话。</span></div><div class="re-people">' + h.people(s,{compact:true}) + '</div></div>';
  }
  function room(s,h,watching) {
    var mic = microphone(s,h);
    var stage = watching ? '<div class="re-stage">' + h.screen(s) + '</div>' : '';
    return '<section class="relay-' + (watching?'watch':'voice') + '">' + h.header(s,{compact:true}) + '<main class="re-main">' + h.notice(s) +
      (watching ? watchBar(s,h) : activity(s,h,'voice') + '<div class="re-bar">' + mic + h.button('sound','声音',{icon:'speaker'}) + '<span>声音调节只影响本机收听</span></div>') + stage + people(s,h) + '</main></section>';
  }
  layouts.relay = {
    entry:function(s,h){ return '<section class="relay-entry">' + h.header(s) + '<main class="re-entry"><div class="re-entry-head"><div><span class="re-kicker">一起开始</span><h1>找到朋友的房间</h1><p>进入房间后，可以先聊天，再随时分享画面。</p></div>' + h.button('refresh','刷新',{icon:'refresh'}) + '</div>' + rooms(s,h) + '<div class="re-entry-actions">' + h.button('create','创建房间',{icon:'plus',kind:'primary'}) + h.button('manual','手动加入',{icon:'link'}) + '</div></main></section>'; },
    voice:function(s,h){ return room(s,h,false); },
    watch:function(s,h){ return room(s,h,true); }
  };
}());
