const playbackGeneration = new WeakMap();

export function setPreviewStream(video, stream, onBlocked = () => {}) {
  if (video.srcObject === (stream ?? null)) return;
  const generation = (playbackGeneration.get(video) ?? 0) + 1;
  playbackGeneration.set(video, generation);
  video.srcObject = stream ?? null;
  if (!stream) return;

  const reportIfCurrent = () => {
    if (playbackGeneration.get(video) === generation && video.srcObject === stream) onBlocked();
  };
  try {
    Promise.resolve(video.play()).catch(reportIfCurrent);
  } catch {
    reportIfCurrent();
  }
}
