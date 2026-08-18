import {
  DEFAULT_DIRECTOR_VIEW_SNAPSHOT,
  getViewportGizmoHitButtonStyle,
  getViewportSnapshotFromGizmoDirection,
  shouldRenderViewportGrid,
} from "../DirectorCanvas";
import { createDefaultDirectorProject } from "../../store/directorStore";
import { getCameraViewSnapshotFromShot } from "../../schema/cameraGeometry";
import { Vector3 } from "three";

function expectTupleToBeCloseTo(
  received: [number, number, number],
  expected: [number, number, number]
) {
  received.forEach((value, index) => {
    expect(value).toBeCloseTo(expected[index], 5);
  });
}

it("shows the viewport grid when the independent display switch is enabled", () => {
  expect(shouldRenderViewportGrid(true)).toBe(true);
});

it("hides the viewport grid without changing snap behavior", () => {
  expect(shouldRenderViewportGrid(false)).toBe(false);
});

it("starts the director and default camera view from a centered front composition", () => {
  const defaultCamera = createDefaultDirectorProject().cameras[0];

  expect(DEFAULT_DIRECTOR_VIEW_SNAPSHOT).toEqual({
    fov: 50,
    position: [0, 1.55, 5.4],
    target: [0, 1.05, 0],
  });
  const defaultCameraView = getCameraViewSnapshotFromShot(defaultCamera);

  expect(defaultCameraView.fov).toBe(DEFAULT_DIRECTOR_VIEW_SNAPSHOT.fov);
  expectTupleToBeCloseTo(defaultCameraView.position, DEFAULT_DIRECTOR_VIEW_SNAPSHOT.position);
  expect(defaultCameraView.target).toEqual(DEFAULT_DIRECTOR_VIEW_SNAPSHOT.target);
  expect(defaultCamera.transform.position[0]).toBe(0);
  expect(defaultCamera.transform.position[1]).toBeGreaterThan(DEFAULT_DIRECTOR_VIEW_SNAPSHOT.target[1]);
  expect(defaultCamera.transform.position[2]).toBeGreaterThan(DEFAULT_DIRECTOR_VIEW_SNAPSHOT.position[2]);
});

it("keeps the current orbit distance when native gizmo axis clicks switch viewport direction", () => {
  const snapshot = getViewportSnapshotFromGizmoDirection(
    DEFAULT_DIRECTOR_VIEW_SNAPSHOT,
    new Vector3(1, 0, 0)
  );

  expect(snapshot.fov).toBe(DEFAULT_DIRECTOR_VIEW_SNAPSHOT.fov);
  expect(snapshot.target).toEqual(DEFAULT_DIRECTOR_VIEW_SNAPSHOT.target);
  expectTupleToBeCloseTo(snapshot.position, [5.423099, 1.05, 0]);
});

it("positions the transparent native gizmo hit target over the visible X axis head", () => {
  const style = getViewportGizmoHitButtonStyle(DEFAULT_DIRECTOR_VIEW_SNAPSHOT, [1, 0, 0]);
  const left = Number.parseFloat(String(style.left));
  const top = Number.parseFloat(String(style.top));

  expect(left).toBeGreaterThan(0);
  expect(left).toBeLessThan(100);
  expect(top).toBeGreaterThan(0);
  expect(top).toBeLessThan(100);
  expect(style.zIndex).toEqual(expect.any(Number));
});
