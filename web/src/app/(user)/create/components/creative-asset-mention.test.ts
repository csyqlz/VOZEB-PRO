import { describe, expect, it } from "vitest";

import type { CreativeAsset } from "@/lib/creative-runtime-contract";

import { creativeAssetMentionAtCursor, creativeAssetMentionCandidates, creativeAssetMentionDeletionAtKey, creativeAssetMentionSegments, publicCreativeAssetPrompt, remapCreativeAssetReferences, replaceCreativeAssetMention } from "./creative-asset-mention";

describe("creative asset mentions", () => {
    it("finds a mention at the current caret without treating email text as a reference", () => {
        expect(creativeAssetMentionAtCursor("请参考 @商品", 7)).toEqual({ start: 4, end: 7, query: "商品" });
        expect(creativeAssetMentionAtCursor("保持主体@商品", 7)).toEqual({ start: 4, end: 7, query: "商品" });
        expect(creativeAssetMentionAtCursor("222@", 4)).toEqual({ start: 3, end: 4, query: "" });
    });

    it("replaces the query with a stable visible reference token", () => {
        expect(replaceCreativeAssetMention("请让 @商品", 6, "图片1")).toEqual({ value: "请让 @图片1 ", cursor: 8 });
        expect(replaceCreativeAssetMention("@图，保持背景", 2, "图片2")).toEqual({ value: "@图片2，保持背景", cursor: 4 });
        expect(replaceCreativeAssetMention("@图书店收购价格", 2, "图片3")).toEqual({ value: "@图片3 书店收购价格", cursor: 5 });
    });

    it("keeps execution references internal while preserving readable public instructions", () => {
        expect(publicCreativeAssetPrompt("@图片1 生成男孩子，@视频1 生成女孩子")).toBe("图片1 生成男孩子，视频1 生成女孩子");
    });

    it("renumbers visible aliases by stable asset identity after a reference is removed", () => {
        const assets = [asset("first", "第一张"), asset("second", "第二张")];
        expect(remapCreativeAssetReferences("@图片1 保持人物，@图片2 改成夜景", assets, ["first", "second"], ["second"])).toBe("保持人物，@图片1 改成夜景");
    });

    it("keeps every matching ready asset without a quantity cutoff", () => {
        const assets = Array.from({ length: 24 }, (_, index) => asset(`asset-${index}`, `商品图 ${index}`));
        assets.push({ ...asset("failed", "商品图失败"), status: "failed" });

        expect(creativeAssetMentionCandidates(assets, "商品图")).toHaveLength(24);
        expect(creativeAssetMentionCandidates(assets, " 23").map((item) => item.id)).toEqual(["asset-23"]);
    });

    it("only renders tokens backed by the current stable references", () => {
        expect(creativeAssetMentionSegments("@图片1保持人物，@图片2改成夜景", new Map([["first", "图片1"]]))).toEqual([
            { text: "@图片1", referenced: true, assetId: "first" },
            { text: "保持人物，", referenced: false },
            { text: "@图片2", referenced: false },
            { text: "改成夜景", referenced: false },
        ]);
    });

    it("deletes a stable reference atomically", () => {
        const aliases = new Map([
            ["first", "图片1"],
            ["second", "图片2"],
        ]);
        const value = "@图片1 保持人物，@图片2改成夜景";

        expect(creativeAssetMentionDeletionAtKey(value, 4, 4, "Backspace", aliases)).toEqual({ assetId: "first", cursor: 0 });
        expect(creativeAssetMentionDeletionAtKey(value, 11, 13, "Delete", aliases)).toEqual({ assetId: "second", cursor: 10 });
    });
});

function asset(id: string, title: string): CreativeAsset {
    return {
        id,
        userId: "user",
        conversationId: "conversation",
        ordinal: 0,
        type: "image",
        status: "ready",
        title,
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
    };
}
