import { describe, expect, it } from "vitest";

import { normalizeCanvasImageDecomposition } from "./canvas-image-decomposition";

const normalize = (value: Record<string, unknown>, width: number, height: number) => normalizeCanvasImageDecomposition({ strategy: "ecommerce", ...value }, width, height);

describe("canvas image decomposition", () => {
    it("keeps ecommerce products, copy, logos, badges and decorations as separate layers", () => {
        const result = normalize(
            {
                backgroundDescription: "蓝色渐变背景",
                backgroundPreservedVisuals: ["柔和渐变", "环境光影"],
                layers: [
                    layer("product", "商品组合", 220, 180, 480, 600, 3),
                    layer("headline", "主标题", 40, 40, 500, 100, 5),
                    layer("logo", "品牌 Logo", 820, 40, 120, 80, 7),
                    layer("badge", "促销角标", 760, 240, 180, 160, 6),
                    layer("decoration", "棉花装饰", 20, 540, 200, 300, 1),
                ],
            },
            1000,
            1000,
        );

        expect(result?.layers.map((item) => item.kind)).toEqual(["decoration", "product", "headline", "badge", "logo"]);
        expect(result?.backgroundDescription).toBe("蓝色渐变背景");
        expect(result?.backgroundPreservedVisuals).toEqual(["柔和渐变", "环境光影"]);
        expect(result?.layers.find((item) => item.kind === "headline")).toMatchObject({ kind: "headline", bbox: { x: 40, y: 40, width: 500, height: 100 } });
    });

    it("clamps model boxes to source pixels and removes duplicate visual slices", () => {
        const result = normalize(
            {
                layers: [layer("product", "商品", -10, 20, 80, 120, 1), layer("foreground", "重复商品", 0, 20, 70, 120, 2)],
            },
            100,
            100,
        );

        expect(result?.layers).toHaveLength(1);
        expect(result?.layers[0].bbox).toEqual({ x: 0, y: 20, width: 70, height: 80 });
    });

    it("merges touching physical boxes into one movable subject", () => {
        const result = normalize(
            {
                layers: [layer("product", "盒体", 20, 20, 40, 40, 1), layer("foreground", "相连配件", 60, 30, 20, 20, 2), layer("product", "独立商品", 120, 20, 30, 30, 3)],
            },
            200,
            100,
        );

        expect(result?.layers).toHaveLength(2);
        expect(result?.layers[0]).toMatchObject({ kind: "product", name: "盒体、相连配件", bbox: { x: 20, y: 20, width: 60, height: 40 } });
    });

    it("merges one semantic asset group even when model boxes do not touch", () => {
        const first = { ...layer("product", "盒体", 20, 20, 40, 40, 1), groupId: "product-main", focusPoints: [{ x: 35, y: 35 }] };
        const second = { ...layer("decoration", "相连提手", 72, 20, 20, 20, 2), groupId: "product-main", focusPoints: [{ x: 82, y: 30 }] };
        const result = normalize({ layers: [first, second] }, 200, 100);

        expect(result?.layers).toHaveLength(1);
        expect(result?.layers[0]).toMatchObject({
            kind: "product",
            name: "盒体、相连提手",
            groupId: "product-main",
            bbox: { x: 20, y: 20, width: 72, height: 40 },
            regions: [first.bbox, second.bbox],
            focusPoints: [first.focusPoints[0], second.focusPoints[0]],
        });
    });

    it("merges touching physical subjects even when the model returned inconsistent group ids", () => {
        const first = { ...layer("product", "左侧商品", 20, 20, 40, 40, 1), groupId: "product-left" };
        const second = { ...layer("product", "右侧商品", 60, 20, 40, 40, 2), groupId: "product-right" };

        expect(normalize({ layers: [first, second] }, 120, 80)?.layers).toHaveLength(1);
    });

    it("keeps one nearby text block together instead of splitting individual glyphs", () => {
        const result = normalize({ layers: [layer("headline", "巾", 20, 20, 20, 24, 1), layer("headline", "净", 44, 20, 20, 24, 2), layer("headline", "另一行", 20, 58, 44, 24, 3)] }, 200, 100);

        expect(result?.layers).toHaveLength(2);
        expect(result?.layers[0]).toMatchObject({ name: "巾、净", bbox: { x: 20, y: 20, width: 44, height: 24 } });
    });

    it("keeps text as an independent visual layer when it overlaps an image asset", () => {
        const result = normalize(
            {
                layers: [layer("foreground", "活动底图", 10, 20, 80, 40, 1), layer("headline", "限时特惠", 10, 20, 80, 40, 2)],
            },
            100,
            100,
        );

        expect(result?.layers).toEqual([expect.objectContaining({ kind: "foreground" }), expect.objectContaining({ kind: "headline" })]);
    });

    it("rejects a whole-poster box masquerading as one foreground layer", () => {
        expect(normalize({ layers: [layer("product", "整张海报", 0, 0, 1000, 1000, 1)] }, 1000, 1000)).toBeNull();
    });

    it("treats a missing preserved-visual list as empty at the untrusted model boundary", () => {
        expect(normalize({ layers: [layer("product", "商品", 20, 20, 60, 60, 1)] }, 100, 100)?.backgroundPreservedVisuals).toEqual([]);
    });

    it("keeps a text layer without OCR metadata because text is rendered as a transparent bitmap", () => {
        expect(normalize({ layers: [{ id: "headline", kind: "headline", name: "标题", bbox: { x: 10, y: 10, width: 80, height: 20 }, zIndex: 1 }] }, 100, 100)?.layers).toEqual([expect.objectContaining({ kind: "headline", name: "标题" })]);
    });

    it("drops a whole-poster box without hiding the valid independent layers", () => {
        const result = normalize(
            {
                layers: [layer("foreground", "整张海报", 0, 0, 1000, 1000, 0), layer("logo", "品牌 Logo", 800, 40, 120, 80, 1)],
            },
            1000,
            1000,
        );

        expect(result?.layers).toEqual([expect.objectContaining({ kind: "logo", bbox: { x: 800, y: 40, width: 120, height: 80 } })]);
    });

    it("requires a subject layer so every split uses the upstream image workflow", () => {
        expect(normalizeCanvasImageDecomposition({ strategy: "subject", backgroundDescription: "室内背景", backgroundPreservedVisuals: [], layers: [] }, 800, 1200)).toBeNull();
        expect(normalizeCanvasImageDecomposition({ strategy: "subject", backgroundDescription: "室内背景", backgroundPreservedVisuals: [], layers: [layer("person", "人物", 80, 120, 520, 900, 1)] }, 800, 1200)?.layers).toEqual([
            expect.objectContaining({ kind: "person", name: "人物" }),
        ]);
    });

    it("requires an explicit image-level strategy", () => {
        expect(normalizeCanvasImageDecomposition({ layers: [layer("person", "人物", 10, 10, 80, 80, 1)] }, 100, 100)).toBeNull();
    });
});

function layer(kind: string, name: string, x: number, y: number, width: number, height: number, zIndex: number) {
    return {
        id: `${kind}-${zIndex}`,
        kind,
        name,
        bbox: { x, y, width, height },
        zIndex,
        confidence: 0.9,
    };
}
