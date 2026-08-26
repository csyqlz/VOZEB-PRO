import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it } from "vitest";

import { canvasResourceMentionAtCursor, CanvasResourceMentionText } from "./canvas-resource-mention-textarea";

describe("Canvas resource mention preview", () => {
    it("opens mentions after existing Chinese prompt text and punctuation", () => {
        const afterText = "生成一张海报@图";
        const afterPunctuation = "保持人物一致，@视";
        const afterDigits = "222@";
        expect(canvasResourceMentionAtCursor(afterText, afterText.length)).toEqual({ start: 6, end: 8, query: "图" });
        expect(canvasResourceMentionAtCursor(afterPunctuation, afterPunctuation.length)).toEqual({ start: 7, end: 9, query: "视" });
        expect(canvasResourceMentionAtCursor(afterDigits, afterDigits.length)).toEqual({ start: 3, end: 4, query: "" });
    });

    it("renders an image thumbnail for a referenced image label", () => {
        const markup = renderToStaticMarkup(
            <CanvasResourceMentionText
                value="请参考 图片1 继续创作"
                references={[
                    {
                        id: "image-1",
                        nodeId: "image-1",
                        kind: "image",
                        label: "图片1",
                        title: "参考图片",
                        previewUrl: "/reference.png",
                        active: true,
                    },
                ]}
            />,
        );

        expect(markup).toContain('data-canvas-resource-reference="image-1"');
        expect(markup).toContain("参考图片");
        expect(markup).toContain("图片1");
        expect(markup).toContain("<img");
    });
});
