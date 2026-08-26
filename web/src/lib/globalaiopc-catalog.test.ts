import { describe, expect, it } from "vitest";

import { buildGlobalAiOpcImageRequest, buildGlobalAiOpcSelection, buildGlobalAiOpcVideoRequest, getGlobalAiOpcPreset, GLOBAL_AIOPC_PRESETS, resolveGlobalAiOpcCatalogPresets, resolveGlobalAiOpcPreset } from "./globalaiopc-catalog";

describe("GlobalAiOpc catalog", () => {
    it("registers the documented text, image, and video endpoint families", () => {
        expect(GLOBAL_AIOPC_PRESETS).toHaveLength(24);
        expect(getGlobalAiOpcPreset("image-gpt-image-2")).toMatchObject({ createPath: "/image2/images", queryPath: "/result/:task_id" });
        expect(getGlobalAiOpcPreset("video-seedance-discount")).toMatchObject({ createPath: "/seedance-discount/videos", queryPath: "/result/:task_id" });
        expect(getGlobalAiOpcPreset("video-seedance-x1")).toMatchObject({ createPath: "/seedance-x1/videos", queryPath: "/result/:task_id" });
        expect(getGlobalAiOpcPreset("video-happyhorse-edit")).toMatchObject({ createPath: "/happyhorse-edit/videos" });
        expect(resolveGlobalAiOpcPreset({ protocol: "globalaiopc", createPath: "/videos/videos" })).toMatchObject({ id: "video-videos" });
        expect(resolveGlobalAiOpcPreset({ protocol: "openai", createPath: "/videos/videos" })).toBeUndefined();
    });

    it("loads the complete vendor catalog from the documented media v1 base and routes each model to its preset", () => {
        const presets = resolveGlobalAiOpcCatalogPresets("https://zcbservice.aizfw.cn/kyyReactApiServer/v1", { protocol: "auto" });
        const selection = buildGlobalAiOpcSelection(presets.map((preset) => preset.id));
        const config = { protocol: "globalaiopc", globalAiOpcPresets: selection.presetIds };

        expect(selection.models).toEqual(expect.arrayContaining(["gpt-4.1", "gemini-3.1-pro-preview", "gpt-image-2", "happyhorse-1.0-i2v", "videos_stable", "videos_stable_fast"]));
        expect(selection.baseUrl).toBe("");
        expect(resolveGlobalAiOpcPreset(config, "gpt-4.1")).toMatchObject({ id: "text-openai-chat", createPath: "/chat/completions" });
        expect(resolveGlobalAiOpcPreset(config, "happyhorse-1.0-i2v")).toMatchObject({ id: "video-happyhorse-i2v", createPath: "/happyhorse-i2v/videos" });
        expect(resolveGlobalAiOpcPreset(config, "videos_stable_fast")).toMatchObject({ id: "video-videos", createPath: "/videos/videos" });
    });

    it("uses the documented image request fields", () => {
        const gptImage = getGlobalAiOpcPreset("image-gpt-image-2")!;
        const banana = getGlobalAiOpcPreset("image-nano-banana")!;
        const input = { model: "image-model", prompt: "test", quality: "high", ratio: "16:9", resolution: "2k", imageUrls: ["https://cdn.example.com/ref.png"] };

        expect(buildGlobalAiOpcImageRequest(gptImage, input)).toEqual({ model: "image-model", prompt: "test", image_urls: input.imageUrls, quality: "high", ratio: "16:9", resolution: "2k" });
        expect(buildGlobalAiOpcImageRequest(banana, input)).toEqual({ model: "image-model", prompt: "test", image_urls: input.imageUrls, resolution: "2k", size: "16:9" });
        expect(buildGlobalAiOpcImageRequest(gptImage, { model: "image-model", prompt: "test", imageUrls: [] })).toEqual({ model: "image-model", prompt: "test", image_urls: [] });
        expect(buildGlobalAiOpcImageRequest(banana, { model: "image-model", prompt: "test", imageUrls: [] })).toEqual({ model: "image-model", prompt: "test", image_urls: [] });
    });

    it("uses content entries for Seedance and endpoint-specific fields for Sora", () => {
        const input = {
            model: "video-model",
            prompt: "animate",
            duration: 5,
            ratio: "16:9",
            resolution: "720p",
            images: ["https://cdn.example.com/ref.png"],
            videos: ["https://cdn.example.com/ref.mp4"],
            audios: ["https://cdn.example.com/ref.mp3"],
            generateAudio: true,
        };

        expect(buildGlobalAiOpcVideoRequest(getGlobalAiOpcPreset("video-seedance-special")!, input)).toMatchObject({
            model: "video-model",
            duration: 5,
            content: [
                { type: "text", text: "animate" },
                { type: "image_url", role: "reference_image", image_url: { url: input.images[0] } },
                { type: "video_url", role: "reference_video", video_url: { url: input.videos[0] } },
                { type: "audio_url", role: "reference_audio", audio_url: { url: input.audios[0] } },
            ],
        });
        expect(buildGlobalAiOpcVideoRequest(getGlobalAiOpcPreset("video-sora")!, input)).toEqual({ model: "video-model", prompt: "animate", aspect_ratio: "16:9", seconds: 5, input_reference: input.images });
    });

    it("keeps explicit first and last frame roles in Seedance content", () => {
        const request = buildGlobalAiOpcVideoRequest(getGlobalAiOpcPreset("video-seedance-special")!, {
            model: "video-model",
            prompt: "animate",
            duration: 5,
            ratio: "16:9",
            resolution: "720p",
            images: [],
            videos: [],
            audios: [],
            generateAudio: true,
            firstFrame: "https://cdn.example.com/first.png",
            lastFrame: "https://cdn.example.com/last.png",
        });

        expect(request).toMatchObject({
            content: [
                { type: "text", text: "animate" },
                { type: "image_url", role: "first_frame", image_url: { url: "https://cdn.example.com/first.png" } },
                { type: "image_url", role: "last_frame", image_url: { url: "https://cdn.example.com/last.png" } },
            ],
        });
    });

    it("keeps each video family on its documented request fields", () => {
        const input = { model: "video-model", prompt: "animate", duration: 5, ratio: "16:9", resolution: "720p", images: ["https://cdn.example.com/ref.png"], videos: [], audios: [], generateAudio: false };

        expect(buildGlobalAiOpcVideoRequest(getGlobalAiOpcPreset("video-omni-flash")!, input)).toEqual({ model: "video-model", prompt: "animate", seconds: "5", aspect_ratio: "16:9", resolution: "720p" });
        expect(buildGlobalAiOpcVideoRequest(getGlobalAiOpcPreset("video-sd2-manxue")!, input)).toEqual({ model: "video-model", prompt: "animate", duration: 5, ratio: "16:9" });
        expect(buildGlobalAiOpcVideoRequest(getGlobalAiOpcPreset("video-happyhorse-t2v")!, input)).toEqual({ model: "video-model", prompt: "animate", duration: 5, ratio: "16:9", resolution: "720P", seed: 0 });
        expect(buildGlobalAiOpcVideoRequest(getGlobalAiOpcPreset("video-seedance-x1")!, input)).toEqual({
            model: "video-model",
            resolution: "720p",
            ratio: "16:9",
            duration: 5,
            content: [
                { type: "text", text: "animate" },
                { type: "image_url", role: "first_frame", image_url: { url: input.images[0] } },
            ],
        });
        expect(buildGlobalAiOpcVideoRequest(getGlobalAiOpcPreset("video-videos")!, input)).toEqual({ model: "video-model", prompt: "animate", duration: 5, ratio: "16:9", resolution: "720p", referenceImages: input.images });
        expect(buildGlobalAiOpcVideoRequest(getGlobalAiOpcPreset("video-videos")!, { ...input, images: [] })).toEqual({ model: "video-model", prompt: "animate", duration: 5, ratio: "16:9", resolution: "720p" });
    });
});
