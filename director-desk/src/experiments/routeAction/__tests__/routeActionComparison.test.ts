import { ACTION_RUNTIME_BODY_PARTS, type ActionRuntimePose } from "../../actionRuntime/poseComparison";
import {
  compareRouteActionReplay,
  compareRouteActionViewSamples,
  getRelativeRightHandDelta,
  type RouteActionSample,
} from "../routeActionComparison";

function pose(offset = 0, handOffset = 0): ActionRuntimePose {
  return Object.fromEntries(ACTION_RUNTIME_BODY_PARTS.map((bodyPart, index) => [
    bodyPart,
    [index + offset + (bodyPart === "rightHand" ? handOffset : 0), index * 0.5, -index] as [number, number, number],
  ])) as ActionRuntimePose;
}

function sample(viewId: string, offset = 0, handOffset = 0): RouteActionSample {
  const currentPose = pose(offset, handOffset);
  return { viewId, pose: currentPose, cameraTarget: currentPose.rightHand, objectPosition: [offset, 0, 0] };
}

it("compares route position and skeleton pose across independent views", () => {
  const result = compareRouteActionViewSamples([sample("main"), sample("monitor", 0.0001)]);
  expect(result.passed).toBe(true);
  expect(result.maxPositionDelta).toBeLessThanOrEqual(0.0005);
});

it("detects a hold action moving the hand relative to the waist", () => {
  expect(getRelativeRightHandDelta(pose(), pose(0, 0.3))).toBeGreaterThan(0.2);
  expect(getRelativeRightHandDelta(pose(), pose(4))).toBe(0);
});

it("compares a replayed route action sample with its canonical sample", () => {
  expect(compareRouteActionReplay(sample("main"), sample("replay", 0.0001))).toEqual({
    poseDelta: expect.any(Number),
    positionDelta: 0.0001,
  });
});
