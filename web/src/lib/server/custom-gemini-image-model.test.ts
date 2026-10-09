import { describe, expect, it } from "vitest";

import { customGeminiImageModelParts, resolveCustomGeminiImageModel } from "./custom-gemini-image-model";

const MODEL = "gemini-3.1-flash-image";

describe("custom Gemini image model variants", () => {
    it.each(["1:1", "16:9", "9:16", "21:9", "4:3", "3:4"])("encodes the documented %s ratio", (ratio) => {
        expect(resolveCustomGeminiImageModel(MODEL, "4K", ratio)).toBe(`${MODEL}-4k-${ratio.replace(":", "x")}`);
    });

    it.each([
        ["auto", "auto", MODEL],
        ["low", "auto", MODEL],
        ["medium", "auto", `${MODEL}-2k`],
        ["high", "auto", `${MODEL}-4k`],
        ["auto", "3840x2160", `${MODEL}-4k-16x9`],
        ["auto", "2160x3840", `${MODEL}-4k-9x16`],
        ["auto", "2048x2048", `${MODEL}-2k-1x1`],
        ["high", "4096x1756", `${MODEL}-4k-21x9`],
    ])("maps quality %s and size %s without inventing an automatic ratio", (quality, size, expected) => {
        expect(resolveCustomGeminiImageModel(MODEL, quality, size)).toBe(expected);
    });

    it("preserves explicit model variants and unrelated models", () => {
        for (const model of [`${MODEL}-4k-16x9`, "gemini-3.1-flash-image-preview", "gpt-image-2"]) {
            expect(resolveCustomGeminiImageModel(model, "2K", "9:16")).toBe(model);
        }
    });

    it("recognizes only documented variant suffixes for routing", () => {
        expect(customGeminiImageModelParts(`models/${MODEL}-4k-21x9`)).toEqual({ baseModel: MODEL, resolution: "4k", ratio: "21x9" });
        for (const model of [`${MODEL}-8k`, `${MODEL}-4k-3x2`, `${MODEL}-preview`, "gemini-3.8-flash-high"]) expect(customGeminiImageModelParts(model)).toBeUndefined();
    });
});
