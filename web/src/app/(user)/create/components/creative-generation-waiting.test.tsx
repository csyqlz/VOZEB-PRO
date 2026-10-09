import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "antd";
import type { CreativeAgentRun } from "@/services/api/creative";

import { CreativeGenerationWaiting, creativeGenerationWaitingCopy, formatCreativeWaitingTime } from "./creative-generation-waiting";

describe("creative generation waiting", () => {
    it.each([
        ["confirm_purposes", "确认用途并继续"],
        ["retry_analysis", "重新分析"],
        ["retry_source", "重试并继续"],
    ])("offers the original paused run's %s reference recovery with its thumbnail", (kind, button) => {
        const run = {
            id: "run-original",
            status: "paused",
            tasks: [],
            ecommerceReferenceReview: {
                version: "ecommerce-reference-review.v1",
                reviewId: "review-one",
                kind,
                question: "请确认这次要修改的图片",
                assets: [{ assetId: "product", assetVersion: "version-one", alias: "图片1", previewUrl: "/api/reference-assets/product.png", purposes: ["edit_target", "product_identity"], allowedPurposes: ["edit_target", "product_identity"] }],
            },
        } as unknown as CreativeAgentRun;
        const markup = renderToStaticMarkup(
            <App>
                <CreativeGenerationWaiting run={run} message={{ content: "任务已暂停", createdAt: 1 }} onRecoverReference={async () => undefined} />
            </App>,
        );
        expect(markup).toContain(button);
        expect(markup).toContain("/api/reference-assets/product.png");
        expect(markup).toContain("图片1");
        expect(markup).not.toContain("已等待");
        expect(markup).not.toContain("animate-pulse");
    });

    it("offers owned scene selection without pretending a paused run is still generating", () => {
        const run = { id: "run", status: "paused", tasks: [], ecommerceSceneSelection: { action: "confirm_scene_selection", baselineAssetId: "scene", url: "/api/reference-assets/scene.png", width: 1254, height: 1254 } } as unknown as CreativeAgentRun;
        const markup = renderToStaticMarkup(
            <App>
                <CreativeGenerationWaiting run={run} message={{ content: "任务已暂停", createdAt: 1 }} onConfirmSceneSelection={async () => undefined} />
            </App>,
        );
        expect(markup).toContain("选择修改位置");
        expect(markup).toContain("待修改的原图");
        expect(markup).toContain("/api/reference-assets/scene.png");
        expect(markup).not.toContain("已等待");
        expect(markup).not.toContain("animate-pulse");
    });
    it("uses the real task phase before elapsed-time comfort copy", () => {
        expect(creativeGenerationWaitingCopy({ mode: "image", runStatus: "planning", progressText: "正在理解需求并选择合适的创作能力", elapsedSeconds: 180 })).toContain("画面的氛围和细节");
        expect(creativeGenerationWaitingCopy({ mode: "text", runStatus: "planning", progressText: "正在理解需求并选择合适的创作能力", elapsedSeconds: 180 })).toContain("想法理顺");
        expect(creativeGenerationWaitingCopy({ mode: "video", runStatus: "planning", progressText: "正在理解需求并选择合适的创作能力", elapsedSeconds: 180 })).toContain("镜头");
        expect(creativeGenerationWaitingCopy({ mode: "video", runStatus: "running", progressText: "连接暂时中断，正在确认后台任务状态", elapsedSeconds: 180 })).toContain("任务仍在后台继续");
        expect(creativeGenerationWaitingCopy({ mode: "image", runStatus: "running", progressText: "检查完成，正在整理结果", elapsedSeconds: 180 })).toContain("整理最后的细节");
    });

    it.each([false, true])("offers status recovery only when the original run has a server-proven checkable child (%s)", (canCheckStatus) => {
        const run = { id: "run-original", status: "paused", tasks: [{ id: "image", status: "needs_review", error: "参考图片暂时无法读取，请检查状态后继续原任务。" }], canCheckStatus } as unknown as CreativeAgentRun;
        const markup = renderToStaticMarkup(<CreativeGenerationWaiting run={run} message={{ content: "任务已暂停", createdAt: 1 }} {...{ onCheckStatus: async (_runId: string) => undefined }} />);
        expect(markup.includes("<button")).toBe(canCheckStatus);
        if (canCheckStatus) expect(markup).toContain("检查状态");
        expect(markup).not.toContain("已等待");
    });

    it("keeps the real ecommerce phase visible instead of replacing it with comfort copy", () => {
        expect(creativeGenerationWaitingCopy({ mode: "image", runStatus: "running", progressText: "正在识别商品", elapsedSeconds: 180 })).toBe("正在识别商品");
        expect(creativeGenerationWaitingCopy({ mode: "image", runStatus: "running", progressText: "正在规划场景", elapsedSeconds: 180 })).toBe("正在规划场景");
        expect(creativeGenerationWaitingCopy({ mode: "image", runStatus: "running", progressText: "正在生成图片", elapsedSeconds: 180 })).toBe("正在生成图片");
        expect(creativeGenerationWaitingCopy({ mode: "image", runStatus: "running", progressText: "正在检查商品细节", elapsedSeconds: 180 })).toBe("正在检查商品细节");
    });

    it("shows the actionable review reason when an ecommerce run pauses", () => {
        expect(
            creativeGenerationWaitingCopy({
                mode: "image",
                runStatus: "paused",
                progressText: "正在规划场景",
                reviewText: "请确认这张图片是商品图还是场景参考图。",
                elapsedSeconds: 5,
            }),
        ).toBe("请确认这张图片是商品图还是场景参考图。");
    });

    it("keeps an actionable paused progress message when run details have no task error", () => {
        expect(
            creativeGenerationWaitingCopy({
                mode: "image",
                runStatus: "paused",
                progressText: "请确认这张图片是商品图还是场景参考图。",
                elapsedSeconds: 5,
            }),
        ).toBe("请确认这张图片是商品图还是场景参考图。");
    });

    it("adapts the comfort copy by media type and natural elapsed minutes", () => {
        expect(creativeGenerationWaitingCopy({ mode: "image", runStatus: "running", progressText: "正在处理创作任务", elapsedSeconds: 20 })).toContain("画面正在一点点显现");
        expect(creativeGenerationWaitingCopy({ mode: "video", runStatus: "running", progressText: "正在处理创作任务", elapsedSeconds: 20 })).toContain("镜头正在一帧帧铺开");
        expect(creativeGenerationWaitingCopy({ mode: "video", runStatus: "running", progressText: "仍在上游处理中", elapsedSeconds: 60 })).toContain("慢慢铺开");
        expect(creativeGenerationWaitingCopy({ mode: "video", runStatus: "running", progressText: "仍在上游处理中", elapsedSeconds: 120 })).toContain("久等了");
        expect(creativeGenerationWaitingCopy({ mode: "video", runStatus: "running", progressText: "仍在上游处理中", elapsedSeconds: 180 })).toContain("一帧帧渲染");
    });

    it("formats the actual elapsed time without an artificial upper limit", () => {
        expect(formatCreativeWaitingTime(42)).toBe("42秒");
        expect(formatCreativeWaitingTime(72)).toBe("1分12秒");
        expect(formatCreativeWaitingTime(3_661)).toBe("1小时1分1秒");
    });
});
