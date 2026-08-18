export type PerformanceProfileId = "auto" | "fluid" | "balanced" | "quality";
export type EffectivePerformanceProfileId = Exclude<PerformanceProfileId, "auto">;

export interface PerformanceCapabilities {
  deviceMemoryGb?: number | null;
  devicePixelRatio: number;
  hardwareConcurrency: number;
}

export interface PerformanceProfileConfig {
  id: EffectivePerformanceProfileId;
  label: string;
  description: string;
  mainDpr: number | [number, number];
  monitorDpr: number | [number, number];
  gizmoDpr: number | [number, number];
  antialias: boolean;
  preserveDrawingBuffer: boolean;
  playbackUiFps: number;
}

export const PERFORMANCE_PROFILE_OPTIONS: Array<{
  id: PerformanceProfileId;
  label: string;
  description: string;
}> = [
  { id: "auto", label: "自动", description: "根据电脑性能自动选择" },
  { id: "fluid", label: "流畅", description: "优先降低卡顿，适合 Windows 集显和大场景" },
  { id: "quality", label: "高清", description: "优先保证画面清晰，适合性能较强的电脑" },
];

export const PERFORMANCE_PROFILE_CONFIGS: Record<EffectivePerformanceProfileId, PerformanceProfileConfig> = {
  fluid: {
    id: "fluid",
    label: "流畅",
    description: "较低渲染分辨率和 24 次/秒界面同步",
    mainDpr: 0.75,
    monitorDpr: 0.65,
    gizmoDpr: 0.65,
    antialias: false,
    preserveDrawingBuffer: false,
    playbackUiFps: 24,
  },
  balanced: {
    id: "balanced",
    label: "均衡",
    description: "标准渲染分辨率和 30 次/秒界面同步",
    mainDpr: 1,
    monitorDpr: 0.85,
    gizmoDpr: 0.85,
    antialias: true,
    preserveDrawingBuffer: false,
    playbackUiFps: 30,
  },
  quality: {
    id: "quality",
    label: "高清",
    description: "高分屏渲染和 60 次/秒界面同步",
    mainDpr: [1, 2],
    monitorDpr: [1, 1.5],
    gizmoDpr: [1, 2],
    antialias: true,
    preserveDrawingBuffer: true,
    playbackUiFps: 60,
  },
};

export function normalizePerformanceProfileId(value: unknown): PerformanceProfileId {
  return value === "fluid" || value === "quality" ? value : "auto";
}

export function detectPerformanceCapabilities(): PerformanceCapabilities {
  if (typeof navigator === "undefined" || typeof window === "undefined") {
    return { devicePixelRatio: 1, hardwareConcurrency: 4, deviceMemoryGb: null };
  }
  const extendedNavigator = navigator as Navigator & { deviceMemory?: number };
  return {
    devicePixelRatio: Math.max(1, window.devicePixelRatio || 1),
    hardwareConcurrency: Math.max(1, navigator.hardwareConcurrency || 4),
    deviceMemoryGb: Number.isFinite(extendedNavigator.deviceMemory) ? extendedNavigator.deviceMemory ?? null : null,
  };
}

export function resolveAutomaticPerformanceProfile(
  capabilities: PerformanceCapabilities
): EffectivePerformanceProfileId {
  if (
    capabilities.hardwareConcurrency <= 8
    || (capabilities.deviceMemoryGb !== null
      && capabilities.deviceMemoryGb !== undefined
      && capabilities.deviceMemoryGb <= 4)
  ) {
    return "fluid";
  }
  return "balanced";
}

export function getEffectivePerformanceProfile(
  profile: PerformanceProfileId,
  capabilities: PerformanceCapabilities = detectPerformanceCapabilities()
) {
  const effectiveId = profile === "auto" ? resolveAutomaticPerformanceProfile(capabilities) : profile;
  return PERFORMANCE_PROFILE_CONFIGS[effectiveId];
}

export function getBenchmarkPerformanceProfile(search: string): PerformanceProfileId | null {
  try {
    const value = new URLSearchParams(search).get("performance");
    return value === "fluid" || value === "balanced" || value === "quality" ? value : null;
  } catch {
    return null;
  }
}
