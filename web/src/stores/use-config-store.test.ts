import { describe, expect, it } from "vitest";

import { applyPublicSystemSettings, defaultConfig, modelMatchesCapability, modelOptionLabel, resolveModelProtocol, type PublicSystemSettings } from "./use-config-store";

const audioSettings: PublicSystemSettings = {
    systemChannels: [
        {
            id: "audio-channel",
            name: "音频渠道",
            baseUrl: "https://api.example.com/v1",
            apiKey: "",
            apiFormat: "openai",
            models: ["speech-v1"],
            enabled: true,
            hasApiKey: true,
        },
    ],
    logicalModels: [
        {
            id: "speech-v1",
            name: "语音模型",
            capability: "audio",
            enabled: true,
            bindings: [{ id: "audio-binding", channelId: "audio-channel", upstreamModel: "speech-v1", enabled: true, priority: 0 }],
        },
    ],
};

describe("applyPublicSystemSettings", () => {
    it("does not reuse a persisted audio model when the administrator has no default", () => {
        const config = applyPublicSystemSettings({ ...defaultConfig, audioModel: "speech-v1" }, audioSettings);

        expect(config.audioModels).toEqual(["speech-v1"]);
        expect(config.audioModel).toBe("");
    });

    it("uses the administrator default audio model when it is resolvable", () => {
        const config = applyPublicSystemSettings(defaultConfig, {
            ...audioSettings,
            defaultModels: { audioModel: "speech-v1" },
        });

        expect(config.audioModel).toBe("speech-v1");
    });

    it("routes SD2.0 aliases to video while retaining full Stable Diffusion names as image", () => {
        expect(modelMatchesCapability("sd2", "image")).toBe(false);
        expect(modelMatchesCapability("sd2", "video")).toBe(true);
        expect(modelMatchesCapability("sd2", "text")).toBe(false);
        expect(modelMatchesCapability("sd_2.0_fast_discount_720p", "video")).toBe(true);
        expect(modelMatchesCapability("stable-diffusion-2.0", "image")).toBe(true);
        expect(modelMatchesCapability("sd3-medium", "image")).toBe(true);
    });

    it("falls back from a persisted image model to the administrator video default", () => {
        const config = applyPublicSystemSettings({ ...defaultConfig, model: "stable-diffusion-2.0", videoModel: "stable-diffusion-2.0" }, rawModelSettings());

        expect(config.imageModels).toEqual(["stable-diffusion-2.0"]);
        expect(config.videoModels).toEqual(["video-v1"]);
        expect(config.videoModel).toBe("video-v1");
    });

    it("preserves the server-provided logical capability instead of guessing from its name", () => {
        const config = applyPublicSystemSettings(defaultConfig, explicitLogicalSettings());

        expect(config.logicalModels.find((model) => model.id === "stable-diffusion-2.0")?.capability).toBe("video");
        expect(config.videoModels).toEqual(["stable-diffusion-2.0", "video-v1"]);
    });

    it("does not expose misleading image-like names on public video models", () => {
        const config = applyPublicSystemSettings(defaultConfig, misleadingVideoNameSettings());

        expect(config.videoModels).toEqual(["video-v1"]);
        expect(modelOptionLabel(config, "video-v1")).toBe("sd2");
    });

    it("keeps a configured logical default when casing or the upstream alias differs", () => {
        const config = applyPublicSystemSettings(defaultConfig, {
            ...rawModelSettings(),
            defaultModels: { videoModel: "VENDOR/VIDEO-V1" },
            logicalModels: [
                {
                    id: "video-v1",
                    name: "默认视频模型",
                    capability: "video",
                    enabled: true,
                    bindings: [{ id: "video-binding", channelId: "mixed-channel", upstreamModel: "video-v1", enabled: true, priority: 1 }],
                },
            ],
        });

        expect(config.videoModel).toBe("video-v1");
    });

    it("uses an existing upstream point price for the logical model estimate", () => {
        const config = applyPublicSystemSettings(defaultConfig, {
            ...audioSettings,
            modelPointCosts: { "speech-v1": 2.5 },
            logicalModels: [{ ...audioSettings.logicalModels![0], id: "voice-pro" }],
        });

        expect(config.modelPointCosts["voice-pro"]).toBe(2.5);
    });

    it("keeps public concurrency and canvas counts above the former client ceilings", () => {
        const config = applyPublicSystemSettings(defaultConfig, {
            ...audioSettings,
            generationConcurrency: { agent: 11, image: 12, video: 6, audio: 13, text: 21, render: 7 },
            generationDefaults: { canvasImageCount: 11, imageCount: 12, imageSize: "auto", imageQuality: "auto", videoQuality: "720", videoSeconds: 5, audioVoice: "alloy", audioFormat: "mp3" },
        });

        expect(config.generationConcurrency).toEqual({ agent: 11, image: 12, video: 6, audio: 13, text: 21, render: 7 });
        expect(config.canvasImageCount).toBe("11");
        expect(config.count).toBe("12");
    });

    it("resolves the public protocol for a logical model binding", () => {
        const config = applyPublicSystemSettings(defaultConfig, {
            systemChannels: [
                {
                    id: "image-channel",
                    name: "图片渠道",
                    baseUrl: "/api/ai/system/image-channel",
                    apiKey: "system",
                    apiFormat: "openai",
                    models: ["vendor-image"],
                    enabled: true,
                    hasApiKey: true,
                    protocol: "custom",
                    modelProtocols: { "vendor-image": "sub2api" },
                },
            ],
            logicalModels: [
                {
                    id: "logical-image",
                    name: "逻辑图片模型",
                    capability: "image",
                    enabled: true,
                    bindings: [{ id: "image-binding", channelId: "image-channel", upstreamModel: "vendor-image", enabled: true, priority: 1 }],
                },
            ],
        });

        expect(resolveModelProtocol(config, "logical-image")).toBe("sub2api");
    });
});

function rawModelSettings(): PublicSystemSettings {
    return {
        systemChannels: [
            {
                id: "mixed-channel",
                name: "混合渠道",
                baseUrl: "https://api.example.com/v1",
                apiKey: "",
                apiFormat: "openai",
                models: ["stable-diffusion-2.0", "video-v1"],
                enabled: true,
                hasApiKey: true,
            },
        ],
        defaultModels: { videoModel: "video-v1" },
    };
}

function explicitLogicalSettings(): PublicSystemSettings {
    return {
        ...rawModelSettings(),
        logicalModels: [
            {
                id: "stable-diffusion-2.0",
                name: "自定义视频能力",
                capability: "video",
                enabled: true,
                bindings: [{ id: "sd-binding", channelId: "mixed-channel", upstreamModel: "stable-diffusion-2.0", enabled: true, priority: 1 }],
            },
            {
                id: "video-v1",
                name: "文生视频",
                capability: "video",
                enabled: true,
                bindings: [{ id: "video-binding", channelId: "mixed-channel", upstreamModel: "video-v1", enabled: true, priority: 2 }],
            },
        ],
    };
}

function misleadingVideoNameSettings(): PublicSystemSettings {
    return {
        ...rawModelSettings(),
        logicalModels: [
            {
                id: "video-v1",
                name: "sd2",
                capability: "video",
                enabled: true,
                bindings: [{ id: "video-binding", channelId: "mixed-channel", upstreamModel: "video-v1", enabled: true, priority: 1 }],
            },
        ],
    };
}
