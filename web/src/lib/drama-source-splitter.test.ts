import { describe, expect, it } from "vitest";

import { splitDramaSource } from "./drama-source-splitter";

describe("splitDramaSource", () => {
    it("uses chapter headings as episode boundaries", () => {
        const result = splitDramaSource("第一章 归来\n她推开门。\n\n第二章 真相\n门后没有人。", 4000);

        expect(result).toHaveLength(2);
        expect(result[0]).toMatchObject({ title: "第 1 集 · 第一章 归来", sourceRange: "第一章 归来" });
        expect(result[1].script).toContain("第二章 真相");
    });

    it("chunks unstructured long text without losing content", () => {
        const source = ["第一段".repeat(200), "第二段".repeat(200), "第三段".repeat(200)].join("\n\n");
        const result = splitDramaSource(source, 800);

        expect(result.length).toBeGreaterThan(1);
        expect(result.map((item) => item.script).join("\n\n")).toBe(source);
    });

    it("keeps source content and episode sections beyond the former fixed boundaries", () => {
        const chapters = Array.from({ length: 105 }, (_, index) => `第${index + 1}章\n第 ${index + 1} 章正文`).join("\n\n");
        const longSource = `${"长".repeat(500_000)}结尾`;

        const chapterDrafts = splitDramaSource(chapters, 4000);
        const longDrafts = splitDramaSource(longSource, 600_000);

        expect(chapterDrafts).toHaveLength(105);
        expect(chapterDrafts.at(-1)?.script).toContain("第 105 章正文");
        expect(longDrafts).toHaveLength(1);
        expect(longDrafts[0]?.script).toBe(longSource);
    });

    it("keeps each detected chapter as one episode even when it exceeds the fallback target", () => {
        const source = [`第 1 章 归来\n${"甲".repeat(1200)}`, `第2章 真相\n${"乙".repeat(1400)}`].join("\n\n");
        const result = splitDramaSource(source, 100);

        expect(result).toHaveLength(2);
        expect(result[0]?.sourceRange).toBe("第 1 章 归来");
        expect(result[1]?.sourceRange).toBe("第2章 真相");
        expect(result[0]?.script).toContain("甲".repeat(1200));
        expect(result[1]?.script).toContain("乙".repeat(1400));
    });

    it("uses the caller's positive split target without platform clamping", () => {
        expect(splitDramaSource("甲".repeat(201), 100).map((item) => item.script.length)).toEqual([100, 100, 1]);
        expect(splitDramaSource("乙".repeat(13_000), 20_000)).toHaveLength(1);
    });
});
