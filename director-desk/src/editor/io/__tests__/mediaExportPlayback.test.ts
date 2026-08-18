import { expect, it, vi } from "vitest";
import { restoreMediaExportPlayback } from "../mediaExportPlayback";

it("restores a paused timeline without restarting it", () => {
  const setPlaying = vi.fn();
  const setProgress = vi.fn();

  restoreMediaExportPlayback({ playing: false, progress: 0.42 }, setPlaying, setProgress);

  expect(setPlaying).toHaveBeenCalledTimes(1);
  expect(setPlaying).toHaveBeenCalledWith(false);
  expect(setProgress).toHaveBeenCalledWith(0.42);
});

it("restores a playing timeline after its exact progress", () => {
  const calls: string[] = [];

  restoreMediaExportPlayback(
    { playing: true, progress: 0.625 },
    (playing) => calls.push(`playing:${playing}`),
    (progress) => calls.push(`progress:${progress}`)
  );

  expect(calls).toEqual(["playing:false", "progress:0.625", "playing:true"]);
});
