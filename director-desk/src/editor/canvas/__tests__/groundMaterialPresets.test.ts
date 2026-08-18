import { afterEach, describe, expect, it, vi } from "vitest";
import { RepeatWrapping, SRGBColorSpace } from "three";
import {
  GROUND_MATERIAL_PRESETS,
  GROUND_PLANE_SIZE,
  createGroundMaterialTexture,
  getGroundMaterialPreset,
  getGroundTextureRepeat,
} from "../groundMaterialPresets";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ground material presets", () => {
  it("defines the five material configurations", () => {
    expect(GROUND_MATERIAL_PRESETS.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "studio", label: "摄影棚" },
      { id: "concrete", label: "混凝土" },
      { id: "asphalt", label: "柏油" },
      { id: "wood", label: "木地板" },
      { id: "grass", label: "草地" },
    ]);

    for (const preset of GROUND_MATERIAL_PRESETS) {
      expect(preset.baseColor).toMatch(/^#[0-9a-f]{6}$/i);
      expect(preset.roughness).toBeGreaterThanOrEqual(0);
      expect(preset.roughness).toBeLessThanOrEqual(1);
      expect(preset.metalness).toBeGreaterThanOrEqual(0);
      expect(preset.metalness).toBeLessThanOrEqual(1);
      expect(preset.textureType).toBeTruthy();
      expect(preset.tileWorldSize[0]).toBeGreaterThan(0);
      expect(preset.tileWorldSize[1]).toBeGreaterThan(0);
      expect(preset.textureSize).toBe(256);
    }
  });

  it("falls back to the studio preset for unknown values", () => {
    expect(getGroundMaterialPreset("unknown")).toBe(getGroundMaterialPreset("studio"));
    expect(getGroundMaterialPreset(null).id).toBe("studio");
    expect(getGroundMaterialPreset(undefined).id).toBe("studio");
  });

  it("keeps texture scale stable when the ground size changes", () => {
    expect(getGroundTextureRepeat("wood", GROUND_PLANE_SIZE)).toEqual([40, 40]);
    expect(getGroundTextureRepeat("wood", 100)).toEqual([20, 20]);
    expect(getGroundTextureRepeat("concrete", GROUND_PLANE_SIZE)).toEqual([50, 50]);
  });

  it("lets users enlarge or shrink the visible ground texture tiles", () => {
    expect(getGroundTextureRepeat("wood", GROUND_PLANE_SIZE, 2)).toEqual([20, 20]);
    expect(getGroundTextureRepeat("wood", GROUND_PLANE_SIZE, 0.5)).toEqual([80, 80]);
    expect(getGroundTextureRepeat("wood", GROUND_PLANE_SIZE, Number.NaN)).toEqual([40, 40]);
  });

  it("keeps visible material details smaller than a person", () => {
    for (const preset of GROUND_MATERIAL_PRESETS) {
      expect(Math.max(...preset.tileWorldSize)).toBeLessThanOrEqual(8);
    }
    const wood = getGroundMaterialPreset("wood");
    expect(wood.tileWorldSize[1] / 8).toBeLessThan(1);
  });

  it("returns null when the DOM is unavailable", () => {
    vi.stubGlobal("document", undefined);

    expect(createGroundMaterialTexture("concrete")).toBeNull();
  });

  it("returns null when a 2D canvas context is unavailable", () => {
    vi.spyOn(document, "createElement").mockReturnValue({
      width: 0,
      height: 0,
      getContext: () => null,
    } as unknown as HTMLCanvasElement);

    expect(createGroundMaterialTexture("asphalt")).toBeNull();
  });

  it("creates deterministic, repeating sRGB canvas textures", () => {
    const operations: string[][] = [];

    vi.spyOn(document, "createElement").mockImplementation(() => {
      const currentOperations: string[] = [];
      operations.push(currentOperations);

      const context = new Proxy<Record<string, unknown>>({}, {
        set(target, property, value) {
          currentOperations.push(`${String(property)}:${String(value)}`);
          target[property as string] = value;
          return true;
        },
        get(target, property) {
          if (property in target) return target[property as string];
          return (...args: unknown[]) => {
            currentOperations.push(`${String(property)}:${args.join(",")}`);
          };
        },
      });

      return {
        width: 0,
        height: 0,
        getContext: () => context,
      } as unknown as HTMLCanvasElement;
    });

    const first = createGroundMaterialTexture("wood", GROUND_PLANE_SIZE, 2);
    const second = createGroundMaterialTexture("wood");
    const preset = getGroundMaterialPreset("wood");

    expect(first).not.toBeNull();
    expect(first?.name).toBe("ground-material-wood");
    expect(first?.wrapS).toBe(RepeatWrapping);
    expect(first?.wrapT).toBe(RepeatWrapping);
    expect(first?.colorSpace).toBe(SRGBColorSpace);
    expect(first?.repeat.toArray()).toEqual(getGroundTextureRepeat(preset.id, GROUND_PLANE_SIZE, 2));
    expect((first?.image as HTMLCanvasElement).width).toBe(preset.textureSize);
    expect((first?.image as HTMLCanvasElement).height).toBe(preset.textureSize);
    expect(operations[0]).toEqual(operations[1]);

    first?.dispose();
    second?.dispose();
  });
});
