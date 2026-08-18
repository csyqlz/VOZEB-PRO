import type { ActionRuntimePose, ActionRuntimeViewSample } from "../actionRuntime/poseComparison";
import { compareActionRuntimeViewSamples, getActionRuntimePoseDelta } from "../actionRuntime/poseComparison";

export interface RouteActionSample extends ActionRuntimeViewSample {
  objectPosition: [number, number, number];
}

export function compareRouteActionViewSamples(samples: RouteActionSample[], tolerance = 0.0005) {
  const poseComparison = compareActionRuntimeViewSamples(samples, tolerance);
  if (samples.length < 2) {
    return { passed: false, maxPositionDelta: Number.POSITIVE_INFINITY, poseComparison };
  }
  const baseline = samples[0].objectPosition;
  const maxPositionDelta = Math.max(...samples.slice(1).map((sample) => Math.hypot(
    sample.objectPosition[0] - baseline[0],
    sample.objectPosition[1] - baseline[1],
    sample.objectPosition[2] - baseline[2],
  )));
  return {
    passed: poseComparison.passed && maxPositionDelta <= tolerance,
    maxPositionDelta: Number(maxPositionDelta.toFixed(6)),
    poseComparison,
  };
}

export function getRelativeRightHandPose(pose: ActionRuntimePose) {
  return pose.rightHand.map((value, index) => value - pose.waist[index]) as [number, number, number];
}

export function getRelativeRightHandDelta(left: ActionRuntimePose, right: ActionRuntimePose) {
  const leftHand = getRelativeRightHandPose(left);
  const rightHand = getRelativeRightHandPose(right);
  return Number(Math.hypot(
    leftHand[0] - rightHand[0],
    leftHand[1] - rightHand[1],
    leftHand[2] - rightHand[2],
  ).toFixed(6));
}

export function compareRouteActionReplay(left: RouteActionSample, right: RouteActionSample) {
  return {
    poseDelta: getActionRuntimePoseDelta(left.pose, right.pose),
    positionDelta: Number(Math.hypot(
      left.objectPosition[0] - right.objectPosition[0],
      left.objectPosition[1] - right.objectPosition[1],
      left.objectPosition[2] - right.objectPosition[2],
    ).toFixed(6)),
  };
}
