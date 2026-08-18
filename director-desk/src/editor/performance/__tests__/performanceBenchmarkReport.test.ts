import { afterEach, describe, expect, it, vi } from "vitest";
import type { DirectorBenchmarkReport } from "../performanceBenchmark";
import {
  buildPerformanceBenchmarkUrl,
  buildPublicPerformanceBenchmarkReport,
  detectBrowserLabel,
  detectOperatingSystemLabel,
  downloadPerformanceBenchmarkReport,
} from "../performanceBenchmarkReport";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const report: DirectorBenchmarkReport = {
  status: "complete",
  mode: "medium",
  performanceProfile: "balanced",
  appVersion: "0.2.0",
  averageFps: 60,
  averageFrameMs: 16.67,
  frameCount: 360,
  longFrameRatio: 0,
  onePercentLowFps: 55,
  p50FrameMs: 16,
  p95FrameMs: 18,
  p99FrameMs: 18.2,
  canvasCount: 3,
  devicePixelRatio: 2,
  system: {
    browser: "Chrome 140",
    hardwareConcurrency: 16,
    platform: "MacIntel",
    webglRenderer: "Apple M5 Pro",
  },
  renderer: { calls: 20, geometries: 15, textures: 4, triangles: 20_000 },
  scene: { characters: 5, props: 20, monitorEnabled: true, panoramaEnabled: false },
  viewport: { cssHeight: 720, cssWidth: 1280, pixelHeight: 720, pixelWidth: 1280 },
};

describe("performance benchmark report", () => {
  it("exports only the explicit anonymous report whitelist", () => {
    const input = {
      ...report,
      projectName: "私人导演台",
      url: "https://example.test/?token=secret",
      localPath: "/Users/name/private.glb",
    } as DirectorBenchmarkReport;
    const publicReport = buildPublicPerformanceBenchmarkReport(input);
    const serialized = JSON.stringify(publicReport);

    expect(publicReport).toEqual({
      schemaVersion: 3,
      benchmark: { mode: "medium", performanceProfile: "balanced", appVersion: "0.2.0" },
      fps: { average: 60, onePercentLow: 55 },
      frameTimeMs: { average: 16.67, p50FrameMs: 16, p95FrameMs: 18, p99FrameMs: 18.2 },
      browser: "Chrome 140",
      operatingSystem: "macOS",
      gpu: "Apple M5 Pro",
      threads: 16,
      sceneScale: { characters: 5, props: 20, monitorEnabled: true, panoramaEnabled: false },
      canvas: { cssHeight: 720, cssWidth: 1280, pixelHeight: 720, pixelWidth: 1280 },
    });
    expect(serialized).not.toContain("私人导演台");
    expect(serialized).not.toContain("token=secret");
    expect(serialized).not.toContain("/Users/");
  });

  it("builds a clean benchmark URL without carrying a director desk id", () => {
    const url = new URL(buildPerformanceBenchmarkUrl(
      "http://127.0.0.1:5176/?instanceId=desk_4&benchmarkProgress=0.5",
      "heavy",
      "fluid"
    ));
    expect(url.searchParams.get("instanceId")).toBeNull();
    expect(url.searchParams.get("benchmarkProgress")).toBeNull();
    expect(url.searchParams.get("benchmark")).toBe("heavy");
    expect(url.searchParams.get("performance")).toBe("fluid");
  });

  it("reports only browser family and major version", () => {
    expect(detectBrowserLabel("Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36")).toBe("Chrome 140");
    expect(detectBrowserLabel("Mozilla/5.0 Version/18.5 Safari/605.1.15")).toBe("Safari 18");
  });

  it("reports a normalized operating system without exposing the raw platform string", () => {
    expect(detectOperatingSystemLabel("Win32")).toBe("Windows");
    expect(detectOperatingSystemLabel("MacIntel")).toBe("macOS");
    expect(detectOperatingSystemLabel("Linux x86_64")).toBe("Linux");
    expect(JSON.stringify(buildPublicPerformanceBenchmarkReport(report))).not.toContain("MacIntel");
  });

  it("mounts a fixed-name JSON download and releases its Blob URL", () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn(() => "blob:anonymous-report");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    downloadPerformanceBenchmarkReport(report);

    const anchor = click.mock.instances[0] as HTMLAnchorElement;
    expect(anchor.download).toBe("director-performance-report.json");
    expect(anchor.href).toBe("blob:anonymous-report");
    expect(anchor.isConnected).toBe(false);
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:anonymous-report");
  });
});
