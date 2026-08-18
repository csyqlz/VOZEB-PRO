import { Color, Group, Mesh, MeshStandardMaterial, BoxGeometry } from "three";
import { describe, expect, it, vi } from "vitest";
import {
  disposeIsolatedModelMaterials,
  getModelTintColor,
  isolateAndTintModelMaterials,
} from "../modelMaterialTint";

describe("model material tint", () => {
  it("keeps the original material color when white means original color", () => {
    const original = new Color("#4b7cac");
    expect(getModelTintColor(original, new Color("#ffffff")).getHexString()).toBe("4b7cac");
  });

  it("changes hue while preserving light and dark material contrast", () => {
    const dark = getModelTintColor(new Color("#202020"), new Color("#e23b3b"));
    const light = getModelTintColor(new Color("#eeeeee"), new Color("#e23b3b"));
    expect(light.getHSL({ h: 0, s: 0, l: 0 }).l).toBeGreaterThan(dark.getHSL({ h: 0, s: 0, l: 0 }).l);
    expect(light.getHSL({ h: 0, s: 0, l: 0 }).h).toBeCloseTo(dark.getHSL({ h: 0, s: 0, l: 0 }).h, 5);
  });

  it("isolates shared materials before tinting and disposes only the clones", () => {
    const shared = new MeshStandardMaterial({ color: "#6699cc" });
    const firstRoot = new Group();
    const secondRoot = new Group();
    firstRoot.add(new Mesh(new BoxGeometry(), shared));
    secondRoot.add(new Mesh(new BoxGeometry(), shared));
    const dispose = vi.spyOn(shared, "dispose");

    isolateAndTintModelMaterials(firstRoot, "#ff0000");
    const firstMaterial = (firstRoot.children[0] as Mesh).material as MeshStandardMaterial;
    const secondMaterial = (secondRoot.children[0] as Mesh).material as MeshStandardMaterial;
    expect(firstMaterial).not.toBe(shared);
    expect(secondMaterial).toBe(shared);
    expect(firstMaterial.color.getHexString()).not.toBe(secondMaterial.color.getHexString());

    const cloneDispose = vi.spyOn(firstMaterial, "dispose");
    disposeIsolatedModelMaterials(firstRoot);
    expect(cloneDispose).toHaveBeenCalledOnce();
    expect(dispose).not.toHaveBeenCalled();
  });
});
