import {ROOM_REACTIONS} from './room-text.js';

export function createRoomReactions({documentRef = document, transport}) {
  const $ = selector => documentRef.querySelector(selector);
  const controls = $('#reaction-controls'), toggle = $('#react-toggle'), picker = $('#reaction-picker');
  const floats = $('#reaction-floats');
  let roomId = '';
  function close(restoreFocus = false) {
    picker.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    if (restoreFocus) toggle.focus({preventScroll: true});
  }
  function float(emoji) {
    if (!roomId || !ROOM_REACTIONS.includes(emoji)) return;
    const bubble = documentRef.createElement('span');
    bubble.className = 'reaction-float';
    bubble.textContent = emoji;
    bubble.addEventListener('animationend', () => bubble.remove(), {once: true});
    if (floats.children.length >= 6) floats.firstElementChild.remove();
    floats.append(bubble);
  }

  toggle.addEventListener('click', () => {
    if (!picker.hidden) { close(); return; }
    picker.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    picker.querySelector('button').focus({preventScroll: true});
  });
  for (const button of picker.querySelectorAll('button[data-emoji]')) {
    button.addEventListener('click', () => {
      if (transport.sendReaction(button.dataset.emoji)) float(button.dataset.emoji);
      close(true);
    });
  }
  documentRef.addEventListener('pointerdown', event => {
    if (!picker.hidden && !controls.contains(event.target)) close();
  });
  documentRef.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || picker.hidden || $('dialog[open]')) return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  }, true);
  return {
    receive: ({emoji}) => float(emoji),
    sync(nextRoomId, watching) {
      const slot = $(watching ? '#watch-reaction-slot' : '#voice-reaction-slot');
      if (controls.parentElement !== slot) {
        const focused = controls.contains(documentRef.activeElement);
        close();
        slot.append(controls);
        if (focused && nextRoomId) toggle.focus({preventScroll: true});
      }
      if (roomId !== nextRoomId) {
        roomId = nextRoomId;
        close();
        floats.replaceChildren();
      }
    },
  };
}
