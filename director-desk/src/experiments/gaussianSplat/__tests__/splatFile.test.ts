import { describe, expect, it } from "vitest";
import {
  buildAnonymousGaussianSplatBenchmarkDto,
  buildAnonymousGaussianSplatBenchmarkReport,
  estimateGaussianSplatWorkingMemory,
  formatBytes,
  validateGaussianSplatFile,
} from "../splatFile";

describe("gaussian splat local file validation", () => {
  it.each([
    ["scan.ply", "ply"],
    ["scan.SPLAT", "splat"],
    ["scan.KsPlAt", "ksplat"],
  ] as const)("accepts the whitelisted %s format case-insensitively", (name, format) => {
    const result = validateGaussianSplatFile({ name, size: 3_200 });

    expect(result).toMatchObject({ ok: true, format, byteLength: 3_200 });
  });

  it("rejects unsupported formats, empty files and files above the configured limit", () => {
    expect(validateGaussianSplatFile({ name: "scan.spz", size: 100 })).toMatchObject({
      ok: false,
      code: "unsupported-format",
    });
    expect(validateGaussianSplatFile({ name: "scan.ply", size: 0 })).toMatchObject({
      ok: false,
      code: "empty-file",
    });
    expect(validateGaussianSplatFile({ name: "scan.ply", size: 101 }, { maxBytes: 100 })).toMatchObject({
      ok: false,
      code: "file-too-large",
    });
  });

  it("derives .splat point counts from complete 32-byte records", () => {
    expect(validateGaussianSplatFile({ name: "scan.splat", size: 3_200 })).toEqual({
      ok: true,
      format: "splat",
      byteLength: 3_200,
      pointCount: 100,
    });
    expect(validateGaussianSplatFile({ name: "scan.splat", size: 3_201 })).toMatchObject({
      ok: false,
      code: "invalid-splat-record-size",
    });
  });

  it("does not invent point counts for formats whose record layout is not fixed", () => {
    expect(validateGaussianSplatFile({ name: "scan.ply", size: 3_200 })).toMatchObject({
      ok: true,
      pointCount: null,
    });
    expect(validateGaussianSplatFile({ name: "scan.ksplat", size: 3_200 })).toMatchObject({
      ok: true,
      pointCount: null,
    });
  });
});

describe("gaussian splat performance report helpers", () => {
  it("formats bytes with binary units and stable precision", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1_024)).toBe("1 KB");
    expect(formatBytes(1.5 * 1_024 * 1_024)).toBe("1.5 MB");
    expect(formatBytes(2 * 1_024 * 1_024 * 1_024)).toBe("2 GB");
  });

  it("estimates separate CPU and GPU working memory", () => {
    expect(estimateGaussianSplatWorkingMemory({
      format: "splat",
      byteLength: 3_200,
      pointCount: 100,
    })).toEqual({
      cpuBytes: 6_400,
      gpuBytes: 4_800,
      totalBytes: 11_200,
    });

    expect(estimateGaussianSplatWorkingMemory({
      format: "ply",
      byteLength: 1_000,
      pointCount: null,
    })).toEqual({
      cpuBytes: 2_000,
      gpuBytes: 2_000,
      totalBytes: 4_000,
    });
  });

  it("builds an anonymous benchmark DTO from an explicit whitelist", () => {
    const input = {
      file: {
        format: "splat" as const,
        byteLength: 3_200,
        pointCount: 100,
        name: "private-room.splat",
        path: "/Users/person/project/private-room.splat",
        url: "file:///Users/person/project/private-room.splat",
      },
      loadDurationMs: 52.35,
      averageFps: 59.8,
      p95FrameMs: 18.4,
      frameCount: 360,
      sampleDurationMs: 6_000,
      projectName: "private-project",
    };

    const dto = buildAnonymousGaussianSplatBenchmarkDto(input);
    const serialized = JSON.stringify(dto);

    expect(dto).toEqual({
      schemaVersion: 1,
      asset: { format: "splat", byteLength: 3_200, pointCount: 100 },
      estimatedWorkingMemory: { cpuBytes: 6_400, gpuBytes: 4_800, totalBytes: 11_200 },
      performance: {
        loadDurationMs: 52.35,
        averageFps: 59.8,
        p95FrameMs: 18.4,
        frameCount: 360,
        sampleDurationMs: 6_000,
      },
    });
    expect(serialized).not.toContain("private-room");
    expect(serialized).not.toContain("/Users/");
    expect(serialized).not.toContain("file://");
    expect(serialized).not.toContain("private-project");
  });

  it("adds only the approved system, canvas and scene fields to a full report", () => {
    const input = {
      file: { format: "ksplat" as const, byteLength: 10_000, pointCount: 200 },
      loadDurationMs: 80,
      averageFps: 48,
      p95FrameMs: 24,
      frameCount: 288,
      sampleDurationMs: 6_000,
      onePercentLowFps: 33,
      browserHeapDeltaBytes: 2_000,
      system: { browser: "Edge 140", gpu: "RTX 3060", hardwareConcurrency: 16 },
      canvas: { width: 1920, height: 1080, devicePixelRatio: 1 },
      scene: { meshObjects: 3, proxyCount: 2, collisionEnabled: true },
      fileName: "private-room.ksplat",
      url: "file:///Users/person/private-room.ksplat",
    };
    const report = buildAnonymousGaussianSplatBenchmarkReport(input);

    expect(report.system).toEqual({ browser: "Edge 140", gpu: "RTX 3060", hardwareConcurrency: 16 });
    expect(report.performance.browserHeapDeltaBytes).toBe(2_000);
    expect(JSON.stringify(report)).not.toContain("private-room");
    expect(JSON.stringify(report)).not.toContain("file://");
  });
});
