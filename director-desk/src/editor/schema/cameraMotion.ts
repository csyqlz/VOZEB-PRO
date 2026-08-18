import type {
  CameraMotionEasing,
  CameraMotionInterpolation,
  DirectorCameraMotionKeyframe,
  DirectorCameraMotionPath,
  DirectorCameraShot,
  DirectorRouteCubicBezier,
} from "./directorProject";
import {
  createRouteTimingPlan,
  getRouteTimingPosition,
  sampleRouteTiming,
} from "./routeTiming";
import type { RouteTimingSample } from "./routeTiming";
import {
  normalizeDirectorCameraTargetBodyPart,
  normalizeDirectorCameraTargetFollowMode,
} from "./semanticBody";

export interface CameraMotionSnapshot {
  fov: number;
  position: [number, number, number];
  target: [number, number, number];
}

export const DEFAULT_CAMERA_MOTION_PATH: DirectorCameraMotionPath = {
  duration: 6,
  loop: false,
  interpolation: "smooth",
  easing: "ease-in-out",
  speedMode: "soft",
  customEasing: [0, 0, 1, 1],
  keyframes: [],
};

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function finite(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function tuple(value: unknown, fallback: [number, number, number]): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) return fallback;
  return [finite(value[0], fallback[0]), finite(value[1], fallback[1]), finite(value[2], fallback[2])];
}

function cubicBezier(value: unknown): DirectorRouteCubicBezier | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  return value.map((item, index) => clamp(finite(item, index < 2 ? 0 : 1))) as DirectorRouteCubicBezier;
}

export function normalizeCameraMotionPath(
  value: unknown,
  fallbackTarget: [number, number, number] = [0, 1, 0],
  fallbackTracking: Pick<DirectorCameraShot, "targetMode" | "targetObjectId"> = {
    targetMode: "manual",
    targetObjectId: null,
  }
): DirectorCameraMotionPath {
  if (!value || typeof value !== "object") return { ...DEFAULT_CAMERA_MOTION_PATH, keyframes: [] };
  const path = value as Partial<DirectorCameraMotionPath>;
  const keyframes = Array.isArray(path.keyframes)
    ? path.keyframes
        .map((item, index): DirectorCameraMotionKeyframe | null => {
          if (!item || typeof item !== "object") return null;
          const keyframe = item as Partial<DirectorCameraMotionKeyframe>;
          return {
            id: typeof keyframe.id === "string" && keyframe.id ? keyframe.id : `motion_key_${index + 1}`,
            time: clamp(finite(keyframe.time, index)),
            position: tuple(keyframe.position, [0, 2, 8]),
            target: tuple(keyframe.target, fallbackTarget),
            fov: Math.min(120, Math.max(10, finite(keyframe.fov, 50))),
            targetMode:
              keyframe.targetMode === "object" || keyframe.targetMode === "manual"
                ? keyframe.targetMode
                : fallbackTracking.targetMode,
            targetObjectId:
              keyframe.targetMode === "object"
                ? typeof keyframe.targetObjectId === "string" && keyframe.targetObjectId
                  ? keyframe.targetObjectId
                  : null
                : keyframe.targetMode === "manual"
                  ? null
                  : fallbackTracking.targetMode === "object"
                    ? fallbackTracking.targetObjectId ?? null
                    : null,
            targetBodyPart: normalizeDirectorCameraTargetBodyPart(keyframe.targetBodyPart),
            targetFollowMode: normalizeDirectorCameraTargetFollowMode(keyframe.targetFollowMode),
            targetStabilizationEnabled: Boolean(keyframe.targetStabilizationEnabled),
            pointBehavior: keyframe.pointBehavior === "hold" ? "hold" : "pass",
            holdSeconds: Math.max(0, finite(keyframe.holdSeconds, 0)),
          };
        })
        .filter((item): item is DirectorCameraMotionKeyframe => Boolean(item))
        .sort((a, b) => a.time - b.time)
    : [];

  const speedMode =
    path.speedMode === "uniform" || path.speedMode === "soft" || path.speedMode === "custom"
      ? path.speedMode
      : undefined;
  const customEasing = cubicBezier(path.customEasing);
  return {
    duration: Math.min(30, Math.max(0.5, finite(path.duration, DEFAULT_CAMERA_MOTION_PATH.duration))),
    loop: Boolean(path.loop),
    interpolation: path.interpolation === "linear" ? "linear" : "smooth",
    easing: path.easing === "linear" ? "linear" : "ease-in-out",
    ...(speedMode ? { speedMode } : {}),
    ...(customEasing ? { customEasing } : {}),
    keyframes,
  };
}

export function getCameraMotionPath(camera: DirectorCameraShot) {
  return normalizeCameraMotionPath(camera.motionPath, camera.target, camera);
}

export function retimeCameraMotionKeyframes(keyframes: DirectorCameraMotionKeyframe[]) {
  if (keyframes.length <= 1) {
    return keyframes.map((item) => ({ ...item, time: 0 }));
  }
  return keyframes.map((item, index) => ({ ...item, time: index / (keyframes.length - 1) }));
}

export function createCameraMotionKeyframe(
  camera: DirectorCameraShot,
  id: string,
  snapshot: CameraMotionSnapshot = {
    position: camera.transform.position,
    target: camera.target,
    fov: camera.fov,
  },
): DirectorCameraMotionKeyframe {
  return {
    id,
    time: 0,
    position: [...snapshot.position],
    target: [...snapshot.target],
    fov: snapshot.fov,
    targetMode: camera.targetMode,
    targetObjectId: camera.targetMode === "object" ? camera.targetObjectId ?? null : null,
    targetBodyPart: "center",
    targetFollowMode: "immediate",
    targetStabilizationEnabled: false,
    pointBehavior: "pass",
    holdSeconds: 0,
  };
}

function linear(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function catmullRom(a: number, b: number, c: number, d: number, t: number) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    2 * b +
    (-a + c) * t +
    (2 * a - 5 * b + 4 * c - d) * t2 +
    (-a + 3 * b - 3 * c + d) * t3
  );
}

function interpolateValue(
  values: number[],
  segment: number,
  t: number,
  interpolation: CameraMotionInterpolation
) {
  if (interpolation === "linear") return linear(values[segment], values[segment + 1], t);
  const a = values[Math.max(0, segment - 1)];
  const b = values[segment];
  const c = values[Math.min(values.length - 1, segment + 1)];
  const d = values[Math.min(values.length - 1, segment + 2)];
  return catmullRom(a, b, c, d, t);
}

function createCameraTimingPlan(path: DirectorCameraMotionPath) {
  return createRouteTimingPlan({
    points: path.keyframes.map((keyframe) => ({
      time: keyframe.time,
      position: keyframe.position,
      pointBehavior: keyframe.pointBehavior,
      holdSeconds: keyframe.holdSeconds,
    })),
    duration: path.duration,
    interpolation: path.interpolation,
    speedMode: path.speedMode ?? "custom",
    customEasing: path.customEasing,
  });
}

export function getCameraMotionTimingPlan(camera: DirectorCameraShot) {
  const path = getCameraMotionPath(camera);
  if (!path.speedMode || path.keyframes.length < 2) return null;
  return createCameraTimingPlan(path);
}

export function getCameraMotionTimingSample(
  camera: DirectorCameraShot,
  progress: number,
): RouteTimingSample | null {
  const plan = getCameraMotionTimingPlan(camera);
  return plan ? sampleRouteTiming(plan, progress) : null;
}

export function getCameraMotionKeyframeArrivalProgress(
  camera: DirectorCameraShot,
  keyframeIndex: number,
) {
  const path = getCameraMotionPath(camera);
  const keyframe = path.keyframes[keyframeIndex];
  if (!keyframe) return 0;
  return getCameraMotionTimingPlan(camera)?.arrivals[keyframeIndex] ?? keyframe.time;
}

export function getCameraMotionActiveKeyframeIndex(
  camera: DirectorCameraShot,
  progress: number,
) {
  const path = getCameraMotionPath(camera);
  if (path.keyframes.length === 0) return -1;
  const timingPlan = getCameraMotionTimingPlan(camera);
  const arrivals = timingPlan?.arrivals ?? path.keyframes.map((keyframe) => keyframe.time);
  const currentProgress = clamp(progress);
  let activeIndex = 0;
  for (let index = 1; index < arrivals.length; index += 1) {
    if (currentProgress + 0.0001 < arrivals[index]) break;
    activeIndex = index;
  }
  return activeIndex;
}

function applyLegacyEasing(value: number, easing: CameraMotionEasing) {
  if (easing === "linear") return value;
  return value * value * (3 - 2 * value);
}

export function getCameraMotionSnapshot(camera: DirectorCameraShot, progress: number): CameraMotionSnapshot {
  const path = getCameraMotionPath(camera);
  const keyframes = path.keyframes;
  const fallback = {
    fov: camera.fov,
    position: [...camera.transform.position] as [number, number, number],
    target: [...camera.target] as [number, number, number],
  };
  if (keyframes.length < 2) return fallback;

  const p = clamp(progress);
  if (p <= keyframes[0].time) {
    return {
      ...fallback,
      fov: keyframes[0].fov,
      position: [...keyframes[0].position],
      target: [...keyframes[0].target],
    };
  }
  const last = keyframes[keyframes.length - 1];
  if (p >= last.time) {
    return { ...fallback, fov: last.fov, position: [...last.position], target: [...last.target] };
  }

  if (!path.speedMode) {
    let segment = 0;
    while (segment < keyframes.length - 2 && p > keyframes[segment + 1].time) segment += 1;
    const from = keyframes[segment];
    const to = keyframes[segment + 1];
    const rawLocal = (p - from.time) / Math.max(0.000001, to.time - from.time);
    const local = applyLegacyEasing(rawLocal, path.easing);
    const values = (axis: 0 | 1 | 2) => keyframes.map((item) => item.position[axis]);
    const targetValues = (axis: 0 | 1 | 2) => keyframes.map((item) => item.target[axis]);
    const position = [0, 1, 2].map((axis) =>
      interpolateValue(values(axis as 0 | 1 | 2), segment, local, path.interpolation)
    ) as [number, number, number];
    const target = [0, 1, 2].map((axis) =>
      interpolateValue(targetValues(axis as 0 | 1 | 2), segment, local, path.interpolation)
    ) as [number, number, number];
    return { fov: linear(from.fov, to.fov, local), position, target };
  }

  const timingPlan = createCameraTimingPlan(path);
  const timing = sampleRouteTiming(timingPlan, p);
  const segment = timing.segment;
  const from = keyframes[segment];
  const to = keyframes[segment + 1];
  const local = timing.local;
  const targetValues = (axis: 0 | 1 | 2) => keyframes.map((item) => item.target[axis]);
  const position = getRouteTimingPosition(timingPlan, p);
  const target: [number, number, number] = [0, 1, 2].map((axis) =>
    interpolateValue(targetValues(axis as 0 | 1 | 2), segment, local, path.interpolation)
  ) as [number, number, number];
  const fov = linear(from.fov, to.fov, local);

  return { fov, position, target };
}

export function sampleCameraMotionPath(camera: DirectorCameraShot, count = 64) {
  if (count < 2) return [getCameraMotionSnapshot(camera, 0).position];
  return Array.from({ length: count }, (_, index) =>
    getCameraMotionSnapshot(camera, index / (count - 1)).position
  );
}
