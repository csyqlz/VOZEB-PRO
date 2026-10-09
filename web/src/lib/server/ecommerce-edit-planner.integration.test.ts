import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { CreativeAsset } from "@/lib/creative-runtime-contract";
import { planEcommerceEdit, type EcommerceEditPlanningRequest } from "./ecommerce-edit-planner";
import type { EcommerceEditPlan } from "./ecommerce-edit-plan";
import { compileEcommerceImageRequest, resolveEcommerceImageProviderProfile } from "./ecommerce-image-compiler";
import { resolveImageEditProtocol } from "./image-edit-protocol";
import type { EcommerceRoleCandidate } from "./ecommerce-model-routing";
import { referenceUsesFromEcommerceDecision, resolveEcommerceReferenceDecision } from "./ecommerce-reference-purpose";
import { resolveSourcesFromEcommerceReferenceDecision } from "./ecommerce-reference-roles";
import { validateEcommerceVisualAnalysisV4, type EcommerceReferenceCue, type EcommerceVisualAnalysis, type EcommerceVisualAnalysisV4, type EcommerceVisualReferenceV4 } from "./ecommerce-visual-analysis";

vi.mock("@/lib/auth/store", () => ({ refundUserPoints: vi.fn(async () => undefined) }));

describe("active ecommerce edit planning TCP contract", () => {
    it.each(["openai", "gemini"].flatMap((apiFormat) => ["operation", "strategy"].map((field) => ({ apiFormat: apiFormat as "openai" | "gemini", field: field as "operation" | "strategy" }))))(
        "repairs an unexecutable product-only $field through the existing $apiFormat budget",
        async ({ apiFormat, field }) => {
            const fixture = projectionFixture("style-only");
            fixture.plan.strategy = "strict_product";
            fixture.input.planningInput.userRequest = "参考图片1的风格，修改图片2";
            fixture.plan.delta.requestedChanges = ["Match the authorized style without adding a room"];
            delete fixture.plan.photography;
            const before = structuredClone(fixture);
            const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
            const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
            try {
                const capture = await captureProjectionRequest(apiFormat, fixture, field);
                expect(capture.requests).toHaveLength(3);
                expect(JSON.stringify(capture.requests[2])).toContain("edit_plan_boundary");
                expect(JSON.stringify(capture.requests[2])).toContain(field);
                const first = capture.requests[0] as { tools: Array<{ function?: { parameters: unknown }; functionDeclarations?: Array<{ parameters: unknown }> }> };
                const schema = apiFormat === "gemini" ? first.tools[0].functionDeclarations![0].parameters : first.tools[0].function!.parameters;
                expect(schema).toMatchObject({ properties: { operation: { enum: ["product_to_scene"] }, strategy: { enum: ["strict_product"] } } });
                expect(capture.result.plan).toMatchObject({ operation: "product_to_scene", strategy: "strict_product", source: fixture.plan.source, baseline: { sceneFacts: null }, referenceUses: fixture.plan.referenceUses });
                expect(capture.result.plan.delta.requestedChanges).toEqual([
                    ...fixture.plan.delta.requestedChanges,
                    ...fixture.analysis.references.flatMap((reference) =>
                        "cues" in reference ? reference.cues.filter((cue) => fixture.input.referenceDecision!.appliedCues.some((use) => use.assetId === reference.assetId && use.cueIds.includes(cue.id))).map((cue) => cue.description) : [],
                    ),
                ]);
                expect(fixture.plan).toEqual(before.plan);
                expect(fixture.analysis).toEqual(before.analysis);
                expect({ ...fixture.input, origin: before.input.origin }).toEqual(before.input);
                expect(warnings).toHaveBeenCalledTimes(2);
                expect(errors).toHaveBeenCalledTimes(2);
            } finally {
                warnings.mockRestore();
                errors.mockRestore();
            }
        },
    );

    const cases = ["openai", "gemini"].flatMap((apiFormat) => ["cue", "version", "uses", "operation", "strategy"].map((failure) => ({ apiFormat: apiFormat as "openai" | "gemini", failure })));
    it.each(cases)("uses the actual v6 contract and repairs $failure through $apiFormat", async ({ apiFormat, failure }) => {
        const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
        const plan: EcommerceEditPlan = {
            planVersion: "ecommerce-edit.v6",
            operation: "scene_edit",
            source: { productAnchorId: null, currentSceneBaselineId: "target", sceneReferenceIds: ["style"] },
            baseline: { productFacts: null, sceneFacts: null },
            referenceUses: [
                { assetId: "target", alias: "图片2", purposes: ["edit_target"], usedCueIds: [] },
                { assetId: "style", alias: "图片1", purposes: ["lighting"], usedCueIds: ["light"] },
            ],
            delta: { requestedChanges: ["调整灯光"], targetObjects: [], targetRegions: [] },
            preserve: { productCore: [], sceneElements: [] },
            strategy: "integrated_scene",
            modelRoles: { visionAnalysis: "vision", editPlanning: "planner", generation: "image", qualityCheck: "qa" },
            continuity: { branchId: "branch", parentResultId: null },
            validation: { requiredChecks: ["scene_intent"] },
        };
        const server = createServer(async (request, response) => {
            const chunks = [];
            for await (const chunk of request) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            requests.push({ path: request.url || "", body });
            const output = structuredClone(plan);
            if (requests.length < 3) {
                if (failure === "cue") output.referenceUses![1].usedCueIds = ["foreign-cue"];
                else if (failure === "version") output.planVersion = "ecommerce-edit.v5";
                else if (failure === "operation") output.operation = "local_edit";
                else if (failure === "strategy") output.strategy = "strict_product";
                else delete output.referenceUses;
            }
            const payload = apiFormat === "gemini" ? { candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] } }] } : { choices: [{ message: { content: JSON.stringify(output) } }] };
            response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
        try {
            const address = server.address();
            if (!address || typeof address === "string") throw new Error("Missing fixture port");
            const origin = `http://127.0.0.1:${address.port}`;
            const analysis: EcommerceVisualAnalysisV4 = {
                analysisVersion: "ecommerce-visual-analysis.v4",
                modelRole: { logicalRole: "vision_analysis", logicalModelId: "vision", channelId: "fixture", upstreamModel: "fixture" },
                purposeSuggestions: [],
                rawAnalysis: {},
                normalizationAudit: [],
                references: ["style", "target"].map((assetId) => ({
                    assetId,
                    contentType: "interior_scene",
                    confidence: "high",
                    visualEvidence: { whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: false },
                    productFacts: null,
                    sceneFacts: null,
                    productCore: null,
                    fusionHalo: null,
                    editableTargets: [],
                    visibleStructure: [],
                    cues: assetId === "style" ? [{ id: "light", facet: "lighting", confidence: "high", description: "左侧柔光" }] : [],
                })),
            };
            const input: EcommerceEditPlanningRequest = {
                origin,
                cookie: "fixture-session",
                userId: "fixture-user",
                requestId: apiFormat,
                branchId: "branch",
                generationModelRole: "image",
                qualityCheckModelRole: "qa",
                planningInput: { userRequest: "参考图片1的光线，调整图片2的灯光", conversationId: "fixture", surface: "chat", assetCandidates: [], conversationContext: { summary: "", recentMessages: [] } },
                sources: { status: "resolved", ...plan.source, parentResultId: null, startsNewProductAnchor: false, createsBranch: false, ambiguityReason: null, clarificationQuestion: null },
                referenceDecision: {
                    version: "ecommerce-reference-decision.v1",
                    state: "resolved",
                    editTargetId: "target",
                    productAnchorId: null,
                    currentSceneBaselineId: "target",
                    bindings: [
                        { assetId: "style", alias: "图片1", purposes: ["lighting"], source: "explicit" },
                        { assetId: "target", alias: "图片2", purposes: ["edit_target"], source: "explicit" },
                    ],
                    appliedCues: [{ assetId: "style", purpose: "lighting", cueIds: ["light"] }],
                    issues: [],
                },
            };
            const candidate: EcommerceRoleCandidate = {
                logicalRole: "edit_planning",
                capability: "text",
                logicalModelId: "planner",
                channelId: apiFormat,
                upstreamModel: "fixture-model",
                channel: { id: apiFormat, name: apiFormat, apiFormat, baseUrl: "https://example.com/v1", apiKey: "fixture-key", enabled: true, models: ["fixture-model"] },
                snapshot: { logicalRole: "edit_planning", capability: "text", logicalModelId: "planner", channelId: apiFormat, upstreamModel: "fixture-model", apiFormat },
            };
            const result = await planEcommerceEdit(input, analysis, [candidate]);
            expect(result.plan).toMatchObject({ planVersion: "ecommerce-edit.v6", baseline: { sceneFacts: null }, referenceUses: plan.referenceUses });
            expect(requests).toHaveLength(3);
            const first = requests[0].body as { tools: Array<{ function?: { parameters: unknown }; functionDeclarations?: Array<{ parameters: unknown }> }> };
            const schema = apiFormat === "gemini" ? first.tools[0].functionDeclarations![0].parameters : first.tools[0].function!.parameters;
            expect(schema).toMatchObject({
                properties: {
                    planVersion: { enum: ["ecommerce-edit.v6"] },
                    operation: { enum: ["scene_edit"] },
                    strategy: { enum: ["integrated_scene"] },
                    referenceUses: { type: "array" },
                    baseline: { properties: { sceneFacts: { anyOf: [expect.anything(), { type: "null" }] } } },
                },
                required: expect.arrayContaining(["referenceUses"]),
            });
            expect(JSON.stringify(requests[2].body)).toContain(failure === "cue" ? "referenceUses[1].usedCueIds" : failure === "version" ? "planVersion" : failure === "uses" ? "referenceUses" : failure);
            expect(JSON.stringify(requests[2].body)).toContain("edit_plan_boundary");
            expect(new Set(requests.map((request) => request.path)).size).toBe(1);
            expect(input.sources.sceneReferenceIds).toEqual(["style"]);
            expect(warnings).toHaveBeenCalledTimes(2);
            for (const [message, detail] of warnings.mock.calls) {
                expect(message).toBe("[ecommerce-edit-planner] planner contract rejected");
                expect(JSON.parse(String(detail))).toMatchObject({ error: expect.stringContaining(failure === "cue" ? "可靠视觉线索" : failure === "version" ? "v6 版本契约" : failure === "uses" ? "referenceUses" : "仅支持") });
            }
            expect(errors).toHaveBeenCalledTimes(2);
            for (const [message, detail] of errors.mock.calls) {
                expect(message).toBe("[text-planning] structured response failed argument validation");
                expect(JSON.parse(String(detail))).toMatchObject({ protocol: apiFormat === "gemini" ? "gemini" : "chat", tool: "plan_ecommerce_edit" });
            }
        } finally {
            warnings.mockRestore();
            errors.mockRestore();
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        }
    });
});

type ProjectionScenario = "lighting-detail" | "lighting-scene" | "selected-cue-subset" | "style-only" | "mixed-uses" | "same-image" | "scene-edit" | "inherited-scene" | "local-edit";
type PlannerPayload = {
    visualAnalysis: { references: Array<Partial<EcommerceVisualReferenceV4> & { assetId: string; alias?: string | null; purposes?: string[] }> };
    referenceDecision?: EcommerceEditPlanningRequest["referenceDecision"];
    sources: EcommerceEditPlanningRequest["sources"];
    continuity: EcommerceEditPlan["continuity"];
    userRequest: string;
};

describe("authorized ecommerce planner input projection", () => {
    const scenarios: ProjectionScenario[] = ["lighting-detail", "lighting-scene", "selected-cue-subset", "style-only", "mixed-uses", "same-image", "scene-edit", "inherited-scene", "local-edit"];
    it.each(["openai", "gemini"].flatMap((apiFormat) => scenarios.map((scenario) => ({ apiFormat: apiFormat as "openai" | "gemini", scenario }))))(
        "projects only authorized facts and cues for $scenario through $apiFormat",
        async ({ apiFormat, scenario }) => {
            const fixture = projectionFixture(scenario);
            const decision = fixture.input.referenceDecision!;
            const before = structuredClone({ input: fixture.input, analysis: fixture.analysis });
            freezeProjectionFixture(fixture.analysis);
            const capture = await captureProjectionRequest(apiFormat, fixture);
            const first = capture.requests[0] as { tools: Array<{ function?: { parameters: unknown }; functionDeclarations?: Array<{ parameters: unknown }> }> };
            const schema = apiFormat === "gemini" ? first.tools[0].functionDeclarations![0].parameters : first.tools[0].function!.parameters;
            expect(schema).toMatchObject({ properties: { operation: { enum: [fixture.plan.operation] }, strategy: { enum: [fixture.plan.strategy] } } });
            const { payload, system } = readProjectionMessages(apiFormat, capture.requests[0]);
            const projected = payload.visualAnalysis;
            expect.soft(system).not.toContain("场景参考只借鉴空间、光线和风格");
            expect.soft(system).toContain("绑定用途");
            expect.soft(system).toContain("已选线索");
            expect.soft(projected).not.toHaveProperty("rawAnalysis");
            expect.soft(projected).not.toHaveProperty("purposeSuggestions");
            expect.soft(projected).not.toHaveProperty("normalizationAudit");
            expect.soft(projected).not.toHaveProperty("summary");
            expect.soft(JSON.stringify(capture.requests)).not.toContain("RAW_AUDIT_ONLY");
            expect.soft(JSON.stringify(capture.requests)).not.toContain("AUX_");
            expect(payload.referenceDecision).toEqual(decision);
            expect(payload.sources).toEqual(fixture.input.sources);
            expect(payload.continuity).toEqual(fixture.plan.continuity);
            expect(payload.userRequest).toBe(fixture.input.planningInput.userRequest);

            for (const original of fixture.analysis.references) {
                const reference = projected.references.find((item) => item.assetId === original.assetId);
                expect(reference).toBeDefined();
                const use = fixture.plan.referenceUses!.find((item) => item.assetId === original.assetId)!;
                const selectedIds = decision.appliedCues.filter((item) => item.assetId === original.assetId && use.purposes.includes(item.purpose)).flatMap((item) => item.cueIds);
                expect.soft(reference?.cues).toEqual(original.cues.filter((cue) => selectedIds.includes(cue.id)));
                expect.soft(reference?.alias).toBe(use.alias);
                expect.soft(reference?.purposes).toEqual(use.purposes);
                for (const cue of original.cues.filter((item) => !selectedIds.includes(item.id))) expect.soft(JSON.stringify(capture.requests)).not.toContain(cue.description);
                if (original.assetId === "aux") {
                    expect.soft(Object.keys(reference || {}).sort()).toEqual(["alias", "assetId", "cues", "purposes"]);
                } else {
                    expect(reference).toMatchObject({
                        confidence: original.confidence,
                        visualEvidence: original.visualEvidence,
                        productCore: original.productCore,
                        fusionHalo: original.fusionHalo,
                        editableTargets: original.editableTargets,
                        visibleStructure: original.visibleStructure,
                        photographyFacts: original.photographyFacts,
                        sourceSize: original.sourceSize,
                    });
                    if (original.assetId === decision.productAnchorId) expect(reference?.productFacts).toEqual(original.productFacts);
                    if (original.assetId === decision.currentSceneBaselineId) expect(reference?.sceneFacts).toEqual(original.sceneFacts);
                }
            }

            const selectedDescriptions = fixture.analysis.references.flatMap((reference) =>
                reference.cues.filter((cue) => decision.appliedCues.some((item) => item.assetId === reference.assetId && item.cueIds.includes(cue.id))).map((cue) => cue.description),
            );
            expect.soft(capture.result.plan.delta.requestedChanges).toEqual([...fixture.plan.delta.requestedChanges, ...selectedDescriptions]);
            expect(capture.result.plan.referenceUses).toEqual(fixture.plan.referenceUses);
            expect(capture.result.plan.source).toEqual(fixture.plan.source);
            expect(capture.result.plan.continuity).toEqual(fixture.plan.continuity);
            expect(capture.result.plan.baseline.productFacts).toEqual(fixture.plan.baseline.productFacts);
            expect(capture.result.plan.baseline.sceneFacts).toEqual(fixture.plan.baseline.sceneFacts);
            expect(capture.result.plan.preserve.productCore).toEqual(fixture.plan.preserve.productCore);
            if (fixture.plan.operation === "local_edit") expect(capture.result.plan.delta.targetObjects).toEqual(fixture.plan.delta.targetObjects);
            const compiled = ["gpt-image-2.5-flare", "nano-banana-2"].map((upstreamModel) => {
                const profile = resolveEcommerceImageProviderProfile({
                    logicalRole: "image_generation",
                    capability: "image",
                    logicalModelId: "image",
                    channelId: "fixture",
                    upstreamModel,
                    apiFormat: "openai",
                    imageEdit: resolveImageEditProtocol({ apiFormat: "openai", model: upstreamModel }),
                });
                if (!profile) throw new Error("Missing fixture image profile");
                expect(profile.supportsIndependentMask).toBe(upstreamModel === "gpt-image-2.5-flare");
                const output = compileEcommerceImageRequest(capture.result.plan, profile);
                const requiresMask = fixture.plan.strategy === "strict_product" || (fixture.plan.operation === "scene_edit" && capture.result.plan.protection?.scope === "local");
                if (requiresMask && !profile.supportsIndependentMask) expect(output).toMatchObject({ state: "needs_review", reason: "independent_mask_unsupported" });
                else expect(output.state).toBe("ready");
                expect(output.compilerVersion).toMatch(/\.v4$/);
                expect(output.referenceMapping).toEqual(fixture.plan.referenceUses!.map((use, providerIndex) => ({ assetId: use.assetId, userAlias: use.alias, providerIndex, purposes: use.purposes })));
                expect(output.prompt).toContain(fixture.plan.delta.requestedChanges[0]);
                for (const description of selectedDescriptions) expect(output.prompt).toContain(description);
                for (const reference of fixture.analysis.references) for (const cue of reference.cues.filter((item) => !selectedDescriptions.includes(item.description))) expect.soft(output.prompt).not.toContain(cue.description);
                expect(output.prompt).not.toContain("场景参考只借鉴空间、光线和风格");
                return output;
            });
            expect(fixture.analysis).toEqual(before.analysis);
            expect({ ...fixture.input, origin: before.input.origin }).toEqual(before.input);
            expect(capture.requests).toHaveLength(1);
            if (process.env.ECOMMERCE_PLANNER_PROJECTION_CAPTURE === "1") console.log(JSON.stringify({ apiFormat, scenario, requests: capture.requests, plan: capture.result.plan, compiled }));
        },
    );

    it.each(["openai", "gemini"] as const)("preserves full analysis and the legacy system instruction without a decision through %s", async (apiFormat) => {
        const fixture = projectionFixture("lighting-scene");
        const legacyAnalysis: EcommerceVisualAnalysis = {
            ...fixture.analysis,
            analysisVersion: "ecommerce-visual-analysis.v3",
            references: fixture.analysis.references.map(({ contentType, ...reference }) => ({
                ...reference,
                role: contentType === "isolated_product" ? "product" : "scene",
                productFacts: contentType === "isolated_product" ? reference.productFacts : null,
            })),
        };
        const legacyPlan = structuredClone(fixture.plan);
        legacyPlan.planVersion = "ecommerce-edit.v5";
        legacyPlan.baseline.sceneFacts = legacyAnalysis.references.find((reference) => reference.assetId === "aux")!.sceneFacts;
        delete legacyPlan.referenceUses;
        const legacyFixture = { ...fixture, analysis: legacyAnalysis, input: { ...fixture.input, referenceDecision: undefined }, plan: legacyPlan };
        const capture = await captureProjectionRequest(apiFormat, legacyFixture);
        const { payload, system } = readProjectionMessages(apiFormat, capture.requests[0]);
        expect(payload.visualAnalysis).toEqual(legacyAnalysis);
        expect(payload).not.toHaveProperty("referenceDecision");
        expect(system).toContain("场景参考只借鉴空间、光线和风格");
        expect(JSON.stringify(capture.requests)).toContain("RAW_AUDIT_ONLY");
        expect(JSON.stringify(capture.requests)).toContain("AUX_PRODUCT_IDENTITY");
        expect(capture.result.plan.planVersion).toBe("ecommerce-edit.v5");
        expect(capture.requests).toHaveLength(1);
        if (process.env.ECOMMERCE_PLANNER_PROJECTION_CAPTURE === "1") console.log(JSON.stringify({ apiFormat, scenario: "legacy", requests: capture.requests, plan: capture.result.plan }));
    });
});

function projectionFixture(scenario: ProjectionScenario) {
    const inherited = scenario === "inherited-scene" || scenario === "local-edit";
    const hasScene = inherited || scenario === "scene-edit";
    const sameImage = scenario === "same-image";
    const reference = (assetId: string, contentType: EcommerceVisualReferenceV4["contentType"]): EcommerceVisualReferenceV4 => ({
        assetId,
        contentType,
        confidence: "high",
        visualEvidence: { whiteBackground: contentType === "isolated_product", transparentBackground: false, isolatedSubject: contentType === "isolated_product", completeScene: contentType === "interior_scene" },
        productFacts: contentType === "interior_scene" ? null : { identity: "TARGET_OAK_CHAIR", outline: "three curved legs", color: "oak", material: "wood", brandText: [], view: "front" },
        sceneFacts: contentType === "interior_scene" ? { space: "TARGET_GRAY_ROOM", composition: "TARGET_EYE_LEVEL", lighting: "TARGET_NEUTRAL_LIGHT" } : null,
        productCore: { x: 0.3, y: 0.3, width: 0.4, height: 0.4 },
        fusionHalo: { x: 0.2, y: 0.2, width: 0.6, height: 0.6 },
        editableTargets: contentType === "interior_scene" ? [{ id: "target-prop", kind: "prop", label: "TARGET_TABLE_PROP", region: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 } }] : [],
        visibleStructure: [{ objectId: assetId === "anchor" ? "anchor-core" : "target-prop", feature: "legs", count: 3, certainty: "confirmed", evidenceRegion: { x: 20, y: 20, width: 100, height: 100 } }],
        photographyFacts: {
            materials: [{ objectId: assetId === "anchor" ? "anchor-core" : "target-prop", textureDirection: "TARGET_VERTICAL_GRAIN", textureScale: "TARGET_FINE_GRAIN", roughness: "TARGET_MATTE", gloss: "TARGET_LOW_GLOSS" }],
            lighting: { keyLight: "TARGET_KEY_LIGHT", fillLight: "TARGET_FILL_LIGHT", whiteBalance: "TARGET_WHITE_BALANCE", contactShadow: "TARGET_CONTACT_SHADOW" },
            composition: { focalSubject: "TARGET_FOCAL_SUBJECT", depth: "TARGET_DEPTH", negativeSpace: "TARGET_NEGATIVE_SPACE" },
        },
        cues: [{ id: "unused-target-style", facet: "style", confidence: "high", description: "UNSELECTED_TARGET_STYLE" }],
    });
    const aux = reference("aux", scenario === "lighting-detail" ? "product_detail" : "interior_scene");
    aux.confidence = scenario === "lighting-detail" ? "medium" : "high";
    aux.visualEvidence.completeScene = scenario !== "lighting-detail";
    aux.productFacts = { identity: "AUX_PRODUCT_IDENTITY", outline: "AUX_OUTLINE", color: "AUX_COLOR", material: "AUX_MATERIAL", brandText: ["AUX_BRAND_TEXT"], view: "AUX_VIEW" };
    aux.sceneFacts = { space: "AUX_SPACE", composition: "AUX_COMPOSITION", lighting: "AUX_FULL_LIGHTING" };
    aux.editableTargets = [{ id: "AUX_PROP", kind: "prop", label: "AUX_PROP_LABEL", region: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 } }];
    aux.visibleStructure = [{ objectId: "AUX_STRUCTURE", feature: "legs", count: 2, certainty: "uncertain", evidenceRegion: { x: 20, y: 20, width: 100, height: 100 } }];
    aux.photographyFacts = {
        materials: [{ objectId: "AUX_MATERIAL_OBJECT", textureDirection: "AUX_TEXTURE_DIRECTION", textureScale: "AUX_TEXTURE_SCALE", roughness: "AUX_ROUGHNESS", gloss: "AUX_GLOSS" }],
        lighting: { keyLight: "AUX_KEY_LIGHT", fillLight: "AUX_FILL_LIGHT", whiteBalance: "AUX_WHITE_BALANCE", contactShadow: "AUX_CONTACT_SHADOW" },
        composition: { focalSubject: "AUX_FOCAL_SUBJECT", depth: "AUX_DEPTH", negativeSpace: "AUX_NEGATIVE_SPACE" },
    };
    aux.cues = [
        { id: "light", facet: "lighting", confidence: "high", description: "SELECTED_SOFT_LEFT_LIGHT" },
        { id: "style", facet: "style", confidence: "high", description: "SELECTED_SCARLET_MARBLE_STYLE" },
        { id: "composition", facet: "composition", confidence: "high", description: "SELECTED_WIDE_NEGATIVE_SPACE" },
        { id: "material", facet: "material_appearance", confidence: "high", description: "SELECTED_MATTE_ENVIRONMENT" },
        { id: "unused-light", facet: "lighting", confidence: "medium", description: "UNSELECTED_OVERHEAD_LIGHT" },
    ];
    if (scenario === "selected-cue-subset") aux.cues[4].confidence = "high";
    const target = reference(hasScene ? "current-scene" : "target", hasScene ? "interior_scene" : "isolated_product");
    if (scenario === "inherited-scene") target.editableTargets = [{ id: "target-light", kind: "lighting", label: "TARGET_SCENE_LIGHT", region: { x: 0, y: 0, width: 1, height: 1 } }];
    const rawReferences = sameImage ? [target] : [aux, target, ...(inherited ? [reference("anchor", "isolated_product")] : [])];
    const assets: CreativeAsset[] = rawReferences.map((item, ordinal) => ({
        id: item.assetId,
        type: "image",
        status: "ready",
        title: "fixture image",
        userId: "fixture-user",
        conversationId: "fixture",
        ordinal,
        metadata: {},
        width: 1024,
        height: 768,
        createdAt: 1,
        updatedAt: 1,
        ...(item.assetId === "current-scene" ? { sourceRunId: "fixture-parent-run", parentAssetId: "anchor" } : {}),
    }));
    const facets = scenario === "style-only" || scenario === "local-edit" ? "风格" : scenario === "mixed-uses" ? "风格、光线和构图" : "光线";
    const userRequest = sameImage
        ? "修改图片1，参考图片1的风格，把商品放进简单灰色房间"
        : inherited
          ? `参考图片1的${facets}，${scenario === "local-edit" ? "在当前场景的桌子旁增加一只杯子" : "调整当前场景的光线"}`
          : `参考图片1的${facets}，修改图片2，${hasScene ? "调整场景光线" : "把商品放进简单灰色房间"}`;
    const planningInput: EcommerceEditPlanningRequest["planningInput"] = {
        userRequest,
        conversationId: "fixture",
        surface: "chat",
        assetCandidates: assets,
        referenceAliases: sameImage ? [{ assetId: "target", alias: "图片1" }] : [{ assetId: "aux", alias: "图片1" }, ...(!inherited ? [{ assetId: target.assetId, alias: "图片2" }] : [])],
        ...(inherited ? { inheritedReferences: { editTargetId: "current-scene", productAnchorId: "anchor" } } : {}),
        conversationContext: { summary: "", recentMessages: [] },
    };
    const validation = validateEcommerceVisualAnalysisV4(
        {
            analysisVersion: "ecommerce-visual-analysis.v4",
            references: rawReferences,
            purposeSuggestions: sameImage ? [] : [{ assetId: "aux", purposes: ["style", "composition"], confidence: "high" }],
            summary: "RAW_AUDIT_ONLY",
            visualEvidence: "RAW_AUDIT_ONLY",
        },
        assets,
    );
    expect(validation.issues).toEqual([]);
    if (!validation.analysis) throw new Error("Invalid projection fixture analysis");
    const analysis: EcommerceVisualAnalysisV4 = { ...validation.analysis, modelRole: { logicalRole: "vision_analysis", logicalModelId: "vision", channelId: "fixture", upstreamModel: "fixture-model" } };
    const decision = resolveEcommerceReferenceDecision({ planningInput, analysis });
    expect(decision.state).toBe("resolved");
    // A valid authoritative selection can be narrower than all high cues of
    // the allowed facet. The planner must obey cue IDs as well as purposes.
    if (scenario === "selected-cue-subset") decision.appliedCues = decision.appliedCues.map((item) => ({ ...item, cueIds: item.cueIds.filter((id) => id !== "unused-light") }));
    const sources = resolveSourcesFromEcommerceReferenceDecision(decision, assets, inherited ? assets.filter((asset) => asset.id === "current-scene") : []);
    expect(sources.status).toBe("resolved");
    const input: EcommerceEditPlanningRequest = {
        origin: "fixture-origin",
        cookie: "fixture-session",
        userId: "fixture-user",
        requestId: scenario,
        branchId: "fixture-branch",
        generationModelRole: "image",
        qualityCheckModelRole: "qa",
        planningInput,
        referenceDecision: decision,
        sources,
    };
    const sourceOrder = [...new Set([sources.currentSceneBaselineId, sources.productAnchorId, ...sources.sceneReferenceIds].filter((id): id is string => Boolean(id)))];
    const anchor = analysis.references.find((item) => item.assetId === sources.productAnchorId);
    const scene = analysis.references.find((item) => item.assetId === sources.currentSceneBaselineId);
    const plan: EcommerceEditPlan = {
        planVersion: "ecommerce-edit.v6",
        operation: inherited ? "local_edit" : hasScene ? "scene_edit" : "product_to_scene",
        strategy: sources.productAnchorId ? "strict_product" : "integrated_scene",
        source: { productAnchorId: sources.productAnchorId, currentSceneBaselineId: sources.currentSceneBaselineId, sceneReferenceIds: [...sources.sceneReferenceIds] },
        baseline: { productFacts: anchor?.productFacts || null, sceneFacts: scene?.sceneFacts || null },
        referenceUses: referenceUsesFromEcommerceDecision({ decision, sourceOrder }),
        delta: {
            requestedChanges: [scenario === "local-edit" ? "Add one cup next to the target prop" : hasScene ? "Adjust the current scene lighting" : "Place the product in a simple gray room"],
            targetObjects: scenario === "local-edit" ? ["target-prop"] : scenario === "inherited-scene" ? ["target-light"] : [],
            targetRegions: [],
        },
        preserve: { productCore: anchor ? ["outline", "brand_text", "color", "material", "scale", "view"] : [], sceneElements: scene ? ["target-prop"] : [] },
        photography: structuredClone((anchor || scene)!.photographyFacts),
        modelRoles: { visionAnalysis: "vision", editPlanning: "planner", generation: "image", qualityCheck: "qa" },
        continuity: { branchId: input.branchId, parentResultId: sources.parentResultId },
        validation: { requiredChecks: ["product_identity", "scene_intent"] },
    };
    return { input, analysis, plan };
}

async function captureProjectionRequest(apiFormat: "openai" | "gemini", fixture: { input: EcommerceEditPlanningRequest; analysis: EcommerceVisualAnalysis | EcommerceVisualAnalysisV4; plan: EcommerceEditPlan }, rejectedField?: "operation" | "strategy") {
    const requests: Array<Record<string, unknown>> = [];
    const server = createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        requests.push(body);
        const { payload } = readProjectionMessages(apiFormat, body);
        const output = structuredClone(fixture.plan);
        // The offline model fixture consumes exactly the cues sent to the real
        // planner. It does not sanitize the returned delta or change the uses.
        output.delta.requestedChanges.push(...payload.visualAnalysis.references.flatMap((reference) => (reference.cues || []).map((cue: EcommerceReferenceCue) => cue.description)));
        if (rejectedField && requests.length < 3) {
            if (rejectedField === "operation") output.operation = "local_edit";
            else output.strategy = "integrated_scene";
        }
        const result = apiFormat === "gemini" ? { candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] } }] } : { choices: [{ message: { content: JSON.stringify(output) } }] };
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing projection fixture port");
        fixture.input.origin = `http://127.0.0.1:${address.port}`;
        freezeProjectionFixture(fixture.input);
        const candidate: EcommerceRoleCandidate = {
            logicalRole: "edit_planning",
            capability: "text",
            logicalModelId: "planner",
            channelId: apiFormat,
            upstreamModel: "fixture-model",
            channel: { id: apiFormat, name: apiFormat, apiFormat, baseUrl: "https://example.com/v1", apiKey: "fixture-key", enabled: true, models: ["fixture-model"] },
            snapshot: { logicalRole: "edit_planning", capability: "text", logicalModelId: "planner", channelId: apiFormat, upstreamModel: "fixture-model", apiFormat },
        };
        const result = await planEcommerceEdit(fixture.input, fixture.analysis, [candidate]);
        return { requests, result };
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
}

function readProjectionMessages(apiFormat: "openai" | "gemini", body: Record<string, unknown>) {
    const openai = body as { messages: Array<{ role: string; content: string }> };
    const gemini = body as { contents: Array<{ role: string; parts: Array<{ text: string }> }>; systemInstruction: { parts: Array<{ text: string }> } };
    const user = apiFormat === "gemini" ? gemini.contents.find((message) => message.role === "user")!.parts[0].text : openai.messages.find((message) => message.role === "user")!.content;
    const system = apiFormat === "gemini" ? gemini.systemInstruction.parts[0].text : openai.messages.find((message) => message.role === "system")!.content;
    return { payload: JSON.parse(user) as PlannerPayload, system };
}

function freezeProjectionFixture<T>(value: T): T {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        Object.values(value).forEach(freezeProjectionFixture);
    }
    return value;
}
