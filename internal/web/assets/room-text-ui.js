const linkPattern = /<\/?[a-z][^<>\r\n]*>|(?<![A-Za-z0-9_:/@])https?:\/\/[^\s<>"'“”‘’\x00-\x1f\x7f，。！？；、]+/gi;
const trailingPunctuation = /[.,;!?：:。！？、，；]+$/u;
const closingPairs = {')': '(', ']': '[', '}': '{', '）': '（', '】': '【', '》': '《'};

function linkEnd(raw) {
  let end = raw.replace(trailingPunctuation, '');
  while (Object.hasOwn(closingPairs, end.at(-1))) {
    const closer = end.at(-1);
    const opener = closingPairs[closer];
    if (end.split(closer).length <= end.split(opener).length) break;
    end = end.slice(0, -1).replace(trailingPunctuation, '');
  }
  return end;
}

export function renderMessageText(documentRef, container, message) {
  let position = 0;
  for (const match of message.matchAll(linkPattern)) {
    if (match[0].startsWith('<')) continue;
    const label = linkEnd(match[0]);
    let url;
    try { url = new URL(label); } catch { continue; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    container.append(documentRef.createTextNode(message.slice(position, match.index)));
    const link = documentRef.createElement('a');
    link.href = url.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = label;
    container.append(link);
    position = match.index + label.length;
  }
  container.append(documentRef.createTextNode(message.slice(position)));
}

function copyIcon(documentRef) {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = documentRef.createElementNS(namespace, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const shape = documentRef.createElementNS(namespace, 'path');
  shape.setAttribute('d', 'M8 7V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2m-3 5H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2Z');
  shape.setAttribute('fill', 'none');
  shape.setAttribute('stroke', 'currentColor');
  shape.setAttribute('stroke-width', '1.65');
  svg.append(shape);
  return svg;
}

export function createRoomTextUI({documentRef = document, transport, nameForPeer, selfPeerId = () => '',
  clipboard = globalThis.navigator?.clipboard, onNotice = () => {}}) {
  const $ = selector => documentRef.querySelector(selector);
  const panel = $('#text-panel'), input = $('#text-input'), log = $('#text-log');
  const triggers = [$('#room-text'), $('#watch-text')];
  const unreadAnimations = new Map();
  let roomId = '', unread = 0, returnTarget = null;
  const refreshTriggers = () => triggers.forEach(button => {
    const label = button.querySelector('.button-label') || button;
    const countChanged = button.dataset.unreadCount !== String(unread);
    if (countChanged) {
      unreadAnimations.get(button)?.cancel();
      unreadAnimations.delete(button);
      if (unread && button.animate && button.getClientRects().length) {
        const easing = documentRef.defaultView.getComputedStyle(button).getPropertyValue('--spring-bouncy').trim();
        unreadAnimations.set(button, button.animate(
          [{transform: 'translateY(2px) scale(.94)'}, {transform: 'translateY(0) scale(1)'}],
          {duration: 360, easing}
        ));
      }
    }
    button.dataset.unread = String(unread > 0);
    if (unread) button.dataset.unreadCount = String(unread);
    else delete button.dataset.unreadCount;
    label.textContent = unread ? `文字 · ${unread}` : '文字';
    button.setAttribute('aria-expanded', String(!panel.hidden));
    button.setAttribute('aria-label', unread ? `房间文字，${unread} 条未读消息` : '房间文字');
  });
  function close() {
    panel.hidden = true; refreshTriggers();
    if (returnTarget?.isConnected && !returnTarget.hidden) returnTarget.focus({preventScroll:true});
  }
  triggers.forEach(button => button.addEventListener('click', () => {
    if (!panel.hidden) { close(); return; }
    returnTarget = button;
    panel.hidden = false;
    if (unread) log.scrollTop = log.scrollHeight;
    unread = 0;
    refreshTriggers();
    input.focus({preventScroll:true});
  }));
  $('#close-text').addEventListener('click', close);
  documentRef.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !panel.hidden && !$('dialog[open]')) { event.preventDefault(); close(); }
  });
  function append(message, self = false) {
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    const item = documentRef.createElement('article'); item.className = self ? 'text-message self-message' : 'text-message';
    const peerId = self ? selfPeerId() : message.peerId;
    const sender = documentRef.createElement('strong');
    sender.dataset.senderPeer = peerId;
    sender.textContent = nameForPeer(peerId) || (self ? '我' : '成员');
    const time = documentRef.createElement('time'); time.dateTime = new Date(message.time).toISOString(); time.textContent = new Date(message.time).toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit'});
    const text = documentRef.createElement('p');
    renderMessageText(documentRef, text, message.text);
    const copy = documentRef.createElement('button');
    copy.type = 'button';
    copy.className = 'button icon-button message-copy';
    copy.title = '复制消息';
    copy.setAttribute('aria-label', '复制消息');
    copy.append(copyIcon(documentRef));
    copy.addEventListener('click', async () => {
      try {
        await clipboard.writeText(message.text);
        onNotice('已复制消息');
      } catch { onNotice('无法自动复制，可选中文字后手动复制。'); }
    });
    const header = documentRef.createElement('header');
    header.append(sender, time, copy);
    item.append(header, text);
    if (!panel.hidden) item.classList.add('is-new');
    if (self) { const delivery = documentRef.createElement('small'); delivery.textContent = message.failed ? `已发送给 ${message.sent} 人，${message.failed} 人未发送成功` : `已发送给 ${message.sent} 人`; item.append(delivery); }
    log.append(item); while(log.children.length > 100) log.firstElementChild.remove();
    if (nearBottom || self) log.scrollTop = log.scrollHeight;
    if (!self && panel.hidden) unread = Math.min(unread + 1, 99);
    refreshTriggers();
    if (!self && panel.hidden) $('#ui-announcement').textContent = `${sender.textContent}发来文字消息：${message.text}`;
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
    refreshNames() {
      for (const sender of log.querySelectorAll('[data-sender-peer]')) {
        const name = nameForPeer(sender.dataset.senderPeer);
        if (name && sender.textContent !== name) sender.textContent = name;
      }
    },
    sync(nextRoomId) {
      if (nextRoomId !== roomId) { roomId = nextRoomId; log.replaceChildren(); input.value = ''; unread = 0; panel.hidden = true; $('#text-error').hidden = true; refreshTriggers(); }
      $('#send-text').disabled = !transport.ready;
      const status = !transport.peers.size ? '朋友加入后就可以发送文字。' : transport.ready ? '文字已连接' : '正在连接文字，请稍候…';
      if ($('#text-connection').textContent !== status) $('#text-connection').textContent = status;
    },
  };
}
