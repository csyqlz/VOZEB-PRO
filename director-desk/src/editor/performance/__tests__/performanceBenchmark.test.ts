import { describe, expect, it } from "vitest";
import {
  STANDARD_BENCHMARK_CHARACTER_COUNT,
  STANDARD_BENCHMARK_PROP_COUNT,
  PERFORMANCE_BENCHMARK_SCENES,
  createPerformanceBenchmarkProject,
  createStandardBenchmarkProject,
  getPerformanceBenchmarkPlayback,
  getPerformanceBenchmarkMode,
  summarizeBenchmarkFrames,
} from "../performanceBenchmark";

describe("performance benchmark", () => {
  it("only enables the standard benchmark from the explicit URL parameter", () => {
    expect(getPerformanceBenchmarkMode("?benchmark=standard")).toBe("standard");
    expect(getPerformanceBenchmarkMode("?benchmark=light")).toBe("light");
    expect(getPerformanceBenchmarkMode("?benchmark=medium")).toBe("medium");
    expect(getPerformanceBenchmarkMode("?benchmark=heavy")).toBe("heavy");
    expect(getPerformanceBenchmarkMode("?benchmark=other")).toBeNull();
    expect(getPerformanceBenchmarkMode("")).toBeNull();
  });

  it("builds the agreed light, medium, and heavy scene sizes", () => {
    const expectations = {
      light: { characters: 2, props: 5, monitor: false, panorama: false },
      medium: { characters: 5, props: 20, monitor: true, panorama: false },
      heavy: { characters: 10, props: 50, monitor: true, panorama: true },
    } as const;

    Object.entries(expectations).forEach(([mode, expected]) => {
      const project = createPerformanceBenchmarkProject(mode as "light" | "medium" | "heavy");
      expect(project.objects.filter((object) => object.kind === "character")).toHaveLength(expected.characters);
      expect(project.objects.filter((object) => object.kind === "prop")).toHaveLength(expected.props);
      expect(PERFORMANCE_BENCHMARK_SCENES[mode as "light" | "medium" | "heavy"].monitorEnabled).toBe(expected.monitor);
      expect(Boolean(project.panoramaAssetId)).toBe(expected.panorama);
      expect(project.cameras[0]?.motionPath?.keyframes).toHaveLength(3);
    });
  });

  it("keeps all benchmark props spatially distinct in the heavy scene", () => {
    const project = createPerformanceBenchmarkProject("heavy");
    const positions = project.objects
      .filter((object) => object.kind === "prop")
      .map((object) => object.transform.position.join(","));
    expect(new Set(positions).size).toBe(50);
    expect(project.assets.find((asset) => asset.id === project.panoramaAssetId)).toMatchObject({
      fileName: "benchmark-panorama.jpg",
      projectionMode: "equirectangular",
    });
  });

  it("allows an explicit paused benchmark progress for deterministic export checks", () => {
    expect(getPerformanceBenchmarkPlayback("?benchmark=standard&benchmarkProgress=0.42&benchmarkPlaying=paused"))
      .toEqual({ playing: false, progress: 0.42 });
    expect(getPerformanceBenchmarkPlayback("?benchmark=standard&benchmarkProgress=9"))
      .toEqual({ playing: true, progress: 1 });
    expect(getPerformanceBenchmarkPlayback("?benchmarkProgress=0.5&benchmarkPlaying=paused"))
      .toEqual({ playing: true, progress: 0 });
  });

  it("builds a deterministic animated benchmark scene", () => {
    const project = createStandardBenchmarkProject();
    const characters = project.objects.filter((object) => object.kind === "character");
    const props = project.objects.filter((object) => object.kind === "prop");

    expect(characters).toHaveLength(STANDARD_BENCHMARK_CHARACTER_COUNT);
    expect(props).toHaveLength(STANDARD_BENCHMARK_PROP_COUNT);
    expect(characters.every((character) => character.motionPath?.keyframes.length === 2)).toBe(true);
    expect(project.cameras[0]?.motionPath?.keyframes).toHaveLength(3);
    expect(project.cameras[0]?.motionPath?.loop).toBe(true);
  });

  it("summarizes real frame intervals with stable percentiles", () => {
    expect(summarizeBenchmarkFrames([16, 17, 16, 18, 40])).toEqual({
      averageFps: 46.7,
      averageFrameMs: 21.4,
      frameCount: 5,
      longFrameRatio: 0.2,
      onePercentLowFps: 25,
      p50FrameMs: 17,
      p95FrameMs: 40,
      p99FrameMs: 40,
    });
    expect(summarizeBenchmarkFrames([])).toMatchObject({ averageFps: 0, frameCount: 0 });
  });
});
