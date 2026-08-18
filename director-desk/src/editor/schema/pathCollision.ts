import type { DirectorObject, DirectorTransform, SceneSettings } from "./directorProject";

type Bounds = {
  min: [number, number, number];
  max: [number, number, number];
};

const CHARACTER_CLEARANCE = 0.32;
const CAMERA_CLEARANCE = 0.18;

function getObstacleBounds(object: DirectorObject): Bounds {
  const [x, y, z] = object.transform.position;
  const [sx, sy, sz] = object.transform.scale.map((value) => Math.max(0.05, Math.abs(value))) as [number, number, number];
  const halfX = sx * 0.55;
  const halfZ = sz * 0.55;
  const height = sy * (object.geometryType === "sphere" ? 1 : 1.2);
  return {
    min: [x - halfX, y, z - halfZ],
    max: [x + halfX, y + height, z + halfZ],
  };
}

function getObstacles(objects: DirectorObject[]) {
  return objects.filter((object) =>
    object.visible && !object.motionPath?.keyframes.length && (object.kind === "prop" || object.kind === "scene")
  );
}

function pushOutside2D(position: [number, number, number], bounds: Bounds, clearance: number) {
  const minX = bounds.min[0] - clearance;
  const maxX = bounds.max[0] + clearance;
  const minZ = bounds.min[2] - clearance;
  const maxZ = bounds.max[2] + clearance;
  if (position[0] <= minX || position[0] >= maxX || position[2] <= minZ || position[2] >= maxZ) return position;

  const exits = [
    { axis: 0 as const, value: minX, distance: position[0] - minX },
    { axis: 0 as const, value: maxX, distance: maxX - position[0] },
    { axis: 2 as const, value: minZ, distance: position[2] - minZ },
    { axis: 2 as const, value: maxZ, distance: maxZ - position[2] },
  ].sort((left, right) => left.distance - right.distance);
  const next = [...position] as [number, number, number];
  next[exits[0].axis] = exits[0].value;
  return next;
}

function pushOutside3D(position: [number, number, number], bounds: Bounds, clearance: number, floorY: number) {
  const min = bounds.min.map((value) => value - clearance) as [number, number, number];
  const max = bounds.max.map((value) => value + clearance) as [number, number, number];
  if (position.some((value, axis) => value <= min[axis] || value >= max[axis])) return position;

  const exits = ([0, 1, 2] as const).flatMap((axis) => [
    { axis, value: min[axis], distance: position[axis] - min[axis] },
    { axis, value: max[axis], distance: max[axis] - position[axis] },
  ]).filter((exit) => exit.axis !== 1 || exit.value >= floorY)
    .sort((left, right) => left.distance - right.distance);
  const next = [...position] as [number, number, number];
  next[exits[0].axis] = exits[0].value;
  return next;
}

export function constrainObjectMotionTransform(
  object: DirectorObject,
  transform: DirectorTransform,
  scene: SceneSettings,
  objects: DirectorObject[]
): DirectorTransform {
  if (!scene.pathCollisionEnabled) return transform;
  let position = [...transform.position] as [number, number, number];
  if (object.kind === "character") position[1] = scene.groundHeight;
  for (const obstacle of getObstacles(objects).filter((item) => item.id !== object.id)) {
    position = pushOutside2D(position, getObstacleBounds(obstacle), CHARACTER_CLEARANCE);
  }
  return { ...transform, position };
}

export function constrainCameraPosition(
  position: [number, number, number],
  scene: SceneSettings,
  objects: DirectorObject[]
) {
  if (!scene.pathCollisionEnabled) return position;
  const floorY = scene.groundHeight + CAMERA_CLEARANCE;
  let next: [number, number, number] = [position[0], Math.max(position[1], floorY), position[2]];
  for (const obstacle of getObstacles(objects)) {
    next = pushOutside3D(next, getObstacleBounds(obstacle), CAMERA_CLEARANCE, floorY);
  }
  return next;
}
