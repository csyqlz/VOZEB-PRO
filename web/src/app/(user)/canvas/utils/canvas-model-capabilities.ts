import { creativeModelProfileForLogicalModel, reconcileCreativeGenerationPreferences, type CreativeModelCapabilityProfile, type CreativeModelCapabilityOption } from "@/lib/creative-model-capabilities";
import type { CreativeGenerationPreferences } from "@/lib/creative-runtime-contract";
import type { AiConfig } from "@/stores/use-config-store";

import type { CanvasGenerationMode, CanvasNodeMetadata } from "../types";

type MediaMode = Extract<CanvasGenerationMode, "image" | "video">;

export function canvasModelCapabilityProfile(config: AiConfig, model = config.model): CreativeModelCapabilityProfile | undefined {
    return creativeModelProfileForLogicalModel(config.logicalModels.find((item) => item.id.toLowerCase() === model.toLowerCase()));
}

export function canvasModelConfigPatch(config: AiConfig, model: string, mode: MediaMode): Partial<CanvasNodeMetadata> {
    const capabilityProfile = canvasModelCapabilityProfile(config, model);
    const option: CreativeModelCapabilityOption = { id: model, name: model, capability: mode, ...(capabilityProfile ? { capabilityProfile } : {}) };
    const preferences: CreativeGenerationPreferences =
        mode === "image" ? { image: { size: config.size, quality: config.quality, count: positiveInteger(config.count, 1) } } : { video: { size: config.size, quality: config.vquality, seconds: positiveInteger(config.videoSeconds, 5) } };
    const reconciled = reconcileCreativeGenerationPreferences(preferences, [option]);
    return mode === "image"
        ? { model, size: reconciled.image?.size, quality: reconciled.image?.quality, count: reconciled.image?.count }
        : { model, size: reconciled.video?.size, vquality: reconciled.video?.quality, seconds: reconciled.video?.seconds === undefined ? undefined : String(reconciled.video.seconds) };
}

function positiveInteger(value: unknown, fallback: number) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
