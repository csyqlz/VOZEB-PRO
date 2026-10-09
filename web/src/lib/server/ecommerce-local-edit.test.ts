import sharp from "sharp";
import { describe, expect, it } from "vitest";

import type { CreativeAsset } from "@/lib/creative-runtime-contract";
import type { EcommerceEditPlan, EcommerceManualRegion } from "./ecommerce-edit-plan";
import { resolveLocalEditTarget } from "./ecommerce-edit-planner";
import { buildLocalEditProductProtection, createEcommerceLocalEditTask } from "./ecommerce-generation-service";
import { compileEcommerceImageRequest, resolveEcommerceImageProviderProfile } from "./ecommerce-image-compiler";
import type { EcommerceVisualAnalysis } from "./ecommerce-visual-analysis";
import { resolveImageEditProtocol } from "./image-edit-protocol";

describe("ecommerce local edit target resolution", () => {
    it.each([
        ["把背景换成厨房", ["background-main"], "background-main"],
        ["增加一杯咖啡", ["coffee-placement"], "coffee-placement"],
        ["去掉右边绿植", ["plant-right"], "plant-right"],
        ["让光线更亮", ["lighting-main"], "lighting-main"],
    ])("resolves one structured non-product target for %s", (request, targetIds, expectedId) => {
        const result = resolveLocalEditTarget(localEditPlan(request, targetIds), visualAnalysis());

        expect(result).toMatchObject({ state: "resolved", target: { id: expectedId, source: "analysis" } });
    });

    it("returns one clarification question when more than one structured target matches", () => {
        const result = resolveLocalEditTarget(localEditPlan("去掉绿植", ["plant-left", "plant-right"]), visualAnalysis());

        expect(result).toMatchObject({ state: "needs_review", reason: "multiple_matching_targets" });
        if (result.state === "resolved") throw new Error("expected an ambiguous target");
        expect(result.clarificationQuestion).toBe("检测到多个可编辑目标，请明确要修改哪一个位置或物品。");
    });

    it("uses an internal manual region before model-selected candidates", () => {
        const manualRegion = { x: 0.7, y: 0.2, width: 0.2, height: 0.3 };
        const result = resolveLocalEditTarget(localEditPlan("修改选中区域", ["plant-left", "plant-right"], manualRegion), visualAnalysis());

        expect(result).toEqual({ state: "resolved", target: { id: "manual-region", kind: "environment", label: "manual region", region: manualRegion, source: "manual" } });
    });

    it.each(["把商品改成黑色", "把木材改成金属", "改变商品结构", "修改包装文字"])("rejects unsupported product-core edits: %s", (request) => {
        const result = resolveLocalEditTarget(localEditPlan(request, ["product-body"], undefined, ["product_core"]), visualAnalysis());

        expect(result).toMatchObject({ state: "rejected", reason: "product_edit_not_supported", clarificationQuestion: expect.stringContaining("第一期") });
    });
});

describe("ecommerce local edit compilation", () => {
    it("builds a target-only mask that keeps product core, fusion halo, and unrelated scene pixels opaque", async () => {
        const source = await sharp({ create: { width: 100, height: 80, channels: 4, background: "#d8d8d8" } })
            .png()
            .toBuffer();
        const resolution = resolveLocalEditTarget(localEditPlan("去掉右边绿植", ["plant-right"]), visualAnalysis());
        if (resolution.state !== "resolved") throw new Error("expected a resolved target");

        const regions = await buildLocalEditProductProtection(source, visualAnalysis(), "scene-result", "product-anchor", resolution.target);
        const maskUrl = regions.editableBackground.mask?.reference.dataUrl;
        if (!maskUrl) throw new Error("expected an inline local edit mask");
        const mask = Buffer.from(maskUrl.slice(maskUrl.indexOf(",") + 1), "base64");
        const decoded = await sharp(mask).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const alpha = (x: number, y: number) => decoded.data[(y * decoded.info.width + x) * decoded.info.channels + 3];

        expect(regions).toMatchObject({ productAnchorId: "product-anchor", sourceAssetId: "scene-result", sourceSize: { width: 100, height: 80 } });
        expect(alpha(80, 30)).toBe(0);
        expect(alpha(50, 40)).toBe(255);
        expect(alpha(36, 20)).toBe(255);
        expect(alpha(10, 10)).toBe(255);
    });

    it("uses the current scene baseline first and the original product anchor second", async () => {
        const source = await sharp({ create: { width: 100, height: 80, channels: 4, background: "#d8d8d8" } })
            .png()
            .toBuffer();
        const plan = localEditPlan("把背景换成厨房", ["background-main"]);
        const resolution = resolveLocalEditTarget(plan, visualAnalysis());
        if (resolution.state !== "resolved") throw new Error("expected a resolved target");
        const regions = await buildLocalEditProductProtection(source, visualAnalysis(), "scene-result", "product-anchor", resolution.target);
        const ecommerceExecution = compileEcommerceImageRequest(
            plan,
            resolveEcommerceImageProviderProfile({
                logicalRole: "image_generation",
                capability: "image",
                logicalModelId: "image-model",
                channelId: "image-channel",
                upstreamModel: "gpt-image-2.5-flare",
                apiFormat: "openai",
                imageEdit: resolveImageEditProtocol({ apiFormat: "openai", model: "gpt-image-2.5-flare" }),
            })!,
        );

        const task = createEcommerceLocalEditTask(
            { id: "run-local", prompt: "把背景换成厨房", generationPreferences: { mode: "image", image: { count: 1 } } },
            plan,
            [imageAsset("product-anchor", "/api/assets/product.png"), imageAsset("scene-result", "/api/assets/scene.png")],
            regions,
            ecommerceExecution,
        );

        expect(task.referenceAssetId).toBe("scene-result");
        expect(task.references).toEqual([expect.objectContaining({ assetId: "scene-result", ecommerceRole: "scene" }), expect.objectContaining({ assetId: "product-anchor", ecommerceRole: "product" })]);
        expect(task.productProtectionRegions).toMatchObject({ productAnchorId: "product-anchor", sourceAssetId: "scene-result" });
        expect(task.prompt).toBe(ecommerceExecution.prompt);
        expect(task.ecommerceExecution).toEqual(ecommerceExecution);
    });
});

function localEditPlan(request: string, targetObjects: string[], manualRegion?: EcommerceManualRegion, targetRegions: string[] = []): EcommerceEditPlan {
    return {
        planVersion: "ecommerce-edit.v1",
        operation: "local_edit",
        source: { productAnchorId: "product-anchor", currentSceneBaselineId: "scene-result", sceneReferenceIds: [] },
        baseline: {
            productFacts: { identity: "oak chair", outline: "chair outline", color: "oak", material: "wood", brandText: [], view: "front" },
            sceneFacts: { space: "living room", composition: "eye level", lighting: "soft daylight" },
        },
        delta: { requestedChanges: [request], targetObjects, targetRegions, ...(manualRegion ? { manualRegion } : {}) },
        preserve: { productCore: ["outline", "brand_text", "color", "material", "scale", "view"], sceneElements: ["unrelated_scene"] },
        strategy: "strict_product",
        modelRoles: { visionAnalysis: "vision-model", editPlanning: "planner-model", generation: "image-model", qualityCheck: "quality-model" },
        continuity: { parentResultId: "scene-result", branchId: "branch-local" },
        validation: { requiredChecks: ["product_identity", "target_locality"] },
    };
}

function visualAnalysis(): EcommerceVisualAnalysis {
    return {
        analysisVersion: "ecommerce-visual-analysis.v1",
        modelRole: { logicalRole: "vision_analysis", logicalModelId: "vision-model", channelId: "vision-channel", upstreamModel: "vision-upstream" },
        references: [
            {
                assetId: "product-anchor",
                role: "product",
                confidence: "high",
                visualEvidence: { whiteBackground: true, transparentBackground: false, isolatedSubject: true, completeScene: false },
                productFacts: { identity: "oak chair", outline: "chair outline", color: "oak", material: "wood", brandText: [], view: "front" },
                sceneFacts: null,
                productCore: { x: 0.35, y: 0.25, width: 0.3, height: 0.5 },
                fusionHalo: { x: 0.31, y: 0.21, width: 0.38, height: 0.58 },
                editableTargets: [],
            },
            {
                assetId: "scene-result",
                role: "scene",
                confidence: "high",
                visualEvidence: { whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: true },
                productFacts: null,
                sceneFacts: { space: "living room", composition: "eye level", lighting: "soft daylight" },
                productCore: { x: 0.4, y: 0.25, width: 0.2, height: 0.5 },
                fusionHalo: { x: 0.35, y: 0.2, width: 0.3, height: 0.6 },
                editableTargets: [
                    { id: "background-main", kind: "background", label: "main room background", region: { x: 0, y: 0, width: 1, height: 1 } },
                    { id: "coffee-placement", kind: "prop", label: "coffee cup placement", region: { x: 0.68, y: 0.58, width: 0.16, height: 0.18 } },
                    { id: "plant-left", kind: "prop", label: "left green plant", region: { x: 0.02, y: 0.2, width: 0.2, height: 0.58 } },
                    { id: "plant-right", kind: "prop", label: "right green plant", region: { x: 0.72, y: 0.2, width: 0.2, height: 0.58 } },
                    { id: "lighting-main", kind: "lighting", label: "whole scene lighting", region: { x: 0, y: 0, width: 1, height: 1 } },
                ],
            },
        ],
    };
}

function imageAsset(id: string, serverUrl: string): CreativeAsset {
    return {
        id,
        userId: "user-one",
        conversationId: "conversation-one",
        ordinal: 0,
        type: "image",
        status: "ready",
        title: id,
        serverUrl,
        width: 100,
        height: 80,
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
    };
}
