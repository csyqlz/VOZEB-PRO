import { describe, expect, it } from "vitest";
import {
  ACTION_RUNTIME_BODY_PARTS,
  compareActionRuntimeCameraTargets,
  compareActionRuntimeViewSamples,
  getActionRuntimeCameraTargetDelta,
  getActionRuntimePoseDelta,
  getActionRuntimePoseTravel,
  getActionRuntimeTargetTravel,
  type ActionRuntimePose,
} from "../poseComparison";

function pose(offset = 0): ActionRuntimePose {
  return Object.fromEntries(ACTION_RUNTIME_BODY_PARTS.map((bodyPart, index) => [
    bodyPart,
    [index + offset, index * 0.5, -index] as [number, number, number],
  ])) as ActionRuntimePose;
}

function sample(viewId: string, offset = 0) {
  const currentPose = pose(offset);
  return { viewId, pose: currentPose, cameraTarget: currentPose.rightHand };
}

describe("action runtime cross-view comparison", () => {
  it("accepts tiny floating point differences between independent canvases", () => {
    const result = compareActionRuntimeViewSamples([
      sample("main"),
      sample("monitor", 0.0001),
      sample("export", -0.0001),
    ]);

    expect(result.passed).toBe(true);
    expect(result.maxDelta).toBeLessThanOrEqual(0.0005);
  });

  it("rejects a visibly different skeleton pose", () => {
    const result = compareActionRuntimeViewSamples([
      sample("main"),
      sample("monitor", 0.02),
    ]);

    expect(result.passed).toBe(false);
    expect(result.viewDeltas.monitor).toBeGreaterThan(0.01);
  });

  it("requires all view cameras to resolve the same moving tracked body part", () => {
    const result = compareActionRuntimeCameraTargets([
      sample("main"),
      sample("monitor", 0.0001),
      sample("export", -0.0001),
    ]);

    expect(result.passed).toBe(true);
    expect(getActionRuntimeCameraTargetDelta(sample("main").cameraTarget, sample("main").pose)).toBe(0);
    expect(getActionRuntimeTargetTravel([sample("main").cameraTarget, sample("later", 0.4).cameraTarget])).toBeGreaterThan(0.3);
  });

  it("proves that the sampled action changes over time", () => {
    expect(getActionRuntimePoseTravel([pose(), pose(0.25)])).toBeGreaterThan(0.2);
    expect(getActionRuntimePoseTravel([pose(), pose()])).toBe(0);
  });

  it("compares a replayed pose with its first deterministic sample", () => {
    expect(getActionRuntimePoseDelta(pose(), pose(0.0001))).toBeLessThanOrEqual(0.0005);
    expect(getActionRuntimePoseDelta(pose(), pose(0.02))).toBeGreaterThan(0.01);
  });
});
