import { describe, expect, it } from "vitest";
import {
  PERFORMANCE_PROFILE_OPTIONS,
  getBenchmarkPerformanceProfile,
  getEffectivePerformanceProfile,
  normalizePerformanceProfileId,
  resolveAutomaticPerformanceProfile,
} from "../performanceProfiles";

describe("performance profiles", () => {
  it("keeps the beginner-facing choices to auto, fluid and quality", () => {
    expect(PERFORMANCE_PROFILE_OPTIONS.map((option) => [option.id, option.label])).toEqual([
      ["auto", "自动"],
      ["fluid", "流畅"],
      ["quality", "高清"],
    ]);
  });
  it("normalizes persisted profile values", () => {
    expect(normalizePerformanceProfileId("fluid")).toBe("fluid");
    expect(normalizePerformanceProfileId("balanced")).toBe("auto");
    expect(normalizePerformanceProfileId("quality")).toBe("quality");
    expect(normalizePerformanceProfileId("unknown")).toBe("auto");
  });

  it("selects fluid for entry hardware and balanced for stronger hardware", () => {
    expect(resolveAutomaticPerformanceProfile({ hardwareConcurrency: 4, devicePixelRatio: 1 })).toBe("fluid");
    expect(resolveAutomaticPerformanceProfile({ hardwareConcurrency: 16, devicePixelRatio: 2 })).toBe("balanced");
    expect(resolveAutomaticPerformanceProfile({ hardwareConcurrency: 16, devicePixelRatio: 1, deviceMemoryGb: 4 })).toBe("fluid");
  });

  it("resolves stable rendering settings for each visible choice", () => {
    expect(getEffectivePerformanceProfile("fluid").mainDpr).toBe(0.75);
    expect(getEffectivePerformanceProfile("balanced").playbackUiFps).toBe(30);
    expect(getEffectivePerformanceProfile("quality").preserveDrawingBuffer).toBe(true);
    expect(getEffectivePerformanceProfile("auto", { hardwareConcurrency: 4, devicePixelRatio: 1 }).id).toBe("fluid");
  });

  it("allows the benchmark URL to select a profile", () => {
    expect(getBenchmarkPerformanceProfile("?benchmark=standard&performance=fluid")).toBe("fluid");
    expect(getBenchmarkPerformanceProfile("?benchmark=medium&performance=balanced")).toBe("balanced");
    expect(getBenchmarkPerformanceProfile("?benchmark=standard")).toBeNull();
  });
});
