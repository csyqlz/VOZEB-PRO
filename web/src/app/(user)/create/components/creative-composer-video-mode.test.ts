import { describe, expect, it } from "vitest";

import { applyAgentGenerationCapability, generationPreferencesAfterSubmit, generationPreferencesForSelectedSkill, shouldShowVideoFrameControls } from "./creative-composer-video-mode";

describe("shouldShowVideoFrameControls", () => {
    it("shows first and last frame slots for explicit video mode", () => {
        expect(shouldShowVideoFrameControls("video", { video: { referenceMode: "first_last" } })).toBe(true);
    });

    it("shows frame slots when Agent parameters explicitly select video", () => {
        expect(shouldShowVideoFrameControls("agent", { mode: "video", video: { referenceMode: "first_frame" } })).toBe(true);
        expect(shouldShowVideoFrameControls("agent", { mode: "image", video: { referenceMode: "first_last" } })).toBe(false);
        expect(shouldShowVideoFrameControls("agent", { mode: "video", video: { referenceMode: "reference" } })).toBe(false);
    });

    it("ignores stale video preferences after switching to another explicit mode", () => {
        expect(shouldShowVideoFrameControls("image", { mode: "video", video: { referenceMode: "first_last" } })).toBe(false);
        expect(shouldShowVideoFrameControls("audio", { video: { referenceMode: "first_frame" } })).toBe(false);
    });

    it("makes the edited Agent parameter capability immediately effective", () => {
        expect(applyAgentGenerationCapability("agent", "video", { image: { quality: "high" } })).toEqual({ mode: "video", image: { quality: "high" } });
        expect(applyAgentGenerationCapability("image", "video", { mode: "image" })).toEqual({ mode: "image" });
    });

    it("drops a stale incompatible mode when a Skill is selected", () => {
        expect(generationPreferencesForSelectedSkill({ mode: "video", video: { seconds: 5, referenceMode: "first_frame", firstFrameAssetId: "asset-one" } }, ["image", "canvas"])).toEqual({
            video: { seconds: 5, referenceMode: "reference", firstFrameAssetId: undefined, lastFrameAssetId: undefined },
        });
    });

    it("resets Agent preferences after each submitted turn", () => {
        expect(generationPreferencesAfterSubmit("agent", { mode: "video", video: { seconds: 5 } })).toEqual({});
        expect(generationPreferencesAfterSubmit("video", { mode: "video", video: { seconds: 5, firstFrameAssetId: "asset-one" } })).toEqual({ mode: "video", video: { seconds: 5, firstFrameAssetId: undefined, lastFrameAssetId: undefined } });
    });
});
