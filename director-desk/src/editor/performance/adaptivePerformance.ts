import type { EffectivePerformanceProfileId } from "./performanceProfiles";

export const ADAPTIVE_SAMPLE_WINDOW_MS = 3_000;
export const ADAPTIVE_SWITCH_COOLDOWN_MS = 9_000;
export const ADAPTIVE_RECOVERY_WINDOW_COUNT = 3;

export interface AdaptiveFrameSummary {
  averageFps: number;
  estimatedRefreshFps: number;
  longFrameRatio: number;
  p95FrameMs: number;
}

export function summarizeAdaptiveFrameWindow(frameIntervalsMs: number[]): AdaptiveFrameSummary {
  const samples = frameIntervalsMs.filter((value) => Number.isFinite(value) && value > 0 && value < 1_000);
  if (samples.length === 0) {
    return { averageFps: 0, estimatedRefreshFps: 60, longFrameRatio: 0, p95FrameMs: 0 };
  }

  const sorted = [...samples].sort((left, right) => left - right);
  const total = samples.reduce((sum, value) => sum + value, 0);
  const p95Index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
  const p10Index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.1) - 1));
  return {
    averageFps: 1_000 / (total / samples.length),
    estimatedRefreshFps: Math.min(60, 1_000 / (sorted[p10Index] ?? 1_000 / 60)),
    longFrameRatio: samples.filter((value) => value > 1_000 / 30).length / samples.length,
    p95FrameMs: sorted[p95Index] ?? 0,
  };
}

export function recommendAdaptivePerformanceProfile(
  current: EffectivePerformanceProfileId,
  summary: AdaptiveFrameSummary
): EffectivePerformanceProfileId {
  if (current === "quality") {
    return summary.averageFps < 52 || summary.p95FrameMs > 24 || summary.longFrameRatio > 0.06
      ? "balanced"
      : "quality";
  }
  if (current === "balanced") {
    return summary.averageFps < 45 || summary.p95FrameMs > 30 || summary.longFrameRatio > 0.1
      ? "fluid"
      : "balanced";
  }
  const recoveryFps = Math.max(45, summary.estimatedRefreshFps * 0.94);
  return summary.averageFps >= recoveryFps && summary.p95FrameMs <= 24 && summary.longFrameRatio <= 0.02
    ? "balanced"
    : "fluid";
}
