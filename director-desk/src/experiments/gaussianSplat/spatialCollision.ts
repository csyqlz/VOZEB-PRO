import { Vector3 } from "three";

export interface Vector3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface AABB {
  readonly min: Vector3Like;
  readonly max: Vector3Like;
}

export interface SphereSweepHit {
  readonly collider: AABB;
  readonly colliderIndex: number;
  readonly time: number;
  readonly point: Vector3;
  readonly normal: Vector3;
}

export interface RayIntersectionLike {
  readonly distance: number;
  readonly point: Vector3Like;
}

export interface DownwardHitOptions<T extends RayIntersectionLike> {
  readonly maxDistance?: number;
  readonly epsilon?: number;
  readonly isValid?: (intersection: T) => boolean;
}

type Axis = "x" | "y" | "z";

interface NumericBounds {
  min: Record<Axis, number>;
  max: Record<Axis, number>;
}

const AXES: readonly Axis[] = ["x", "y", "z"];
const SWEEP_EPSILON = 1e-10;

function assertRadius(radius: number) {
  if (!Number.isFinite(radius) || radius < 0) {
    throw new RangeError("Sphere radius must be a finite, non-negative number");
  }
}

function toBounds(aabb: AABB, expansion = 0): NumericBounds {
  return {
    min: {
      x: Math.min(aabb.min.x, aabb.max.x) - expansion,
      y: Math.min(aabb.min.y, aabb.max.y) - expansion,
      z: Math.min(aabb.min.z, aabb.max.z) - expansion,
    },
    max: {
      x: Math.max(aabb.min.x, aabb.max.x) + expansion,
      y: Math.max(aabb.min.y, aabb.max.y) + expansion,
      z: Math.max(aabb.min.z, aabb.max.z) + expansion,
    },
  };
}

function isStrictlyInside(point: Vector3Like, bounds: NumericBounds) {
  return AXES.every((axis) => point[axis] > bounds.min[axis] && point[axis] < bounds.max[axis]);
}

export function isPointInsideAABB(point: Vector3Like, aabb: AABB): boolean {
  const bounds = toBounds(aabb);
  return AXES.every((axis) => point[axis] >= bounds.min[axis] && point[axis] <= bounds.max[axis]);
}

export function sphereIntersectsAABB(center: Vector3Like, radius: number, aabb: AABB): boolean {
  assertRadius(radius);
  const bounds = toBounds(aabb);
  let distanceSquared = 0;

  for (const axis of AXES) {
    const coordinate = center[axis];
    const closest = Math.max(bounds.min[axis], Math.min(coordinate, bounds.max[axis]));
    const difference = coordinate - closest;
    distanceSquared += difference * difference;
  }

  return distanceSquared <= radius * radius;
}

function connectedIntervalAtPoint(
  point: Vector3Like,
  axis: Axis,
  boundsList: readonly NumericBounds[],
): { min: number; max: number } | null {
  const otherAxes = AXES.filter((candidate) => candidate !== axis);
  const intervals = boundsList
    .filter((bounds) => otherAxes.every(
      (otherAxis) => point[otherAxis] > bounds.min[otherAxis]
        && point[otherAxis] < bounds.max[otherAxis],
    ))
    .map((bounds) => ({ min: bounds.min[axis], max: bounds.max[axis] }));

  let componentMin = point[axis];
  let componentMax = point[axis];
  let found = false;
  let changed = true;

  while (changed) {
    changed = false;
    for (const interval of intervals) {
      const containsPoint = interval.min < point[axis] && interval.max > point[axis];
      const overlapsComponent = found
        && interval.min < componentMax
        && interval.max > componentMin;
      if (!containsPoint && !overlapsComponent) continue;

      const nextMin = Math.min(componentMin, interval.min);
      const nextMax = Math.max(componentMax, interval.max);
      if (!found || nextMin !== componentMin || nextMax !== componentMax) {
        componentMin = nextMin;
        componentMax = nextMax;
        changed = true;
      }
      found = true;
    }
  }

  return found ? { min: componentMin, max: componentMax } : null;
}

/**
 * Resolves penetration using the AABBs expanded by the sphere radius.
 * Inputs are never mutated; exact boundary contact is considered resolved.
 */
export function pushSphereOutOfAABBs(
  position: Vector3Like,
  radius: number,
  colliders: readonly AABB[],
): Vector3 {
  assertRadius(radius);
  const resolved = new Vector3(position.x, position.y, position.z);
  const expanded = colliders.map((collider) => toBounds(collider, radius));
  if (!expanded.some((bounds) => isStrictlyInside(resolved, bounds))) return resolved;

  let bestAxis: Axis | null = null;
  let bestCoordinate = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const axis of AXES) {
    const component = connectedIntervalAtPoint(resolved, axis, expanded);
    if (!component) continue;

    for (const coordinate of [component.min, component.max]) {
      const distance = Math.abs(coordinate - resolved[axis]);
      if (distance < bestDistance) {
        bestAxis = axis;
        bestCoordinate = coordinate;
        bestDistance = distance;
      }
    }
  }

  if (bestAxis) resolved[bestAxis] = bestCoordinate;
  return resolved;
}

function sweepPointAgainstBounds(
  start: Vector3Like,
  target: Vector3Like,
  bounds: NumericBounds,
): { time: number; normal: Vector3 } | null {
  let entryTime = Number.NEGATIVE_INFINITY;
  let exitTime = Number.POSITIVE_INFINITY;
  const entryNormal = new Vector3();
  let hasMovement = false;

  for (const axis of AXES) {
    const delta = target[axis] - start[axis];
    if (Math.abs(delta) <= SWEEP_EPSILON) {
      if (start[axis] <= bounds.min[axis] || start[axis] >= bounds.max[axis]) return null;
      continue;
    }

    hasMovement = true;
    const minimumTime = (bounds.min[axis] - start[axis]) / delta;
    const maximumTime = (bounds.max[axis] - start[axis]) / delta;
    const nearTime = Math.min(minimumTime, maximumTime);
    const farTime = Math.max(minimumTime, maximumTime);

    if (nearTime > entryTime) {
      entryTime = nearTime;
      entryNormal.set(0, 0, 0);
      entryNormal[axis] = delta > 0 ? -1 : 1;
    }
    exitTime = Math.min(exitTime, farTime);
    if (entryTime > exitTime) return null;
  }

  if (!hasMovement
    || entryTime < -SWEEP_EPSILON
    || entryTime > 1 + SWEEP_EPSILON
    || exitTime < 0
    || entryNormal.lengthSq() === 0) {
    return null;
  }

  return { time: Math.max(0, Math.min(1, entryTime)), normal: entryNormal };
}

/** Returns the earliest collision of a sphere proxy moving along start-target. */
export function sweepSphereAgainstAABBs(
  start: Vector3Like,
  target: Vector3Like,
  radius: number,
  colliders: readonly AABB[],
): SphereSweepHit | null {
  assertRadius(radius);
  const delta = new Vector3(target.x - start.x, target.y - start.y, target.z - start.z);
  let nearest: SphereSweepHit | null = null;

  colliders.forEach((collider, colliderIndex) => {
    const hit = sweepPointAgainstBounds(start, target, toBounds(collider, radius));
    if (!hit || (nearest && hit.time >= nearest.time)) return;

    nearest = {
      collider,
      colliderIndex,
      time: hit.time,
      point: new Vector3(start.x, start.y, start.z).addScaledVector(delta, hit.time),
      normal: hit.normal,
    };
  });

  return nearest;
}

/** Resolves initial overlap, then clamps the target to the first swept collision. */
export function clampSphereMovement(
  start: Vector3Like,
  target: Vector3Like,
  radius: number,
  colliders: readonly AABB[],
): Vector3 {
  const resolvedStart = pushSphereOutOfAABBs(start, radius, colliders);
  const hit = sweepSphereAgainstAABBs(resolvedStart, target, radius, colliders);
  return hit?.point ?? new Vector3(target.x, target.y, target.z);
}

/**
 * Selects the nearest usable hit from a downward Raycaster-style result list.
 * The original intersection object is returned so object/face metadata is kept.
 */
export function selectNearestDownwardHit<T extends RayIntersectionLike>(
  intersections: readonly T[],
  origin: Vector3Like,
  options: DownwardHitOptions<T> = {},
): T | null {
  const maxDistance = options.maxDistance ?? Number.POSITIVE_INFINITY;
  const epsilon = Math.max(0, options.epsilon ?? 1e-6);
  let nearest: T | null = null;

  for (const intersection of intersections) {
    const { distance, point } = intersection;
    const finitePoint = Number.isFinite(point?.x)
      && Number.isFinite(point?.y)
      && Number.isFinite(point?.z);
    if (!finitePoint
      || !Number.isFinite(distance)
      || distance < 0
      || distance > maxDistance
      || point.y > origin.y + epsilon
      || (options.isValid && !options.isValid(intersection))) {
      continue;
    }

    if (!nearest || distance < nearest.distance) nearest = intersection;
  }

  return nearest;
}
