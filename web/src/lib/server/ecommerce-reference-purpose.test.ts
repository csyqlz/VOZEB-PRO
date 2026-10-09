import { describe, expect, it } from "vitest";
import type { CreativeAsset } from "@/lib/creative-runtime-contract";
import { buildEcommercePlanningInput } from "./ecommerce-generation-snapshot";
import { ecommerceReferenceReviewMessage, resolveEcommerceReferenceDecision } from "./ecommerce-reference-purpose";
import { normalizeEcommerceVisualAnalysis, type EcommerceVisualReferenceV4 } from "./ecommerce-visual-analysis";

describe("ecommerce reference purpose preparation", () => {
    it("freezes mixed-type aliases by deduplicated current-run IDs despite same titles and fallback assets", () => {
        const input = buildEcommercePlanningInput(
            { userId: "user", conversationId: "conversation", surface: "chat", prompt: "参考图片1的光线和风格，修改图片2", referencedAssetIds: ["audio", "b", "b", "a"] },
            [asset("a"), asset("fallback"), asset("b"), asset("audio", "audio")],
            { summary: "", recentMessages: [] },
        );
        expect(input.assetCandidates.map(({ id }) => id)).toEqual(["audio", "b", "a", "fallback"]);
        expect(input.referenceAliases).toEqual([
            { assetId: "audio", alias: "音频1" },
            { assetId: "b", alias: "图片1" },
            { assetId: "a", alias: "图片2" },
        ]);
        expect(input.explicitReferenceBindings).toEqual([
            { assetId: "b", alias: "图片1", purposes: ["style", "lighting"], source: "explicit" },
            { assetId: "a", alias: "图片2", purposes: ["edit_target"], source: "explicit" },
        ]);
        expect(input.userRequest).toBe("参考图片1的光线和风格，修改图片2");
    });

    it("binds clone identity by selected asset ID and never by an identical title", () => {
        const input = buildEcommercePlanningInput({ userId: "user", conversationId: "conversation", surface: "chat", prompt: "参考图片1，修改图片2", referencedAssetIds: ["clone", "original"] }, [asset("original"), asset("clone")], {
            summary: "",
            recentMessages: [],
        });
        expect(input.explicitReferenceBindings).toEqual([
            { assetId: "clone", alias: "图片1", purposes: ["style"], source: "explicit" },
            { assetId: "original", alias: "图片2", purposes: ["edit_target"], source: "explicit" },
        ]);
    });

    it("does not assign aliases to foreign, wrong-conversation, failed or unselected historical assets", () => {
        const input = buildEcommercePlanningInput(
            { userId: "user", conversationId: "conversation", surface: "chat", prompt: "修改图片1", referencedAssetIds: ["foreign", "other", "failed", "selected"] },
            [{ ...asset("foreign"), userId: "other-user" }, { ...asset("other"), conversationId: "other-conversation" }, { ...asset("failed"), status: "failed" }, asset("history"), asset("selected")],
            { summary: "", recentMessages: [] },
        );
        expect(input.referenceAliases).toEqual([{ assetId: "selected", alias: "图片1" }]);
        expect(input.assetCandidates.map(({ id }) => id)).toEqual(["selected", "history"]);
    });

    it("does not make fallback-only images into user aliases", () => {
        const input = buildEcommercePlanningInput({ userId: "user", conversationId: "conversation", surface: "chat", prompt: "调整灯光", referencedAssetIds: [] }, [asset("history")], { summary: "", recentMessages: [] });
        expect(input.referenceAliases).toEqual([]);
        expect(input.explicitReferenceBindings).toEqual([]);
    });

    it("keeps two white-background images in the explicit style and target uses despite model swaps", () => {
        const input = planning("参考图片1，修改图片2");
        const analysis = vision(
            input,
            [reference("a"), reference("b")],
            [
                { assetId: "a", purposes: ["edit_target", "product_identity"] as const, confidence: "high" as const },
                { assetId: "b", purposes: ["style"] as const, confidence: "high" as const },
            ],
        );
        const decision = resolveEcommerceReferenceDecision({ planningInput: input, analysis });
        expect(decision).toMatchObject({ state: "resolved", editTargetId: "b", productAnchorId: "b", currentSceneBaselineId: null, issues: [] });
        expect(decision.bindings).toEqual([
            { assetId: "a", alias: "图片1", purposes: ["style"], source: "explicit" },
            { assetId: "b", alias: "图片2", purposes: ["edit_target", "product_identity"], source: "explicit" },
        ]);
    });

    it("binds the user-facing reference wording to the explicit aliases without a model call", () => {
        const input = planning("@图片1 参考这张图的光纤等风格，把@图片2 这张图修改成风格一样");
        const decision = resolveEcommerceReferenceDecision({ planningInput: input, analysis: vision(input, [reference("a"), reference("b")]) });
        expect(decision).toMatchObject({ state: "resolved", editTargetId: "b", productAnchorId: "b", issues: [] });
        expect(decision.bindings).toEqual([
            { assetId: "a", alias: "图片1", purposes: ["style"], source: "explicit" },
            { assetId: "b", alias: "图片2", purposes: ["edit_target", "product_identity"], source: "explicit" },
        ]);
    });

    it("uses reliable lighting and style from a medium detail while keeping its counts away from identity", () => {
        const input = planning("参考图片1的光线和风格，修改图片2");
        const detail = reference("a");
        detail.contentType = "product_detail";
        detail.confidence = "medium";
        detail.cues.push({ id: "light", facet: "lighting", description: "左侧大面积柔光", confidence: "high" });
        detail.visibleStructure = [{ objectId: "reference-cabinet", feature: "drawers", count: null, certainty: "uncertain", evidenceRegion: { x: 0, y: 0, width: 50, height: 50 } }];
        const analysis = vision(input, [detail, reference("b")]);
        const decision = resolveEcommerceReferenceDecision({ planningInput: input, analysis });
        expect(decision).toMatchObject({
            state: "resolved",
            productAnchorId: "b",
            currentSceneBaselineId: null,
            appliedCues: [
                { assetId: "a", purpose: "style", cueIds: ["style"] },
                { assetId: "a", purpose: "lighting", cueIds: ["light"] },
            ],
        });
        expect(analysis.references[0]).toMatchObject({ confidence: "medium", sceneFacts: null, visualEvidence: { completeScene: false } });
        expect(analysis.references[0]).not.toHaveProperty("photographyFacts");
    });

    it("lets a single image provide edit target and product identity without collapsing its purposes", () => {
        const input = planning("修改图片1", ["a"]);
        const decision = resolveEcommerceReferenceDecision({ planningInput: input, analysis: vision(input, [reference("a")]) });
        expect(decision).toMatchObject({ state: "resolved", editTargetId: "a", productAnchorId: "a", bindings: [{ assetId: "a", alias: "图片1", purposes: ["edit_target", "product_identity"], source: "explicit" }] });
    });

    it("requires confirmation for ambiguous product targets despite a high model purpose suggestion", () => {
        const input = planning("参考这两张图片调整效果");
        const decision = resolveEcommerceReferenceDecision({ planningInput: input, analysis: vision(input, [reference("a"), reference("b")], [{ assetId: "b", purposes: ["edit_target"], confidence: "high" }]) });
        expect(decision.state).toBe("needs_confirmation");
        expect(decision.editTargetId).toBeNull();
        expect(decision.issues).toContainEqual(expect.objectContaining({ code: "edit_target_required" }));
    });

    it.each([
        { prompt: "修改图片9", code: "reference_expression_unresolved" },
        { prompt: "参考图片1风格，修改图片9", code: "reference_expression_unresolved" },
        { prompt: "不要修改图片1", code: "edit_target_required" },
    ])("does not infer a target across an unresolved explicit alias expression: %s", ({ prompt, code }) => {
        const input = planning(prompt, ["a"]);
        const decision = resolveEcommerceReferenceDecision({ planningInput: input, analysis: vision(input, [reference("a")], [{ assetId: "a", purposes: ["edit_target"], confidence: "high" }]) });
        expect(decision.state).toBe("needs_confirmation");
        expect(decision.editTargetId).toBeNull();
        expect(decision.issues).toContainEqual(expect.objectContaining({ code }));
    });

    it("keeps the positive target when a different reference is explicitly excluded from editing", () => {
        const input = planning("不要修改@图片1，修改@图片2");
        const decision = resolveEcommerceReferenceDecision({ planningInput: input, analysis: vision(input, [reference("a"), reference("b")], [{ assetId: "a", purposes: ["style"], confidence: "high" }]) });
        expect(decision).toMatchObject({ state: "resolved", editTargetId: "b", productAnchorId: "b" });
        expect(decision.bindings[1]).toMatchObject({ assetId: "b", source: "explicit", purposes: ["edit_target", "product_identity"] });
    });

    it("retains product protection while another explicit reference supplies lighting", () => {
        const input = planning("不要改变@图片2商品，参考@图片1光线");
        const detail = reference("a");
        detail.contentType = "product_detail";
        detail.cues = [{ id: "light", facet: "lighting", description: "左侧大面积柔光", confidence: "high" }];
        const decision = resolveEcommerceReferenceDecision({ planningInput: input, analysis: vision(input, [detail, reference("b")]) });
        expect(decision).toMatchObject({ state: "resolved", editTargetId: "b", productAnchorId: "b", appliedCues: [{ assetId: "a", purpose: "lighting", cueIds: ["light"] }] });
    });

    it.each([
        ["参考图片1风格，修改图片2，不要改变商品结构", "style"],
        ["参考图片1的风格，将图片2生成明亮的家居场景，不要改变其颜色和材质", "style"],
        ["不要修改图片1，只参考它的光线，修改图片2", "lighting"],
    ] as const)("keeps target exclusions within the named image clause: %s", (prompt, purpose) => {
        const input = planning(prompt);
        const style = reference("a");
        style.cues.push({ id: "light", facet: "lighting", description: "左侧柔和日光", confidence: "high" });
        const decision = resolveEcommerceReferenceDecision({ planningInput: input, analysis: vision(input, [style, reference("b")]) });
        expect(decision).toMatchObject({ state: "resolved", editTargetId: "b", productAnchorId: "b" });
        expect(decision.bindings[0]).toMatchObject({ assetId: "a", purposes: [purpose] });
        expect(decision.bindings[1]).toMatchObject({ assetId: "b", purposes: ["edit_target", "product_identity"] });
    });

    it("does not resolve an unbound pronoun to one of several mentioned images", () => {
        const input = planning("图片1和图片2，不要修改它，只参考它的光线");
        const decision = resolveEcommerceReferenceDecision({ planningInput: input, analysis: vision(input, [reference("a"), reference("b")]) });
        expect(decision).toMatchObject({ state: "needs_confirmation", editTargetId: null });
    });

    it("does not promise that purpose confirmation can restore missing product facts", () => {
        const input = planning("修改图片1", ["a"]);
        const target = reference("a");
        target.productFacts = null;
        const decision = resolveEcommerceReferenceDecision({ planningInput: input, analysis: vision(input, [target]) });
        expect(ecommerceReferenceReviewMessage(decision)).toContain("完整、清晰的白底商品图");
        expect(ecommerceReferenceReviewMessage(decision)).not.toContain("确认商品主体后继续");
    });

    it("requests a clear scene when scene target facts are insufficient", () => {
        const input = planning("修改图片1", ["a"]);
        const decision = resolveEcommerceReferenceDecision({ planningInput: input, analysis: vision(input, [reference("a", "interior_scene")]) });
        expect(decision.issues).toContainEqual(expect.objectContaining({ code: "edit_target_facts_unreliable" }));
        expect(ecommerceReferenceReviewMessage(decision)).toContain("场景");
        expect(ecommerceReferenceReviewMessage(decision)).not.toContain("白底商品图");
    });

    it("lets validated confirmation resolve the original missing alias expression", () => {
        const input = planning("修改图片9", ["a"]);
        const decision = resolveEcommerceReferenceDecision({ planningInput: input, analysis: vision(input, [reference("a")]), confirmedBindings: [{ assetId: "a", alias: "图片1", purposes: ["edit_target", "product_identity"] }] });
        expect(decision).toMatchObject({ state: "resolved", editTargetId: "a", issues: [] });
    });

    it("preserves confirmed purposes against conflicting model suggestions", () => {
        const input = planning("参考这两张图片调整效果");
        const decision = resolveEcommerceReferenceDecision({
            planningInput: input,
            analysis: vision(input, [reference("a"), reference("b")], [{ assetId: "a", purposes: ["edit_target"], confidence: "high" }]),
            confirmedBindings: [
                { assetId: "a", alias: "图片1", purposes: ["style"] },
                { assetId: "b", alias: "图片2", purposes: ["edit_target", "product_identity"] },
            ],
        });
        expect(decision).toMatchObject({
            state: "resolved",
            editTargetId: "b",
            bindings: [
                { assetId: "a", source: "confirmed", purposes: ["style"] },
                { assetId: "b", source: "confirmed", purposes: ["edit_target", "product_identity"] },
            ],
        });
    });

    it.each(["以@图片1为唯一视觉参考，对@图片2进行生成", "参考图片1的风格，把图片2放到明亮客厅中生成", "使用图片1作为场景参考，将图片2合成到该空间"])("accepts common long-form reference wording: %s", (prompt) => {
        const input = planning(prompt);
        const decision = resolveEcommerceReferenceDecision({ planningInput: input, analysis: vision(input, [reference("a"), reference("b")]) });
        expect(decision).toMatchObject({ state: "resolved", editTargetId: "b", productAnchorId: "b" });
        expect(decision.bindings[0]).toMatchObject({ assetId: "a", purposes: ["style"] });
        expect(decision.bindings[1]).toMatchObject({ assetId: "b", purposes: expect.arrayContaining(["edit_target", "product_identity"]) });
    });

    it("uses a medium-confidence white-background detail as a product anchor after pixel segmentation", () => {
        const input = planning("生成简约家具场景", ["a"]);
        const detail = reference("a");
        detail.contentType = "product_detail";
        detail.confidence = "medium";
        detail.visualEvidence = { whiteBackground: true, transparentBackground: false, isolatedSubject: true, completeScene: false };
        const decision = resolveEcommerceReferenceDecision({ planningInput: input, analysis: vision(input, [detail]) });
        expect(decision).toMatchObject({ state: "resolved", editTargetId: "a", productAnchorId: "a" });
    });

    it("separates a clear cropped product target from an unreliable product identity", () => {
        const input = planning("生成简约家具场景", ["a"]);
        const detail = reference("a");
        detail.contentType = "product_detail";
        detail.productFacts = null;
        detail.visualEvidence = { whiteBackground: true, transparentBackground: false, isolatedSubject: true, completeScene: false };
        const decision = resolveEcommerceReferenceDecision({ planningInput: input, analysis: vision(input, [detail]) });

        expect(decision).toMatchObject({
            state: "needs_confirmation",
            editTargetId: "a",
            productAnchorId: null,
            bindings: [{ assetId: "a", purposes: ["edit_target", "product_identity"] }],
        });
        expect(decision.issues).not.toContainEqual(expect.objectContaining({ code: "edit_target_required" }));
        expect(decision.issues).not.toContainEqual(expect.objectContaining({ code: "reference_purpose_required" }));
        expect(decision.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "product_identity_unreliable" }), expect.objectContaining({ code: "edit_target_facts_unreliable" })]));
        expect(ecommerceReferenceReviewMessage(decision)).toContain("上传完整、清晰的白底商品图");
        expect(ecommerceReferenceReviewMessage(decision)).not.toContain("重新指定参考图用途");
    });

    it.each([
        { assetId: "outside", alias: "图片1" },
        { assetId: "a", alias: "图片2" },
    ])("rejects foreign or exchanged confirmed aliases: %s", (binding) => {
        const input = planning("修改图片1", ["a"]);
        const decision = resolveEcommerceReferenceDecision({ planningInput: input, analysis: vision(input, [reference("a")]), confirmedBindings: [{ ...binding, purposes: ["edit_target"] }] });
        expect(decision.state).toBe("needs_confirmation");
        expect(decision.issues).toContainEqual(expect.objectContaining({ code: "binding_invalid", assetId: binding.assetId }));
        expect(decision.editTargetId).toBeNull();
    });

    it.each(["lighting", "style-and-lighting", "missing-lighting"])("pauses the selected purpose when its corresponding cue is unreliable (%s)", (condition) => {
        const input = planning(`参考图片1的${condition === "style-and-lighting" ? "风格和光线" : "光线"}，修改图片2灯光`);
        const detail = reference("a", "product_detail");
        detail.cues = [...(condition === "style-and-lighting" ? detail.cues : []), ...(condition === "missing-lighting" ? [] : [{ id: "light", facet: "lighting" as const, description: "模糊光线", confidence: "low" as const }])];
        const analysis = vision(input, [detail, reference("b")]);
        const original = structuredClone(analysis);
        for (const confirmed of [false, true]) {
            const decision = resolveEcommerceReferenceDecision({
                planningInput: input,
                analysis,
                ...(confirmed
                    ? {
                          confirmedBindings: [
                              { assetId: "a", alias: "图片1", purposes: condition === "style-and-lighting" ? (["style", "lighting"] as const).map((purpose) => purpose) : (["lighting"] as const).map((purpose) => purpose) },
                              { assetId: "b", alias: "图片2", purposes: (["edit_target", "product_identity"] as const).map((purpose) => purpose) },
                          ],
                      }
                    : {}),
            });
            expect(decision.state).toBe("needs_confirmation");
            expect(decision.bindings[0]).toMatchObject({ assetId: "a", purposes: condition === "style-and-lighting" ? ["style", "lighting"] : ["lighting"] });
            expect(decision.appliedCues).toEqual(condition === "style-and-lighting" ? [{ assetId: "a", purpose: "style", cueIds: ["style"] }] : []);
            expect(decision.issues).toContainEqual(expect.objectContaining({ code: "reference_cue_unreliable", assetId: "a", path: "cues.lighting" }));
            expect(ecommerceReferenceReviewMessage(decision)).toContain("光线");
            expect(ecommerceReferenceReviewMessage(decision)).toMatch(/重新分析|重试分析/);
            expect(ecommerceReferenceReviewMessage(decision)).not.toContain("确认参考图用途");
        }
        expect(analysis).toEqual(original);
        expect(input.userRequest).toContain("光线");
    });

    it.each(["参考图片1光线", "参考图片1的光线", "参考@图片1的光线"])("keeps alias wording separate from lighting-only authorization: %s", (referenceRequest) => {
        const input = planning(`${referenceRequest}，修改图片2灯光`);
        const detail = reference("a", "product_detail");
        detail.cues.push({ id: "light", facet: "lighting", description: "左侧柔光", confidence: "high" });
        const decision = resolveEcommerceReferenceDecision({ planningInput: input, analysis: vision(input, [detail, reference("b")]) });
        expect(decision).toMatchObject({ state: "resolved", editTargetId: "b", productAnchorId: "b", issues: [] });
        expect(input.explicitReferenceBindings).toEqual([
            { assetId: "a", alias: "图片1", purposes: ["lighting"], source: "explicit" },
            { assetId: "b", alias: "图片2", purposes: ["edit_target"], source: "explicit" },
        ]);
        expect(decision.bindings[0].purposes).toEqual(["lighting"]);
        expect(decision.bindings[1].purposes).toEqual(["edit_target", "product_identity"]);
        expect(decision.appliedCues).toEqual([{ assetId: "a", purpose: "lighting", cueIds: ["light"] }]);
    });

    it("uses a cropped image's reliable requested light without requiring its unreliable style or full room", () => {
        const input = planning("参考图片1光线，修改图片2灯光");
        const detail = reference("a", "product_detail");
        detail.confidence = "medium";
        detail.cues = [
            { id: "style", facet: "style", description: "模糊风格", confidence: "low" },
            { id: "light", facet: "lighting", description: "左侧柔光", confidence: "high" },
        ];
        const decision = resolveEcommerceReferenceDecision({ planningInput: input, analysis: vision(input, [detail, reference("b")]) });
        expect(decision).toMatchObject({ state: "resolved", issues: [], appliedCues: [{ assetId: "a", purpose: "lighting", cueIds: ["light"] }] });
        expect(detail.visualEvidence.completeScene).toBe(false);
        expect(detail.sceneFacts).toBeNull();
    });

    it("does not promote missing target facts through an explicit or confirmed purpose", () => {
        const input = planning("修改图片1", ["a"]);
        const target = reference("a");
        target.productFacts = null;
        const analysis = vision(input, [target]);
        for (const confirmedBindings of [undefined, [{ assetId: "a", alias: "图片1", purposes: ["edit_target", "product_identity"] as const }]]) {
            const decision = resolveEcommerceReferenceDecision({ planningInput: input, analysis, ...(confirmedBindings ? { confirmedBindings: confirmedBindings.map((binding) => ({ ...binding, purposes: [...binding.purposes] })) } : {}) });
            expect(decision.state).toBe("needs_confirmation");
            expect(decision.productAnchorId).toBeNull();
            expect(decision.issues).toContainEqual(expect.objectContaining({ code: "product_identity_unreliable", assetId: "a" }));
        }
    });

    it.each([false, true].flatMap((continuity) => (["low", "high"] as const).map((styleConfidence) => ({ continuity, styleConfidence }))))(
        "uses the same-analysis lighting suggestion before default style (continuity=$continuity, style=$styleConfidence)",
        ({ continuity, styleConfidence }) => {
            const base = planning(continuity ? "参考这张新图的光线，继续编辑最近结果" : "参考这张新图的光线，生成简约家具场景", continuity ? ["a"] : ["a", "b"]);
            const current = reference("current", "interior_scene");
            current.sceneFacts = { space: "original room", composition: "original view", lighting: "original daylight" };
            const input = { ...base, ...(continuity ? { assetCandidates: [asset("current"), asset("a"), asset("b")], inheritedReferences: { editTargetId: "current", productAnchorId: "b" } } : {}) };
            const detail = reference("a", "product_detail");
            detail.cues = [
                { id: "style", facet: "style", description: "reference style", confidence: styleConfidence },
                { id: "light", facet: "lighting", description: "left soft light", confidence: "high" },
            ];
            const analysis = vision(input, [...(continuity ? [current] : []), detail, reference("b")], [{ assetId: "a", purposes: ["lighting"], confidence: "high" }]);
            const original = structuredClone({ input, analysis });
            const decision = resolveEcommerceReferenceDecision({ planningInput: input, analysis });
            expect(decision).toMatchObject({ state: "resolved", editTargetId: continuity ? "current" : "b", productAnchorId: "b", currentSceneBaselineId: continuity ? "current" : null, issues: [] });
            expect(decision.bindings[0]).toEqual({ assetId: "a", alias: "图片1", purposes: ["lighting"], source: "inferred" });
            expect(decision.appliedCues).toEqual([{ assetId: "a", purpose: "lighting", cueIds: ["light"] }]);
            expect({ input, analysis }).toEqual(original);
        },
    );

    it.each([false, true])("inherits the current scene and product anchor without giving implicit references user aliases (%s)", (withStyle) => {
        const current = reference("current", "interior_scene");
        current.sceneFacts = { space: "living room", composition: "front view", lighting: "daylight" };
        const base = planning(withStyle ? "参考图片1的风格，继续调整当前结果" : "再明亮一点", withStyle ? ["style"] : []);
        const input = { ...base, assetCandidates: [asset("current"), ...(withStyle ? [asset("style")] : []), asset("original")], inheritedReferences: { editTargetId: "current", productAnchorId: "original" } };
        const decision = resolveEcommerceReferenceDecision({ planningInput: input, analysis: vision(input, [current, ...(withStyle ? [reference("style")] : []), reference("original")]) });
        expect(decision).toMatchObject({ state: "resolved", editTargetId: "current", productAnchorId: "original", currentSceneBaselineId: "current", issues: [] });
        expect(decision.bindings).toEqual(withStyle ? [{ assetId: "style", alias: "图片1", purposes: ["style"], source: "explicit" }] : []);
    });

    it.each([null, "original"])("binds a selected historical result to its inherited edit target without replacing the product anchor (%s)", (productAnchorId) => {
        const base = planning("从较早结果改成午后阳光", ["current"]);
        const input = { ...base, assetCandidates: [asset("current"), ...(productAnchorId ? [asset(productAnchorId)] : [])], inheritedReferences: { editTargetId: "current", productAnchorId } };
        const current = reference("current", "interior_scene");
        current.sceneFacts = { space: "living room", composition: "front view", lighting: "daylight" };
        const analysis = vision(input, [current, ...(productAnchorId ? [reference(productAnchorId)] : [])], [{ assetId: "current", purposes: ["style"], confidence: "high" }]);
        const original = structuredClone({ input, analysis });

        const decision = resolveEcommerceReferenceDecision({ planningInput: input, analysis });

        expect(decision).toMatchObject({ state: "resolved", editTargetId: "current", productAnchorId, currentSceneBaselineId: "current", issues: [] });
        expect(decision.bindings).toEqual([{ assetId: "current", alias: "图片1", purposes: ["edit_target"], source: "inferred" }]);
        expect(decision.appliedCues).toEqual([]);
        expect({ input, analysis }).toEqual(original);
    });

    it.each([null, "original"].flatMap((productAnchorId) => (["isolated_product", "product_detail"] as const).flatMap((contentType) => [false, true].map((explicitTarget) => ({ productAnchorId, contentType, explicitTarget })))))(
        "does not infer product identity from a historical target ($contentType, anchor=$productAnchorId, explicit=$explicitTarget)",
        ({ productAnchorId, contentType, explicitTarget }) => {
            const base = planning(explicitTarget ? "修改图片1" : "从较早结果改成午后阳光", ["current"]);
            const input = { ...base, assetCandidates: [asset("current"), ...(productAnchorId ? [asset(productAnchorId)] : [])], inheritedReferences: { editTargetId: "current", productAnchorId } };
            const current = reference("current");
            current.contentType = contentType;
            const analysis = vision(input, [current, ...(productAnchorId ? [reference(productAnchorId)] : [])]);
            const original = structuredClone({ input, analysis });

            const decision = resolveEcommerceReferenceDecision({ planningInput: input, analysis });

            expect(decision).toMatchObject({ state: "resolved", editTargetId: "current", productAnchorId, currentSceneBaselineId: null, issues: [] });
            expect(decision.bindings).toEqual([{ assetId: "current", alias: "图片1", purposes: ["edit_target"], source: explicitTarget ? "explicit" : "inferred" }]);
            expect({ input, analysis }).toEqual(original);
        },
    );

    it("keeps a selected historical target separate from a newly authorized style reference", () => {
        const base = planning("参考图片1的风格，继续修改较早结果", ["style", "current"]);
        const input = { ...base, assetCandidates: [asset("style"), asset("current"), asset("original")], inheritedReferences: { editTargetId: "current", productAnchorId: "original" } };
        const current = reference("current", "interior_scene");
        current.sceneFacts = { space: "living room", composition: "front view", lighting: "daylight" };
        const decision = resolveEcommerceReferenceDecision({ planningInput: input, analysis: vision(input, [reference("style"), current, reference("original")]) });

        expect(decision).toMatchObject({ state: "resolved", editTargetId: "current", productAnchorId: "original", currentSceneBaselineId: "current", issues: [] });
        expect(decision.bindings).toEqual([
            { assetId: "style", alias: "图片1", purposes: ["style"], source: "explicit" },
            { assetId: "current", alias: "图片2", purposes: ["edit_target"], source: "inferred" },
        ]);
        expect(decision.appliedCues).toEqual([{ assetId: "style", purpose: "style", cueIds: ["style"] }]);
    });

    it.each(["不要修改图片1", "修改图片9"])("does not assign the inherited alias an edit purpose across an exclusion or unresolved request: %s", (prompt) => {
        const base = planning(prompt, ["current"]);
        const input = { ...base, inheritedReferences: { editTargetId: "current", productAnchorId: null } };
        const current = reference("current", "interior_scene");
        current.sceneFacts = { space: "living room", composition: "front view", lighting: "daylight" };
        const decision = resolveEcommerceReferenceDecision({ planningInput: input, analysis: vision(input, [current]) });

        expect(decision.state).toBe("needs_confirmation");
        expect(decision.bindings[0].purposes).not.toContain("edit_target");
    });

    it.each([false, true])("does not promote an inherited alias with an explicit or confirmed reference-only purpose (%s)", (confirmed) => {
        const base = planning("参考图片1的风格，继续调整当前结果", ["current"]);
        const input = { ...base, inheritedReferences: { editTargetId: "current", productAnchorId: null } };
        const current = reference("current", "interior_scene");
        current.sceneFacts = { space: "living room", composition: "front view", lighting: "daylight" };
        const decision = resolveEcommerceReferenceDecision({
            planningInput: input,
            analysis: vision(input, [current], [{ assetId: "current", purposes: ["edit_target"], confidence: "high" }]),
            ...(confirmed ? { confirmedBindings: [{ assetId: "current", alias: "图片1", purposes: ["style"] as const }].map((binding) => ({ ...binding, purposes: [...binding.purposes] })) } : {}),
        });

        expect(decision.bindings).toEqual([{ assetId: "current", alias: "图片1", purposes: ["style"], source: confirmed ? "confirmed" : "explicit" }]);
    });

    it("still requires reliable scene facts for a selected inherited target", () => {
        const base = planning("从较早结果改成午后阳光", ["current"]);
        const input = { ...base, inheritedReferences: { editTargetId: "current", productAnchorId: null } };
        const decision = resolveEcommerceReferenceDecision({ planningInput: input, analysis: vision(input, [reference("current", "interior_scene")]) });

        expect(decision.state).toBe("needs_confirmation");
        expect(decision.bindings[0].purposes).toEqual(["edit_target"]);
        expect(decision.issues).toContainEqual(expect.objectContaining({ code: "edit_target_facts_unreliable", assetId: "current" }));
        expect(decision.issues).not.toContainEqual(expect.objectContaining({ code: "reference_purpose_required" }));
    });

    it.each(["改成这个房间", "参考这个房间生成新场景"])("keeps the inherited target and identity ahead of a new room's default role: %s", (prompt) => {
        const base = planning(prompt, ["room"]);
        const input = { ...base, assetCandidates: [asset("current"), asset("room"), asset("original")], inheritedReferences: { editTargetId: "current", productAnchorId: "original" } };
        const current = reference("current", "interior_scene");
        current.sceneFacts = { space: "original room", composition: "original camera", lighting: "original daylight" };
        current.visualEvidence.completeScene = true;
        const room = { ...structuredClone(current), assetId: "room", sceneFacts: { space: "new room", composition: "new camera", lighting: "new daylight" } };
        const decision = resolveEcommerceReferenceDecision({ planningInput: input, analysis: vision(input, [room, current, reference("original")]) });
        expect(decision).toMatchObject({ state: "resolved", editTargetId: "current", productAnchorId: "original", currentSceneBaselineId: "current", issues: [] });
        expect(decision.bindings).toEqual([{ assetId: "room", alias: "图片1", purposes: ["style"], source: "inferred" }]);
    });

    it("preserves an explicitly selected replacement instead of inheriting the old product anchor", () => {
        const base = planning("修改图片1", ["replacement"]);
        const input = { ...base, assetCandidates: [asset("current"), asset("replacement"), asset("original")], inheritedReferences: { editTargetId: "current", productAnchorId: "original" } };
        const decision = resolveEcommerceReferenceDecision({ planningInput: input, analysis: vision(input, [reference("current", "interior_scene"), reference("replacement"), reference("original")]) });
        expect(decision).toMatchObject({ state: "resolved", editTargetId: "replacement", productAnchorId: "replacement", currentSceneBaselineId: null });
    });

    it.each(["中的", "里面的", "里的", "的"])("retains an explicit target when a later clause protects a qualified product attribute (%s)", (qualifier) => {
        const input = planning(`修改图片2场景，不要对图片2${qualifier}商品颜色进行修改`);
        const detail = reference("a");
        detail.contentType = "product_detail";
        detail.productFacts = null;
        detail.productCore = null;
        detail.fusionHalo = null;
        const analysis = vision(input, [detail, reference("b")], [{ assetId: "a", purposes: ["style"], confidence: "high" }]);
        const decision = resolveEcommerceReferenceDecision({ planningInput: input, analysis });
        expect(decision).toMatchObject({ state: "resolved", editTargetId: "b", productAnchorId: "b" });
        expect(decision.bindings).toEqual([
            { assetId: "a", alias: "图片1", purposes: ["style"], source: "inferred" },
            { assetId: "b", alias: "图片2", purposes: ["edit_target", "product_identity"], source: "explicit" },
        ]);
    });

    it("does not use a protected attribute clause to silently resolve another image's purpose", () => {
        const input = planning("参考图片1风格，修改图片2场景，不要对图片1中的商品颜色进行修改");
        const decision = resolveEcommerceReferenceDecision({ planningInput: input, analysis: vision(input, [reference("a"), reference("b")]) });
        expect(decision.state).toBe("needs_confirmation");
    });

    it.each(["修改图片2场景，请不要更改图片2中的商品颜色和材质", "修改图片2场景，不要让图片2里面的商品颜色变成白色", "修改图片2场景，请勿将图片2里的商品材质由木质换成金属", "修改图片2场景，图片2的商品颜色不要从黑色改成白色"])(
        "keeps the same explicit target across action and negation relations: %s",
        (prompt) => {
            const input = planning(prompt);
            const decision = resolveEcommerceReferenceDecision({ planningInput: input, analysis: vision(input, [reference("a"), reference("b")], [{ assetId: "a", purposes: ["style"], confidence: "high" }]) });
            expect(decision).toMatchObject({ state: "resolved", editTargetId: "b", productAnchorId: "b", issues: [] });
            expect(decision.bindings[1]).toMatchObject({ assetId: "b", purposes: ["edit_target", "product_identity"] });
        },
    );
});

function asset(id: string, type: CreativeAsset["type"] = "image"): CreativeAsset {
    return { id, userId: "user", conversationId: "conversation", ordinal: 0, type, status: "ready", title: "same title", serverUrl: `/api/assets/${id}`, width: 100, height: 100, metadata: {}, createdAt: 1, updatedAt: 1 };
}

function planning(prompt: string, ids = ["a", "b"]) {
    return buildEcommercePlanningInput(
        { userId: "user", conversationId: "conversation", surface: "chat", prompt, referencedAssetIds: ids },
        ids.map((id) => asset(id)),
        { summary: "", recentMessages: [] },
    );
}

function reference(assetId: string, contentType: EcommerceVisualReferenceV4["contentType"] = "isolated_product"): EcommerceVisualReferenceV4 {
    const product = contentType === "isolated_product";
    return {
        assetId,
        contentType,
        confidence: "high",
        visualEvidence: { whiteBackground: product, transparentBackground: false, isolatedSubject: product, completeScene: false },
        productFacts: product ? { identity: "cabinet", outline: "rectangular", color: "oak", material: "wood", brandText: [], view: "front" } : null,
        sceneFacts: null,
        productCore: product ? { x: 0.2, y: 0.2, width: 0.5, height: 0.5 } : null,
        fusionHalo: product ? { x: 0.1, y: 0.1, width: 0.7, height: 0.7 } : null,
        editableTargets: [],
        visibleStructure: [],
        cues: [{ id: "style", facet: "style", description: "简约自然色调", confidence: "high" }],
    };
}

function vision(input: ReturnType<typeof planning>, references: EcommerceVisualReferenceV4[], purposeSuggestions: Array<{ assetId: string; purposes: readonly string[]; confidence: string }> = []) {
    const analysis = normalizeEcommerceVisualAnalysis({ analysisVersion: "ecommerce-visual-analysis.v4", references, purposeSuggestions }, input.assetCandidates);
    if (analysis?.analysisVersion !== "ecommerce-visual-analysis.v4") throw new Error("Invalid test visual facts");
    return analysis;
}
