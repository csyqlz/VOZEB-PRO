import { beforeEach, describe, expect, it, vi } from "vitest";

import { ECOMMERCE_EDIT_PLAN_VERSION, type EcommerceEditPlan } from "./ecommerce-edit-plan";
import { normalizePlannedEdit, planEcommerceEdit } from "./ecommerce-edit-planner";
import { referenceUsesFromEcommerceDecision, resolveEcommerceReferenceDecision, type EcommerceReferenceDecision } from "./ecommerce-reference-purpose";
import type { EcommerceVisualAnalysisV4 } from "./ecommerce-visual-analysis";
import { compileEcommerceImageRequest, resolveEcommerceImageProviderProfile } from "./ecommerce-image-compiler";
import { resolveImageEditProtocol } from "./image-edit-protocol";
import type { EcommercePlanningInput } from "./ecommerce-generation-snapshot";
import type { EcommerceRoleCandidate } from "./ecommerce-model-routing";
import type { EcommerceVisualAnalysis } from "./ecommerce-visual-analysis";
import { normalizeEcommerceVisualAnalysis } from "./ecommerce-visual-analysis";
import { resolveSourcesFromEcommerceReferenceDecision } from "./ecommerce-reference-roles";
import { requestStructuredText, type TextPlanningCandidate } from "./text-planning-runtime";

const mocks = vi.hoisted(() => ({ refundUserPoints: vi.fn(async () => undefined) }));

vi.mock("@/lib/auth/store", () => ({ refundUserPoints: mocks.refundUserPoints }));

vi.mock("./text-planning-runtime", () => ({
    requestStructuredText: vi.fn(),
    rankTextPlanningCandidates: <T>(candidates: T[]) => candidates,
}));

const mockedRequest = vi.mocked(requestStructuredText);

describe("ecommerce edit planner", () => {
    it.each(["operation", "strategy"] as const)("rejects an unexecutable v6 product-only %s without rewriting the request or raw output", (field) => {
        const { input, analysis, plan } = productPurposeFixture("参考图片1的风格，修改图片2");
        if (field === "operation") plan.operation = "local_edit";
        else plan.strategy = "integrated_scene";
        const before = structuredClone({ input, analysis, plan });

        expect(() => normalizePlannedEdit(plan, input, analysis, "planner-model")).toThrow(expect.objectContaining({ issues: [expect.objectContaining({ code: "edit_plan_boundary", path: field })] }));
        expect({ input, analysis, plan }).toEqual(before);
    });

    it.each(["operation", "strategy"] as const)("rejects an unexecutable raw v6 scene-only %s before legacy adaptation", (field) => {
        const { input, analysis, plan } = purposeFixture();
        if (field === "operation") plan.operation = "local_edit";
        else plan.strategy = "strict_product";
        const before = structuredClone({ input, analysis, plan });

        expect(() => normalizePlannedEdit(plan, input, analysis, "planner-model")).toThrow(expect.objectContaining({ issues: [expect.objectContaining({ code: "edit_plan_boundary", path: field })] }));
        expect({ input, analysis, plan }).toEqual(before);
    });

    it("keeps an authorized style-only product delta and unknown scene facts unchanged", () => {
        const { input, analysis, plan } = productPurposeFixture("参考图片1的风格，修改图片2");
        plan.delta = { requestedChanges: ["match the authorized style"], targetObjects: [], targetRegions: ["background"] };
        const before = structuredClone({ input, analysis, plan });
        const result = normalizePlannedEdit(plan, input, analysis, "planner-model")!;

        expect(result.operation).toBe("product_to_scene");
        expect(result.strategy).toBe("strict_product");
        expect(result.baseline.sceneFacts).toBeNull();
        expect(result.delta).toEqual(plan.delta);
        expect({ input, analysis, plan }).toEqual(before);
    });

    it("takes v6 scene facts only from the edit target even when the auxiliary scene is first", () => {
        const { input, analysis, plan } = purposeFixture();
        const result = normalizePlannedEdit(plan, input, analysis, "planner-model")!;
        expect(result.baseline.sceneFacts).toEqual(analysis.references[1].sceneFacts);
        expect(result.referenceUses).toEqual([
            { assetId: "scene", alias: null, purposes: ["edit_target"], usedCueIds: [] },
            { assetId: "aux", alias: "图片1", purposes: ["lighting"], usedCueIds: ["light"] },
        ]);
        expect(result.planVersion).toBe("ecommerce-edit.v6");
    });

    it("keeps unknown v6 target scene facts null instead of borrowing the reference room", () => {
        const { input, analysis, plan } = purposeFixture();
        analysis.references[1].sceneFacts = null;
        const result = normalizePlannedEdit(plan, input, analysis, "planner-model")!;
        expect(result.baseline.sceneFacts).toBeNull();
        expect(result.delta.requestedChanges).toEqual(plan.delta.requestedChanges);
    });

    it.each(["version", "uses"])("requires the active raw v6 %s contract before normalization", (kind) => {
        const { input, analysis, plan } = purposeFixture();
        if (kind === "version") plan.planVersion = "ecommerce-edit.v5";
        else delete plan.referenceUses;
        expect(() => normalizePlannedEdit(plan, input, analysis, "planner-model")).toThrow(kind === "version" ? "版本" : "referenceUses");
    });

    it.each([
        ["参考图片1光线，修改图片2商品颜色为白色", "change product color to white"],
        ["将图片2商品材质改为金属", "change product material to metal"],
        ["不要改变背景，把商品颜色改成白色", "change product color to white"],
        ["将商品材质改为金属并保持背景不变", "change product material to metal"],
        ["商品颜色换成白色", "change product color to white"],
        ["修改产品的材料为金属", "change product material to metal"],
        ["参考图片1光线，修改图片2商品颜色为白色", "generate a living room"],
        ["将图片2商品材质改为金属", "generate a living room"],
        ["参考图片1光线，把图片2中的商品颜色从黑色改成白色", "change product color from black to white"],
        ["参考图片1光线，把图片2中的商品颜色从黑色改成白色", "generate a living room"],
        ["参考图片1光线，将图片2中的商品材质由木质换成金属", "change product material from wood to metal"],
        ["参考图片1光线，将图片2中的商品材质由木质换成金属", "generate a living room"],
        ["不要改变商品颜色，但将商品材质由木质换成金属", "generate a living room"],
        ["参考图片1光线，修改图片2背景颜色和商品颜色", "generate a living room"],
        ["参考图片1光线，把图片2中的背景颜色和商品颜色都改成白色", "generate a living room"],
        ["不要改变商品颜色但把商品材质和背景地板材质一起换成金属", "generate a living room"],
        ...["中的", "里面的", "里的", "的"].flatMap((qualifier) => [
            [`参考图片1光线，修改图片2${qualifier}商品颜色为白色`, "change product color to white"],
            [`参考图片1光线，修改图片2${qualifier}商品颜色为白色`, "generate a living room"],
            [`不要改变背景，将图片2${qualifier}商品材质改为金属`, "change product material to metal"],
        ]),
    ])("rejects a protected product request without erasing it: %s / %s", (userRequest, modelDelta) => {
        const { input, analysis, plan } = productPurposeFixture(userRequest);
        plan.delta.requestedChanges = [modelDelta];
        const original = structuredClone({ input, plan });
        const profile = resolveEcommerceImageProviderProfile({
            logicalRole: "image_generation",
            capability: "image",
            logicalModelId: "image-generation",
            channelId: "fixture",
            upstreamModel: "gpt-image-2.5-flare",
            apiFormat: "openai",
            imageEdit: resolveImageEditProtocol({ apiFormat: "openai", model: "gpt-image-2.5-flare" }),
        })!;
        expect(() => compileEcommerceImageRequest(normalizePlannedEdit(plan, input, analysis, "planner-model")!, profile)).toThrow("暂不支持修改商品颜色或材质");
        expect(input.planningInput.userRequest).toBe(original.input.planningInput.userRequest);
        expect(plan.preserve).toEqual(original.plan.preserve);
        expect(analysis.references[0].productFacts).toEqual(productFacts());
    });

    it.each([
        "参考图片1光线，修改图片2商品结构为四层抽屉，同时生成客厅",
        "参考图片1光线，把图片2中的商品结构从三层改成四层",
        "参考图片1光线，将图片2商品抽屉数量改为四个",
        "参考图片1光线，把图片2商品柜门数量换成两个",
        "参考图片1光线，修改图片2商品把手形状为圆形",
        "参考图片1光线，将图片2商品腿数量改为四条",
        "参考图片1光线，修改图片2背景结构和商品结构",
        "参考图片1光线，不要改变背景结构，但把商品结构改成四层抽屉",
        "参考图片1光线，change product structure to four drawers",
        "参考图片1光线，change product shape to round",
        "参考图片1光线，修改图片2场景，新增商品抽屉，同时生成客厅",
        "参考图片1光线，修改图片2场景，删除商品把手，同时生成客厅",
        "参考图片1光线，修改图片2场景，商品抽屉数量增加到四个，同时生成客厅",
        "参考图片1光线，修改图片2场景，添加商品柜门，同时生成客厅",
        "参考图片1光线，修改图片2场景，商品抽屉数量减少到两个，同时生成客厅",
        "参考图片1光线，修改图片2场景，移除商品把手，同时生成客厅",
        "参考图片1光线，修改图片2场景，去掉商品腿，同时生成客厅",
        "参考图片1光线，修改图片2场景，增加背景结构和商品抽屉数量",
        "参考图片1光线，修改图片2场景，商品把手和背景结构都删除",
        "参考图片1光线，修改图片2场景，add product drawers and generate a living room",
        "参考图片1光线，修改图片2场景，remove product handles and generate a living room",
        "参考图片1光线，修改图片2场景，delete product legs and generate a living room",
        "参考图片1光线，修改图片2场景，increase product drawer count to four and generate a living room",
        "参考图片1光线，修改图片2场景，product door count decrease to one and generate a living room",
    ])("rejects an original product structure request before an environment-only planner delta: %s", async (userRequest) => {
        const { input, analysis: rawAnalysis, plan } = productPurposeFixture(userRequest);
        const normalized = normalizeEcommerceVisualAnalysis(rawAnalysis, input.planningInput.assetCandidates);
        expect(normalized?.analysisVersion).toBe("ecommerce-visual-analysis.v4");
        if (normalized?.analysisVersion !== "ecommerce-visual-analysis.v4") throw new Error("Invalid visual fixture");
        const analysis = { ...normalized, modelRole: rawAnalysis.modelRole };
        input.referenceDecision = resolveEcommerceReferenceDecision({ planningInput: input.planningInput, analysis });
        expect(input.referenceDecision.state).toBe("resolved");
        plan.referenceUses = referenceUsesFromEcommerceDecision({ decision: input.referenceDecision, sourceOrder: ["product", "scene"] });
        plan.delta.requestedChanges = ["generate a living room"];
        mockedRequest.mockResolvedValue(modelCall(plan));
        const original = structuredClone({ input, analysis, plan });

        await expect(planEcommerceEdit(input, analysis, [roleCandidate("edit_planning", "planner-model", "fixture")])).rejects.toThrow("结构");
        expect(mockedRequest).not.toHaveBeenCalled();
        expect(() => normalizePlannedEdit(plan, input, analysis, "planner-model")).toThrow("结构");
        expect({ input, analysis, plan }).toEqual(original);
    });

    it.each([
        "参考图片1光线，修改图片2场景，不要改变商品结构",
        "参考图片1光线，修改图片2场景，商品结构不要从三层改成四层",
        "参考图片1光线，修改图片2背景结构，保持商品结构不变",
        "参考图片1光线，修改图片2场景，商品抽屉数量和背景结构都不要修改",
        "参考图片1光线，修改图片2背景结构和墙面材质，保留商品抽屉数量",
        "参考图片1光线和风格，修改图片2场景，商品结构从原图继承",
        "参考图片1光线，修改图片2场景，不要删除商品把手，只改背景",
        "参考图片1光线，修改图片2场景，商品抽屉数量不要增加到四个，只改背景",
        "参考图片1光线，修改图片2场景，禁止新增商品抽屉，只改背景",
        "参考图片1光线，修改图片2场景，不要同时增加商品抽屉数量和背景结构",
        "参考图片1光线，修改图片2场景，商品把手和背景结构都不要删除",
        "参考图片1光线，修改图片2场景，添加背景摆件，保持商品结构不变",
        "参考图片1光线，修改图片2场景，删除背景墙装饰，保留商品把手",
        "参考图片1光线，修改图片2场景，新增背景结构，保持商品抽屉数量",
        "参考图片1光线，修改图片2场景，do not add product drawers, change background",
        "参考图片1光线，修改图片2场景，do not remove product handles, change background",
        "参考图片1光线，修改图片2场景，product drawer count do not increase, change background",
        "参考图片1光线，修改图片2场景，add background structure, preserve product structure",
        "参考图片1光线，修改图片2场景，delete background handles, keep product handles",
    ])("keeps product structure preservation and environment structure edits executable: %s", async (userRequest) => {
        const { input, analysis: rawAnalysis, plan } = productPurposeFixture(userRequest);
        const normalized = normalizeEcommerceVisualAnalysis(rawAnalysis, input.planningInput.assetCandidates);
        expect(normalized?.analysisVersion).toBe("ecommerce-visual-analysis.v4");
        if (normalized?.analysisVersion !== "ecommerce-visual-analysis.v4") throw new Error("Invalid visual fixture");
        const analysis = { ...normalized, modelRole: rawAnalysis.modelRole };
        input.referenceDecision = resolveEcommerceReferenceDecision({ planningInput: input.planningInput, analysis });
        expect(input.referenceDecision.state).toBe("resolved");
        plan.referenceUses = referenceUsesFromEcommerceDecision({ decision: input.referenceDecision, sourceOrder: ["product", "scene"] });
        const original = structuredClone({ input, analysis, plan });
        mockedRequest.mockResolvedValue(modelCall(plan));

        const result = await planEcommerceEdit(input, analysis, [roleCandidate("edit_planning", "planner-model", "fixture")]);

        expect(mockedRequest).toHaveBeenCalledOnce();
        expect(result.plan.preserve.productCore).toEqual(plan.preserve.productCore);
        expect(result.plan.baseline.productFacts).toEqual(productFacts());
        expect({ input, analysis, plan }).toEqual(original);
    });

    it.each([
        "参考图片1光线，修改图片2场景，不要改变商品颜色和材质",
        "把背景墙的颜色改为白色，保持商品颜色不变",
        "将背景地板材质改为金属，不要改变商品材质",
        "参考图片1的木质风格生成场景，不改变商品外观",
        "商品颜色不要修改，背景改成白色",
        "修改背景材质，不要改变商品材质",
        "保留产品颜色并调整光线",
        "参考图片1光线，修改图片2场景，请不要更改商品颜色和材质",
        "参考图片1光线，修改图片2场景，不要让商品颜色变成白色",
        "参考图片1光线，修改图片2场景，商品颜色不要从黑色改成白色",
        "参考图片1光线，修改图片2场景，请勿将商品材质由木质换成金属",
        "参考图片1光线，修改图片2场景，不要把商品颜色和背景颜色都改成白色",
        "参考图片1光线，修改图片2场景，商品材质和背景地板材质都不要换成金属",
        "参考图片1光线，修改图片2场景，商品颜色保持不变并将背景颜色改成白色",
        "参考图片1光线，修改图片2场景，保持商品材质和颜色并将背景地板材质换成金属",
        "参考图片1光线，修改图片2场景，不要同时修改商品颜色和背景颜色",
        "参考图片1光线，修改图片2场景，禁止一起修改商品材质和背景地板材质",
        "参考图片1光线，修改图片2场景，商品材质由原图继承并将背景地板材质换成金属",
        "参考图片1光线，修改图片2场景，商品颜色从原图继承并将背景颜色改成白色",
        ...["中的", "里面的", "里的", "的"].flatMap((qualifier) => [`修改图片2场景，不要对图片2${qualifier}商品颜色进行修改`, `修改图片2场景，将背景地板材质改成石材，禁止修改图片2${qualifier}商品材质`]),
    ])("keeps scene edits and product-preservation instructions executable: %s", (userRequest) => {
        const { input, analysis, plan } = productPurposeFixture(userRequest);
        const profile = resolveEcommerceImageProviderProfile({
            logicalRole: "image_generation",
            capability: "image",
            logicalModelId: "image-generation",
            channelId: "fixture",
            upstreamModel: "gpt-image-2.5-flare",
            apiFormat: "openai",
            imageEdit: resolveImageEditProtocol({ apiFormat: "openai", model: "gpt-image-2.5-flare" }),
        })!;
        const normalized = normalizePlannedEdit(plan, input, analysis, "planner-model")!;
        expect(compileEcommerceImageRequest(normalized, profile).state).toBe("ready");
        expect(normalized.preserve.productCore).toEqual(expect.arrayContaining(["color", "material"]));
        expect(normalized.baseline.productFacts).toEqual(productFacts());
    });

    it.each([
        ["参考图片1光线，把图片2中的商品颜色和背景颜色都改成白色", "change product color and background color to white"],
        ["参考图片1光线，将图片2中的商品材质和背景地板材质一起换成金属", "change product material and background floor material to metal"],
    ])("rejects shared product and environment actions through legal v4 sources and both compilers: %s", (userRequest, requestedChange) => {
        const { input, analysis: rawAnalysis, plan } = productPurposeFixture(userRequest);
        const analysis = normalizeEcommerceVisualAnalysis(rawAnalysis, input.planningInput.assetCandidates);
        expect(analysis?.analysisVersion).toBe("ecommerce-visual-analysis.v4");
        if (analysis?.analysisVersion !== "ecommerce-visual-analysis.v4") throw new Error("Invalid visual fixture");
        input.referenceDecision = resolveEcommerceReferenceDecision({ planningInput: input.planningInput, analysis });
        const sources = resolveSourcesFromEcommerceReferenceDecision(
            input.referenceDecision,
            input.planningInput.assetCandidates.map((asset, ordinal) => ({ ...asset, userId: "fixture-user", conversationId: "fixture-conversation", ordinal, status: "ready", serverUrl: asset.url, metadata: {}, createdAt: 1, updatedAt: 1 })),
        );
        const resolvedInput = { ...input, sources };
        expect(input.referenceDecision.state).toBe("resolved");
        expect(sources).toMatchObject({ status: "resolved", productAnchorId: "product", sceneReferenceIds: ["scene"] });
        const original = structuredClone({ input: resolvedInput, analysis });
        for (const model of ["gpt-image-2.5-flare", "nano-banana-2"]) {
            const profile = resolveEcommerceImageProviderProfile({
                logicalRole: "image_generation",
                capability: "image",
                logicalModelId: "image-generation",
                channelId: "fixture",
                upstreamModel: model,
                apiFormat: model === "nano-banana-2" ? "gemini" : "openai",
            })!;
            for (const modelDelta of [requestedChange, "generate a living room"]) {
                plan.delta.requestedChanges = [modelDelta];
                const originalPlan = structuredClone(plan);
                expect(() => compileEcommerceImageRequest(normalizePlannedEdit(plan, resolvedInput, { ...rawAnalysis, ...analysis }, "planner-model")!, profile)).toThrow("暂不支持修改商品颜色或材质");
                expect(plan).toEqual(originalPlan);
            }
        }
        expect({ input: resolvedInput, analysis }).toEqual(original);
    });

    it("rejects a v6 planner source exchange before server canonicalization", () => {
        const { input, analysis, plan } = purposeFixture();
        analysis.references.reverse();
        plan.source = { ...plan.source, currentSceneBaselineId: "aux", sceneReferenceIds: ["scene"] };
        expect(() => normalizePlannedEdit(plan, input, analysis, "planner-model")).toThrow("来源");
    });

    it.each(["missing", "low", "mixed"])("rejects a forged resolved decision without reliable evidence for each purpose (%s)", async (condition) => {
        const { input, analysis, plan } = purposeFixture();
        if (condition === "missing") {
            input.referenceDecision.appliedCues = [];
            analysis.references[0].cues = [];
        } else {
            analysis.references[0].cues[0].confidence = "low";
            if (condition === "mixed") {
                input.referenceDecision.bindings[0].purposes.unshift("style");
                analysis.references[0].cues.push({ id: "style", facet: "style", confidence: "high", description: "简约风格" });
                input.referenceDecision.appliedCues = [{ assetId: "aux", purpose: "style", cueIds: ["style"] }];
                plan.referenceUses![1].purposes.unshift("style");
                plan.referenceUses![1].usedCueIds = ["style"];
            }
        }
        mockedRequest.mockResolvedValue(modelCall(plan));
        const original = structuredClone({ input, analysis, plan });
        expect(() => normalizePlannedEdit(plan, input, analysis, "planner-model")).toThrow("可靠");
        await expect(planEcommerceEdit(input, analysis, [roleCandidate("edit_planning", "planner-model", "fixture")])).rejects.toThrow("可靠");
        expect(mockedRequest).not.toHaveBeenCalled();
        expect({ input, analysis, plan }).toEqual(original);
    });

    it.each(["empty", "missing-lighting"])("requires model-selected cue coverage for every authorized purpose (%s)", (condition) => {
        const { input, analysis, plan } = purposeFixture();
        input.referenceDecision.bindings[0].purposes.unshift("style");
        analysis.references[0].cues.push({ id: "style", facet: "style", confidence: "high", description: "简约风格" });
        input.referenceDecision.appliedCues.unshift({ assetId: "aux", purpose: "style", cueIds: ["style"] });
        plan.referenceUses![1].purposes.unshift("style");
        plan.referenceUses![1].usedCueIds = condition === "empty" ? [] : ["style"];
        expect(() => normalizePlannedEdit(plan, input, analysis, "planner-model")).toThrow("线索");
    });

    it.each(["purpose", "cue"])("rejects an auxiliary v6 %s permission exchange", (kind) => {
        const { input, analysis, plan } = purposeFixture();
        analysis.references.reverse();
        plan.referenceUses = [
            { assetId: "scene", alias: null, purposes: ["edit_target"], usedCueIds: [] },
            { assetId: "aux", alias: "图片1", purposes: kind === "purpose" ? ["product_identity"] : ["lighting"], usedCueIds: kind === "cue" ? ["foreign-cue"] : ["light"] },
        ];
        expect(() => normalizePlannedEdit(plan, input, analysis, "planner-model")).toThrow(kind === "purpose" ? "用途" : "线索");
    });

    it.each(["source", "purpose"])("rejects unversioned active %s claims before the legacy adapter can replace them", (kind) => {
        const input = {
            ...planningRequest(),
            referenceDecision: {
                version: "ecommerce-reference-decision.v1",
                state: "resolved",
                editTargetId: "product",
                productAnchorId: "product",
                currentSceneBaselineId: null,
                bindings: [
                    { assetId: "product", alias: "图片1", purposes: ["edit_target", "product_identity"], source: "explicit" },
                    { assetId: "scene", alias: "图片2", purposes: ["lighting"], source: "explicit" },
                ],
                appliedCues: [],
                issues: [],
            } as EcommerceReferenceDecision,
        };
        const raw = {
            ...validPlan(),
            planVersion: undefined,
            source: { productAnchorId: kind === "source" ? "scene" : "product", currentSceneBaselineId: null, sceneReferenceIds: ["scene"] },
            referenceUses: [{ assetId: "scene", alias: "图片2", purposes: ["product_identity"], usedCueIds: [] }],
        };
        expect(() => normalizePlannedEdit({ editPlan: raw }, input, visualAnalysis(), "planner-model")).toThrow("版本");
    });

    it.each(["structure", "protection"])("rejects auxiliary v6 %s objects while allowing target count comparisons", (kind) => {
        const { input, analysis, plan } = purposeFixture();
        plan.visibleStructure = kind === "structure" ? structuredClone(analysis.references[0].visibleStructure) : structuredClone(analysis.references[1].visibleStructure);
        analysis.references.reverse();
        if (kind === "protection") plan.protection = { scope: "local", protectedObjectIds: ["aux-cabinet"], preserveOutsideMask: true, allowLightingChange: false };
        expect(() => normalizePlannedEdit(plan, input, analysis, "planner-model")).toThrow("主基线");
        plan.visibleStructure = structuredClone(analysis.references[0].visibleStructure);
        plan.visibleStructure[0].count = 4;
        delete plan.protection;
        expect(normalizePlannedEdit(plan, input, analysis, "planner-model")?.visibleStructure?.[0].count).toBe(4);
    });
    it.each(["让场景光线再亮一点。", "调整场景光照为更明亮的自然光，保持机位和构图。"])("honors product continuity relighting without changing the anchor or camera: %s", (userRequest) => {
        const input = {
            ...planningRequest(),
            planningInput: { ...planningInput(), userRequest },
            sources: { ...planningRequest().sources, currentSceneBaselineId: "scene", sceneReferenceIds: [], parentResultId: "scene", startsNewProductAnchor: false },
            canvasInput: { userRequest: { mode: "preserve" as const }, baselineSize: { width: 1024, height: 1024 } },
        };
        const analysis = visualAnalysis();
        analysis.analysisVersion = "ecommerce-visual-analysis.v3";
        for (const reference of analysis.references) reference.photographyFacts = photographyFacts();
        analysis.references[1].editableTargets = sceneVisualAnalysis().references[0].editableTargets;
        const photography = {
            ...photographyFacts(),
            lighting: { ...photographyFacts().lighting, keyLight: "本轮更明亮的自然主光" },
            composition: { focalSubject: "未经授权的鸟瞰商品", depth: "未经授权的新机位", negativeSpace: "未经授权的新构图" },
        };
        const output = validPlan({
            planVersion: "ecommerce-edit.v5",
            operation: "local_edit",
            source: { productAnchorId: "product", currentSceneBaselineId: "scene", sceneReferenceIds: [] },
            delta: { requestedChanges: [userRequest], targetObjects: ["lighting-main"], targetRegions: [] },
            protection: { scope: "global", protectedObjectIds: ["cabinet"], preserveOutsideMask: false, allowLightingChange: true },
            continuity: { parentResultId: "scene", branchId: "branch-one" },
            photography,
        });

        const plan = normalizePlannedEdit(output, input, analysis, "planner-model")!;

        expect(plan).toMatchObject({
            operation: "local_edit",
            strategy: "strict_product",
            source: { productAnchorId: "product", currentSceneBaselineId: "scene" },
            continuity: { parentResultId: "scene", branchId: "branch-one" },
            protection: { scope: "global", preserveOutsideMask: false, allowLightingChange: true, protectedObjectIds: expect.arrayContaining(["product", "cabinet"]) },
            canvas: { mode: "exact", size: { width: 1024, height: 1024 }, allowReframe: false },
        });
        expect(plan.preserve.productCore).toEqual(expect.arrayContaining(["outline", "brand_text", "color", "material", "scale", "view"]));
        expect(plan.photography?.lighting.keyLight).toBe("本轮更明亮的自然主光");
        expect(plan.photography?.composition).toEqual(photographyFacts().composition);
        expect(plan.photography?.materials[0]).toMatchObject({ textureDirection: "沿原图木纹方向", gloss: "保留原有低光泽" });
        const profile = resolveEcommerceImageProviderProfile({
            logicalRole: "image_generation",
            capability: "image",
            logicalModelId: "image-generation",
            channelId: "fixture",
            upstreamModel: "gpt-image-2.5-flare",
            apiFormat: "openai",
            imageEdit: resolveImageEditProtocol({ apiFormat: "openai", model: "gpt-image-2.5-flare" }),
        })!;
        const compiled = compileEcommerceImageRequest(plan, profile);
        expect(compiled).toMatchObject({ state: "ready", mask: { mode: "independent", required: true }, protection: { scope: "global", allowLightingChange: true } });
        expect(compiled.prompt).toContain("本轮更明亮的自然主光");
        expect(compiled.prompt).not.toContain("不得改变全图光照");
    });
    it.each([
        "只加柜面花瓶，保持场景光线不变。",
        "只加柜面花瓶，不要让场景光线再亮一点。",
        "场景光线不要再亮一点。",
        "只加柜面花瓶，光线不要再亮一点。",
        "只加柜面花瓶，不要把光线变得更亮。",
        "不要让场景光线再亮一点并且调整机位。",
        "只让选区内的光线再亮一点。",
        "场景光线。",
        "调整全图机位为俯视。",
    ])("keeps product continuity preservation ahead of planner scope: %s", (userRequest) => {
        const input = {
            ...planningRequest(),
            planningInput: { ...planningInput(), userRequest },
            sources: { ...planningRequest().sources, currentSceneBaselineId: "scene", sceneReferenceIds: [], parentResultId: "scene", startsNewProductAnchor: false },
        };
        const analysis = visualAnalysis();
        for (const reference of analysis.references) reference.photographyFacts = photographyFacts();
        analysis.references[1].editableTargets = sceneVisualAnalysis().references[0].editableTargets;
        const output = validPlan({
            planVersion: "ecommerce-edit.v5",
            operation: "local_edit",
            source: { productAnchorId: "product", currentSceneBaselineId: "scene", sceneReferenceIds: [] },
            delta: { requestedChanges: [userRequest], targetObjects: ["lighting-main"], targetRegions: [] },
            protection: { scope: "global", protectedObjectIds: ["cabinet"], preserveOutsideMask: false, allowLightingChange: true },
            continuity: { parentResultId: "scene", branchId: "branch-one" },
            photography: { ...photographyFacts(), lighting: { ...photographyFacts().lighting, keyLight: "未经授权的新主光" }, composition: { focalSubject: "未经授权的新视角", depth: "未经授权的新机位", negativeSpace: "未经授权的新构图" } },
        });

        const plan = normalizePlannedEdit(output, input, analysis, "planner-model")!;

        expect(plan.protection).toMatchObject({ scope: "local", allowLightingChange: false, preserveOutsideMask: false, protectedObjectIds: expect.arrayContaining(["product"]) });
        expect(plan.photography?.lighting.keyLight).toBe("保留原有左侧大面积柔光");
        expect(plan.photography?.composition).toEqual(photographyFacts().composition);
        const profile = resolveEcommerceImageProviderProfile({
            logicalRole: "image_generation",
            capability: "image",
            logicalModelId: "image-generation",
            channelId: "fixture",
            upstreamModel: "gpt-image-2.5-flare",
            apiFormat: "openai",
            imageEdit: resolveImageEditProtocol({ apiFormat: "openai", model: "gpt-image-2.5-flare" }),
        })!;
        const compiled = compileEcommerceImageRequest(plan, profile);
        expect(compiled).toMatchObject({ state: "ready", mask: { mode: "independent", required: true }, protection: { scope: "local", allowLightingChange: false } });
        expect(compiled.prompt).not.toContain("未经授权");
    });
    it.each([
        { userRequest: "调整全图白平衡为中性，保持机位和构图", lighting: { whiteBalance: "中性白平衡" }, changesComposition: false },
        { userRequest: "调整全图主光为右侧柔光，保持机位和构图", lighting: { keyLight: "右侧大面积柔光" }, changesComposition: false },
        { userRequest: "调整全图补光为正面柔光，保持机位和构图", lighting: { fillLight: "正面柔和补光" }, changesComposition: false },
        { userRequest: "调整全图白平衡和构图", lighting: { whiteBalance: "中性白平衡" }, changesComposition: true },
    ])("honors global photography scope for $userRequest", async ({ userRequest, lighting, changesComposition }) => {
        const input = scenePlanningRequest();
        input.planningInput.userRequest = userRequest;
        const analysis = sceneVisualAnalysis();
        analysis.analysisVersion = "ecommerce-visual-analysis.v3";
        const facts = { ...photographyFacts(), lighting: { ...photographyFacts().lighting, whiteBalance: "原图轻微暖偏白平衡" } };
        analysis.references[0].photographyFacts = facts;
        analysis.references[0].visibleStructure = [];
        const photography = {
            ...facts,
            lighting: { ...facts.lighting, ...lighting },
            composition: { focalSubject: "柜体新明度层次", depth: "本轮空间纵深", negativeSpace: "本轮重新留白" },
        };
        mockedRequest.mockResolvedValue(modelCall(photographyScenePlan(photography)));

        const { plan } = await planEcommerceEdit(input, analysis, plannerRole([candidate("planner")]));

        expect({ protection: plan.protection, lighting: plan.photography?.lighting }).toMatchObject({ protection: { scope: "global", allowLightingChange: true, preserveOutsideMask: false }, lighting: photography.lighting });
        expect(plan.photography?.composition).toEqual(changesComposition ? photography.composition : facts.composition);
        expect(plan.photography?.materials[0]).toMatchObject({ textureDirection: "沿原图木纹方向", gloss: "保留原有低光泽" });
    });
    it.each([
        ["只加柜面花瓶", "local", false],
        ["只加柜面花瓶，不要改变主光、补光和白平衡", "local", false],
        ["只加柜面花瓶，保持主光、补光和白平衡不变", "local", false],
        ["禁止同时调整全图主光、补光和白平衡，只加柜面花瓶", "local", false],
        ["不要改变主光并且调整机位", "local", false],
        ["只调整选区内补光，保持全图白平衡和机位", "local", false],
        ["仅调整局部白平衡，不改变机位和主光", "local", false],
        ["调整全图机位为俯视", "global", true],
        ["调整全图构图，不要改变主光、补光和白平衡", "global", true],
    ])("preserves photography scope restrictions for %s", async (userRequest, scope, changesComposition) => {
        const input = scenePlanningRequest();
        input.planningInput.userRequest = userRequest as string;
        const analysis = sceneVisualAnalysis();
        analysis.analysisVersion = "ecommerce-visual-analysis.v3";
        const facts = photographyFacts();
        analysis.references[0].photographyFacts = facts;
        analysis.references[0].visibleStructure = [];
        const photography = {
            ...facts,
            lighting: { keyLight: "未经授权的新主光", fillLight: "未经授权的新补光", whiteBalance: "未经授权的新白平衡", contactShadow: "未经授权的新阴影" },
            composition: { focalSubject: "柜体新明度层次", depth: "本轮空间纵深", negativeSpace: "本轮重新留白" },
        };
        const output = photographyScenePlan(photography);
        output.protection = { scope: "global", allowLightingChange: true, protectedObjectIds: ["cabinet"], preserveOutsideMask: false };
        mockedRequest.mockResolvedValue(modelCall(output));

        const { plan } = await planEcommerceEdit(input, analysis, plannerRole([candidate("planner")]));

        expect(plan.protection).toMatchObject({ scope, allowLightingChange: false, preserveOutsideMask: scope === "local" });
        expect(plan.photography?.lighting).toMatchObject({ keyLight: `保留原有${facts.lighting.keyLight}`, fillLight: `保留原有${facts.lighting.fillLight}`, whiteBalance: `保留原有${facts.lighting.whiteBalance}` });
        expect(plan.photography?.composition).toEqual(changesComposition ? photography.composition : facts.composition);
        expect(plan.photography?.materials[0]).toMatchObject({ textureDirection: "沿原图木纹方向", gloss: "保留原有低光泽" });
        if (scope === "local") expect(plan.photography?.lighting.contactShadow).toContain("仅在允许区域");
    });
    it("preserves cabinet material and existing photography when only adding a vase", () => {
        const input = scenePlanningRequest();
        input.planningInput.userRequest = "只加柜面花瓶，不改变机位和光照";
        const analysis = sceneVisualAnalysis();
        analysis.references[0].photographyFacts = photographyFacts();
        const output = validPlan({
            planVersion: "ecommerce-edit.v5",
            operation: "scene_edit",
            source: { productAnchorId: null, currentSceneBaselineId: "scene", sceneReferenceIds: [] },
            baseline: { productFacts: null, sceneFacts: analysis.references[0].sceneFacts! },
            preserve: { productCore: [], sceneElements: ["cabinet"] },
            strategy: "integrated_scene",
            photography: { ...photographyFacts(), materials: [{ ...photographyFacts().materials[0], gloss: "油亮高光" }], lighting: { ...photographyFacts().lighting, keyLight: "新增台灯照亮全图" } },
        });
        const plan = normalizePlannedEdit(output, input, analysis, "planner-model")!;
        expect(plan.photography?.materials[0]).toMatchObject({ objectId: "cabinet", textureDirection: "沿原图木纹方向", gloss: "保留原有低光泽" });
        expect(plan.protection).toMatchObject({ scope: "local", allowLightingChange: false });
        expect(plan.photography?.lighting.keyLight).toBe("保留原有左侧大面积柔光");
        expect(plan.photography?.composition).toEqual(photographyFacts().composition);
        expect(plan.photography?.lighting.contactShadow).toContain("仅在允许区域");
        expect(JSON.stringify(plan.photography)).not.toMatch(/新增台灯|油亮/);
        expect(plan.validation.requiredChecks).toEqual(expect.arrayContaining(["protected_material", "composition_lighting", "scene_intent"]));
    });
    it("allows environmental light and contact shadow for product-to-scene without replacing anchor material", () => {
        const analysis = visualAnalysis();
        analysis.references[0].photographyFacts = photographyFacts();
        analysis.references[1].photographyFacts = { ...photographyFacts(), materials: [{ ...photographyFacts().materials[0], gloss: "高光泽参考家具" }] };
        const photography = { ...photographyFacts(), lighting: { ...photographyFacts().lighting, keyLight: "左侧窗户的大面积环境主光", contactShadow: "商品落地接触阴影" } };
        const plan = normalizePlannedEdit(validPlan({ planVersion: "ecommerce-edit.v5", photography }), planningRequest(), analysis, "planner-model")!;
        expect(plan.photography?.lighting).toEqual(photography.lighting);
        expect(plan.photography?.materials[0].gloss).toBe("保留原有低光泽");
    });
    it("canonicalizes an invalid global outside-mask flag for product-to-scene", () => {
        const plan = normalizePlannedEdit(
            validPlan({
                protection: { scope: "global", protectedObjectIds: ["cabinet-main"], preserveOutsideMask: true, allowLightingChange: true },
            }),
            planningRequest(),
            visualAnalysis(),
            "planner-model",
        );

        expect(plan?.protection).toEqual({ scope: "global", protectedObjectIds: ["cabinet-main"], preserveOutsideMask: false, allowLightingChange: true });
    });
    it("does not invent photography facts or accept unobserved material objects", () => {
        const output = validPlan({ planVersion: "ecommerce-edit.v5", photography: photographyFacts() });
        expect(() => normalizePlannedEdit(output, planningRequest(), visualAnalysis(), "planner-model")).toThrow("摄影事实");
        const analysis = visualAnalysis();
        analysis.references[0].photographyFacts = photographyFacts();
        output.photography!.materials[0].objectId = "invented-furniture";
        expect(() => normalizePlannedEdit(output, planningRequest(), analysis, "planner-model")).toThrow("材质对象");
    });
    it("preserves composition when the user globally changes light but keeps the camera", () => {
        const input = scenePlanningRequest();
        input.planningInput.userRequest = "把整体灯光改为冬日阳光，保持机位和构图不变";
        const analysis = sceneVisualAnalysis();
        analysis.references[0].photographyFacts = photographyFacts();
        const photography = { ...photographyFacts(), lighting: { ...photographyFacts().lighting, keyLight: "冬日窗光" }, composition: { focalSubject: "鸟瞰柜体", depth: "改变机位", negativeSpace: "重新构图" } };
        const output = validPlan({
            planVersion: "ecommerce-edit.v5",
            operation: "scene_edit",
            source: { productAnchorId: null, currentSceneBaselineId: "scene", sceneReferenceIds: [] },
            baseline: { productFacts: null, sceneFacts: analysis.references[0].sceneFacts! },
            preserve: { productCore: [], sceneElements: ["cabinet"] },
            strategy: "integrated_scene",
            photography,
        });
        const plan = normalizePlannedEdit(output, input, analysis, "planner-model")!;
        expect(plan.protection).toMatchObject({ scope: "global", allowLightingChange: true });
        expect(plan.photography?.lighting.keyLight).toBe("冬日窗光");
        expect(plan.photography?.composition).toEqual(photographyFacts().composition);
    });
    it("keeps the planner's structure claim separately from the visual baseline facts", () => {
        const analysis = visualAnalysis();
        const region = { x: 0, y: 0, width: 100, height: 100 };
        analysis.references[0].visibleStructure = [{ objectId: "cabinet", feature: "drawers", count: 3, certainty: "confirmed", evidenceRegion: region }];
        const output = validPlan({
            planVersion: "ecommerce-edit.v4" as EcommerceEditPlan["planVersion"],
            visibleStructure: [{ objectId: "cabinet", feature: "drawers", count: 4, certainty: "confirmed", evidenceRegion: region }],
        } as Partial<EcommerceEditPlan>);
        const plan = normalizePlannedEdit(output, planningRequest(), analysis, "planner-model");
        expect(plan?.visibleStructure?.[0].count).toBe(4);
        expect(analysis.references[0].visibleStructure[0].count).toBe(3);
    });
    it("retains a frozen null quality role and rejects a planner that adds a quality model", () => {
        const input = { ...planningRequest(), qualityCheckModelRole: null };
        const plan = validPlan();
        plan.planVersion = "ecommerce-edit.v2";
        plan.canvas = { mode: "exact", size: { width: 100, height: 80 }, source: "default", allowReframe: false };
        plan.modelRoles.qualityCheck = null;
        expect(normalizePlannedEdit(plan, input, visualAnalysis(), "planner-model")?.modelRoles.qualityCheck).toBeNull();
        expect(() => normalizePlannedEdit({ ...plan, modelRoles: { ...plan.modelRoles, qualityCheck: "quality-check" } }, input, visualAnalysis(), "planner-model")).toThrow();
    });
    it.each([
        ["只加柜面花瓶，不改变机位和光照", "local"],
        ["只加柜面花瓶，保持灯光不变", "local"],
        ["只加柜面花瓶，保持整体光照不变", "local"],
        ["只加柜面花瓶，保持全图机位和构图不变", "local"],
        ["只加柜面花瓶，禁止改变整体光照", "local"],
        ["只加柜面花瓶，不要对整体光照做任何改变", "local"],
        ["只加柜面花瓶，禁止对全图机位和构图做任何调整", "local"],
        ["只加柜面花瓶，对整体光照不作任何改变", "local"],
        ["只加柜面花瓶，不要同时改变整体光照和机位", "local"],
        ["只加柜面花瓶，禁止同时对整体光照和机位做任何调整", "local"],
        ["只加柜面花瓶，不要同时把整体光照改成暖色", "local"],
        ["只加柜面花瓶，不要改变光照并调整机位", "local"],
        ["只加柜面花瓶，不要改变光照并且调整机位", "local"],
        ...["同时", "并且", "而且"].flatMap((connector) => ["把", "将"].flatMap((marker) => ["", "，这两项调整都禁止"].map((prohibition) => [`只加柜面花瓶，不要改变光照${connector}${marker}机位调整成俯视${prohibition}`, "local"]))),
        ["只加柜面花瓶，整体光照", "local"],
        ["把灯光改成暖色", "global"],
        ["把整体灯光改为冬日阳光", "global"],
        ["不要对全图机位做任何改变，把灯光改成暖色", "global"],
        ["把灯光改成暖色，不要对全图机位做任何改变", "global"],
        ["保持全图机位和构图不变，把灯光改成暖色", "global"],
        ["把灯光改成暖色，保持机位和构图不变", "global"],
        ["整体光照同时机位和构图", "local"],
        ...["同时", "但"].flatMap((connector) => [
            [`把灯光改成暖色${connector}保持机位和构图不变`, "global"],
            [`保持机位和构图不变${connector}把灯光改成暖色`, "global"],
            [`把灯光改成暖色${connector}不要对机位与构图做任何改变`, "global"],
        ]),
        ["不要对机位与构图做任何改变但把灯光改成暖色", "global"],
        ["不要对机位与构图做任何改变同时把灯光改成暖色", "local"],
        ...["同时", "但"].flatMap((connector) =>
            ["保持整体光照与机位和构图不变", "禁止对整体光照与机位和构图做任何调整"].flatMap((preservation) => [
                [`只改柜面花瓶${connector}${preservation}`, "local"],
                [`${preservation}${connector}只改柜面花瓶`, "local"],
            ]),
        ),
    ])("binds protection to this request: %s", (userRequest, scope) => {
        const request = scenePlanningRequest();
        request.planningInput = { ...request.planningInput, userRequest };
        const output = validPlan({
            operation: "scene_edit",
            source: { productAnchorId: null, currentSceneBaselineId: "scene", sceneReferenceIds: [] },
            baseline: { productFacts: null, sceneFacts: { space: "living room", composition: "eye-level wide view", lighting: "soft daylight" } },
            preserve: { productCore: [], sceneElements: ["cabinet"] },
            strategy: "integrated_scene",
        });
        const normalized = normalizePlannedEdit(output, request, sceneVisualAnalysis(), "planner-model");
        expect(normalized).toMatchObject({ planVersion: ECOMMERCE_EDIT_PLAN_VERSION, protection: { scope, preserveOutsideMask: scope === "local", allowLightingChange: scope === "global" } });
        const profile = resolveEcommerceImageProviderProfile({
            logicalRole: "image_generation",
            capability: "image",
            logicalModelId: "image-generation",
            channelId: "fixture",
            upstreamModel: "gpt-image-2.5-flare",
            apiFormat: "openai",
            imageEdit: resolveImageEditProtocol({ apiFormat: "openai", model: "gpt-image-2.5-flare" }),
        })!;
        const compiled = compileEcommerceImageRequest(normalized!, profile);
        expect(compiled).toMatchObject({ state: "ready", protection: normalized!.protection });
        if (scope === "local") expect(compiled.mask).toEqual({ mode: "independent", required: true });
        else {
            expect(compiled.mask).toBeUndefined();
            expect(compiled.prompt).toContain("不承诺选区外像素");
        }
    });
    it("canonicalizes canvas from the current request and decoded baseline ahead of planner claims", () => {
        const input = { ...scenePlanningRequest(), canvasInput: { userRequest: { mode: "preserve" as const }, explicitSize: { width: 3000, height: 2000 }, baselineSize: { width: 3840, height: 2160 } } };
        const output = {
            ...validPlan(),
            operation: "scene_edit",
            source: { productAnchorId: null, currentSceneBaselineId: "scene", sceneReferenceIds: [] },
            baseline: { productFacts: null, sceneFacts: { space: "living room", composition: "eye-level wide view", lighting: "soft daylight" } },
            preserve: { productCore: [], sceneElements: ["camera"] },
            strategy: "integrated_scene",
            canvas: { mode: "ratio", size: { width: 9, height: 16 }, source: "planning", allowReframe: true },
        };
        expect(normalizePlannedEdit(output, input, sceneVisualAnalysis(), "planner-model")?.canvas).toEqual({ mode: "exact", size: { width: 3840, height: 2160 }, source: "user_text", allowReframe: false });
    });
    beforeEach(() => {
        mockedRequest.mockReset();
        mocks.refundUserPoints.mockClear();
    });

    it("rejects a plan when a required model field is missing", async () => {
        const value = validPlan() as unknown as Record<string, unknown>;
        value.baseline = { ...(value.baseline as Record<string, unknown>), productFacts: { ...productFacts(), material: undefined } };
        mockedRequest.mockResolvedValue(modelCall(value));

        await expect(planEcommerceEdit(planningRequest(), visualAnalysis(), plannerRole([candidate("planner")]))).rejects.toThrow("字段");
    });

    it("adapts the scene-generation contract returned by a compatible planner", async () => {
        mockedRequest.mockResolvedValue(
            modelCall({
                operation: "scene_generation_and_product_compositing",
                source: { productAssetId: "product", sceneReferenceAssetId: null, inputType: "white-background-product" },
                baseline: {
                    productFacts: productFacts(),
                    sceneFacts: { background: "white", environment: "no existing scene", referenceAvailable: false },
                },
                delta: {
                    background: "bright modern minimalist home interior",
                    environmentElements: ["warm white wall", "light wood furniture"],
                    lighting: "soft natural window light",
                    composition: "product centered with generous negative space",
                    style: "modern minimalist European home",
                    mood: "bright and comfortable",
                },
                preserve: {
                    productIdentity: true,
                    geometry: true,
                    outline: true,
                    proportions: true,
                    color: true,
                    woodMaterial: true,
                    woodGrain: true,
                    frontView: true,
                    brandText: true,
                    prohibitedChanges: ["do not change the product structure"],
                },
                strategy: { method: "lock the product and redraw the background", steps: ["segment product", "generate scene"] },
                modelRoles: { visionAnalysis: "vision-model", editPlanning: "planner-model", generation: "image-generation", qualityCheck: "quality-check" },
                continuity: { branchId: "branch-one" },
                validation: { checks: [{ name: "product identity", criterion: "product remains unchanged", required: true }] },
            }),
        );

        const result = await planEcommerceEdit(planningRequest(), visualAnalysis(), plannerRole([candidate("planner")]));

        expect(result.plan.operation).toBe("product_to_scene");
        expect(result.plan.source).toMatchObject({ productAnchorId: "product", currentSceneBaselineId: null, sceneReferenceIds: ["scene"] });
        expect(result.plan.baseline.sceneFacts).toEqual({
            space: "living room",
            composition: "eye-level wide view",
            lighting: "soft daylight",
        });
        expect(result.plan.delta.requestedChanges).toEqual(expect.arrayContaining(["bright modern minimalist home interior", "warm white wall", "soft natural window light"]));
        expect(result.plan.preserve.productCore).toEqual(expect.arrayContaining(["outline", "brand_text", "color", "material", "scale", "view"]));
        expect(result.plan.validation.requiredChecks).toEqual(["product identity: product remains unchanged"]);
    });

    it("does not make strict_product available when a core preservation constraint is missing", async () => {
        mockedRequest.mockResolvedValue(modelCall(validPlan({ preserve: { productCore: ["outline", "brand_text", "color", "material", "scale"], sceneElements: [] } })));

        await expect(planEcommerceEdit(planningRequest(), visualAnalysis(), plannerRole([candidate("planner")]))).rejects.toThrow("商品核心保护项");
    });

    it("anchors accepted plans to visual facts instead of model paraphrases", async () => {
        mockedRequest.mockResolvedValue(
            modelCall(
                validPlan({
                    baseline: {
                        productFacts: { ...productFacts(), identity: "generic table", color: "brown" },
                        sceneFacts: { space: "room", composition: "wide", lighting: "daylight" },
                    },
                }),
            ),
        );

        const result = await planEcommerceEdit(planningRequest(), visualAnalysis(), plannerRole([candidate("planner")]));

        expect(result.plan.baseline.productFacts).toEqual(productFacts());
        expect(result.plan.baseline.sceneFacts).toEqual({ space: "living room", composition: "eye-level wide view", lighting: "soft daylight" });
    });

    it("plans a scene edit from one complete scene without inventing a product anchor", async () => {
        const planned = {
            ...validPlan(),
            operation: "scene_edit",
            source: { productAnchorId: null, currentSceneBaselineId: "scene", sceneReferenceIds: [] },
            baseline: {
                productFacts: null,
                sceneFacts: { space: "model paraphrase", composition: "model paraphrase", lighting: "model paraphrase" },
            },
            delta: {
                requestedChanges: ["change to winter sunlight"],
                targetObjects: ["lighting-main"],
                targetRegions: ["whole-scene"],
            },
            preserve: { productCore: [], sceneElements: ["layout", "furniture", "camera"] },
            strategy: "integrated_scene",
            validation: { requiredChecks: ["requested_edit", "scene_preservation", "composition_lighting"] },
        };
        mockedRequest.mockResolvedValue(modelCall(planned));

        const result = await planEcommerceEdit(scenePlanningRequest(), sceneVisualAnalysis(), plannerRole([candidate("planner")]));

        expect(result.plan.operation).toBe("scene_edit");
        expect(result.plan.source).toEqual({ productAnchorId: null, currentSceneBaselineId: "scene", sceneReferenceIds: [] });
        expect(result.plan.baseline.productFacts).toBeNull();
        expect(result.plan.baseline.sceneFacts).toEqual({ space: "living room", composition: "eye-level wide view", lighting: "soft daylight" });
    });

    it("instructs the planner to use the scene-only contract", async () => {
        mockedRequest.mockRejectedValue(new Error("stop after capturing the planner request"));

        await expect(planEcommerceEdit(scenePlanningRequest(), sceneVisualAnalysis(), plannerRole([candidate("planner")]))).rejects.toThrow("stop after capturing the planner request");
        const systemPrompt = mockedRequest.mock.calls[0]?.[0].messages[0]?.content;
        expect(systemPrompt).toContain("productAnchorId 为空");
        expect(systemPrompt).toContain("scene_edit");
        expect(systemPrompt).toContain("integrated_scene");
    });

    it("normalizes a versioned local edit from a scene-only input into scene_edit", () => {
        const planned = validPlan({
            operation: "local_edit",
            source: { productAnchorId: null, currentSceneBaselineId: "scene", sceneReferenceIds: [] },
            baseline: {
                productFacts: null,
                sceneFacts: { space: "model paraphrase", composition: "model paraphrase", lighting: "model paraphrase" },
            },
            delta: {
                requestedChanges: ["change the wall to warm white"],
                targetObjects: ["wall-main"],
                targetRegions: ["wall"],
            },
            preserve: {
                productCore: ["outline", "brand_text", "color", "material", "scale", "view"],
                sceneElements: ["layout", "furniture", "camera"],
            },
            strategy: "strict_product",
        });

        const plan = normalizePlannedEdit(planned, scenePlanningRequest(), sceneVisualAnalysis(), "planner-model");

        expect(plan).toMatchObject({
            operation: "scene_edit",
            source: { productAnchorId: null, currentSceneBaselineId: "scene", sceneReferenceIds: [] },
            baseline: { productFacts: null },
            preserve: { productCore: [], sceneElements: ["layout", "furniture", "camera"] },
            strategy: "integrated_scene",
        });
    });

    it("does not reclassify a product edit whose planner omitted the product anchor", () => {
        const planned = validPlan({
            operation: "local_edit",
            source: { productAnchorId: null, currentSceneBaselineId: null, sceneReferenceIds: ["scene"] },
        });

        expect(() => normalizePlannedEdit(planned, planningRequest(), visualAnalysis(), "planner-model")).toThrow("商品主参考图无效");
    });

    it("uses a same-role logical-model fallback and attributes billing to the actual planner", async () => {
        const incorrect = validPlan({
            operation: "local_edit",
            delta: { requestedChanges: ["add a coffee cup next to the product"], targetObjects: ["product body"], targetRegions: ["product_core"] },
            modelRoles: { visionAnalysis: "vision-model", editPlanning: "planner-primary", generation: "image-generation", qualityCheck: "quality-check" },
        });
        const corrected = validPlan({
            operation: "local_edit",
            delta: { requestedChanges: ["add a coffee cup next to the product"], targetObjects: ["coffee cup"], targetRegions: ["scene beside product"] },
            modelRoles: { visionAnalysis: "vision-model", editPlanning: "planner-backup", generation: "image-generation", qualityCheck: "quality-check" },
        });
        mockedRequest.mockResolvedValueOnce(modelCall(incorrect, new Headers({ "x-vozeb-pro-points-cost": "4", "x-vozeb-pro-points-record-id": "planner-primary-charge" }))).mockResolvedValueOnce(modelCall(corrected));

        const result = await planEcommerceEdit({ ...planningRequest(), planningInput: { ...planningInput(), userRequest: "Add a coffee cup next to the product" } }, visualAnalysis(), [
            roleCandidate("edit_planning", "planner-primary", "primary"),
            roleCandidate("edit_planning", "planner-backup", "secondary"),
        ]);

        expect(mockedRequest).toHaveBeenCalledTimes(2);
        expect(result.plan.delta).toMatchObject({ targetObjects: ["coffee cup"], targetRegions: ["scene beside product"] });
        expect(result.modelRole).toMatchObject({ logicalModelId: "planner-backup", channelId: "secondary", upstreamModel: "vendor/secondary" });
        expect(mockedRequest.mock.calls[0]?.[0].headers).toMatchObject({ "x-vozeb-pro-logical-model": "planner-primary", "x-vozeb-pro-upstream-model": "vendor/primary" });
        expect(mockedRequest.mock.calls[1]?.[0].headers).toMatchObject({ "x-vozeb-pro-logical-model": "planner-backup", "x-vozeb-pro-upstream-model": "vendor/secondary" });
        expect(new Headers(mockedRequest.mock.calls[0]?.[0].headers).get("x-vozeb-pro-points-idempotency-key")).not.toBe(new Headers(mockedRequest.mock.calls[1]?.[0].headers).get("x-vozeb-pro-points-idempotency-key"));
        expect(mocks.refundUserPoints).toHaveBeenCalledWith("user-one", "planner-primary", 4, "text", 1, undefined, "planner-primary-charge");
    });

    it("rejects a cross-role candidate group", async () => {
        await expect(planEcommerceEdit(planningRequest(), visualAnalysis(), [roleCandidate("vision_analysis", "vision-model", "vision")])).rejects.toThrow("edit_planning");
        expect(mockedRequest).not.toHaveBeenCalled();
    });
});

function purposeFixture() {
    const base = scenePlanningRequest();
    const decision: EcommerceReferenceDecision = {
        version: "ecommerce-reference-decision.v1",
        state: "resolved",
        editTargetId: "scene",
        productAnchorId: null,
        currentSceneBaselineId: "scene",
        bindings: [{ assetId: "aux", alias: "图片1", purposes: ["lighting"], source: "explicit" }],
        appliedCues: [{ assetId: "aux", purpose: "lighting", cueIds: ["light"] }],
        issues: [],
    };
    const input = { ...base, sources: { ...base.sources, sceneReferenceIds: ["aux"] }, referenceDecision: decision };
    const reference = sceneVisualAnalysis().references[0];
    const structure = { objectId: "cabinet", feature: "drawers" as const, count: 3, certainty: "confirmed" as const, evidenceRegion: { x: 1, y: 1, width: 4, height: 4 } };
    const analysis: EcommerceVisualAnalysisV4 = {
        analysisVersion: "ecommerce-visual-analysis.v4",
        modelRole: sceneVisualAnalysis().modelRole,
        purposeSuggestions: [],
        rawAnalysis: {},
        normalizationAudit: [],
        references: [
            {
                ...reference,
                assetId: "aux",
                contentType: "interior_scene",
                sceneFacts: { space: "aux bedroom", composition: "aux view", lighting: "aux light" },
                visibleStructure: [{ ...structure, objectId: "aux-cabinet" }],
                cues: [{ id: "light", facet: "lighting", description: "左侧柔光", confidence: "high" }],
            },
            { ...reference, contentType: "interior_scene", visibleStructure: [structure], cues: [] },
        ],
    };
    const plan = validPlan({
        planVersion: "ecommerce-edit.v6",
        operation: "scene_edit",
        source: { ...base.sources, sceneReferenceIds: ["aux"] },
        baseline: { productFacts: null, sceneFacts: reference.sceneFacts },
        referenceUses: [
            { assetId: "scene", alias: null, purposes: ["edit_target"], usedCueIds: [] },
            { assetId: "aux", alias: "图片1", purposes: ["lighting"], usedCueIds: ["light"] },
        ],
        strategy: "integrated_scene",
        preserve: { productCore: [], sceneElements: ["cabinet"] },
    });
    return { input, analysis, plan };
}

function productPurposeFixture(userRequest: string) {
    const base = planningRequest();
    const legacy = visualAnalysis();
    const analysis: EcommerceVisualAnalysisV4 = {
        ...legacy,
        analysisVersion: "ecommerce-visual-analysis.v4",
        purposeSuggestions: [{ assetId: "scene", purposes: ["style"], confidence: "high" }],
        rawAnalysis: {},
        normalizationAudit: [],
        references: legacy.references.map(({ role, ...reference }) => ({
            ...reference,
            contentType: role === "product" ? "isolated_product" : "interior_scene",
            visibleStructure: [],
            cues:
                role === "product"
                    ? []
                    : [
                          { id: "light", facet: "lighting", confidence: "high", description: "左侧柔光" },
                          { id: "style", facet: "style", confidence: "high", description: "简约风格" },
                      ],
        })),
    };
    const planningInput = {
        ...base.planningInput,
        userRequest,
        referenceAliases: [
            { assetId: "scene", alias: "图片1" },
            { assetId: "product", alias: "图片2" },
        ],
    };
    const decision = resolveEcommerceReferenceDecision({ planningInput, analysis });
    const input = { ...base, planningInput, referenceDecision: decision };
    const plan = validPlan({
        planVersion: "ecommerce-edit.v6",
        baseline: { productFacts: productFacts(), sceneFacts: null },
        referenceUses: referenceUsesFromEcommerceDecision({ decision, sourceOrder: ["product", "scene"] }),
    });
    return { input, analysis, plan };
}

function planningRequest() {
    return {
        origin: "http://127.0.0.1:3000",
        cookie: "session=test",
        userId: "user-one",
        requestId: "run-one",
        planningInput: planningInput(),
        sources: {
            status: "resolved" as const,
            productAnchorId: "product",
            currentSceneBaselineId: null,
            sceneReferenceIds: ["scene"],
            parentResultId: null,
            startsNewProductAnchor: true,
            createsBranch: false,
            ambiguityReason: null,
            clarificationQuestion: null,
        },
        branchId: "branch-one",
        generationModelRole: "image-generation",
        qualityCheckModelRole: "quality-check",
    };
}

function planningInput(): EcommercePlanningInput {
    return {
        userRequest: "把商品放进简约客厅",
        conversationId: "conversation-one",
        surface: "chat",
        assetCandidates: [
            { id: "product", type: "image", title: "product.png", url: "/api/reference-assets/product.png" },
            { id: "scene", type: "image", title: "scene.png", url: "/api/reference-assets/scene.png" },
        ],
        conversationContext: { summary: "", recentMessages: [] },
    };
}

function visualAnalysis(): EcommerceVisualAnalysis {
    return {
        analysisVersion: "ecommerce-visual-analysis.v1",
        references: [
            {
                assetId: "product",
                role: "product",
                confidence: "high",
                visualEvidence: { whiteBackground: true, transparentBackground: false, isolatedSubject: true, completeScene: false },
                productFacts: productFacts(),
                sceneFacts: null,
                productCore: { x: 0.2, y: 0.15, width: 0.6, height: 0.7 },
                fusionHalo: { x: 0.16, y: 0.11, width: 0.68, height: 0.78 },
                editableTargets: [],
            },
            {
                assetId: "scene",
                role: "scene",
                confidence: "high",
                visualEvidence: { whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: true },
                productFacts: null,
                sceneFacts: { space: "living room", composition: "eye-level wide view", lighting: "soft daylight" },
                productCore: null,
                fusionHalo: null,
                editableTargets: [],
            },
        ],
        modelRole: { logicalRole: "vision_analysis", logicalModelId: "vision-model", channelId: "vision", upstreamModel: "vendor/vision" },
    };
}

function scenePlanningRequest() {
    return {
        ...planningRequest(),
        planningInput: {
            ...planningInput(),
            userRequest: "改成冬日阳光，其他内容保持不变",
            assetCandidates: [{ id: "scene", type: "image" as const, title: "scene.png", url: "/api/reference-assets/scene.png" }],
        },
        sources: {
            status: "resolved" as const,
            productAnchorId: null,
            currentSceneBaselineId: "scene",
            sceneReferenceIds: [],
            parentResultId: null,
            startsNewProductAnchor: false,
            createsBranch: false,
            ambiguityReason: null,
            clarificationQuestion: null,
        },
    };
}

function sceneVisualAnalysis(): EcommerceVisualAnalysis {
    return {
        analysisVersion: "ecommerce-visual-analysis.v1",
        references: [
            {
                assetId: "scene",
                role: "scene",
                confidence: "high",
                visualEvidence: { whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: true },
                productFacts: null,
                sceneFacts: { space: "living room", composition: "eye-level wide view", lighting: "soft daylight" },
                productCore: null,
                fusionHalo: null,
                editableTargets: [
                    {
                        id: "lighting-main",
                        kind: "lighting",
                        label: "main scene lighting",
                        region: { x: 0, y: 0, width: 1, height: 1 },
                    },
                ],
            },
        ],
        modelRole: {
            logicalRole: "vision_analysis",
            logicalModelId: "vision-model",
            channelId: "vision",
            upstreamModel: "vendor/vision",
        },
    };
}

function validPlan(overrides: Partial<EcommerceEditPlan> = {}): EcommerceEditPlan {
    return {
        planVersion: "ecommerce-edit.v1",
        operation: "product_to_scene",
        source: { productAnchorId: "product", currentSceneBaselineId: null, sceneReferenceIds: ["scene"] },
        baseline: { productFacts: productFacts(), sceneFacts: { space: "living room", composition: "eye-level wide view", lighting: "soft daylight" } },
        delta: { requestedChanges: ["place product in a minimal living room"], targetObjects: ["scene"], targetRegions: ["background"] },
        preserve: { productCore: ["outline", "brand_text", "color", "material", "scale", "view"], sceneElements: [] },
        strategy: "strict_product",
        modelRoles: { visionAnalysis: "vision-model", editPlanning: "planner-model", generation: "image-generation", qualityCheck: "quality-check" },
        continuity: { parentResultId: null, branchId: "branch-one" },
        validation: { requiredChecks: ["product_identity", "product_outline"] },
        ...overrides,
    };
}

function productFacts() {
    return { identity: "oak side table", outline: "round top and three legs", color: "natural oak", material: "wood", brandText: [], view: "front three-quarter" };
}

function photographyFacts() {
    return {
        materials: [{ objectId: "cabinet", textureDirection: "纵向木纹", textureScale: "细木纹", roughness: "细哑光", gloss: "低光泽" }],
        lighting: { keyLight: "左侧大面积柔光", fillLight: "右侧弱补光", whiteBalance: "中性白平衡", contactShadow: "柜脚柔和接触阴影" },
        composition: { focalSubject: "边柜明暗层次清楚", depth: "原有前后空间层次", negativeSpace: "柜旁留白" },
    };
}

function photographyScenePlan(photography: NonNullable<EcommerceEditPlan["photography"]>): EcommerceEditPlan {
    return validPlan({
        planVersion: "ecommerce-edit.v5",
        operation: "scene_edit",
        source: { productAnchorId: null, currentSceneBaselineId: "scene", sceneReferenceIds: [] },
        baseline: { productFacts: null, sceneFacts: { space: "living room", composition: "eye-level wide view", lighting: "soft daylight" } },
        preserve: { productCore: [], sceneElements: ["cabinet"] },
        strategy: "integrated_scene",
        photography,
    });
}

function plannerRole(candidates: TextPlanningCandidate[]) {
    return candidates.map((value) => roleCandidate("edit_planning", "planner-model", value.channelId));
}

function roleCandidate(logicalRole: "vision_analysis" | "edit_planning", logicalModelId: string, channelId: string): EcommerceRoleCandidate {
    const value = candidate(channelId);
    return {
        channelId: value.channelId,
        upstreamModel: value.upstreamModel,
        channel: value.channel,
        logicalRole,
        capability: "text",
        logicalModelId,
        snapshot: { logicalRole, capability: "text", logicalModelId, channelId, upstreamModel: value.upstreamModel, apiFormat: "openai" },
    };
}

function candidate(id: string): TextPlanningCandidate {
    return {
        channelId: id,
        upstreamModel: "vendor/" + id,
        channel: { id, name: id, baseUrl: "https://example.com/v1", apiKey: "secret", apiFormat: "openai", models: ["vendor/" + id], enabled: true },
    };
}

function modelCall(value: unknown, headers = new Headers()) {
    return { arguments: JSON.stringify(value), headers, protocol: "chat" as const, elapsedMs: 10 };
}
