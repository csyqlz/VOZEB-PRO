import { describe, expect, it } from "vitest";
import type { DirectorCameraShot } from "../directorProject";
import {
  createCameraMotionKeyframe,
  getCameraMotionActiveKeyframeIndex,
  getCameraMotionKeyframeArrivalProgress,
  getCameraMotionSnapshot,
  normalizeCameraMotionPath,
  retimeCameraMotionKeyframes,
  sampleCameraMotionPath,
} from "../cameraMotion";

function camera(): DirectorCameraShot {
  return {
    id: "cam_1",
    name: "机位01",
    fov: 50,
    transform: { position: [0, 2, 8], rotation: [0, 0, 0], scale: [1, 1, 1] },
    targetMode: "manual",
    target: [0, 1, 0],
    motionPath: {
      duration: 6,
      loop: false,
      interpolation: "smooth",
      easing: "ease-in-out",
      keyframes: [
        { id: "key_1", time: 0, position: [0, 2, 8], target: [0, 1, 0], fov: 50 },
        { id: "key_2", time: 0.5, position: [5, 3, 2], target: [1, 1.5, 0], fov: 42 },
        { id: "key_3", time: 1, position: [0, 1.5, -5], target: [3, 1, -1], fov: 35 },
      ],
    },
  };
}

describe("camera motion path", () => {
  it("normalizes malformed persisted values", () => {
    expect(normalizeCameraMotionPath({ duration: -1, interpolation: "unknown" })).toMatchObject({
      duration: 0.5,
      interpolation: "smooth",
      keyframes: [],
    });
    expect(normalizeCameraMotionPath({ duration: 99 }).duration).toBe(30);
  });

  it("captures the current camera as a keyframe", () => {
    expect(createCameraMotionKeyframe(camera(), "key_4")).toMatchObject({
      id: "key_4",
      position: [0, 2, 8],
      target: [0, 1, 0],
      fov: 50,
      targetBodyPart: "center",
      targetFollowMode: "immediate",
      targetStabilizationEnabled: false,
    });
  });

  it("normalizes semantic body tracking fields without breaking old routes", () => {
    const path = normalizeCameraMotionPath({
      duration: 6,
      keyframes: [
        { id: "valid", time: 0, position: [0, 2, 8], target: [0, 1, 0], fov: 50, targetBodyPart: "rightHand", targetFollowMode: "smooth", targetStabilizationEnabled: true },
        { id: "legacy", time: 1, position: [0, 2, 4], target: [0, 1, 0], fov: 50 },
      ],
    });

    expect(path.keyframes[0]).toMatchObject({ targetBodyPart: "rightHand", targetFollowMode: "smooth", targetStabilizationEnabled: true });
    expect(path.keyframes[1]).toMatchObject({ targetBodyPart: "center", targetFollowMode: "immediate", targetStabilizationEnabled: false });
  });

  it("retimes keyframes across the complete shot", () => {
    const retimed = retimeCameraMotionKeyframes(camera().motionPath!.keyframes);
    expect(retimed.map((item) => item.time)).toEqual([0, 0.5, 1]);
  });

  it("preserves exact first and last camera positions and look targets", () => {
    const shot = camera();
    shot.motionPath!.keyframes[0].target = [-2, 1, 1];
    shot.motionPath!.keyframes[2].target = [4, 2, -3];

    expect(getCameraMotionSnapshot(shot, 0)).toMatchObject({
      position: [0, 2, 8],
      target: [-2, 1, 1],
    });
    expect(getCameraMotionSnapshot(shot, 1)).toMatchObject({
      position: [0, 1.5, -5],
      target: [4, 2, -3],
    });
  });

  it("samples a smooth path while interpolating each waypoint target", () => {
    const shot = camera();
    const sample = getCameraMotionSnapshot(shot, 0.5);
    expect(sample.position).toEqual([5, 3, 2]);
    expect(sample.target).toEqual([1, 1.5, 0]);
    expect(sampleCameraMotionPath(shot, 20)).toHaveLength(20);
  });

  it("captures an arbitrary live pilot snapshot instead of the camera rig", () => {
    expect(
      createCameraMotionKeyframe(camera(), "key_live", {
        position: [9, 4, -2],
        target: [2, 2, 0],
        fov: 33,
      })
    ).toMatchObject({
      id: "key_live",
      position: [9, 4, -2],
      target: [2, 2, 0],
      fov: 33,
    });
  });

  it("uses physical distance when the new uniform speed mode is selected", () => {
    const shot = camera();
    shot.motionPath = {
      ...shot.motionPath!,
      interpolation: "linear",
      speedMode: "uniform",
      keyframes: [
        { id: "short", time: 0, position: [0, 0, 0], target: [0, 0, 1], fov: 50 },
        { id: "corner", time: 0.5, position: [1, 0, 0], target: [1, 0, 1], fov: 50 },
        { id: "long", time: 1, position: [10, 0, 0], target: [10, 0, 1], fov: 50 },
      ],
    };

    expect(getCameraMotionSnapshot(shot, 0.5).position[0]).toBeCloseTo(5, 2);
    expect(getCameraMotionKeyframeArrivalProgress(shot, 1)).toBeCloseTo(0.1, 4);
    expect(getCameraMotionActiveKeyframeIndex(shot, 0.09)).toBe(0);
    expect(getCameraMotionActiveKeyframeIndex(shot, 0.1)).toBe(1);
  });

  it("keeps the camera fixed for an explicit waypoint hold", () => {
    const shot = camera();
    shot.motionPath = {
      ...shot.motionPath!,
      interpolation: "linear",
      speedMode: "uniform",
      duration: 10,
      keyframes: [
        { id: "start", time: 0, position: [0, 0, 0], target: [0, 0, 1], fov: 50 },
        {
          id: "hold",
          time: 0.5,
          position: [5, 0, 0],
          target: [5, 0, 1],
          fov: 50,
          pointBehavior: "hold",
          holdSeconds: 2,
        },
        { id: "end", time: 1, position: [10, 0, 0], target: [10, 0, 1], fov: 50 },
      ],
    };

    expect(getCameraMotionSnapshot(shot, 0.5).position).toEqual([5, 0, 0]);
    expect(getCameraMotionSnapshot(shot, 0.59).position).toEqual([5, 0, 0]);
  });
});
