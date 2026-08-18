import { expect, it } from "vitest";
import type { DirectorCameraShot, DirectorObject } from "../directorProject";
import { getAnimatedCameraFocusSample, getAnimatedCameraFocusTarget } from "../cameraTarget";

it("tracks the animated position of a moving prop at the current shared timeline progress", () => {
  const object: DirectorObject = {
    id: "moving_box",
    name: "移动箱子",
    kind: "prop",
    visible: true,
    locked: false,
    geometryType: "box",
    transform: { position: [10, 2, -4], rotation: [0, 0, 0], scale: [2, 2, 2] },
    motionPath: {
      interpolation: "linear",
      keyframes: [
        { id: "move_1", time: 0, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
        { id: "move_2", time: 1, transform: { position: [10, 2, -4], rotation: [0, 0, 0], scale: [2, 2, 2] } },
      ],
    },
  };
  const camera: DirectorCameraShot = {
    id: "cam_1",
    name: "机位01",
    fov: 50,
    transform: { position: [0, 2, 8], rotation: [0, 0, 0], scale: [1, 1, 1] },
    targetMode: "object",
    targetObjectId: object.id,
    target: [0, 0.5, 0],
  };

  expect(getAnimatedCameraFocusTarget(camera, [object], 0)).toEqual([0, 0.5, 0]);
  expect(getAnimatedCameraFocusTarget(camera, [object], 0.5)).toEqual([5, 1.75, -2]);
  expect(getAnimatedCameraFocusTarget(camera, [object], 1)).toEqual([10, 3, -4]);
});

it("does not override a manually aimed camera", () => {
  const camera: DirectorCameraShot = {
    id: "cam_1",
    name: "机位01",
    fov: 50,
    transform: { position: [0, 2, 8], rotation: [0, 0, 0], scale: [1, 1, 1] },
    targetMode: "manual",
    target: [1, 2, 3],
  };

  expect(getAnimatedCameraFocusTarget(camera, [], 0.5)).toBeNull();
});

it("passes each waypoint body part to the runtime resolver", () => {
  const character: DirectorObject = {
    id: "actor_1",
    name: "挥手角色",
    kind: "character",
    visible: true,
    locked: false,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  };
  const camera: DirectorCameraShot = {
    id: "cam_hand",
    name: "手部跟拍",
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
        { id: "p1", time: 0, position: [0, 2, 8], target: [0, 1, 0], fov: 50, targetMode: "object", targetObjectId: character.id, targetBodyPart: "rightHand", targetFollowMode: "smooth" },
        { id: "p2", time: 1, position: [0, 2, 4], target: [0, 1, 0], fov: 50, targetMode: "object", targetObjectId: character.id, targetBodyPart: "head", targetFollowMode: "immediate" },
      ],
    },
  };
  const requestedParts: string[] = [];
  const sample = getAnimatedCameraFocusSample(camera, [character], 0.25, (_object, bodyPart) => {
    requestedParts.push(bodyPart);
    return bodyPart === "rightHand" ? [2, 3, 4] : [5, 6, 7];
  });

  expect(requestedParts).toEqual(["rightHand", "head"]);
  expect(sample?.followMode).toBe("smooth");
  expect(sample?.stabilizationEnabled).toBe(false);
  expect(sample?.target).toEqual([2.75, 3.75, 4.75]);
});

it("lets each waypoint track a different moving subject and blends between them", () => {
  const left: DirectorObject = {
    id: "left_actor",
    name: "左侧人物",
    kind: "prop",
    visible: true,
    locked: false,
    geometryType: "box",
    transform: { position: [-4, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  };
  const right: DirectorObject = {
    ...left,
    id: "right_actor",
    name: "右侧人物",
    transform: { ...left.transform, position: [4, 0, 0] },
  };
  const camera: DirectorCameraShot = {
    id: "cam_route",
    name: "切换跟踪目标",
    fov: 50,
    transform: { position: [0, 2, 8], rotation: [0, 0, 0], scale: [1, 1, 1] },
    targetMode: "manual",
    target: [0, 1, 0],
    motionPath: {
      duration: 6,
      loop: false,
      interpolation: "smooth",
      easing: "linear",
      keyframes: [
        { id: "point_1", time: 0, position: [0, 2, 8], target: [-4, 0.5, 0], fov: 50, targetMode: "object", targetObjectId: left.id },
        { id: "point_2", time: 1, position: [0, 2, 4], target: [4, 0.5, 0], fov: 50, targetMode: "object", targetObjectId: right.id },
      ],
    },
  };

  expect(getAnimatedCameraFocusTarget(camera, [left, right], 0)).toEqual([-4, 0.5, 0]);
  expect(getAnimatedCameraFocusTarget(camera, [left, right], 0.5)).toEqual([0, 0.5, 0]);
  expect(getAnimatedCameraFocusTarget(camera, [left, right], 1)).toEqual([4, 0.5, 0]);
});

it("uses the camera route timing sample when switching tracked subjects", () => {
  const subjects: DirectorObject[] = [0, 10, 20].map((x, index) => ({
    id: `subject_${index}`,
    name: `目标${index + 1}`,
    kind: "prop",
    visible: true,
    locked: false,
    geometryType: "box",
    transform: { position: [x, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  }));
  const camera: DirectorCameraShot = {
    id: "timed_camera",
    name: "同步跟踪",
    fov: 50,
    transform: { position: [0, 2, 8], rotation: [0, 0, 0], scale: [1, 1, 1] },
    targetMode: "manual",
    target: [0, 0.5, 0],
    motionPath: {
      duration: 10,
      loop: false,
      interpolation: "linear",
      easing: "linear",
      speedMode: "uniform",
      keyframes: [
        { id: "point_1", time: 0, position: [0, 2, 8], target: [0, 0.5, 0], fov: 50, targetMode: "object", targetObjectId: subjects[0].id },
        { id: "point_2", time: 0.5, position: [1, 2, 8], target: [10, 0.5, 0], fov: 50, targetMode: "object", targetObjectId: subjects[1].id },
        { id: "point_3", time: 1, position: [10, 2, 8], target: [20, 0.5, 0], fov: 50, targetMode: "object", targetObjectId: subjects[2].id },
      ],
    },
  };

  const target = getAnimatedCameraFocusTarget(camera, subjects, 0.5);
  expect(target?.[0]).toBeCloseTo(14.444444, 4);
  expect(target?.[1]).toBeCloseTo(0.5, 5);
});
