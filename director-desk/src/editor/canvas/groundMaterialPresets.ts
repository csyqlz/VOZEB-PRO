import {
  CanvasTexture,
  RepeatWrapping,
  SRGBColorSpace,
} from "three";
import type { GroundMaterialPresetId } from "../schema/directorProject";

export type { GroundMaterialPresetId } from "../schema/directorProject";

export type GroundTextureType = "grid" | "concrete" | "asphalt" | "wood" | "grass";

export interface GroundMaterialPreset {
  readonly id: GroundMaterialPresetId;
  readonly label: string;
  readonly baseColor: `#${string}`;
  readonly roughness: number;
  readonly metalness: number;
  readonly textureType: GroundTextureType;
  /** World-space metres covered by one texture tile. */
  readonly tileWorldSize: readonly [number, number];
  readonly textureSize: number;
}

export const GROUND_PLANE_SIZE = 200;

export const GROUND_MATERIAL_PRESETS: readonly GroundMaterialPreset[] = [
  {
    id: "studio",
    label: "摄影棚",
    baseColor: "#5b6068",
    roughness: 0.72,
    metalness: 0.04,
    textureType: "grid",
    tileWorldSize: [8, 8],
    textureSize: 256,
  },
  {
    id: "concrete",
    label: "混凝土",
    baseColor: "#777773",
    roughness: 0.92,
    metalness: 0,
    textureType: "concrete",
    tileWorldSize: [4, 4],
    textureSize: 256,
  },
  {
    id: "asphalt",
    label: "柏油",
    baseColor: "#303235",
    roughness: 0.96,
    metalness: 0,
    textureType: "asphalt",
    tileWorldSize: [3, 3],
    textureSize: 256,
  },
  {
    id: "wood",
    label: "木地板",
    baseColor: "#8a5d3b",
    roughness: 0.68,
    metalness: 0,
    textureType: "wood",
    tileWorldSize: [5, 5],
    textureSize: 256,
  },
  {
    id: "grass",
    label: "草地",
    baseColor: "#45683b",
    roughness: 1,
    metalness: 0,
    textureType: "grass",
    tileWorldSize: [3, 3],
    textureSize: 256,
  },
] as const;

const DEFAULT_PRESET = GROUND_MATERIAL_PRESETS[0];

export function getGroundMaterialPreset(id: string | null | undefined): GroundMaterialPreset {
  return GROUND_MATERIAL_PRESETS.find((preset) => preset.id === id) ?? DEFAULT_PRESET;
}

export function getGroundTextureRepeat(
  id: string | null | undefined,
  groundSize = GROUND_PLANE_SIZE,
  textureScale = 1,
): [number, number] {
  const preset = getGroundMaterialPreset(id);
  const size = Math.max(1, Number.isFinite(groundSize) ? groundSize : GROUND_PLANE_SIZE);
  const scale = Math.min(8, Math.max(0.25, Number.isFinite(textureScale) ? textureScale : 1));
  return [
    size / Math.max(0.1, preset.tileWorldSize[0] * scale),
    size / Math.max(0.1, preset.tileWorldSize[1] * scale),
  ];
}

function createSeededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function seedForPreset(id: GroundMaterialPresetId) {
  let seed = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    seed ^= id.charCodeAt(index);
    seed = Math.imul(seed, 16777619);
  }
  return seed >>> 0;
}

function paintBase(
  context: CanvasRenderingContext2D,
  size: number,
  color: string,
) {
  context.fillStyle = color;
  context.fillRect(0, 0, size, size);
}

function drawStudio(
  context: CanvasRenderingContext2D,
  size: number,
  random: () => number,
) {
  context.strokeStyle = "rgba(235, 240, 246, 0.10)";
  context.lineWidth = 1;
  for (let position = 0; position <= size; position += 32) {
    context.beginPath();
    context.moveTo(position, 0);
    context.lineTo(position, size);
    context.moveTo(0, position);
    context.lineTo(size, position);
    context.stroke();
  }

  context.fillStyle = "rgba(255, 255, 255, 0.035)";
  for (let index = 0; index < 90; index += 1) {
    const radius = 0.4 + random() * 0.8;
    context.beginPath();
    context.arc(random() * size, random() * size, radius, 0, Math.PI * 2);
    context.fill();
  }
}

function drawConcrete(
  context: CanvasRenderingContext2D,
  size: number,
  random: () => number,
) {
  for (let index = 0; index < 260; index += 1) {
    const light = random() > 0.5 ? 255 : 20;
    const alpha = 0.025 + random() * 0.07;
    const grainSize = 0.6 + random() * 2.4;
    context.fillStyle = `rgba(${light}, ${light}, ${light}, ${alpha})`;
    context.fillRect(random() * size, random() * size, grainSize, grainSize);
  }

  context.strokeStyle = "rgba(35, 35, 33, 0.13)";
  context.lineWidth = 1;
  for (const position of [0, size / 2, size]) {
    context.beginPath();
    context.moveTo(position, 0);
    context.lineTo(position, size);
    context.moveTo(0, position);
    context.lineTo(size, position);
    context.stroke();
  }
}

function drawAsphalt(
  context: CanvasRenderingContext2D,
  size: number,
  random: () => number,
) {
  for (let index = 0; index < 420; index += 1) {
    const value = 105 + Math.floor(random() * 95);
    const radius = 0.25 + random() * 1.15;
    context.fillStyle = `rgba(${value}, ${value}, ${value - 5}, ${0.08 + random() * 0.16})`;
    context.beginPath();
    context.arc(random() * size, random() * size, radius, 0, Math.PI * 2);
    context.fill();
  }
}

function drawWood(
  context: CanvasRenderingContext2D,
  size: number,
  random: () => number,
) {
  const plankHeight = 32;
  context.strokeStyle = "rgba(45, 23, 12, 0.38)";
  context.lineWidth = 1.5;
  for (let y = 0; y <= size; y += plankHeight) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(size, y);
    context.stroke();
  }

  for (let row = 0; row < size / plankHeight; row += 1) {
    const jointOffset = row % 2 === 0 ? size / 2 : size / 4;
    context.beginPath();
    context.moveTo(jointOffset, row * plankHeight);
    context.lineTo(jointOffset, (row + 1) * plankHeight);
    context.stroke();
  }

  context.strokeStyle = "rgba(255, 220, 170, 0.12)";
  context.lineWidth = 0.8;
  for (let index = 0; index < 95; index += 1) {
    const x = random() * size;
    const y = random() * size;
    const length = 8 + random() * 30;
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(Math.min(size, x + length), y + (random() - 0.5) * 2);
    context.stroke();
  }
}

function drawGrass(
  context: CanvasRenderingContext2D,
  size: number,
  random: () => number,
) {
  for (let index = 0; index < 520; index += 1) {
    const x = random() * size;
    const y = random() * size;
    const length = 1.5 + random() * 4;
    const light = random() > 0.52;
    context.strokeStyle = light ? "rgba(165, 188, 103, 0.28)" : "rgba(20, 55, 20, 0.34)";
    context.lineWidth = 0.6 + random() * 0.8;
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(x + (random() - 0.5) * 2, y - length);
    context.stroke();
  }
}

function paintPresetTexture(
  context: CanvasRenderingContext2D,
  preset: GroundMaterialPreset,
) {
  const random = createSeededRandom(seedForPreset(preset.id));
  paintBase(context, preset.textureSize, preset.baseColor);

  switch (preset.textureType) {
    case "grid":
      drawStudio(context, preset.textureSize, random);
      break;
    case "concrete":
      drawConcrete(context, preset.textureSize, random);
      break;
    case "asphalt":
      drawAsphalt(context, preset.textureSize, random);
      break;
    case "wood":
      drawWood(context, preset.textureSize, random);
      break;
    case "grass":
      drawGrass(context, preset.textureSize, random);
      break;
  }
}

export function createGroundMaterialTexture(
  id: string | null | undefined,
  groundSize = GROUND_PLANE_SIZE,
  textureScale = 1,
): CanvasTexture | null {
  if (typeof document === "undefined" || typeof document.createElement !== "function") return null;

  try {
    const preset = getGroundMaterialPreset(id);
    const canvas = document.createElement("canvas");
    canvas.width = preset.textureSize;
    canvas.height = preset.textureSize;

    const context = canvas.getContext("2d");
    if (!context) return null;

    paintPresetTexture(context, preset);

    const texture = new CanvasTexture(canvas);
    texture.name = `ground-material-${preset.id}`;
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    texture.colorSpace = SRGBColorSpace;
    texture.repeat.set(...getGroundTextureRepeat(preset.id, groundSize, textureScale));
    return texture;
  } catch {
    return null;
  }
}
