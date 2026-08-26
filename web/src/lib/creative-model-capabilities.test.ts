import { describe, expect, it } from "vitest";

import { creativeModelProfileForLogicalModel, creativeSelectedModelProfile, reconcileCreativeGenerationPreferences, type CreativeModelCapabilityOption } from "./creative-model-capabilities";

describe("creative model capabilities", () => {
    it("merges route bindings and intersects the explicitly configured options of selected models", () => {
        const first = creativeModelProfileForLogicalModel({
            id: "first",
            bindings: [
                { enabled: true, capabilityProfile: { aspectRatios: ["16:9", "9:16"], resolutions: ["720", "1080"], durationSeconds: [5, 10], maxBatchSize: 4 } },
                { enabled: true, capabilityProfile: { aspectRatios: ["1:1"], resolutions: ["4K"], durationSeconds: [8], maxBatchSize: 6 } },
            ],
        });
        expect(first).toEqual({ aspectRatios: ["16:9", "9:16", "1:1"], resolutions: ["720", "1080", "4K"], durationSeconds: [5, 8, 10], maxBatchSize: 6 });

        const selected = creativeSelectedModelProfile(
            [
                { id: "first", name: "一", capability: "video", capabilityProfile: first },
                { id: "second", name: "二", capability: "video", capabilityProfile: { aspectRatios: ["16:9", "1:1"], resolutions: ["1080", "2160"], durationSeconds: [8, 10], maxBatchSize: 2 } },
            ],
            "video",
        );
        expect(selected).toEqual({ aspectRatios: ["16:9", "1:1"], resolutions: ["1080"], durationSeconds: [8, 10], maxBatchSize: 8 });
    });

    it("converges stale parameters when models change and leaves unconfigured models unchanged", () => {
        const model: CreativeModelCapabilityOption = {
            id: "video",
            name: "视频",
            capability: "video",
            capabilityProfile: { aspectRatios: ["16:9"], resolutions: ["1080"], durationSeconds: [8, 10], maxBatchSize: 2 },
        };
        expect(reconcileCreativeGenerationPreferences({ video: { size: "9:16", quality: "720P", seconds: 5, count: 4 } }, [model])).toEqual({ video: { size: "16:9", quality: "1080", seconds: 8, count: 2 } });

        const original = { image: { size: "9:16", quality: "high" as const, count: 4 } };
        expect(reconcileCreativeGenerationPreferences(original, [{ id: "image", name: "图片", capability: "image" }])).toBe(original);
    });

    it("keeps intelligent values across model changes and preserves exact dimensions with a supported ratio", () => {
        const model: CreativeModelCapabilityOption = {
            id: "image",
            name: "图片",
            capability: "image",
            capabilityProfile: { aspectRatios: ["9:16"], resolutions: ["2K"], maxBatchSize: 2 },
        };
        expect(reconcileCreativeGenerationPreferences({ image: { size: "auto", quality: "auto", count: 4 } }, [model])).toEqual({ image: { size: "auto", quality: "auto", count: 2 } });
        expect(reconcileCreativeGenerationPreferences({ image: { count: 1 } }, [model])).toEqual({ image: { count: 1 } });
        expect(reconcileCreativeGenerationPreferences({ image: { size: "1080x1920", quality: "2k", count: 1 } }, [model])).toEqual({ image: { size: "1080x1920", quality: "2K", count: 1 } });
    });

    it("keeps every selected model represented and sums their known batch capacities", () => {
        const models: CreativeModelCapabilityOption[] = [
            { id: "first", name: "一", capability: "image", capabilityProfile: { maxBatchSize: 1 } },
            { id: "second", name: "二", capability: "image", capabilityProfile: { maxBatchSize: 2 } },
        ];
        expect(creativeSelectedModelProfile(models, "image")).toEqual({ maxBatchSize: 3 });
        expect(reconcileCreativeGenerationPreferences({ image: { count: 1 } }, models)).toEqual({ image: { count: 2 } });
        expect(reconcileCreativeGenerationPreferences({ image: { count: 9 } }, models)).toEqual({ image: { count: 3 } });
    });
});
