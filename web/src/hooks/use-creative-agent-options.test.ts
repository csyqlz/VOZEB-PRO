import { describe, expect, it } from "vitest";

import { creativeAgentModelsFromConfig } from "@/hooks/use-creative-agent-options";
import { applyPublicSystemSettings, defaultConfig, type PublicSystemSettings } from "@/stores/use-config-store";

describe("creative Agent public model catalog", () => {
    it("uses the same resolved capability lists as text, image, video, audio and Canvas workbenches", () => {
        const config = applyPublicSystemSettings(defaultConfig, publicSettings());

        expect(creativeAgentModelsFromConfig(config, ["text", "image", "video", "audio"])).toEqual([
            { id: "text-one", name: "文本模型", capability: "text" },
            { id: "image-one", name: "图片模型", capability: "image" },
            { id: "video-one", name: "视频模型", capability: "video" },
            { id: "audio-one", name: "音频模型", capability: "audio" },
        ]);
    });

    it("keeps a channel-catalog fallback visible while logical model synchronization catches up", () => {
        const settings = publicSettings();
        settings.logicalModels = settings.logicalModels?.filter((model) => model.capability !== "video");
        const config = applyPublicSystemSettings(defaultConfig, settings);

        expect(config.videoModels).toEqual(["video-one"]);
        expect(creativeAgentModelsFromConfig(config, ["video"])).toEqual([{ id: "video-one", name: "video-one", capability: "video" }]);
    });

    it("keeps consumer-facing sale pricing attached to selectable models", () => {
        const settings = publicSettings();
        settings.modelPricing = {
            "image-one": { billingUnit: "per_call", currency: "CNY", salePrice: 0.4 },
            "text-one": { billingUnit: "per_1m_tokens", currency: "CNY", inputSalePrice: 1.5, outputSalePrice: 9 },
        };
        const config = applyPublicSystemSettings(defaultConfig, settings);

        expect(creativeAgentModelsFromConfig(config, ["text", "image"])).toEqual([
            { id: "text-one", name: "文本模型", capability: "text", pricing: settings.modelPricing["text-one"] },
            { id: "image-one", name: "图片模型", capability: "image", pricing: settings.modelPricing["image-one"] },
        ]);
    });
});

function publicSettings(): PublicSystemSettings {
    return {
        systemChannels: [
            {
                id: "media-channel",
                name: "媒体渠道",
                baseUrl: "/api/ai/system/media-channel",
                apiKey: "system",
                apiFormat: "openai",
                models: ["text-one", "image-one", "video-one", "audio-one"],
                enabled: true,
                hasApiKey: true,
            },
        ],
        logicalModels: [logicalModel("text-one", "文本模型", "text"), logicalModel("image-one", "图片模型", "image"), logicalModel("video-one", "视频模型", "video"), logicalModel("audio-one", "音频模型", "audio")],
    };
}

function logicalModel(id: string, name: string, capability: "text" | "image" | "video" | "audio") {
    return { id, name, capability, enabled: true, bindings: [{ id: `${id}-binding`, channelId: "media-channel", upstreamModel: id, enabled: true, priority: 1 }] };
}
