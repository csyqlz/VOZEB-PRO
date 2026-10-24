import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CreativeRunBillingDetails } from "./creative-run-billing";

describe("CreativeRunBillingDetails", () => {
    it("separates settled model charges, auxiliary text and unsettled holds", () => {
        const markup = renderToStaticMarkup(
            <CreativeRunBillingDetails
                modelNames={
                    new Map([
                        ["image-model", "绘图模型"],
                        ["text-model", "文本模型"],
                    ])
                }
                summary={{
                    chargedPoints: 24.5,
                    refundedPoints: 4.5,
                    actualPoints: 20,
                    pendingHeldPoints: 8,
                    charges: [
                        { type: "image", purpose: "generation", logicalModelId: "image-model", chargedPoints: 23.5, refundedPoints: 4.5, actualPoints: 19 },
                        { type: "text", purpose: "planning", logicalModelId: "text-model", chargedPoints: 1, refundedPoints: 0, actualPoints: 1 },
                    ],
                    pending: [{ type: "video", logicalModelId: "image-model", heldPoints: 8, count: 1 }],
                }}
            />,
        );

        expect(markup).toContain("已结净额");
        expect(markup).toContain("20 积分");
        expect(markup).toContain("绘图模型 · 图片生成");
        expect(markup).toContain("文本模型 · 文本规划");
        expect(markup).toContain("已退 4.5");
        expect(markup).toContain("未结预留");
        expect(markup).toContain("8 积分");
        expect(markup).toContain("预留未计入已结净额");
        expect(markup).not.toContain("28 积分");
    });
});
