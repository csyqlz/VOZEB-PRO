import { expect, it } from "vitest";
import type { DirectorCameraShot, DirectorObject } from "../directorProject";
import { getCameraPlaybackSnapshot } from "../cameraPlayback";

function movingCharacter(id: string, startX: number, endX: number): DirectorObject {
  const start = { position: [startX, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] };
  const end = { ...start, position: [endX, 0, 0] as [number, number, number] };
  return {
    id,
    name: id,
    kind: "character",
    visible: true,
    locked: false,
    bodyType: "mannequin",
    transform: start,
    motionPath: {
      interpolation: "linear",
      keyframes: [
        { id: `${id}_start`, time: 0, transform: start },
        { id: `${id}_end`, time: 1, transform: end },
      ],
    },
  };
}

it("keeps the render camera moving while switching between two animated characters", () => {
  const first = movingCharacter("actor_1", -4, 0);
  const second = movingCharacter("actor_2", 4, 8);
  const camera: DirectorCameraShot = {
    id: "camera_1",
    name: "双人物跟拍",
    fov: 50,
    transform: { position: [0, 2, 8], rotation: [0, 0, 0], scale: [1, 1, 1] },
    targetMode: "manual",
    target: [0, 1, 0],
    motionPath: {
      duration: 6,
      loop: false,
      interpolation: "linear",
      easing: "linear",
      keyframes: [
        { id: "point_1", time: 0, position: [0, 2, 8], target: [-4, 1, 0], fov: 50, targetMode: "object", targetObjectId: first.id },
        { id: "point_2", time: 0.5, position: [2, 2, 6], target: [-2, 1, 0], fov: 46, targetMode: "object", targetObjectId: first.id },
        { id: "point_3", time: 0.5001, position: [2.1, 2, 5.9], target: [6, 1, 0], fov: 45, targetMode: "object", targetObjectId: second.id },
        { id: "point_4", time: 1, position: [4, 2, 4], target: [8, 1, 0], fov: 40, targetMode: "object", targetObjectId: second.id },
      ],
    },
  };

  const quarter = getCameraPlaybackSnapshot(camera, [first, second], 0.25);
  const middle = getCameraPlaybackSnapshot(camera, [first, second], 0.5);
  const threeQuarter = getCameraPlaybackSnapshot(camera, [first, second], 0.75);

  expect(quarter.position).toEqual([1, 2, 7]);
  expect(middle.position).toEqual([2, 2, 6]);
  expect(threeQuarter.position[0]).toBeGreaterThan(middle.position[0]);
  expect(threeQuarter.target[0]).toBeGreaterThan(middle.target[0]);
  for (const snapshot of [quarter, middle, threeQuarter]) {
    expect([...snapshot.position, ...snapshot.target, snapshot.fov].every(Number.isFinite)).toBe(true);
  }
});
