import { Color, MathUtils, type Material, type Object3D } from "three";

const ISOLATED_MATERIAL_KEY = "directorTintMaterialIsolated";
const ORIGINAL_COLOR_KEY = "directorTintOriginalColor";

type ColorMaterial = Material & { color: Color };
type MaterialObject = Object3D & { material: Material | Material[] };

function hasMaterial(object: Object3D): object is MaterialObject {
  return "material" in object && Boolean((object as Partial<MaterialObject>).material);
}

function hasColor(material: Material): material is ColorMaterial {
  return "color" in material && (material as Partial<ColorMaterial>).color instanceof Color;
}

function cloneMaterial(material: Material) {
  const clone = material.clone();
  if (hasColor(material)) clone.userData[ORIGINAL_COLOR_KEY] = material.color.getHexString();
  return clone;
}

export function getModelTintColor(original: Color, tint: Color) {
  if (tint.getHex() === 0xffffff) return original.clone();
  const originalHsl = { h: 0, s: 0, l: 0 };
  const tintHsl = { h: 0, s: 0, l: 0 };
  original.getHSL(originalHsl);
  tint.getHSL(tintHsl);
  return new Color().setHSL(
    tintHsl.h,
    Math.max(0.08, tintHsl.s),
    MathUtils.clamp(tintHsl.l * (0.55 + originalHsl.l * 0.9), 0.03, 0.95),
  );
}

export function isolateAndTintModelMaterials(root: Object3D, color?: string) {
  const tint = color ? new Color(color) : null;
  root.traverse((object) => {
    if (!hasMaterial(object)) return;
    if (!object.userData[ISOLATED_MATERIAL_KEY]) {
      object.material = Array.isArray(object.material)
        ? object.material.map(cloneMaterial)
        : cloneMaterial(object.material);
      object.userData[ISOLATED_MATERIAL_KEY] = true;
    }
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach((material) => {
      if (!hasColor(material)) return;
      const originalHex = typeof material.userData[ORIGINAL_COLOR_KEY] === "string"
        ? material.userData[ORIGINAL_COLOR_KEY]
        : material.color.getHexString();
      material.color.copy(tint ? getModelTintColor(new Color(`#${originalHex}`), tint) : new Color(`#${originalHex}`));
      material.needsUpdate = true;
    });
  });
}

export function disposeIsolatedModelMaterials(root: Object3D) {
  root.traverse((object) => {
    if (!hasMaterial(object) || !object.userData[ISOLATED_MATERIAL_KEY]) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach((material) => material.dispose());
  });
}
