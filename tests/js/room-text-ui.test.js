import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createRoomTextUI, renderMessageText} from '../../internal/web/assets/room-text-ui.js';
import {createRoomReactions} from '../../internal/web/assets/room-reactions.js';

test('message links preserve plain text and only render validated HTTP(S) anchors', () => {
  const {document} = parseHTML('<p></p>');
  const container = document.querySelector('p');
  const message = '看https://example.com/docs。 (http://example.org/a(b)). javascript:alert(1) javascript:https://invalid.test ftp://invalid.test https://? <img src="https://hidden.test/path" onerror=alert(1)>';
  renderMessageText(document, container, message);
  assert.equal(container.textContent, message);
  assert.equal(container.querySelector('img'), null);
  assert.deepEqual([...container.querySelectorAll('a')].map(a => [a.href, a.target, a.rel]), [
    ['https://example.com/docs', '_blank', 'noopener noreferrer'],
    ['http://example.org/a(b)', '_blank', 'noopener noreferrer'],
  ]);
});

test('copy uses the original message and room reactions never touch the log or unread count', async () => {
  const {document} = parseHTML(`<button id="room-text"></button><button id="watch-text"></button>
    <aside id="text-panel" hidden><button id="close-text"></button><span id="text-connection"></span><div id="text-log"></div>
    <form id="text-form"><textarea id="text-input"></textarea><button id="send-text"></button><p id="text-error"></p></form></aside>
    <p id="ui-announcement"></p><div id="reaction-floats"></div><div id="watch-reaction-slot"></div>
    <div id="voice-reaction-slot"><div id="reaction-controls"><button id="react-toggle"></button><div id="reaction-picker"></div></div></div>`);
  const copied = [], notices = [];
  const transport = {ready: true, peers: new Map([['friend', {}]])};
  const ui = createRoomTextUI({documentRef: document, transport, nameForPeer: () => '友人',
    clipboard: {writeText: async value => copied.push(value)}, onNotice: value => notices.push(value)});
  const reactions = createRoomReactions({documentRef: document, transport});
  ui.sync('room');
  reactions.sync('room', false);
  const text = 'https://example.com/!\n<img src=x onerror=alert(1)>';
  ui.receive({peerId: 'friend', text, time: Date.now()});
  const unread = document.querySelector('#watch-text');
  assert.equal(unread.dataset.unreadCount, '1');
  reactions.receive({emoji:'👍'});
  reactions.receive({emoji:'invalid'});
  assert.equal(document.querySelectorAll('.reaction-float').length, 1);
  assert.equal(document.querySelectorAll('.text-message').length, 1);
  assert.equal(unread.dataset.unreadCount, '1');
  document.querySelector('.message-copy').click();
  await Promise.resolve();
  assert.deepEqual(copied, [text]);
  assert.deepEqual(notices, ['已复制消息']);
  reactions.sync('', false);
  assert.equal(document.querySelectorAll('.reaction-float').length, 0);
});
