import { Vector3, type Object3D } from "three";
import type { CameraMotionSnapshot } from "../schema/cameraMotion";
import { getCameraMotionPath } from "../schema/cameraMotion";
import { getCameraPlaybackSnapshot } from "../schema/cameraPlayback";
import { getAnimatedCameraFocusSample } from "../schema/cameraTarget";
import type { DirectorCameraShot, DirectorObject, SceneSettings } from "../schema/directorProject";
import { getSceneSemanticBodyPartTarget } from "./semanticBodyTracking";

export interface CameraTrackingSmoothingState {
  cameraId: string | null;
  initialized: boolean;
  lastProgress: number;
  target: Vector3;
}

export function createCameraTrackingSmoothingState(): CameraTrackingSmoothingState {
  return {
    cameraId: null,
    initialized: false,
    lastProgress: 0,
    target: new Vector3(),
  };
}

function resolveSceneObjectFocus(scene: Object3D) {
  return (object: DirectorObject, bodyPart: Parameters<typeof getSceneSemanticBodyPartTarget>[2]) =>
    getSceneSemanticBodyPartTarget(scene, object.id, bodyPart);
}

export function getRuntimeCameraPlaybackSnapshot({
  camera,
  objects,
  progress,
  scene,
  sceneSettings,
  smoothingState,
}: {
  camera: DirectorCameraShot;
  objects: DirectorObject[];
  progress: number;
  scene: Object3D;
  sceneSettings?: SceneSettings;
  smoothingState: CameraTrackingSmoothingState;
}): CameraMotionSnapshot {
  const resolveObjectFocus = resolveSceneObjectFocus(scene);
  const snapshot = getCameraPlaybackSnapshot(
    camera,
    objects,
    progress,
    sceneSettings,
    resolveObjectFocus
  );
  const tracking = getAnimatedCameraFocusSample(camera, objects, progress, resolveObjectFocus);
  const rawTarget = new Vector3(...snapshot.target);
  const pathDuration = getCameraMotionPath(camera).duration;
  const progressDelta = progress - smoothingState.lastProgress;
  const timelineDeltaSeconds = Math.max(0, progressDelta * pathDuration);
  const jumped = progressDelta < -0.0001 || progressDelta > 0.08;
  const sameFrameTargetChanged = Math.abs(progressDelta) <= 0.000001
    && smoothingState.target.distanceToSquared(rawTarget) > 0.00000001;
  const shouldSmooth = Boolean(
    tracking && (tracking.followMode === "smooth" || tracking.stabilizationEnabled)
  );

  if (
    !tracking
    || !shouldSmooth
    || !smoothingState.initialized
    || smoothingState.cameraId !== camera.id
    || jumped
    || sameFrameTargetChanged
  ) {
    smoothingState.target.copy(rawTarget);
    smoothingState.initialized = true;
  } else if (timelineDeltaSeconds > 0) {
    const response = tracking.stabilizationEnabled ? 2.4 : 6;
    const alpha = 1 - Math.exp(-response * timelineDeltaSeconds);
    smoothingState.target.lerp(rawTarget, alpha);
  }

  smoothingState.cameraId = camera.id;
  smoothingState.lastProgress = progress;

  return shouldSmooth
    ? {
        ...snapshot,
        target: [
          smoothingState.target.x,
          smoothingState.target.y,
          smoothingState.target.z,
        ],
      }
    : snapshot;
}
