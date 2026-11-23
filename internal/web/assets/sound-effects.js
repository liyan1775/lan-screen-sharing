const chimes = {
  joined: [[660, 0, .13, .026], [880, .072, .19, .028]],
  shared: [[784, 0, .17, .025], [1175, .046, .21, .019]],
  message: [[1047, 0, .105, .018, 784]],
};

export function createSoundEffects({AudioContextImpl = globalThis.AudioContext} = {}) {
  let enabled = true;
  let context, output, lastPlayed = -Infinity;
  return {
    setEnabled(value) {
      enabled = !!value;
      if (output) output.gain.value = enabled ? 1 : 0;
    },
    unlock() {
      if (!enabled || !AudioContextImpl) return;
      try {
        if (!context) {
          context = new AudioContextImpl();
          output = context.createGain();
          output.connect(context.destination);
        }
        if (context.state === 'suspended') void context.resume().catch(() => {});
      } catch { /* Room use continues when audio is unavailable. */ }
    },
    play(kind) {
      if (!enabled || context?.state !== 'running' || !Object.hasOwn(chimes, kind)) return false;
      const now = context.currentTime;
      if (now - lastPlayed < .09) return false;
      lastPlayed = now;
      for (const [frequency, offset, duration, volume, endFrequency] of chimes[kind]) {
        const start = now + offset;
        const tone = context.createOscillator();
        const envelope = context.createGain();
        tone.frequency.setValueAtTime(frequency, start);
        if (endFrequency) tone.frequency.exponentialRampToValueAtTime(endFrequency, start + duration / 2);
        envelope.gain.setValueAtTime(.0001, start);
        envelope.gain.exponentialRampToValueAtTime(volume, start + .014);
        envelope.gain.exponentialRampToValueAtTime(.0001, start + duration);
        tone.connect(envelope);
        envelope.connect(output);
        tone.onended = () => { tone.disconnect(); envelope.disconnect(); };
        tone.start(start);
        tone.stop(start + duration);
      }
      return true;
    },
  };
}

export function createRoomSoundEvents(play) {
  let roomId = '', revision = -1, lastStart = -1;
  const members = new Set();
  return (message, room, selfPeerId, recovering) => {
    const nextRoom = room?.roomId || '';
    if (nextRoom !== roomId || message.recovered || message.type === 'room.joined') {
      roomId = nextRoom;
      revision = lastStart = room?.presentationRevision ?? -1;
      members.clear();
      for (const member of room?.members ?? []) members.add(member.peerId);
      return;
    }
    if (!roomId || message.roomId !== roomId) return;
    if (message.type === 'peer.joined' && message.peerId && message.peerId !== selfPeerId && !members.has(message.peerId)) {
      members.add(message.peerId);
      if (!recovering) play('joined');
    }
    if (message.type !== 'room.state') return;
    const {presentationRevision, presentationStarted, screenSharing, resumed} = message.payload ?? {};
    if (!Number.isSafeInteger(presentationRevision) || presentationRevision < revision) return;
    revision = presentationRevision;
    if (recovering || resumed) { lastStart = revision; return; }
    if (presentationStarted === true && screenSharing === true && revision > lastStart) {
      lastStart = revision;
      play('shared');
    }
  };
}
