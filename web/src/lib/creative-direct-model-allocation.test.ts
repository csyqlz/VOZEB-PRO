import { describe, expect, it } from "vitest";

import { allocateDirectCreativeModels } from "./creative-direct-model-allocation";

describe("direct creative model allocation", () => {
    it("shows the actual per-model and final count when requested count is below selected models", () => {
        const models = [
            { id: "image-a", capability: "image" as const, capabilityProfile: { maxBatchSize: 2 } },
            { id: "image-b", capability: "image" as const, capabilityProfile: { maxBatchSize: 4 } },
            { id: "video-a", capability: "video" as const, capabilityProfile: { maxBatchSize: 2 } },
        ];

        expect(allocateDirectCreativeModels(models, { image: { count: 1 }, video: { count: 2 } }).map(({ model, count }) => [model.id, count])).toEqual([
            ["image-a", 1],
            ["image-b", 1],
            ["video-a", 2],
        ]);
        expect(allocateDirectCreativeModels(models, { image: { count: 6 } }).map(({ model, count }) => [model.id, count])).toEqual([
            ["image-a", 2],
            ["image-b", 4],
            ["video-a", 1],
        ]);
        expect(() => allocateDirectCreativeModels(models, { image: { count: 7 } })).toThrow("无法承载当前生成总数");
    });
});
