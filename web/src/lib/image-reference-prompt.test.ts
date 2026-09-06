import { describe, expect, it } from "vitest";

import { buildImageReferencePromptText } from "./image-reference-prompt";

describe("buildImageReferencePromptText", () => {
    it("keeps the single-reference guidance concise", () => {
        const prompt = buildImageReferencePromptText("换成夜景", [{}]);

        expect(prompt).toContain("Reference images: 图片1");
        expect(prompt).not.toContain("多图合成规则");
    });

    it("explains how numbered references compose into one result", () => {
        const prompt = buildImageReferencePromptText("图片1作背景，图片2作文字，图片3作人物", [{}, {}, {}]);

        expect(prompt).toContain("图片1作背景、图片2提供文字、图片3提供人物");
        expect(prompt).toContain("不能只读取第一张");
    });
});
