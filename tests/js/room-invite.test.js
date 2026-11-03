import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRoomInvite, parseRoomInvite } from '../../internal/web/assets/room-invite.js';

test('one pasted invitation accepts the current and earlier copied format', () => {
  const details = { hostIPv4: '192.168.1.20', hostPort: 45678, roomCode: 'ABCD2345' };
  assert.equal(formatRoomInvite(details), '192.168.1.20:45678  房间码 ABCD2345');
  for (const value of [
    '192.168.1.20:45678  房间码 ABCD2345',
    '  192.168.1.20:45678\n房间码：abcd2345  ',
    '192.168.1.20：45678 房间码ABCD2345',
    '192.168.1.20:45678/abcd2345',
  ]) assert.deepEqual(parseRoomInvite(value), details);
});

test('invitation round trips across private IPv4 ranges and port boundaries', () => {
  for (const hostIPv4 of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.255.254']) {
    for (const hostPort of [1, 65535]) {
      const details = { hostIPv4, hostPort, roomCode: 'ZYXW9876' };
      assert.deepEqual(parseRoomInvite(formatRoomInvite(details)), details);
    }
  }
});

test('an invitation cannot omit fields, use an invalid endpoint or smuggle extra content', () => {
  for (const value of ['', 'ABCD2345', '192.168.1.20:45678',
    '192.168.1.256:45678/ABCD2345', '127.0.0.1:45678/ABCD2345', '8.8.8.8:45678/ABCD2345',
    '172.32.0.1:45678/ABCD2345', '192.168.1.20:0/ABCD2345', '192.168.1.20:65536/ABCD2345',
    '192.168.1.20:45678/ABC012IO', '192.168.1.20:45678/ABCD2345 extra',
    'https://192.168.1.20:45678/ABCD2345', '<script>192.168.1.20:45678/ABCD2345</script>',
    ' '.repeat(260) + '192.168.1.20:45678/ABCD2345' + 'x'.repeat(260),
  ]) assert.throws(() => parseRoomInvite(value), Error, value);
});
