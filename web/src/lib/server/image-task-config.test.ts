import { describe, expect, it } from "vitest";

import { resolveImageGenerationCount, resolveImageTaskOptions } from "./image-task-config";

describe("resolveImageTaskOptions", () => {
    const defaults = { imageQuality: "high", imageSize: "9:16" };

    it("uses backend defaults when image parameters are missing", () => {
        expect(resolveImageTaskOptions({}, defaults)).toEqual({ quality: "high", size: "9:16" });
    });

    it("keeps explicit image parameters", () => {
        expect(resolveImageTaskOptions({ quality: "medium", size: "1:1" }, defaults)).toEqual({ quality: "medium", size: "1:1" });
    });

    it("keeps only the explicit transparent output mode", () => {
        expect(resolveImageTaskOptions({ outputBackground: "transparent" }, defaults)).toEqual({ quality: "high", size: "9:16", outputBackground: "transparent" });
        expect(resolveImageTaskOptions({ outputBackground: "unknown" }, defaults)).toEqual({ quality: "high", size: "9:16" });
    });

    it("keeps only the explicit layer output mode", () => {
        expect(resolveImageTaskOptions({ outputMode: "layers" }, defaults)).toEqual({ quality: "high", size: "9:16", outputMode: "layers" });
        expect(resolveImageTaskOptions({ outputMode: "unknown" }, defaults)).toEqual({ quality: "high", size: "9:16" });
    });

    it("treats blank image parameters as missing", () => {
        expect(resolveImageTaskOptions({ quality: " ", size: "" }, defaults)).toEqual({ quality: "high", size: "9:16" });
    });
});

describe("resolveImageGenerationCount", () => {
    it("keeps the effective backend or user count without an unconfigured cap", () => {
        expect(resolveImageGenerationCount("3")).toBe(3);
        expect(resolveImageGenerationCount(20)).toBe(20);
        expect(resolveImageGenerationCount(0)).toBe(1);
    });
});
