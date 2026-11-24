import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomClient } from '../../internal/web/assets/client.js';
import { createPreferenceWriter, displayMemberName, nicknameDraft, paintAvatar } from '../../internal/web/assets/preferences.js';

test('preferences restore false values and serialize patches without losing edits from an in-flight save', async () => {
  const patches = [];
  let finishFirst;
  const gate = new Promise(resolve => { finishFirst = resolve; });
  const writer = createPreferenceWriter({debounce: 60_000, onError: error => assert.fail(error.message),
    save: async patch => {
      patches.push(patch);
      if (patches.length === 1) await gate;
      return {...patch, preferredLanIPv4: '192.168.1.1'};
    },
  });
  writer.restore({pauseBackgroundPreview: false, soundEffects: false, micMode: 'ptt', micDeviceId: 'test-id'});
  assert.equal(writer.values.pauseBackgroundPreview, false);
  assert.equal(writer.values.soundEffects, false);
  assert.equal(writer.values.micMode, 'ptt');
  assert.equal(writer.values.micDeviceId, 'test-id');
  writer.set({nickname: '第一版', avatarColor: 'teal'});
  const first = writer.flush();
  writer.set({nickname: '新名字'});
  writer.restore({preferredLanIPv4: '172.22.1.10'});
  const second = writer.flush();
  finishFirst();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.deepEqual(patches, [{nickname: '第一版', avatarColor: 'teal'}, {nickname: '新名字'}]);
  assert.equal(writer.values.nickname, '新名字');
  assert.equal(writer.values.preferredLanIPv4, '172.22.1.10');
});

test('a failed save retains the latest values for retry without writing unrecognized fields', async () => {
  const failures = [], sent = [];
  const writer = createPreferenceWriter({debounce: 60_000, onError: error => failures.push(error.message),
    save: async patch => {
      sent.push(patch);
      if (sent.length === 1) throw new Error('disk error');
      return patch;
    },
  });
  writer.set({nickname: '待保存', resumeToken: 'never persist'});
  assert.equal(await writer.flush(), false);
  writer.set({nickname: '已更正'});
  assert.equal(await writer.flush(), true);
  assert.deepEqual(failures, ['disk error']);
  assert.deepEqual(sent, [{nickname: '待保存'}, {nickname: '已更正'}]);
});

test('identity controls count Unicode code points and default labels stay tied to seats', () => {
  assert.equal(nicknameDraft('  \u0000' + '🌙'.repeat(21)), '🌙'.repeat(20));
  assert.equal(displayMemberName({role: 'viewer', seatIndex: 3}), '成员 2');
  assert.equal(displayMemberName({role: 'host', seatIndex: 1, nickname: '<b>小雨</b>'}), '<b>小雨</b>');
  const avatar = {dataset: {}};
  paintAvatar(avatar, {nickname: '🌙夜航', avatarColor: 'pink'}, '成');
  assert.equal(avatar.textContent, '🌙');
  assert.equal(avatar.dataset.avatarColor, 'pink');
});

test('peer hosts default empty and only save up to eight unique canonical RFC 1918 addresses', async () => {
  const sent = [];
  const writer = createPreferenceWriter({onError: assert.fail, save: async patch => { sent.push(patch); return patch; }});
  assert.deepEqual(writer.values.peerHosts, []);
  writer.restore({peerHosts: null});
  assert.deepEqual(writer.values.peerHosts, []);
  const candidates = [' 10.208.1.20 ', '10.208.1.20', '172.16.0.1', '172.31.255.254', '192.168.1.1',
    '172.15.1.1', '172.32.0.1', '127.0.0.1', '100.64.1.1', '169.254.1.1', '8.8.8.8', '::ffff:10.1.1.1',
    '010.1.1.1', '10.256.1.1', '10.1.1.1:80', '10.1.1', 10, '10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.0.5'];
  const expected = ['10.208.1.20', '172.16.0.1', '172.31.255.254', '192.168.1.1', '10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4'];
  writer.restore({peerHosts: candidates});
  assert.deepEqual(writer.values.peerHosts, expected);
  writer.set({peerHosts: []});
  await writer.flush();
  writer.set({peerHosts: candidates});
  await writer.flush();
  writer.set({peerHosts: expected});
  await writer.flush();
  assert.deepEqual(sent, [{peerHosts: []}, {peerHosts: expected}]);
});

test('profile notification updates only the named member and older rosters cannot rewind it', () => {
  const client = new RoomClient({storageImpl: null});
  const send = (type, payload, peerId) => client.receive(JSON.stringify({type, payload, peerId, roomId: 'room-a'}));
  const members = [
    {peerId: 'host', role: 'host', seatIndex: 1, nickname: '旧名', avatarColor: 'blue', profileRevision: 1},
    {peerId: 'viewer', role: 'viewer', seatIndex: 3, nickname: '', avatarColor: 'teal', profileRevision: 1},
  ];
  send('room.state', {members, presenterPeerId: 'host', screenSharing: true, presentationRevision: 4});
  send('peer.profile', {nickname: '<b>新名</b>', avatarColor: 'pink', profileRevision: 2, seatIndex: 99}, 'host');
  assert.equal(client.room.members[0].nickname, '<b>新名</b>');
  assert.equal(client.room.members[0].seatIndex, 1);
  assert.equal(client.room.presenterPeerId, 'host');
  assert.equal(client.room.screenSharing, true);
  send('room.state', {members, presenterPeerId: '', screenSharing: false, presentationRevision: 3});
  assert.equal(client.room.members[0].nickname, '<b>新名</b>');
  assert.equal(client.room.members[0].avatarColor, 'pink');
  assert.deepEqual(client.room.members[1], members[1]);
  assert.equal(client.room.presenterPeerId, 'host');
  assert.equal(client.room.presentationRevision, 4);
});
