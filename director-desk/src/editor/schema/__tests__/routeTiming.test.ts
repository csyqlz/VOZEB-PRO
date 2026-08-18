import { describe, expect, it } from "vitest";
import {
  createRouteTimingPlan,
  evaluateCubicBezier,
  getRouteTimingPosition,
  sampleRouteTiming,
} from "../routeTiming";

const point = (time: number, x: number, extras = {}) => ({
  time,
  position: [x, 0, 0] as [number, number, number],
  ...extras,
});

describe("shared route timing", () => {
  it("allocates uniform time from physical distance instead of point count", () => {
    const plan = createRouteTimingPlan({
      points: [point(0, 0), point(0.5, 1), point(1, 10)],
      duration: 10,
      interpolation: "linear",
      speedMode: "uniform",
    });

    expect(plan.arrivals[1]).toBeCloseTo(0.1, 3);
    expect(getRouteTimingPosition(plan, 0.5)[0]).toBeCloseTo(5, 2);
  });

  it("does not brake at an intermediate pass-through point", () => {
    const plan = createRouteTimingPlan({
      points: [point(0, 0), point(0.5, 5), point(1, 10)],
      duration: 10,
      interpolation: "linear",
      speedMode: "uniform",
    });
    const before = getRouteTimingPosition(plan, 0.499)[0];
    const after = getRouteTimingPosition(plan, 0.501)[0];

    expect(5 - before).toBeCloseTo(after - 5, 4);
    expect(after - before).toBeGreaterThan(0.015);
  });

  it("applies soft easing once across the whole moving route", () => {
    const plan = createRouteTimingPlan({
      points: [point(0, 0), point(0.5, 5), point(1, 10)],
      duration: 10,
      interpolation: "linear",
      speedMode: "soft",
    });
    const startTravel = getRouteTimingPosition(plan, 0.05)[0];
    const centerTravel = getRouteTimingPosition(plan, 0.55)[0] - getRouteTimingPosition(plan, 0.45)[0];
    const waypointTravel = getRouteTimingPosition(plan, 0.51)[0] - getRouteTimingPosition(plan, 0.49)[0];

    expect(startTravel).toBeLessThan(0.2);
    expect(centerTravel).toBeGreaterThan(1.4);
    expect(waypointTravel).toBeGreaterThan(0.25);
  });

  it("holds an explicit point for the configured number of seconds", () => {
    const plan = createRouteTimingPlan({
      points: [
        point(0, 0),
        point(0.5, 5, { pointBehavior: "hold", holdSeconds: 2 }),
        point(1, 10),
      ],
      duration: 10,
      interpolation: "linear",
      speedMode: "uniform",
    });

    expect(plan.departures[1] - plan.arrivals[1]).toBeCloseTo(0.2, 5);
    expect(getRouteTimingPosition(plan, plan.arrivals[1] + 0.1)).toEqual([5, 0, 0]);
    expect(sampleRouteTiming(plan, plan.arrivals[1] + 0.1).holdingPointIndex).toBe(1);
  });

  it("uses manual arrival times and a deterministic custom speed curve", () => {
    const plan = createRouteTimingPlan({
      points: [point(0, 0), point(0.2, 5), point(1, 10)],
      duration: 10,
      interpolation: "linear",
      speedMode: "custom",
      customEasing: [0.42, 0, 1, 1],
    });

    expect(plan.arrivals).toEqual([0, 0.2, 1]);
    expect(getRouteTimingPosition(plan, 0.1)[0]).toBeLessThan(2.5);
    expect(evaluateCubicBezier(0.5, [0, 0, 1, 1])).toBeCloseTo(0.5, 4);
  });

  it("uses arc length to keep a smooth spatial curve close to uniform speed", () => {
    const plan = createRouteTimingPlan({
      points: [
        { time: 0, position: [0, 0, 0] },
        { time: 0.5, position: [4, 0, 0] },
        { time: 1, position: [4, 0, 4] },
      ],
      duration: 10,
      interpolation: "smooth",
      speedMode: "uniform",
    });
    const positions = [0, 0.1, 0.2, 0.3, 0.4].map((progress) => getRouteTimingPosition(plan, progress));
    const distances = positions.slice(1).map((position, index) => Math.hypot(
      position[0] - positions[index][0],
      position[1] - positions[index][1],
      position[2] - positions[index][2],
    ));

    expect(Math.max(...distances) - Math.min(...distances)).toBeLessThan(0.08);
  });
});
