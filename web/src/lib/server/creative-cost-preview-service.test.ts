import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ settings: vi.fn(), activation: vi.fn(), candidates: vi.fn() }));
vi.mock("@/lib/auth/store", () => ({ getAuthSettings: mocks.settings }));
vi.mock("./model-pricing-activation-store", () => ({ getModelPricingActivation: mocks.activation }));
vi.mock("./logical-model-router", () => ({ resolveLogicalModelCandidates: mocks.candidates }));

import { previewCreativeDirectCosts } from "./creative-cost-preview-service";

describe("creative direct cost preview", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.settings.mockResolvedValue({
            logicalModels: [
                { id: "image-a", name: "模型 A", capability: "image", enabled: true, bindings: [] },
                { id: "image-b", name: "模型 B", capability: "image", enabled: true, bindings: [] },
            ],
            modelPointCosts: { "image-a": 2.5, "image-b": 4 },
            generationPointMultipliers: { imageQuality: { high: 2 }, videoQuality: {}, videoSeconds: {} },
        });
        mocks.activation.mockResolvedValue(undefined);
        mocks.candidates.mockReturnValue([{ channel: { advancedConfig: { protocol: "openai" } }, capabilityProfile: { maxBatchSize: 4 } }]);
    });

    it("uses actual per-model allocation and fixed pricing without creating a charge", async () => {
        const preview = await previewCreativeDirectCosts(["image-b", "image-a"], { image: { quality: "high", count: 3 } });

        expect(preview).toEqual({
            totalCount: 3,
            fixedEstimatedPoints: 21,
            lines: [
                { modelId: "image-b", modelName: "模型 B", capability: "image", count: 2, estimatedPoints: 16 },
                { modelId: "image-a", modelName: "模型 A", capability: "image", count: 1, estimatedPoints: 5 },
            ],
        });
        expect(mocks.activation).toHaveBeenCalledWith("image-b", "image:generations:standard");
    });

    it("does not label an activated usage model or an undetermined operation as fixed price", async () => {
        mocks.activation.mockImplementation(async (id: string) => (id === "image-a" ? { enabled: true } : undefined));

        const preview = await previewCreativeDirectCosts(["image-a", "image-b"], { image: { quality: "high", count: 2 } }, true);

        expect(preview.fixedEstimatedPoints).toBe(0);
        expect(preview.lines[0]).toMatchObject({ count: 1, note: "按量计费已启用或待核对，暂无可靠费用预览" });
        expect(preview.lines[1]).toMatchObject({ count: 1, note: "参考图操作待确定，暂无可靠费用预览" });
    });

    it("keeps a fixed-price subtotal separate from a metered model", async () => {
        mocks.activation.mockImplementation(async (id: string) => (id === "image-a" ? { enabled: true } : undefined));

        const preview = await previewCreativeDirectCosts(["image-a", "image-b"], { image: { quality: "high", count: 2 } });

        expect(preview.fixedEstimatedPoints).toBe(8);
        expect(preview.lines[0]).not.toHaveProperty("estimatedPoints");
        expect(preview.lines[1]).toMatchObject({ count: 1, estimatedPoints: 8 });
    });

    it("does not estimate fixed media charges when smart parameters are still open", async () => {
        const preview = await previewCreativeDirectCosts(["image-a"], { image: { quality: "auto" } });
        expect(preview.lines[0]).toMatchObject({ note: "智能参数待确定，暂无可靠费用预览" });
        expect(preview.lines[0]).not.toHaveProperty("estimatedPoints");
    });

    it("previews explicit fixed video parameters and independent audio calls", async () => {
        mocks.settings.mockResolvedValue({
            logicalModels: [
                { id: "video-a", name: "视频模型", capability: "video", enabled: true, bindings: [] },
                { id: "audio-a", name: "音频模型", capability: "audio", enabled: true, bindings: [] },
            ],
            modelPointCosts: { "video-a": 3, "audio-a": 1.25 },
            generationPointMultipliers: { imageQuality: {}, videoQuality: { "720": 2 }, videoSeconds: { "5": 1.5 } },
        });

        const preview = await previewCreativeDirectCosts(["video-a", "audio-a"], { video: { count: 2, quality: "720P", seconds: 5 } });

        expect(preview).toMatchObject({
            totalCount: 3,
            fixedEstimatedPoints: 19.25,
            lines: [
                { count: 2, estimatedPoints: 18 },
                { count: 1, estimatedPoints: 1.25 },
            ],
        });
    });

    it("does not quote fixed video points when the video scope uses metered pricing", async () => {
        mocks.settings.mockResolvedValue({
            logicalModels: [{ id: "video-a", name: "视频模型", capability: "video", enabled: true, bindings: [] }],
            modelPointCosts: { "video-a": 3 },
            generationPointMultipliers: { imageQuality: {}, videoQuality: {}, videoSeconds: {} },
        });
        mocks.activation.mockImplementation(async (_id: string, scope?: string) => (scope === "video:generation:standard" ? { enabled: true } : undefined));

        const preview = await previewCreativeDirectCosts(["video-a"], { video: { quality: "720P", seconds: 5 } });

        expect(mocks.activation).toHaveBeenCalledWith("video-a", "video:generation:standard");
        expect(preview.fixedEstimatedPoints).toBe(0);
        expect(preview.lines[0]).toMatchObject({ note: "按量计费已启用或待核对，暂无可靠费用预览" });
    });
});
