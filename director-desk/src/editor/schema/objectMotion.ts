import type {
  DirectorObject,
  DirectorObjectMotionKeyframe,
  DirectorObjectMotionPath,
  DirectorRouteCubicBezier,
  DirectorTransform,
} from "./directorProject";
import {
  createRouteTimingPlan,
  getRouteTimingPosition,
  interpolateRoutePosition,
  sampleRouteTiming,
} from "./routeTiming";
import type { RouteTimingSample } from "./routeTiming";

export const DEFAULT_OBJECT_MOTION_PATH: DirectorObjectMotionPath = {
  interpolation: "smooth",
  speedMode: "uniform",
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
  if (!Array.isArray(value) || value.length !== 3) return [...fallback];
  return [finite(value[0], fallback[0]), finite(value[1], fallback[1]), finite(value[2], fallback[2])];
}

function cubicBezier(value: unknown): DirectorRouteCubicBezier | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  return value.map((item, index) => clamp(finite(item, index < 2 ? 0 : 1))) as DirectorRouteCubicBezier;
}

function normalizeTransform(value: unknown, fallback: DirectorTransform): DirectorTransform {
  if (!value || typeof value !== "object") {
    return {
      position: [...fallback.position],
      rotation: [...fallback.rotation],
      scale: [...fallback.scale],
    };
  }
  const transform = value as Partial<DirectorTransform>;
  return {
    position: tuple(transform.position, fallback.position),
    rotation: tuple(transform.rotation, fallback.rotation),
    scale: tuple(transform.scale, fallback.scale),
  };
}

const FALLBACK_TRANSFORM: DirectorTransform = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
};

export function normalizeObjectMotionPath(
  value: unknown,
  fallbackTransform: DirectorTransform = FALLBACK_TRANSFORM
): DirectorObjectMotionPath {
  if (!value || typeof value !== "object") return { ...DEFAULT_OBJECT_MOTION_PATH, keyframes: [] };
  const path = value as Partial<DirectorObjectMotionPath>;
  const keyframes = Array.isArray(path.keyframes)
    ? path.keyframes
        .map((entry, index): DirectorObjectMotionKeyframe | null => {
          if (!entry || typeof entry !== "object") return null;
          const keyframe = entry as Partial<DirectorObjectMotionKeyframe>;
          return {
            id: typeof keyframe.id === "string" && keyframe.id ? keyframe.id : `object_motion_${index + 1}`,
            time: clamp(finite(keyframe.time, index)),
            transform: normalizeTransform(keyframe.transform, fallbackTransform),
            actionPresetId: typeof keyframe.actionPresetId === "string" ? keyframe.actionPresetId : null,
            facingMode: keyframe.facingMode === "path" ? "path" : "manual",
            pointBehavior: keyframe.pointBehavior === "hold" ? "hold" : "pass",
            holdSeconds: Math.max(0, finite(keyframe.holdSeconds, 0)),
            holdAction:
              keyframe.holdAction === "stand" || keyframe.holdAction === "custom"
                ? keyframe.holdAction
                : "current",
            holdActionPresetId:
              typeof keyframe.holdActionPresetId === "string" ? keyframe.holdActionPresetId : null,
          };
        })
        .filter((entry): entry is DirectorObjectMotionKeyframe => Boolean(entry))
        .sort((a, b) => a.time - b.time)
    : [];

  const speedMode =
    path.speedMode === "uniform" || path.speedMode === "soft" || path.speedMode === "custom"
      ? path.speedMode
      : undefined;
  const customEasing = cubicBezier(path.customEasing);
  return {
    interpolation: path.interpolation === "linear" ? "linear" : "smooth",
    ...(speedMode ? { speedMode } : {}),
    ...(customEasing ? { customEasing } : {}),
    keyframes,
  };
}

function interpolate(a: number, b: number, progress: number) {
  return a + (b - a) * progress;
}

function interpolateAngle(a: number, b: number, progress: number) {
  let delta = (b - a) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return a + delta * progress;
}

function cloneTransform(transform: DirectorTransform): DirectorTransform {
  return {
    position: [...transform.position],
    rotation: [...transform.rotation],
    scale: [...transform.scale],
  };
}

function createObjectTimingPlan(path: DirectorObjectMotionPath, duration: number) {
  return createRouteTimingPlan({
    points: path.keyframes.map((keyframe) => ({
      time: keyframe.time,
      position: keyframe.transform.position,
      pointBehavior: keyframe.pointBehavior,
      holdSeconds: keyframe.holdSeconds,
    })),
    duration,
    interpolation: path.interpolation,
    speedMode: path.speedMode ?? "custom",
    customEasing: path.customEasing,
  });
}

export function getObjectMotionTimingPlan(object: DirectorObject, duration = 6) {
  const path = normalizeObjectMotionPath(object.motionPath, object.transform);
  if (!path.speedMode || path.keyframes.length < 2) return null;
  return createObjectTimingPlan(path, duration);
}

function findLegacyMotionSegment(path: DirectorObjectMotionPath, progress: number) {
  const p = clamp(progress);
  let segment = 0;
  while (segment < path.keyframes.length - 2 && p > path.keyframes[segment + 1].time) segment += 1;
  const from = path.keyframes[segment];
  const to = path.keyframes[Math.min(path.keyframes.length - 1, segment + 1)];
  const local = clamp((p - from.time) / Math.max(0.000001, to.time - from.time));
  return { from, local, segment, to };
}

export function getObjectMotionTimingSample(
  object: DirectorObject,
  progress: number,
  duration = 6,
): RouteTimingSample | null {
  const path = normalizeObjectMotionPath(object.motionPath, object.transform);
  if (path.keyframes.length < 2) return null;
  if (!path.speedMode) {
    const legacy = findLegacyMotionSegment(path, progress);
    return { segment: legacy.segment, local: legacy.local, holdingPointIndex: null };
  }
  return sampleRouteTiming(createObjectTimingPlan(path, duration), progress);
}

function findMotionSegment(path: DirectorObjectMotionPath, progress: number, duration: number) {
  if (!path.speedMode) return findLegacyMotionSegment(path, progress);
  const timing = sampleRouteTiming(createObjectTimingPlan(path, duration), progress);
  const segment = timing.segment;
  const from = path.keyframes[segment];
  const to = path.keyframes[Math.min(path.keyframes.length - 1, segment + 1)];
  return { from, local: timing.local, segment, timing, to };
}

function samplePosition(path: DirectorObjectMotionPath, progress: number, duration: number): [number, number, number] {
  const first = path.keyframes[0];
  const last = path.keyframes[path.keyframes.length - 1];
  if (progress <= first.time) return [...first.transform.position];
  if (progress >= last.time) return [...last.transform.position];
  if (!path.speedMode) {
    const legacy = findLegacyMotionSegment(path, progress);
    return interpolateRoutePosition(
      path.keyframes.map((keyframe) => ({ time: keyframe.time, position: keyframe.transform.position })),
      legacy.segment,
      legacy.local,
      path.interpolation,
    );
  }
  return getRouteTimingPosition(createObjectTimingPlan(path, duration), progress);
}

function getPathFacingYaw(path: DirectorObjectMotionPath, progress: number, duration: number) {
  const epsilon = 0.001;
  const before = samplePosition(path, Math.max(path.keyframes[0].time, progress - epsilon), duration);
  const after = samplePosition(path, Math.min(path.keyframes[path.keyframes.length - 1].time, progress + epsilon), duration);
  const dx = after[0] - before[0];
  const dz = after[2] - before[2];
  return Math.hypot(dx, dz) > 0.000001 ? Math.atan2(dx, dz) : null;
}

export function getObjectMotionSnapshot(object: DirectorObject, progress: number, duration = 6): DirectorTransform {
  const path = normalizeObjectMotionPath(object.motionPath, object.transform);
  if (path.keyframes.length === 0) return cloneTransform(object.transform);
  const p = clamp(progress);
  const first = path.keyframes[0];
  const last = path.keyframes[path.keyframes.length - 1];
  if (p <= first.time) {
    const transform = cloneTransform(first.transform);
    const yaw = object.kind === "character" && first.facingMode === "path" ? getPathFacingYaw(path, first.time, duration) : null;
    if (yaw != null) transform.rotation[1] = yaw;
    return transform;
  }
  if (p >= last.time) {
    const transform = cloneTransform(last.transform);
    const previous = path.keyframes[path.keyframes.length - 2];
    const yaw = object.kind === "character" && previous?.facingMode === "path" ? getPathFacingYaw(path, last.time, duration) : null;
    if (yaw != null) transform.rotation[1] = yaw;
    return transform;
  }

  const { from, local, to } = findMotionSegment(path, p, duration);
  const mapTuple = (
    left: [number, number, number],
    right: [number, number, number],
    angle = false
  ) => left.map((value, axis) =>
    angle ? interpolateAngle(value, right[axis], local) : interpolate(value, right[axis], local)
  ) as [number, number, number];

  const rotation = mapTuple(from.transform.rotation, to.transform.rotation, true);
  if (object.kind === "character" && from.facingMode === "path") {
    const yaw = getPathFacingYaw(path, p, duration);
    if (yaw != null) rotation[1] = yaw;
  }

  return {
    position: samplePosition(path, p, duration),
    rotation,
    scale: mapTuple(from.transform.scale, to.transform.scale),
  };
}

export function sampleObjectMotionPath(object: DirectorObject, count = 80, duration = 6) {
  const path = normalizeObjectMotionPath(object.motionPath, object.transform);
  if (path.keyframes.length === 0) return [object.transform.position];
  if (path.keyframes.length === 1 || count < 2) return [path.keyframes[0].transform.position];
  const start = path.keyframes[0].time;
  const end = path.keyframes[path.keyframes.length - 1].time;
  return Array.from({ length: count }, (_, index) =>
    samplePosition(path, start + (end - start) * (index / (count - 1)), duration)
  );
}

export function getObjectMotionActionPresetId(object: DirectorObject, progress: number, duration = 6) {
  return getObjectMotionActionSample(object, progress, duration).actionPresetId;
}

export interface ObjectMotionActionSample {
  actionPresetId: string | null;
  animationTimeSeconds: number;
  holdingPointIndex: number | null;
}

export function getObjectMotionActionSample(
  object: DirectorObject,
  progress: number,
  duration = 6,
): ObjectMotionActionSample {
  const path = normalizeObjectMotionPath(object.motionPath, object.transform);
  const timelineTimeSeconds = clamp(progress) * duration;
  if (path.keyframes.length === 0) {
    return {
      actionPresetId: object.characterRig?.actionPresetId ?? null,
      animationTimeSeconds: timelineTimeSeconds,
      holdingPointIndex: null,
    };
  }
  if (path.keyframes.length === 1) {
    return {
      actionPresetId: path.keyframes[0].actionPresetId ?? null,
      animationTimeSeconds: timelineTimeSeconds,
      holdingPointIndex: null,
    };
  }
  if (!path.speedMode) {
    const { segment } = findLegacyMotionSegment(path, progress);
    return {
      actionPresetId: path.keyframes[segment]?.actionPresetId ?? null,
      animationTimeSeconds: timelineTimeSeconds,
      holdingPointIndex: null,
    };
  }
  const plan = createObjectTimingPlan(path, duration);
  const timing = sampleRouteTiming(plan, progress);
  if (timing.holdingPointIndex != null) {
    const point = path.keyframes[timing.holdingPointIndex];
    if (point.holdAction === "stand") {
      return { actionPresetId: null, animationTimeSeconds: 0, holdingPointIndex: timing.holdingPointIndex };
    }
    if (point.holdAction === "custom") {
      return {
        actionPresetId: point.holdActionPresetId ?? null,
        animationTimeSeconds: Math.max(0, timelineTimeSeconds - plan.arrivals[timing.holdingPointIndex] * duration),
        holdingPointIndex: timing.holdingPointIndex,
      };
    }
    return {
      actionPresetId: path.keyframes[Math.max(0, timing.holdingPointIndex - 1)]?.actionPresetId ?? null,
      animationTimeSeconds: timelineTimeSeconds,
      holdingPointIndex: timing.holdingPointIndex,
    };
  }
  return {
    actionPresetId: path.keyframes[timing.segment]?.actionPresetId ?? null,
    animationTimeSeconds: timelineTimeSeconds,
    holdingPointIndex: null,
  };
}

export function getObjectMotionSpeed(object: DirectorObject, progress: number, duration = 6) {
  const before = getObjectMotionSnapshot(object, Math.max(0, progress - 0.002), duration);
  const after = getObjectMotionSnapshot(object, Math.min(1, progress + 0.002), duration);
  return Math.hypot(
    after.position[0] - before.position[0],
    after.position[1] - before.position[1],
    after.position[2] - before.position[2]
  ) / 0.004;
}
