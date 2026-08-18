import type { CameraMotionSnapshot } from "./cameraMotion";
import { getCameraMotionPath, getCameraMotionSnapshot } from "./cameraMotion";
import { getAnimatedCameraFocusTarget, type CameraObjectFocusResolver } from "./cameraTarget";
import type { DirectorCameraShot, DirectorObject, SceneSettings } from "./directorProject";
import { getCameraViewSnapshotFromShot } from "./cameraGeometry";
import { constrainCameraPosition, constrainObjectMotionTransform } from "./pathCollision";
import { getObjectMotionSnapshot } from "./objectMotion";

export function getCameraPlaybackSnapshot(
  camera: DirectorCameraShot,
  objects: DirectorObject[],
  progress: number,
  scene?: SceneSettings,
  resolveObjectFocus?: CameraObjectFocusResolver
): CameraMotionSnapshot {
  const motionPath = getCameraMotionPath(camera);
  const base = motionPath.keyframes.length >= 2
    ? getCameraMotionSnapshot(camera, progress)
    : getCameraViewSnapshotFromShot(camera);
  const constrainedObjects = scene?.pathCollisionEnabled
    ? objects.map((object) => ({
        ...object,
        transform: constrainObjectMotionTransform(
          object,
          getObjectMotionSnapshot(object, progress, motionPath.duration),
          scene,
          objects,
        ),
      }))
    : objects;
  const trackingTarget = getAnimatedCameraFocusTarget(camera, constrainedObjects, progress, resolveObjectFocus);
  const position = scene ? constrainCameraPosition(base.position, scene, objects) : base.position;

  return trackingTarget ? { ...base, position, target: trackingTarget } : { ...base, position };
}
