import { agentSkillSupportsGenerationMode, type CreativeGenerationMode, type CreativeGenerationPreferences } from "@/lib/creative-runtime-contract";

export function shouldShowVideoFrameControls(creationMode: "agent" | CreativeGenerationMode, preferences: CreativeGenerationPreferences) {
    const effectiveMode = creationMode === "agent" ? preferences.mode : creationMode;
    return effectiveMode === "video" && preferences.video?.referenceMode !== undefined && preferences.video.referenceMode !== "reference";
}

export function applyAgentGenerationCapability(creationMode: "agent" | CreativeGenerationMode, capability: CreativeGenerationMode, preferences: CreativeGenerationPreferences) {
    return creationMode === "agent" ? { ...preferences, mode: capability } : preferences;
}

export function generationPreferencesForSelectedSkill(preferences: CreativeGenerationPreferences, workspaces?: readonly string[]) {
    if (!preferences.mode || agentSkillSupportsGenerationMode(workspaces, preferences.mode)) return preferences;
    const next = { ...preferences };
    delete next.mode;
    if (preferences.mode === "video" && next.video) next.video = { ...next.video, referenceMode: "reference", firstFrameAssetId: undefined, lastFrameAssetId: undefined };
    return next;
}

export function generationPreferencesAfterSubmit(creationMode: "agent" | CreativeGenerationMode, preferences: CreativeGenerationPreferences) {
    if (creationMode === "agent") return {};
    return preferences.video ? { ...preferences, video: { ...preferences.video, firstFrameAssetId: undefined, lastFrameAssetId: undefined } } : preferences;
}
