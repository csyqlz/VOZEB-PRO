import { describe, expect, it } from "vitest";

import { normalizeVideoAspectRatio, normalizeVideoSize, resolveUpstreamVideoDuration, resolveVideoGenerationParameters, withVideoReferenceFidelity } from "./video-task-config";

describe("resolveVideoGenerationParameters", () => {
    const defaults = { imageSize: "9:16", videoQuality: "1080", videoSeconds: 10 };

    it("uses backend defaults when video parameters are missing", () => {
        expect(resolveVideoGenerationParameters({}, defaults)).toEqual({ size: "9:16", vquality: "1080", videoSeconds: 10 });
    });

    it("keeps explicit video parameters and channel flags", () => {
        expect(resolveVideoGenerationParameters({ size: "1:1", vquality: "480", videoSeconds: "6", videoGenerateAudio: "false", videoWatermark: "true" }, defaults)).toEqual({
            size: "1:1",
            vquality: "480",
            videoSeconds: 6,
            videoGenerateAudio: "false",
            videoWatermark: "true",
        });
    });

    it("treats blank or invalid values as missing", () => {
        expect(resolveVideoGenerationParameters({ size: " ", vquality: "", videoSeconds: 0 }, defaults)).toEqual({ size: "9:16", vquality: "1080", videoSeconds: 10 });
    });

    it("keeps the explicit intelligent duration option", () => {
        expect(resolveVideoGenerationParameters({ videoSeconds: "-1" }, defaults).videoSeconds).toBe(-1);
    });

    it("keeps intelligent ratio and resolution instead of applying fixed defaults", () => {
        expect(resolveVideoGenerationParameters({ size: "auto", vquality: "auto" }, defaults)).toEqual({ size: "auto", vquality: "auto", videoSeconds: 10 });
    });

    it("does not impose a platform duration ceiling before provider normalization", () => {
        expect(resolveVideoGenerationParameters({ videoSeconds: "60" }, defaults).videoSeconds).toBe(60);
    });

    it("selects the first supported duration that is not shorter than the request", () => {
        expect(resolveUpstreamVideoDuration(7, 5, { durationRange: "5、8、10 秒" })).toBe(8);
        expect(resolveUpstreamVideoDuration(12, 5, { durationRange: "5、8、10 秒" })).toBe(10);
    });

    it("clamps continuous provider ranges and uses five seconds by default", () => {
        expect(resolveUpstreamVideoDuration(undefined, 0, { durationRange: "4-15 秒" })).toBe(5);
        expect(resolveUpstreamVideoDuration(3, 5, { durationRange: "4-15 秒" })).toBe(4);
        expect(resolveUpstreamVideoDuration(7, 5, { durationRange: "4-15 秒" })).toBe(7);
        expect(resolveUpstreamVideoDuration(20, 5, { durationRange: "4-15 秒" })).toBe(15);
    });

    it("keeps intelligent duration only when the provider declares it", () => {
        expect(resolveUpstreamVideoDuration(-1, 5, { durationRange: "4-15 秒" })).toBe(5);
        expect(resolveUpstreamVideoDuration(-1, 5, { durationRange: "-1 智能或 5-15 秒" })).toBe(-1);
    });

    it("keeps exact pixel dimensions while exposing a normalized ratio separately", () => {
        expect(normalizeVideoAspectRatio("1280x720")).toBe("16:9");
        expect(normalizeVideoAspectRatio("720 × 1280")).toBe("9:16");
        expect(normalizeVideoSize("720 × 1280")).toBe("720x1280");
        expect(resolveVideoGenerationParameters({ size: "1024x1024" }, defaults).size).toBe("1024x1024");
        expect(resolveVideoGenerationParameters({ size: "1280x720" }, defaults).size).toBe("1280x720");
    });

    it("adds a server-side subject fidelity constraint for visual references", () => {
        const prompt = withVideoReferenceFidelity("让人物自然挥手", [{ type: "image", url: "https://cdn.example.com/reference.png" }]);

        expect(prompt).toContain("让人物自然挥手");
        expect(prompt).toContain("将参考图作为首帧、主体身份、外观和场景的主要依据");
        expect(prompt).toContain("禁止替换主体");
    });

    it("does not change text-to-video or duplicate the fidelity constraint", () => {
        expect(withVideoReferenceFidelity("生成海边日落", [])).toBe("生成海边日落");
        const once = withVideoReferenceFidelity("让镜头缓慢推进", [{ type: "video", url: "https://cdn.example.com/reference.mp4" }]);
        expect(withVideoReferenceFidelity(once, [{ type: "video", url: "https://cdn.example.com/reference.mp4" }])).toBe(once);
    });
});
