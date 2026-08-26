import { describe, expect, it } from "vitest";

import { defaultConfig, type AiConfig } from "@/stores/use-config-store";
import { isSeedanceFastModel, isSeedanceVideoConfig, normalizeSeedanceResolution, seedancePixelLabel } from "./seedance-video";

describe("Seedance video configuration", () => {
    it("keeps intelligent resolution adaptive in the settings UI", () => {
        expect(normalizeSeedanceResolution("auto", "seedance-2.0-fast")).toBe("auto");
        expect(seedancePixelLabel("auto", "16:9")).toBe("自动匹配");
    });

    it("recognizes SD2.0 aliases without confusing Stable Diffusion", () => {
        expect(isSeedanceVideoConfig({ model: "sd2.0", videoModel: "", baseUrl: "" })).toBe(true);
        expect(isSeedanceVideoConfig({ model: "sd_2.0_fast_discount_720p", videoModel: "", baseUrl: "" })).toBe(true);
        expect(isSeedanceFastModel("sd_2.0_fast_discount_720p")).toBe(true);
        expect(isSeedanceVideoConfig({ model: "stable-diffusion-2.0", videoModel: "", baseUrl: "" })).toBe(false);
    });

    it("uses the selected model's protocol on a mixed channel", () => {
        expect(isSeedanceVideoConfig(mixedChannelConfig("video-logical", "seedance"))).toBe(true);
        expect(isSeedanceVideoConfig(mixedChannelConfig("video-logical", "compatible"))).toBe(false);
    });

    it("recognizes Ark paths only on the exact provider host", () => {
        expect(isSeedanceVideoConfig({ model: "other-video", videoModel: "", baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3" })).toBe(true);
        expect(isSeedanceVideoConfig({ model: "other-video", videoModel: "", baseUrl: "https://ark.cn-beijing.volces.com.evil.test/api/plan/v3" })).toBe(false);
        expect(isSeedanceVideoConfig({ model: "other-video", videoModel: "", baseUrl: "https://example.com/api/plan/v3" })).toBe(false);
    });
});

function mixedChannelConfig(model: string, protocol: "seedance" | "compatible"): AiConfig {
    return {
        ...defaultConfig,
        model,
        videoModel: model,
        channels: [
            {
                id: "mixed",
                name: "混合渠道",
                baseUrl: "/api/ai/system/mixed",
                apiKey: "system",
                apiFormat: "openai",
                models: ["openai-text", "opaque-video"],
                advancedConfig: {
                    protocol: "auto",
                    textModel: "openai-text",
                    imageModel: "",
                    videoModel: "opaque-video",
                    createPath: "",
                    queryPath: "",
                    requestTemplate: "",
                    resultField: "",
                    statusField: "",
                    durationRange: "",
                    referenceRule: "",
                    supportsReferenceImage: false,
                    supportsReferenceVideo: false,
                    supportsReferenceAudio: false,
                    modelConfigs: { "opaque-video": { capability: "video", protocol } },
                },
            },
        ],
        logicalModels: [
            {
                id: "video-logical",
                name: "视频模型",
                capability: "video",
                enabled: true,
                bindings: [{ id: "video-binding", channelId: "mixed", upstreamModel: "opaque-video", enabled: true, priority: 1 }],
            },
        ],
    };
}
