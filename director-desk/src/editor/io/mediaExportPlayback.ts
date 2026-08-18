export interface MediaExportPlaybackSnapshot {
  playing: boolean;
  progress: number;
}

export function restoreMediaExportPlayback(
  snapshot: MediaExportPlaybackSnapshot,
  setPlaying: (playing: boolean) => void,
  setProgress: (progress: number) => void
) {
  setPlaying(false);
  setProgress(snapshot.progress);
  if (snapshot.playing) setPlaying(true);
}
