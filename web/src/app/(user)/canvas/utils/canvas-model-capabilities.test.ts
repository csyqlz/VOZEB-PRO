import { describe, expect, it } from "vitest";

import { defaultConfig } from "@/stores/use-config-store";

import { canvasModelCapabilityProfile, canvasModelConfigPatch } from "./canvas-model-capabilities";

describe("canvas model capabilities", () => {
    const config = {
        ...defaultConfig,
        model: "old",
        size: "1:1",
        quality: "auto",
        vquality: "720",
        videoSeconds: "5",
        count: "4",
        logicalModels: [
            {
                id: "image-model",
                name: "图片模型",
                capability: "image" as const,
                enabled: true,
                bindings: [{ id: "image-binding", channelId: "channel", upstreamModel: "image", enabled: true, priority: 1, capabilityProfile: { aspectRatios: ["9:16"], resolutions: ["2K"], maxBatchSize: 2 } }],
            },
            {
                id: "video-model",
                name: "视频模型",
                capability: "video" as const,
                enabled: true,
                bindings: [{ id: "video-binding", channelId: "channel", upstreamModel: "video", enabled: true, priority: 1, capabilityProfile: { aspectRatios: ["16:9"], resolutions: ["1080"], durationSeconds: [8] } }],
            },
        ],
    };

    it("reads the union profile for the selected logical model", () => {
        expect(canvasModelCapabilityProfile(config, "image-model")).toEqual({ aspectRatios: ["9:16"], resolutions: ["2K"], maxBatchSize: 2 });
    });

    it("reconciles image and video parameters with the selected model", () => {
        expect(canvasModelConfigPatch(config, "image-model", "image")).toEqual({ model: "image-model", size: "9:16", quality: "auto", count: 2 });
        expect(canvasModelConfigPatch(config, "video-model", "video")).toEqual({ model: "video-model", size: "16:9", vquality: "1080", seconds: "8" });
    });

    it("does not turn intelligent Canvas parameters into the first fixed model option", () => {
        expect(canvasModelConfigPatch({ ...config, size: "auto", quality: "auto", vquality: "auto" }, "image-model", "image")).toEqual({ model: "image-model", size: "auto", quality: "auto", count: 2 });
        expect(canvasModelConfigPatch({ ...config, size: "auto", quality: "auto", vquality: "auto" }, "video-model", "video")).toEqual({ model: "video-model", size: "auto", vquality: "auto", seconds: "8" });
    });
});
