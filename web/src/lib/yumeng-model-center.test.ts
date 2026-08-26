import { describe, expect, it } from "vitest";

import { assertYumengVideoReferences, buildYumengImageRequest, buildYumengVideoRequest, resolveYumengImageResolution, YUMENG_MODEL_CENTER_MODELS } from "./yumeng-model-center";

describe("Yumeng model center contracts", () => {
    it("uses only the model IDs published by the current documentation navigation", () => {
        const ids = YUMENG_MODEL_CENTER_MODELS.map((model) => model.id);
        expect(ids).toHaveLength(26);
        expect(ids).toEqual(expect.arrayContaining(["seedream_5.0Pro", "seedream-5.0", "seedance-2.5-c1", "sd_2.0_fast_special", "videos_933_c1", "KlingO3"]));
        expect(ids).not.toEqual(expect.arrayContaining(["seedance-2.5", "seedance-2.5-c2", "videos_stable", "videos_stable_fast", "minimax-h3"]));
        expect(YUMENG_MODEL_CENTER_MODELS.every((model) => model.operation.createPath === "/kyyReactApiServer/v2/model-center/tasks")).toBe(true);
    });

    it("builds the two documented image payloads without leaking unsupported fields", () => {
        expect(resolveYumengImageResolution("seedream_5.0Pro", "high")).toBe("2K");
        expect(resolveYumengImageResolution("seedream-5.0", "high")).toBe("4K");
        expect(resolveYumengImageResolution("seedream-5.0", "auto")).toBeUndefined();
        expect(buildYumengImageRequest({ model: "seedream-5.0", prompt: "智能构图", images: [] })).toEqual({ model: "seedream-5.0", prompt: "智能构图", watermark: false });
        expect(
            buildYumengImageRequest({
                model: "seedream_5.0Pro",
                prompt: "海边产品照",
                images: [],
                aspectRatio: "1:1",
                resolution: "1K",
                size: "1024x1024",
            }),
        ).toEqual({ model: "seedream_5.0Pro", prompt: "海边产品照", aspect_ratio: "1:1", resolution: "1K", watermark: false });
        expect(
            buildYumengImageRequest({
                model: "seedream-5.0",
                prompt: "保持主体重绘",
                images: ["https://cdn.example.com/reference.png"],
                aspectRatio: "16:9",
                resolution: "4K",
                size: "1920x1080",
            }),
        ).toEqual({
            model: "seedream-5.0",
            prompt: "保持主体重绘",
            reference_images: ["https://cdn.example.com/reference.png"],
            aspect_ratio: "16:9",
            resolution: "4K",
            size: "1920x1080",
            watermark: false,
        });
    });

    it("builds the documented Seedance 2 multimodal payload", () => {
        const payload = buildVideo("sd_2.0_fast_special", {
            images: ["https://cdn.example.com/reference.png"],
            videos: ["https://cdn.example.com/reference.mp4"],
            audios: ["https://cdn.example.com/reference.mp3"],
        });
        expect(payload).toMatchObject({
            model: "sd_2.0_fast_special",
            duration: 5,
            aspect_ratio: "16:9",
            resolution: "720p",
            seed: "-1",
            generate_audio: "true",
            tools: [],
            watermark: "false",
        });
        expect(payload).not.toHaveProperty("first_image");
    });

    it.each([
        ["seedance_1_5_pro_1080p", { images: ["https://cdn.example.com/first.png"] }, { size: "16:9", first_image: "https://cdn.example.com/first.png" }],
        ["videos_933_c1", { firstFrame: "https://cdn.example.com/first.png", lastFrame: "https://cdn.example.com/last.png" }, { reference_mode: "frame", reference_images: ["https://cdn.example.com/first.png", "https://cdn.example.com/last.png"] }],
        ["happyhorse-1.0-i2v", { images: ["https://cdn.example.com/first.png"] }, { first_image: "https://cdn.example.com/first.png", resolution: "720P" }],
        ["happyhorse-1.0-r2v", { images: ["https://cdn.example.com/reference.png"] }, { reference_images: ["https://cdn.example.com/reference.png"], resolution: "720P" }],
        ["wan2.7-i2v", { firstFrame: "https://cdn.example.com/first.png", lastFrame: "https://cdn.example.com/last.png" }, { first_image: "https://cdn.example.com/first.png", last_image: "https://cdn.example.com/last.png" }],
        ["wan2.7-videoedit", { videos: ["https://cdn.example.com/reference.mp4"] }, { reference_videos: ["https://cdn.example.com/reference.mp4"], audio_setting: true }],
        ["KlingO3", { firstFrame: "https://cdn.example.com/first.png" }, { model: "KlingO3", first_image: "https://cdn.example.com/first.png", reference_mode: "frame" }],
    ])("builds the documented %s request shape", (model, references, expected) => {
        expect(buildVideo(model, references)).toMatchObject(expected);
    });

    it("rejects invalid reference combinations before creating an upstream task", () => {
        expect(() => assertYumengVideoReferences("sd_2.0_fast_special", [{ type: "audio", url: "https://cdn.example.com/reference.mp3" }])).toThrow("参考音频不能单独使用");
        expect(() =>
            assertYumengVideoReferences("sd_2.0_fast_special", [
                { type: "image", url: "https://cdn.example.com/reference.png" },
                { type: "image", role: "first_frame", url: "https://cdn.example.com/first.png" },
            ]),
        ).toThrow("不能同时使用");
        expect(() => assertYumengVideoReferences("happyhorse-1.0-i2v", [])).toThrow("需要一张首帧图片");
        expect(() => assertYumengVideoReferences("wan2.7-i2v", [{ type: "image", role: "first_frame", url: "https://cdn.example.com/first.png" }])).toThrow("需要首帧和尾帧");
        expect(() => assertYumengVideoReferences("wan2.7-videoedit", [])).toThrow("需要参考视频");
    });
});

function buildVideo(model: string, references: Partial<Pick<Parameters<typeof buildYumengVideoRequest>[0], "images" | "videos" | "audios" | "firstFrame" | "lastFrame">> = {}) {
    return buildYumengVideoRequest({
        model,
        prompt: "电影感产品镜头",
        duration: 5,
        aspectRatio: "16:9",
        resolution: "720p",
        generateAudio: true,
        watermark: false,
        images: references.images || [],
        videos: references.videos || [],
        audios: references.audios || [],
        firstFrame: references.firstFrame,
        lastFrame: references.lastFrame,
    });
}
