import type { CSSProperties } from "react";
import { Matrix4, PerspectiveCamera, Quaternion, Vector3 } from "three";
import type { CameraShotSnapshot } from "../store/directorStore";

const GIZMO_HIT_LAYER_CENTER = 40;
const GIZMO_AXIS_SCREEN_RADIUS = 25;
const GIZMO_AXIS_HIT_SIZE = 15;

export function toSnapshotTuple(vector: Vector3): [number, number, number] {
  return [vector.x, vector.y, vector.z].map((value) => Number(value.toFixed(6))) as [number, number, number];
}

export function shouldRenderViewportGrid(showGrid: boolean) {
  return showGrid;
}

export function getViewportSnapshotFromGizmoDirection(
  snapshot: CameraShotSnapshot,
  direction: Vector3
): CameraShotSnapshot {
  const target = new Vector3(...snapshot.target);
  const currentPosition = new Vector3(...snapshot.position);
  const radius = Math.max(currentPosition.distanceTo(target), 0.000001);
  const nextDirection = direction.lengthSq() === 0 ? new Vector3(0, 0, 1) : direction.clone().normalize();
  const nextPosition = target.clone().add(nextDirection.multiplyScalar(radius));

  return {
    fov: snapshot.fov,
    position: toSnapshotTuple(nextPosition),
    target: snapshot.target,
  };
}

export function getViewportGizmoHitButtonStyle(
  snapshot: CameraShotSnapshot,
  direction: [number, number, number]
): CSSProperties {
  const relativeCamera = new Vector3(...snapshot.position).sub(new Vector3(...snapshot.target));
  const camera = new PerspectiveCamera(snapshot.fov, 1);
  const safeCameraPosition = relativeCamera.lengthSq() === 0 ? new Vector3(0, 0, 1) : relativeCamera;
  camera.position.copy(safeCameraPosition);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  const gizmoQuaternion = new Quaternion().setFromRotationMatrix(new Matrix4().copy(camera.matrix).invert());
  const projectedDirection = new Vector3(...direction).applyQuaternion(gizmoQuaternion);
  const left = GIZMO_HIT_LAYER_CENTER + projectedDirection.x * GIZMO_AXIS_SCREEN_RADIUS - GIZMO_AXIS_HIT_SIZE / 2;
  const top = GIZMO_HIT_LAYER_CENTER - projectedDirection.y * GIZMO_AXIS_SCREEN_RADIUS - GIZMO_AXIS_HIT_SIZE / 2;

  return {
    left: `${Number(left.toFixed(3))}px`,
    top: `${Number(top.toFixed(3))}px`,
    zIndex: Math.round((projectedDirection.z + 1) * 100),
  };
}
