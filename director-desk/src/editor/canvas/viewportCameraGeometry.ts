import { Box3, Matrix4, Quaternion, Vector3 } from "three";
import { VIEWPORT_CAMERA_VISUAL_SCALE } from "../schema/cameraGeometry";
import { VIEWPORT_OBJECT_LABEL_VERTICAL_GAP } from "../schema/viewportLabels";

const VIEWPORT_CAMERA_HIT_PADDING = 0.06;
export const VIEWPORT_CAMERA_FORWARD = new Vector3(0, 0, 1);
const VIEWPORT_CAMERA_WORLD_UP = new Vector3(0, 1, 0);
const VIEWPORT_CAMERA_BODY_CENTER: CameraWirePoint = [0, 0, -0.52 * VIEWPORT_CAMERA_VISUAL_SCALE];
const VIEWPORT_CAMERA_BODY_SIZE: CameraWirePoint = [
  0.4 * VIEWPORT_CAMERA_VISUAL_SCALE,
  0.4 * VIEWPORT_CAMERA_VISUAL_SCALE,
  1 * VIEWPORT_CAMERA_VISUAL_SCALE,
];
const VIEWPORT_CAMERA_BODY_FRONT_Z = VIEWPORT_CAMERA_BODY_CENTER[2] + VIEWPORT_CAMERA_BODY_SIZE[2] / 2;
export const VIEWPORT_CAMERA_LENS_TIP: CameraWirePoint = [0, 0, 0.2 * VIEWPORT_CAMERA_VISUAL_SCALE];
const IMPORTED_MODEL_TARGET_MAX_SIZE = 2;
type CameraWirePoint = [number, number, number];
type CameraWirePointLine = CameraWirePoint[];
type CameraWirePart = "body" | "lens" | "reel";
type CameraWireLine = {
  part: CameraWirePart;
  points: CameraWirePointLine;
};
type CameraHitArea = {
  args: CameraWirePoint;
  position: CameraWirePoint;
};

export function getViewportCameraQuaternion(
  position: [number, number, number],
  target: [number, number, number]
) {
  const origin = new Vector3(...position);
  const direction = new Vector3(...target).sub(origin);
  if (direction.lengthSq() === 0) return new Quaternion();

  const forward = direction.normalize();
  const up =
    Math.abs(forward.dot(VIEWPORT_CAMERA_WORLD_UP)) > 0.999
      ? new Vector3(0, 0, 1)
      : VIEWPORT_CAMERA_WORLD_UP;
  const matrix = new Matrix4().lookAt(origin, origin.clone().sub(forward), up);

  return new Quaternion().setFromRotationMatrix(matrix);
}
export function getViewportCameraOpaqueDepthRange() {
  const zValues = getViewportCameraBodyWireframeLines()
    .filter((line) => line.part !== "lens")
    .flatMap((line) => line.points)
    .map((point) => point[2]);

  return {
    minZ: Math.min(...zValues),
    maxZ: Math.max(...zValues),
  };
}
export function getViewportCameraLabelY() {
  const points = getViewportCameraBodyWireframeLines().flatMap((line) => line.points);
  const modelTopY = Math.max(...points.map((point) => point[1]));

  return modelTopY + VIEWPORT_OBJECT_LABEL_VERTICAL_GAP;
}

export function getImportedModelNormalization(bounds: Box3, targetMaxSize = IMPORTED_MODEL_TARGET_MAX_SIZE) {
  if (bounds.isEmpty()) {
    return {
      position: [0, 0, 0] as [number, number, number],
      scale: 1,
    };
  }

  const size = new Vector3();
  const center = new Vector3();
  bounds.getSize(size);
  bounds.getCenter(center);

  const maxSize = Math.max(size.x, size.y, size.z);
  const scale = Number.isFinite(maxSize) && maxSize > 0 ? targetMaxSize / maxSize : 1;

  return {
    position: [-center.x * scale, -bounds.min.y * scale, -center.z * scale] as [number, number, number],
    scale,
  };
}

function createBoxWireframeLines({
  center,
  size,
}: {
  center: CameraWirePoint;
  size: CameraWirePoint;
}): CameraWirePointLine[] {
  const [cx, cy, cz] = center;
  const [width, height, depth] = size;
  const x0 = cx - width / 2;
  const x1 = cx + width / 2;
  const y0 = cy - height / 2;
  const y1 = cy + height / 2;
  const z0 = cz - depth / 2;
  const z1 = cz + depth / 2;
  const corners: Record<string, CameraWirePoint> = {
    bbl: [x0, y0, z0],
    bbr: [x1, y0, z0],
    btl: [x0, y1, z0],
    btr: [x1, y1, z0],
    fbl: [x0, y0, z1],
    fbr: [x1, y0, z1],
    ftl: [x0, y1, z1],
    ftr: [x1, y1, z1],
  };

  return [
    [corners.bbl, corners.bbr],
    [corners.bbr, corners.btr],
    [corners.btr, corners.btl],
    [corners.btl, corners.bbl],
    [corners.fbl, corners.fbr],
    [corners.fbr, corners.ftr],
    [corners.ftr, corners.ftl],
    [corners.ftl, corners.fbl],
    [corners.bbl, corners.fbl],
    [corners.bbr, corners.fbr],
    [corners.btr, corners.ftr],
    [corners.btl, corners.ftl],
  ];
}

function createCircleWireframeLine({
  center,
  radius,
  segments = 32,
  plane = "xy",
}: {
  center: CameraWirePoint;
  radius: number;
  segments?: number;
  plane?: "xy" | "xz" | "yz";
}): CameraWirePointLine {
  const [cx, cy, cz] = center;
  return Array.from({ length: segments + 1 }, (_, index) => {
    const angle = (Math.PI * 2 * index) / segments;
    const a = Math.cos(angle) * radius;
    const b = Math.sin(angle) * radius;

    if (plane === "xz") return [cx + a, cy, cz + b];
    if (plane === "yz") return [cx, cy + a, cz + b];

    return [cx + a, cy + b, cz];
  });
}

function createInvertedTetrahedronLensWireframeLines(): CameraWirePointLine[] {
  const backTopLeft: CameraWirePoint = [
    -0.10 * VIEWPORT_CAMERA_VISUAL_SCALE,
    0.10 * VIEWPORT_CAMERA_VISUAL_SCALE,
    VIEWPORT_CAMERA_BODY_FRONT_Z,
  ];
  const backTopRight: CameraWirePoint = [
    0.10 * VIEWPORT_CAMERA_VISUAL_SCALE,
    0.10 * VIEWPORT_CAMERA_VISUAL_SCALE,
    VIEWPORT_CAMERA_BODY_FRONT_Z,
  ];
  const backBottomRight: CameraWirePoint = [
    0.10 * VIEWPORT_CAMERA_VISUAL_SCALE,
    -0.10 * VIEWPORT_CAMERA_VISUAL_SCALE,
    VIEWPORT_CAMERA_BODY_FRONT_Z,
  ];
  const backBottomLeft: CameraWirePoint = [
    -0.10 * VIEWPORT_CAMERA_VISUAL_SCALE,
    -0.10 * VIEWPORT_CAMERA_VISUAL_SCALE,
    VIEWPORT_CAMERA_BODY_FRONT_Z,
  ];

  const frontTopLeft: CameraWirePoint = [
    -0.25 * VIEWPORT_CAMERA_VISUAL_SCALE,
    0.2 * VIEWPORT_CAMERA_VISUAL_SCALE,
    VIEWPORT_CAMERA_LENS_TIP[2],
  ];
  const frontTopRight: CameraWirePoint = [
    0.25 * VIEWPORT_CAMERA_VISUAL_SCALE,
    0.2 * VIEWPORT_CAMERA_VISUAL_SCALE,
    VIEWPORT_CAMERA_LENS_TIP[2],
  ];
  const frontBottomRight: CameraWirePoint = [
    0.25 * VIEWPORT_CAMERA_VISUAL_SCALE,
    -0.2 * VIEWPORT_CAMERA_VISUAL_SCALE,
    VIEWPORT_CAMERA_LENS_TIP[2],
  ];
  const frontBottomLeft: CameraWirePoint = [
    -0.25 * VIEWPORT_CAMERA_VISUAL_SCALE,
    -0.2 * VIEWPORT_CAMERA_VISUAL_SCALE,
    VIEWPORT_CAMERA_LENS_TIP[2],
  ];

  return [
    [backTopLeft, backTopRight, backBottomRight, backBottomLeft, backTopLeft],
    [frontTopLeft, frontTopRight, frontBottomRight, frontBottomLeft, frontTopLeft],

    [backTopLeft, frontTopLeft],
    [backTopRight, frontTopRight],
    [backBottomRight, frontBottomRight],
    [backBottomLeft, frontBottomLeft],

  ];
}
function withCameraPart(part: CameraWirePart, lines: CameraWirePointLine[]): CameraWireLine[] {
  return lines.map((points) => ({ part, points }));
}

export function getViewportCameraBodyWireframeLines(): CameraWireLine[] {
  return [
    ...withCameraPart("body", [
      ...createBoxWireframeLines({ center: VIEWPORT_CAMERA_BODY_CENTER, size: VIEWPORT_CAMERA_BODY_SIZE }),
    ]),
    ...withCameraPart("lens", createInvertedTetrahedronLensWireframeLines()),
    ...withCameraPart("reel", [
      createCircleWireframeLine({
        center: [0, 0.44 * VIEWPORT_CAMERA_VISUAL_SCALE, -0.78 * VIEWPORT_CAMERA_VISUAL_SCALE],
        radius: 0.21 * VIEWPORT_CAMERA_VISUAL_SCALE,
        plane: "yz",
      }),
      createCircleWireframeLine({
        center: [0, 0.44 * VIEWPORT_CAMERA_VISUAL_SCALE, -0.34 * VIEWPORT_CAMERA_VISUAL_SCALE],
        radius: 0.21 * VIEWPORT_CAMERA_VISUAL_SCALE,
        plane: "yz",
      }),
    ]),
  ];
}

export function getViewportCameraHitArea(): CameraHitArea {
  const points = getViewportCameraBodyWireframeLines().flatMap((line) => line.points);
  const minX = Math.min(...points.map((point) => point[0]));
  const maxX = Math.max(...points.map((point) => point[0]));
  const minY = Math.min(...points.map((point) => point[1]));
  const maxY = Math.max(...points.map((point) => point[1]));
  const minZ = Math.min(...points.map((point) => point[2]));
  const maxZ = Math.max(...points.map((point) => point[2]));

  return {
    args: [
      maxX - minX + VIEWPORT_CAMERA_HIT_PADDING * 2,
      maxY - minY + VIEWPORT_CAMERA_HIT_PADDING * 2,
      maxZ - minZ + VIEWPORT_CAMERA_HIT_PADDING * 2,
    ],
    position: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
  };
}
