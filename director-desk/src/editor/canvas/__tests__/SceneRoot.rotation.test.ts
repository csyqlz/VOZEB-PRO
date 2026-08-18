import { Vector3 } from "three";
import {
  getEffectiveGroundOpacity,
  getPanoramaRotationRadians,
  getViewportCameraBodyWireframeLines,
  getViewportCameraFrustumLines,
  getViewportCameraHitArea,
  getViewportCameraOpaqueDepthRange,
  getViewportCameraQuaternion,
} from "../SceneRoot";
import { VIEWPORT_CAMERA_VISUAL_SCALE } from "../../schema/cameraGeometry";

it("aligns the panorama front view to the image center by default", () => {
  expect(getPanoramaRotationRadians(0)).toBeCloseTo(Math.PI / 2);
});

it("keeps the user yaw adjustment on top of the default forward alignment", () => {
  expect(getPanoramaRotationRadians(30)).toBeCloseTo((120 * Math.PI) / 180);
});

it("softens the ground overlay when a panorama background is active", () => {
  expect(getEffectiveGroundOpacity(0.4, true)).toBeCloseTo(0.1);
  expect(getEffectiveGroundOpacity(0.08, true)).toBeCloseTo(0.08);
  expect(getEffectiveGroundOpacity(0.4, false)).toBeCloseTo(0.4);
});

it("orients the viewport camera model so its local positive z axis faces the shot target", () => {
  const cameraPosition: [number, number, number] = [0, 2.2, 9];
  const target: [number, number, number] = [0, 1.2, 0];
  const cameraForward = new Vector3(0, 0, 1).applyQuaternion(getViewportCameraQuaternion(cameraPosition, target));
  const targetDirection = new Vector3(...target).sub(new Vector3(...cameraPosition)).normalize();

  expect(cameraForward.dot(targetDirection)).toBeCloseTo(1);
});

it("keeps the viewport camera model upright while facing the shot target", () => {
  const cameraPosition: [number, number, number] = [0, 2.2, 9];
  const target: [number, number, number] = [0, 1.2, 0];
  const cameraUp = new Vector3(0, 1, 0).applyQuaternion(getViewportCameraQuaternion(cameraPosition, target));

  expect(cameraUp.dot(new Vector3(0, 1, 0))).toBeGreaterThan(0.9);
});

function getFrustumMetrics({
  fov = 50,
  target = [0, 1.2, 0],
}: {
  fov?: number;
  target?: [number, number, number];
}) {
  const lines = getViewportCameraFrustumLines({
    id: "cam_1",
    name: "机位01",
    fov,
    transform: {
      position: [0, 2.2, 9],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
    targetMode: "manual",
    target,
    lastCaptureUrl: null,
  });
  const points = lines.flat();

  return {
    maxDepth: Math.max(...points.map((point) => point[2])),
    maxHalfWidth: Math.max(...points.map((point) => Math.abs(point[0]))),
    maxHalfHeight: Math.max(...points.map((point) => Math.abs(point[1]))),
  };
}

function getUniquePoints(points: Array<[number, number, number]>) {
  return Array.from(new Map(points.map((point) => [point.join(","), point])).values());
}

it("uses a smaller fixed 16:9 front viewfinder with a longer depth", () => {
  const metrics = getFrustumMetrics({});

  expect(metrics.maxDepth).toBeCloseTo(5.2 * VIEWPORT_CAMERA_VISUAL_SCALE);
  expect(metrics.maxHalfWidth).toBeCloseTo(1.6 * VIEWPORT_CAMERA_VISUAL_SCALE);
  expect(metrics.maxHalfHeight).toBeCloseTo(0.9 * VIEWPORT_CAMERA_VISUAL_SCALE);
  expect(metrics.maxHalfWidth / metrics.maxHalfHeight).toBeCloseTo(16 / 9);
});

it("keeps the viewport camera viewfinder length fixed when the shot target distance changes", () => {
  const nearMetrics = getFrustumMetrics({ target: [0, 1.2, 5] });
  const defaultMetrics = getFrustumMetrics({ target: [0, 1.2, 0] });
  const farMetrics = getFrustumMetrics({ target: [0, 1.2, -9] });

  expect(defaultMetrics.maxDepth).toBeCloseTo(nearMetrics.maxDepth);
  expect(farMetrics.maxDepth).toBeCloseTo(defaultMetrics.maxDepth);
});

it("keeps the viewport camera viewfinder size fixed when fov changes", () => {
  const narrowMetrics = getFrustumMetrics({ fov: 35 });
  const wideMetrics = getFrustumMetrics({ fov: 75 });

  expect(wideMetrics.maxHalfWidth).toBeCloseTo(narrowMetrics.maxHalfWidth);
});

it("keeps the opaque viewport camera model behind the shot origin", () => {
  expect(getViewportCameraOpaqueDepthRange().maxZ).toBeLessThanOrEqual(0);
});

it("uses the current long rectangular camera body behind the shot origin", () => {
  const lines = getViewportCameraBodyWireframeLines();
  const points = lines.flatMap((line) => line.points);
  const bodyPoints = lines.filter((line) => line.part === "body").flatMap((line) => line.points);
  const width = Math.max(...points.map((point) => point[0])) - Math.min(...points.map((point) => point[0]));
  const height = Math.max(...points.map((point) => point[1])) - Math.min(...points.map((point) => point[1]));
  const bodyWidth = Math.max(...bodyPoints.map((point) => point[0])) - Math.min(...bodyPoints.map((point) => point[0]));
  const bodyHeight = Math.max(...bodyPoints.map((point) => point[1])) - Math.min(...bodyPoints.map((point) => point[1]));
  const bodyDepth = Math.max(...bodyPoints.map((point) => point[2])) - Math.min(...bodyPoints.map((point) => point[2]));
  const maxZ = Math.max(...points.map((point) => point[2]));
  const circularReels = lines.filter((line) => line.part === "reel" && line.points.length > 20);

  expect(lines.length).toBe(20);
  expect(bodyDepth / bodyWidth).toBeGreaterThan(2.4);
  expect(bodyWidth).toBeCloseTo(0.4 * VIEWPORT_CAMERA_VISUAL_SCALE);
  expect(bodyHeight).toBeCloseTo(0.4 * VIEWPORT_CAMERA_VISUAL_SCALE);
  expect(width).toBeGreaterThan(bodyWidth);
  expect(height).toBeCloseTo(0.85 * VIEWPORT_CAMERA_VISUAL_SCALE);
  expect(maxZ).toBeCloseTo(0.2 * VIEWPORT_CAMERA_VISUAL_SCALE);
  expect(circularReels).toHaveLength(2);
});

it("places the two camera reels as separated vertical disks along the long body", () => {
  const lines = getViewportCameraBodyWireframeLines();
  const reelLines = lines.filter((line) => line.part === "reel");
  const reelCenters = reelLines.map((line) => {
    const uniquePoints = line.points.slice(0, -1);
    const sum = uniquePoints.reduce(
      (acc, point) => [acc[0] + point[0], acc[1] + point[1], acc[2] + point[2]] as [number, number, number],
      [0, 0, 0] as [number, number, number]
    );

    return sum.map((value) => Number((value / uniquePoints.length).toFixed(6))) as [number, number, number];
  });
  const zSeparation = Math.abs(reelCenters[0][2] - reelCenters[1][2]);
  const reelXRange = Math.max(...reelLines.flatMap((line) => line.points.map((point) => point[0]))) -
    Math.min(...reelLines.flatMap((line) => line.points.map((point) => point[0])));

  expect(zSeparation).toBeCloseTo(0.44 * VIEWPORT_CAMERA_VISUAL_SCALE);
  reelCenters.forEach((center) => {
    expect(center[1]).toBeCloseTo(0.44 * VIEWPORT_CAMERA_VISUAL_SCALE);
  });
  expect(reelXRange).toBeLessThan(0.02);
});

it("draws the viewport camera lens as a deeper faceted front assembly facing the viewfinder", () => {
  const lines = getViewportCameraBodyWireframeLines();
  const bodyPoints = lines.filter((line) => line.part === "body").flatMap((line) => line.points);
  const lensLines = lines.filter((line) => line.part === "lens");
  const lensPoints = lensLines.flatMap((line) => line.points);
  const bodyMaxZ = Math.max(...bodyPoints.map((point) => point[2]));
  const bodyCenterX =
    (Math.min(...bodyPoints.map((point) => point[0])) + Math.max(...bodyPoints.map((point) => point[0]))) / 2;
  const bodyCenterY =
    (Math.min(...bodyPoints.map((point) => point[1])) + Math.max(...bodyPoints.map((point) => point[1]))) / 2;
  const lensMaxZ = Math.max(...lensPoints.map((point) => point[2]));
  const frontFramePoints = getUniquePoints(lensPoints.filter((point) => point[2] === lensMaxZ));
  const lensFrontCenter = frontFramePoints
    .reduce(
      (acc, point) => [acc[0] + point[0], acc[1] + point[1], acc[2] + point[2]] as [number, number, number],
      [0, 0, 0] as [number, number, number]
    )
    .map((value) => Number((value / frontFramePoints.length).toFixed(6))) as [number, number, number];
  const closedRings = lensLines.filter((line) => {
    const firstPoint = line.points[0];
    const lastPoint = line.points[line.points.length - 1];
    return (
      line.points.length === 5 &&
      firstPoint?.[0] === lastPoint?.[0] &&
      firstPoint?.[1] === lastPoint?.[1] &&
      firstPoint?.[2] === lastPoint?.[2]
    );
  });

  expect(lensLines.length).toBe(6);
  expect(closedRings).toHaveLength(2);
  expect(lensFrontCenter[2]).toBeGreaterThan(bodyMaxZ + 0.1 * VIEWPORT_CAMERA_VISUAL_SCALE);
  expect(lensFrontCenter[0]).toBeCloseTo(bodyCenterX);
  expect(lensFrontCenter[1]).toBeCloseTo(bodyCenterY);
});

it("starts the viewfinder lines from the centered front lens frame", () => {
  const bodyLines = getViewportCameraBodyWireframeLines();
  const lensPoints = bodyLines.filter((line) => line.part === "lens").flatMap((line) => line.points);
  const lensMaxZ = Math.max(...lensPoints.map((point) => point[2]));
  const frontFramePoints = getUniquePoints(lensPoints.filter((point) => point[2] === lensMaxZ));
  const lensFrontCenter = frontFramePoints
    .reduce(
      (acc, point) => [acc[0] + point[0], acc[1] + point[1], acc[2] + point[2]] as [number, number, number],
      [0, 0, 0] as [number, number, number]
    )
    .map((value) => Number((value / frontFramePoints.length).toFixed(6))) as [number, number, number];
  const frustumLines = getViewportCameraFrustumLines({
    id: "cam_1",
    name: "机位01",
    fov: 50,
    transform: {
      position: [0, 2.2, 9],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
    targetMode: "manual",
    target: [0, 1.2, 0],
    lastCaptureUrl: null,
  });

  frustumLines.slice(0, 4).forEach(([origin]) => {
    expect(origin[0]).toBeCloseTo(lensFrontCenter[0]);
    expect(origin[1]).toBeCloseTo(lensFrontCenter[1]);
    expect(origin[2]).toBeCloseTo(lensFrontCenter[2]);
  });
});

it("expands the invisible viewport camera hit area around the full line model", () => {
  const points = getViewportCameraBodyWireframeLines().flatMap((line) => line.points);
  const hitArea = getViewportCameraHitArea();
  const minX = Math.min(...points.map((point) => point[0]));
  const maxX = Math.max(...points.map((point) => point[0]));
  const minY = Math.min(...points.map((point) => point[1]));
  const maxY = Math.max(...points.map((point) => point[1]));
  const minZ = Math.min(...points.map((point) => point[2]));
  const maxZ = Math.max(...points.map((point) => point[2]));
  const [hitX, hitY, hitZ] = hitArea.position;
  const [hitWidth, hitHeight, hitDepth] = hitArea.args;

  expect(hitX - hitWidth / 2).toBeLessThanOrEqual(minX - 0.04);
  expect(hitX + hitWidth / 2).toBeGreaterThanOrEqual(maxX + 0.04);
  expect(hitY - hitHeight / 2).toBeLessThanOrEqual(minY - 0.04);
  expect(hitY + hitHeight / 2).toBeGreaterThanOrEqual(maxY + 0.04);
  expect(hitZ - hitDepth / 2).toBeLessThanOrEqual(minZ - 0.04);
  expect(hitZ + hitDepth / 2).toBeGreaterThanOrEqual(maxZ + 0.04);
});
