import { Bone, Group } from "three";
import { expect, it } from "vitest";
import type { DirectorCameraShot, DirectorObject } from "../../schema/directorProject";
import {
  createCameraTrackingSmoothingState,
  getRuntimeCameraPlaybackSnapshot,
} from "../cameraBodyTracking";
import { getDirectorObjectSceneNodeName } from "../semanticBodyTracking";

function actor(): DirectorObject {
  return {
    id: "actor_1",
    name: "角色 1",
    kind: "character",
    visible: true,
    locked: false,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  };
}

function trackingCamera(followMode: "immediate" | "smooth"): DirectorCameraShot {
  return {
    id: "camera_1",
    name: "右手跟拍",
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
        { id: "p1", time: 0, position: [0, 2, 8], target: [0, 1, 0], fov: 50, targetMode: "object", targetObjectId: "actor_1", targetBodyPart: "rightHand", targetFollowMode: followMode },
        { id: "p2", time: 1, position: [0, 2, 6], target: [0, 1, 0], fov: 50, targetMode: "object", targetObjectId: "actor_1", targetBodyPart: "rightHand", targetFollowMode: followMode },
      ],
    },
  };
}

function stabilizedTrackingCamera(): DirectorCameraShot {
  const camera = trackingCamera("immediate");
  camera.motionPath!.keyframes = camera.motionPath!.keyframes.map((keyframe) => ({
    ...keyframe,
    targetStabilizationEnabled: true,
  }));
  return camera;
}

function animatedScene() {
  const scene = new Group();
  const character = new Group();
  character.name = getDirectorObjectSceneNodeName("actor_1");
  const hand = new Bone();
  hand.name = "mixamorig:RightHand";
  hand.position.set(1, 1.5, 0);
  character.add(hand);
  scene.add(character);
  scene.updateMatrixWorld(true);
  return { hand, scene };
}

it("aims at the current animated right-hand world position", () => {
  const { scene } = animatedScene();
  const snapshot = getRuntimeCameraPlaybackSnapshot({
    camera: trackingCamera("immediate"),
    objects: [actor()],
    progress: 0.5,
    scene,
    smoothingState: createCameraTrackingSmoothingState(),
  });

  expect(snapshot.target).toEqual([1, 1.5, 0]);
});

it("smooth follow moves toward a waving hand without snapping", () => {
  const { hand, scene } = animatedScene();
  const smoothingState = createCameraTrackingSmoothingState();
  const camera = trackingCamera("smooth");
  const first = getRuntimeCameraPlaybackSnapshot({ camera, objects: [actor()], progress: 0, scene, smoothingState });

  hand.position.x = 4;
  scene.updateMatrixWorld(true);
  const second = getRuntimeCameraPlaybackSnapshot({ camera, objects: [actor()], progress: 0.02, scene, smoothingState });

  expect(first.target[0]).toBe(1);
  expect(second.target[0]).toBeGreaterThan(1);
  expect(second.target[0]).toBeLessThan(4);
});

it("body tracking stabilization filters a walking limb even with immediate response selected", () => {
  const { hand, scene } = animatedScene();
  const smoothingState = createCameraTrackingSmoothingState();
  const camera = stabilizedTrackingCamera();
  getRuntimeCameraPlaybackSnapshot({ camera, objects: [actor()], progress: 0, scene, smoothingState });

  hand.position.x = 4;
  scene.updateMatrixWorld(true);
  const stabilized = getRuntimeCameraPlaybackSnapshot({
    camera,
    objects: [actor()],
    progress: 0.02,
    scene,
    smoothingState,
  });

  expect(stabilized.target[0]).toBeGreaterThan(1);
  expect(stabilized.target[0]).toBeLessThan(4);
});
