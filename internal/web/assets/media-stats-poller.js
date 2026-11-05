// Keep a small history while sharing, and collect detailed stats only when read.
// A timeout is scheduled after each sample so slow browser reports cannot overlap.
export function createMediaStatsPoller({ sample, getState, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout }) {
  let timer = null, interval = null, previous = '', running = false, pending = false, stopped = false;
  function cancelTimer() {
    if (timer !== null) clearTimeoutImpl(timer);
    timer = null;
  }
  async function run() {
    if (stopped || interval === null) return;
    if (running) { pending = true; return; }
    running = true;
    try { await sample(); }
    finally {
      running = false;
      if (!stopped && interval !== null) {
        if (pending) { pending = false; void run(); }
        else timer = setTimeoutImpl(() => { timer = null; void run(); }, interval);
      }
    }
  }
  return {
    sync() {
      if (stopped) return;
      const { active, diagnosticsVisible, hidden, context = '' } = getState();
      const next = active ? (diagnosticsVisible && !hidden ? 2000 : 10000) : null;
      const key = `${next}:${!!hidden}:${context}`;
      if (key === previous) return;
      previous = key; interval = next; pending = false;
      cancelTimer();
      if (interval !== null) void run();
    },
    stop() { stopped = true; pending = false; interval = null; cancelTimer(); },
  };
}
