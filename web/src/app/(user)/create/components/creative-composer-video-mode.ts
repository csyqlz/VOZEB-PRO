import type { CreativeCreationMode, CreativeGenerationMode, CreativeGenerationPreferences } from "@/lib/creative-runtime-contract";

export function shouldShowVideoFrameControls(creationMode: CreativeCreationMode, preferences: CreativeGenerationPreferences) {
    const effectiveMode = creationMode === "agent" ? preferences.mode : creationMode;
    return effectiveMode === "video" && preferences.video?.referenceMode !== undefined && preferences.video.referenceMode !== "reference";
}

export function applyAgentGenerationCapability(creationMode: CreativeCreationMode, capability: CreativeGenerationMode, preferences: CreativeGenerationPreferences) {
    return creationMode === "agent" ? { ...preferences, mode: capability } : preferences;
}
