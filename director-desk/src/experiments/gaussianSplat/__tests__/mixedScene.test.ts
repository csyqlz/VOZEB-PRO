import { expect, it } from "vitest";
import { Vector3 } from "three";
import {
  createExperimentCameraRig,
  createExperimentCharacter,
  createExperimentProp,
  createProxyBoxMesh,
} from "../mixedScene";

it("creates a visible character, prop, and camera helper in the same Three.js coordinate system", () => {
  expect(createExperimentCharacter().children.length).toBeGreaterThanOrEqual(6);
  expect(createExperimentProp().children.length).toBe(2);
  expect(createExperimentCameraRig().children).toHaveLength(2);
});

it("stores proxy dimensions with the visible collision box", () => {
  const proxy = createProxyBoxMesh(new Vector3(1, 2, 3), new Vector3(2, 4, 6));
  expect(proxy.position.toArray()).toEqual([1, 2, 3]);
  expect(proxy.userData.proxySize).toEqual([2, 4, 6]);
});
