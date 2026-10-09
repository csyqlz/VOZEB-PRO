import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GenerationLogDetail } from "./admin-generation-log";

describe("GenerationLogDetail ecommerce observability", () => {
    it("renders the four ecommerce execution stages and their actual models", () => {
        const markup = renderToStaticMarkup(
            <GenerationLogDetail
                log={
                    {
                        id: "log-one",
                        userId: "user-one",
                        username: "creator",
                        displayName: "创作者",
                        kind: "image",
                        source: "agent",
                        status: "success",
                        title: "商品场景图",
                        prompt: "生成简约家居场景",
                        model: "flare",
                        summary: "完成",
                        durationMs: 1000,
                        count: 1,
                        successCount: 1,
                        failCount: 0,
                        assets: [],
                        createdAt: "2026-09-25T00:00:00.000Z",
                        updatedAt: "2026-09-25T00:00:01.000Z",
                        ecommerceTrace: {
                            version: "ecommerce-generation-trace.v1",
                            runId: "agent-run-one",
                            agentTaskId: "ecommerce-product-scene",
                            imageTaskIds: ["image-task-one"],
                            stages: [
                                { key: "visual_analysis", status: "completed", model: { upstreamModel: "gemini-3.8-flash-high" }, output: { references: [] } },
                                { key: "edit_planning", status: "completed", model: { upstreamModel: "gpt-5.6-sol" }, output: { operation: "product_to_scene" } },
                                { key: "image_generation", status: "completed", model: { upstreamModel: "gpt-image-2.5-flare" }, output: { compilerVersion: "ecommerce-openai-image-2.5.v1" } },
                                {
                                    key: "quality_check",
                                    status: "blocked",
                                    model: { upstreamModel: "gemini-3.8-flash-high" },
                                    output: {
                                        checks: [],
                                        observations: { baseline: { readable: true } },
                                        contradictions: [{ observedCount: 3, reportedCount: 2 }],
                                        sceneProtectionEvidence: [{ outsideMaskMatches: false }],
                                        canvasEvidence: [{ nativeStatus: "readable", nativeSize: { width: 1254, height: 1254 }, nativeMatches: false, storedStatus: "unavailable", storedMatches: null }],
                                    },
                                },
                            ],
                            finalStatus: "needs_review",
                            recordedAt: 500,
                        },
                    } as never
                }
            />,
        );

        expect(markup).toContain("视觉分析");
        expect(markup).toContain("编辑规划");
        expect(markup).toContain("图片生成");
        expect(markup).toContain("结果验收");
        expect(markup).toContain("gpt-image-2.5-flare");
        expect(markup).toContain("gemini-3.8-flash-high");
        expect(markup).toContain("agent-run-one");
        const evidence = markup.replaceAll("&quot;", '"');
        expect(evidence).toContain('"storedMatches": null');
        expect(evidence).toContain('"nativeMatches": false');
        expect(evidence).toContain('"observedCount": 3');
        expect(evidence).toContain('"outsideMaskMatches": false');
        expect(evidence).not.toContain('"storedSize"');
    });
});
