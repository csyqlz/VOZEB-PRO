import { describe, expect, it } from "vitest";

import { normalizeEcommerceEditPlan, type EcommerceEditPlan } from "./ecommerce-edit-plan";
import { compileEcommerceImageRequest, resolveEcommerceImageProviderProfile } from "./ecommerce-image-compiler";
import { buildEcommerceGenerationTrace } from "./ecommerce-generation-trace";
import type { AgentRunTask } from "./agent-run-store";
import type { EcommerceRoleRouteSnapshot } from "./ecommerce-model-routing";

describe("R2 reference-purpose runtime wiring", () => {
    it("accepts v6 plans with a null observed scene baseline and locked reference uses", () => {
        const plan = normalizeEcommerceEditPlan({
            planVersion: "ecommerce-edit.v6",
            operation: "product_to_scene",
            source: { productAnchorId: "target", currentSceneBaselineId: null, sceneReferenceIds: ["style"] },
            referenceUses: [
                { assetId: "target", alias: "图片2", purposes: ["edit_target", "product_identity"], usedCueIds: [] },
                { assetId: "style", alias: "图片1", purposes: ["style", "lighting"], usedCueIds: ["soft-light"] },
            ],
            baseline: {
                productFacts: { identity: "cabinet", outline: "rectangular", color: "oak", material: "wood", brandText: [], view: "front" },
                sceneFacts: null,
            },
            delta: { requestedChanges: ["place in a room"], targetObjects: ["room"], targetRegions: ["background"] },
            preserve: { productCore: ["outline", "brand_text", "color", "material", "scale", "view"], sceneElements: [] },
            strategy: "strict_product",
            modelRoles: { visionAnalysis: "vision", editPlanning: "planner", generation: "image", qualityCheck: "quality" },
            continuity: { parentResultId: null, branchId: "r2" },
            validation: { requiredChecks: ["product_identity"] },
        });

        expect(plan).toMatchObject({ planVersion: "ecommerce-edit.v6", baseline: { sceneFacts: null } });
        expect(plan?.referenceUses).toContainEqual(expect.objectContaining({ assetId: "style", usedCueIds: ["soft-light"] }));
    });

    it("keeps the target and style references in scene_edit with explicit provider positions", () => {
        const plan = {
            ...sceneEditPlan(),
            planVersion: "ecommerce-edit.v6",
            source: { productAnchorId: null, currentSceneBaselineId: "baseline", sceneReferenceIds: ["style"] },
            referenceUses: [
                { assetId: "baseline", alias: "图片2", purposes: ["edit_target"], usedCueIds: [] },
                { assetId: "style", alias: "图片1", purposes: ["style", "lighting"], usedCueIds: ["soft-light"] },
            ],
        } as unknown as EcommerceEditPlan;
        const profile = resolveEcommerceImageProviderProfile(snapshot("gpt-image-2.5-flare", "openai"))!;
        const compiled = compileEcommerceImageRequest(plan, profile);

        expect(compiled.compilerVersion).toBe("ecommerce-openai-image-2.5.v4");
        expect(compiled.referenceMapping).toEqual([
            { assetId: "baseline", userAlias: "图片2", providerIndex: 0, purposes: ["edit_target"] },
            { assetId: "style", userAlias: "图片1", providerIndex: 1, purposes: ["style", "lighting"] },
        ]);
        expect(compiled.prompt).toContain("图片1");
        expect(compiled.prompt).toContain("图片2");
        expect(compiled.prompt).not.toContain("唯一视觉参考");
    });

    it("records reference decision and selected cues in the generation trace", () => {
        const snapshot = {
            version: "ecommerce-generation.v1" as const,
            mode: "active" as const,
            input: { userRequest: "参考图片1的光线，修改图片2", assetIds: ["style", "target"], conversationId: "conversation", surface: "chat" as const },
            referenceDecision: {
                version: "ecommerce-reference-decision.v1" as const,
                state: "resolved" as const,
                bindings: [
                    { assetId: "style", alias: "图片1", purposes: ["lighting" as const], source: "explicit" as const },
                    { assetId: "target", alias: "图片2", purposes: ["edit_target" as const, "product_identity" as const], source: "explicit" as const },
                ],
                editTargetId: "target",
                productAnchorId: "target",
                currentSceneBaselineId: null,
                appliedCues: [{ assetId: "style", purpose: "lighting" as const, cueIds: ["soft-light"] }],
                issues: [],
            },
            createdAt: 1,
        };
        const trace = buildEcommerceGenerationTrace({
            runId: "run",
            task: { ...task(), ecommerceExecution: undefined },
            snapshot,
            imageTaskIds: [],
            generationStatus: "needs_review",
            finalStatus: "needs_review",
            recordedAt: 2,
        });

        expect(trace.stages[0].output).toMatchObject({ referenceDecision: snapshot.referenceDecision });
    });
});

function snapshot(upstreamModel: string, apiFormat: "openai" | "gemini"): EcommerceRoleRouteSnapshot {
    return { logicalRole: "image_generation", capability: "image", logicalModelId: upstreamModel, channelId: `${apiFormat}-channel`, upstreamModel, apiFormat };
}

function sceneEditPlan(): EcommerceEditPlan {
    return {
        planVersion: "ecommerce-edit.v5",
        operation: "scene_edit",
        source: { productAnchorId: null, currentSceneBaselineId: "baseline", sceneReferenceIds: [] },
        baseline: { productFacts: null, sceneFacts: { space: "living room", composition: "eye level", lighting: "soft daylight" } },
        delta: { requestedChanges: ["改为冬日阳光"], targetObjects: ["lighting-main"], targetRegions: ["whole-scene"] },
        preserve: { productCore: [], sceneElements: ["保持房间布局"] },
        strategy: "integrated_scene",
        protection: { scope: "global", protectedObjectIds: [], preserveOutsideMask: false, allowLightingChange: true },
        modelRoles: { visionAnalysis: "vision", editPlanning: "planner", generation: "image", qualityCheck: "quality" },
        continuity: { parentResultId: null, branchId: "branch" },
        validation: { requiredChecks: ["requested_edit", "scene_preservation"] },
    };
}

function task(): AgentRunTask {
    return {
        id: "task",
        title: "商品场景图",
        type: "image",
        model: "image",
        prompt: "prompt",
        optimizedPrompt: "prompt",
        count: 1,
        dependencies: [],
        status: "needs_review",
        attempts: 0,
    } as AgentRunTask;
}
