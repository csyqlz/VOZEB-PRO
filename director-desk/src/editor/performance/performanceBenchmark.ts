import type {
  DirectorObject,
  DirectorProject,
  DirectorTransform,
} from "../schema/directorProject";
import { createDefaultDirectorProject } from "../store/directorStore";
import type { EffectivePerformanceProfileId } from "./performanceProfiles";

export const STANDARD_BENCHMARK_CHARACTER_COUNT = 25;
export const STANDARD_BENCHMARK_PROP_COUNT = 12;
export const STANDARD_BENCHMARK_WARMUP_MS = 2_000;
export const STANDARD_BENCHMARK_SAMPLE_MS = 6_000;

export type PerformanceBenchmarkMode = "standard" | "light" | "medium" | "heavy";

export interface PerformanceBenchmarkSceneConfig {
  id: PerformanceBenchmarkMode;
  label: string;
  characterCount: number;
  propCount: number;
  monitorEnabled: boolean;
  panoramaEnabled: boolean;
}

export const PERFORMANCE_BENCHMARK_SCENES: Record<PerformanceBenchmarkMode, PerformanceBenchmarkSceneConfig> = {
  standard: { id: "standard", label: "历史压力", characterCount: 25, propCount: 12, monitorEnabled: true, panoramaEnabled: false },
  light: { id: "light", label: "轻量", characterCount: 2, propCount: 5, monitorEnabled: false, panoramaEnabled: false },
  medium: { id: "medium", label: "中等", characterCount: 5, propCount: 20, monitorEnabled: true, panoramaEnabled: false },
  heavy: { id: "heavy", label: "重型", characterCount: 10, propCount: 50, monitorEnabled: true, panoramaEnabled: true },
};

export interface PerformanceBenchmarkSummary {
  averageFps: number;
  averageFrameMs: number;
  frameCount: number;
  longFrameRatio: number;
  onePercentLowFps: number;
  p50FrameMs: number;
  p95FrameMs: number;
  p99FrameMs: number;
}

export interface DirectorBenchmarkReport extends PerformanceBenchmarkSummary {
  status: "complete";
  mode: PerformanceBenchmarkMode;
  performanceProfile: EffectivePerformanceProfileId;
  appVersion: string;
  canvasCount: number;
  devicePixelRatio: number;
  system: {
    browser: string;
    hardwareConcurrency: number | null;
    platform: string;
    webglRenderer: string;
  };
  renderer: {
    calls: number;
    geometries: number;
    textures: number;
    triangles: number;
  };
  scene: {
    characters: number;
    props: number;
    monitorEnabled: boolean;
    panoramaEnabled: boolean;
  };
  viewport: {
    cssHeight: number;
    cssWidth: number;
    pixelHeight: number;
    pixelWidth: number;
  };
}

declare global {
  interface Window {
    __DIRECTOR_BENCHMARK_REPORT__?: DirectorBenchmarkReport;
    __DIRECTOR_BENCHMARK_STATUS__?: "warming-up" | "sampling" | "complete";
  }
}

function round(value: number, digits = 2) {
  return Number(value.toFixed(digits));
}

function percentile(sortedValues: number[], ratio: number) {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * ratio) - 1));
  return sortedValues[index] ?? 0;
}

export function summarizeBenchmarkFrames(frameIntervalsMs: number[]): PerformanceBenchmarkSummary {
  const samples = frameIntervalsMs.filter((value) => Number.isFinite(value) && value > 0);
  if (samples.length === 0) {
    return {
      averageFps: 0,
      averageFrameMs: 0,
      frameCount: 0,
      longFrameRatio: 0,
      onePercentLowFps: 0,
      p50FrameMs: 0,
      p95FrameMs: 0,
      p99FrameMs: 0,
    };
  }

  const sorted = [...samples].sort((left, right) => left - right);
  const total = samples.reduce((sum, value) => sum + value, 0);
  const averageFrameMs = total / samples.length;
  const longFrames = samples.filter((value) => value > 1000 / 30).length;
  const p99FrameMs = percentile(sorted, 0.99);

  return {
    averageFps: round(1000 / averageFrameMs, 1),
    averageFrameMs: round(averageFrameMs),
    frameCount: samples.length,
    longFrameRatio: round(longFrames / samples.length, 4),
    onePercentLowFps: p99FrameMs > 0 ? round(1000 / p99FrameMs, 1) : 0,
    p50FrameMs: round(percentile(sorted, 0.5)),
    p95FrameMs: round(percentile(sorted, 0.95)),
    p99FrameMs: round(p99FrameMs),
  };
}

export function getPerformanceBenchmarkMode(search: string): PerformanceBenchmarkMode | null {
  try {
    const mode = new URLSearchParams(search).get("benchmark");
    return mode === "standard" || mode === "light" || mode === "medium" || mode === "heavy" ? mode : null;
  } catch {
    return null;
  }
}

export function getPerformanceBenchmarkPlayback(search: string) {
  if (!getPerformanceBenchmarkMode(search)) return { playing: true, progress: 0 };
  try {
    const params = new URLSearchParams(search);
    const rawProgress = Number(params.get("benchmarkProgress"));
    return {
      playing: params.get("benchmarkPlaying") !== "paused",
      progress: Number.isFinite(rawProgress) ? Math.min(1, Math.max(0, rawProgress)) : 0,
    };
  } catch {
    return { playing: true, progress: 0 };
  }
}

function transform(position: [number, number, number]): DirectorTransform {
  return {
    position,
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  };
}

function createBenchmarkCharacter(index: number, count: number): DirectorObject {
  const columns = Math.min(5, count);
  const rowCount = Math.ceil(count / columns);
  const row = Math.floor(index / columns);
  const column = index % columns;
  const start: [number, number, number] = [
    (column - (columns - 1) / 2) * 1.65,
    0,
    (row - (rowCount - 1) / 2) * 1.7,
  ];
  const end: [number, number, number] = [start[0] + (row % 2 === 0 ? 1.1 : -1.1), 0, start[2] + 2.4];
  const baseTransform = transform(start);

  return {
    id: `benchmark_character_${index + 1}`,
    name: `基准角色 ${String(index + 1).padStart(2, "0")}`,
    kind: "character",
    visible: true,
    locked: false,
    bodyType: index % 3 === 0 ? "female" : index % 3 === 1 ? "mannequin" : "slim",
    color: index % 2 === 0 ? "#4F8EF7" : "#E0524D",
    transform: baseTransform,
    characterRig: {
      rigType: "ue4-mannequin",
      posePresetId: "stand",
      actionPresetId: index % 4 === 0 ? "run-cycle" : "walk-cycle",
      controls: {},
    },
    motionPath: {
      interpolation: "smooth",
      speedMode: "uniform",
      keyframes: [
        {
          id: `benchmark_character_${index + 1}_start`,
          time: 0,
          transform: baseTransform,
          actionPresetId: index % 4 === 0 ? "run-cycle" : "walk-cycle",
          facingMode: "path",
          pointBehavior: "pass",
          holdSeconds: 0,
        },
        {
          id: `benchmark_character_${index + 1}_end`,
          time: 1,
          transform: transform(end),
          actionPresetId: index % 4 === 0 ? "run-cycle" : "walk-cycle",
          facingMode: "path",
          pointBehavior: "pass",
          holdSeconds: 0,
        },
      ],
    },
  };
}

function createBenchmarkProp(index: number, count: number): DirectorObject {
  const columns = Math.min(10, count);
  const rows = Math.ceil(count / columns);
  const row = Math.floor(index / columns);
  const column = index % columns;
  return {
    id: `benchmark_prop_${index + 1}`,
    name: `基准道具 ${index + 1}`,
    kind: "prop",
    visible: true,
    locked: false,
    geometryType: index % 2 === 0 ? "box" : "cylinder",
    color: "#d7e7ff",
    transform: {
      position: [
        (column - (columns - 1) / 2) * 1.75,
        0,
        (row - (rows - 1) / 2) * 2.1 + (row % 2 === 0 ? -4.8 : 4.8),
      ],
      rotation: [0, index * 0.2, 0],
      scale: [0.65, 1 + (index % 3) * 0.25, 0.65],
    },
  };
}

export function getPerformanceBenchmarkSceneConfig(mode: PerformanceBenchmarkMode) {
  return PERFORMANCE_BENCHMARK_SCENES[mode];
}

export function createPerformanceBenchmarkProject(mode: PerformanceBenchmarkMode): DirectorProject {
  const config = getPerformanceBenchmarkSceneConfig(mode);
  const project = createDefaultDirectorProject();
  const camera = project.cameras[0];
  const targetCharacterId = `benchmark_character_${Math.ceil(config.characterCount / 2)}`;
  const panoramaAsset = config.panoramaEnabled ? {
    id: "benchmark_panorama",
    kind: "panorama" as const,
    sourceType: "image" as const,
    fileName: "benchmark-panorama.jpg",
    name: "固定基准全景",
    url: `${import.meta.env.BASE_URL}benchmark-panorama.jpg`,
    assetSource: "library" as const,
    projectionMode: "equirectangular" as const,
  } : null;

  return {
    ...project,
    scene: {
      ...project.scene,
      showLabels: false,
      showGrid: true,
      showGround: true,
      groundMaterialPreset: "studio",
      groundTextureScale: 1,
    },
    assets: panoramaAsset ? [panoramaAsset] : [],
    panoramaAssetId: panoramaAsset?.id ?? null,
    objects: [
      ...Array.from({ length: config.characterCount }, (_, index) => createBenchmarkCharacter(index, config.characterCount)),
      ...Array.from({ length: config.propCount }, (_, index) => createBenchmarkProp(index, config.propCount)),
      ...project.objects.filter((object) => object.kind === "camera"),
    ],
    cameras: [{
      ...camera,
      targetMode: "object",
      targetObjectId: targetCharacterId,
      motionPath: {
        duration: 8,
        loop: true,
        interpolation: "smooth",
        easing: "ease-in-out",
        speedMode: "uniform",
        keyframes: [
          { id: "benchmark_camera_1", time: 0, position: [-8, 4.6, 11], target: [0, 1, 0], fov: 52, targetMode: "object", targetObjectId: targetCharacterId, targetBodyPart: "chest", targetFollowMode: "smooth", pointBehavior: "pass", holdSeconds: 0 },
          { id: "benchmark_camera_2", time: 0.5, position: [0, 3.2, 8.5], target: [0, 1, 0], fov: 45, targetMode: "object", targetObjectId: targetCharacterId, targetBodyPart: "chest", targetFollowMode: "smooth", pointBehavior: "pass", holdSeconds: 0 },
          { id: "benchmark_camera_3", time: 1, position: [8, 5.2, 10], target: [0, 1, 0], fov: 50, targetMode: "object", targetObjectId: targetCharacterId, targetBodyPart: "chest", targetFollowMode: "smooth", pointBehavior: "pass", holdSeconds: 0 },
        ],
      },
    }],
  };
}

export function createStandardBenchmarkProject(): DirectorProject {
  return createPerformanceBenchmarkProject("standard");
}
