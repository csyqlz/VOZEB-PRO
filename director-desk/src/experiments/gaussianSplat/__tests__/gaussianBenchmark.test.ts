import { expect, it } from "vitest";
import { summarizeGaussianFrames } from "../gaussianBenchmark";

it("summarizes average, p95 and one-percent-low Gaussian frame timing", () => {
  expect(summarizeGaussianFrames([16, 16, 17, 18, 40])).toEqual({
    averageFps: 46.7,
    averageFrameMs: 21.4,
    p95FrameMs: 40,
    onePercentLowFps: 25,
    frameCount: 5,
  });
});

it("ignores invalid and suspended-tab frame intervals", () => {
  expect(summarizeGaussianFrames([0, Number.NaN, 2_000])).toMatchObject({ averageFps: 0, frameCount: 0 });
});
