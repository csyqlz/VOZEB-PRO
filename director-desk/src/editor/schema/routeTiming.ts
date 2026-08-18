import type {
  CameraMotionInterpolation,
  DirectorRouteCubicBezier,
  DirectorRoutePointBehavior,
  DirectorRouteSpeedMode,
} from "./directorProject";

export interface RouteTimingPoint {
  time: number;
  position: [number, number, number];
  pointBehavior?: DirectorRoutePointBehavior;
  holdSeconds?: number;
}

export interface RouteTimingOptions {
  points: RouteTimingPoint[];
  duration: number;
  interpolation: CameraMotionInterpolation;
  speedMode: DirectorRouteSpeedMode;
  customEasing?: DirectorRouteCubicBezier;
}

export interface RouteTimingPlan {
  arrivals: number[];
  cumulativeDistances: number[];
  departures: number[];
  duration: number;
  effectiveHoldSeconds: number[];
  interpolation: CameraMotionInterpolation;
  movingSeconds: number;
  points: RouteTimingPoint[];
  segmentLengths: number[];
  segmentSamples: number[][];
  speedMode: DirectorRouteSpeedMode;
  totalDistance: number;
  customEasing: DirectorRouteCubicBezier;
}

export interface RouteTimingSample {
  segment: number;
  local: number;
  holdingPointIndex: number | null;
}

const DEFAULT_CUSTOM_EASING: DirectorRouteCubicBezier = [0, 0, 1, 1];
const CURVE_SAMPLES_PER_SEGMENT = 32;

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function finite(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function distance(a: [number, number, number], b: [number, number, number]) {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

function linear(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function catmullRom(a: number, b: number, c: number, d: number, t: number) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    2 * b
    + (-a + c) * t
    + (2 * a - 5 * b + 4 * c - d) * t2
    + (-a + 3 * b - 3 * c + d) * t3
  );
}

export function interpolateRoutePosition(
  points: RouteTimingPoint[],
  segment: number,
  local: number,
  interpolation: CameraMotionInterpolation,
): [number, number, number] {
  if (points.length === 0) return [0, 0, 0];
  if (points.length === 1) return [...points[0].position];
  const safeSegment = Math.min(points.length - 2, Math.max(0, segment));
  const t = clamp(local);
  const from = points[safeSegment].position;
  const to = points[safeSegment + 1].position;
  if (interpolation === "linear" || points.length < 3) {
    return [0, 1, 2].map((axis) => linear(from[axis], to[axis], t)) as [number, number, number];
  }
  const before = points[Math.max(0, safeSegment - 1)].position;
  const after = points[Math.min(points.length - 1, safeSegment + 2)].position;
  return [0, 1, 2].map((axis) => catmullRom(
    before[axis],
    from[axis],
    to[axis],
    after[axis],
    t,
  )) as [number, number, number];
}

function cubicCoordinate(t: number, first: number, second: number) {
  const inverse = 1 - t;
  return 3 * inverse * inverse * t * first + 3 * inverse * t * t * second + t * t * t;
}

export function evaluateCubicBezier(progress: number, curve: DirectorRouteCubicBezier) {
  const x = clamp(progress);
  const [x1, y1, x2, y2] = curve;
  let low = 0;
  let high = 1;
  for (let index = 0; index < 18; index += 1) {
    const midpoint = (low + high) / 2;
    if (cubicCoordinate(midpoint, x1, x2) < x) low = midpoint;
    else high = midpoint;
  }
  return clamp(cubicCoordinate((low + high) / 2, y1, y2));
}

function inverseEasing(value: number, easing: (progress: number) => number) {
  const target = clamp(value);
  let low = 0;
  let high = 1;
  for (let index = 0; index < 20; index += 1) {
    const midpoint = (low + high) / 2;
    if (easing(midpoint) < target) low = midpoint;
    else high = midpoint;
  }
  return (low + high) / 2;
}

function smoothstep(value: number) {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
}

function normalizeBezier(value: DirectorRouteCubicBezier | undefined): DirectorRouteCubicBezier {
  if (!Array.isArray(value) || value.length !== 4) return DEFAULT_CUSTOM_EASING;
  return [
    clamp(finite(value[0], 0)),
    clamp(finite(value[1], 0)),
    clamp(finite(value[2], 1)),
    clamp(finite(value[3], 1)),
  ];
}

function getHoldSeconds(point: RouteTimingPoint, duration: number) {
  if (point.pointBehavior !== "hold") return 0;
  return clamp(finite(point.holdSeconds, 0), 0, duration);
}

function buildSegmentSamples(
  points: RouteTimingPoint[],
  interpolation: CameraMotionInterpolation,
) {
  const segmentSamples: number[][] = [];
  const segmentLengths: number[] = [];
  for (let segment = 0; segment < points.length - 1; segment += 1) {
    const cumulative = [0];
    let previous = interpolateRoutePosition(points, segment, 0, interpolation);
    for (let index = 1; index <= CURVE_SAMPLES_PER_SEGMENT; index += 1) {
      const current = interpolateRoutePosition(
        points,
        segment,
        index / CURVE_SAMPLES_PER_SEGMENT,
        interpolation,
      );
      cumulative.push(cumulative[cumulative.length - 1] + distance(previous, current));
      previous = current;
    }
    segmentSamples.push(cumulative);
    segmentLengths.push(cumulative[cumulative.length - 1]);
  }
  return { segmentLengths, segmentSamples };
}

export function createRouteTimingPlan(options: RouteTimingOptions): RouteTimingPlan {
  const duration = Math.max(0.001, finite(options.duration, 1));
  const points = options.points.map((point, index) => ({
    ...point,
    time: clamp(finite(point.time, index / Math.max(1, options.points.length - 1))),
    position: [...point.position] as [number, number, number],
    holdSeconds: getHoldSeconds(point, duration),
  }));
  const { segmentLengths, segmentSamples } = buildSegmentSamples(points, options.interpolation);
  const cumulativeDistances = [0];
  segmentLengths.forEach((length) => cumulativeDistances.push(cumulativeDistances[cumulativeDistances.length - 1] + length));
  const totalDistance = cumulativeDistances[cumulativeDistances.length - 1] ?? 0;
  const arrivals = points.map((point) => point.time);
  const departures = points.map((point) => Math.min(1, point.time + getHoldSeconds(point, duration) / duration));
  const customEasing = normalizeBezier(options.customEasing);
  const effectiveHoldSeconds = points.map((point, index) =>
    index < points.length - 1 ? getHoldSeconds(point, duration) : 0
  );
  let movingSeconds = duration;

  if (points.length > 1 && options.speedMode !== "custom") {
    const requestedHoldSeconds = effectiveHoldSeconds.reduce((sum, seconds) => sum + seconds, 0);
    const holdScale = requestedHoldSeconds > duration ? duration / requestedHoldSeconds : 1;
    effectiveHoldSeconds.forEach((seconds, index) => {
      effectiveHoldSeconds[index] = seconds * holdScale;
    });
    movingSeconds = Math.max(0, duration - requestedHoldSeconds * holdScale);
    const easing = options.speedMode === "soft" ? smoothstep : (value: number) => value;
    let elapsedHoldSeconds = 0;

    for (let index = 0; index < points.length; index += 1) {
      const distanceProgress = totalDistance > 0
        ? cumulativeDistances[index] / totalDistance
        : index / (points.length - 1);
      const movingProgress = inverseEasing(distanceProgress, easing);
      arrivals[index] = clamp((elapsedHoldSeconds + movingProgress * movingSeconds) / duration);
      const holdSeconds = effectiveHoldSeconds[index];
      departures[index] = clamp(arrivals[index] + holdSeconds / duration);
      elapsedHoldSeconds += holdSeconds;
    }
    arrivals[0] = 0;
    arrivals[arrivals.length - 1] = 1;
    departures[departures.length - 1] = 1;
  }

  return {
    arrivals,
    cumulativeDistances,
    departures,
    duration,
    effectiveHoldSeconds,
    interpolation: options.interpolation,
    movingSeconds,
    points,
    segmentLengths,
    segmentSamples,
    speedMode: options.speedMode,
    totalDistance,
    customEasing,
  };
}

function localFromDistance(plan: RouteTimingPlan, segment: number, distanceProgress: number) {
  const samples = plan.segmentSamples[segment];
  const segmentLength = plan.segmentLengths[segment] ?? 0;
  if (!samples || segmentLength <= 0.000001) return clamp(distanceProgress);
  const target = clamp(distanceProgress) * segmentLength;
  let index = 0;
  while (index < samples.length - 2 && samples[index + 1] < target) index += 1;
  const from = samples[index];
  const to = samples[index + 1];
  const local = (target - from) / Math.max(0.000001, to - from);
  return (index + local) / CURVE_SAMPLES_PER_SEGMENT;
}

export function sampleRouteTiming(plan: RouteTimingPlan, progress: number): RouteTimingSample {
  const pointCount = plan.points.length;
  if (pointCount < 2) return { segment: 0, local: 0, holdingPointIndex: pointCount === 1 ? 0 : null };
  const p = clamp(progress);

  for (let index = 0; index < pointCount - 1; index += 1) {
    if (p >= plan.arrivals[index] && p < plan.departures[index]) {
      return {
        segment: Math.min(index, pointCount - 2),
        local: index === pointCount - 1 ? 1 : 0,
        holdingPointIndex: index,
      };
    }
    if (p < plan.arrivals[index + 1]) {
      if (plan.speedMode !== "custom") {
        const elapsedHoldSeconds = plan.effectiveHoldSeconds
          .slice(0, index + 1)
          .reduce((sum, seconds) => sum + seconds, 0);
        const movingProgress = clamp(
          (p * plan.duration - elapsedHoldSeconds) / Math.max(0.000001, plan.movingSeconds),
        );
        const distanceProgress = plan.speedMode === "soft" ? smoothstep(movingProgress) : movingProgress;
        const routeDistance = distanceProgress * plan.totalDistance;
        const segmentDistance = routeDistance - plan.cumulativeDistances[index];
        return {
          segment: index,
          local: localFromDistance(
            plan,
            index,
            segmentDistance / Math.max(0.000001, plan.segmentLengths[index]),
          ),
          holdingPointIndex: null,
        };
      }
      const raw = clamp(
        (p - plan.departures[index])
        / Math.max(0.000001, plan.arrivals[index + 1] - plan.departures[index]),
      );
      const distanceProgress = evaluateCubicBezier(raw, plan.customEasing);
      return {
        segment: index,
        local: localFromDistance(plan, index, distanceProgress),
        holdingPointIndex: null,
      };
    }
  }

  return { segment: pointCount - 2, local: 1, holdingPointIndex: null };
}

export function getRouteTimingPosition(plan: RouteTimingPlan, progress: number) {
  const sample = sampleRouteTiming(plan, progress);
  if (sample.holdingPointIndex != null) {
    return [...plan.points[sample.holdingPointIndex].position] as [number, number, number];
  }
  return interpolateRoutePosition(plan.points, sample.segment, sample.local, plan.interpolation);
}
