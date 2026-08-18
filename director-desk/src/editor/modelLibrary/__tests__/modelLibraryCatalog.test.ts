import { expect, it } from "vitest";
import {
  getModelLibraryCharacterStatus,
  getModelLibraryItems,
  LOCAL_GUO_ASSETS_AVAILABLE,
  LOCAL_MIXAMO_CHARACTER_AVAILABLE,
} from "../modelLibraryCatalog";

it("labels character compatibility before a model is added", () => {
  const items = getModelLibraryItems();
  if (!LOCAL_GUO_ASSETS_AVAILABLE) return;
  expect(getModelLibraryCharacterStatus(items.find((item) => item.name === "健壮男性")!)).toBe("可用动作");
  expect(getModelLibraryCharacterStatus(items.find((item) => item.name === "马")!)).toBe("需骨架映射");
  expect(getModelLibraryCharacterStatus(items.find((item) => item.name === "女性美人鱼")!)).toBe("需骨架映射");
  expect(getModelLibraryCharacterStatus(items.find((item) => item.name === "家用轿车")!)).toBeNull();
});

it("ships a useful built-in everyday model collection without external files", () => {
  const items = getModelLibraryItems();
  const names = items.map((item) => item.name);

  expect(names).toEqual(expect.arrayContaining([
    "家用轿车",
    "城市SUV",
    "城市公交车",
    "自行车",
    "电动踏板车",
    "沙发",
    "餐桌",
    "冰箱",
    "洗衣机",
    "路灯",
    "绿化树",
    "分类垃圾桶",
  ]));
  expect(items.filter((item) => item.url.startsWith("builtin://life/"))).toHaveLength(18);
  expect(items.find((item) => item.name === "家用轿车")).toMatchObject({
    categoryId: "outdoor",
    fileName: "sedan_low.fbx",
  });
  expect(items.find((item) => item.name === "家用轿车")?.thumbUrl).toMatch(/^data:image\/svg\+xml/);
});

it("indexes the locally installed character and prop libraries", () => {
  const items = getModelLibraryItems();

  if (LOCAL_GUO_ASSETS_AVAILABLE) {
    expect(items.filter((item) => item.id.startsWith("guo-character:"))).toHaveLength(37);
    expect(items.filter((item) => item.id.startsWith("guo-prop:"))).toHaveLength(180);
    expect(items.find((item) => item.id.startsWith("guo-character:"))).toMatchObject({
      categoryId: "characters",
    });
    expect(items.find((item) => item.id === "guo-character:guo-skeleton-0040-muscular-male")).toMatchObject({
      characterRigProfile: "mixamo",
      characterImportReadiness: "ready",
      characterOrientationCorrection: [0, 0, 0],
    });
    expect(items.find((item) => item.id === "guo-character:guo-skeleton-0033-horse")).toMatchObject({
      characterRigProfile: "unknown",
      characterImportReadiness: "manual-mapping",
    });
  } else {
    expect(items.some((item) => item.id.startsWith("guo-character:"))).toBe(false);
    expect(items.some((item) => item.id.startsWith("guo-prop:"))).toBe(false);
  }

  expect(items.some((item) => item.id === "mixamo-character:camille"))
    .toBe(LOCAL_MIXAMO_CHARACTER_AVAILABLE);
  if (LOCAL_MIXAMO_CHARACTER_AVAILABLE) {
    expect(items.filter((item) => item.id.startsWith("mixamo-character:"))).toHaveLength(1);
    expect(items.some((item) => item.id === "rigged-character:robot-expressive")).toBe(true);
    expect(items.map((item) => item.name)).toEqual(expect.arrayContaining([
      "Camille（Mixamo）",
      "表情机器人（自带动作）",
    ]));
  }
});
