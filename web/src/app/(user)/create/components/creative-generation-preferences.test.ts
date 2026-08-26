import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { normalizePositiveInteger, normalizePositiveNumber, normalizeVideoQuality } from "@/components/creative-generation-preference-fields";
import { generationPreferenceSummary, generationRatioOptions, generationResolutionOptions, normalizeGenerationCount } from "@/components/creative-generation-preferences";

describe("generationPreferenceSummary", () => {
    it("keeps image, video and audio settings readable in one compact label", () => {
        expect(generationPreferenceSummary("image", {})).toBe("智能参数");
        expect(generationPreferenceSummary("video", { video: { size: "16:9", quality: "2160", seconds: 60, count: 3, generateAudio: false, watermark: true } })).toBe("16:9 · 2160P · 60秒 · 无声 · 带水印 · 3条");
        expect(generationPreferenceSummary("image", { image: { size: "1024x1536", quality: "high", count: 2 } })).toBe("1024×1536 · 高画质 · 2张");
        expect(generationPreferenceSummary("image", { image: { size: "2048x1152", quality: "high" } })).toBe("2K 16:9 · 高画质");
        expect(generationPreferenceSummary("image", { image: { size: "3840x2160", quality: "auto" } })).toBe("4K 16:9 · 智能画质");
        expect(generationPreferenceSummary("audio", { audio: { voice: "nova", format: "wav", speed: 1.25 } })).toBe("Nova · WAV · 1.25x");
        expect(generationPreferenceSummary("video", {})).toBe("智能参数 · 5秒 · 有声 · 无水印");
    });

    it("accepts custom generation counts within the server contract", () => {
        expect(normalizeGenerationCount("6")).toBe(6);
        expect(normalizeGenerationCount(10)).toBe(10);
        expect(normalizeGenerationCount(11)).toBe(11);
        expect(normalizeGenerationCount("0")).toBe(0);
        expect(normalizeGenerationCount("6份")).toBe(0);
    });

    it("accepts open-ended video and audio values without inventing capability ceilings", () => {
        expect(normalizeVideoQuality(" 8K ")).toBe("8K");
        expect(normalizePositiveInteger(60)).toBe(60);
        expect(normalizePositiveInteger(1.5)).toBe(0);
        expect(normalizePositiveNumber(8)).toBe(8);
        expect(normalizePositiveNumber(0)).toBe(0);
    });

    it("keeps intelligent ratio and quality available when a model declares fixed capabilities", () => {
        expect(generationRatioOptions("image", { aspectRatios: ["9:16"] }).map((option) => option.value)).toEqual(["auto", "9:16", "1152x2048", "2160x3840"]);
        expect(generationResolutionOptions("video", { resolutions: ["1080P"] }).map((option) => option.value)).toEqual(["auto", "1080P"]);
    });

    it("keeps high-resolution image presets for a declared image ratio", () => {
        expect(generationRatioOptions("image", { aspectRatios: ["16:9"] }).map((option) => option.value)).toEqual(["auto", "16:9", "2048x1152", "3840x2160"]);
    });

    it("exposes the same positive custom pixel editor for images and videos", async () => {
        const source = await readFile(resolve(process.cwd(), "src/components/creative-generation-preferences.tsx"), "utf8");

        expect(source).toContain('aria-label={`打开${capability === "image" ? "图片" : "视频"}自定义像素尺寸`}');
        expect(source).toContain("<CustomMediaSizeEditor capability={capability}");
        expect(source).toContain('`自定义${capability === "image" ? "图片" : "视频"}宽度`');
        expect(source).toContain('`自定义${capability === "image" ? "图片" : "视频"}高度`');
    });

    it("offers explicit 2K and 4K image size presets without treating them as custom sizes", async () => {
        const source = await readFile(resolve(process.cwd(), "src/components/creative-generation-preferences.tsx"), "utf8");

        expect(source).toContain('{ value: "2048x1152", label: "2K 16:9"');
        expect(source).toContain('{ value: "1152x2048", label: "2K 9:16"');
        expect(source).toContain('{ value: "3840x2160", label: "4K 16:9"');
        expect(source).toContain('{ value: "2160x3840", label: "4K 9:16"');
        expect(source).toContain("高分辨率");
        expect(source).toContain("grid-cols-4 gap-1");
        expect(source).toContain("grid-cols-3 gap-1");
        expect(source).toContain("!isPresetMediaSize(capability, selectedSize)");
    });

    it("keeps media type above the canvas and output parameter tabs", async () => {
        const source = await readFile(resolve(process.cwd(), "src/components/creative-generation-preferences.tsx"), "utf8");

        expect(source.indexOf("availableCapabilities.map")).toBeLessThan(source.indexOf("<PreferencePanel"));
        expect(source.indexOf("画面")).toBeLessThan(source.indexOf("输出"));
        expect(source.indexOf("比例")).toBeLessThan(source.indexOf("自定义像素尺寸"));
    });
});
