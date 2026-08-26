import { describe, expect, it } from "vitest";

import { CreativeRuntimeInputError, isCreativeProjectHandoff, normalizeCreativeRunRequest } from "./creative-runtime-contract";

describe("normalizeCreativeRunRequest", () => {
    it("normalizes a chat request and deduplicates assets", () => {
        expect(
            normalizeCreativeRunRequest({
                clientRequestId: " req-1 ",
                surface: "chat",
                prompt: " @图片1 hello ",
                publicPrompt: " 图片1 hello ",
                assetIds: ["a", "a", "b"],
                skillIds: ["character-design", "character-design"],
                modelIds: [" image-pro ", "image-pro", "video-pro"],
            }),
        ).toEqual({
            clientRequestId: "req-1",
            surface: "chat",
            prompt: "@图片1 hello",
            publicPrompt: "图片1 hello",
            assetIds: ["a", "b"],
            skillIds: ["character-design"],
            modelIds: ["image-pro", "video-pro"],
        });
    });

    it("normalizes explicit media mode, size and quality preferences", () => {
        expect(
            normalizeCreativeRunRequest({
                clientRequestId: "req-2",
                surface: "chat",
                prompt: "生成一条产品视频",
                assetIds: [],
                skillIds: [],
                modelIds: [],
                preferences: {
                    mode: "video",
                    image: { size: " 1024 × 1536 ", quality: "high", count: 12 },
                    video: { size: " 9：16 ", quality: " 2160P ", seconds: 10, count: 12, generateAudio: false, watermark: true },
                    audio: { voice: " nova ", format: " wav ", speed: 1.25 },
                },
            }),
        ).toMatchObject({
            preferences: {
                mode: "video",
                image: { size: "1024x1536", quality: "high", count: 12 },
                video: { size: "9:16", quality: "2160", seconds: 10, count: 12, generateAudio: false, watermark: true },
                audio: { voice: "nova", format: "wav", speed: 1.25 },
            },
        });
    });

    it("keeps all explicitly selected asset IDs instead of silently truncating them", () => {
        const assetIds = Array.from({ length: 24 }, (_, index) => `asset-${index}`);
        expect(normalizeCreativeRunRequest({ clientRequestId: "req-many-assets", surface: "chat", prompt: "继续使用这些素材", assetIds, skillIds: [], modelIds: [] }).assetIds).toEqual(assetIds);
    });

    it("normalizes explicit video first and last frame preferences", () => {
        expect(
            normalizeCreativeRunRequest({
                clientRequestId: "req-frames",
                surface: "chat",
                prompt: "让首尾画面自然衔接",
                assetIds: ["first-image", "last-image"],
                skillIds: [],
                modelIds: [],
                preferences: {
                    mode: "video",
                    video: {
                        referenceMode: "first_last",
                        firstFrameAssetId: "first-image",
                        lastFrameAssetId: "last-image",
                    },
                },
            }),
        ).toMatchObject({
            preferences: {
                mode: "video",
                video: {
                    referenceMode: "first_last",
                    firstFrameAssetId: "first-image",
                    lastFrameAssetId: "last-image",
                },
            },
        });
    });

    it.each([
        [{ referenceMode: "first_frame" }, ["first-image"], "首帧模式需要选择首帧图片"],
        [{ referenceMode: "first_last", firstFrameAssetId: "first-image" }, ["first-image"], "首尾帧模式需要同时选择首帧和尾帧图片"],
        [{ referenceMode: "first_last", firstFrameAssetId: "same-image", lastFrameAssetId: "same-image" }, ["same-image"], "首帧和尾帧不能使用同一张图片"],
        [{ referenceMode: "first_frame", firstFrameAssetId: "missing-image" }, ["other-image"], "视频首尾帧必须来自本轮已选择的图片素材"],
    ])("rejects invalid video frame preferences", (video, assetIds, message) => {
        expect(() =>
            normalizeCreativeRunRequest({
                clientRequestId: "req-invalid-frames",
                surface: "chat",
                prompt: "生成视频",
                assetIds,
                skillIds: [],
                modelIds: [],
                preferences: { mode: "video", video },
            }),
        ).toThrow(message);
    });

    it("requires projects for canvas and drama", () => {
        expect(() => normalizeCreativeRunRequest({ clientRequestId: "x", surface: "canvas", prompt: "draw" })).toThrow("画布标识不能为空");
        expect(() => normalizeCreativeRunRequest({ clientRequestId: "x", surface: "drama", prompt: "write" })).toThrow("短剧项目标识不能为空");
    });

    it("rejects project state on chat and oversized snapshots", () => {
        expect(() => normalizeCreativeRunRequest({ clientRequestId: "x", surface: "chat", projectId: "p", prompt: "hello" })).toThrow("普通对话不接受项目或快照");
        try {
            normalizeCreativeRunRequest({ clientRequestId: "x", surface: "canvas", projectId: "p", prompt: "draw", snapshot: { value: "x".repeat(513 * 1024) } });
            throw new Error("expected validation error");
        } catch (error) {
            expect(error).toBeInstanceOf(CreativeRuntimeInputError);
            expect((error as CreativeRuntimeInputError).status).toBe(413);
        }
    });

    it("allows an oversized drama client snapshot when the server can hydrate by project ID", () => {
        expect(
            normalizeCreativeRunRequest({
                clientRequestId: "drama-large",
                surface: "drama",
                projectId: "drama-project",
                prompt: "继续当前剧本",
                snapshot: { script: "x".repeat(513 * 1024) },
            }),
        ).toMatchObject({ surface: "drama", projectId: "drama-project" });
    });
});

describe("isCreativeProjectHandoff", () => {
    it("accepts complete handoffs and rejects incomplete event payloads", () => {
        expect(
            isCreativeProjectHandoff({
                id: "handoff-one",
                sourceRunId: "run-one",
                conversationId: "conversation-one",
                surface: "canvas",
                title: "品牌画布",
                summary: "整理当前内容",
                assetIds: [],
                assets: [],
            }),
        ).toBe(true);
        expect(isCreativeProjectHandoff({ id: "handoff-one", surface: "canvas", title: "品牌画布", assets: [] })).toBe(false);
    });
});
