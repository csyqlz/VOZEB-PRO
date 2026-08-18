let runtimeProgress = 0;
const listeners = new Set<(progress: number) => void>();

export function getRuntimePlaybackProgress() {
  return runtimeProgress;
}

export function setRuntimePlaybackProgress(progress: number) {
  const nextProgress = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));
  if (nextProgress === runtimeProgress) return runtimeProgress;
  runtimeProgress = nextProgress;
  listeners.forEach((listener) => listener(runtimeProgress));
  return runtimeProgress;
}

export function subscribeRuntimePlayback(listener: (progress: number) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
