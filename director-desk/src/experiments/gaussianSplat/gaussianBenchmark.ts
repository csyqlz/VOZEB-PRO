export const GAUSSIAN_BENCHMARK_DURATION_MS = 6_000;

export interface GaussianFrameSummary {
  averageFps: number;
  averageFrameMs: number;
  p95FrameMs: number;
  onePercentLowFps: number;
  frameCount: number;
}

function round(value: number, digits = 1) {
  return Number(value.toFixed(digits));
}

export function summarizeGaussianFrames(frameIntervalsMs: number[]): GaussianFrameSummary {
  const samples = frameIntervalsMs.filter((value) => Number.isFinite(value) && value > 0 && value < 1_000);
  if (samples.length === 0) {
    return { averageFps: 0, averageFrameMs: 0, p95FrameMs: 0, onePercentLowFps: 0, frameCount: 0 };
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const averageFrameMs = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
  const p99 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1)] ?? 0;
  return {
    averageFps: round(1_000 / averageFrameMs),
    averageFrameMs: round(averageFrameMs, 2),
    p95FrameMs: round(p95, 2),
    onePercentLowFps: p99 > 0 ? round(1_000 / p99) : 0,
    frameCount: samples.length,
  };
}
