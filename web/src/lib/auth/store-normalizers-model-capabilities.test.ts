import { describe, expect, it } from "vitest";

import { normalizeSystemChannelAdvancedConfig } from "./store-normalizers";

describe("system channel model capabilities", () => {
    it("keeps the Yumeng protocol identity", () => {
        expect(normalizeSystemChannelAdvancedConfig({ protocol: "yumeng" } as never)?.protocol).toBe("yumeng");
    });

    it("normalizes supported capabilities and removes invalid entries", () => {
        const normalized = normalizeSystemChannelAdvancedConfig({
            protocol: "auto",
            modelCapabilities: {
                "models/Writer-V1": "text",
                " image-v1 ": "image",
                "video-v1": "video",
                invalid: "unknown",
            },
        } as never);

        expect(normalized?.modelCapabilities).toEqual({ "writer-v1": "text", "image-v1": "image", "video-v1": "video" });
    });

    it("persists the VOZEB recommended protocol after a settings round-trip", () => {
        expect(normalizeSystemChannelAdvancedConfig({ protocol: "vozeb-recommended" } as never)?.protocol).toBe("vozeb-recommended");
    });

    it("normalizes per-model routes for mixed company APIs", () => {
        const normalized = normalizeSystemChannelAdvancedConfig({
            protocol: "auto",
            modelConfigs: {
                "models/OpenAI-Text": { capability: "text", apiFormat: "openai", createPath: "chat/completions" },
                "SD2.0": { capability: "video", protocol: "seedance", createPath: "/videos", queryPath: "/videos/:task_id" },
                invalid: { capability: "other", createPath: "/bad" },
            },
        } as never);

        expect(normalized?.modelConfigs).toEqual({
            "openai-text": { capability: "text", apiFormat: "openai", createPath: "/chat/completions" },
            "sd2.0": { capability: "video", protocol: "seedance", createPath: "/videos", queryPath: "/videos/:task_id" },
        });
    });

    it("normalizes capability-level protocol operations and cancellation settings", () => {
        const normalized = normalizeSystemChannelAdvancedConfig({
            protocol: "custom",
            operationConfigs: {
                video: {
                    capability: "video",
                    protocol: "custom",
                    createPath: "/jobs",
                    queryPath: "/jobs/:task_id",
                    cancelPath: "/jobs/:task_id/cancel",
                    cancelMethod: "DELETE",
                    requestTemplate: '{"model":"{{model}}"}',
                    resultField: "data.url",
                },
                text: { capability: "video", createPath: "/invalid" },
            },
        } as never);

        expect(normalized?.operationConfigs).toEqual({
            video: expect.objectContaining({ capability: "video", protocol: "custom", createPath: "/jobs", cancelPath: "/jobs/:task_id/cancel", cancelMethod: "DELETE" }),
        });
    });

    it("keeps verified streaming and context-window settings", () => {
        const normalized = normalizeSystemChannelAdvancedConfig({ protocol: "openai", streaming: { enabled: true, path: "chat/completions", format: "sse" }, contextWindowTokens: 32_000 } as never);
        expect(normalized).toMatchObject({ streaming: { enabled: true, path: "/chat/completions", format: "sse" }, contextWindowTokens: 32_000 });
    });
});
