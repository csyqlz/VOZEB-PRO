import { describe, expect, it } from "vitest";
import {
  recommendAdaptivePerformanceProfile,
  summarizeAdaptiveFrameWindow,
} from "../adaptivePerformance";

describe("adaptive performance", () => {
  it("summarizes a frame window without accepting stalled background-tab frames", () => {
    const summary = summarizeAdaptiveFrameWindow([16, 17, 16, 40, 2_000]);
    expect(summary.averageFps).toBeCloseTo(44.94, 1);
    expect(summary.estimatedRefreshFps).toBe(60);
    expect(summary.longFrameRatio).toBe(0.25);
    expect(summary.p95FrameMs).toBe(40);
  });

  it("drops one level when balanced or quality cannot sustain smooth playback", () => {
    expect(recommendAdaptivePerformanceProfile("quality", {
      averageFps: 45,
      estimatedRefreshFps: 60,
      longFrameRatio: 0.08,
      p95FrameMs: 28,
    })).toBe("balanced");
    expect(recommendAdaptivePerformanceProfile("balanced", {
      averageFps: 40,
      estimatedRefreshFps: 60,
      longFrameRatio: 0.12,
      p95FrameMs: 34,
    })).toBe("fluid");
  });

  it("only recommends recovery from fluid for a consistently healthy window", () => {
    expect(recommendAdaptivePerformanceProfile("fluid", {
      averageFps: 58,
      estimatedRefreshFps: 60,
      longFrameRatio: 0.01,
      p95FrameMs: 18,
    })).toBe("balanced");
    expect(recommendAdaptivePerformanceProfile("fluid", {
      averageFps: 54,
      estimatedRefreshFps: 60,
      longFrameRatio: 0,
      p95FrameMs: 18,
    })).toBe("fluid");
    expect(recommendAdaptivePerformanceProfile("fluid", {
      averageFps: 48,
      estimatedRefreshFps: 50,
      longFrameRatio: 0,
      p95FrameMs: 21,
    })).toBe("balanced");
  });
});
