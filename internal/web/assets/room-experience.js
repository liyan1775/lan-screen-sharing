import { icon } from './icons.js';

// Reparent controls, never the media elements. A mode change must not restart a stream.
export function createRoomExperience(documentRef = document) {
  const $ = selector => documentRef.querySelector(selector);
  const activity = $('#voice-activity');
  let current = {};
  const returnTargets = new WeakMap();
  const place = (node, parent) => { if (node && parent && node.parentElement !== parent) parent.append(node); };
  function decorate(button, name) {
    if (!button) return;
    if (button.dataset.decoratedIcon === name && button.querySelector('.ui-icon')) return;
    const text = button.textContent;
    const mark = documentRef.createElement('span'); mark.className = 'ui-icon'; mark.setAttribute('aria-hidden', 'true'); mark.innerHTML = icon(name);
    const label = documentRef.createElement('span'); label.textContent = text;
    button.replaceChildren(mark, label);
    button.dataset.decoratedIcon = name;
  }
  documentRef.querySelectorAll('[data-icon]').forEach(node => { node.innerHTML = icon(node.dataset.icon); node.setAttribute('aria-hidden', node.hasAttribute('aria-label') ? 'false' : 'true'); });
  documentRef.querySelectorAll('[data-button-icon]').forEach(button => decorate(button, button.dataset.buttonIcon));

  const allRows = () => [...documentRef.querySelectorAll('.audio-source')];
  function prepareMembers() {
    allRows().forEach(row => place(row, $('#audio-stash')));
    place($('#toggle-mic'), $('#mic-home'));
    place(activity, $('#voice-stage'));
  }
  function syncAudio() {
    const open = !!$('#sound-dialog').open;
    const seats = [...$('#members').children];
    let available = 0;
    for (const row of allRows()) {
      const system = row.dataset.role === 'systemAudio';
      const valid = !system || row.dataset.peerId === current.presenterPeerId;
      row.hidden = !valid;
      if (valid) available++;
      const seat = seats.find(node => node.dataset.peerId === row.dataset.peerId);
      const slot = !system && current.stage === 'voice' && !open ? seat?.querySelector('.seat-audio') : null;
      place(row, open && valid ? $('#audio-sources') : slot || $('#audio-stash'));
      const paused = system && current.voiceOnly;
      row.querySelectorAll('button,input').forEach(input => { input.disabled = paused; });
      const output = row.querySelector('output');
      const range = row.querySelector('input');
      const mute = row.querySelector('button');
      if (output && range && mute) {
        const text = paused ? '本机暂停' : mute.getAttribute('aria-pressed') === 'true' ? '已静音' : `${Math.round(Number(range.value) * 100)}%`;
        if (output.textContent !== text) output.textContent = text;
      }
    }
    $('#sound-empty').hidden = available > 0;
    seats.forEach(seat => {
      const waiting = seat.querySelector?.('.seat-audio-state');
      if (waiting) waiting.hidden = !!seat.querySelector('.audio-source');
    });
  }
  function open(id, trigger) {
    const previous = $('dialog[open]');
    const target = previous ? returnTargets.get(previous) : trigger || documentRef.activeElement;
    documentRef.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
    const dialog = $(`#${id}`);
    returnTargets.set(dialog, target);
    dialog.showModal(); syncAudio();
  }
  documentRef.querySelectorAll('dialog').forEach(dialog => {
    dialog.querySelector('[data-close-dialog]')?.addEventListener('click', () => dialog.close());
    dialog.addEventListener('keydown', event => {
      if (event.key !== 'Tab' || event.ctrlKey || event.altKey || event.metaKey) return;
      const controls = [...dialog.querySelectorAll('button,input,select,textarea,summary,a[href],[tabindex]')].filter(node => {
        if (node.disabled || node.tabIndex < 0 || !node.getClientRects().length) return false;
        // Chromium can report rectangles for descendants of a closed details element.
        for (let details = node.parentElement?.closest('details:not([open])'); details; details = details.parentElement?.closest('details:not([open])')) {
          if (![...details.children].find(child => child.tagName === 'SUMMARY')?.contains(node)) return false;
        }
        return true;
      });
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && documentRef.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && documentRef.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    dialog.addEventListener('click', event => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close(); } });
    dialog.addEventListener('close', () => {
      syncAudio();
      const target = returnTargets.get(dialog);
      const visible = target?.isConnected && !target.closest('[hidden]') && (!target.getClientRects || target.getClientRects().length > 0);
      if (!$('dialog[open]')) (visible ? target : current.stage === 'entry' ? $('#entry-settings') : current.stage === 'setup' ? $('#browse-rooms') : $('#open-settings')).focus({preventScroll:true});
    });
  });
  async function confirm({title, description, action}, trigger) {
    const previous = $('dialog[open]');
    const contextId = current.roomId;
    const dialog = $('#confirm-dialog');
    $('#confirm-title').textContent = title;
    $('#confirm-description').textContent = description;
    $('#confirm-accept').textContent = action;
    dialog.returnValue = '';
    const result = new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }));
    open('confirm-dialog', trigger);
    const accepted = await result;
    if (!accepted && previous?.isConnected && current.roomId === contextId) { previous.showModal(); trigger?.focus({preventScroll:true}); }
    return accepted;
  }
  $('#confirm-cancel').addEventListener('click', () => $('#confirm-dialog').close('cancel'));
  $('#confirm-accept').addEventListener('click', () => $('#confirm-dialog').close('confirm'));
  for (const id of ['voice-sound', 'watch-sound', 'members-sound']) $(`#${id}`).addEventListener('click', event => open('sound-dialog', event.currentTarget));
  for (const id of ['open-settings', 'entry-settings', 'share-options']) $(`#${id}`).addEventListener('click', event => open('settings-dialog', event.currentTarget));
  $('#invite-room').addEventListener('click', event => open('invite-dialog', event.currentTarget));
  $('#room-menu').addEventListener('click', event => open('members-dialog', event.currentTarget));

  function sync(state) {
    const previous = current.stage; current = state;
    documentRef.body.dataset.stage = state.stage;
    const joined = state.stage === 'voice' || state.stage === 'watch';
    $('.room-context').hidden = !joined; $('.room-top-actions').hidden = !joined;
    const errorHome = joined ? $('#share-panel') : $('#app');
    if ($('#error-message').parentElement !== errorHome) errorHome.prepend($('#error-message'));
    $('#topbar-room-name').textContent = state.roomName || '房间';
    $('#topbar-room-count').textContent = `${state.memberCount || 0} 人`;
    $('#watch-source').textContent = state.presenterPeerId ? `${state.presenterName || '成员'}正在共享${state.voiceOnly ? ' · 本机只聊语音' : ''}` : '';
    $('#screen-source-label').textContent = state.presenterPeerId ? `${state.presenterName || '成员'}的共享画面` : '';
    $('#watch-title').textContent = state.presenterPeerId ? `正在观看${state.presenterName || '成员'}的共享画面` : '等待共享画面';
    $('#voice-activity-title').textContent = state.presenterPeerId ? `${state.presenterName || '成员'}正在共享` : '还没有人共享';
    $('#voice-stage-message').textContent = state.presenterPeerId ? '画面由你决定是否观看，语音仍在房间里。' : '先聊着，任何人都可以开始共享。';
    const seats = [...$('#members').children].filter(node => node.classList.contains('member-seat'));
    if (state.stage === 'voice') {
      const left = seats.find(node => node.dataset.seat === 'left');
      const right = seats.find(node => node.dataset.seat === 'right');
      const near = seats.find(node => node.dataset.seat === 'near');
      // Keep the reading and keyboard order aligned with the member column,
      // then move to the sharing area. The media elements remain in place.
      const nodes = [left, right, near, activity].filter(Boolean);
      nodes.forEach((node,index) => { if ($('#members').children[index] !== node) $('#members').insertBefore(node, $('#members').children[index] || null); });
      place($('#members'), $('.orbit-table'));
      place($('#toggle-mic'), near?.querySelector('.seat-mic') || $('#mic-home'));
      place($('#host-share-controls'), $('#voice-share-slot'));
      place($('#voice-only'), $('#voice-view-slot'));
    } else {
      place(activity, $('#voice-stage'));
      place($('#toggle-mic'), $('#mic-home'));
      place($('#host-share-controls'), $('#share-home'));
      place($('#voice-only'), $('#view-home'));
      place($('#members'), $('.orbit-table'));
    }
    $('#voice-only').hidden = !state.presenterPeerId && !state.voiceOnly;
    $('#stop-share').hidden = $('#stop-share').disabled;
    $('#start-share').hidden = !!state.screenSharing;
    $('#voice-only').classList.toggle('button-primary', state.stage === 'voice' && !!state.voiceOnly && !!state.screenSharing);
    $('#share-options').hidden = !!state.presenterPeerId;
    $('#toggle-mic').setAttribute('aria-pressed', String(!!state.microphone));
    const self = seats.find(node => node.dataset.self === 'true');
    if (self) self.querySelector('.member-status').textContent = state.microphone ? '麦克风已开启' : '麦克风已关闭';
    const summary = $('#member-summary');
    const present = seats.filter(node => node.dataset.empty !== 'true');
    const summaryNodes = present.map(seat => {
      let row = [...summary.children].find(node => node.dataset.peerId === seat.dataset.peerId);
      if (!row) {
        row = documentRef.createElement('article'); row.className = 'member-seat'; row.dataset.peerId = seat.dataset.peerId;
        row.innerHTML = '<span class="member-avatar" aria-hidden="true"></span><strong></strong><small class="member-status"></small>';
      }
      row.dataset.seat = seat.dataset.seat;
      row.querySelector('.member-avatar').textContent = seat.querySelector('.member-avatar').textContent;
      row.querySelector('strong').textContent = seat.querySelector('strong').textContent;
      row.querySelector('.member-status').textContent = seat.querySelector('.member-status').textContent;
      return row;
    });
    [...summary.children].filter(node => !summaryNodes.includes(node)).forEach(node => node.remove());
    summaryNodes.forEach((node,index) => { if (summary.children[index] !== node) summary.insertBefore(node, summary.children[index] || null); });
    decorate($('#toggle-mic'), state.microphone ? 'mic' : 'mic-off');
    decorate($('#start-share'), 'screen'); decorate($('#stop-share'), 'screen');
    decorate($('#voice-only'), state.voiceOnly ? 'screen' : 'headphones');
    const invite = $('.manual-invite');
    if (invite) { place(invite, joined ? $('#invite-content') : $('#host-panel')); invite.open = joined; }
    syncAudio();
    if (previous && previous !== state.stage) {
      if (!joined) documentRef.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
      if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches !== true) $('#app').animate?.([{ opacity: .7 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });
    }
  }
  return { prepareMembers, sync, syncAudio, open, confirm };
}
