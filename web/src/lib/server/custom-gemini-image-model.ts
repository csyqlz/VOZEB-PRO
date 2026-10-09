import { parseImageDimensions } from "@/lib/image-size";

const MODEL = /^(?:models\/)?(gemini-3\.1-flash-image)(?:-(2k|4k))?(?:-(1x1|16x9|9x16|21x9|4x3|3x4))?$/i;
const RATIOS = ["1:1", "16:9", "9:16", "21:9", "4:3", "3:4"];

export function customGeminiImageModelParts(model: string) {
    const match = model.trim().match(MODEL);
    return match ? { baseModel: match[1], resolution: match[2]?.toLowerCase(), ratio: match[3]?.toLowerCase() } : undefined;
}

export function isCustomGeminiImageModel(model: string) {
    return MODEL.test(model.trim());
}

export function resolveCustomGeminiImageModel(model: string, quality?: string, size?: string) {
    const parts = customGeminiImageModelParts(model);
    if (!parts || parts.resolution || parts.ratio) return model;
    const normalizedQuality = quality?.trim().toLowerCase();
    const dimensions = parseImageDimensions(size || "");
    const longSide = dimensions ? Math.max(dimensions.width, dimensions.height) : 0;
    const resolution = longSide > 2048 || normalizedQuality === "high" || normalizedQuality === "4k" ? "4k" : longSide > 1024 || normalizedQuality === "medium" || normalizedQuality === "2k" ? "2k" : "";
    const ratio = dimensions
        ? RATIOS.reduce((closest, candidate) => {
              const distance = (value: string) => {
                  const [width, height] = value.split(":").map(Number);
                  return Math.abs(Math.log(dimensions.width / dimensions.height / (width / height)));
              };
              return distance(candidate) < distance(closest) ? candidate : closest;
          })
        : RATIOS.includes(size || "")
          ? size!
          : "";
    return [model, resolution, ratio.replace(":", "x")].filter(Boolean).join("-");
}
