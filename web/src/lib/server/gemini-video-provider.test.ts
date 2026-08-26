import { describe, expect, it } from "vitest";

import { assertGeminiVideoReferences, buildGeminiVideoRequest, geminiVideoCreatePath, normalizeGeminiVideoDuration, parseGeminiVideoCreateResponse, parseGeminiVideoOperation } from "./gemini-video-provider";

const firstImage = "data:image/png;base64,AQID";
const lastImage = "data:image/webp;base64,BAUG";

describe("Gemini Veo provider", () => {
    it("builds text-to-video parameters with supported duration tiers", async () => {
        const request = await buildGeminiVideoRequest({ prompt: "A quiet lake", durationSeconds: 5, aspectRatio: "16:9", resolution: "720p", generateAudio: true, references: [], origin: "http://localhost", cookie: "" });

        expect(request).toEqual({
            instances: [{ prompt: "A quiet lake" }],
            parameters: { durationSeconds: 6, aspectRatio: "16:9", resolution: "720p", generateAudio: true },
        });
        expect(normalizeGeminiVideoDuration(7)).toBe(8);
        expect(normalizeGeminiVideoDuration(10)).toBe(8);
        expect(geminiVideoCreatePath("models/veo-3.1-generate-preview")).toBe("/models/veo-3.1-generate-preview:predictLongRunning");
    });

    it("omits intelligent ratio and resolution instead of forcing fixed values", async () => {
        const request = await buildGeminiVideoRequest({ prompt: "A quiet lake", durationSeconds: 5, aspectRatio: "auto", resolution: "auto", generateAudio: true, references: [], origin: "http://localhost", cookie: "" });

        expect(request.parameters).toEqual({ durationSeconds: 6, generateAudio: true });
    });

    it("encodes ordinary references as referenceImages", async () => {
        const request = await buildGeminiVideoRequest({
            prompt: "Keep the product identity",
            durationSeconds: 8,
            aspectRatio: "9:16",
            resolution: "1080",
            generateAudio: false,
            references: [{ type: "image", role: "reference", url: firstImage }],
            origin: "http://localhost",
            cookie: "",
        });

        expect(request.instances[0]).toMatchObject({
            referenceImages: [{ image: { inlineData: { mimeType: "image/png", data: "AQID" } }, referenceType: "asset" }],
        });
    });

    it("keeps first and last frames in separate inlineData fields", async () => {
        const request = await buildGeminiVideoRequest({
            prompt: "Transition naturally",
            durationSeconds: 8,
            aspectRatio: "16:9",
            resolution: "1080p",
            generateAudio: true,
            references: [
                { type: "image", role: "first_frame", url: firstImage },
                { type: "image", role: "last_frame", url: lastImage },
            ],
            origin: "http://localhost",
            cookie: "",
        });

        expect(request.instances[0]).toMatchObject({
            image: { inlineData: { mimeType: "image/png", data: "AQID" } },
            lastFrame: { inlineData: { mimeType: "image/webp", data: "BAUG" } },
        });
    });

    it("parses the operation identity and completed video URI", () => {
        expect(parseGeminiVideoCreateResponse({ name: "models/veo-3.1-generate-preview/operations/operation-1" }, "veo-3.1-generate-preview")).toEqual({
            id: "operation-1",
            queryPath: "/models/veo-3.1-generate-preview/operations/operation-1",
            resultUrl: "",
            error: "",
        });
        expect(
            parseGeminiVideoOperation({
                done: true,
                response: { generateVideoResponse: { generatedSamples: [{ video: { uri: "https://cdn.example.com/video.mp4" } }] } },
            }),
        ).toEqual({ state: "succeeded", status: "completed", resultUrl: "https://cdn.example.com/video.mp4" });
    });

    it("distinguishes pending and failed operations", () => {
        expect(parseGeminiVideoOperation({ name: "models/veo/operations/one", done: false })).toEqual({ state: "pending", status: "processing" });
        expect(parseGeminiVideoOperation({ done: true, error: { code: 400, message: "invalid prompt" } })).toEqual({ state: "failed", status: "failed", error: "invalid prompt" });
        expect(parseGeminiVideoOperation({ done: true })).toEqual({ state: "failed", status: "failed", error: "Gemini Veo 任务已完成但没有返回视频地址" });
    });

    it("rejects reference video and audio before submission", () => {
        expect(() => assertGeminiVideoReferences([{ type: "video", role: "reference", url: "https://cdn.example.com/reference.mp4" }])).toThrow("参考视频");
        expect(() => assertGeminiVideoReferences([{ type: "audio", role: "reference", url: "https://cdn.example.com/reference.mp3" }])).toThrow("参考音频");
    });
});
