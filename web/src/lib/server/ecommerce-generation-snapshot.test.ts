import { describe, expect, it } from "vitest";

import { buildEcommercePlanningInput, ecommerceShadowPlanningEnabled, legacyPlanFallback, recordEcommerceGenerationSnapshot, type EcommerceGenerationSnapshot } from "./ecommerce-generation-snapshot";
import { publicAgentRun } from "./agent-run-public";
import type { AgentRun } from "./agent-run-store";
import type { EcommerceEditPlan } from "./ecommerce-edit-plan";

describe("ecommerce generation shadow snapshot", () => {
    it("freezes nullable quality routing and deterministic technical evidence without inventing QA", () => {
        const snapshot: EcommerceGenerationSnapshot = {
            version: "ecommerce-generation.v1",
            mode: "active",
            qualityPolicy: "disabled",
            createdAt: 1,
            input: { userRequest: "edit", assetIds: ["scene"], conversationId: "fixture", surface: "chat" },
            modelRoles: { visionAnalysis: "vision", editPlanning: "planner", generation: "image", qualityCheck: null },
            technicalCheck: {
                version: "ecommerce-technical.v1",
                status: "passed",
                checks: [{ resultId: "result", key: "stored_media", status: "passed", source: "media", reason: "decoded" }],
                hardFailures: [],
                canvasEvidence: [],
                sceneProtectionEvidence: [],
                checkedAt: 1,
            },
        };
        const original = structuredClone(snapshot);
        const saved = recordEcommerceGenerationSnapshot({ id: "run", userId: "user" }, snapshot);
        snapshot.modelRoles!.qualityCheck = "changed";
        snapshot.technicalCheck!.checks[0].reason = "changed";
        expect(saved.modelRoles).toEqual(original.modelRoles);
        expect(saved.technicalCheck).toEqual(original.technicalCheck);
        expect(saved.qualityCheck).toBeUndefined();
        expect(JSON.parse(JSON.stringify(saved))).toMatchObject({ qualityPolicy: "disabled", modelRoles: { qualityCheck: null } });
    });
    it("freezes inherited image identities and actual failed visual evidence", () => {
        const snapshot: EcommerceGenerationSnapshot = {
            version: "ecommerce-generation.v1",
            mode: "active",
            createdAt: 1,
            input: { userRequest: "continue", assetIds: ["scene", "product"], conversationId: "fixture", surface: "chat", inheritedReferences: { editTargetId: "scene", productAnchorId: "product" } },
            visualAnalysisFailure: {
                analysisVersion: "ecommerce-visual-analysis.v4",
                kind: "invalid_structure",
                attempts: [
                    {
                        modelRole: { logicalRole: "vision_analysis", logicalModelId: "vision", channelId: "fixture", upstreamModel: "fixture" },
                        kind: "invalid_structure",
                        status: 502,
                        elapsedMs: 10,
                        validation: { rawAnalysis: { invalid: true }, issues: [{ code: "visual_field_invalid", path: "references[0]", message: "invalid" }], normalizationAudit: [] },
                    },
                ],
            },
        };
        const original = structuredClone(snapshot);
        const saved = recordEcommerceGenerationSnapshot({ id: "run", userId: "user" }, snapshot);
        snapshot.input.inheritedReferences!.editTargetId = "other";
        snapshot.visualAnalysisFailure!.attempts[0].validation!.issues[0].path = "other";
        (snapshot.visualAnalysisFailure!.attempts[0].validation!.rawAnalysis as Record<string, unknown>).invalid = false;
        expect(saved.input).toEqual(original.input);
        expect(saved.visualAnalysisFailure).toEqual(original.visualAnalysisFailure);
    });
    it("isolates server reference decisions and frozen aliases from later mutation", () => {
        const snapshot = {
            version: "ecommerce-generation.v1",
            mode: "active",
            createdAt: 1,
            input: { userRequest: "edit", assetIds: ["target"], conversationId: "conversation", surface: "chat", referenceAliases: [{ assetId: "target", alias: "图片1" }] },
            referenceDecision: {
                version: "ecommerce-reference-decision.v1",
                state: "resolved",
                bindings: [{ assetId: "target", alias: "图片1", purposes: ["edit_target", "product_identity"], source: "explicit" }],
                editTargetId: "target",
                productAnchorId: "target",
                currentSceneBaselineId: null,
                appliedCues: [{ assetId: "target", purpose: "lighting", cueIds: ["light"] }],
                issues: [{ code: "fixture", path: "references[0]", message: "fixture" }],
            },
        } as EcommerceGenerationSnapshot;
        const original = structuredClone(snapshot);
        const saved = recordEcommerceGenerationSnapshot({ id: "run", userId: "user" }, snapshot);
        snapshot.referenceDecision!.bindings[0].purposes.length = 0;
        snapshot.referenceDecision!.appliedCues[0].cueIds.push("other");
        snapshot.referenceDecision!.issues[0].message = "changed";
        snapshot.input.referenceAliases![0].alias = "图片9";
        expect(saved.referenceDecision).toEqual(original.referenceDecision);
        expect(saved.input.referenceAliases).toEqual(original.input.referenceAliases);
    });
    it("isolates partial native and stored media evidence in the immutable QA snapshot", () => {
        const snapshot: EcommerceGenerationSnapshot = {
            version: "ecommerce-generation.v1",
            mode: "active",
            input: { userRequest: "edit", assetIds: ["scene"], conversationId: "fixture", surface: "chat" },
            createdAt: 1,
            qualityCheck: {
                version: "ecommerce-quality.v2",
                status: "blocked",
                publicStatus: "needs_review",
                modelRole: { logicalRole: "quality_check", capability: "text", logicalModelId: "quality", channelId: "fixture", upstreamModel: "fixture", apiFormat: "openai" },
                checks: [{ resultId: "fixture-result", key: "canvas_geometry", status: "failed", source: "media", reason: "native=120x120;stored=unavailable" }],
                hardFailures: [{ resultId: "fixture-result", key: "canvas_geometry", status: "failed", source: "media", reason: "native=120x120;stored=unavailable" }],
                internalReason: "fixture",
                checkedAt: 1,
                canvasEvidence: [
                    {
                        resultId: "fixture-result",
                        constraint: { mode: "exact", size: { width: 120, height: 160 }, source: "baseline", allowReframe: false },
                        nativeUrl: "/api/generation-log-assets/fixture-native.png",
                        storedUrl: "/api/generation-log-assets/fixture-stored.png",
                        nativeSize: { width: 120, height: 120 },
                        nativeStatus: "readable",
                        storedStatus: "unavailable",
                        nativeMatches: false,
                        storedMatches: null,
                        hardFailures: ["canvas_geometry"],
                    },
                ],
            },
        };
        const original = structuredClone(snapshot.qualityCheck);
        const saved = recordEcommerceGenerationSnapshot({ id: "fixture-run", userId: "fixture-user" }, snapshot);
        snapshot.qualityCheck!.canvasEvidence![0].nativeSize!.width = 999;
        snapshot.qualityCheck!.canvasEvidence![0].hardFailures.length = 0;
        snapshot.qualityCheck!.hardFailures[0].reason = "changed";
        expect(saved.qualityCheck).toEqual(original);
        expect(saved.qualityCheck!.canvasEvidence![0]).not.toHaveProperty("storedSize");
    });
    it("isolates nested analysis size and transport evidence in the immutable snapshot", () => {
        const snapshot: EcommerceGenerationSnapshot = {
            version: "ecommerce-generation.v1",
            mode: "active",
            input: { userRequest: "edit", assetIds: ["scene"], conversationId: "fixture", surface: "chat" },
            createdAt: 1,
            visualAnalysis: {
                analysisVersion: "ecommerce-visual-analysis.v2",
                modelRole: { logicalRole: "vision_analysis", logicalModelId: "vision", channelId: "fixture", upstreamModel: "fixture" },
                references: [
                    {
                        assetId: "scene",
                        role: "scene",
                        confidence: "high",
                        visualEvidence: { whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: true },
                        productFacts: null,
                        sceneFacts: { space: "room", composition: "front", lighting: "soft" },
                        productCore: null,
                        fusionHalo: null,
                        editableTargets: [],
                        visibleStructure: [],
                        sourceSize: { width: 120, height: 160 },
                    },
                ],
                visionEvidence: { imageCount: 1, transmissions: [{ protocol: "chat", bodyBytes: 100, maxBytes: 200 }] },
            },
        };
        const original = structuredClone(snapshot);
        const saved = recordEcommerceGenerationSnapshot({ id: "fixture-run", userId: "fixture-user" }, snapshot);
        snapshot.visualAnalysis!.references[0].sourceSize!.width = 999;
        snapshot.visualAnalysis!.visionEvidence!.transmissions[0].bodyBytes = 999;
        expect(saved.visualAnalysis).toEqual(original.visualAnalysis);
    });
    it.each(["ecommerce-edit.v3", "ecommerce-edit.v4", "ecommerce-edit.v5"] as const)("preserves %s local protection and canvas when the planner object is mutated after recording", (planVersion) => {
        const plan: EcommerceEditPlan = {
            planVersion,
            operation: "scene_edit",
            source: { productAnchorId: null, currentSceneBaselineId: "scene", sceneReferenceIds: [] },
            baseline: { productFacts: null, sceneFacts: { space: "room", composition: "front", lighting: "soft" } },
            canvas: { mode: "exact", size: { width: 6, height: 4 }, source: "baseline", allowReframe: false },
            protection: { scope: "local", protectedObjectIds: ["cabinet"], preserveOutsideMask: true, allowLightingChange: false },
            delta: { requestedChanges: ["add vase"], targetObjects: ["vase"], targetRegions: ["cabinet top"] },
            preserve: { productCore: [], sceneElements: ["room"] },
            strategy: "integrated_scene",
            modelRoles: { visionAnalysis: "vision", editPlanning: "planner", generation: "image", qualityCheck: "quality" },
            continuity: { branchId: "branch", parentResultId: null },
            validation: { requiredChecks: ["outside_mask"] },
        };
        if (planVersion === "ecommerce-edit.v5")
            plan.photography = {
                materials: [{ objectId: "cabinet", textureDirection: "纵向木纹", textureScale: "细木纹", roughness: "哑光", gloss: "低光泽" }],
                lighting: { keyLight: "柔光", fillLight: "弱补光", whiteBalance: "中性", contactShadow: "局部接触阴影" },
                composition: { focalSubject: "边柜", depth: "纵深", negativeSpace: "留白" },
            };
        const original = structuredClone(plan);
        const snapshot = recordEcommerceGenerationSnapshot(
            { id: "run", userId: "user" },
            { version: "ecommerce-generation.v1", mode: "active", input: { userRequest: "add vase", assetIds: ["scene"], conversationId: "conversation", surface: "chat" }, plan, createdAt: 1 },
        );
        plan.protection!.protectedObjectIds.push("new object");
        plan.protection!.preserveOutsideMask = false;
        plan.canvas!.size.width = 12;
        plan.delta.requestedChanges.push("change lighting");
        if (plan.photography) plan.photography.materials[0].gloss = "changed";
        expect(snapshot.plan).toEqual(original);
        if (planVersion !== "ecommerce-edit.v5") expect(snapshot.plan).not.toHaveProperty("photography");
    });

    it("keeps shadow planning disabled unless the rollout mode explicitly enables it", () => {
        expect(ecommerceShadowPlanningEnabled(undefined)).toBe(false);
        expect(ecommerceShadowPlanningEnabled("off")).toBe(false);
        expect(ecommerceShadowPlanningEnabled("shadow")).toBe(true);
    });

    it("builds a bounded planning input from the user request and asset metadata", () => {
        const input = buildEcommercePlanningInput(
            {
                conversationId: "conversation",
                surface: "chat",
                prompt: "把白底台灯放到明亮客厅",
                referencedAssetIds: ["asset-product", "asset-scene"],
            },
            [
                { id: "asset-product", type: "image", title: "白底台灯", remoteUrl: "https://cdn.example.com/product.png", metadata: {}, userId: "user", conversationId: "conversation", ordinal: 0, status: "ready", createdAt: 1, updatedAt: 1 },
                {
                    id: "asset-scene",
                    type: "image",
                    title: "客厅参考",
                    serverUrl: "/api/assets/scene",
                    metadata: { content: "data:image/png;base64,secret" },
                    userId: "user",
                    conversationId: "conversation",
                    ordinal: 1,
                    status: "ready",
                    createdAt: 1,
                    updatedAt: 1,
                },
            ] as never,
            { summary: "家居商品连续创作", recentMessages: [{ role: "assistant", content: "上一轮生成了台灯场景", sequence: 2 }] } as never,
        );

        expect(input).toMatchObject({
            userRequest: "把白底台灯放到明亮客厅",
            conversationId: "conversation",
            assetCandidates: [
                { id: "asset-product", type: "image", title: "白底台灯", url: "https://cdn.example.com/product.png" },
                { id: "asset-scene", type: "image", title: "客厅参考", url: "/api/assets/scene" },
            ],
            conversationContext: { summary: "家居商品连续创作" },
        });
        expect(JSON.stringify(input)).not.toContain("data:image/png;base64,secret");
    });

    it("appends a recovered product anchor after the explicitly referenced history result", () => {
        const input = buildEcommercePlanningInput(
            {
                conversationId: "conversation",
                surface: "chat",
                prompt: "把背景换成厨房",
                referencedAssetIds: ["asset-scene-result"],
            },
            [imageAsset("asset-product-anchor", "原始商品", "/api/assets/product"), imageAsset("asset-scene-result", "上一轮场景", "/api/assets/scene-result")],
            { summary: "", recentMessages: [] } as never,
        );

        expect(input.assetCandidates.map((asset) => asset.id)).toEqual(["asset-scene-result", "asset-product-anchor"]);
    });

    it("records a server-only snapshot without changing the user-visible task", () => {
        const snapshot: EcommerceGenerationSnapshot = {
            version: "ecommerce-generation.v1",
            mode: "shadow",
            input: { userRequest: "换成客厅", assetIds: ["asset-product"], conversationId: "conversation", surface: "chat" },
            compilerVersion: "legacy-shadow.v1",
            createdAt: 10,
        };
        const recorded = recordEcommerceGenerationSnapshot({ id: "agent-run", userId: "user" }, snapshot);

        expect(recorded).toEqual({ ...snapshot, runId: "agent-run", userId: "user" });
        expect(recorded).toHaveProperty("input.userRequest", "换成客厅");
    });

    it("keeps the legacy path explicit when the ecommerce planner is not enabled", () => {
        const input = { userRequest: "把背景改成厨房", assetIds: ["asset-product"], conversationId: "conversation", surface: "chat" as const };

        expect(legacyPlanFallback(input)).toEqual({ mode: "legacy", reason: "ecommerce_planner_disabled", input });
    });

    it("does not expose the internal snapshot through the public Agent Run shape", () => {
        const snapshot: EcommerceGenerationSnapshot = {
            version: "ecommerce-generation.v1",
            mode: "shadow",
            input: { userRequest: "生成场景", assetIds: ["asset-product"], conversationId: "conversation", surface: "chat" },
            createdAt: 10,
        };
        const publicRun = publicAgentRun({
            id: "agent-run",
            userId: "user",
            conversationId: "conversation",
            clientRequestId: "request",
            surface: "chat",
            inputMessageId: "message-user",
            assistantMessageId: "message-assistant",
            prompt: "生成场景",
            referencedAssetIds: ["asset-product"],
            assetIds: [],
            status: "planning",
            tasks: [],
            reviewed: false,
            ecommerceSnapshot: recordEcommerceGenerationSnapshot({ id: "agent-run", userId: "user" }, snapshot),
            createdAt: 1,
            updatedAt: 1,
        } as AgentRun);

        expect(publicRun).not.toHaveProperty("ecommerceSnapshot");
    });
});

function imageAsset(id: string, title: string, serverUrl: string) {
    return {
        id,
        userId: "user",
        conversationId: "conversation",
        ordinal: 0,
        type: "image" as const,
        status: "ready" as const,
        title,
        serverUrl,
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
    };
}
