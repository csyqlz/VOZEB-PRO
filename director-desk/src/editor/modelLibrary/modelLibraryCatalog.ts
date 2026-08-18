import guoCharactersManifest from "./guoCharactersManifest.json";
import guoPropsManifest from "./guoPropsManifest.json";
import type { CharacterImportReadiness, CharacterRigProfile } from "../schema/directorProject";
import { getGuoCharacterCompatibility } from "./guoCharacterCompatibility";

export const LOCAL_GUO_ASSETS_AVAILABLE = __LOCAL_GUO_ASSETS_AVAILABLE__;
export const LOCAL_MIXAMO_CHARACTER_AVAILABLE = __LOCAL_MIXAMO_CHARACTER_AVAILABLE__;

export type ModelLibraryCategoryId = "characters" | "convenience" | "home" | "outdoor" | "tools" | "weapons" | "my-models";

export type ModelLibraryCategory = {
  directoryName: string;
  id: ModelLibraryCategoryId;
  label: string;
};

export type ModelLibraryItem = {
  categoryId: ModelLibraryCategoryId;
  fileName: string;
  id: string;
  name: string;
  thumbUrl?: string;
  url: string;
  kind?: "character" | "prop";
  characterRigProfile?: CharacterRigProfile;
  characterImportReadiness?: CharacterImportReadiness;
  characterOrientationCorrection?: [number, number, number];
};

export function getModelLibraryCharacterStatus(item: ModelLibraryItem) {
  if (item.kind !== "character") return null;
  if (item.characterImportReadiness === "ready") return "可用动作";
  if (item.characterImportReadiness === "native-only") return "仅自带动作";
  if (item.characterImportReadiness === "manual-mapping") return "需骨架映射";
  if (item.characterImportReadiness === "static-only") return "仅静态";
  return "未体检";
}

export const MODEL_LIBRARY_CATEGORIES: ModelLibraryCategory[] = [
  ...(LOCAL_GUO_ASSETS_AVAILABLE || LOCAL_MIXAMO_CHARACTER_AVAILABLE
    ? [{ id: "characters" as const, label: "人物", directoryName: "人物" }]
    : []),
  { id: "convenience", label: "便利生活", directoryName: "便利生活" },
  { id: "home", label: "居家生活", directoryName: "生活家居" },
  { id: "outdoor", label: "户外出行", directoryName: "户外出行" },
  { id: "tools", label: "工具配件", directoryName: "工具配件" },
  ...(LOCAL_GUO_ASSETS_AVAILABLE ? [{ id: "weapons" as const, label: "武器", directoryName: "武器" }] : []),
  { id: "my-models", label: "我的模型", directoryName: "" },
];

function createBuiltInThumbnail(name: string, categoryId: ModelLibraryCategoryId) {
  const colors: Record<ModelLibraryCategoryId, [string, string]> = {
    characters: ["#38506b", "#8cc7eb"],
    convenience: ["#295b78", "#59b7da"],
    home: ["#6d4d3d", "#d49a6a"],
    outdoor: ["#315c49", "#72bd83"],
    tools: ["#62522f", "#d1aa50"],
    weapons: ["#5c3b40", "#d08a92"],
    "my-models": ["#4d5561", "#98a2b3"],
  };
  const [background, accent] = colors[categoryId];
  const label = name.slice(0, 2);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="192" height="128" viewBox="0 0 192 128"><rect width="192" height="128" rx="8" fill="${background}"/><path d="M24 91h144M38 76h116l-14-32H58z" fill="none" stroke="${accent}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" opacity=".72"/><circle cx="66" cy="91" r="10" fill="${background}" stroke="${accent}" stroke-width="5"/><circle cx="130" cy="91" r="10" fill="${background}" stroke="${accent}" stroke-width="5"/><text x="96" y="31" text-anchor="middle" fill="#fff" font-family="system-ui,sans-serif" font-size="17" font-weight="700">${label}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const BUILTIN_LIFE_MODEL_INPUTS: Array<Omit<ModelLibraryItem, "id" | "thumbUrl" | "url">> = [
  { categoryId: "convenience", fileName: "ATM_low.fbx", name: "自动取款机" },
  { categoryId: "convenience", fileName: "trash_sorting_low.fbx", name: "分类垃圾桶" },
  { categoryId: "home", fileName: "sofa_modern_low.fbx", name: "沙发" },
  { categoryId: "home", fileName: "dining_table_low.fbx", name: "餐桌" },
  { categoryId: "home", fileName: "refrigerator_modern_low.fbx", name: "冰箱" },
  { categoryId: "home", fileName: "washing_machine_modern_low.fbx", name: "洗衣机" },
  { categoryId: "outdoor", fileName: "sedan_low.fbx", name: "家用轿车" },
  { categoryId: "outdoor", fileName: "suv_city_low.fbx", name: "城市SUV" },
  { categoryId: "outdoor", fileName: "city_bus_low.fbx", name: "城市公交车" },
  { categoryId: "outdoor", fileName: "bicycle_city_low.fbx", name: "自行车" },
  { categoryId: "outdoor", fileName: "electric_scooter_low.fbx", name: "电动踏板车" },
  { categoryId: "outdoor", fileName: "street_lamp_low.fbx", name: "路灯" },
  { categoryId: "outdoor", fileName: "street_tree_low.fbx", name: "绿化树" },
  { categoryId: "outdoor", fileName: "backpack_low.fbx", name: "背包" },
  { categoryId: "outdoor", fileName: "thermus_low.fbx", name: "保温瓶" },
  { categoryId: "outdoor", fileName: "deer_skull_low.fbx", name: "鹿头骨" },
  { categoryId: "tools", fileName: "wrench_low.fbx", name: "扳手" },
  { categoryId: "tools", fileName: "drill_press_low.fbx", name: "台钻" },
];

export const BUILTIN_LIFE_MODELS: ModelLibraryItem[] = BUILTIN_LIFE_MODEL_INPUTS.map((item) => ({
  ...item,
  id: `builtin:${item.fileName}`,
  url: `builtin://life/${item.fileName}`,
  thumbUrl: createBuiltInThumbnail(item.name, item.categoryId),
}));

type GuoCharacterManifestItem = {
  id: string;
  label: string;
  localModelPath: string;
  localThumbnailPath: string;
};

type GuoPropManifestItem = {
  id: string;
  label: string;
  categoryId: string;
  localModelPath: string;
  localThumbnailPath: string;
};

const localAssetUrl = (path: string) => `${import.meta.env.BASE_URL}local-assets/guo-3d-assets/${path}`;
const localMixamoAssetUrl = (path: string) => `${import.meta.env.BASE_URL}local-assets/mixamo/${path}`;

export const MIXAMO_CHARACTER_MODELS: ModelLibraryItem[] = LOCAL_MIXAMO_CHARACTER_AVAILABLE
  ? [{
      id: "mixamo-character:camille",
      kind: "character",
      categoryId: "characters",
      fileName: "camille.fbx",
      name: "Camille（Mixamo）",
      url: localMixamoAssetUrl("characters/camille.fbx"),
      characterRigProfile: "mixamo",
      characterImportReadiness: "ready",
      characterOrientationCorrection: [0, 0, 0],
    }, {
      id: "rigged-character:robot-expressive",
      kind: "character",
      categoryId: "characters",
      fileName: "robot-expressive.glb",
      name: "表情机器人（自带动作）",
      url: localMixamoAssetUrl("characters/robot-expressive.glb"),
      characterRigProfile: "mixamo",
      characterImportReadiness: "ready",
      characterOrientationCorrection: [0, 0, 0],
    }]
  : [];

export const GUO_CHARACTER_MODELS: ModelLibraryItem[] = (guoCharactersManifest.items as GuoCharacterManifestItem[]).map((item) => {
  const compatibility = getGuoCharacterCompatibility(item.id);
  return {
    id: `guo-character:${item.id}`,
    kind: "character",
    categoryId: "characters",
    fileName: item.localModelPath.split("/").pop() ?? `${item.id}.fbx`,
    name: item.label,
    url: localAssetUrl(`guo-skeleton-models/${item.localModelPath}`),
    thumbUrl: localAssetUrl(`guo-skeleton-models/${item.localThumbnailPath}`),
    characterRigProfile: compatibility.rigProfile,
    characterImportReadiness: compatibility.readiness,
    characterOrientationCorrection: compatibility.orientationCorrection,
  };
});

function mapGuoPropCategory(categoryId: string): ModelLibraryCategoryId {
  if (categoryId === "furniture") return "home";
  if (categoryId === "vehicle" || categoryId === "environment") return "outdoor";
  if (categoryId === "firearms" || categoryId === "melee") return "weapons";
  if (categoryId === "accessory") return "convenience";
  return "tools";
}

export const GUO_PROP_MODELS: ModelLibraryItem[] = (guoPropsManifest.items as GuoPropManifestItem[]).map((item) => ({
  id: `guo-prop:${item.id}`,
  kind: "prop",
  categoryId: mapGuoPropCategory(item.categoryId),
  fileName: item.localModelPath.split("/").pop() ?? `${item.id}.fbx`,
  name: item.label,
  url: localAssetUrl(`guo-mounted-props-200/${item.localModelPath}`),
  thumbUrl: localAssetUrl(`guo-mounted-props-200/${item.localThumbnailPath}`),
}));

export function getModelLibraryItems() {
  const localModels = LOCAL_GUO_ASSETS_AVAILABLE ? [...GUO_CHARACTER_MODELS, ...GUO_PROP_MODELS] : [];
  return [...MIXAMO_CHARACTER_MODELS, ...localModels, ...BUILTIN_LIFE_MODELS].sort((a, b) => {
    const categoryIndexA = MODEL_LIBRARY_CATEGORIES.findIndex((category) => category.id === a.categoryId);
    const categoryIndexB = MODEL_LIBRARY_CATEGORIES.findIndex((category) => category.id === b.categoryId);

    if (categoryIndexA !== categoryIndexB) return categoryIndexA - categoryIndexB;

    return a.name.localeCompare(b.name, "zh-CN");
  });
}
