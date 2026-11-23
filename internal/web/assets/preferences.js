export const preferenceDefaults = Object.freeze({
  nickname: '', avatarColor: 'blue', preferredLanIPv4: '', qualityTarget: '1080p60',
  shareMode: 'combined', pauseBackgroundPreview: true, shareCursor: false,
  micMode: 'open', micDeviceId: '', micDeviceLabel: '', soundEffects: true,
});

const avatarColors = new Set(['blue', 'indigo', 'teal', 'green', 'orange', 'pink']);
const maxNickname = 20;

export function nicknameDraft(text) {
  const clean = text.replace(/\p{Cc}/gu, '').trimStart();
  const chars = Array.from(clean);
  return chars.length > maxNickname ? chars.slice(0, maxNickname).join('') : clean;
}

export function profileFrom({nickname = '', avatarColor}) {
  return { nickname: nicknameDraft(nickname).trimEnd(), avatarColor: avatarColors.has(avatarColor) ? avatarColor : 'blue' };
}

export function displayMemberName(member) {
  if (!member) return '成员';
  return member.nickname || (member.role === 'host' ? '房主' :
    member.seatIndex === 2 || member.seatIndex === 3 ? `成员 ${member.seatIndex - 1}` : '成员');
}

export function paintAvatar(node, profile, fallback) {
  const { nickname, avatarColor } = profileFrom(profile);
  node.textContent = Array.from(nickname)[0] || fallback;
  node.dataset.avatarColor = avatarColor;
}

export function createPreferenceWriter({save, onError, debounce = 250}) {
  const values = {...preferenceDefaults};
  let edits = {}, timer, inFlight;
  function restore(saved) {
    for (const key of Object.keys(preferenceDefaults)) {
      if (Object.hasOwn(saved, key) && !Object.hasOwn(edits, key)) values[key] = saved[key];
    }
  }
  function set(patch) {
    let changed = false;
    for (const [key, value] of Object.entries(patch)) {
      if (!Object.hasOwn(values, key) || values[key] === value) continue;
      edits[key] = values[key] = value;
      changed = true;
    }
    if (changed) {
      clearTimeout(timer);
      timer = setTimeout(() => void flush(), debounce);
    }
  }
  async function flush() {
    clearTimeout(timer);
    while (inFlight) if (!await inFlight) return false;
    if (!Object.keys(edits).length) return true;
    const patch = edits;
    edits = {};
    const savePatch = async () => {
      try {
        const saved = await save(patch);
        // Normalize only the fields in this request. An unrelated field may
        // have a newer value from a separate network change.
        for (const key of Object.keys(patch)) {
          if (!Object.hasOwn(edits, key) && Object.hasOwn(saved, key)) values[key] = saved[key];
        }
        return true;
      } catch (error) {
        edits = {...patch, ...edits};
        onError(error);
        return false;
      } finally {
        inFlight = null;
      }
    };
    inFlight = savePatch();
    return inFlight;
  }
  return {values, restore, set, flush};
}
