(function () {
  'use strict';
  var D = window.LanDemo = { layouts: {}, icons: {} };
  var routeNames = { portal: '房间会展开', orbit: '三人一桌', edge: '只留画面' };
  var themeNames = { cinema: '深色影院', lounge: '纸白客厅', precision: '冷白精密' };
  function rooms() { return [
    { id: 'game', name: '今晚一起玩', count: 2, sharing: true, full: false },
    { id: 'chat', name: '先聊一会儿', count: 1, sharing: false, full: false },
    { id: 'full', name: '三个位置都坐满了', count: 3, sharing: false, full: true }
  ]; }
  function members() { return [{ id: 'owner', label: '房主', self: false }, { id: 'friend', label: '成员', self: false }, { id: 'self', label: '我', self: true }]; }
  function initial() { return {
    scene: 'entry', roomName: '今晚一起玩', owner: false, view: 'voice', presenter: null,
    mic: false, micDenied: false, connection: 'connected', discovery: 'ready',
    rooms: rooms(), members: members(), volumes: { owner: .8, friend: 1, system: .7 },
    muted: { owner: false, friend: false, system: false }, systemShared: true,
    quality: '1080p60', cursor: false, shareAudio: true, isolation: 'unknown',
    layout: { entry: 'portal', voice: 'orbit', watch: 'edge' }, theme: 'lounge',
    error: '', busy: '', selectedSource: 'display-1'
  }; }
  function scenario(s, key) {
    var prefs = { layout: Object.assign({}, s.layout), theme: s.theme, quality: s.quality, cursor: s.cursor, shareAudio: s.shareAudio };
    Object.assign(s, initial(), prefs);
    if (['nearby', 'empty', 'blocked', 'full'].indexOf(key) >= 0) {
      if (key === 'empty') s.discovery = 'empty';
      if (key === 'blocked') s.discovery = 'blocked';
      if (key === 'full') s.rooms = [rooms()[2]];
      return s;
    }
    s.scene = 'room'; s.mic = true;
    if (key === 'watching' || key === 'reconnecting' || key === 'silent') { s.presenter = 'owner'; s.view = 'watch'; }
    if (key === 'broadcasting') { s.presenter = 'self'; s.view = 'watch'; }
    if (key === 'handoff') { s.presenter = null; s.view = 'voice'; }
    if (key === 'reconnecting') s.connection = 'reconnecting';
    if (key === 'silent') s.systemShared = false;
    if (key === 'denied') { s.mic = false; s.micDenied = true; }
    if (key === 'long') s.roomName = '这是一个用来检查窄窗口的非常非常长的无空格房间名称LongRoomName';
    return s;
  }
  D.model = { initial: initial, scenario: scenario, rooms: rooms, members: members, routeNames: routeNames, themeNames: themeNames };
}());
