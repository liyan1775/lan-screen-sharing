(function () {
  var D = window.LanDemo, original = D.makeHelpers;
  D.makeHelpers = function (s) {
    var h = original(s), screen = h.screen;
    function audioRow(x, row) {
      var volume=x.volumes[row.id]===undefined?1:x.volumes[row.id], muted=!!x.muted[row.id], paused=row.id==='system'&&x.view==='voice', unavailable=x.connection!=='connected';
      return '<div class="d-audio-row">' + (row.icon ? '<span class="d-audio-kind" aria-hidden="true">' + h.icon(row.icon) + '</span>' : '') + '<label for="person-audio-' + h.e(row.id) + '">' + h.e(row.name) + '</label><output>' + (unavailable?'等待连接':paused?'本机暂停':muted?'已静音':Math.round(volume*100)+'%') + '</output><div class="d-audio-range"><input id="person-audio-' + h.e(row.id) + '" data-volume="' + h.e(row.id) + '" type="range" min="0" max="1" step="0.05" value="' + volume + '" aria-label="' + h.e(row.name + '的本机音量') + '"' + (paused||unavailable?' disabled':'') + '>' + h.button('mute',muted?'取消静音':'静音',{icon:muted?'speaker-off':'speaker',value:row.id,disabled:paused||unavailable,attrs:'aria-pressed="'+String(muted)+'"'}) + '</div></div>';
    }
    h.screen = function (x, options) { return screen(x, options).replace('src="assets/', 'src="../frontend-lab/assets/'); };
    h.person = function (x, id, options) {
      var m = x.members.find(function (p) { return p.id === id; });
      if (!m) return '';
      var label = h.memberLabel(x, id), status = m.self ? (x.mic ? '麦克风已开启' : '麦克风已关闭') : x.connection !== 'connected' ? '等待连接' : x.presenter === id ? '正在共享' : x.audioAvailable && x.audioAvailable[id] === false ? '等待语音' : '在房间';
      return '<button class="ex-person' + (options && options.compact ? ' ex-person-compact' : '') + (m.self ? ' ex-person-self' : '') + '" type="button" data-action="member" data-value="' + h.e(id) + '" aria-label="' + h.e(label + '，' + status + '，打开声音控制') + '"><span class="ex-avatar" aria-hidden="true">' + h.e(m.self ? '我' : label.slice(0, 1)) + '</span><span class="ex-person-copy"><strong>' + h.e(label) + '</strong><small>' + h.e(status) + '</small></span>' + h.icon(m.self ? (x.mic ? 'mic' : 'mic-off') : 'sliders') + '</button>';
    };
    h.people = function (x, options) { return '<div class="ex-people" aria-label="房间里的成员">' + x.members.map(function (m) { return h.person(x, m.id, options); }).join('') + '</div>'; };
    h.personAudio = function (x, id) {
      var m = x.members.find(function (p) { return p.id === id; });
      if (!m) return '<p class="d-audio-note">这位成员已经离开。</p>';
      if (m.self) return '<p class="d-audio-note">控制你发送给朋友的声音。</p>' + h.button('mic', x.mic ? '关闭我的麦克风' : '开启我的麦克风', {icon:x.mic?'mic':'mic-off',attrs:'aria-pressed="' + String(x.mic) + '"'}) + (x.presenter === 'self' ? '<h3>我正在共享画面</h3><p class="d-audio-note">' + (x.systemShared?'系统声音正在发给朋友。本机不重复播放。':'当前没有共享系统声音。') + '</p>' + (x.systemShared ? h.button('stop-system','只停止共享系统声音',{icon:'speaker-off'}) : '') : '');
      var voiceAvailable = !x.audioAvailable || x.audioAvailable[id] !== false;
      var rows = voiceAvailable ? [{ id: id, name: h.memberLabel(x,id) + '的语音' }] : [];
      if (x.presenter === id && x.systemShared) rows.push({id:'system',name:'共享的游戏声音'});
      return (voiceAvailable ? '' : '<p class="d-audio-note">正在等待这位成员的语音来源，当前还不能调节。</p>') + '<div class="d-audio-list">' + rows.map(function (row) { return audioRow(x,row); }).join('') + '</div>' + (x.presenter===id&&!x.systemShared?'<p class="d-audio-note">这次共享没有游戏声音。</p>':'') + '<p class="d-audio-note">只改变你在本机听到的声音，其他人的音量不受影响。</p>';
    };
    h.audio = function (x) {
      var members=x.members.filter(function(m){return !m.self&&m.id!=='self';});
      if (!members.length) return '<p class="d-audio-note">还没有其他成员的声音。</p>';
      var waiting = members.filter(function(m){return x.audioAvailable && x.audioAvailable[m.id] === false;});
      var rows = members.filter(function(m){return !x.audioAvailable || x.audioAvailable[m.id] !== false;}).map(function(m){return {id:m.id,name:h.memberLabel(x,m.id)+'的语音',icon:'mic'};});
      if (x.presenter && x.presenter !== 'self' && x.systemShared) rows.push({id:'system',name:'共享的游戏声音',icon:'speaker'});
      var unavailable = waiting.length ? '<p class="d-audio-note">正在等待'+waiting.map(function(m){return h.e(h.memberLabel(x,m.id));}).join('、')+'的语音来源。</p>' : '';
      var noSystem = x.presenter && x.presenter !== 'self' && !x.systemShared ? '<p class="d-audio-note">这次共享没有游戏声音。</p>' : '';
      return '<div class="d-audio-list d-audio-compact">'+rows.map(function(row){return audioRow(x,row);}).join('')+'</div>'+unavailable+noSystem+'<p class="d-audio-note">只改变你在本机听到的声音，其他人的音量不受影响。</p>';
    };
    return h;
  };
}());
