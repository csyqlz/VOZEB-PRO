import { describe, expect, it } from "vitest";

import { creativeAgentModelsFromConfig } from "@/hooks/use-creative-agent-options";
import { applyPublicSystemSettings, defaultConfig, type PublicSystemSettings } from "@/stores/use-config-store";

describe("creative Agent public model catalog", () => {
    it("uses the same resolved capability lists as image, video, audio and Canvas workbenches", () => {
        const config = applyPublicSystemSettings(defaultConfig, publicSettings());

        expect(creativeAgentModelsFromConfig(config)).toEqual([
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

    it("offers the verified 2K tier for a DataEyes Seedream 5.0 Pro binding", () => {
        const settings = publicSettings();
        settings.systemChannels![0] = { ...settings.systemChannels![0], models: ["ByteDance-Seedream-5.0-pro"] };
        settings.logicalModels = [
            {
                id: "seedream-image",
                name: "Seedream 5.0 Pro",
                capability: "image",
                enabled: true,
                bindings: [{ id: "seedream-binding", channelId: "media-channel", upstreamModel: "ByteDance-Seedream-5.0-pro", enabled: true, priority: 1, capabilityProfile: { aspectRatios: ["2K"] } }],
            },
        ];
        const models = creativeAgentModelsFromConfig(applyPublicSystemSettings(defaultConfig, settings), ["image"]);
        expect(models).toEqual([{ id: "seedream-image", name: "Seedream 5.0 Pro", capability: "image", capabilityProfile: { aspectRatios: ["2K"] } }]);
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
                models: ["image-one", "video-one", "audio-one"],
                enabled: true,
                hasApiKey: true,
            },
        ],
        logicalModels: [logicalModel("image-one", "图片模型", "image"), logicalModel("video-one", "视频模型", "video"), logicalModel("audio-one", "音频模型", "audio")],
    };
}

function logicalModel(id: string, name: string, capability: "image" | "video" | "audio") {
    return { id, name, capability, enabled: true, bindings: [{ id: `${id}-binding`, channelId: "media-channel", upstreamModel: id, enabled: true, priority: 1 }] };
}
