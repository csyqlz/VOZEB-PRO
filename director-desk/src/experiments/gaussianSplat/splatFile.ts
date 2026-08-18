export const GAUSSIAN_SPLAT_FILE_EXTENSIONS = [".ply", ".splat", ".ksplat"] as const;
export const DEFAULT_MAX_GAUSSIAN_SPLAT_FILE_BYTES = 512 * 1_024 * 1_024;
export const SPLAT_BYTES_PER_POINT = 32;
export const ESTIMATED_CPU_BYTES_PER_POINT = 64;
export const ESTIMATED_GPU_BYTES_PER_POINT = 48;
export const GAUSSIAN_SPLAT_BENCHMARK_SCHEMA_VERSION = 1;

export type GaussianSplatFormat = "ply" | "splat" | "ksplat";

export interface GaussianSplatFileLike {
  name: string;
  size: number;
}

export interface GaussianSplatFileSummary {
  format: GaussianSplatFormat;
  byteLength: number;
  pointCount: number | null;
}

export type GaussianSplatFileValidationErrorCode =
  | "unsupported-format"
  | "invalid-size"
  | "empty-file"
  | "file-too-large"
  | "invalid-splat-record-size";

export type GaussianSplatFileValidationResult =
  | ({ ok: true } & GaussianSplatFileSummary)
  | {
      ok: false;
      code: GaussianSplatFileValidationErrorCode;
      message: string;
    };

export interface GaussianSplatFileValidationOptions {
  maxBytes?: number;
}

export interface GaussianSplatWorkingMemoryEstimate {
  cpuBytes: number;
  gpuBytes: number;
  totalBytes: number;
}

export interface GaussianSplatBenchmarkInput {
  file: GaussianSplatFileSummary;
  loadDurationMs: number;
  averageFps: number;
  p95FrameMs: number;
  frameCount: number;
  sampleDurationMs: number;
}

export interface AnonymousGaussianSplatBenchmarkDto {
  schemaVersion: 1;
  asset: GaussianSplatFileSummary;
  estimatedWorkingMemory: GaussianSplatWorkingMemoryEstimate;
  performance: {
    loadDurationMs: number;
    averageFps: number;
    p95FrameMs: number;
    frameCount: number;
    sampleDurationMs: number;
  };
}

export interface AnonymousGaussianSplatBenchmarkReport extends AnonymousGaussianSplatBenchmarkDto {
  performance: AnonymousGaussianSplatBenchmarkDto["performance"] & {
    onePercentLowFps: number;
    browserHeapDeltaBytes: number | null;
  };
  system: {
    browser: string;
    gpu: string;
    hardwareConcurrency: number | null;
  };
  canvas: {
    width: number;
    height: number;
    devicePixelRatio: number;
  };
  scene: {
    meshObjects: number;
    proxyCount: number;
    collisionEnabled: boolean;
  };
}

export interface AnonymousGaussianSplatBenchmarkReportInput extends GaussianSplatBenchmarkInput {
  onePercentLowFps: number;
  browserHeapDeltaBytes: number | null;
  system: AnonymousGaussianSplatBenchmarkReport["system"];
  canvas: AnonymousGaussianSplatBenchmarkReport["canvas"];
  scene: AnonymousGaussianSplatBenchmarkReport["scene"];
}

const FORMAT_BY_EXTENSION: Record<(typeof GAUSSIAN_SPLAT_FILE_EXTENSIONS)[number], GaussianSplatFormat> = {
  ".ply": "ply",
  ".splat": "splat",
  ".ksplat": "ksplat",
};

function assertFiniteNonNegative(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite non-negative number`);
  }
}

export function getGaussianSplatFormat(fileName: string): GaussianSplatFormat | null {
  const normalizedName = fileName.trim().toLowerCase();
  const extension = GAUSSIAN_SPLAT_FILE_EXTENSIONS.find((candidate) => normalizedName.endsWith(candidate));
  return extension ? FORMAT_BY_EXTENSION[extension] : null;
}

export function validateGaussianSplatFile(
  file: GaussianSplatFileLike,
  options: GaussianSplatFileValidationOptions = {}
): GaussianSplatFileValidationResult {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_GAUSSIAN_SPLAT_FILE_BYTES;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new RangeError("maxBytes must be a finite positive number");
  }

  const format = getGaussianSplatFormat(file.name);
  if (!format) {
    return {
      ok: false,
      code: "unsupported-format",
      message: "仅支持 .ply、.splat 和 .ksplat 文件",
    };
  }
  if (!Number.isFinite(file.size) || !Number.isSafeInteger(file.size) || file.size < 0) {
    return {
      ok: false,
      code: "invalid-size",
      message: "文件大小无效",
    };
  }
  if (file.size === 0) {
    return {
      ok: false,
      code: "empty-file",
      message: "文件不能为空",
    };
  }
  if (file.size > maxBytes) {
    return {
      ok: false,
      code: "file-too-large",
      message: `文件不能超过 ${formatBytes(maxBytes)}`,
    };
  }
  if (format === "splat" && file.size % SPLAT_BYTES_PER_POINT !== 0) {
    return {
      ok: false,
      code: "invalid-splat-record-size",
      message: `.splat 文件大小必须是 ${SPLAT_BYTES_PER_POINT} 字节记录的整数倍`,
    };
  }

  return {
    ok: true,
    format,
    byteLength: file.size,
    pointCount: format === "splat" ? file.size / SPLAT_BYTES_PER_POINT : null,
  };
}

export function formatBytes(byteLength: number, maximumFractionDigits = 2) {
  assertFiniteNonNegative(byteLength, "byteLength");
  if (!Number.isInteger(maximumFractionDigits) || maximumFractionDigits < 0 || maximumFractionDigits > 20) {
    throw new RangeError("maximumFractionDigits must be an integer from 0 to 20");
  }
  if (byteLength === 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  const unitIndex = Math.min(Math.floor(Math.log(byteLength) / Math.log(1_024)), units.length - 1);
  const value = byteLength / 1_024 ** unitIndex;
  const formatted = Number(value.toFixed(maximumFractionDigits)).toString();
  return `${formatted} ${units[unitIndex]}`;
}

export function estimateGaussianSplatWorkingMemory(
  file: GaussianSplatFileSummary
): GaussianSplatWorkingMemoryEstimate {
  assertFiniteNonNegative(file.byteLength, "byteLength");
  if (file.pointCount !== null) {
    assertFiniteNonNegative(file.pointCount, "pointCount");
  }

  const cpuBytes = Math.ceil(Math.max(
    file.byteLength * 2,
    (file.pointCount ?? 0) * ESTIMATED_CPU_BYTES_PER_POINT
  ));
  const gpuBytes = Math.ceil(file.pointCount === null
    ? file.byteLength * 2
    : file.pointCount * ESTIMATED_GPU_BYTES_PER_POINT);

  return {
    cpuBytes,
    gpuBytes,
    totalBytes: cpuBytes + gpuBytes,
  };
}

export function buildAnonymousGaussianSplatBenchmarkDto(
  input: GaussianSplatBenchmarkInput
): AnonymousGaussianSplatBenchmarkDto {
  const asset: GaussianSplatFileSummary = {
    format: input.file.format,
    byteLength: input.file.byteLength,
    pointCount: input.file.pointCount,
  };

  return {
    schemaVersion: GAUSSIAN_SPLAT_BENCHMARK_SCHEMA_VERSION,
    asset,
    estimatedWorkingMemory: estimateGaussianSplatWorkingMemory(asset),
    performance: {
      loadDurationMs: input.loadDurationMs,
      averageFps: input.averageFps,
      p95FrameMs: input.p95FrameMs,
      frameCount: input.frameCount,
      sampleDurationMs: input.sampleDurationMs,
    },
  };
}

export function buildAnonymousGaussianSplatBenchmarkReport(
  input: AnonymousGaussianSplatBenchmarkReportInput
): AnonymousGaussianSplatBenchmarkReport {
  const base = buildAnonymousGaussianSplatBenchmarkDto(input);
  return {
    ...base,
    performance: {
      ...base.performance,
      onePercentLowFps: input.onePercentLowFps,
      browserHeapDeltaBytes: input.browserHeapDeltaBytes,
    },
    system: {
      browser: input.system.browser,
      gpu: input.system.gpu,
      hardwareConcurrency: input.system.hardwareConcurrency,
    },
    canvas: {
      width: input.canvas.width,
      height: input.canvas.height,
      devicePixelRatio: input.canvas.devicePixelRatio,
    },
    scene: {
      meshObjects: input.scene.meshObjects,
      proxyCount: input.scene.proxyCount,
      collisionEnabled: input.scene.collisionEnabled,
    },
  };
}
