(function () {
  var D = window.LanDemo, initial = D.model.initial, scenario = D.model.scenario;
  D.model.routeNames = { portal: '房间会展开', orbit: '三人一桌', edge: '只留画面', channel: '同伴通道', source: '来源展开', relay: '接力现场' };
  D.model.themeNames = { cinema: '深色影院', lounge: '纸白客厅', precision: '冷白精密', clearblue: '晴蓝灵感' };
  D.model.initial = function () {
    var s = initial();
    s.layout = { entry: 'portal', voice: 'orbit', watch: 'edge' };
    s.theme = 'lounge';
    s.roomId = '';
    s.joiningRoom = '';
    s.audioAvailable = { owner: true, friend: true };
    return s;
  };
  D.model.scenario = function (s, key) {
    scenario(s, key === 'waiting-audio' ? 'chat' : key);
    s.audioAvailable = { owner: key !== 'waiting-audio', friend: key !== 'waiting-audio' };
    return s;
  };
}());
