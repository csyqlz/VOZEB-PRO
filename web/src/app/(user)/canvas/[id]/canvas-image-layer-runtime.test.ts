import { describe, expect, it } from "vitest";

import { canvasEcommerceBackgroundPrompt, canvasEcommerceElementPrompt, runCanvasImageLayerTaskBatch } from "./canvas-image-layer-runtime";

describe("Canvas 电商分层任务编排", () => {
    it("keeps the complete source reference and starts every task before awaiting any result", async () => {
        const source = { id: "source", name: "source.png", type: "image/png", dataUrl: "/source.png" };
        const plans = ["product", "headline", "background"];
        const started: string[] = [];
        const resolvers: Array<() => void> = [];

        const pending = runCanvasImageLayerTaskBatch(plans, source, async (plan, reference) => {
            started.push(`${plan}:${reference.dataUrl}`);
            await new Promise<void>((resolve) => resolvers.push(resolve));
            return plan;
        });

        expect(started).toEqual(["product:/source.png", "headline:/source.png", "background:/source.png"]);
        expect(resolvers).toHaveLength(plans.length);
        resolvers.forEach((resolve) => resolve());
        await expect(pending).resolves.toEqual(plans.map((value) => ({ status: "fulfilled", value })));
    });

    it("carries each element's source coordinates into the image prompt", () => {
        const decomposition = {
            strategy: "ecommerce" as const,
            width: 1200,
            height: 800,
            backgroundDescription: "浅色渐变背景",
            backgroundPreservedVisuals: ["地面阴影"],
            layers: [
                {
                    id: "product-1",
                    name: "主商品",
                    kind: "product" as const,
                    bbox: { x: 120, y: 80, width: 360, height: 420 },
                    zIndex: 1,
                    focusPoints: [{ x: 240, y: 280 }],
                },
            ],
        };

        expect(canvasEcommerceElementPrompt(decomposition.layers[0], decomposition)).toContain("x=120, y=80, width=360, height=420");
        expect(canvasEcommerceElementPrompt(decomposition.layers[0], decomposition)).toContain("原图完整宽高和原坐标");
        expect(canvasEcommerceBackgroundPrompt(decomposition)).toContain("主商品[x=120,y=80,width=360,height=420]");
        expect(canvasEcommerceBackgroundPrompt(decomposition)).toContain("地面阴影");
    });
});
