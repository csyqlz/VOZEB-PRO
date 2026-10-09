import { resolveCustomGeminiImageModel } from "@/lib/server/custom-gemini-image-model";
import type { ImageTask, ImageTaskConfig } from "@/lib/server/image-task-store";

export function customGeminiImageTaskPath(config: ImageTaskConfig, kind: ImageTask["kind"]) {
    if (config.apiFormat !== "gemini" || config.advancedConfig?.protocol !== "custom") return "";
    const path = (kind === "edit" ? config.advancedConfig.editPath || config.advancedConfig.createPath : config.advancedConfig.createPath)?.trim() || "";
    if (!/^\/(?:[a-z0-9._~-]+\/)*models\/[^/?#]+:generateContent$/i.test(path)) return "";
    const model = resolveCustomGeminiImageModel(config.model, config.quality, config.size).replace(/^models\//i, "");
    return path.replace(/(\/models\/)[^/]+(:generateContent)$/i, `$1${model}$2`);
}
