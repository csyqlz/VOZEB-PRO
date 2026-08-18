import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import {
  clampSphereMovement,
  isPointInsideAABB,
  sphereIntersectsAABB,
  pushSphereOutOfAABBs,
  selectNearestDownwardHit,
  sweepSphereAgainstAABBs,
  type AABB,
} from "../spatialCollision";

const box = (
  min: [number, number, number],
  max: [number, number, number],
): AABB => ({
  min: new Vector3(...min),
  max: new Vector3(...max),
});

describe("spatial collision primitives", () => {
  const unitBox = box([0, 0, 0], [1, 1, 1]);

  it("treats AABB faces as part of the box", () => {
    expect(isPointInsideAABB(new Vector3(0, 0.5, 1), unitBox)).toBe(true);
    expect(isPointInsideAABB(new Vector3(-0.001, 0.5, 1), unitBox)).toBe(false);
  });

  it("detects sphere overlap and exact boundary contact", () => {
    expect(sphereIntersectsAABB(new Vector3(-0.5, 0.5, 0.5), 0.5, unitBox)).toBe(true);
    expect(sphereIntersectsAABB(new Vector3(-0.501, 0.5, 0.5), 0.5, unitBox)).toBe(false);
    expect(sphereIntersectsAABB(new Vector3(0.5, 0.5, 0.5), 0, unitBox)).toBe(true);
  });

  it("pushes a sphere proxy outside the connected union of multiple AABBs", () => {
    const colliders = [
      box([0, -1, -1], [1, 1, 1]),
      box([1, -1, -1], [2, 1, 1]),
    ];
    const original = new Vector3(0.5, 0, 0);

    const resolved = pushSphereOutOfAABBs(original, 0.25, colliders);

    expect(resolved.toArray()).toEqual([-0.25, 0, 0]);
    expect(original.toArray()).toEqual([0.5, 0, 0]);
    expect(colliders.every((collider) => !sphereIntersectsAABB(resolved, 0.249999, collider))).toBe(true);
  });

  it("leaves an already valid position unchanged", () => {
    const position = new Vector3(3, 2, 1);
    expect(pushSphereOutOfAABBs(position, 0.5, [unitBox]).equals(position)).toBe(true);
    expect(pushSphereOutOfAABBs(position, 0.5, [])).not.toBe(position);
  });
});

describe("continuous sphere movement", () => {
  const wall = box([0, -1, -1], [1, 1, 1]);

  it("finds the first expanded-AABB hit along a segment", () => {
    const hit = sweepSphereAgainstAABBs(
      new Vector3(-2, 0, 0),
      new Vector3(3, 0, 0),
      0.25,
      [wall],
    );

    expect(hit).not.toBeNull();
    expect(hit?.time).toBeCloseTo(0.35);
    expect(hit?.point.toArray()).toEqual([-0.25, 0, 0]);
    expect(hit?.normal.toArray()).toEqual([-1, 0, 0]);
    expect(hit?.colliderIndex).toBe(0);
  });

  it("clamps repeated target movement at contact instead of tunneling", () => {
    const firstFrame = clampSphereMovement(
      new Vector3(-2, 0, 0),
      new Vector3(3, 0, 0),
      0.25,
      [wall],
    );
    const secondFrame = clampSphereMovement(
      firstFrame,
      new Vector3(4, 0, 0),
      0.25,
      [wall],
    );

    expect(firstFrame.toArray()).toEqual([-0.25, 0, 0]);
    expect(secondFrame.toArray()).toEqual([-0.25, 0, 0]);
  });

  it("returns the target when the segment misses and allows movement away from contact", () => {
    const missTarget = new Vector3(3, 3, 0);
    expect(clampSphereMovement(new Vector3(-2, 3, 0), missTarget, 0.25, [wall]).equals(missTarget)).toBe(true);
    expect(clampSphereMovement(new Vector3(-0.25, 0, 0), new Vector3(-2, 0, 0), 0.25, [wall]).toArray()).toEqual([-2, 0, 0]);
  });
});

describe("downward intersection selection", () => {
  const origin = new Vector3(0, 10, 0);

  it("selects the nearest valid downward hit from unsorted Raycaster-like results", () => {
    const intersections = [
      { distance: 6, point: new Vector3(0, 4, 0), id: "far" },
      { distance: Number.NaN, point: new Vector3(0, 9, 0), id: "nan" },
      { distance: 1, point: new Vector3(0, 11, 0), id: "above-origin" },
      { distance: 2, point: new Vector3(0, 8, 0), id: "nearest" },
    ];

    expect(selectNearestDownwardHit(intersections, origin)?.id).toBe("nearest");
    expect(selectNearestDownwardHit(intersections, origin, { maxDistance: 1.5 })).toBeNull();
  });

  it("supports caller filtering and returns null when no hit is valid", () => {
    const intersections = [
      { distance: 1, point: new Vector3(0, 9, 0), kind: "helper" },
      { distance: 3, point: new Vector3(0, 7, 0), kind: "ground" },
    ];

    const ground = selectNearestDownwardHit(intersections, origin, {
      isValid: (hit) => hit.kind === "ground",
    });

    expect(ground?.kind).toBe("ground");
    expect(selectNearestDownwardHit([], origin)).toBeNull();
    expect(selectNearestDownwardHit(
      [{ distance: -1, point: new Vector3(0, 9, 0) }],
      origin,
    )).toBeNull();
  });
});
