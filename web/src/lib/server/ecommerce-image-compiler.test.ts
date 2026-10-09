import { describe, expect, it } from "vitest";

import type { EcommerceEditPlan } from "./ecommerce-edit-plan";
import { compileEcommerceImageRequest, resolveEcommerceImageProviderProfile } from "./ecommerce-image-compiler";
import type { EcommerceRoleRouteSnapshot } from "./ecommerce-model-routing";
import { resolveImageEditProtocol } from "./image-edit-protocol";

describe("ecommerce image compiler", () => {
    it.each(["gpt-image-2.5-flare", "nano-banana-2"])("successfully compiles only authorized lighting cues for v6 product-to-scene: %s", (model) => {
        const edit: EcommerceEditPlan = {
            ...plan(),
            planVersion: "ecommerce-edit.v6",
            strategy: "integrated_scene",
            baseline: { productFacts: plan().baseline.productFacts, sceneFacts: null },
            referenceUses: [
                { assetId: "product", alias: "图片2", purposes: ["edit_target", "product_identity"], usedCueIds: [] },
                { assetId: "scene", alias: "图片1", purposes: ["lighting"], usedCueIds: ["light"] },
            ],
        };
        const original = structuredClone(edit);
        const compiled = compileEcommerceImageRequest(edit, resolveEcommerceImageProviderProfile(snapshot(model, model === "nano-banana-2" ? "gemini" : "openai"))!);
        expect(compiled.state).toBe("ready");
        expect(compiled.referenceMapping).toEqual([
            { assetId: "product", userAlias: "图片2", providerIndex: 0, purposes: ["edit_target", "product_identity"] },
            { assetId: "scene", userAlias: "图片1", providerIndex: 1, purposes: ["lighting"] },
        ]);
        expect(compiled.prompt).toContain(model === "nano-banana-2" ? "scene；用途=lighting" : "scene=lighting cues=light");
        expect(compiled.prompt).not.toMatch(/场景参考仅决定|用途=(?:style|composition)|scene=(?:style|composition)/);
        if (model !== "nano-banana-2") expect(compiled.prompt).toMatch(/辅助参考只能.*绑定用途.*已选线索.*其他视觉属性不得导入/);
        expect(compiled.prompt).toContain("outline、brand_text、color、material、scale、view");
        expect(compiled.prompt).toContain("place in a modern room");
        expect(compiled.photography).toBeUndefined();
        expect(edit).toEqual(original);
    });

    it.each(["ecommerce-edit.v1", "ecommerce-edit.v5"] as const)("preserves the original product-to-scene instruction for %s", (planVersion) => {
        const compiled = compileEcommerceImageRequest({ ...plan(), planVersion }, resolveEcommerceImageProviderProfile(snapshot("gpt-image-2.5-flare", "openai"))!);
        expect(compiled.prompt).toContain("商品锚点决定商品身份；场景参考仅决定空间、构图、光线和氛围。");
        expect(compiled.referenceMapping).toBeUndefined();
    });

    it.each(["gpt-image-2.5-flare", "nano-banana-2"])("refuses a v6 reference purpose without any frozen cue before compiling %s", (model) => {
        const edit: EcommerceEditPlan = {
            ...sceneEditPlan(),
            planVersion: "ecommerce-edit.v6",
            source: { productAnchorId: null, currentSceneBaselineId: "scene-original", sceneReferenceIds: ["style"] },
            referenceUses: [
                { assetId: "scene-original", alias: "图片2", purposes: ["edit_target"], usedCueIds: [] },
                { assetId: "style", alias: "图片1", purposes: ["lighting"], usedCueIds: [] },
            ],
        };
        const original = structuredClone(edit);
        expect(() => compileEcommerceImageRequest(edit, resolveEcommerceImageProviderProfile(snapshot(model, model === "nano-banana-2" ? "gemini" : "openai"))!)).toThrow("线索");
        expect(edit).toEqual(original);
    });
    it.each(["gpt-image-2.5-flare", "nano-banana-2"])("compiles bounded photography for %s with real provider mask support", (model) => {
        const photography = {
            materials: [{ objectId: "cabinet", textureDirection: "沿原图木纹方向", textureScale: "保留细木纹尺度", roughness: "保留细哑光", gloss: "保留原有低光泽" }],
            lighting: { keyLight: "保留左侧柔光", fillLight: "保留弱补光", whiteBalance: "保持中性", contactShadow: "仅在允许区域融合花瓶接触阴影" },
            composition: { focalSubject: "柜体明度层次不变", depth: "纵深不变", negativeSpace: "留白不变" },
        };
        const edit: EcommerceEditPlan = { ...sceneEditPlan(), planVersion: "ecommerce-edit.v5", photography, protection: { scope: "local", protectedObjectIds: ["cabinet"], preserveOutsideMask: true, allowLightingChange: false } };
        const compiled = compileEcommerceImageRequest(edit, resolveEcommerceImageProviderProfile(snapshot(model, model === "nano-banana-2" ? "gemini" : "openai"))!);
        expect(compiled.photography).toEqual(photography);
        expect(compiled.prompt).toContain("沿原图木纹方向");
        expect(compiled.prompt).toContain("保留原有低光泽");
        expect(compiled.prompt).toContain("仅在允许区域");
        expect(compiled.prompt).toContain("不得改变全图光照");
        expect(compiled.compilerVersion).toBe(model === "nano-banana-2" ? "ecommerce-nano-banana-2.v3" : "ecommerce-openai-image-2.5.v3");
        expect(compiled.state).toBe(model === "nano-banana-2" ? "needs_review" : "ready");
        edit.photography!.materials[0].gloss = "mutated";
        expect(compiled.photography?.materials[0].gloss).toBe("保留原有低光泽");
    });
    it("requires a real independent mask for local scene protection", () => {
        const localScenePlan = {
            ...sceneEditPlan(),
            delta: { requestedChanges: ["只加柜面花瓶"], targetObjects: ["vase"], targetRegions: ["cabinet top"] },
            protection: { scope: "local" as const, protectedObjectIds: ["cabinet"], preserveOutsideMask: true, allowLightingChange: false },
        };
        const maskedProfile = resolveEcommerceImageProviderProfile(snapshot("gpt-image-2.5-flare", "openai"))!;
        expect(compileEcommerceImageRequest(localScenePlan, maskedProfile)).toMatchObject({ state: "ready", compilerVersion: "ecommerce-openai-image-2.5.v2", mask: { mode: "independent", required: true } });
        expect(compileEcommerceImageRequest(localScenePlan, { ...maskedProfile, supportsIndependentMask: false })).toMatchObject({ state: "needs_review", reason: "independent_mask_unsupported" });
    });
    it("never promises unchanged outside pixels for a global lighting edit", () => {
        const globalScenePlan = { ...sceneEditPlan(), protection: { scope: "global" as const, protectedObjectIds: ["cabinet"], preserveOutsideMask: false, allowLightingChange: true } };
        const compiled = compileEcommerceImageRequest(globalScenePlan, resolveEcommerceImageProviderProfile(snapshot("gpt-image-2.5-flare", "openai"))!);
        expect(compiled.mask).toBeUndefined();
        expect(compiled.protection).toEqual(globalScenePlan.protection);
        expect(compiled.prompt).toContain("不承诺选区外像素");
    });
    it("compiles the same deterministic canvas into parameters and the scene task", async () => {
        const { createEcommerceSceneEditTask } = await import("./ecommerce-generation-service");
        const canvas = { mode: "exact" as const, size: { width: 3840, height: 2160 }, source: "user_text" as const, allowReframe: false };
        const edit = { ...sceneEditPlan(), canvas };
        edit.modelRoles.generation = "nano-banana-2";
        edit.delta.requestedChanges.push("planner says portrait");
        const compiled = compileEcommerceImageRequest(edit, resolveEcommerceImageProviderProfile(snapshot("nano-banana-2", "gemini"))!);
        const task = createEcommerceSceneEditTask(
            { id: "run", prompt: "保持原尺寸", generationPreferences: { mode: "image", image: { size: "3:2" } } },
            edit,
            [{ id: "scene-original", type: "image", serverUrl: "/api/reference-assets/scene.png", status: "ready", metadata: {}, userId: "u", conversationId: "c", ordinal: 0, title: "scene", createdAt: 1, updatedAt: 1 }],
            compiled,
        );
        expect(compiled).toMatchObject({ canvas, parameters: { size: "3840x2160" } });
        expect(compiled.prompt).toContain("3840x2160");
        expect(task.ratio).toBe("3840x2160");
        expect(task.ecommerceExecution?.canvas).toEqual(canvas);
    });
    it.each([
        ["gpt-image-2.5-flare", "gpt-image-2.5-flare"],
        ["gpt-image-2.5-sunburst", "gpt-image-2.5-sunburst"],
    ])("keeps the %s execution profile distinct while using the OpenAI compiler family", (upstreamModel, profileId) => {
        const profile = resolveEcommerceImageProviderProfile(snapshot(upstreamModel, "openai"));
        const compiled = compileEcommerceImageRequest(plan(), profile!);

        expect(profile).toMatchObject({ profileId, compilerFamily: "openai-image-2.5", supportsIndependentMask: true });
        expect(compiled).toMatchObject({
            state: "ready",
            compilerVersion: "ecommerce-openai-image-2.5.v1",
            providerProfileId: profileId,
            referenceRoles: [
                { assetId: "product", role: "product" },
                { assetId: "scene", role: "scene" },
            ],
            mask: { mode: "independent", required: true },
        });
        expect(compiled.prompt).toContain("strict_product");
        expect(compiled.prompt).toContain("product");
        expect(compiled.prompt).not.toContain("foundation");
        expect(compiled.prompt).not.toContain("model reason");
    });

    it("uses the Nano Banana compiler but fails closed for strict independent-mask editing", () => {
        const profile = resolveEcommerceImageProviderProfile(snapshot("nano-banana-2", "gemini"));
        const compiled = compileEcommerceImageRequest(plan(), profile!);

        expect(profile).toMatchObject({ profileId: "nano-banana-2", compilerFamily: "nano-banana-2", supportsIndependentMask: false });
        expect(compiled).toMatchObject({
            state: "needs_review",
            compilerVersion: "ecommerce-nano-banana-2.v1",
            providerProfileId: "nano-banana-2",
            reason: "independent_mask_unsupported",
        });
        expect(compiled.prompt).toContain("商品锚点");
        expect(compiled).not.toHaveProperty("mask");
    });

    it("orders local-edit references as current scene baseline then immutable product anchor", () => {
        const profile = resolveEcommerceImageProviderProfile(snapshot("gpt-image-2.5-flare", "openai"));
        const compiled = compileEcommerceImageRequest(localEditPlan(), profile!);

        expect(compiled.referenceRoles).toEqual([
            { assetId: "result", role: "scene" },
            { assetId: "product", role: "product" },
        ]);
        expect(compiled.prompt).toContain("coffee table");
        expect(compiled.prompt).toContain("right background");
    });

    it("compiles a scene edit with only the scene baseline and no product mask", () => {
        const profile = resolveEcommerceImageProviderProfile(snapshot("nano-banana-2", "gemini"));
        const compiled = compileEcommerceImageRequest(sceneEditPlan(), profile!);

        expect(compiled).toMatchObject({
            state: "ready",
            referenceRoles: [{ assetId: "scene-original", role: "scene" }],
        });
        expect(compiled).not.toHaveProperty("mask");
        expect(compiled.prompt).toContain("冬日阳光");
        expect(compiled.prompt).toContain("保持房间布局");
    });

    it("does not guess a provider profile for an unknown generation model", () => {
        expect(resolveEcommerceImageProviderProfile(snapshot("future-image-model", "openai"))).toBeNull();
    });
});

function snapshot(upstreamModel: string, apiFormat: "openai" | "gemini"): EcommerceRoleRouteSnapshot {
    return {
        logicalRole: "image_generation",
        capability: "image",
        logicalModelId: upstreamModel,
        channelId: `${apiFormat}-channel`,
        upstreamModel,
        apiFormat,
        imageEdit: resolveImageEditProtocol({ apiFormat, model: upstreamModel }),
    };
}

function plan(): EcommerceEditPlan {
    return {
        planVersion: "ecommerce-edit.v1",
        operation: "product_to_scene",
        source: { productAnchorId: "product", currentSceneBaselineId: null, sceneReferenceIds: ["scene"] },
        baseline: {
            productFacts: { identity: "oak chair", outline: "curved back", color: "oak", material: "wood", brandText: [], view: "front" },
            sceneFacts: { space: "living room", composition: "eye level", lighting: "soft daylight" },
        },
        delta: { requestedChanges: ["place in a modern room"], targetObjects: ["room"], targetRegions: ["background"] },
        preserve: { productCore: ["outline", "brand_text", "color", "material", "scale", "view"], sceneElements: [] },
        strategy: "strict_product",
        modelRoles: { visionAnalysis: "vision", editPlanning: "planner", generation: "image", qualityCheck: "quality" },
        continuity: { parentResultId: null, branchId: "branch" },
        validation: { requiredChecks: ["product_identity"] },
    };
}

function localEditPlan(): EcommerceEditPlan {
    return {
        ...plan(),
        operation: "local_edit",
        source: { productAnchorId: "product", currentSceneBaselineId: "result", sceneReferenceIds: [] },
        delta: { requestedChanges: ["add a coffee table"], targetObjects: ["coffee table"], targetRegions: ["right background"] },
    };
}

function sceneEditPlan(): EcommerceEditPlan {
    return {
        ...plan(),
        operation: "scene_edit",
        source: { productAnchorId: null, currentSceneBaselineId: "scene-original", sceneReferenceIds: [] },
        baseline: {
            productFacts: null,
            sceneFacts: { space: "living room", composition: "eye level", lighting: "soft daylight" },
        },
        delta: {
            requestedChanges: ["改为冬日阳光"],
            targetObjects: ["lighting-main"],
            targetRegions: ["whole-scene"],
        },
        preserve: { productCore: [], sceneElements: ["保持房间布局", "保持家具和机位"] },
        strategy: "integrated_scene",
        validation: { requiredChecks: ["requested_edit", "scene_preservation"] },
    } as EcommerceEditPlan;
}
