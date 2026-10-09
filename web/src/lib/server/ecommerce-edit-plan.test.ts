import { describe, expect, it } from "vitest";

import { ecommerceCanvasSize, normalizeEcommerceEditPlan, planPublicSummary, resolveEcommerceCanvasConstraint, validateEcommerceEditPlan, type EcommerceEditPlan } from "./ecommerce-edit-plan";
import { assertCapabilityConstraints } from "./capability-constraints";

describe("deterministic ecommerce canvas", () => {
    it("accepts a disabled null quality role while requiring the other model roles", () => {
        const plan = validPlan();
        plan.modelRoles.qualityCheck = null;
        expect(normalizeEcommerceEditPlan(JSON.parse(JSON.stringify(plan)))).toMatchObject({ modelRoles: { qualityCheck: null } });
        expect(normalizeEcommerceEditPlan({ ...plan, modelRoles: { ...plan.modelRoles, generation: null } })).toBeNull();
        expect(normalizeEcommerceEditPlan({ ...plan, modelRoles: { ...plan.modelRoles, qualityCheck: "" } })).toBeNull();
    });
    it("round-trips v5 photography and retains old v4 structure without adding targets", () => {
        const photography = {
            materials: [{ objectId: "cabinet", textureDirection: "沿原图木纹方向", textureScale: "细木纹", roughness: "哑光", gloss: "保留原有低光泽" }],
            lighting: { keyLight: "柔光", fillLight: "弱补光", whiteBalance: "中性", contactShadow: "接触阴影" },
            composition: { focalSubject: "边柜", depth: "纵深", negativeSpace: "留白" },
        };
        const visibleStructure = [{ objectId: "cabinet", feature: "drawers", count: 3, certainty: "confirmed", evidenceRegion: { x: 0, y: 0, width: 100, height: 100 } }];
        const current = { ...validPlan(), planVersion: "ecommerce-edit.v5", photography, visibleStructure };
        expect(normalizeEcommerceEditPlan(JSON.parse(JSON.stringify(current)))).toMatchObject({ photography, visibleStructure });
        expect(normalizeEcommerceEditPlan({ ...current, photography: { ...photography, lighting: { ...photography.lighting, keyLight: "" } } })).toBeNull();
        expect(normalizeEcommerceEditPlan({ ...current, photography: { ...photography, materials: [photography.materials[0], photography.materials[0]] } })).toBeNull();
        const old = { ...validPlan(), planVersion: "ecommerce-edit.v4", visibleStructure };
        const saved = normalizeEcommerceEditPlan(JSON.parse(JSON.stringify(old)))!;
        expect(saved).toMatchObject(old);
        expect(saved).not.toHaveProperty("photography");
        expect(normalizeEcommerceEditPlan({ ...old, photography })).toBeNull();
    });
    it("round-trips new protection without rewriting older plans", () => {
        const protection = { scope: "local", protectedObjectIds: ["cabinet"], preserveOutsideMask: true, allowLightingChange: false };
        const scene = {
            ...validPlan(),
            planVersion: "ecommerce-edit.v3",
            operation: "scene_edit",
            source: { productAnchorId: null, currentSceneBaselineId: "scene", sceneReferenceIds: [] },
            baseline: { ...validPlan().baseline, productFacts: null },
            preserve: { productCore: [], sceneElements: ["cabinet"] },
            strategy: "integrated_scene",
            protection,
        };
        expect(normalizeEcommerceEditPlan(JSON.parse(JSON.stringify(scene)))).toMatchObject({ planVersion: "ecommerce-edit.v3", protection });
        expect(normalizeEcommerceEditPlan({ ...scene, protection: undefined })).toBeNull();
        expect(normalizeEcommerceEditPlan({ ...scene, protection: { ...protection, preserveOutsideMask: false } })).toBeNull();
        expect(normalizeEcommerceEditPlan({ ...scene, protection: { ...protection, scope: "global" } })).toBeNull();
        expect(normalizeEcommerceEditPlan({ ...scene, planVersion: "ecommerce-edit.v2", protection: undefined })).toMatchObject({ planVersion: "ecommerce-edit.v2" });
        const productLocal = { ...validPlan(), planVersion: "ecommerce-edit.v3", operation: "local_edit", protection: { ...protection, protectedObjectIds: ["asset-product-001"], preserveOutsideMask: false } };
        expect(normalizeEcommerceEditPlan(JSON.parse(JSON.stringify(productLocal)))).toMatchObject({ protection: { scope: "local", protectedObjectIds: ["asset-product-001"], preserveOutsideMask: false } });
    });
    const baselineSize = { width: 3840, height: 2160 };
    it.each([
        { width: 3840, height: 2160, ratio: "16:9" },
        { width: 1000, height: 1000, ratio: "1:1" },
        { width: 1001, height: 777, ratio: "143:111" },
    ])("serializes baseline $width x $height as an equivalent supported ratio", ({ width, height, ratio }) => {
        const canvas = resolveEcommerceCanvasConstraint({ operation: "product_to_scene", baselineSize: { width, height } })!;
        const size = ecommerceCanvasSize(canvas);
        expect(() => assertCapabilityConstraints({ aspectRatios: [ratio] }, { capability: "image", aspectRatio: size })).not.toThrow();
        expect(size).toBe(ratio);
        expect(canvas.size).toEqual({ width, height });
    });
    it("keeps original pixels ahead of stale custom dimensions", () => {
        expect(resolveEcommerceCanvasConstraint({ operation: "scene_edit", userRequest: { mode: "preserve" }, explicitSize: { width: 3000, height: 2000 }, baselineSize })).toEqual({
            mode: "exact",
            size: baselineSize,
            source: "user_text",
            allowReframe: false,
        });
    });
    it("keeps preserve unresolved when the baseline cannot be decoded", () => {
        expect(resolveEcommerceCanvasConstraint({ operation: "scene_edit", userRequest: { mode: "preserve" }, explicitSize: baselineSize, defaultSize: baselineSize })).toBeNull();
    });
    it("resolves text, exact custom, main baseline, planning, default in that order", () => {
        const input = { operation: "scene_edit" as const, explicitSize: { width: 3000, height: 2000 }, baselineSize, planningSize: { width: 1, height: 1 }, defaultSize: { width: 4, height: 3 } };
        expect(resolveEcommerceCanvasConstraint({ ...input, userRequest: { mode: "ratio", size: { width: 9, height: 16 } } })).toMatchObject({ mode: "ratio", source: "user_text", allowReframe: true });
        expect(resolveEcommerceCanvasConstraint(input)).toMatchObject({ mode: "exact", source: "explicit_size" });
        expect(resolveEcommerceCanvasConstraint({ ...input, explicitSize: undefined })).toMatchObject({ mode: "exact", source: "baseline", allowReframe: false });
        expect(resolveEcommerceCanvasConstraint({ operation: "product_to_scene", baselineSize })).toMatchObject({ mode: "ratio", source: "baseline" });
        expect(resolveEcommerceCanvasConstraint({ operation: "product_to_scene", planningSize: input.planningSize, defaultSize: input.defaultSize })).toMatchObject({ source: "planning" });
        expect(resolveEcommerceCanvasConstraint({ operation: "product_to_scene", defaultSize: input.defaultSize })).toMatchObject({ source: "default" });
        expect(resolveEcommerceCanvasConstraint({ operation: "product_to_scene" })).toBeNull();
    });
    it.each([0, -1, 1.5, Infinity, NaN])("rejects non-positive-integer dimension %s", (width) => {
        expect(() => resolveEcommerceCanvasConstraint({ operation: "scene_edit", baselineSize: { width, height: 2160 } })).toThrow("尺寸");
    });
    it("round-trips the versioned constraint and rejects invalid canvas without dropping it", () => {
        const canvas = { mode: "exact" as const, size: baselineSize, source: "baseline" as const, allowReframe: false };
        const restored = normalizeEcommerceEditPlan(JSON.parse(JSON.stringify(validPlan({ planVersion: "ecommerce-edit.v2", canvas }))));
        expect(restored).toMatchObject({ planVersion: "ecommerce-edit.v2", canvas });
        expect(normalizeEcommerceEditPlan(validPlan())?.planVersion).toBe("ecommerce-edit.v1");
        expect(normalizeEcommerceEditPlan({ ...validPlan(), canvas: { ...canvas, size: { width: 0, height: 2160 } } })).toBeNull();
    });
});

function validPlan(overrides: Partial<EcommerceEditPlan> = {}): EcommerceEditPlan {
    return {
        planVersion: "ecommerce-edit.v1",
        operation: "product_to_scene",
        source: {
            productAnchorId: "asset-product-001",
            currentSceneBaselineId: null,
            sceneReferenceIds: ["asset-scene-001"],
        },
        baseline: {
            productFacts: {
                identity: "白色陶瓷台灯",
                outline: "圆柱灯罩和木质底座",
                color: "暖白和浅木色",
                material: "陶瓷、木材",
                brandText: [],
                view: "三分之二正面",
            },
            sceneFacts: {
                space: "现代客厅",
                composition: "商品位于画面右侧",
                lighting: "柔和自然窗光",
            },
        },
        delta: {
            requestedChanges: ["生成现代客厅环境"],
            targetObjects: ["background"],
            targetRegions: ["background", "product_halo"],
        },
        preserve: {
            productCore: ["outline", "brand_text", "color", "material", "scale", "view"],
            sceneElements: [],
        },
        strategy: "strict_product",
        modelRoles: {
            visionAnalysis: "logical-vision-model",
            editPlanning: "logical-planner-model",
            generation: "logical-image-model",
            qualityCheck: "logical-quality-model",
        },
        continuity: {
            parentResultId: null,
            branchId: "branch-001",
        },
        validation: {
            requiredChecks: ["product_identity", "product_outline", "brand_text", "requested_scene_change"],
        },
        ...overrides,
    };
}

describe("EcommerceEditPlan", () => {
    it("round-trips v4 visible facts and keeps prior snapshots free of new facts", () => {
        const visibleStructure = [{ objectId: "cabinet", feature: "drawers", count: 3, certainty: "confirmed", evidenceRegion: { x: 10, y: 10, width: 100, height: 200 } }];
        const current = { ...validPlan(), planVersion: "ecommerce-edit.v4", visibleStructure };
        expect(normalizeEcommerceEditPlan(JSON.parse(JSON.stringify(current)))).toEqual(current);
        for (const version of ["ecommerce-edit.v1", "ecommerce-edit.v2", "ecommerce-edit.v3"]) {
            expect(normalizeEcommerceEditPlan({ ...validPlan(), planVersion: version })).not.toHaveProperty("visibleStructure");
            expect(normalizeEcommerceEditPlan({ ...current, planVersion: version })).toBeNull();
        }
        expect(normalizeEcommerceEditPlan({ ...current, visibleStructure: [{ ...visibleStructure[0], count: 4, certainty: "uncertain" }] })).toBeNull();
        expect(normalizeEcommerceEditPlan({ ...current, visibleStructure: [{ ...visibleStructure[0], count: null, certainty: "uncertain" }] })).not.toBeNull();
        expect(normalizeEcommerceEditPlan({ ...current, visibleStructure: [{ ...visibleStructure[0], count: -1 }] })).toBeNull();
    });
    it("accepts a strict product-to-scene plan with a product anchor", () => {
        expect(() => validateEcommerceEditPlan(validPlan())).not.toThrow();
    });

    it("rejects product-to-scene plans without a product anchor", () => {
        const plan = validPlan({ source: { ...validPlan().source, productAnchorId: "" } });

        expect(() => validateEcommerceEditPlan(plan)).toThrow("商品主参考图");
    });

    it("accepts a scene edit with a scene baseline and no product anchor", () => {
        const plan = validPlan({
            operation: "scene_edit",
            source: { productAnchorId: null, currentSceneBaselineId: "asset-scene-001", sceneReferenceIds: [] },
            baseline: {
                productFacts: null,
                sceneFacts: { space: "现代客厅", composition: "平视广角", lighting: "柔和日光" },
            },
            delta: { requestedChanges: ["改为冬日阳光"], targetObjects: ["lighting-main"], targetRegions: ["whole-scene"] },
            preserve: { productCore: [], sceneElements: ["layout", "furniture", "camera"] },
            strategy: "integrated_scene",
            validation: { requiredChecks: ["requested_edit", "scene_preservation", "composition_lighting"] },
        } as Partial<EcommerceEditPlan>);

        expect(() => validateEcommerceEditPlan(plan)).not.toThrow();
        expect(normalizeEcommerceEditPlan(plan)).toEqual(plan);
    });

    it("rejects a scene edit that substitutes a product anchor for the scene baseline", () => {
        const plan = validPlan({
            operation: "scene_edit",
            source: { productAnchorId: "asset-product-001", currentSceneBaselineId: "asset-scene-001", sceneReferenceIds: [] },
            baseline: { productFacts: validPlan().baseline.productFacts, sceneFacts: validPlan().baseline.sceneFacts },
            preserve: { productCore: [], sceneElements: ["layout"] },
            strategy: "integrated_scene",
        } as Partial<EcommerceEditPlan>);

        expect(() => validateEcommerceEditPlan(plan)).toThrow("场景编辑不能包含商品锚点");
    });

    it("requires strict product core protections", () => {
        const plan = validPlan({ preserve: { productCore: ["outline"], sceneElements: [] } });

        expect(() => validateEcommerceEditPlan(plan)).toThrow("商品核心保护项");
    });

    it("rejects a scene reference that is also declared as the product anchor", () => {
        const plan = validPlan({ source: { ...validPlan().source, sceneReferenceIds: ["asset-product-001"] } });

        expect(() => validateEcommerceEditPlan(plan)).toThrow("场景参考图不能作为商品主参考图");
    });

    it("requires a target object or manual region for local edits", () => {
        const plan = validPlan({ operation: "local_edit", delta: { requestedChanges: ["调整画面"], targetObjects: [], targetRegions: [] } });

        expect(() => validateEcommerceEditPlan(plan)).toThrow("局部编辑目标");
    });

    it("does not silently accept an invalid continuity parent result", () => {
        const value = validPlan({ continuity: { parentResultId: "", branchId: "branch-001" } });

        expect(normalizeEcommerceEditPlan(value)).toBeNull();
        expect(() => validateEcommerceEditPlan(value)).toThrow("父结果");
    });

    it("normalizes a valid plan without mutating its input", () => {
        const input = validPlan();
        const normalized = normalizeEcommerceEditPlan(input);

        expect(normalized).toEqual(input);
        expect(normalized).not.toBe(input);
        expect(normalized?.delta.requestedChanges).not.toBe(input.delta.requestedChanges);
    });

    it("returns only a public operation summary", () => {
        const summary = planPublicSummary(validPlan());

        expect(summary).toEqual({ operation: "product_to_scene", strategy: "strict_product", requestedChanges: ["生成现代客厅环境"], targetObjects: ["background"] });
        expect(summary).not.toHaveProperty("source");
        expect(summary).not.toHaveProperty("baseline");
        expect(summary).not.toHaveProperty("modelRoles");
        expect(summary).not.toHaveProperty("validation");
    });
});
