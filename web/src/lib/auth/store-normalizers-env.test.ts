import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveLogicalModelConfig } from "@/lib/model-routing-config";

import { DEFAULT_SETTINGS } from "./store-foundation";
import { normalizeSettings } from "./store-normalizers";
import type { AuthSettings } from "./store-types";

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("normalizeSettings environment text defaults", () => {
    it("adds a DeepSeek default text model when only the environment API key is configured", () => {
        vi.stubEnv("VOZEB_PRO_DEEPSEEK_API_KEY", "test-deepseek-key");

        const settings = normalizeSettings(structuredClone(DEFAULT_SETTINGS));

        expect(settings.defaultModels.textModel).toBe("deepseek-default-text");
        expect(resolveLogicalModelConfig(settings.logicalModels, settings.systemChannels, "text", "deepseek-default-text")).toMatchObject({
            binding: { channelId: "deepseek-env", upstreamModel: "deepseek-v4-flash" },
            channel: { baseUrl: "https://api.deepseek.com", apiFormat: "openai", apiKey: "test-deepseek-key", models: ["deepseek-v4-flash"], enabled: true },
        });
    });

    it("keeps an existing resolvable default text model while exposing the DeepSeek environment fallback", () => {
        vi.stubEnv("VOZEB_PRO_DEEPSEEK_API_KEY", "test-deepseek-key");
        const settings: AuthSettings = {
            ...structuredClone(DEFAULT_SETTINGS),
            systemChannels: [{ id: "configured-channel", name: "Configured", baseUrl: "https://configured.example", apiKey: "configured-key", apiFormat: "openai", models: ["configured-text"], enabled: true }],
            logicalModels: [{ id: "configured-text", name: "Configured Text", capability: "text", enabled: true, bindings: [{ id: "configured-binding", channelId: "configured-channel", upstreamModel: "configured-text", enabled: true, priority: 1 }] }],
            defaultModels: { imageModel: "", videoModel: "", textModel: "configured-text", audioModel: "" },
        };

        const normalized = normalizeSettings(settings);

        expect(normalized.defaultModels.textModel).toBe("configured-text");
        expect(resolveLogicalModelConfig(normalized.logicalModels, normalized.systemChannels, "text", "deepseek-default-text")).toMatchObject({
            binding: { channelId: "deepseek-env", upstreamModel: "deepseek-v4-flash" },
        });
    });

    it("keeps DeepSeek as the default text model while exposing SiliconFlow text options", () => {
        vi.stubEnv("VOZEB_PRO_DEEPSEEK_API_KEY", "test-deepseek-key");
        vi.stubEnv("VOZEB_PRO_SILICONFLOW_API_KEY", "test-siliconflow-key");

        const settings = normalizeSettings(structuredClone(DEFAULT_SETTINGS));

        expect(settings.defaultModels.textModel).toBe("deepseek-default-text");
        expect(resolveLogicalModelConfig(settings.logicalModels, settings.systemChannels, "text", "deepseek-default-text")).toMatchObject({
            binding: { channelId: "deepseek-env", upstreamModel: "deepseek-v4-flash" },
        });
        expect(resolveLogicalModelConfig(settings.logicalModels, settings.systemChannels, "text", "siliconflow-fast-text")).toMatchObject({
            binding: { channelId: "siliconflow-text-env", upstreamModel: "deepseek-ai/DeepSeek-V4-Flash" },
            channel: { baseUrl: "https://api.siliconflow.cn/v1", apiFormat: "openai", apiKey: "test-siliconflow-key", enabled: true },
        });
        expect(resolveLogicalModelConfig(settings.logicalModels, settings.systemChannels, "text", "siliconflow-quality-text")).toMatchObject({
            binding: { channelId: "siliconflow-text-env", upstreamModel: "deepseek-ai/DeepSeek-V4-Pro" },
        });
        expect(resolveLogicalModelConfig(settings.logicalModels, settings.systemChannels, "text", "siliconflow-backup-text")).toMatchObject({
            binding: { channelId: "siliconflow-text-env", upstreamModel: "Qwen/Qwen3.5-9B" },
        });
    });

    it("adds SiliconFlow image options while keeping Kolors as the default economical image model", () => {
        vi.stubEnv("VOZEB_PRO_SILICONFLOW_API_KEY", "test-siliconflow-key");

        const settings = normalizeSettings(structuredClone(DEFAULT_SETTINGS));

        expect(settings.defaultModels.imageModel).toBe("siliconflow-default-image");
        expect(resolveLogicalModelConfig(settings.logicalModels, settings.systemChannels, "image", "siliconflow-default-image")).toMatchObject({
            binding: { channelId: "siliconflow-env", upstreamModel: "Kwai-Kolors/Kolors" },
        });
        expect(resolveLogicalModelConfig(settings.logicalModels, settings.systemChannels, "image", "siliconflow-qwen-image")).toMatchObject({
            binding: { channelId: "siliconflow-env", upstreamModel: "Qwen/Qwen-Image" },
        });
        expect(resolveLogicalModelConfig(settings.logicalModels, settings.systemChannels, "image", "siliconflow-qwen-image-edit")).toMatchObject({
            binding: { channelId: "siliconflow-env", upstreamModel: "Qwen/Qwen-Image-Edit" },
        });
    });
});
