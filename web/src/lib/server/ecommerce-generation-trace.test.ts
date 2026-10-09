import { describe, expect, it } from "vitest";

import { buildEcommerceGenerationTrace, normalizeEcommerceGenerationTrace } from "./ecommerce-generation-trace";

describe("ecommerce generation observability trace", () => {
    it("records a failed analysis as failed with actual candidates rather than not_run", () => {
        const failure = {
            analysisVersion: "ecommerce-visual-analysis.v4",
            kind: "invalid_structure",
            attempts: [
                {
                    modelRole: { logicalRole: "vision_analysis", logicalModelId: "vision", channelId: "fixture", upstreamModel: "fixture" },
                    kind: "invalid_structure",
                    status: 502,
                    elapsedMs: 10,
                    validation: { rawAnalysis: { invalid: true, apiKey: "SECRET" }, issues: [{ code: "visual_field_invalid", path: "references[0]", message: "invalid" }], normalizationAudit: [] },
                },
            ],
        };
        const trace = buildEcommerceGenerationTrace({ runId: "run", task: { id: "task" } as never, snapshot: { visualAnalysisFailure: failure } as never, imageTaskIds: [], generationStatus: "needs_review", finalStatus: "needs_review" });
        expect(trace.stages[0]).toMatchObject({ status: "failed", model: { channelId: "fixture" }, output: { visualAnalysisFailure: { kind: "invalid_structure", attempts: [{ validation: { issues: [{ path: "references[0]" }] } }] } } });
        expect(JSON.stringify(trace)).not.toContain("SECRET");
        expect(normalizeEcommerceGenerationTrace(JSON.parse(JSON.stringify(trace)))?.stages[0]).toEqual(trace.stages[0]);
    });
    it("round-trips photography execution targets without adding them to a v4 trace", () => {
        const photography = {
            materials: [{ objectId: "cabinet", textureDirection: "纵向木纹", textureScale: "细木纹", roughness: "哑光", gloss: "低光泽" }],
            lighting: { keyLight: "柔光", fillLight: "弱补光", whiteBalance: "中性", contactShadow: "局部接触阴影" },
            composition: { focalSubject: "边柜", depth: "纵深", negativeSpace: "留白" },
        };
        const trace = buildEcommerceGenerationTrace({
            runId: "run",
            task: { id: "task", ecommerceExecution: { photography } } as never,
            snapshot: { plan: { planVersion: "ecommerce-edit.v5", photography } } as never,
            imageTaskIds: [],
            generationStatus: "completed",
            finalStatus: "completed",
        });
        expect(normalizeEcommerceGenerationTrace(JSON.parse(JSON.stringify(trace)))?.stages[2].output).toMatchObject({ photography });
        expect(trace.stages[1].output).toMatchObject({ photography });
        const old = buildEcommerceGenerationTrace({ runId: "run", task: { id: "task" } as never, snapshot: { plan: { planVersion: "ecommerce-edit.v4" } } as never, imageTaskIds: [], generationStatus: "completed", finalStatus: "completed" });
        expect(JSON.stringify(old)).not.toContain("photography");
    });
    it("preserves the snapshot rollout mode without manufacturing old trace modes", () => {
        const trace = buildEcommerceGenerationTrace({ runId: "run", task: { id: "task" } as never, snapshot: { mode: "shadow" } as never, imageTaskIds: [], generationStatus: "completed", finalStatus: "completed" });
        expect(normalizeEcommerceGenerationTrace(trace)?.mode).toBe("shadow");
        const { mode: _mode, ...old } = trace;
        expect(_mode).toBe("shadow");
        expect(normalizeEcommerceGenerationTrace(old)).not.toHaveProperty("mode");
    });
    it("round-trips independent QA and partial canvas evidence without inventing missing facts", () => {
        const quality = {
            status: "blocked",
            publicStatus: "needs_review",
            checks: [],
            hardFailures: [],
            observations: { baseline: { readable: true, visibleStructure: [] } },
            contradictions: [{ source: "plan", observedCount: 3, reportedCount: 2 }],
            sceneProtectionEvidence: [{ resultId: "result", evidence: { outsideMaskMatches: false } }],
            visionEvidence: { imageCount: 2, transmissions: [], images: [] },
            canvasEvidence: [{ resultId: "result", nativeStatus: "readable", nativeSize: { width: 1254, height: 1254 }, nativeMatches: false, storedStatus: "unavailable", storedMatches: null }],
        };
        const trace = buildEcommerceGenerationTrace({
            runId: "run",
            task: {
                id: "task",
                sceneProtection: { sourceAssetId: "scene", sourceSize: { width: 6, height: 4 }, targetRegion: { x: 2, y: 1, width: 2, height: 2 }, selectionSource: "user_selection", mask: { reference: { dataUrl: "data:SECRET" } } },
            } as never,
            snapshot: { qualityCheck: quality } as never,
            imageTaskIds: ["child"],
            generationStatus: "completed",
            finalStatus: "needs_review",
        });
        const restored = normalizeEcommerceGenerationTrace(JSON.parse(JSON.stringify(trace)))!;
        expect(restored.stages[3].output).toMatchObject(quality);
        expect(restored.stages[2].output).toMatchObject({ sceneProtection: { sourceAssetId: "scene", targetRegion: { x: 2, y: 1, width: 2, height: 2 } } });
        expect(JSON.stringify(restored)).not.toContain("SECRET");
        const old = buildEcommerceGenerationTrace({
            runId: "run",
            task: { id: "task" } as never,
            snapshot: { qualityCheck: { ...quality, canvasEvidence: [{ resultId: "old", nativeMatches: true, storedMatches: true }] } } as never,
            imageTaskIds: [],
            generationStatus: "completed",
            finalStatus: "needs_review",
        });
        expect(JSON.stringify(old.stages[3].output)).not.toContain("nativeStatus");
    });
    it("records validated outputs and actual model routes without raw media or credentials", () => {
        const trace = buildEcommerceGenerationTrace({
            runId: "agent-run-one",
            task: {
                id: "ecommerce-product-scene",
                productProtectionRegions: {
                    productAnchorId: "asset-product",
                    sourceAssetId: "asset-product",
                    sourceSize: { width: 1200, height: 1200 },
                    productCore: { rectangles: [{ x: 100, y: 120, width: 800, height: 700 }] },
                    fusionHalo: { rectangles: [{ x: 90, y: 110, width: 820, height: 720 }] },
                    editableBackground: {
                        rectangles: [{ x: 0, y: 0, width: 1200, height: 1200 }],
                        mask: { trust: "trusted", provider: "sharp", reference: { dataUrl: "data:image/png;base64,SECRET-MASK", apiKey: "secret" } },
                    },
                },
                ecommerceExecution: {
                    state: "ready",
                    compilerVersion: "ecommerce-openai-image-2.5.v1",
                    providerProfileId: "gpt-image-2.5-flare",
                    prompt: "保留商品主体并生成明亮客厅",
                    referenceRoles: [{ assetId: "asset-product", role: "product" }],
                    mask: { mode: "independent", required: true },
                    parameters: { variant: "gpt-image-2.5-flare" },
                    modelSnapshot: imageRoute(),
                },
            } as never,
            snapshot: {
                version: "ecommerce-generation.v1",
                mode: "active",
                input: { userRequest: "生成简约家居场景", assetIds: ["asset-product"], conversationId: "conversation", surface: "chat" },
                visualAnalysis: {
                    analysisVersion: "ecommerce-visual-analysis.v1",
                    references: [
                        {
                            assetId: "asset-product",
                            role: "product",
                            confidence: "high",
                            visualEvidence: { whiteBackground: true, transparentBackground: false, isolatedSubject: true, completeScene: false },
                            productFacts: { identity: "木质边柜", outline: "矩形柜体", color: "原木色", material: "木材", brandText: [], view: "正面" },
                            sceneFacts: null,
                            productCore: { x: 0.1, y: 0.1, width: 0.7, height: 0.7 },
                            fusionHalo: { x: 0.08, y: 0.08, width: 0.74, height: 0.74 },
                            editableTargets: [],
                        },
                    ],
                    modelRole: { logicalRole: "vision_analysis", logicalModelId: "gemini-vision", channelId: "gemini-channel", upstreamModel: "gemini-3.8-flash-high" },
                },
                plan: {
                    planVersion: "ecommerce-edit-plan.v1",
                    operation: "product_to_scene",
                    source: { productAnchorId: "asset-product", sceneReferenceIds: [] },
                    baseline: {
                        productFacts: { identity: "木质边柜", outline: "矩形柜体", color: "原木色", material: "木材", brandText: [], view: "正面" },
                        sceneFacts: { space: "", composition: "", lighting: "" },
                    },
                    delta: { requestedChanges: ["现代简约客厅"], targetObjects: [], targetRegions: ["background"] },
                    preserve: { productCore: ["identity", "outline", "color", "material", "proportions", "main_view"], sceneElements: [] },
                    strategy: "strict_product",
                    modelRoles: { visionAnalysis: "gemini-vision", editPlanning: "gpt-planner", generation: "flare", qualityCheck: "gemini-quality" },
                    continuity: { parentResultId: null, branchId: "branch-one" },
                    validation: { requiredChecks: ["product_identity", "product_silhouette"] },
                },
                modelRouteSnapshots: {
                    vision_analysis: { logicalRole: "vision_analysis", capability: "text", logicalModelId: "gemini-vision", channelId: "gemini-channel", upstreamModel: "gemini-3.8-flash-high", apiFormat: "gemini" },
                    edit_planning: { logicalRole: "edit_planning", capability: "text", logicalModelId: "gpt-planner", channelId: "gpt-channel", upstreamModel: "gpt-5.6-sol", apiFormat: "openai" },
                    image_generation: imageRoute(),
                    quality_check: qualityRoute(),
                },
                compilerVersion: "ecommerce-openai-image-2.5.v1",
                qualityCheck: {
                    version: "ecommerce-quality.v1",
                    status: "passed",
                    publicStatus: "passed",
                    modelRole: qualityRoute(),
                    checks: [{ resultId: "image-task-one", key: "product_identity", status: "passed", reason: "商品身份一致" }],
                    hardFailures: [],
                    internalReason: "all required checks passed",
                    checkedAt: 400,
                },
                stageTimings: { analysisCompletedAt: 200, planningCompletedAt: 300 },
                createdAt: 320,
            } as never,
            imageTaskIds: ["image-task-one"],
            generationStatus: "completed",
            finalStatus: "passed",
            recordedAt: 500,
        });

        expect(trace).toMatchObject({
            version: "ecommerce-generation-trace.v1",
            runId: "agent-run-one",
            imageTaskIds: ["image-task-one"],
            stages: [
                { key: "visual_analysis", status: "completed", model: { upstreamModel: "gemini-3.8-flash-high" }, completedAt: 200 },
                { key: "edit_planning", status: "completed", model: { upstreamModel: "gpt-5.6-sol" }, completedAt: 300 },
                { key: "image_generation", status: "completed", model: { upstreamModel: "gpt-image-2.5-flare" } },
                { key: "quality_check", status: "passed", model: { upstreamModel: "gemini-3.8-flash-high" }, completedAt: 400 },
            ],
            finalStatus: "passed",
        });
        expect(trace.stages[2]?.output).toMatchObject({ compilerVersion: "ecommerce-openai-image-2.5.v1", executionPrompt: "保留商品主体并生成明亮客厅", protection: { sourceSize: { width: 1200, height: 1200 }, maskProvider: "sharp" } });
        const serialized = JSON.stringify(trace);
        expect(serialized).not.toContain("SECRET-MASK");
        expect(serialized).not.toContain("data:image");
        expect(serialized).not.toContain("apiKey");
    });
});

function imageRoute() {
    return { logicalRole: "image_generation" as const, capability: "image" as const, logicalModelId: "flare", channelId: "image-channel", upstreamModel: "gpt-image-2.5-flare", apiFormat: "openai" as const };
}

function qualityRoute() {
    return { logicalRole: "quality_check" as const, capability: "text" as const, logicalModelId: "gemini-quality", channelId: "gemini-channel", upstreamModel: "gemini-3.8-flash-high", apiFormat: "gemini" as const };
}
