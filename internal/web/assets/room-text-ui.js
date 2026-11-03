export function createRoomTextUI({documentRef = document, transport, nameForPeer}) {
  const $ = selector => documentRef.querySelector(selector);
  const panel = $('#text-panel'), input = $('#text-input'), log = $('#text-log');
  const triggers = [$('#room-text'), $('#watch-text')];
  let roomId = '', unread = 0, returnTarget = null;
  const refreshTriggers = () => triggers.forEach(button => {
    button.textContent = unread ? `文字 · ${unread}` : '文字';
    button.setAttribute('aria-expanded', String(!panel.hidden));
    button.setAttribute('aria-label', unread ? `房间文字，${unread} 条未读消息` : '房间文字');
  });
  function close() {
    panel.hidden = true; refreshTriggers();
    if (returnTarget?.isConnected && !returnTarget.hidden) returnTarget.focus({preventScroll:true});
  }
  triggers.forEach(button => button.addEventListener('click', () => {
    if (!panel.hidden) { close(); return; }
    returnTarget = button; panel.hidden = false; unread = 0; refreshTriggers(); input.focus({preventScroll:true});
  }));
  $('#close-text').addEventListener('click', close);
  documentRef.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !panel.hidden && !$('dialog[open]')) { event.preventDefault(); close(); }
  });
  function append(message, self = false) {
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    const item = documentRef.createElement('article'); item.className = self ? 'text-message self-message' : 'text-message';
    const sender = documentRef.createElement('strong'); sender.textContent = self ? '我' : nameForPeer(message.peerId);
    const time = documentRef.createElement('time'); time.dateTime = new Date(message.time).toISOString(); time.textContent = new Date(message.time).toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit'});
    const text = documentRef.createElement('p'); text.textContent = message.text;
    item.append(sender, time, text);
    if (self) { const delivery = documentRef.createElement('small'); delivery.textContent = message.failed ? `已发送给 ${message.sent} 人，${message.failed} 人未发送成功` : `已发送给 ${message.sent} 人`; item.append(delivery); }
    log.append(item); while(log.children.length > 100) log.firstElementChild.remove();
    if (nearBottom || self) log.scrollTop = log.scrollHeight;
    if (!self && panel.hidden) unread = Math.min(unread + 1, 99);
    refreshTriggers();
    if (!self && panel.hidden) $('#ui-announcement').textContent = `${nameForPeer(message.peerId)}发来文字消息：${message.text}`;
  }
  $('#text-form').addEventListener('submit', event => {
    event.preventDefault();
    const error = $('#text-error'); error.hidden = true; input.setCustomValidity('');
    try {
      const message = transport.send(input.value);
      if (message.sent) append(message, true);
      if (message.failed) throw new Error('部分文字未发送成功，请等待连接恢复后再发送。');
      input.value = ''; input.focus({preventScroll:true});
    } catch (failure) { error.textContent = failure.message; error.hidden = false; }
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); if (!$('#send-text').disabled) $('#text-form').requestSubmit(); }
  });
  return {
    receive: message => append(message),
    sync(nextRoomId) {
      if (nextRoomId !== roomId) { roomId = nextRoomId; log.replaceChildren(); input.value = ''; unread = 0; panel.hidden = true; $('#text-error').hidden = true; refreshTriggers(); }
      $('#send-text').disabled = !transport.ready;
      const status = !transport.peers.size ? '朋友加入后就可以发送文字。' : transport.ready ? '文字已连接' : '正在连接文字，请稍候…';
      if ($('#text-connection').textContent !== status) $('#text-connection').textContent = status;
    },
  };
}
