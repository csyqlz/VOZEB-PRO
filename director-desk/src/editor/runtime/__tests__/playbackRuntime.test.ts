import { expect, it, vi } from "vitest";
import { getRuntimePlaybackProgress, setRuntimePlaybackProgress, subscribeRuntimePlayback } from "../playbackRuntime";

it("keeps high-frequency playback progress outside React state", () => {
  expect(setRuntimePlaybackProgress(0.42)).toBe(0.42);
  expect(getRuntimePlaybackProgress()).toBe(0.42);
  expect(setRuntimePlaybackProgress(9)).toBe(1);
  expect(setRuntimePlaybackProgress(-9)).toBe(0);
});

it("notifies runtime scene nodes without React subscriptions", () => {
  const values: number[] = [];
  const unsubscribe = subscribeRuntimePlayback((value) => values.push(value));
  setRuntimePlaybackProgress(0.2);
  setRuntimePlaybackProgress(0.6);
  unsubscribe();
  setRuntimePlaybackProgress(0.9);
  expect(values).toEqual([0.2, 0.6]);
});

it("does not notify runtime scene nodes when progress is unchanged", () => {
  setRuntimePlaybackProgress(0.35);
  const listener = vi.fn();
  const unsubscribe = subscribeRuntimePlayback(listener);

  setRuntimePlaybackProgress(0.35);

  expect(listener).not.toHaveBeenCalled();
  unsubscribe();
});
