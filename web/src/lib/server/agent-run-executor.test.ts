import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { createHash } from "node:crypto";
import type { CreativeConversationContext } from "@/lib/creative-runtime-contract";
import { AGENT_PLAN_SCHEMA_VERSION } from "./agent-run-audit";
import type { AgentRun, AgentRunTask } from "./agent-run-store";
import type { ImageTask } from "./image-task-store";
import { buildSceneEditProtection, compositeSceneEdit } from "./ecommerce-product-regions";
import { resolveImageEditProtocol } from "./image-edit-protocol";
import { canvasPlan, canvasSettings, conversationPlan, creativeImageAsset, disabledSettings, imageTask, plannerFailoverSettings, planningRun, runFixture, runWithTasks, settings } from "./agent-run-executor.test-fixtures";

const mocks = vi.hoisted(() => ({
    fetchInternalApi: vi.fn(),
    fetchSafeOutbound: vi.fn(),
    getAuthSettings: vi.fn(),
    refundUserPoints: vi.fn(async () => undefined),
    getCreativeAssetsByIds: vi.fn(async (_ids: string[] = []): Promise<Array<Record<string, unknown>>> => {
        void _ids;
        return [];
    }),
    listRecentCreativeMediaAssets: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []),
    getCreativeConversationContext: vi.fn(async (): Promise<CreativeConversationContext> => ({ summary: "", summaryThroughSequence: 0, recentMessages: [] })),
    mutateCreativeRun: vi.fn(),
    registerCreativeAssets: vi.fn(),
    reviewCreativeOutputs: vi.fn(),
    linkStoredGenerationTask: vi.fn(async () => undefined),
    getStoredGenerationTaskRecord: vi.fn(),
    events: [] as Array<{ type: string; data?: unknown }>,
    run: null as AgentRun | null,
    updateAgentRunById: vi.fn(),
    updateAgentRunTaskById: vi.fn(),
    scheduleGenerationTask: vi.fn<(type: string, id: string, patch: { executionPhase?: string }) => Promise<void>>(async () => undefined),
    analyzeEcommerceReferences: vi.fn(),
    planEcommerceEdit: vi.fn(),
    selectCurrentSceneBaseline: vi.fn(),
    createEditBranch: vi.fn(),
    checkEcommerceResult: vi.fn(),
    checkEcommerceTechnicalResult: vi.fn(),
    attachEcommerceTraceToGenerationLogs: vi.fn(async () => ({ updated: 1 })),
    updateImageTask: vi.fn(async (id: string, patch: Record<string, unknown>) => ({ id, ...patch })),
    getImageTask: vi.fn(async (_id: string): Promise<ImageTask | null> => {
        void _id;
        return null;
    }),
}));

vi.mock("@/lib/auth/store", () => ({
    getAuthSettings: mocks.getAuthSettings,
    refundUserPoints: mocks.refundUserPoints,
}));
vi.mock("@/lib/server/internal-origin", () => ({ fetchInternalApi: mocks.fetchInternalApi }));
vi.mock("@/lib/server/safe-outbound-fetch", () => ({ fetchSafeOutbound: mocks.fetchSafeOutbound }));
vi.mock("@/lib/server/creative-runtime-store", () => ({
    getCreativeAssetsByIds: mocks.getCreativeAssetsByIds,
    getCreativeConversationContext: mocks.getCreativeConversationContext,
    listRecentCreativeMediaAssets: mocks.listRecentCreativeMediaAssets,
    registerCreativeAssets: mocks.registerCreativeAssets,
    mutateCreativeRun: mocks.mutateCreativeRun,
}));
vi.mock("@/lib/server/generation-task-store", () => ({ linkStoredGenerationTask: mocks.linkStoredGenerationTask, getStoredGenerationTaskRecord: mocks.getStoredGenerationTaskRecord }));
vi.mock("@/lib/server/generation-task-scheduler", () => ({ scheduleGenerationTask: mocks.scheduleGenerationTask }));
vi.mock("@/lib/server/generation-log-store", () => ({ attachEcommerceTraceToGenerationLogs: mocks.attachEcommerceTraceToGenerationLogs }));
vi.mock("@/lib/server/image-task-store", () => ({ updateImageTask: mocks.updateImageTask, getImageTask: mocks.getImageTask }));
vi.mock("@/lib/server/creative-review-service", () => ({ reviewCreativeOutputs: mocks.reviewCreativeOutputs }));
vi.mock("./ecommerce-visual-analysis", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./ecommerce-visual-analysis")>();
    return { ...actual, analyzeEcommerceReferences: mocks.analyzeEcommerceReferences };
});
vi.mock("./ecommerce-edit-planner", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./ecommerce-edit-planner")>();
    return { ...actual, planEcommerceEdit: mocks.planEcommerceEdit };
});
vi.mock("./ecommerce-quality-check", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./ecommerce-quality-check")>();
    return { ...actual, checkEcommerceResult: mocks.checkEcommerceResult, checkEcommerceResultWithFallback: mocks.checkEcommerceResult, checkEcommerceTechnicalResult: mocks.checkEcommerceTechnicalResult };
});
vi.mock("@/lib/server/agent-run-store", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/server/agent-run-store")>();
    return {
        ...actual,
        getAgentRun: vi.fn(async () => mocks.run),
        updateAgentRunById: mocks.updateAgentRunById,
        updateAgentRunTaskById: mocks.updateAgentRunTaskById,
        selectCurrentSceneBaseline: mocks.selectCurrentSceneBaseline,
        createEditBranch: mocks.createEditBranch,
    };
});

import { executeAgentRun } from "./agent-run-executor";
import { prepareEcommerceSceneSelectionResume } from "./ecommerce-generation-service";
import { executeTasks, processAgentRunReview, taskResultOps } from "./agent-run-execution";
import { resetTextPlanningRuntime } from "./text-planning-runtime";
import { publicAgentRun } from "./agent-run-public";
import { UNKNOWN_SUBMISSION_REVIEW_ERROR } from "./generation-errors";
import { normalizeEcommerceVisualAnalysis } from "./ecommerce-visual-analysis";
import { createEcommerceReferenceCheckpoint, referenceSourcesLoaded } from "./ecommerce-reference-recovery";
import { buildEcommercePlanningInput } from "./ecommerce-generation-snapshot";
import { referenceUsesFromEcommerceDecision, resolveEcommerceReferenceDecision } from "./ecommerce-reference-purpose";
import { recoverEcommerceReferences } from "./ecommerce-reference-recovery-service";
import { publicAgentRunForRequest } from "./agent-run-public-selection";

async function executeAndReview(...args: Parameters<typeof executeAgentRun>) {
    await executeAgentRun(...args);
    if (mocks.run?.status === "completed" && mocks.run.reviewStatus === "review_pending" && mocks.run.ecommerceSnapshot?.qualityPolicy === "advisory") {
        await processAgentRunReview(mocks.run, args[1], args[2]);
    }
}

describe("executeAgentRun backend settings", () => {
    it("keeps completed analysis, route and frozen identities after a temporary original-source 503", async () => {
        const fixture = await frozenReferenceFixture("confirm_purposes");
        const frozen = fixture.run.ecommerceSnapshot!.referenceCheckpoint!;
        frozen.route = { ...fixture.analysis.modelRole, capability: "text", apiFormat: "gemini" };
        mocks.run = fixture.run;
        mocks.getAuthSettings.mockResolvedValue(ecommerceSettings());
        mocks.getCreativeAssetsByIds.mockResolvedValue([fixture.product]);
        mocks.fetchInternalApi.mockResolvedValue(new Response("unavailable", { status: 503 }));
        await executeAndReview(mocks.run, "http://localhost", "session=test");
        expect(mocks.run).toMatchObject({
            status: "paused",
            tasks: [{ status: "needs_review", attempts: 0 }],
            ecommerceSnapshot: {
                fallback: { reason: "reference_source_unavailable" },
                referenceCheckpoint: { inputId: frozen.inputId, decisionId: frozen.decisionId, analysisStage: frozen.analysisStage, analysis: fixture.analysis, route: frozen.route, sourceReadFailure: { kind: "source_read", status: 503 } },
            },
        });
        expect(mocks.run!.ecommerceSnapshot!.referenceCheckpoint!.assets).toEqual(frozen.assets);
        expect(mocks.analyzeEcommerceReferences).not.toHaveBeenCalled();
        expect(mocks.planEcommerceEdit).not.toHaveBeenCalled();
        expect(mocks.fetchInternalApi.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
        const publicRun = await publicAgentRunForRequest(mocks.run!, new Request("http://localhost"));
        expect(publicRun.ecommerceReferenceReview).toMatchObject({ kind: "retry_source", question: expect.stringContaining("读取") });
        expect(publicRun.ecommerceReferenceReview?.question).not.toMatch(/无效|重新提供/);
    });

    it("recovers the same run from source-read review on matching bytes without clearing or reposting completed analysis", async () => {
        const fixture = await frozenReferenceFixture("confirm_purposes");
        const checkpoint = fixture.run.ecommerceSnapshot!.referenceCheckpoint!;
        const route = { ...fixture.analysis.modelRole, capability: "text" as const, apiFormat: "gemini" as const };
        mocks.run = {
            ...fixture.run,
            status: "paused",
            tasks: [{ id: "source-review", title: "reference", type: "image", prompt: fixture.run.prompt, count: 1, dependencies: [], status: "needs_review", attempts: 0 }],
            ecommerceSnapshot: {
                ...fixture.run.ecommerceSnapshot!,
                fallback: { reason: "reference_source_unavailable" },
                referenceCheckpoint: { ...checkpoint, state: "needs_review", route, sourceReadFailure: { kind: "source_read", status: 503, message: "参考图片暂时无法读取" } },
            },
        };
        const paused = structuredClone(mocks.run);
        mocks.getCreativeAssetsByIds.mockResolvedValue([fixture.product]);
        mocks.fetchInternalApi.mockImplementation(async () => new Response(fixture.source, { headers: { "content-type": "image/png" } }));
        mocks.mutateCreativeRun.mockImplementation(async (_id, _ttl, mutate, allowedStatuses) => {
            if (!mocks.run || !allowedStatuses.includes(mocks.run.status)) return null;
            const result = mutate(mocks.run, { persistedChildren: [] });
            mocks.run = result?.run || mocks.run;
            return result?.run || null;
        });
        const recovered = await recoverEcommerceReferences({
            run: paused,
            recovery: { reviewId: checkpoint.reviewId, action: "retry_source" },
            actorId: paused.userId,
            conversationId: paused.conversationId,
            origin: "http://localhost",
            cookie: "session=test",
        });
        expect(recovered).not.toBeNull();
        expect(recovered).toMatchObject({ id: paused.id, conversationId: paused.conversationId, inputMessageId: paused.inputMessageId, assistantMessageId: paused.assistantMessageId, status: "planning", tasks: [] });
        expect(recovered!.ecommerceSnapshot!.referenceCheckpoint).toMatchObject({ inputId: checkpoint.inputId, assets: checkpoint.assets, analysis: fixture.analysis, analysisStage: checkpoint.analysisStage, route });
        expect(recovered!.ecommerceSnapshot!.referenceCheckpoint!.history).toEqual(checkpoint.history);
        mocks.getAuthSettings.mockResolvedValue(ecommerceSettings());
        mocks.planEcommerceEdit.mockRejectedValue(new Error("stop after observing the resumed planner"));
        await executeAndReview(recovered!, "http://localhost", "session=test");
        expect(mocks.planEcommerceEdit).toHaveBeenCalledOnce();
        expect(mocks.analyzeEcommerceReferences).not.toHaveBeenCalled();
        expect(mocks.selectCurrentSceneBaseline).not.toHaveBeenCalled();
        expect(mocks.run!.ecommerceSnapshot!.referenceCheckpoint).toMatchObject({ inputId: checkpoint.inputId, analysis: fixture.analysis, analysisStage: checkpoint.analysisStage, route });
        expect(mocks.run!.ecommerceSnapshot!.referenceCheckpoint!.assets).toEqual(checkpoint.assets);
    });

    it("persists the complete frozen reference input and stage identity before entering the analyzer", async () => {
        const product = { ...creativeImageAsset("asset-product", "product.png", "upload"), type: "image" as const, status: "ready" as const, serverUrl: "/api/reference-assets/product.png" };
        mocks.run = runFixture({ surface: "chat", projectId: undefined, prompt: "修改图片1", referencedAssetIds: [product.id], generationPreferences: { mode: "image" } });
        mocks.getCreativeAssetsByIds.mockResolvedValue([product]);
        mocks.getAuthSettings.mockResolvedValue(ecommerceSettings());
        mocks.getCreativeConversationContext.mockResolvedValue({ summary: "frozen summary", summaryThroughSequence: 0, recentMessages: [] });
        let observed: unknown;
        let requestId = "";
        mocks.analyzeEcommerceReferences.mockImplementation(async (input) => {
            observed = structuredClone(mocks.run?.ecommerceSnapshot?.referenceCheckpoint);
            requestId = input.requestId;
            throw new Error("fixture service failure");
        });
        await executeAndReview(mocks.run, "http://localhost", "session=test");
        expect(observed).toMatchObject({
            version: "ecommerce-reference-checkpoint.v1",
            state: "analyzing",
            inputId: expect.any(String),
            analysisStage: { requestId, state: "created" },
            planningInput: { userRequest: "修改图片1", conversationContext: { summary: "frozen summary" }, assetCandidates: [{ id: product.id }] },
            assets: [{ asset: { id: product.id } }],
        });
        expect(requestId).not.toBe(mocks.run!.id);
        expect(mocks.run?.ecommerceSnapshot?.referenceCheckpoint).toMatchObject({ state: "needs_review", analysisStage: { requestId, state: "failed" } });
    });

    it.each(["confirm_purposes", "retry_analysis", "initial"] as const)("reuses completed frozen analysis at the pre-planning crash boundary after %s without selecting a newer baseline", async (action) => {
        const product = { ...creativeImageAsset("asset-product", "product.png", "upload"), type: "image" as const, status: "ready" as const, remoteUrl: undefined, sourceRunId: "upload", serverUrl: "/api/reference-assets/product.png" };
        const run = runFixture({ surface: "chat", projectId: undefined, prompt: "修改图片1", referencedAssetIds: [product.id], generationPreferences: { mode: "image" } });
        const planningInput = buildEcommercePlanningInput(run, [product], { summary: "frozen summary", recentMessages: [] });
        const legacy = ecommerceAnalysis("product");
        const analysis = {
            ...legacy,
            analysisVersion: "ecommerce-visual-analysis.v4" as const,
            references: legacy.references.map(({ role: _role, ...reference }) => ({ ...reference, contentType: "isolated_product" as const, visibleStructure: [], cues: [] })),
            purposeSuggestions: [],
            rawAnalysis: {},
            normalizationAudit: [],
        };
        const source = await sharp({ create: { width: 64, height: 48, channels: 3, background: "white" } })
            .png()
            .toBuffer();
        const checkpoint = referenceSourcesLoaded(createEcommerceReferenceCheckpoint(run, planningInput, [product]), [{ assetId: product.id, contentSha256: createHash("sha256").update(source).digest("hex"), sourceSize: { width: 64, height: 48 } }]);
        checkpoint.state = action === "confirm_purposes" ? "consumed" : "resolved";
        checkpoint.analysis = analysis;
        checkpoint.decision = resolveEcommerceReferenceDecision({ planningInput, analysis });
        checkpoint.confirmedBindings = [{ assetId: product.id, alias: "图片1", purposes: ["edit_target", "product_identity"] }];
        checkpoint.analysisStage = { requestId: "accepted-original-analysis-stage", state: "completed" };
        if (action !== "initial") checkpoint.consumption = { id: "consumption-one", action, acceptedAt: 1, actorId: run.userId };
        const acceptedRoute = { ...analysis.modelRole, capability: "text" as const, apiFormat: "gemini" as const };
        checkpoint.route = acceptedRoute;
        mocks.run = {
            ...run,
            ...(action === "confirm_purposes" ? {} : { status: "running" as const, executionId: "exited-worker" }),
            ecommerceSnapshot: {
                version: "ecommerce-generation.v1",
                mode: "active",
                runId: run.id,
                userId: run.userId,
                input: { userRequest: run.prompt, conversationId: run.conversationId, surface: "chat", assetIds: [product.id] },
                referenceCheckpoint: checkpoint,
                createdAt: 1,
            },
        };
        mocks.getCreativeAssetsByIds.mockResolvedValue([product]);
        mocks.getCreativeConversationContext.mockResolvedValue({ summary: "new context must not replace frozen summary", summaryThroughSequence: 0, recentMessages: [] });
        mocks.getAuthSettings.mockResolvedValue(ecommerceSettings());
        mocks.analyzeEcommerceReferences.mockResolvedValue(analysis);
        mocks.planEcommerceEdit.mockRejectedValue(new Error("stop after observing planning input"));
        mocks.fetchInternalApi.mockImplementation(async () => new Response(source, { headers: { "content-type": "image/png" } }));
        await executeAndReview(mocks.run!, "http://localhost", "session=test");
        expect(mocks.analyzeEcommerceReferences).not.toHaveBeenCalled();
        expect(mocks.getCreativeConversationContext).not.toHaveBeenCalled();
        expect(mocks.selectCurrentSceneBaseline).not.toHaveBeenCalled();
        expect(mocks.planEcommerceEdit).toHaveBeenCalledWith(expect.objectContaining({ planningInput: expect.objectContaining({ conversationContext: { summary: "frozen summary", recentMessages: [] } }) }), analysis, expect.any(Array));
        expect(mocks.run?.ecommerceSnapshot?.referenceCheckpoint?.analysisStage.requestId).toBe("accepted-original-analysis-stage");
        expect(mocks.run?.ecommerceSnapshot?.referenceCheckpoint?.inputId).toBe(checkpoint.inputId);
        expect(mocks.run?.ecommerceSnapshot?.referenceCheckpoint?.history).toEqual(checkpoint.history);
        expect(mocks.run?.ecommerceSnapshot?.referenceCheckpoint?.route).toEqual(acceptedRoute);
        expect(mocks.run?.ecommerceSnapshot?.modelRouteSnapshots?.vision_analysis).toEqual(acceptedRoute);
    });

    it("persists the actionable needs-review state after a purpose ambiguity pause", async () => {
        const fixture = await frozenReferenceFixture("confirm_purposes");
        const auxiliary = { ...fixture.product, id: "lighting-detail", title: "lighting detail", serverUrl: "/api/reference-assets/lighting-detail.png" };
        mocks.run = { ...fixture.run, ecommerceSnapshot: undefined, prompt: "图片1和图片2", referencedAssetIds: [fixture.product.id, auxiliary.id] };
        const first = fixture.analysis.references[0];
        const analysis = {
            ...fixture.analysis,
            references: [
                first,
                {
                    ...first,
                    assetId: auxiliary.id,
                    contentType: "product_detail" as const,
                    confidence: "medium" as const,
                    productFacts: null,
                    productCore: null,
                    fusionHalo: null,
                    visualEvidence: { whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: false },
                    cues: [{ id: "light", facet: "lighting" as const, description: "soft window light", confidence: "high" as const }],
                },
            ],
        };
        mocks.getAuthSettings.mockResolvedValue(ecommerceSettings());
        mocks.getCreativeAssetsByIds.mockResolvedValue([fixture.product, auxiliary]);
        mocks.analyzeEcommerceReferences.mockResolvedValue(analysis);
        await executeAndReview(mocks.run, "http://localhost", "session=test");
        expect(mocks.run).toMatchObject({
            status: "paused",
            tasks: [{ status: "needs_review", attempts: 0 }],
            ecommerceSnapshot: { fallback: { reason: "reference_purpose_confirmation_required" }, referenceCheckpoint: { state: "needs_review", analysisStage: { state: "completed" } } },
        });
        expect(mocks.planEcommerceEdit).not.toHaveBeenCalled();
    });

    it.each(["confirm_purposes", "retry_analysis"] as const)("rejects original-byte replacement after the %s recovery commit without another planning or image POST", async (action) => {
        const fixture = await frozenReferenceFixture(action);
        mocks.run = fixture.run;
        const frozen = structuredClone(fixture.run.ecommerceSnapshot!.referenceCheckpoint!);
        const replacement = await sharp({ create: { width: 64, height: 48, channels: 3, background: "blue" } })
            .png()
            .toBuffer();
        mocks.getAuthSettings.mockResolvedValue(ecommerceSettings());
        mocks.fetchInternalApi.mockImplementation(async () => new Response(replacement, { headers: { "content-type": "image/png" } }));
        mocks.analyzeEcommerceReferences.mockImplementation(async (input) => {
            await input.onSourcesLoaded([{ assetId: fixture.product.id, contentSha256: createHash("sha256").update(replacement).digest("hex"), sourceSize: { width: 64, height: 48 } }]);
            return fixture.analysis;
        });
        mocks.planEcommerceEdit.mockRejectedValue(new Error("must not reach planner with replaced input"));
        await executeAndReview(mocks.run, "http://localhost", "session=test");
        expect(mocks.run).toMatchObject({
            status: "paused",
            ecommerceSnapshot: { fallback: { reason: "reference_source_changed" }, referenceCheckpoint: { state: "needs_review", inputId: frozen.inputId, analysisStage: { requestId: frozen.analysisStage.requestId } } },
        });
        expect(mocks.run?.ecommerceSnapshot?.referenceCheckpoint?.assets).toEqual(frozen.assets);
        expect(mocks.planEcommerceEdit).not.toHaveBeenCalled();
        if (action === "confirm_purposes") expect(mocks.analyzeEcommerceReferences).not.toHaveBeenCalled();
        expect(mocks.fetchInternalApi.mock.calls.some(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"))).toBe(false);
    });

    it("records the actual route of a new analysis instead of an incomplete stage's stale route", async () => {
        const product = { ...creativeImageAsset("asset-product", "product.png", "upload"), type: "image" as const, status: "ready" as const, serverUrl: "/api/reference-assets/product.png" };
        const run = runFixture({ surface: "chat", projectId: undefined, prompt: "修改图片1", referencedAssetIds: [product.id], generationPreferences: { mode: "image" } });
        const planningInput = buildEcommercePlanningInput(run, [product], { summary: "frozen summary", recentMessages: [] });
        const legacy = ecommerceAnalysis("product");
        const analysis = {
            ...legacy,
            analysisVersion: "ecommerce-visual-analysis.v4" as const,
            references: legacy.references.map(({ role: _role, ...reference }) => ({ ...reference, contentType: "isolated_product" as const, visibleStructure: [], cues: [] })),
            purposeSuggestions: [],
            rawAnalysis: {},
            normalizationAudit: [],
        };
        const checkpoint = createEcommerceReferenceCheckpoint(run, planningInput, [product]);
        checkpoint.route = { ...analysis.modelRole, capability: "text", apiFormat: "gemini", channelId: "previous-analysis-channel" };
        mocks.run = {
            ...run,
            ecommerceSnapshot: {
                version: "ecommerce-generation.v1",
                mode: "active",
                runId: run.id,
                userId: run.userId,
                input: { userRequest: run.prompt, conversationId: run.conversationId, surface: "chat", assetIds: [product.id] },
                referenceCheckpoint: checkpoint,
                createdAt: 1,
            },
        };
        mocks.getAuthSettings.mockResolvedValue(ecommerceSettings());
        mocks.analyzeEcommerceReferences.mockResolvedValue(analysis);
        mocks.planEcommerceEdit.mockRejectedValue(new Error("stop after observing actual route"));
        const source = await sharp({ create: { width: 64, height: 48, channels: 3, background: "white" } })
            .png()
            .toBuffer();
        mocks.fetchInternalApi.mockImplementation(async () => new Response(source, { headers: { "content-type": "image/png" } }));
        await executeAndReview(mocks.run, "http://localhost", "session=test");
        expect(mocks.analyzeEcommerceReferences).toHaveBeenCalledOnce();
        const actualRoute = { ...analysis.modelRole, capability: "text", apiFormat: "openai" };
        expect(mocks.run?.ecommerceSnapshot?.referenceCheckpoint?.route).toEqual(actualRoute);
        expect(mocks.run?.ecommerceSnapshot?.modelRouteSnapshots?.vision_analysis).toEqual(actualRoute);
        expect(mocks.run?.ecommerceSnapshot?.referenceCheckpoint?.analysisStage).toEqual({ requestId: checkpoint.analysisStage.requestId, state: "completed" });
    });

    it.each([
        ["只加柜面花瓶，不改变机位和光照", "local"],
        ["只加柜面花瓶，保持整体光照不变", "local"],
        ["只加柜面花瓶，保持全图机位和构图不变", "local"],
        ["只加柜面花瓶，不要对整体光照做任何改变", "local"],
        ["只加柜面花瓶，禁止对全图机位和构图做任何调整", "local"],
        ...["同时", "并且", "而且"].flatMap((connector) => ["把", "将"].flatMap((marker) => ["", "，这两项调整都禁止"].map((prohibition) => [`只加柜面花瓶，不要改变光照${connector}${marker}机位调整成俯视${prohibition}`, "local"]))),
        ["把灯光改成暖色", "global"],
        ["不要对全图机位做任何改变，把灯光改成暖色", "global"],
        ["把灯光改成暖色，不要对全图机位做任何改变", "global"],
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
    ])("keeps protection scope through the actual planner normalizer: %s (%s)", async (prompt, scope) => {
        vi.stubEnv("ECOMMERCE_GENERATION_ROLLOUT", "internal");
        const source = await sharp({ create: { width: 6, height: 4, channels: 3, background: "blue" } })
            .png()
            .toBuffer();
        const scene = { ...creativeImageAsset("asset-scene", "scene.png", ""), sourceRunId: "upload", serverUrl: "/api/reference-assets/scene.png" };
        const plan = {
            ...ecommerceScenePlan(),
            planVersion: "ecommerce-edit.v3" as const,
            protection: { scope: "local" as const, protectedObjectIds: ["cabinet", "background"], preserveOutsideMask: true, allowLightingChange: false },
            delta: { requestedChanges: ["add vase"], targetObjects: ["vase"], targetRegions: ["cabinet top"], manualRegion: { x: 0, y: 0, width: 1, height: 1 } },
        };
        mocks.run = runFixture({ surface: "chat", projectId: undefined, prompt, referencedAssetIds: [scene.id] });
        mocks.getCreativeAssetsByIds.mockResolvedValue([scene]);
        mocks.getAuthSettings.mockResolvedValue(ecommerceSettings());
        mocks.analyzeEcommerceReferences.mockResolvedValue(ecommerceSceneAnalysis());
        const planner = await vi.importActual<typeof import("./ecommerce-edit-planner")>("./ecommerce-edit-planner");
        mocks.planEcommerceEdit.mockImplementation(async (input) => ({
            plan: planner.normalizePlannedEdit({ ...plan, modelRoles: { ...plan.modelRoles, visionAnalysis: "planner" } }, input, ecommerceSceneAnalysis(), "planner"),
            modelRole: { logicalRole: "edit_planning", logicalModelId: "planner", channelId: "planner-channel", upstreamModel: "vendor/planner" },
        }));
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/api/reference-assets/scene.png")) return new Response(source, { headers: { "content-type": "image/png" } });
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-confirmed-scene" } });
            if (url.endsWith("/api/image-tasks/child-confirmed-scene")) return Response.json({ task: { status: "success", result: { url: "/api/generation-log-assets/result.png" } } });
            throw new Error("unexpected fixture request: " + url);
        });
        await executeAndReview(mocks.run, "http://localhost", "session=test");
        if (scope === "global") {
            expect(mocks.run).toMatchObject({ status: "completed", tasks: [{ attempts: 1 }], ecommerceSnapshot: { plan: { protection: { scope: "global", preserveOutsideMask: false, allowLightingChange: true } } } });
            const submitted = mocks.fetchInternalApi.mock.calls.filter(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"));
            expect(submitted).toHaveLength(1);
            const body = JSON.parse(String(submitted[0][1]?.body));
            expect(body.ecommerceExecution.mask).toBeUndefined();
            expect(body.sceneProtection).toBeUndefined();
            expect(body.ecommerceExecution.prompt).toContain("不承诺选区外像素");
            expect(mocks.run?.ecommerceSnapshot?.fallback).toBeUndefined();
            return;
        }
        expect(mocks.run).toMatchObject({
            status: "paused",
            tasks: [{ status: "needs_review", attempts: 0, ecommerceExecution: { mask: { mode: "independent", required: true } } }],
            ecommerceSnapshot: { fallback: { reason: "scene_selection_required" }, plan: { protection: plan.protection, canvas: { mode: "exact", size: { width: 6, height: 4 } } }, visualAnalysis: ecommerceSceneAnalysis() },
        });
        expect(mocks.fetchInternalApi.mock.calls.filter(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"))).toHaveLength(0);
        const snapshot = structuredClone(mocks.run!.ecommerceSnapshot);
        mocks.run = { ...mocks.run!, status: "running" };
        await executeAndReview(mocks.run, "http://localhost", "session=test");
        expect(mocks.run!.status).toBe("paused");
        expect(mocks.run!.ecommerceSnapshot).toEqual(snapshot);
        const tasks = await prepareEcommerceSceneSelectionResume(mocks.run!, { baselineAssetId: scene.id, region: { x: 2, y: 1, width: 2, height: 2 } }, "http://localhost", "session=test", "user");
        mocks.run = { ...mocks.run!, status: "running", tasks };
        await executeAndReview(mocks.run, "http://localhost", "session=test");
        const submitted = mocks.fetchInternalApi.mock.calls.filter(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"));
        expect(submitted).toHaveLength(1);
        const body = JSON.parse(String(submitted[0][1]?.body));
        expect(body.ecommerceExecution).toEqual(tasks[0].ecommerceExecution);
        expect(body.sceneProtection).toEqual(tasks[0].sceneProtection);
        expect(body.sceneProtection).toMatchObject({ selectionSource: "user_selection", targetRegion: { x: 2, y: 1, width: 2, height: 2 } });
        expect(body.ecommerceExecution.mask).toEqual({ mode: "independent", required: true });
        const native = await sharp({ create: { width: 6, height: 4, channels: 3, background: "red" } })
            .png()
            .toBuffer();
        const { compositeSceneEdit } = await import("./ecommerce-product-regions");
        expect((await compositeSceneEdit(source, native, body.sceneProtection)).evidence).toMatchObject({ nativeOutsideChangedPixels: 20, compositeOutsideChangedPixels: 0 });
        expect(body.references).toEqual([expect.objectContaining({ id: scene.id, ecommerceRole: "scene" })]);
        expect(mocks.analyzeEcommerceReferences).toHaveBeenCalledOnce();
        expect(mocks.planEcommerceEdit).toHaveBeenCalledOnce();
        expect(mocks.run?.status).toBe("completed");
    });

    it.each(["audio", "video", "text"] as const)("keeps an explicit %s attachment in the generic planner despite an existing scene", async (type) => {
        const attachment = { ...creativeImageAsset(`${type}-current`, `${type} attachment`, ""), type, sourceRunId: "upload", serverUrl: `/api/reference-assets/${type}-current` };
        mocks.run = runFixture({ surface: "chat", projectId: undefined, prompt: "处理这份附件", referencedAssetIds: [attachment.id] });
        mocks.getAuthSettings.mockResolvedValue(ecommerceSettings());
        mocks.getCreativeAssetsByIds.mockResolvedValue([attachment]);
        mocks.selectCurrentSceneBaseline.mockResolvedValue({
            ...creativeImageAsset("prior-scene", "prior scene", ""),
            sourceRunId: "prior-run",
            metadata: { ecommerceContinuity: { productAnchorId: null, sceneRootAssetId: "prior-root" } },
        });
        mocks.fetchInternalApi.mockImplementation(async () => Response.json({ output: [{ type: "function_call", name: "create_agent_plan", arguments: JSON.stringify(conversationPlan("image-model", "附件已处理")) }] }));

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(mocks.selectCurrentSceneBaseline).not.toHaveBeenCalled();
        expect(mocks.analyzeEcommerceReferences).not.toHaveBeenCalled();
        expect(mocks.run).toMatchObject({ status: "completed" });
        expect(mocks.run?.ecommerceSnapshot).toBeUndefined();
        const planningCall = mocks.fetchInternalApi.mock.calls.find(([url]) => String(url).endsWith("/chat/completions"));
        const body = JSON.parse(String(planningCall?.[1]?.body));
        expect(JSON.parse(body.messages[1].content)).toMatchObject({ referencedAssets: [{ id: attachment.id, type }] });
    });

    it("continues a scene-only image chain even when a media planner would classify a short reply as conversation", async () => {
        const sceneBytes = await sharp({ create: { width: 100, height: 80, channels: 3, background: "#ddd" } })
            .png()
            .toBuffer();
        const root = { ...creativeImageAsset("scene-root", "root.png", ""), sourceRunId: "upload", serverUrl: "/api/reference-assets/root.png" };
        const history = {
            ...creativeImageAsset("asset-scene", "scene.png", ""),
            sourceRunId: "scene-run",
            parentAssetId: root.id,
            serverUrl: "/api/reference-assets/scene.png",
            metadata: { ecommerceContinuity: { productAnchorId: null, sceneRootAssetId: root.id, branchId: "prior-branch", parentResultId: null } },
        };
        mocks.run = runFixture({ surface: "chat", projectId: undefined, prompt: "再加一个花瓶" });
        mocks.getAuthSettings.mockResolvedValue(ecommerceSettings());
        mocks.selectCurrentSceneBaseline.mockResolvedValue(history);
        mocks.getCreativeAssetsByIds.mockImplementation(async (ids = []) => (ids.includes(root.id) ? [root] : []));
        mocks.analyzeEcommerceReferences.mockResolvedValue(ecommerceSceneAnalysis());
        mocks.planEcommerceEdit.mockResolvedValue({
            plan: { ...ecommerceScenePlan(), continuity: { parentResultId: history.id, branchId: "ecommerce-agent-run" } },
            modelRole: { logicalRole: "edit_planning", logicalModelId: "planner", channelId: "planner-channel", upstreamModel: "vendor/planner" },
        });
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/api/reference-assets/scene.png")) return new Response(sceneBytes, { headers: { "content-type": "image/png" } });
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-scene-continuation" } });
            if (url.endsWith("/api/image-tasks/child-scene-continuation")) return Response.json({ task: { status: "success", result: { url: "/api/generation-log-assets/result.png" } } });
            return Response.json({ output: [{ type: "function_call", name: "create_agent_plan", arguments: JSON.stringify(conversationPlan("image-model", "好的")) }] });
        });
        await executeAndReview(mocks.run, "http://localhost", "session=test");
        expect(mocks.run).toMatchObject({ status: "completed", ecommerceSnapshot: { continuity: { sceneRootAssetId: root.id, parentResultId: history.id }, plan: { operation: "scene_edit" }, qualityCheck: { status: "passed" } } });
        expect(mocks.analyzeEcommerceReferences).toHaveBeenCalledOnce();
        expect(mocks.fetchInternalApi.mock.calls.filter(([url]) => String(url).includes("/api/ai/system/"))).toHaveLength(0);
    });
    it.each([
        { label: "valid v4 independent observations", validQualityResponse: true },
        { label: "invalid legacy QA response", validQualityResponse: false },
    ])("blocks a native canvas mismatch before optional visual QA ($label)", async ({ validQualityResponse }) => {
        const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const observation = { readable: true, logo: "absent", packagingText: "absent", visibleStructure: [{ objectId: "fixture-furniture", feature: "drawers", count: 0, certainty: "confirmed", evidenceRegion: { x: 0, y: 0, width: 384, height: 216 } }] };
        vi.stubEnv("ECOMMERCE_GENERATION_ROLLOUT", "internal");
        const original = await sharp({ create: { width: 384, height: 216, channels: 3, background: "#aaa" } })
            .png()
            .toBuffer();
        const square = await sharp({ create: { width: 288, height: 288, channels: 3, background: "#bbb" } })
            .png()
            .toBuffer();
        mocks.run = runFixture({ surface: "chat", projectId: undefined, prompt: "冬日阳光，保持原尺寸", referencedAssetIds: ["asset-scene"], generationPreferences: { mode: "image", image: { size: "3:2" } } });
        mocks.getCreativeAssetsByIds.mockResolvedValue([{ ...creativeImageAsset("asset-scene", "scene.png", ""), serverUrl: "/api/reference-assets/scene.png", sourceRunId: "upload" }]);
        mocks.getAuthSettings.mockResolvedValue(ecommerceSettings());
        mocks.analyzeEcommerceReferences.mockResolvedValue(ecommerceSceneAnalysis());
        mocks.planEcommerceEdit.mockResolvedValue({
            plan: { ...ecommerceScenePlan(), protection: { scope: "global", protectedObjectIds: ["fixture-furniture"], preserveOutsideMask: false, allowLightingChange: true } },
            modelRole: { logicalRole: "edit_planning", logicalModelId: "planner", channelId: "planner-channel", upstreamModel: "vendor/planner" },
        });
        const media = [1, 2].map((index) => ({
            dataUrl: `/api/generation-log-assets/stored-${index}.png`,
            serverUrl: `/api/generation-log-assets/stored-${index}.png`,
            remoteUrl: "https://provider.fixture/shared-result.png",
            width: 999,
            height: 999,
            canvasEvidence: {
                constraint: { mode: "exact" as const, size: { width: 384, height: 216 }, source: "user_text" as const, allowReframe: false },
                requestedSize: { width: 384, height: 216 },
                nativeSize: { width: 384, height: 216 },
                storedSize: { width: 384, height: 216 },
                nativeUrl: `/api/generation-log-assets/native-${index}.png`,
                normalization: "none" as const,
            },
        }));
        mocks.getImageTask.mockResolvedValue({ id: "child-canvas", userId: "user", result: { ...media[0], results: media } } as ImageTask);
        const quality = await vi.importActual<typeof import("./ecommerce-quality-check")>("./ecommerce-quality-check");
        mocks.checkEcommerceResult.mockImplementation(quality.checkEcommerceResultWithFallback);
        mocks.checkEcommerceTechnicalResult.mockImplementation(quality.checkEcommerceTechnicalResult);
        mocks.fetchSafeOutbound.mockRejectedValue(new Error("fixture forbids remote media reads"));
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/api/reference-assets/scene.png") || /\/stored-[12]\.png$/.test(url) || url.endsWith("/native-2.png")) return new Response(original, { headers: { "content-type": "image/png" } });
            if (url.endsWith("/native-1.png")) return new Response(square, { headers: { "content-type": "image/png" } });
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-canvas" } });
            if (url.endsWith("/api/image-tasks/child-canvas"))
                return Response.json({
                    task: {
                        status: "success",
                        result: {
                            ...media[0],
                            results: media.map(({ canvasEvidence, ...publicMedia }) => {
                                void canvasEvidence;
                                return publicMedia;
                            }),
                        },
                    },
                });
            if (url.includes("/api/ai/system/"))
                return Response.json({
                    output: [
                        {
                            type: "function_call",
                            name: "check_ecommerce_results",
                            arguments: JSON.stringify({
                                ...(validQualityResponse ? { baselineObservation: observation } : {}),
                                results: [1, 2].map((index) => ({
                                    resultId: `child-canvas:${index}`,
                                    ...(validQualityResponse ? { observation } : {}),
                                    checks: (validQualityResponse ? quality.ECOMMERCE_QUALITY_CHECK_KEYS : quality.ECOMMERCE_QUALITY_CHECK_KEYS.slice(0, 8)).map((key) => ({ key, status: "passed", reason: "fixture visual checks passed" })),
                                })),
                            }),
                        },
                    ],
                });
            throw new Error("unexpected fixture request: " + url);
        });
        await executeAndReview(mocks.run, "http://localhost", "session=test");
        expect(mocks.run?.status).toBe("paused");
        expect(mocks.registerCreativeAssets).not.toHaveBeenCalled();
        expect(mocks.run?.ecommerceSnapshot?.technicalCheck).toMatchObject({
            status: "blocked",
            hardFailures: [{ resultId: "child-canvas:1", key: "canvas_geometry" }],
            canvasEvidence: [
                { resultId: "child-canvas:1", nativeSize: { width: 288, height: 288 }, storedSize: { width: 384, height: 216 }, nativeMatches: false, storedMatches: true },
                { resultId: "child-canvas:2", nativeMatches: true, storedMatches: true },
            ],
        });
        expect(mocks.fetchSafeOutbound).not.toHaveBeenCalled();
        expect(mocks.fetchInternalApi.mock.calls.filter(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"))).toHaveLength(1);
        expect(mocks.checkEcommerceResult).not.toHaveBeenCalled();
        expect(mocks.run?.ecommerceSnapshot?.qualityCheck).toBeUndefined();
        expect(diagnostic).not.toHaveBeenCalled();
        diagnostic.mockRestore();
    });
    it.each([true, false])("resolves preserve-original from actual baseline bytes or pauses before submission (decode=%s)", async (decode) => {
        vi.stubEnv("ECOMMERCE_GENERATION_ROLLOUT", "internal");
        const sceneBytes = await sharp({ create: { width: 384, height: 216, channels: 3, background: "#aaa" } })
            .png()
            .toBuffer();
        mocks.run = runFixture({ surface: "chat", projectId: undefined, prompt: "改成冬日阳光，保持原尺寸", referencedAssetIds: ["asset-scene"], generationPreferences: { mode: "image", image: { size: "3000x2000" } } });
        mocks.getCreativeAssetsByIds.mockResolvedValue([{ ...creativeImageAsset("asset-scene", "scene.png", ""), serverUrl: "/api/reference-assets/scene.png", width: 900, height: 900, sourceRunId: "upload" }]);
        mocks.getAuthSettings.mockResolvedValue(ecommerceSettings());
        mocks.analyzeEcommerceReferences.mockResolvedValue(ecommerceSceneAnalysis());
        mocks.planEcommerceEdit.mockResolvedValue({ plan: ecommerceScenePlan(), modelRole: { logicalRole: "edit_planning", logicalModelId: "planner", channelId: "planner-channel", upstreamModel: "vendor/planner" } });
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/api/reference-assets/scene.png")) return new Response(decode ? sceneBytes : Buffer.from("invalid"), { headers: { "content-type": "image/png" } });
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-preserve" } });
            if (url.endsWith("/api/image-tasks/child-preserve")) return Response.json({ task: { status: "success", result: { url: "/api/generation-log-assets/stored.png" } } });
            throw new Error("unexpected request: " + url);
        });
        await executeAndReview(mocks.run, "http://localhost", "session=test");
        const submitted = mocks.fetchInternalApi.mock.calls.find(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"));
        if (!decode) {
            expect(submitted).toBeUndefined();
            expect(mocks.run?.status).toBe("paused");
            expect(mocks.run?.tasks[0].error).toContain("尺寸");
        } else {
            expect(submitted).toBeDefined();
            const body = JSON.parse(String(submitted?.[1]?.body));
            expect(body.config.size).toBe("384x216");
            expect(body.ecommerceExecution.canvas).toMatchObject({ source: "user_text", mode: "exact", size: { width: 384, height: 216 } });
            expect(mocks.run?.ecommerceSnapshot?.plan?.canvas).toEqual(body.ecommerceExecution.canvas);
            expect(mocks.planEcommerceEdit).toHaveBeenCalledWith(expect.objectContaining({ canvasInput: expect.objectContaining({ baselineSize: { width: 384, height: 216 } }) }), expect.anything(), expect.anything());
        }
    });
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv("ECOMMERCE_GENERATION_ROLLOUT", "off");
        resetTextPlanningRuntime();
        mocks.events = [];
        mocks.getCreativeAssetsByIds.mockResolvedValue([]);
        mocks.listRecentCreativeMediaAssets.mockResolvedValue([]);
        mocks.analyzeEcommerceReferences.mockReset();
        mocks.planEcommerceEdit.mockReset();
        mocks.selectCurrentSceneBaseline.mockReset().mockResolvedValue(null);
        mocks.createEditBranch.mockReset().mockImplementation(async (parentResultId: string, run: AgentRun) => ({ parentResultId, branchId: `ecommerce-${run.id}` }));
        mocks.checkEcommerceResult.mockReset().mockResolvedValue(passedQualityCheck());
        mocks.checkEcommerceTechnicalResult.mockReset().mockResolvedValue({ version: "ecommerce-technical.v1", status: "passed", checks: [], hardFailures: [], canvasEvidence: [], sceneProtectionEvidence: [], checkedAt: 1 });
        mocks.scheduleGenerationTask.mockReset().mockResolvedValue(undefined);
        mocks.updateImageTask.mockReset().mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ id, ...patch }));
        mocks.getImageTask.mockReset().mockResolvedValue(null);
        mocks.getStoredGenerationTaskRecord.mockReset().mockResolvedValue({ executionPhase: "needs_review" });
        mocks.fetchSafeOutbound.mockReset().mockRejectedValue(new Error("fixture forbids remote reads"));
        mocks.getCreativeConversationContext.mockResolvedValue({ summary: "", summaryThroughSequence: 0, recentMessages: [] });
        mocks.reviewCreativeOutputs.mockResolvedValue({ mode: "visual", status: "passed", summary: "检查通过", issues: [], retryTaskIds: [] });
        mocks.registerCreativeAssets.mockImplementation(async (inputs: Array<Record<string, unknown>>) => inputs.map((input, index) => ({ ...input, id: `asset-${index}`, status: "ready", createdAt: 1, updatedAt: 1 })));
        mocks.updateAgentRunById.mockImplementation(async (_id, patch, event, allowedStatuses, expectedExecutionId, expectedTasks, expectedReview) => {
            if (!mocks.run || (allowedStatuses && !allowedStatuses.includes(mocks.run.status)) || (expectedExecutionId && mocks.run.executionId !== expectedExecutionId)) return null;
            if (expectedTasks && JSON.stringify(mocks.run.tasks) !== JSON.stringify(expectedTasks)) return null;
            if (expectedReview && ((mocks.run.reviewAttempts || 0) !== expectedReview.attempts || Boolean(mocks.run.reviewed) !== expectedReview.reviewed)) return null;
            mocks.run = {
                ...mocks.run,
                ...patch,
            };
            if (event) mocks.events.push(event);
            return mocks.run;
        });
        mocks.updateAgentRunTaskById.mockImplementation(async (_id, taskId, patch, eventType, expectedExecutionId) => {
            if (!mocks.run || mocks.run.status !== "running" || mocks.run.executionId !== expectedExecutionId) return null;
            const tasks = mocks.run.tasks.map((task) => {
                if (task.id !== taskId) return task;
                const children = new Map((task.childTasks || []).map((child) => [child.id, child]));
                for (const child of patch.childTasks || []) children.set(child.id, child);
                return {
                    ...task,
                    ...patch,
                    ...(patch.childTasks ? { childTasks: Array.from(children.values()) } : {}),
                    ...(patch.taskIds ? { taskIds: Array.from(new Set([...(task.taskIds || []), ...patch.taskIds])) } : {}),
                    ...(patch.assetIds ? { assetIds: Array.from(new Set([...(task.assetIds || []), ...patch.assetIds])) } : {}),
                };
            });
            const taskIndex = tasks.findIndex((item) => item.id === taskId);
            const task = tasks[taskIndex];
            mocks.run = { ...mocks.run, tasks, assetIds: Array.from(new Set([...mocks.run.assetIds, ...(task?.assetIds || [])])) };
            const output = task && mocks.run.surface === "canvas" && eventType === "task.completed" ? taskResultOps(mocks.run.id, taskIndex, task) : undefined;
            mocks.events.push({
                type: eventType,
                data: task ? { taskId, title: task.title, type: task.type, status: task.status, attempts: task.attempts, error: task.error, message: eventType === "task.completed" ? "任务已完成" : undefined, ops: output?.ops } : { taskId },
            });
            return mocks.run;
        });
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (init?.method === "POST") return Response.json({ task: { id: `child-${mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST").length}` } });
            if (url.includes("/api/image-tasks/")) return Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/output.png" } } });
            throw new Error(`unexpected request: ${url}`);
        });
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it("records an ecommerce shadow snapshot without changing the legacy planner request", async () => {
        vi.stubEnv("ECOMMERCE_GENERATION_ROLLOUT", "shadow");
        mocks.run = runFixture({ surface: "chat", projectId: undefined, prompt: "把白底台灯放到明亮客厅", referencedAssetIds: ["asset-product"] });
        mocks.getCreativeAssetsByIds.mockResolvedValue([creativeImageAsset("asset-product", "白底台灯", "https://cdn.example.com/product.png")]);
        mocks.getAuthSettings.mockResolvedValue({ ...(canvasSettings("image-default", "image-default-channel") as unknown as Record<string, unknown>), ecommerceGenerationEnabled: false } as never);
        mocks.fetchInternalApi.mockImplementation(async (url: string) => {
            if (url.endsWith("/chat/completions")) return Response.json({ output: [{ type: "function_call", name: "create_agent_plan", arguments: JSON.stringify(conversationPlan("image-default", "已按原流程处理。")) }] });
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(mocks.run?.ecommerceSnapshot).toMatchObject({ mode: "shadow", input: { userRequest: "把白底台灯放到明亮客厅", assetIds: ["asset-product"] }, fallback: { reason: "ecommerce_planner_disabled" } });
        expect(mocks.analyzeEcommerceReferences).not.toHaveBeenCalled();
        expect(mocks.checkEcommerceResult).not.toHaveBeenCalled();
        const plannerBody = JSON.parse(String(mocks.fetchInternalApi.mock.calls.find(([url]) => url.endsWith("/chat/completions"))?.[1]?.body)) as { messages: Array<{ content: string }> };
        expect(JSON.parse(plannerBody.messages[1].content)).toMatchObject({ requirement: "把白底台灯放到明亮客厅" });
        expect(mocks.run?.tasks).toEqual([]);
    });

    it.each(["internal", "enabled"])("keeps ecommerce orchestration disabled when the administrator switch is off and rollout is %s", async (rollout) => {
        vi.stubEnv("ECOMMERCE_GENERATION_ROLLOUT", rollout);
        mocks.run = runFixture({ surface: "chat", projectId: undefined, prompt: "把白底台灯放到明亮客厅", referencedAssetIds: ["asset-product"] });
        mocks.getCreativeAssetsByIds.mockResolvedValue([creativeImageAsset("asset-product", "白底台灯", "https://cdn.example.com/product.png")]);
        mocks.getAuthSettings.mockResolvedValue({ ...(canvasSettings("image-default", "image-default-channel") as unknown as Record<string, unknown>), ecommerceGenerationEnabled: false } as never);
        mocks.fetchInternalApi.mockImplementation(async (url: string) => {
            if (url.endsWith("/chat/completions")) return Response.json({ output: [{ type: "function_call", name: "create_agent_plan", arguments: JSON.stringify(conversationPlan("image-default", "已按普通图片流程处理。")) }] });
            throw new Error("unexpected request: " + url);
        });

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(mocks.analyzeEcommerceReferences).not.toHaveBeenCalled();
        expect(mocks.run?.ecommerceSnapshot).toBeUndefined();
        expect(mocks.planEcommerceEdit).not.toHaveBeenCalled();
        expect(mocks.fetchInternalApi.mock.calls.some(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"))).toBe(false);
    });

    it("pauses for review when every visual-analysis candidate fails", async () => {
        vi.stubEnv("ECOMMERCE_GENERATION_ROLLOUT", "internal");
        mocks.run = runFixture({
            surface: "chat",
            projectId: undefined,
            prompt: "生成简约家具图",
            referencedAssetIds: ["asset-product"],
            generationPreferences: { mode: "image", image: { count: 1 } },
        });
        mocks.getCreativeAssetsByIds.mockResolvedValue([creativeImageAsset("asset-product", "product.png", "upload")]);
        mocks.getAuthSettings.mockResolvedValue(ecommerceSettings());
        const vision = await vi.importActual<typeof import("./ecommerce-visual-analysis")>("./ecommerce-visual-analysis");
        const failure = {
            analysisVersion: "ecommerce-visual-analysis.v4" as const,
            kind: "service_unavailable" as const,
            attempts: [{ modelRole: { logicalRole: "vision_analysis" as const, logicalModelId: "planner", channelId: "planner-channel", upstreamModel: "vendor/planner" }, kind: "service_unavailable" as const, status: 503, elapsedMs: 10 }],
        };
        mocks.analyzeEcommerceReferences.mockRejectedValue(new vision.EcommerceVisualAnalysisError("all vision candidates failed", 503, failure));

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(mocks.run).toMatchObject({
            status: "paused",
            tasks: [{ status: "needs_review", error: "无法可靠分析参考图，任务已暂停等待复核。" }],
            ecommerceSnapshot: { visualAnalysisFailure: failure, input: { referenceAliases: [{ assetId: "asset-product", alias: "图片1" }] }, fallback: { reason: "visual_analysis_unavailable" } },
        });
        expect(mocks.run).not.toHaveProperty("failure");
        expect(mocks.analyzeEcommerceReferences).toHaveBeenCalledOnce();
        expect(mocks.analyzeEcommerceReferences.mock.calls[0][0]).toMatchObject({ analysisVersion: "ecommerce-visual-analysis.v4" });
        expect(mocks.planEcommerceEdit).not.toHaveBeenCalled();
        expect(mocks.fetchInternalApi.mock.calls.some(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"))).toBe(false);
    });

    it("retains the accepted v4 analysis and actual route when the next planner fails", async () => {
        const source = await sharp({ create: { width: 64, height: 48, channels: 4, background: "white" } })
            .png()
            .toBuffer();
        const product = { ...creativeImageAsset("asset-product", "product.png", "upload"), serverUrl: "/api/reference-assets/product.png", width: 64, height: 48 };
        mocks.run = runFixture({ surface: "chat", projectId: undefined, prompt: "修改图片1", referencedAssetIds: [product.id], generationPreferences: { mode: "image" } });
        mocks.getCreativeAssetsByIds.mockResolvedValue([product]);
        mocks.getAuthSettings.mockResolvedValue(ecommerceSettings());
        const legacy = ecommerceAnalysis("product");
        const analysis = {
            ...legacy,
            analysisVersion: "ecommerce-visual-analysis.v4" as const,
            references: legacy.references.map(({ role: _role, ...reference }) => ({ ...reference, contentType: "isolated_product" as const, visibleStructure: [], cues: [] })),
            purposeSuggestions: [],
            rawAnalysis: {},
            normalizationAudit: [],
        };
        mocks.analyzeEcommerceReferences.mockResolvedValue(analysis);
        mocks.planEcommerceEdit.mockRejectedValue(new Error("planner fixture failed"));
        mocks.fetchInternalApi.mockImplementation(async () => new Response(source, { headers: { "content-type": "image/png" } }));
        await executeAndReview(mocks.run, "http://localhost", "session=test");
        expect(mocks.run).toMatchObject({
            status: "failed",
            ecommerceSnapshot: {
                visualAnalysis: analysis,
                input: { referenceAliases: [{ assetId: product.id, alias: "图片1" }] },
                referenceDecision: { state: "resolved", editTargetId: product.id },
                modelRouteSnapshots: { vision_analysis: { channelId: "planner-channel" } },
                stageTimings: { analysisCompletedAt: expect.any(Number) },
            },
        });
        expect(mocks.planEcommerceEdit).toHaveBeenCalledOnce();
        expect(mocks.fetchInternalApi.mock.calls.some(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"))).toBe(false);
    });

    it.each(["off", "internal", "enabled"])("executes the administrator-enabled product-to-scene slice when rollout is %s", async (rollout) => {
        vi.stubEnv("ECOMMERCE_GENERATION_ROLLOUT", rollout);
        const source = await sharp({ create: { width: 64, height: 48, channels: 4, background: "#ffffff" } })
            .composite([{ input: { create: { width: 20, height: 28, channels: 4, background: "#252525" } }, left: 22, top: 10 }])
            .png()
            .toBuffer();
        mocks.run = runFixture({
            surface: "chat",
            projectId: undefined,
            prompt: "生成简约家具图",
            referencedAssetIds: ["asset-product"],
            generationPreferences: { mode: "image", image: { size: "4:3", quality: "high", count: 1 } },
        });
        mocks.getCreativeAssetsByIds.mockResolvedValue([
            {
                ...creativeImageAsset("asset-product", "product.png", "upload"),
                remoteUrl: undefined,
                serverUrl: "/api/reference-assets/product.png",
                width: 64,
                height: 48,
            },
        ]);
        mocks.getAuthSettings.mockResolvedValue(ecommerceSettingsWithQualityFallback());
        mocks.analyzeEcommerceReferences.mockResolvedValue(ecommerceAnalysis("product"));
        mocks.planEcommerceEdit.mockResolvedValue({
            plan: ecommercePlan(),
            modelRole: { logicalRole: "edit_planning", logicalModelId: "planner", channelId: "planner-channel", upstreamModel: "vendor/planner" },
        });
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/api/reference-assets/product.png")) return new Response(source, { headers: { "content-type": "image/png" } });
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-ecommerce" } });
            if (url.endsWith("/api/image-tasks/child-ecommerce")) {
                return Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/ecommerce.png" } } });
            }
            throw new Error("unexpected request: " + url);
        });

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(mocks.analyzeEcommerceReferences).toHaveBeenCalledOnce();
        expect(mocks.planEcommerceEdit).toHaveBeenCalledOnce();
        const createCall = mocks.fetchInternalApi.mock.calls.find(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"));
        const body = JSON.parse(String(createCall?.[1]?.body)) as {
            references: Array<Record<string, unknown>>;
            productProtectionRegions: Record<string, unknown>;
            ecommerceExecution: Record<string, unknown>;
        };
        expect(body.references).toEqual([expect.objectContaining({ id: "asset-product", url: "/api/reference-assets/product.png", width: 64, height: 48 })]);
        expect(body.productProtectionRegions).toMatchObject({
            productAnchorId: "asset-product",
            sourceSize: { width: 64, height: 48 },
            editableBackground: { mask: { trust: "trusted", provider: "white-background-flood-fill.v1" } },
        });
        expect(body.ecommerceExecution).toMatchObject({
            state: "ready",
            compilerVersion: "ecommerce-openai-image-2.5.v1",
            providerProfileId: "gpt-image-2.5-flare",
            modelSnapshot: {
                logicalRole: "image_generation",
                logicalModelId: "image-model",
                channelId: "image-channel",
                upstreamModel: "gpt-image-2.5-flare",
            },
        });
        expect(mocks.run).toMatchObject({
            status: "completed",
            ecommerceSnapshot: {
                mode: "active",
                plan: { operation: "product_to_scene", strategy: "strict_product" },
                compilerVersion: "ecommerce-openai-image-2.5.v1",
                modelRouteSnapshots: {
                    vision_analysis: expect.objectContaining({ logicalRole: "vision_analysis", logicalModelId: "planner", channelId: "planner-channel", upstreamModel: "vendor/planner" }),
                    edit_planning: expect.objectContaining({ logicalRole: "edit_planning", logicalModelId: "planner", channelId: "planner-channel", upstreamModel: "vendor/planner" }),
                    image_generation: expect.objectContaining({ channelId: "image-channel", upstreamModel: "gpt-image-2.5-flare" }),
                    quality_check: expect.objectContaining({ logicalRole: "quality_check", logicalModelId: "planner", channelId: "planner-channel", upstreamModel: "vendor/planner" }),
                },
                qualityCheck: expect.objectContaining({ status: "passed", publicStatus: "passed" }),
            },
        });
        expect(mocks.checkEcommerceResult).toHaveBeenCalledOnce();
        expect(mocks.checkEcommerceResult.mock.calls[0]?.[1]).toEqual([
            expect.objectContaining({ logicalModelId: "planner", channelId: "planner-channel", upstreamModel: "vendor/planner" }),
            expect.objectContaining({
                logicalModelId: "quality-fallback",
                channelId: "quality-fallback-channel",
                upstreamModel: "gpt-5.6-sol",
            }),
        ]);
        expect(mocks.attachEcommerceTraceToGenerationLogs).toHaveBeenCalledWith(
            ["child-ecommerce"],
            expect.objectContaining({
                version: "ecommerce-generation-trace.v1",
                runId: mocks.run?.id,
                finalStatus: "completed",
                stages: expect.arrayContaining([
                    expect.objectContaining({ key: "visual_analysis", status: "completed" }),
                    expect.objectContaining({ key: "edit_planning", status: "completed" }),
                    expect.objectContaining({ key: "image_generation", status: "completed" }),
                    expect.objectContaining({ key: "quality_check", status: "passed" }),
                ]),
            }),
        );
        expect(mocks.updateImageTask).toHaveBeenCalledWith("child-ecommerce", expect.objectContaining({ ecommerceTrace: expect.objectContaining({ finalStatus: "completed" }) }));
        expect(mocks.updateImageTask.mock.invocationCallOrder[0]).toBeLessThan(mocks.attachEcommerceTraceToGenerationLogs.mock.invocationCallOrder[0]);
        expect(mocks.registerCreativeAssets.mock.invocationCallOrder[0]).toBeLessThan(mocks.checkEcommerceResult.mock.invocationCallOrder[0]);
        expect(mocks.events.filter((event) => event.type === "ecommerce.progress").map((event) => event.data)).toEqual([
            { stage: "identifying_product", text: "正在识别商品" },
            { stage: "planning_scene", text: "正在规划场景" },
            { stage: "generating_image", text: "正在生成图片" },
            { stage: "checking_result", text: "正在检查商品细节" },
        ]);
        expect(JSON.stringify(mocks.events)).not.toContain("vision-role-private");
    });

    it("routes one uploaded scene through scene editing when an image model is selected without an explicit mode", async () => {
        vi.stubEnv("ECOMMERCE_GENERATION_ROLLOUT", "internal");
        const sceneBytes = await sharp({ create: { width: 1200, height: 900, channels: 3, background: "#aaa" } })
            .png()
            .toBuffer();
        mocks.run = runFixture({
            surface: "chat",
            projectId: undefined,
            prompt: "把画面改成冬日阳光，其他内容保持不变",
            requestedModelIds: ["image-model"],
            referencedAssetIds: ["asset-scene"],
        });
        mocks.getCreativeAssetsByIds.mockResolvedValue([
            {
                ...creativeImageAsset("asset-scene", "scene.png", ""),
                serverUrl: "/api/reference-assets/scene.png",
                sourceRunId: "upload",
                width: 1200,
                height: 900,
            },
        ]);
        mocks.getAuthSettings.mockResolvedValue(ecommerceSettings());
        mocks.analyzeEcommerceReferences.mockResolvedValue(ecommerceSceneAnalysis());
        mocks.planEcommerceEdit.mockResolvedValue({
            plan: ecommerceScenePlan(),
            modelRole: { logicalRole: "edit_planning", logicalModelId: "planner", channelId: "planner-channel", upstreamModel: "vendor/planner" },
        });
        const protection = await buildSceneEditProtection(sceneBytes, "asset-scene", { x: 0, y: 0, width: 10, height: 10 }, ["fixture-edit"], "user_selection");
        const composite = await compositeSceneEdit(sceneBytes, sceneBytes, protection);
        mocks.getImageTask.mockResolvedValue({
            id: "child-scene-edit",
            userId: "user",
            result: { dataUrl: "https://cdn.example.com/scene-edited.png", serverUrl: "https://cdn.example.com/scene-edited.png", sceneProtectionEvidence: composite.evidence },
        } as ImageTask);
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/api/reference-assets/scene.png")) return new Response(sceneBytes, { headers: { "content-type": "image/png" } });
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-scene-edit" } });
            if (url.endsWith("/api/image-tasks/child-scene-edit")) {
                return Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/scene-edited.png" } } });
            }
            throw new Error("unexpected request: " + url);
        });

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(mocks.analyzeEcommerceReferences).toHaveBeenCalledOnce();
        expect(mocks.planEcommerceEdit).toHaveBeenCalledOnce();
        const createCall = mocks.fetchInternalApi.mock.calls.find(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"));
        const body = JSON.parse(String(createCall?.[1]?.body)) as Record<string, unknown>;
        expect(body.references).toEqual([expect.objectContaining({ id: "asset-scene", ecommerceRole: "scene" })]);
        expect(body).not.toHaveProperty("productProtectionRegions");
        expect(mocks.checkEcommerceResult).toHaveBeenCalledWith(
            expect.objectContaining({
                plan: expect.objectContaining({ operation: "scene_edit" }),
                baselineReference: expect.objectContaining({ assetId: "asset-scene", role: "scene" }),
                resultImages: [expect.objectContaining({ resultId: "child-scene-edit:1", sceneProtectionEvidence: composite.evidence })],
            }),
            expect.any(Array),
            expect.objectContaining({ status: "passed" }),
        );
        expect(mocks.run).toMatchObject({
            status: "completed",
            ecommerceSnapshot: { plan: { operation: "scene_edit", source: { productAnchorId: null, currentSceneBaselineId: "asset-scene" } } },
        });
        expect(mocks.events.filter((event) => event.type === "ecommerce.progress")).toHaveLength(4);
    });

    it("generates with visual quality off even if no quality route is available", async () => {
        const { product } = await frozenReferenceFixture("confirm_purposes");
        const source = await sharp({ create: { width: 64, height: 48, channels: 4, background: "#ffffff" } })
            .composite([{ input: { create: { width: 20, height: 28, channels: 4, background: "#252525" } }, left: 22, top: 10 }])
            .png()
            .toBuffer();
        mocks.run = runFixture({ surface: "chat", projectId: undefined, prompt: "生成简约家具图", referencedAssetIds: [product.id], generationPreferences: { mode: "image" } });
        mocks.getCreativeAssetsByIds.mockResolvedValue([product]);
        const configured = { ...(ecommerceSettings() as Record<string, unknown>), ecommerceVisualQualityCheckEnabled: false, ecommerceModelRoles: { quality_check: ["unavailable-quality-model"] } };
        mocks.getAuthSettings.mockResolvedValue(configured as never);
        mocks.analyzeEcommerceReferences.mockResolvedValue(ecommerceAnalysis("product"));
        mocks.planEcommerceEdit.mockResolvedValue({
            plan: { ...ecommercePlan(), modelRoles: { ...ecommercePlan().modelRoles, qualityCheck: null } },
            modelRole: { logicalRole: "edit_planning", logicalModelId: "planner", channelId: "planner-channel", upstreamModel: "vendor/planner" },
        });
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/api/reference-assets/product.png")) return new Response(source, { headers: { "content-type": "image/png" } });
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-no-quality" } });
            if (url.endsWith("/api/image-tasks/child-no-quality")) return Response.json({ task: { status: "success", result: { url: "/api/generation-log-assets/no-quality.png" } } });
            throw new Error("unexpected fixture request: " + url);
        });
        await executeAndReview(mocks.run, "http://localhost", "session=test");
        expect(mocks.run).toMatchObject({ status: "completed", reviewed: true, assetIds: ["asset-0"], ecommerceSnapshot: { qualityPolicy: "disabled", technicalCheck: { status: "passed" }, plan: { modelRoles: { qualityCheck: null } } } });
        expect(mocks.run?.ecommerceSnapshot?.qualityCheck).toBeUndefined();
        expect(mocks.run?.ecommerceSnapshot?.modelRouteSnapshots?.quality_check).toBeUndefined();
        expect(mocks.checkEcommerceResult).not.toHaveBeenCalled();
    });

    it("keeps a visually flagged ecommerce result delivered with optional advice", async () => {
        vi.stubEnv("ECOMMERCE_GENERATION_ROLLOUT", "internal");
        const source = await sharp({ create: { width: 64, height: 48, channels: 4, background: "#ffffff" } })
            .composite([{ input: { create: { width: 20, height: 28, channels: 4, background: "#252525" } }, left: 22, top: 10 }])
            .png()
            .toBuffer();
        mocks.run = runFixture({
            surface: "chat",
            projectId: undefined,
            prompt: "生成简约家具图",
            referencedAssetIds: ["asset-product"],
            generationPreferences: { mode: "image", image: { size: "4:3", quality: "high", count: 1 } },
        });
        mocks.getCreativeAssetsByIds.mockResolvedValue([
            {
                ...creativeImageAsset("asset-product", "product.png", ""),
                remoteUrl: undefined,
                serverUrl: "/api/reference-assets/product.png",
                width: 64,
                height: 48,
            },
        ]);
        mocks.getAuthSettings.mockResolvedValue(ecommerceSettings());
        mocks.analyzeEcommerceReferences.mockResolvedValue(ecommerceAnalysis("product"));
        mocks.planEcommerceEdit.mockResolvedValue({
            plan: ecommercePlan(),
            modelRole: { logicalRole: "edit_planning", logicalModelId: "planner", channelId: "planner-channel", upstreamModel: "vendor/planner" },
        });
        mocks.checkEcommerceResult.mockResolvedValue(blockedQualityCheck());
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/api/reference-assets/product.png")) return new Response(source, { headers: { "content-type": "image/png" } });
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-blocked" } });
            if (url.endsWith("/api/image-tasks/child-blocked")) return Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/blocked.png" } } });
            throw new Error("unexpected request: " + url);
        });

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(mocks.checkEcommerceResult).toHaveBeenCalledOnce();
        expect(mocks.registerCreativeAssets).toHaveBeenCalledOnce();
        expect(mocks.run).toMatchObject({
            status: "completed",
            assetIds: ["asset-0"],
            tasks: [{ status: "completed", result: { url: "https://cdn.example.com/blocked.png" }, assetIds: ["asset-0"] }],
            ecommerceSnapshot: { qualityPolicy: "advisory", technicalCheck: { status: "passed" }, qualityCheck: { status: "blocked", publicStatus: "needs_review" } },
        });
        expect(mocks.events).toContainEqual({ type: "ecommerce.quality", data: { status: "needs_adjustment", text: expect.any(String) } });
        expect(JSON.stringify(mocks.events)).not.toContain("product silhouette changed");
    });

    it("edits one explicitly referenced history result using the recovered product anchor", async () => {
        vi.stubEnv("ECOMMERCE_GENERATION_ROLLOUT", "internal");
        const sceneBytes = await sharp({ create: { width: 100, height: 80, channels: 4, background: "#d8d8d8" } })
            .png()
            .toBuffer();
        const product = { ...creativeImageAsset("product-anchor", "product.png", ""), serverUrl: "/api/reference-assets/product.png", width: 100, height: 80 };
        const history = {
            ...creativeImageAsset("scene-result", "scene.png", ""),
            serverUrl: "/api/reference-assets/scene.png",
            width: 100,
            height: 80,
            sourceRunId: "run-product-scene",
            parentAssetId: "product-anchor",
        };
        mocks.selectCurrentSceneBaseline.mockResolvedValue(history);
        mocks.run = runFixture({
            surface: "chat",
            projectId: undefined,
            prompt: "把背景换成厨房",
            referencedAssetIds: [history.id],
            generationPreferences: { mode: "image", image: { count: 1 } },
        });
        mocks.getCreativeAssetsByIds.mockImplementation(async (ids: string[] = []) => {
            if (ids.includes(history.id)) return [history];
            if (ids.includes(product.id)) return [product];
            return [];
        });
        mocks.getAuthSettings.mockResolvedValue(ecommerceSettings());
        mocks.analyzeEcommerceReferences.mockResolvedValue(ecommerceLocalAnalysis());
        mocks.planEcommerceEdit.mockResolvedValue({
            plan: ecommerceLocalPlan(["background-main"]),
            modelRole: { logicalRole: "edit_planning", logicalModelId: "planner", channelId: "planner-channel", upstreamModel: "vendor/planner" },
        });
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/api/reference-assets/scene.png")) return new Response(sceneBytes, { headers: { "content-type": "image/png" } });
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-local-edit" } });
            if (url.endsWith("/api/image-tasks/child-local-edit")) return Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/local-edit.png" } } });
            throw new Error("unexpected request: " + url);
        });

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        const createCall = mocks.fetchInternalApi.mock.calls.find(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"));
        const body = JSON.parse(String(createCall?.[1]?.body)) as { references: Array<Record<string, unknown>>; productProtectionRegions: Record<string, unknown> };
        expect(body.references).toEqual([expect.objectContaining({ id: "scene-result", ecommerceRole: "scene" }), expect.objectContaining({ id: "product-anchor", ecommerceRole: "product" })]);
        expect(body.productProtectionRegions).toMatchObject({ productAnchorId: "product-anchor", sourceAssetId: "scene-result" });
        expect(mocks.checkEcommerceResult).toHaveBeenCalledWith(
            expect.objectContaining({ baselineReference: { assetId: history.id, url: history.serverUrl, role: "scene" }, productAnchorReference: { assetId: product.id, url: product.serverUrl } }),
            expect.any(Array),
            expect.objectContaining({ status: "passed" }),
        );
        expect(mocks.run).toMatchObject({ status: "completed", ecommerceSnapshot: { plan: { operation: "local_edit", source: { currentSceneBaselineId: "scene-result" } } } });
    });

    it.each(["legacy", "v4", "v4_style", "v4_room", "v4_lighting_low_style", "v4_lighting_high_style"])("continues the latest completed scene through the real normalizer and compiler (%s)", async (mode) => {
        vi.stubEnv("ECOMMERCE_GENERATION_ROLLOUT", "internal");
        const sceneBytes = await sharp({ create: { width: 100, height: 80, channels: 4, background: "#d8d8d8" } })
            .png()
            .toBuffer();
        const product = { ...creativeImageAsset("product-anchor", "product.png", ""), serverUrl: "/api/reference-assets/product.png", width: 100, height: 80 };
        const history = {
            ...creativeImageAsset("scene-result", "scene.png", ""),
            serverUrl: "/api/reference-assets/scene.png",
            width: 100,
            height: 80,
            sourceRunId: "run-product-scene",
            parentAssetId: product.id,
        };
        const withLighting = mode === "v4_lighting_low_style" || mode === "v4_lighting_high_style";
        const withStyle = mode === "v4_style" || mode === "v4_room" || withLighting;
        const auxiliaryPurposes = withLighting ? ["lighting"] : ["style"];
        const auxiliaryCueIds = withLighting ? ["light"] : ["style-cue"];
        const style = { ...creativeImageAsset("style", "style.png", "upload"), serverUrl: "/api/reference-assets/style.png" };
        const prompt = withLighting ? "参考这张新图的光线，继续编辑最近结果" : mode === "v4_room" ? "改成这个房间" : withStyle ? "参考图片1的风格，把背景换成厨房" : "再亮一点";
        mocks.run = runFixture({ surface: "chat", projectId: undefined, prompt, referencedAssetIds: withStyle ? [style.id] : [], generationPreferences: { mode: "image", image: { count: 1 } } });
        mocks.listRecentCreativeMediaAssets.mockResolvedValue([history]);
        mocks.selectCurrentSceneBaseline.mockResolvedValue(history);
        mocks.getCreativeAssetsByIds.mockImplementation(async (ids: string[] = []) => [product, style, history].filter((asset) => ids.includes(asset.id)));
        mocks.getAuthSettings.mockResolvedValue(ecommerceSettings());
        const legacy = ecommerceLocalAnalysis();
        const analysis =
            mode === "legacy"
                ? legacy
                : {
                      ...legacy,
                      analysisVersion: "ecommerce-visual-analysis.v4" as const,
                      purposeSuggestions: withLighting ? [{ assetId: style.id, purposes: ["lighting" as const], confidence: "high" as const }] : [],
                      rawAnalysis: {},
                      normalizationAudit: [],
                      references: [
                          ...legacy.references.map(({ role, ...reference }) => ({ ...reference, contentType: role === "product" ? ("isolated_product" as const) : ("interior_scene" as const), visibleStructure: [], cues: [] })),
                          ...(withStyle
                              ? [
                                    {
                                        ...legacy.references[0],
                                        assetId: style.id,
                                        contentType: mode === "v4_room" ? ("interior_scene" as const) : ("product_detail" as const),
                                        ...(withLighting ? { visualEvidence: { whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: false }, editableTargets: [] } : {}),
                                        sceneFacts: mode === "v4_room" ? { space: "new room", composition: "new camera", lighting: "new daylight" } : null,
                                        productCore: null,
                                        fusionHalo: null,
                                        visibleStructure: [],
                                        cues: [
                                            { id: "style-cue", facet: "style" as const, confidence: mode === "v4_lighting_low_style" ? ("low" as const) : ("high" as const), description: "简约自然色调" },
                                            ...(withLighting ? [{ id: "light", facet: "lighting" as const, confidence: "high" as const, description: "left soft light" }] : []),
                                        ],
                                    },
                                ]
                              : []),
                      ],
                  };
        if (withLighting)
            expect(
                normalizeEcommerceVisualAnalysis(
                    analysis,
                    [product, style, history].map((asset) => ({ ...asset, type: "image", url: asset.serverUrl })),
                ),
            ).toMatchObject({ analysisVersion: "ecommerce-visual-analysis.v4" });
        mocks.analyzeEcommerceReferences.mockResolvedValue(analysis);
        const originalAnalysis = structuredClone(analysis);
        if (mode === "legacy")
            mocks.planEcommerceEdit.mockResolvedValue({ plan: ecommerceLocalPlan(["background-main"], prompt), modelRole: { logicalRole: "edit_planning", logicalModelId: "planner", channelId: "planner-channel", upstreamModel: "vendor/planner" } });
        else {
            const planner = await vi.importActual<typeof import("./ecommerce-edit-planner")>("./ecommerce-edit-planner");
            mocks.planEcommerceEdit.mockImplementation(async (input) => ({
                plan: planner.normalizePlannedEdit(
                    {
                        ...ecommerceLocalPlan(["background-main"], prompt),
                        planVersion: "ecommerce-edit.v6",
                        source: { productAnchorId: product.id, currentSceneBaselineId: history.id, sceneReferenceIds: withStyle ? [style.id] : [] },
                        referenceUses: [
                            { assetId: history.id, alias: null, purposes: ["edit_target"], usedCueIds: [] },
                            { assetId: product.id, alias: null, purposes: ["product_identity"], usedCueIds: [] },
                            ...(withStyle ? [{ assetId: style.id, alias: "图片1", purposes: auxiliaryPurposes, usedCueIds: auxiliaryCueIds }] : []),
                        ],
                        modelRoles: { ...ecommerceLocalPlan([]).modelRoles, visionAnalysis: "planner" },
                    },
                    input,
                    analysis,
                    "planner",
                ),
                modelRole: { logicalRole: "edit_planning", logicalModelId: "planner", channelId: "planner-channel", upstreamModel: "vendor/planner" },
            }));
        }
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/api/reference-assets/scene.png")) return new Response(sceneBytes, { headers: { "content-type": "image/png" } });
            if (mode === "v4_room" && url.endsWith("/api/reference-assets/style.png")) return new Response(sceneBytes, { headers: { "content-type": "image/png" } });
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-continuation" } });
            if (url.endsWith("/api/image-tasks/child-continuation")) return Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/brighter.png" } } });
            throw new Error("unexpected request: " + url);
        });

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(mocks.selectCurrentSceneBaseline).toHaveBeenCalledWith(mocks.run?.conversationId, undefined, mocks.run?.userId);
        expect(mocks.createEditBranch).toHaveBeenCalledWith(history.id, expect.objectContaining({ id: mocks.run?.id }), expect.any(String));
        expect(mocks.run).toMatchObject({ status: "completed", ecommerceSnapshot: { plan: { source: { productAnchorId: product.id, currentSceneBaselineId: history.id } } } });
        if (mode !== "legacy") {
            expect(mocks.analyzeEcommerceReferences).toHaveBeenCalledOnce();
            expect(mocks.planEcommerceEdit).toHaveBeenCalledOnce();
            expect(mocks.run?.ecommerceSnapshot?.input).toMatchObject({ inheritedReferences: { editTargetId: history.id, productAnchorId: product.id }, referenceAliases: withStyle ? [{ assetId: style.id, alias: "图片1" }] : [] });
            const submission = mocks.fetchInternalApi.mock.calls.find(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"));
            const body = JSON.parse(String(submission?.[1]?.body));
            expect(body.references.map((reference: { id: string }) => reference.id)).toEqual([history.id, product.id, ...(withStyle ? [style.id] : [])]);
            expect(body.ecommerceExecution).toMatchObject({
                compilerVersion: "ecommerce-openai-image-2.5.v4",
                referenceMapping: [
                    { assetId: history.id, userAlias: null, providerIndex: 0, purposes: ["edit_target"] },
                    { assetId: product.id, userAlias: null, providerIndex: 1, purposes: ["product_identity"] },
                    ...(withStyle ? [{ assetId: style.id, userAlias: "图片1", providerIndex: 2, purposes: auxiliaryPurposes }] : []),
                ],
            });
            expect(mocks.run?.ecommerceSnapshot?.visualAnalysis).toEqual(analysis);
            expect(analysis).toEqual(originalAnalysis);
            if (withLighting) {
                expect(mocks.run?.ecommerceSnapshot?.referenceDecision).toMatchObject({ bindings: [{ assetId: style.id, purposes: ["lighting"], source: "inferred" }], appliedCues: [{ assetId: style.id, purpose: "lighting", cueIds: ["light"] }] });
                expect(mocks.run?.ecommerceSnapshot?.plan?.referenceUses?.at(-1)).toMatchObject({ assetId: style.id, purposes: ["lighting"], usedCueIds: ["light"] });
            }
            expect(mocks.checkEcommerceResult).toHaveBeenCalledWith(
                expect.objectContaining({
                    plan: expect.objectContaining({ planVersion: "ecommerce-edit.v6" }),
                    analysisVisibleStructure: [],
                    baselineReference: { assetId: history.id, url: history.serverUrl, role: "scene" },
                    productAnchorReference: { assetId: product.id, url: product.serverUrl },
                }),
                expect.anything(),
                expect.objectContaining({ status: "passed" }),
            );
        }
    });

    it.each(
        [false, true].flatMap((continuation) =>
            [
                continuation ? "继续修改商品结构为四层抽屉，同时把背景改成厨房" : "修改图片1商品结构为四层抽屉，同时生成客厅",
                "新增商品抽屉，同时生成客厅",
                "删除商品把手，同时生成客厅",
                "商品抽屉数量增加到四个，同时生成客厅",
                "添加商品柜门，同时生成客厅",
                "商品抽屉数量减少到两个，同时生成客厅",
                "移除商品把手，同时生成客厅",
                "去掉商品腿，同时生成客厅",
                "add product drawers and generate a living room",
                "remove product handles and generate a living room",
                "delete product legs and generate a living room",
                "increase product drawer count to four and generate a living room",
                "product door count decrease to one and generate a living room",
            ].map((prompt) => [continuation, prompt] as const),
        ),
    )("pauses original product structure changes before an environment-only plan on the same run (continuation=%s): %s", async (continuation, prompt) => {
        vi.stubEnv("ECOMMERCE_GENERATION_ROLLOUT", "internal");
        const source = await sharp({ create: { width: 100, height: 80, channels: 4, background: "#ffffff" } })
            .composite([{ input: { create: { width: 40, height: 48, channels: 4, background: "#987654" } }, left: 30, top: 16 }])
            .png()
            .toBuffer();
        const product = {
            ...creativeImageAsset(continuation ? "product-anchor" : "asset-product", "product.png", ""),
            type: "image" as const,
            status: "ready" as const,
            sourceRunId: "upload",
            remoteUrl: undefined,
            serverUrl: "/api/reference-assets/product.png",
            width: 100,
            height: 80,
        };
        const history = {
            ...creativeImageAsset("scene-result", "scene.png", ""),
            type: "image" as const,
            status: "ready" as const,
            sourceRunId: "run-product-scene",
            remoteUrl: undefined,
            serverUrl: "/api/reference-assets/scene.png",
            width: 100,
            height: 80,
            parentAssetId: product.id,
        };
        mocks.run = runFixture({ surface: "chat", projectId: undefined, prompt, referencedAssetIds: continuation ? [] : [product.id], generationPreferences: { mode: "image", image: { count: 1 } } });
        const runIdentity = { id: mocks.run.id, conversationId: mocks.run.conversationId, inputMessageId: mocks.run.inputMessageId, assistantMessageId: mocks.run.assistantMessageId };
        if (continuation) {
            mocks.listRecentCreativeMediaAssets.mockResolvedValue([history]);
            mocks.selectCurrentSceneBaseline.mockResolvedValue(history);
        }
        mocks.getCreativeAssetsByIds.mockImplementation(async (ids: string[] = []) => [product, history].filter((asset) => ids.includes(asset.id)));
        mocks.getAuthSettings.mockResolvedValue(ecommerceSettings());
        const legacy = continuation ? ecommerceLocalAnalysis() : ecommerceAnalysis("product");
        const analysis = {
            ...legacy,
            analysisVersion: "ecommerce-visual-analysis.v4" as const,
            purposeSuggestions: [],
            rawAnalysis: {},
            normalizationAudit: [],
            references: legacy.references.map(({ role, ...reference }) => ({
                ...reference,
                contentType: role === "product" ? ("isolated_product" as const) : ("interior_scene" as const),
                ...(role === "product" ? { productFacts: { identity: "oak cabinet", outline: "rectangular cabinet with three drawers", color: "oak", material: "wood", brandText: [], view: "front" } } : {}),
                visibleStructure: [{ objectId: "cabinet", feature: "drawers" as const, count: 3, certainty: "confirmed" as const, evidenceRegion: { x: 30, y: 16, width: 40, height: 48 } }],
                cues: [],
            })),
        };
        expect(
            normalizeEcommerceVisualAnalysis(
                analysis,
                [product, ...(continuation ? [history] : [])].map((asset) => ({ ...asset, type: "image", url: asset.serverUrl })),
            ),
        ).toMatchObject({ analysisVersion: "ecommerce-visual-analysis.v4" });
        const planningInput = buildEcommercePlanningInput(mocks.run, continuation ? [history, product] : [product], { summary: "", recentMessages: [] });
        if (continuation) planningInput.inheritedReferences = { editTargetId: history.id, productAnchorId: product.id };
        expect(resolveEcommerceReferenceDecision({ planningInput, analysis })).toMatchObject({
            state: "resolved",
            editTargetId: continuation ? history.id : product.id,
            productAnchorId: product.id,
            currentSceneBaselineId: continuation ? history.id : null,
        });
        expect(history).toMatchObject({ sourceRunId: "run-product-scene", parentAssetId: product.id, userId: mocks.run.userId, conversationId: mocks.run.conversationId });
        mocks.analyzeEcommerceReferences.mockResolvedValue(analysis);
        const originalAnalysis = structuredClone(analysis);
        const planner = await vi.importActual<typeof import("./ecommerce-edit-planner")>("./ecommerce-edit-planner");
        mocks.planEcommerceEdit.mockImplementation(async (input) => ({
            plan: planner.normalizePlannedEdit(
                {
                    ...(continuation ? ecommerceLocalPlan(["background-main"], "把背景换成厨房") : ecommercePlan()),
                    planVersion: "ecommerce-edit.v6",
                    source: { productAnchorId: product.id, currentSceneBaselineId: continuation ? history.id : null, sceneReferenceIds: [] },
                    referenceUses: referenceUsesFromEcommerceDecision({ decision: input.referenceDecision!, sourceOrder: continuation ? [history.id, product.id] : [product.id] }),
                    modelRoles: { ...ecommercePlan().modelRoles, visionAnalysis: "planner" },
                },
                input,
                analysis,
                "planner",
            ),
            modelRole: { logicalRole: "edit_planning", logicalModelId: "planner", channelId: "planner-channel", upstreamModel: "vendor/planner" },
        }));
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/api/reference-assets/product.png") || url.endsWith("/api/reference-assets/scene.png")) return new Response(source, { headers: { "content-type": "image/png" } });
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-structure" } });
            if (url.endsWith("/api/image-tasks/child-structure")) return Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/structure.png" } } });
            throw new Error("unexpected structure fixture request");
        });

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(mocks.run?.ecommerceSnapshot?.referenceDecision).toMatchObject({ state: "resolved", productAnchorId: product.id, currentSceneBaselineId: continuation ? history.id : null });
        expect(mocks.run).toMatchObject({
            ...runIdentity,
            status: "paused",
            prompt,
            ecommerceSnapshot: { input: { userRequest: prompt }, visualAnalysis: analysis, fallback: { reason: "product_edit_not_supported" } },
            tasks: [{ status: "needs_review", attempts: 0, prompt, error: expect.stringContaining("结构") }],
        });
        expect(publicAgentRun(mocks.run!).tasks[0].error).toContain("结构");
        expect(mocks.run?.tasks[0].taskIds).toBeUndefined();
        expect(mocks.run?.ecommerceSnapshot?.plan).toBeUndefined();
        expect(mocks.planEcommerceEdit).not.toHaveBeenCalled();
        expect(mocks.fetchInternalApi.mock.calls.some(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"))).toBe(false);
        expect(analysis).toEqual(originalAnalysis);
    });

    const productRequestCases: Array<{ prompt: string; unsupported: boolean; inferredLighting?: "low" | "high" }> = [
        ...["参考图片1光线，修改图片2商品颜色为白色", "参考图片1光线，将图片2商品材质改为金属"].map((prompt) => ({ prompt, unsupported: true })),
        ...["参考图片1光线，把图片2中的商品颜色从黑色改成白色", "参考图片1光线，将图片2中的商品材质由木质换成金属"].map((prompt) => ({ prompt, unsupported: true })),
        ...["参考图片1光线，把图片2中的商品颜色和背景颜色都改成白色", "参考图片1光线，将图片2中的商品材质和背景地板材质一起换成金属"].map((prompt) => ({ prompt, unsupported: true })),
        ...(["low", "high"] as const).map((inferredLighting) => ({ prompt: "参考这张新图的光线，生成简约家具场景", unsupported: false, inferredLighting })),
        ...["参考图片1光线，修改图片2场景，请不要更改商品颜色和材质", "参考图片1光线，修改图片2场景，不要让商品颜色变成白色", "参考图片1光线，修改图片2背景墙颜色为白色，保留商品颜色和材质"].map((prompt) => ({ prompt, unsupported: false })),
        ...[
            "参考图片1光线，修改图片2场景，不要删除商品把手，只改背景",
            "参考图片1光线，修改图片2场景，商品抽屉数量不要增加到四个，只改背景",
            "参考图片1光线，修改图片2场景，不要同时增加商品抽屉数量和背景结构",
            "参考图片1光线，修改图片2场景，商品把手和背景结构都不要删除",
            "参考图片1光线，修改图片2场景，添加背景摆件，保持商品结构不变",
            "参考图片1光线，修改图片2场景，删除背景墙装饰，保留商品把手",
            "参考图片1光线，修改图片2场景，do not add product drawers, change background",
            "参考图片1光线，修改图片2场景，product drawer count do not increase, change background",
            "参考图片1光线，修改图片2场景，delete background handles, keep product handles",
        ].map((prompt) => ({ prompt, unsupported: false })),
        ...["中的", "里面的", "里的", "的"].flatMap((qualifier) => [
            { prompt: `参考图片1光线，修改图片2${qualifier}商品颜色为白色`, unsupported: true },
            { prompt: `参考图片1光线，将图片2${qualifier}商品材质改为金属`, unsupported: true },
            { prompt: `修改图片2场景，不要对图片2${qualifier}商品颜色进行修改`, unsupported: false },
            { prompt: `修改图片2场景，禁止修改图片2${qualifier}商品材质`, unsupported: false },
        ]),
    ];
    it.each(productRequestCases)("keeps product request semantics through the protected executor: $prompt (style=$inferredLighting)", async ({ prompt, unsupported, inferredLighting }) => {
        vi.stubEnv("ECOMMERCE_GENERATION_ROLLOUT", "internal");
        const source = await sharp({ create: { width: 64, height: 48, channels: 4, background: "#ffffff" } })
            .composite([{ input: { create: { width: 20, height: 28, channels: 4, background: "#252525" } }, left: 22, top: 10 }])
            .png()
            .toBuffer();
        const product = { ...creativeImageAsset("asset-product", "product.png", "upload"), remoteUrl: undefined, serverUrl: "/api/reference-assets/product.png", width: 64, height: 48 };
        const style = { ...creativeImageAsset("style", "style.png", "upload"), remoteUrl: undefined, serverUrl: "/api/reference-assets/style.png" };
        mocks.run = runFixture({ surface: "chat", projectId: undefined, prompt, referencedAssetIds: [style.id, product.id], generationPreferences: { mode: "image" } });
        mocks.getCreativeAssetsByIds.mockImplementation(async (ids: string[] = []) => [product, style].filter((asset) => ids.includes(asset.id)));
        mocks.getAuthSettings.mockResolvedValue(ecommerceSettings());
        const legacy = ecommerceAnalysis("product");
        const analysis = {
            ...legacy,
            analysisVersion: "ecommerce-visual-analysis.v4" as const,
            purposeSuggestions: [{ assetId: style.id, purposes: inferredLighting ? ["lighting" as const] : ["style" as const, "lighting" as const], confidence: "high" as const }],
            rawAnalysis: {},
            normalizationAudit: [],
            references: [
                { ...legacy.references[0], contentType: "isolated_product" as const, visibleStructure: [], cues: [] },
                {
                    ...legacy.references[0],
                    assetId: style.id,
                    contentType: "product_detail" as const,
                    confidence: inferredLighting ? ("high" as const) : ("medium" as const),
                    visualEvidence: { whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: false },
                    productFacts: inferredLighting ? null : legacy.references[0].productFacts,
                    productCore: inferredLighting ? null : legacy.references[0].productCore,
                    fusionHalo: inferredLighting ? null : legacy.references[0].fusionHalo,
                    visibleStructure: [],
                    cues: [
                        { id: "light", facet: "lighting" as const, confidence: "high" as const, description: "soft window light" },
                        { id: "style-cue", facet: "style" as const, confidence: inferredLighting || ("high" as const), description: "minimal style" },
                    ],
                },
            ],
        };
        if (inferredLighting)
            expect(
                normalizeEcommerceVisualAnalysis(
                    analysis,
                    [product, style].map((asset) => ({ ...asset, type: "image", url: asset.serverUrl })),
                ),
            ).toMatchObject({ analysisVersion: "ecommerce-visual-analysis.v4" });
        mocks.analyzeEcommerceReferences.mockResolvedValue(analysis);
        const originalAnalysis = structuredClone(analysis);
        const auxiliaryPurposes = prompt.includes("参考图片1") || inferredLighting ? ["lighting"] : ["style", "lighting"];
        const auxiliaryCueIds = prompt.includes("参考图片1") || inferredLighting ? ["light"] : ["style-cue", "light"];
        const planner = await vi.importActual<typeof import("./ecommerce-edit-planner")>("./ecommerce-edit-planner");
        mocks.planEcommerceEdit.mockImplementation(async (input) => ({
            plan: planner.normalizePlannedEdit(
                {
                    ...ecommercePlan(),
                    planVersion: "ecommerce-edit.v6",
                    source: { productAnchorId: product.id, currentSceneBaselineId: null, sceneReferenceIds: [style.id] },
                    referenceUses: [
                        { assetId: product.id, alias: "图片2", purposes: ["edit_target", "product_identity"], usedCueIds: [] },
                        { assetId: style.id, alias: "图片1", purposes: auxiliaryPurposes, usedCueIds: auxiliaryCueIds },
                    ],
                    modelRoles: { ...ecommercePlan().modelRoles, visionAnalysis: "planner" },
                },
                input,
                analysis,
                "planner",
            ),
            modelRole: { logicalRole: "edit_planning", logicalModelId: "planner", channelId: "planner-channel", upstreamModel: "vendor/planner" },
        }));
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/api/reference-assets/product.png")) return new Response(source, { headers: { "content-type": "image/png" } });
            if (url.endsWith("/api/reference-assets/style.png")) return new Response(source, { headers: { "content-type": "image/png" } });
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-product" } });
            if (url.endsWith("/api/image-tasks/child-product")) return Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/product.png" } } });
            throw new Error("unexpected fixture request");
        });
        await executeAndReview(mocks.run, "http://localhost", "session=test");
        expect(mocks.run?.ecommerceSnapshot?.referenceDecision).toMatchObject({ state: "resolved", editTargetId: product.id, productAnchorId: product.id });
        expect(mocks.run?.ecommerceSnapshot?.referenceDecision?.bindings).toEqual([
            { assetId: style.id, alias: "图片1", purposes: auxiliaryPurposes, source: prompt.includes("参考图片1") ? "explicit" : "inferred" },
            { assetId: product.id, alias: "图片2", purposes: ["edit_target", "product_identity"], source: inferredLighting ? "inferred" : "explicit" },
        ]);
        expect(mocks.run?.failure).toBeUndefined();
        expect(analysis).toEqual(originalAnalysis);
        if (!unsupported) {
            expect(mocks.run).toMatchObject({
                status: "completed",
                prompt,
                ecommerceSnapshot: {
                    input: { userRequest: prompt },
                    visualAnalysis: analysis,
                    plan: { planVersion: "ecommerce-edit.v6", baseline: { productFacts: legacy.references[0].productFacts }, preserve: { productCore: expect.arrayContaining(["color", "material"]) } },
                },
            });
            expect(mocks.planEcommerceEdit).toHaveBeenCalledOnce();
            expect(mocks.analyzeEcommerceReferences).toHaveBeenCalledOnce();
            const submitted = mocks.fetchInternalApi.mock.calls.filter(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"));
            expect(submitted).toHaveLength(1);
            const body = JSON.parse(String(submitted[0][1]?.body));
            expect(body.ecommerceExecution).toMatchObject({ state: "ready", compilerVersion: "ecommerce-openai-image-2.5.v4", mask: { mode: "independent", required: true } });
            expect(body.ecommerceExecution.prompt).toContain("必须保持：outline、brand_text、color、material、scale、view");
            expect(body.productProtectionRegions).toMatchObject({ productAnchorId: product.id, sourceAssetId: product.id, editableBackground: { mask: { trust: "trusted", provider: "white-background-flood-fill.v1" } } });
            expect(body.references.map((reference: { id: string }) => reference.id)).toEqual([product.id, style.id]);
            if (inferredLighting) {
                expect(mocks.run?.ecommerceSnapshot?.referenceDecision?.appliedCues).toEqual([{ assetId: style.id, purpose: "lighting", cueIds: ["light"] }]);
                expect(body.ecommerceExecution.referenceMapping.at(-1)).toEqual({ assetId: style.id, userAlias: "图片1", providerIndex: 1, purposes: ["lighting"] });
                expect(mocks.run?.ecommerceSnapshot?.plan?.referenceUses?.at(-1)).toMatchObject({ assetId: style.id, purposes: ["lighting"], usedCueIds: ["light"] });
                expect(body.ecommerceExecution.prompt).not.toContain("场景参考仅决定");
            }
            return;
        }
        expect(mocks.run).toMatchObject({
            status: "paused",
            prompt,
            ecommerceSnapshot: { fallback: { reason: "product_edit_not_supported" }, input: { userRequest: prompt }, visualAnalysis: analysis },
            tasks: [expect.objectContaining({ status: "needs_review", prompt, error: expect.stringContaining("暂不支持修改商品颜色或材质") })],
        });
        expect(publicAgentRun(mocks.run!).tasks[0].error).toContain("暂不支持修改商品颜色或材质");
        expect(mocks.planEcommerceEdit).not.toHaveBeenCalled();
        mocks.run = { ...mocks.run!, status: "planning" };
        await executeAndReview(mocks.run, "http://localhost", "session=test");
        expect(mocks.analyzeEcommerceReferences).toHaveBeenCalledOnce();
        expect(mocks.fetchInternalApi.mock.calls.some(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"))).toBe(false);
    });

    it.each([false, true])("pauses unreliable reference lighting with preserved evidence and zero planner or image submission (withStyle=%s)", async (withStyle) => {
        vi.stubEnv("ECOMMERCE_GENERATION_ROLLOUT", "internal");
        const product = creativeImageAsset("asset-product", "product.png", "upload");
        const style = creativeImageAsset("style", "style.png", "upload");
        const prompt = `参考图片1的${withStyle ? "风格和光线" : "光线"}，修改图片2灯光`;
        mocks.run = runFixture({ surface: "chat", projectId: undefined, prompt, referencedAssetIds: [style.id, product.id], generationPreferences: { mode: "image" } });
        mocks.getCreativeAssetsByIds.mockImplementation(async (ids: string[] = []) => [product, style].filter((asset) => ids.includes(asset.id)));
        mocks.getAuthSettings.mockResolvedValue(ecommerceSettings());
        const legacy = ecommerceAnalysis("product");
        const analysis = {
            ...legacy,
            analysisVersion: "ecommerce-visual-analysis.v4" as const,
            purposeSuggestions: [],
            rawAnalysis: { preserved: "original-model-output" },
            normalizationAudit: [],
            references: [
                { ...legacy.references[0], contentType: "isolated_product" as const, visibleStructure: [], cues: [] },
                {
                    ...legacy.references[0],
                    assetId: style.id,
                    contentType: "product_detail" as const,
                    confidence: "medium" as const,
                    visualEvidence: { whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: false },
                    productFacts: null,
                    productCore: null,
                    fusionHalo: null,
                    visibleStructure: [],
                    cues: [
                        { id: "light", facet: "lighting" as const, confidence: "low" as const, description: "uncertain light" },
                        { id: "style-cue", facet: "style" as const, confidence: "high" as const, description: "minimal style" },
                    ],
                },
            ],
        };
        const original = structuredClone(analysis);
        mocks.analyzeEcommerceReferences.mockResolvedValue(analysis);
        await executeAndReview(mocks.run, "http://localhost", "session=test");
        expect(mocks.run).toMatchObject({
            status: "paused",
            prompt,
            ecommerceSnapshot: {
                input: { userRequest: prompt },
                visualAnalysis: original,
                fallback: { reason: "reference_cue_unreliable" },
                referenceDecision: {
                    state: "needs_confirmation",
                    editTargetId: product.id,
                    productAnchorId: product.id,
                    appliedCues: withStyle ? [{ assetId: style.id, purpose: "style", cueIds: ["style-cue"] }] : [],
                    issues: [{ code: "reference_cue_unreliable", assetId: style.id, path: "cues.lighting" }],
                },
            },
        });
        expect(mocks.run?.ecommerceSnapshot?.referenceDecision?.bindings[0].purposes).toEqual(withStyle ? ["style", "lighting"] : ["lighting"]);
        expect(mocks.run?.tasks[0].error).toContain("光线");
        expect(mocks.run?.tasks[0].error).not.toContain("确认参考图用途");
        expect(mocks.run?.ecommerceSnapshot?.plan).toBeUndefined();
        expect(mocks.run?.ecommerceSnapshot?.stageTimings?.analysisCompletedAt).toEqual(expect.any(Number));
        expect(mocks.analyzeEcommerceReferences).toHaveBeenCalledOnce();
        expect(mocks.planEcommerceEdit).not.toHaveBeenCalled();
        expect(mocks.fetchInternalApi.mock.calls.some(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"))).toBe(false);
        expect(analysis).toEqual(original);
        const saved = structuredClone(mocks.run!.ecommerceSnapshot);
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "cue-recovery" } });
            if (url.endsWith("/api/image-tasks/cue-recovery")) return Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/cue-recovery.png" } } });
            throw new Error("unexpected cue recovery request");
        });
        mocks.run = { ...mocks.run!, status: "planning" };
        await executeAndReview(mocks.run, "http://localhost", "session=test");
        expect(mocks.run).toMatchObject({ status: "paused", tasks: [{ status: "needs_review", attempts: 0 }] });
        expect(mocks.run?.ecommerceSnapshot).toEqual(saved);
        expect(mocks.analyzeEcommerceReferences).toHaveBeenCalledOnce();
        expect(mocks.planEcommerceEdit).not.toHaveBeenCalled();
        expect(mocks.fetchInternalApi.mock.calls.some(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"))).toBe(false);
    });

    it("keeps a cue-evidence checkpoint paused through direct ordinary task execution", async () => {
        const message = "无法可靠提取参考光线，请重试分析";
        const run = runWithTasks([{ ...imageTask("cue-review"), status: "needs_review", error: message }]);
        mocks.run = {
            ...run,
            status: "running",
            executionId: "cue-lease",
            ecommerceSnapshot: {
                version: "ecommerce-generation.v1",
                runId: run.id,
                userId: run.userId,
                mode: "active",
                input: { userRequest: "参考图片1光线，修改图片2灯光", assetIds: ["reference", "target"], conversationId: "conversation-one", surface: "chat" },
                fallback: { reason: "reference_cue_unreliable" },
                createdAt: 1,
            },
        };
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "cue-direct" } });
            if (url.endsWith("/api/image-tasks/cue-direct")) return Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/cue-direct.png" } } });
            throw new Error("unexpected direct cue request");
        });
        await executeTasks(run.id, "http://localhost", "session=test", "cue-lease", settings("image-model", "image-channel"));
        expect(mocks.run).toMatchObject({ status: "paused", tasks: [{ id: "cue-review", status: "needs_review", attempts: 0, error: message }] });
        expect(mocks.fetchInternalApi).not.toHaveBeenCalled();
        expect(mocks.events).toContainEqual({ type: "run.paused", data: { message } });
    });

    it.each(["valid", "foreign", "missing"])("keeps all frozen v6 references while confirming a local scene selection (%s)", async (condition) => {
        const source = await sharp({ create: { width: 6, height: 4, channels: 3, background: "blue" } })
            .png()
            .toBuffer();
        const scene = { ...creativeImageAsset("asset-scene", "scene.png", "upload"), remoteUrl: undefined, serverUrl: "/api/reference-assets/scene.png", width: 6, height: 4 };
        const style = { ...creativeImageAsset("style", "style.png", "upload"), remoteUrl: undefined, serverUrl: "/api/reference-assets/style.png", ...(condition === "foreign" ? { userId: "foreign" } : {}) };
        const plan = {
            ...ecommerceScenePlan(),
            planVersion: "ecommerce-edit.v6" as const,
            source: { productAnchorId: null, currentSceneBaselineId: scene.id, sceneReferenceIds: [style.id] },
            referenceUses: [
                { assetId: scene.id, alias: "图片2", purposes: ["edit_target" as const], usedCueIds: [] },
                { assetId: style.id, alias: "图片1", purposes: ["style" as const], usedCueIds: ["style-cue"] },
            ],
            protection: { scope: "local" as const, protectedObjectIds: [], preserveOutsideMask: true, allowLightingChange: false },
            canvas: { mode: "exact" as const, size: { width: 6, height: 4 }, source: "baseline" as const, allowReframe: false },
        };
        const compiler = await vi.importActual<typeof import("./ecommerce-image-compiler")>("./ecommerce-image-compiler");
        const execution = compiler.compileEcommerceImageRequest(
            plan,
            compiler.resolveEcommerceImageProviderProfile({
                logicalRole: "image_generation",
                capability: "image",
                logicalModelId: "image-model",
                channelId: "image-channel",
                upstreamModel: "gpt-image-2.5-flare",
                apiFormat: "openai",
                imageEdit: resolveImageEditProtocol({ model: "gpt-image-2.5-flare", apiFormat: "openai", baseUrl: "https://api.example.com/v1" }),
            })!,
        );
        const run = runFixture({
            status: "paused",
            tasks: [{ ...imageTask("scene-task"), status: "needs_review", attempts: 0, ecommerceExecution: execution }],
            ecommerceSnapshot: {
                version: "ecommerce-generation.v1",
                runId: "agent-run",
                userId: "user",
                mode: "active",
                createdAt: 1,
                input: { userRequest: "add vase", assetIds: [style.id, scene.id], conversationId: scene.conversationId, surface: "chat" },
                plan,
                fallback: { reason: "scene_selection_required" },
            },
        });
        mocks.getCreativeAssetsByIds.mockImplementation(async (ids: string[] = []) => [scene, ...(condition === "missing" ? [] : [style])].filter((asset) => ids.includes(asset.id)));
        mocks.fetchInternalApi.mockResolvedValue(new Response(source, { headers: { "content-type": "image/png" } }));
        const resume = prepareEcommerceSceneSelectionResume(run, { baselineAssetId: scene.id, region: { x: 2, y: 1, width: 2, height: 2 } }, "http://localhost", "session=test", run.userId);
        if (condition !== "valid") await expect(resume).rejects.toThrow("权限");
        else {
            const [task] = await resume;
            expect(task.references?.map((reference) => reference.assetId)).toEqual([scene.id, style.id]);
            expect(task.ecommerceExecution).toEqual(execution);
            expect(task.sceneProtection).toMatchObject({ sourceAssetId: scene.id, selectionSource: "user_selection" });
        }
    });

    it("uses an uploaded empty room as a scene reference while retaining product and branch IDs", async () => {
        vi.stubEnv("ECOMMERCE_GENERATION_ROLLOUT", "internal");
        const productBytes = await sharp({ create: { width: 64, height: 48, channels: 4, background: "#ffffff" } })
            .composite([{ input: { create: { width: 20, height: 28, channels: 4, background: "#252525" } }, left: 22, top: 10 }])
            .png()
            .toBuffer();
        const product = { ...creativeImageAsset("product-anchor", "product.png", ""), serverUrl: "/api/reference-assets/product.png", width: 64, height: 48 };
        const room = { ...creativeImageAsset("scene-reference", "room.png", ""), serverUrl: "/api/reference-assets/room.png", width: 64, height: 48 };
        const history = { ...creativeImageAsset("scene-result", "previous.png", ""), sourceRunId: "run-prior", parentAssetId: product.id };
        mocks.run = runFixture({ surface: "chat", projectId: undefined, prompt: "改成这个房间", referencedAssetIds: [room.id], generationPreferences: { mode: "image" } });
        mocks.selectCurrentSceneBaseline.mockResolvedValue(history);
        mocks.getCreativeAssetsByIds.mockImplementation(async (ids: string[] = []) => (ids.includes(room.id) ? [room] : ids.includes(product.id) ? [product] : []));
        mocks.getAuthSettings.mockResolvedValue(ecommerceSettings());
        const analysis = ecommerceLocalAnalysis();
        mocks.analyzeEcommerceReferences.mockResolvedValue({ ...analysis, references: [{ ...analysis.references[0], assetId: room.id, productCore: null, fusionHalo: null, editableTargets: [] }, analysis.references[1]] });
        mocks.planEcommerceEdit.mockResolvedValue({
            plan: { ...ecommercePlan(), source: { productAnchorId: product.id, currentSceneBaselineId: null, sceneReferenceIds: [room.id] }, continuity: { parentResultId: history.id, branchId: "ecommerce-agent-run" } },
            modelRole: { logicalRole: "edit_planning", logicalModelId: "planner", channelId: "planner-channel", upstreamModel: "vendor/planner" },
        });
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/api/reference-assets/product.png")) return new Response(productBytes, { headers: { "content-type": "image/png" } });
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-room" } });
            if (url.endsWith("/api/image-tasks/child-room")) return Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/new-room.png" } } });
            throw new Error("unexpected request: " + url);
        });

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(mocks.analyzeEcommerceReferences).toHaveBeenCalledWith(
            expect.objectContaining({ planningInput: expect.objectContaining({ assetCandidates: expect.arrayContaining([expect.objectContaining({ id: room.id }), expect.objectContaining({ id: product.id })]) }) }),
            expect.anything(),
        );
        expect(mocks.run).toMatchObject({
            status: "completed",
            ecommerceSnapshot: { plan: { operation: "product_to_scene", source: { productAnchorId: product.id, currentSceneBaselineId: null, sceneReferenceIds: [room.id] }, continuity: { parentResultId: history.id } } },
        });
    });

    it("uses both new uploads instead of the inherited product when replacing the product", async () => {
        vi.stubEnv("ECOMMERCE_GENERATION_ROLLOUT", "internal");
        const replacementBytes = await sharp({ create: { width: 64, height: 48, channels: 4, background: "#ffffff" } })
            .composite([{ input: { create: { width: 20, height: 28, channels: 4, background: "#252525" } }, left: 22, top: 10 }])
            .png()
            .toBuffer();
        const replacement = { ...creativeImageAsset("replacement-product", "replacement.png", ""), serverUrl: "/api/reference-assets/replacement.png", width: 64, height: 48 };
        const room = { ...creativeImageAsset("room-reference", "room.png", ""), serverUrl: "/api/reference-assets/room.png", width: 64, height: 48 };
        const oldAnchor = { ...creativeImageAsset("product-anchor", "old-product.png", ""), serverUrl: "/api/reference-assets/old-product.png" };
        const history = { ...creativeImageAsset("scene-result", "previous.png", ""), sourceRunId: "run-prior", parentAssetId: oldAnchor.id };
        mocks.run = runFixture({ surface: "chat", projectId: undefined, prompt: "换成新商品，放进这个房间", referencedAssetIds: [replacement.id, room.id], generationPreferences: { mode: "image" } });
        mocks.selectCurrentSceneBaseline.mockResolvedValue(history);
        mocks.getCreativeAssetsByIds.mockImplementation(async (ids: string[] = []) => (ids.includes(oldAnchor.id) ? [oldAnchor] : [replacement, room].filter((asset) => ids.includes(asset.id))));
        mocks.getAuthSettings.mockResolvedValue(ecommerceSettings());
        const analysis = ecommerceLocalAnalysis();
        mocks.analyzeEcommerceReferences.mockResolvedValue({
            ...analysis,
            references: [
                { ...analysis.references[1], assetId: replacement.id },
                { ...analysis.references[0], assetId: room.id, productCore: null, fusionHalo: null, editableTargets: [] },
            ],
        });
        mocks.planEcommerceEdit.mockResolvedValue({
            plan: { ...ecommercePlan(), source: { productAnchorId: replacement.id, currentSceneBaselineId: null, sceneReferenceIds: [room.id] }, continuity: { parentResultId: history.id, branchId: "ecommerce-agent-run" } },
            modelRole: { logicalRole: "edit_planning", logicalModelId: "planner", channelId: "planner-channel", upstreamModel: "vendor/planner" },
        });
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/api/reference-assets/replacement.png")) return new Response(replacementBytes, { headers: { "content-type": "image/png" } });
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-replacement" } });
            if (url.endsWith("/api/image-tasks/child-replacement")) return Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/replacement-room.png" } } });
            throw new Error("unexpected request: " + url);
        });

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(mocks.analyzeEcommerceReferences).toHaveBeenCalledWith(
            expect.objectContaining({ planningInput: expect.objectContaining({ assetCandidates: [expect.objectContaining({ id: replacement.id }), expect.objectContaining({ id: room.id })] }) }),
            expect.anything(),
        );
        expect(mocks.planEcommerceEdit).toHaveBeenCalledWith(
            expect.objectContaining({ sources: expect.objectContaining({ productAnchorId: replacement.id, sceneReferenceIds: [room.id], parentResultId: history.id }) }),
            expect.anything(),
            expect.anything(),
        );
        expect(mocks.createEditBranch).toHaveBeenCalledWith(history.id, expect.objectContaining({ id: mocks.run?.id }), expect.any(String));
        expect(mocks.run).toMatchObject({
            status: "completed",
            ecommerceSnapshot: { plan: { operation: "product_to_scene", source: { productAnchorId: replacement.id, currentSceneBaselineId: null, sceneReferenceIds: [room.id] }, continuity: { parentResultId: history.id } } },
        });
    });

    it("pauses an ambiguous local edit target without creating a provider task", async () => {
        vi.stubEnv("ECOMMERCE_GENERATION_ROLLOUT", "internal");
        const sceneBytes = await sharp({ create: { width: 100, height: 80, channels: 3, background: "#aaa" } })
            .png()
            .toBuffer();
        mocks.fetchInternalApi.mockImplementation(async () => new Response(sceneBytes, { headers: { "content-type": "image/png" } }));
        const product = { ...creativeImageAsset("product-anchor", "product.png", ""), serverUrl: "/api/reference-assets/product.png", width: 100, height: 80 };
        const history = {
            ...creativeImageAsset("scene-result", "scene.png", ""),
            serverUrl: "/api/reference-assets/scene.png",
            width: 100,
            height: 80,
            sourceRunId: "run-product-scene",
            parentAssetId: "product-anchor",
        };
        mocks.selectCurrentSceneBaseline.mockResolvedValue(history);
        mocks.run = runFixture({ surface: "chat", projectId: undefined, prompt: "去掉绿植", referencedAssetIds: [history.id], generationPreferences: { mode: "image" } });
        mocks.getCreativeAssetsByIds.mockImplementation(async (ids: string[] = []) => (ids.includes(history.id) ? [history] : ids.includes(product.id) ? [product] : []));
        mocks.getAuthSettings.mockResolvedValue(ecommerceSettings());
        mocks.analyzeEcommerceReferences.mockResolvedValue(ecommerceLocalAnalysis());
        mocks.planEcommerceEdit.mockResolvedValue({
            plan: ecommerceLocalPlan(["plant-left", "plant-right"], "去掉绿植"),
            modelRole: { logicalRole: "edit_planning", logicalModelId: "planner", channelId: "planner-channel", upstreamModel: "vendor/planner" },
        });

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(mocks.planEcommerceEdit).toHaveBeenCalledOnce();
        expect(mocks.run).toMatchObject({ status: "paused", tasks: [expect.objectContaining({ status: "needs_review", error: "检测到多个可编辑目标，请明确要修改哪一个位置或物品。" })] });
        expect(mocks.fetchInternalApi.mock.calls.some(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"))).toBe(false);
    });

    it("persists ambiguous ecommerce references as needs_review without submitting a provider task", async () => {
        vi.stubEnv("ECOMMERCE_GENERATION_ROLLOUT", "internal");
        mocks.run = runFixture({
            surface: "chat",
            projectId: undefined,
            prompt: "生成场景图",
            referencedAssetIds: ["asset-unknown"],
            generationPreferences: { mode: "image" },
        });
        mocks.getCreativeAssetsByIds.mockResolvedValue([creativeImageAsset("asset-unknown", "unknown.png", "https://cdn.example.com/unknown.png")]);
        mocks.getAuthSettings.mockResolvedValue(ecommerceSettings());
        mocks.analyzeEcommerceReferences.mockResolvedValue(ecommerceAnalysis("unknown"));

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(mocks.run).toMatchObject({
            status: "paused",
            tasks: [expect.objectContaining({ id: "ecommerce-product-scene", status: "needs_review", error: expect.any(String) })],
            ecommerceSnapshot: { mode: "active", fallback: { reason: expect.any(String) } },
        });
        expect(mocks.planEcommerceEdit).not.toHaveBeenCalled();
        expect(mocks.fetchInternalApi.mock.calls.some(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"))).toBe(false);
    });

    it("preserves generated media dimensions in canvas output ops", () => {
        const task = {
            ...imageTask("image-one"),
            attempts: 1,
            result: { url: "https://cdn.example.com/output.png", width: 1024, height: 1024, mimeType: "image/png" },
        } as AgentRunTask;

        const output = taskResultOps("agent-run", 0, task);

        expect(output.ops[0]).toMatchObject({
            type: "update_node",
            id: "output-agent-run-0-0",
            metadata: { remoteUrl: "https://cdn.example.com/output.png", naturalWidth: 1024, naturalHeight: 1024, mimeType: "image/png", size: task.ratio },
        });
        expect(output.ops).not.toContainEqual({ type: "select_nodes", ids: ["output-agent-run-0-0"] });
    });

    it("uses one immutable settings snapshot for a resumed run", async () => {
        mocks.run = runWithTasks([imageTask("image-one")]);
        mocks.getAuthSettings.mockResolvedValueOnce(settings("old-image", "old-channel")).mockResolvedValue(settings("new-image", "new-channel"));

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        const createCall = mocks.fetchInternalApi.mock.calls.find((call) => call[1]?.method === "POST");
        const body = JSON.parse(String(createCall?.[1]?.body)) as { config: { model: string; baseUrl: string; apiKey: string } };
        expect(body.config).toMatchObject({ model: "old-image", baseUrl: "/api/ai/system/old-channel", apiKey: "" });
        expect(mocks.run?.status).toBe("completed");
    });

    it("completes a single media run and schedules its persistent review", async () => {
        mocks.run = { ...runWithTasks([imageTask("image-one")]), reviewed: false };
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(mocks.run?.status).toBe("completed");
        expect(mocks.run?.reviewed).toBe(false);
        expect(mocks.run?.reviewStatus).toBe("review_pending");
        expect(mocks.events.at(-1)?.type).toBe("run.completed");
        expect(mocks.reviewCreativeOutputs).not.toHaveBeenCalled();
        expect(mocks.updateAgentRunById).toHaveBeenCalledWith("agent-run", expect.objectContaining({ status: "completed", reviewStatus: "review_pending" }), expect.objectContaining({ type: "run.completed" }), ["running"], expect.any(String));
        expect(mocks.scheduleGenerationTask).not.toHaveBeenCalledWith("agent", "agent-run", expect.objectContaining({ executionPhase: "review_pending" }));
    });

    it("settles a failed persistent review without unconfigured paid retries", async () => {
        mocks.run = { ...runWithTasks([imageTask("image-one")]), status: "completed", reviewed: false, reviewStatus: "review_pending" };
        mocks.reviewCreativeOutputs.mockRejectedValue(new Error("review offline"));

        await expect(processAgentRunReview(mocks.run, "http://localhost", "session=test")).resolves.toEqual({ status: "unavailable", attempts: 1 });

        expect(mocks.run).toMatchObject({ status: "completed", reviewed: true, reviewStatus: "review_unavailable", reviewAttempts: 1, review: { mode: "unavailable", status: "unavailable" } });
        expect(mocks.events.map((event) => event.type)).toEqual(["run.review.started", "run.review.background"]);
    });

    it("keeps review blocking for multi-task runs", async () => {
        mocks.run = { ...runWithTasks([imageTask("image-one"), imageTask("image-two")]), reviewed: false };
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));
        let finishReview: ((value: { mode: "visual"; status: "passed"; summary: string; issues: never[]; retryTaskIds: never[] }) => void) | undefined;
        mocks.reviewCreativeOutputs.mockReturnValue(
            new Promise((resolve) => {
                finishReview = resolve;
            }),
        );

        const execution = executeAgentRun(mocks.run, "http://localhost", "session=test");
        await vi.waitFor(() => expect(mocks.reviewCreativeOutputs).toHaveBeenCalledOnce());

        expect(mocks.run?.status).toBe("running");
        expect(mocks.events.some((event) => event.type === "run.completed")).toBe(false);

        finishReview?.({ mode: "visual", status: "passed", summary: "检查通过", issues: [], retryTaskIds: [] });
        await execution;
        expect(mocks.run?.status).toBe("completed");
    });

    it("keeps completed media identities when review suggests revisions", async () => {
        mocks.run = { ...runWithTasks([imageTask("image-one"), imageTask("image-two")]), reviewed: false };
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));
        mocks.reviewCreativeOutputs.mockResolvedValue({
            mode: "visual",
            status: "needs_revision",
            summary: "第一张需要调整",
            issues: [{ taskId: "image-one", category: "composition", severity: "high", message: "主体偏移", correction: "主体居中" }],
            retryTaskIds: ["image-one"],
        });

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(mocks.fetchInternalApi.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
        expect(mocks.run).toMatchObject({ status: "completed", reviewed: true, reviewStatus: "review_completed", review: { status: "needs_revision", retryTaskIds: ["image-one"] } });
        expect(mocks.run?.tasks).toEqual([
            expect.objectContaining({ id: "image-one", status: "completed", taskId: expect.any(String), assetIds: expect.any(Array), result: expect.any(Object) }),
            expect.objectContaining({ id: "image-two", status: "completed", taskId: expect.any(String), assetIds: expect.any(Array), result: expect.any(Object) }),
        ]);
        expect(mocks.events.some((event) => event.type === "run.review.needs_revision")).toBe(true);
    });

    it("plans a chat request before executing every explicitly selected generation model", async () => {
        mocks.run = runFixture({
            surface: "chat",
            projectId: undefined,
            prompt: "把白底台灯放到明亮的现代客厅",
            requestedModelIds: ["image-model"],
            referencedAssetIds: ["asset-product"],
            generationPreferences: { mode: "image" },
        });
        mocks.getCreativeConversationContext.mockResolvedValue({
            summary: "同一商品使用红色包装",
            summaryThroughSequence: 1,
            recentMessages: [],
        });
        mocks.getCreativeAssetsByIds.mockResolvedValue([creativeImageAsset("asset-product", "白底台灯", "https://cdn.example.com/product.png")]);
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));
        const basePlan = canvasPlan("image-model");
        const plan = {
            ...basePlan,
            deliverables: [{ ...basePlan.deliverables[0], prompt: "保留台灯外观，将白底替换为明亮现代客厅，使用自然窗光和真实接触阴影", assetIds: ["asset-product"] }],
        };
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/chat/completions")) return Response.json({ output: [{ type: "function_call", name: "create_agent_plan", arguments: JSON.stringify(plan) }] });
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-planned" } });
            if (url.endsWith("/api/image-tasks/child-planned")) return Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/planned.png" } } });
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(mocks.getCreativeConversationContext).toHaveBeenCalledWith("conversation", "user", "agent-run");
        expect(mocks.listRecentCreativeMediaAssets).not.toHaveBeenCalled();
        const planningCall = mocks.fetchInternalApi.mock.calls.find(([url]) => String(url).endsWith("/chat/completions"));
        expect(planningCall).toBeDefined();
        const planningBody = JSON.parse(String(planningCall?.[1]?.body)) as { messages: Array<{ content: string }> };
        const planningInput = JSON.parse(planningBody.messages[1].content) as { requestedModelIds: string[]; availableModels: Array<{ id: string }>; conversationContext: { summary: string } };
        expect(planningInput.requestedModelIds).toEqual(["image-model"]);
        expect(planningInput.availableModels.map((model) => model.id)).toEqual(["image-model"]);
        expect(planningInput.conversationContext.summary).toBe("同一商品使用红色包装");
        expect(mocks.fetchInternalApi.mock.calls.some(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"))).toBe(true);
        expect(mocks.run?.tasks[0]).toMatchObject({ model: "image-model", optimizedPrompt: plan.deliverables[0].prompt });
        expect(mocks.run?.plannerAudit).toMatchObject({ mode: "model", logicalModelId: "planner" });
        expect(mocks.run?.status).toBe("completed");
    });

    it("creates Canvas plan nodes when a generation model is selected explicitly", async () => {
        mocks.run = runFixture({ surface: "canvas", prompt: "生成商品主图", requestedModelIds: ["image-model"] });
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(mocks.events.find((event) => event.type === "run.planned")).toBeUndefined();
        expect(mocks.events.find((event) => event.type === "canvas.ops")?.data).toMatchObject({
            ops: expect.arrayContaining([expect.objectContaining({ type: "add_node", id: "task-agent-run-0", nodeType: "task" }), expect.objectContaining({ type: "add_node", id: "output-agent-run-0-0", nodeType: "image" })]),
        });
        expect(mocks.run?.status).toBe("completed");
    });

    it("does not complete the run when it is paused during a parallel batch", async () => {
        mocks.run = runWithTasks([imageTask("image-one"), imageTask("image-two")]);
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));
        mocks.updateAgentRunTaskById.mockImplementation(async (_id, taskId, patch, eventType, expectedExecutionId) => {
            const current = mocks.run;
            if (!current || current.status !== "running" || current.executionId !== expectedExecutionId) return null;
            const tasks = current.tasks.map((task) => (task.id === taskId ? { ...task, ...patch } : task));
            mocks.run = { ...current, tasks, status: eventType === "task.completed" ? "paused" : current.status };
            return mocks.run;
        });

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(2);
        expect(mocks.run?.status).toBe("paused");
    });

    it("creates two independent tasks before polling either result", async () => {
        mocks.run = runWithTasks([imageTask("image-one"), imageTask("image-two")]);
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));
        const postCountsAtPoll: number[] = [];
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (init?.method === "POST") {
                const count = mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST").length;
                return Response.json({ task: { id: "child-" + count } });
            }
            postCountsAtPoll.push(mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST").length);
            if (url.includes("/api/image-tasks/")) return Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/output.png" } } });
            throw new Error("unexpected request: " + url);
        });

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(postCountsAtPoll).toEqual([2, 2]);
        expect(mocks.run?.tasks).toEqual([expect.objectContaining({ status: "completed" }), expect.objectContaining({ status: "completed" })]);
    });

    it("does not change channel settings halfway through a run", async () => {
        mocks.run = runWithTasks([imageTask("image-one"), imageTask("image-two")]);
        mocks.getAuthSettings.mockResolvedValueOnce(settings("image-model", "image-channel")).mockResolvedValueOnce(settings("image-model", "image-channel")).mockResolvedValue(disabledSettings("image-model", "image-channel"));

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(2);
        expect(mocks.run?.tasks[1]).toMatchObject({ status: "completed", attempts: 1 });
        expect(mocks.run?.status).toBe("completed");
    });

    it("resumes polling an in-flight child task instead of failing the run", async () => {
        mocks.run = runWithTasks([{ ...imageTask("image-one"), status: "running", attempts: 1, taskId: "child-existing" }]);
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(0);
        expect(mocks.fetchInternalApi.mock.calls.some(([url]) => String(url).endsWith("/api/image-tasks/child-existing"))).toBe(true);
        expect(mocks.run?.status).toBe("completed");
    });

    it("persists every child result for a multi-copy image task", async () => {
        mocks.run = runWithTasks([{ ...imageTask("image-one"), count: 2 }]);
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(2);
        expect(mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST").map((call) => JSON.parse(String(call[1]?.body)).context.clientRequestId)).toEqual(["request:image-one:1:1", "request:image-one:1:2"]);
        expect(mocks.run?.tasks[0].childTasks).toEqual([
            expect.objectContaining({ id: "child-1", status: "completed", result: expect.objectContaining({ url: "https://cdn.example.com/output.png" }) }),
            expect.objectContaining({ id: "child-2", status: "completed", result: expect.objectContaining({ url: "https://cdn.example.com/output.png" }) }),
        ]);
        expect(mocks.run?.tasks[0].result).toMatchObject({ results: [{ url: "https://cdn.example.com/output.png" }, { url: "https://cdn.example.com/output.png" }] });
    });

    it("creates two copies before polling either result", async () => {
        mocks.run = runWithTasks([{ ...imageTask("image-one"), count: 2 }]);
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));
        const postCountsAtPoll: number[] = [];
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (init?.method === "POST") {
                const count = mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST").length;
                return Response.json({ task: { id: "copy-" + count } });
            }
            postCountsAtPoll.push(mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST").length);
            if (url.includes("/api/image-tasks/")) return Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/output.png" } } });
            throw new Error("unexpected request: " + url);
        });

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(postCountsAtPoll).toEqual([2, 2]);
        expect(mocks.run?.tasks[0].childTasks).toHaveLength(2);
    });

    it("keeps successful assets and completes the run as partial when a later image copy fails", async () => {
        mocks.run = runWithTasks([{ ...imageTask("image-one"), count: 2 }]);
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));
        mocks.registerCreativeAssets.mockImplementation(async (inputs: Array<Record<string, unknown>>) => inputs.map((input) => ({ ...input, id: `asset-${input.sourceTaskId}`, status: "ready", createdAt: 1, updatedAt: 1 })));
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (init?.method === "POST") {
                const count = mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST").length;
                return Response.json({ task: { id: `child-${count}` } });
            }
            if (url.endsWith("/api/image-tasks/child-1")) return Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/one.png" } } });
            if (url.endsWith("/api/image-tasks/child-2")) return Response.json({ task: { status: "error", error: "第二张生成失败" } });
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(mocks.run?.tasks[0]).toMatchObject({
            status: "failed",
            assetIds: ["asset-child-1"],
            childTasks: [expect.objectContaining({ id: "child-1", status: "completed" }), expect.objectContaining({ id: "child-2", status: "failed", error: "第二张生成失败" })],
        });
        expect(mocks.run?.assetIds).toEqual(["asset-child-1"]);
        expect(mocks.run?.status).toBe("completed");
        expect(mocks.events.find((event) => event.type === "run.completed")?.data).toMatchObject({ partial: true, assetIds: ["asset-child-1"], reply: expect.stringContaining("成功 1 张，失败 1 张") });
        expect(mocks.events.some((event) => event.type === "run.failed")).toBe(false);
    });

    it("resumes only unfinished children after a multi-copy run restarts", async () => {
        mocks.run = runWithTasks([
            {
                ...imageTask("image-one"),
                count: 2,
                status: "running",
                attempts: 1,
                taskId: "child-two",
                taskIds: ["child-one", "child-two"],
                childTasks: [
                    { id: "child-one", status: "completed", attempt: 1, result: { url: "https://cdn.example.com/one.png" } },
                    { id: "child-two", status: "pending", attempt: 1 },
                ],
            },
        ]);
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(0);
        expect(mocks.fetchInternalApi.mock.calls.some(([url]) => String(url).endsWith("/api/image-tasks/child-one"))).toBe(false);
        expect(mocks.fetchInternalApi.mock.calls.some(([url]) => String(url).endsWith("/api/image-tasks/child-two"))).toBe(true);
        expect(mocks.run?.tasks[0].result).toMatchObject({ results: [{ url: "https://cdn.example.com/one.png" }, { url: "https://cdn.example.com/output.png" }] });
    });

    it("releases execution after a transient response and resumes the same child on the next lease", async () => {
        mocks.run = runWithTasks([imageTask("image-one")]);
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));
        let polls = 0;
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (init?.method === "POST") return Response.json({ task: { id: "child-transient" } });
            if (String(url).endsWith("/api/image-tasks/child-transient")) {
                polls += 1;
                return polls === 1 ? new Response("temporary", { status: 502 }) : Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/recovered.png" } } });
            }
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
        expect(polls).toBe(1);
        expect(mocks.run?.status).toBe("running");
        expect(mocks.run?.tasks[0]).toMatchObject({ status: "running", taskId: "child-transient", childTasks: [{ id: "child-transient", status: "pending" }], error: "生成任务查询暂时不可用" });
        expect(mocks.events.filter((event) => event.type === "task.waiting")).toHaveLength(1);

        await executeAndReview(mocks.run!, "http://localhost", "session=test");

        expect(mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
        expect(polls).toBe(2);
        expect(mocks.events.filter((event) => event.type === "task.running")).toHaveLength(1);
        expect(mocks.run?.status).toBe("completed");
    });

    it("pauses a mixed batch when a pending sibling returns before the child that needs review", async () => {
        mocks.run = runWithTasks([{ ...imageTask("image-mixed-pause"), count: 2 }]);
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));
        const pendingSeen = Promise.withResolvers<void>();
        let created = 0;
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/api/image-tasks") && init?.method === "POST") return Response.json({ task: { id: ++created === 1 ? "source-child" : "sibling-child" } });
            if (url.endsWith("/api/image-tasks/sibling-child")) {
                pendingSeen.resolve();
                return Response.json({ task: { status: "running", needsReview: false } });
            }
            if (url.endsWith("/api/image-tasks/source-child")) {
                await pendingSeen.promise;
                return Response.json({ task: { status: "running", needsReview: true, reviewReason: "参考图片暂时无法读取" } });
            }
            throw new Error("unexpected mixed pause request");
        });
        await executeAndReview(mocks.run, "http://localhost", "session=test");
        expect(mocks.run).toMatchObject({ status: "paused", tasks: [{ count: 2, attempts: 1, status: "needs_review", error: "参考图片暂时无法读取", taskIds: ["source-child", "sibling-child"] }] });
        expect(mocks.fetchInternalApi.mock.calls.filter(([url, init]) => init?.method === "POST" && url.endsWith("/api/image-tasks"))).toHaveLength(2);
        expect(mocks.analyzeEcommerceReferences).not.toHaveBeenCalled();
    });
    it.each(["created", "polling", "completed"] as const)("recovers only the paused original child while its %s sibling continues through GET", async (phase) => {
        const task = {
            ...imageTask("image-mixed"),
            status: "needs_review" as const,
            count: 2,
            attempts: 1,
            taskId: "source-child",
            taskIds: ["source-child", "sibling-child"],
            childTasks: [
                { id: "source-child", status: "needs_review" as const, attempt: 1 },
                { id: "sibling-child", status: "needs_review" as const, attempt: 1 },
            ],
        };
        mocks.run = runWithTasks([task]);
        const identity = { id: mocks.run.id, conversationId: mocks.run.conversationId, inputMessageId: mocks.run.inputMessageId, assistantMessageId: mocks.run.assistantMessageId };
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));
        mocks.getStoredGenerationTaskRecord.mockImplementation(async (_type, id) => ({
            id,
            executionPhase: id === "source-child" ? "needs_review" : phase,
            lastUpstreamStatus: id === "source-child" ? "reference_source_unavailable" : phase,
            upstreamTaskId: id === "sibling-child" && phase !== "created" ? "original-sibling-upstream" : undefined,
        }));
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/api/image-tasks/source-child") && init?.method === "POST") return Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/source.png" } } });
            if (url.endsWith("/api/image-tasks/sibling-child") && !init?.method) return Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/sibling.png" } } });
            return new Response("unexpected create or sibling recovery", { status: 409 });
        });
        await executeAndReview(mocks.run, "http://localhost", "session=test");
        expect(mocks.run).toMatchObject({ ...identity, status: "completed", tasks: [{ id: task.id, count: 2, attempts: 1, taskIds: task.taskIds, childTasks: task.childTasks.map((child) => ({ id: child.id, attempt: 1, status: "completed" })) }] });
        expect(mocks.fetchInternalApi.mock.calls.filter(([url, init]) => init?.method === "POST" && url.endsWith("/api/image-tasks"))).toHaveLength(0);
        expect(mocks.fetchInternalApi.mock.calls.filter(([, init]) => init?.method === "POST")).toEqual([["http://localhost/api/image-tasks/source-child", expect.objectContaining({ body: JSON.stringify({ action: "recover" }) })]]);
        expect(mocks.fetchInternalApi.mock.calls.filter(([url]) => url.endsWith("/api/image-tasks/sibling-child"))).toEqual([["http://localhost/api/image-tasks/sibling-child", expect.objectContaining({ cache: "no-store" })]]);
        expect(mocks.analyzeEcommerceReferences).not.toHaveBeenCalled();
        expect(mocks.linkStoredGenerationTask).not.toHaveBeenCalled();
    });
    it("defers a temporary child-state read failure without creating or recovering any child", async () => {
        mocks.run = runWithTasks([{ ...imageTask("image-read"), status: "needs_review", attempts: 1, taskIds: ["original-child"], childTasks: [{ id: "original-child", status: "needs_review", attempt: 1 }] }]);
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));
        mocks.getStoredGenerationTaskRecord.mockRejectedValue(new Error("fixture database unavailable"));
        await executeAndReview(mocks.run, "http://localhost", "session=test");
        expect(mocks.run).toMatchObject({ status: "running", tasks: [{ status: "needs_review", attempts: 1, error: "生成任务查询暂时不可用", childTasks: [{ id: "original-child", status: "needs_review", attempt: 1 }] }] });
        expect(mocks.fetchInternalApi).not.toHaveBeenCalled();
    });
    it("pauses on needs_review and resumes the same child without another upstream creation", async () => {
        const reviewReason = "上游创建状态待确认";
        mocks.run = runWithTasks([imageTask("image-one")]);
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));
        let polls = 0;
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-review" } });
            if (url.endsWith("/api/image-tasks/child-review")) {
                polls += 1;
                return polls === 1 ? Response.json({ task: { status: "running", needsReview: true, reviewReason } }) : Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/recovered.png" } } });
            }
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
        expect(mocks.run).toMatchObject({
            status: "paused",
            tasks: [expect.objectContaining({ status: "needs_review", attempts: 1, taskId: "child-review", error: reviewReason, childTasks: [expect.objectContaining({ id: "child-review", status: "needs_review", attempt: 1, error: reviewReason })] })],
        });
        expect(mocks.events.some((event) => event.type === "task.needs_review")).toBe(true);
        expect(mocks.events.some((event) => event.type === "run.paused")).toBe(true);

        mocks.run = { ...mocks.run!, status: "running" };
        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST" && String(call[0]).endsWith("/api/image-tasks"))).toHaveLength(1);
        expect(mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST" && String(call[0]).endsWith("/api/image-tasks/child-review"))).toHaveLength(1);
        expect(polls).toBe(2);
        expect(mocks.run?.status).toBe("completed");
        expect(mocks.run?.tasks[0]).toMatchObject({ attempts: 1, taskId: "child-review", childTasks: [expect.objectContaining({ id: "child-review", attempt: 1, status: "completed" })] });
    });

    it.each([
        ["missing", undefined, "上游创建状态待确认"],
        ["empty", "", "上游创建状态待确认"],
        ["whitespace", " \n ", "上游创建状态待确认"],
        ["null", null, "上游创建状态待确认"],
        ["number", 42, "上游创建状态待确认"],
        ["object", { message: "not public" }, "上游创建状态待确认"],
        ["array", ["not public"], "上游创建状态待确认"],
        ["submission_outcome_unknown", UNKNOWN_SUBMISSION_REVIEW_ERROR, UNKNOWN_SUBMISSION_REVIEW_ERROR],
        ["trimmed", "  当前协议不支持可信独立蒙版，请选择支持局部编辑的模型。  ", "当前协议不支持可信独立蒙版，请选择支持局部编辑的模型。"],
        ["infrastructure", "provider https://private.fixture.invalid/submit api key fixture-secret", "生成渠道暂时无法连接，请稍后重试或联系管理员。"],
    ])("keeps a safe child review reason for %s API values without another create", async (_label, reviewReason, expected) => {
        mocks.run = runWithTasks([imageTask("image-one")]);
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-review-reason" } });
            if (url.endsWith("/api/image-tasks/child-review-reason")) return Response.json({ task: { status: "pending", needsReview: true, reviewReason } });
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(mocks.run).toMatchObject({
            status: "paused",
            tasks: [{ status: "needs_review", attempts: 1, error: expected, taskId: "child-review-reason", childTasks: [{ id: "child-review-reason", attempt: 1, status: "needs_review", error: expected }] }],
        });
        expect(publicAgentRun(mocks.run!).tasks[0].error).toBe(expected);
        expect(mocks.events).toContainEqual({ type: "run.paused", data: { message: expected } });
        expect(mocks.fetchInternalApi.mock.calls.filter(([url, init]) => init?.method === "POST" && url.endsWith("/api/image-tasks"))).toHaveLength(1);
    });

    it("does not create another child after an upstream task reports an error", async () => {
        mocks.run = runWithTasks([imageTask("image-one")]);
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-error" } });
            if (url.endsWith("/api/image-tasks/child-error")) return Response.json({ task: { status: "error", error: "上游生成失败" } });
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
        expect(mocks.run?.tasks[0]).toMatchObject({ status: "failed", attempts: 1, taskId: "child-error", childTasks: [{ id: "child-error", status: "failed", attempt: 1, error: "上游生成失败" }], error: "上游生成失败" });
        expect(mocks.run).toMatchObject({ status: "failed", failureStage: "task_execution", failure: expect.stringContaining("上游生成失败") });
    });

    it("turns explicit canvas text-node content into a node result without calling the text task API", async () => {
        mocks.run = runWithTasks([
            {
                id: "text-one",
                title: "欢迎文案",
                type: "text",
                prompt: "创建一个文字节点，内容写“欢迎使用 VOZEB PRO Agent”，放在画布中央，并选中它。\n\n严格输出要求：只输出最终文本，不要标题、Markdown、解释或列表。",
                count: 1,
                dependencies: [],
                status: "ready",
                attempts: 0,
            },
        ]);
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(mocks.fetchInternalApi.mock.calls.some(([url]) => String(url).includes("/api/text-tasks"))).toBe(false);
        expect(mocks.run?.tasks[0].result).toEqual({ content: "欢迎使用 VOZEB PRO Agent" });
        const completed = mocks.events.find((event) => event.type === "task.completed") as { data?: { message?: string; ops?: Array<Record<string, unknown>> } } | undefined;
        expect(completed?.data?.message).not.toContain("无法直接操作");
        expect(completed?.data?.ops).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    type: "add_node",
                    id: "output-agent-run-0-0",
                    nodeType: "text",
                    position: { x: 800, y: 96 },
                    metadata: expect.objectContaining({ content: "欢迎使用 VOZEB PRO Agent" }),
                }),
                { type: "select_nodes", ids: ["output-agent-run-0-0"] },
            ]),
        );
        expect(mocks.run?.status).toBe("completed");
    });

    it("stops a stale executor before it dispatches a child task", async () => {
        mocks.run = runWithTasks([imageTask("image-one")]);
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));
        mocks.updateAgentRunTaskById.mockImplementationOnce(async () => {
            if (mocks.run) mocks.run = { ...mocks.run, executionId: "replacement-executor" };
            return null;
        });

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(0);
        expect(mocks.run?.executionId).toBe("replacement-executor");
    });

    it("accepts a strict JSON canvas plan and executes the model selected by the Agent", async () => {
        mocks.run = { ...planningRun(), selectedSkillIds: ["skill-one"] };
        const nextSettings = canvasSettings("image-default", "image-default-channel", "image-creative", "image-creative-channel") as unknown as { agentSkills: Array<Record<string, unknown>> };
        nextSettings.agentSkills = [
            {
                id: "skill-one",
                name: "商品视觉",
                description: "商品视觉规划",
                instructions: "保持商品一致",
                enabled: true,
                keywords: ["商品"],
                workspaces: ["canvas"],
                sourceVersion: "1.2.0",
                sourceCommit: "abcdef",
                sourceContentHash: "hash",
            },
        ];
        mocks.getAuthSettings.mockResolvedValue(nextSettings as never);
        const plan = canvasPlan("image-creative");
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/responses")) return new Response("unsupported endpoint", { status: 404 });
            if (url.endsWith("/chat/completions")) return Response.json({ choices: [{ message: { content: JSON.stringify(plan) } }] }, { headers: { "x-vozeb-pro-points-cost": "1.25", "x-vozeb-pro-points-record-id": "points-plan" } });
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-planned" } });
            if (url.endsWith("/api/image-tasks/child-planned")) return Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/planned.png" } } });
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        const planningCall = mocks.fetchInternalApi.mock.calls.find(([url]) => String(url).endsWith("/chat/completions"));
        const planningBody = JSON.parse(String(planningCall?.[1]?.body)) as { messages: Array<{ content: string }> };
        expect(planningBody.messages[0].content).toContain("你是 星河创作 画布创作 Agent");
        const planningInput = JSON.parse(planningBody.messages[1].content) as { availableModels: Array<{ id: string; capability: string }> };
        expect(planningInput.availableModels).toEqual(expect.arrayContaining([expect.objectContaining({ id: "image-default", capability: "image" }), expect.objectContaining({ id: "image-creative", capability: "image" })]));
        expect(mocks.run?.plannerContext).toMatchObject({
            serializedChars: expect.any(Number),
            kept: { modelIds: expect.arrayContaining(["image-default", "image-creative"]) },
            omitted: { modelIds: [], skillIds: [], assetIds: [], recentMessageSequences: [] },
        });
        expect(mocks.run?.plannerContext).not.toHaveProperty("maxInputChars");
        expect(mocks.run?.plannerAudit).toMatchObject({
            schemaVersion: AGENT_PLAN_SCHEMA_VERSION,
            mode: "model",
            logicalModelId: "planner",
            channelId: "planner-channel",
            upstreamModel: "vendor/planner",
            protocol: "chat",
            elapsedMs: expect.any(Number),
            pointsCost: 1.25,
            pointsRecordId: "points-plan",
            skills: [
                {
                    id: "skill-one",
                    name: "商品视觉",
                    description: "商品视觉规划",
                    plannerSummary: "商品视觉规划",
                    instructions: "保持商品一致",
                    enabled: true,
                    keywords: ["商品"],
                    workspaces: ["canvas"],
                    action: "generate",
                    requiresReference: false,
                    defaultConfig: {},
                    sourceVersion: "1.2.0",
                    sourceCommit: "abcdef",
                    sourceContentHash: "hash",
                },
            ],
        });
        const createCall = mocks.fetchInternalApi.mock.calls.find(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"));
        const createBody = JSON.parse(String(createCall?.[1]?.body)) as { config: { model: string } };
        expect(createBody.config.model).toBe("image-creative");
        const planEvent = mocks.events.find((event) => event.type === "canvas.ops") as { data?: { reply?: string } } | undefined;
        expect(planEvent?.data?.reply).toBe("已收到，我会按你的要求完成这次画布创作。");
        expect(mocks.run?.status).toBe("completed");
    });

    it("passes the persistent summary and recent messages to the planner", async () => {
        mocks.run = planningRun("继续刚才的红色服装方案");
        mocks.getCreativeConversationContext.mockResolvedValue({
            summary: "用户正在制作统一的新中式女主角色。",
            summaryThroughSequence: 8,
            recentMessages: [{ id: "history-one", conversationId: "conversation", sequence: 9, role: "assistant", status: "completed", content: "第二张采用红色服装。", metadata: {}, createdAt: 1, updatedAt: 1 }],
        });
        mocks.getAuthSettings.mockResolvedValue(canvasSettings("image-default", "image-default-channel"));
        mocks.fetchInternalApi.mockResolvedValue(Response.json({ output: [{ type: "function_call", name: "create_agent_plan", arguments: JSON.stringify({ ...canvasPlan("image-default"), intent: "conversation", decisions: [], deliverables: [] }) }] }));

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        const body = JSON.parse(String(mocks.fetchInternalApi.mock.calls[0][1]?.body)) as { messages: Array<{ content: string }> };
        expect(JSON.parse(body.messages[1].content)).toMatchObject({
            conversationContext: { summary: "用户正在制作统一的新中式女主角色。", recentMessages: [{ role: "assistant", content: "第二张采用红色服装。", sequence: 9 }] },
        });
        expect(mocks.getCreativeConversationContext).toHaveBeenCalledWith("conversation", "user", "agent-run");
    });

    it("lets the text model select a same-conversation media candidate for continuous creation", async () => {
        mocks.run = runFixture({ surface: "chat", projectId: undefined, prompt: "继续上一张，把衣服换成红色" });
        const memoryAsset = creativeImageAsset("asset-memory", "上一张角色图", "https://cdn.example.com/memory.png");
        mocks.listRecentCreativeMediaAssets.mockResolvedValue([memoryAsset]);
        mocks.getAuthSettings.mockResolvedValue(canvasSettings("image-default", "image-default-channel"));
        const plan = {
            ...canvasPlan("image-default"),
            deliverables: [{ ...canvasPlan("image-default").deliverables[0], assetIds: [memoryAsset.id] }],
        };
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/chat/completions")) return Response.json({ output: [{ type: "function_call", name: "create_agent_plan", arguments: JSON.stringify(plan) }] });
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-memory" } });
            if (url.endsWith("/api/image-tasks/child-memory")) return Response.json({ task: { status: "success", result: { remoteUrl: "https://cdn.example.com/continued.png" } } });
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(mocks.listRecentCreativeMediaAssets).toHaveBeenCalledWith("conversation", "user", 6);
        const planningBody = JSON.parse(String(mocks.fetchInternalApi.mock.calls.find(([url]) => String(url).endsWith("/chat/completions"))?.[1]?.body)) as { messages: Array<{ content: string }> };
        expect(JSON.parse(planningBody.messages[1].content)).toMatchObject({
            referenceContext: { source: "conversation-memory-candidates" },
            referencedAssets: [{ id: "asset-memory", title: "上一张角色图" }],
        });
        const createBody = JSON.parse(String(mocks.fetchInternalApi.mock.calls.find(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"))?.[1]?.body));
        expect(createBody.references).toEqual([{ dataUrl: "", url: "https://cdn.example.com/memory.png" }]);
    });

    it("keeps current-turn attachments exclusive and does not mix conversation memory", async () => {
        mocks.run = runFixture({ surface: "chat", projectId: undefined, prompt: "@图片1 保持人物，@图片2 改成夜景", referencedAssetIds: ["asset-first", "asset-second"] });
        mocks.getCreativeAssetsByIds.mockResolvedValue([creativeImageAsset("asset-second", "第二张附件", "https://cdn.example.com/second.png"), creativeImageAsset("asset-first", "第一张附件", "https://cdn.example.com/first.png")]);
        mocks.listRecentCreativeMediaAssets.mockResolvedValue([creativeImageAsset("asset-memory", "历史图片", "https://cdn.example.com/memory.png")]);
        mocks.getAuthSettings.mockResolvedValue(canvasSettings("image-default", "image-default-channel"));
        mocks.fetchInternalApi.mockResolvedValue(Response.json({ output: [{ type: "function_call", name: "create_agent_plan", arguments: JSON.stringify({ ...canvasPlan("image-default"), intent: "conversation", decisions: [], deliverables: [] }) }] }));

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(mocks.listRecentCreativeMediaAssets).not.toHaveBeenCalled();
        const planningBody = JSON.parse(String(mocks.fetchInternalApi.mock.calls[0][1]?.body)) as { messages: Array<{ content: string }> };
        expect(JSON.parse(planningBody.messages[1].content)).toMatchObject({
            referenceContext: { source: "current-turn-explicit" },
            referencedAssets: [
                { id: "asset-first", alias: "@图片1", title: "第一张附件" },
                { id: "asset-second", alias: "@图片2", title: "第二张附件" },
            ],
        });
    });

    it("does not attach an old candidate when the text model plans a new subject", async () => {
        mocks.run = runFixture({ surface: "chat", projectId: undefined, prompt: "新建一个完全独立的海边产品主视觉" });
        mocks.listRecentCreativeMediaAssets.mockResolvedValue([creativeImageAsset("asset-old", "旧角色", "https://cdn.example.com/old.png")]);
        mocks.getAuthSettings.mockResolvedValue(canvasSettings("image-default", "image-default-channel"));
        const plan = { ...canvasPlan("image-default"), deliverables: [{ ...canvasPlan("image-default").deliverables[0], assetIds: [] }] };
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/chat/completions")) return Response.json({ output: [{ type: "function_call", name: "create_agent_plan", arguments: JSON.stringify(plan) }] });
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-new-subject" } });
            if (url.endsWith("/api/image-tasks/child-new-subject")) return Response.json({ task: { status: "success", result: { remoteUrl: "https://cdn.example.com/new.png" } } });
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        const createBody = JSON.parse(String(mocks.fetchInternalApi.mock.calls.find(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"))?.[1]?.body));
        expect(createBody.references).toEqual([]);
        expect(mocks.run?.tasks[0].referenceAssetId).toBeUndefined();
    });

    it("answers ordinary conversation without creating canvas ops or media tasks", async () => {
        mocks.run = planningRun("你在吗？");
        mocks.getAuthSettings.mockResolvedValue(canvasSettings("image-default", "image-default-channel"));
        mocks.fetchInternalApi.mockResolvedValue(
            Response.json({
                output: [
                    {
                        type: "function_call",
                        name: "create_agent_plan",
                        arguments: JSON.stringify({ ...canvasPlan("image-default"), intent: "conversation", reply: "在的，你可以直接和我聊天，也可以让我操作当前画布。", decisions: [], deliverables: [] }),
                    },
                ],
            }),
        );

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(mocks.run?.status).toBe("completed");
        expect(mocks.run?.tasks).toEqual([]);
        expect(mocks.events.some((event) => event.type === "canvas.ops")).toBe(false);
        expect(mocks.events.find((event) => event.type === "run.completed")?.data).toMatchObject({ completed: 0, reply: "在的，你可以直接和我聊天，也可以让我操作当前画布。" });
        expect(mocks.fetchInternalApi.mock.calls.some(([url]) => /\/api\/(?:image|video|audio|text)-tasks/.test(String(url)))).toBe(false);
    });

    it("falls back to structured Chat Completions when Responses returns prose", async () => {
        mocks.run = planningRun("你在吗？");
        mocks.getAuthSettings.mockResolvedValue(canvasSettings("image-default", "image-default-channel"));
        mocks.fetchInternalApi.mockImplementation(async (url: string) => {
            if (url.endsWith("/responses")) return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "在的，你可以直接告诉我想创作什么。" }] }] });
            if (url.endsWith("/chat/completions")) return Response.json({ choices: [{ message: { content: JSON.stringify(conversationPlan("image-default", "在的，你可以直接告诉我想创作什么。")) } }] });
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(mocks.run?.status).toBe("completed");
        expect(mocks.events.find((event) => event.type === "run.completed")?.data).toMatchObject({ completed: 0, reply: "在的，你可以直接告诉我想创作什么。" });
        expect(mocks.refundUserPoints).not.toHaveBeenCalled();
    });

    it("rejects an unstructured prose planner response instead of pretending generation completed", async () => {
        const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
        mocks.run = planningRun("你在吗？");
        mocks.getAuthSettings.mockResolvedValue(canvasSettings("image-default", "image-default-channel"));
        mocks.fetchInternalApi.mockImplementation(async (url: string) => {
            if (url.endsWith("/responses")) return new Response("unsupported", { status: 404 });
            if (url.endsWith("/chat/completions")) return Response.json({ choices: [{ message: { content: "在的，需要我帮你做什么？" } }] });
            throw new Error(`unexpected request: ${url}`);
        });

        try {
            await executeAndReview(mocks.run, "http://localhost", "session=test");
            expect(mocks.run?.status).toBe("failed");
            expect(mocks.events.some((event) => event.type === "run.completed")).toBe(false);
            expect(diagnostic).toHaveBeenCalledTimes(2);
            for (const [message, details] of diagnostic.mock.calls) {
                expect(message).toBe("[text-planning] structured response has no readable result");
                expect(JSON.parse(String(details))).toMatchObject({ protocol: "chat", tool: "create_agent_plan", choices: 1, messageKeys: ["content"], toolCalls: 0 });
            }
        } finally {
            diagnostic.mockRestore();
        }
    });

    it("does not submit a second planning request when the Responses outcome is unknown", async () => {
        mocks.run = planningRun("你在吗？");
        mocks.getAuthSettings.mockResolvedValue(canvasSettings("image-default", "image-default-channel"));
        const timeoutController = new AbortController();
        timeoutController.abort(new DOMException("timed out", "TimeoutError"));
        const timeoutCalls: number[] = [];
        const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
            timeoutCalls.push(milliseconds);
            return timeoutController.signal;
        });
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/chat/completions")) {
                expect(init?.signal?.aborted).toBe(true);
                throw new DOMException("timed out", "TimeoutError");
            }
            throw new Error(`unexpected request: ${url}`);
        });

        try {
            await executeAndReview(mocks.run, "http://localhost", "session=test");
        } finally {
            timeoutSpy.mockRestore();
        }

        expect(timeoutCalls).toContain(3 * 60_000);
        expect(mocks.fetchInternalApi.mock.calls.map(([url]) => String(url))).toEqual([expect.stringMatching(/\/chat\/completions$/)]);
        expect(mocks.run?.status).toBe("failed");
        expect(mocks.events.some((event) => event.type === "run.completed")).toBe(false);
    });

    it("switches to a healthy planning channel after a 5xx response", async () => {
        mocks.run = planningRun("你在吗？");
        mocks.getAuthSettings.mockResolvedValue(plannerFailoverSettings("image-default", "image-default-channel"));
        mocks.fetchInternalApi.mockImplementation(async (url: string) => {
            if (url.includes("/planner-primary/") && (url.endsWith("/responses") || url.endsWith("/chat/completions"))) return new Response("unavailable", { status: 502 });
            if (url.includes("/planner-backup/") && url.endsWith("/chat/completions"))
                return Response.json({ output: [{ type: "function_call", name: "create_agent_plan", arguments: JSON.stringify(conversationPlan("image-default", "备用规划渠道已接管。")) }] });
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(mocks.fetchInternalApi.mock.calls.some(([url]) => String(url).includes("/planner-primary/"))).toBe(true);
        expect(mocks.fetchInternalApi.mock.calls.some(([url]) => String(url).includes("/planner-backup/"))).toBe(true);
        expect(mocks.run?.status).toBe("completed");
        expect(mocks.events.some((event) => event.type === "run.completed")).toBe(true);
    });

    it("automatically switches to the next planning model after a timeout", async () => {
        mocks.run = planningRun("你在吗？");
        mocks.getAuthSettings.mockResolvedValue(plannerFailoverSettings("image-default", "image-default-channel"));
        mocks.fetchInternalApi.mockImplementation(async (url: string) => {
            if (url.includes("/planner-primary/") && url.endsWith("/chat/completions")) throw new DOMException("timed out", "TimeoutError");
            if (url.includes("/planner-backup/") && url.endsWith("/chat/completions"))
                return Response.json({ output: [{ type: "function_call", name: "create_agent_plan", arguments: JSON.stringify(conversationPlan("image-default", "备用文本模型已自动接管。")) }] });
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        const primaryCalls = mocks.fetchInternalApi.mock.calls.filter(([url]) => String(url).includes("/planner-primary/"));
        const backupCalls = mocks.fetchInternalApi.mock.calls.filter(([url]) => String(url).includes("/planner-backup/"));
        expect(primaryCalls).toHaveLength(1);
        expect(backupCalls).toHaveLength(1);
        expect(mocks.run?.status).toBe("completed");
        expect(mocks.events.some((event) => event.type === "run.completed")).toBe(true);
    });

    it("plans chat media without canvas ops, links the child task and registers a stable asset", async () => {
        mocks.run = runFixture({ surface: "chat", projectId: undefined, prompt: "把这张图改成红色服装", referencedAssetIds: ["asset-source", "asset-style"], requestedImageSize: "1080x1213" });
        mocks.getCreativeAssetsByIds.mockResolvedValue([
            {
                id: "asset-source",
                userId: "user",
                conversationId: "conversation",
                ordinal: 0,
                type: "image",
                status: "ready",
                title: "参考角色",
                remoteUrl: "https://cdn.example.com/source.png",
                metadata: {},
                createdAt: 1,
                updatedAt: 1,
            },
            {
                id: "asset-style",
                userId: "user",
                conversationId: "conversation",
                ordinal: 1,
                type: "image",
                status: "ready",
                title: "风格参考",
                remoteUrl: "https://cdn.example.com/style.png",
                metadata: {},
                createdAt: 1,
                updatedAt: 1,
            },
        ]);
        mocks.getAuthSettings.mockResolvedValue(canvasSettings("image-default", "image-default-channel"));
        const plan = { ...canvasPlan("image-default"), deliverables: [{ ...canvasPlan("image-default").deliverables[0], assetIds: ["asset-source", "asset-style"] }] };
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/chat/completions")) return Response.json({ output: [{ type: "function_call", name: "create_agent_plan", arguments: JSON.stringify(plan) }] });
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-chat" } });
            if (url.endsWith("/api/image-tasks/child-chat")) return Response.json({ task: { status: "success", result: { dataUrl: "data:image/png;base64,abc", remoteUrl: "https://cdn.example.com/result.png", mimeType: "image/png" } } });
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(mocks.events.some((event) => event.type === "canvas.ops")).toBe(false);
        expect(mocks.events.some((event) => event.type === "run.planned")).toBe(true);
        expect(mocks.events.find((event) => event.type === "task.completed")?.data).not.toMatchObject({ ops: expect.anything() });
        expect(mocks.linkStoredGenerationTask).toHaveBeenCalledWith("image", "child-chat", {
            conversationId: "conversation",
            runId: "agent-run",
            surface: "chat",
            projectId: undefined,
            parentTaskId: "agent-run",
            attemptNo: 1,
        });
        expect(mocks.registerCreativeAssets).toHaveBeenCalledWith([expect.objectContaining({ sourceTaskId: "child-chat", parentAssetId: "asset-source", remoteUrl: "https://cdn.example.com/result.png", messageId: "assistant-message" })]);
        expect(mocks.registerCreativeAssets.mock.calls[0][0][0]).not.toHaveProperty("dataUrl");
        expect(mocks.run?.assetIds).toEqual(["asset-0"]);
        const createCall = mocks.fetchInternalApi.mock.calls.find(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"));
        expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({ source: "agent", config: { size: "1080x1213" }, references: [{ url: "https://cdn.example.com/source.png" }, { url: "https://cdn.example.com/style.png" }] });
    });

    it("uses completed dependency assets as real references for downstream video", async () => {
        mocks.run = runWithTasks([imageTask("image-one"), { id: "video-one", title: "角色动画", type: "video", model: "video-model", prompt: "让角色缓慢转身", count: 1, dependencies: ["image-one"], status: "ready", attempts: 0 }]);
        const nextSettings = settings("image-model", "image-channel") as unknown as {
            defaultModels: { videoModel: string };
            systemChannels: Array<Record<string, unknown>>;
            logicalModels: Array<Record<string, unknown>>;
        };
        nextSettings.defaultModels.videoModel = "video-model";
        nextSettings.systemChannels.push({ id: "video-channel", name: "视频", enabled: true, baseUrl: "https://api.example.com/v1", apiKey: "video-secret", models: ["vendor/video-model"] });
        nextSettings.logicalModels.push({ id: "video-model", name: "视频", capability: "video", enabled: true, bindings: [{ id: "video-binding", channelId: "video-channel", upstreamModel: "vendor/video-model", enabled: true, priority: 1 }] });
        mocks.getAuthSettings.mockResolvedValue(nextSettings as never);
        mocks.getCreativeAssetsByIds.mockImplementation(async (ids?: string[]) =>
            ids?.includes("asset-0")
                ? [
                      {
                          id: "asset-0",
                          userId: "user",
                          conversationId: "conversation",
                          sourceTaskId: "child-image",
                          ordinal: 0,
                          type: "image",
                          status: "ready",
                          title: "角色图",
                          remoteUrl: "https://cdn.example.com/dependency.png",
                          metadata: {},
                          createdAt: 1,
                          updatedAt: 1,
                      },
                  ]
                : [],
        );
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-image" } });
            if (url.endsWith("/api/image-tasks/child-image")) return Response.json({ task: { status: "success", result: { remoteUrl: "https://cdn.example.com/dependency.png" } } });
            if (init?.method === "POST" && url.endsWith("/api/video-generation-tasks")) return Response.json({ task: { id: "child-video" } });
            if (url.endsWith("/api/video-tasks/child-video")) return Response.json({ task: { status: "success", result: { remoteUrl: "https://cdn.example.com/dependency.mp4" } } });
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        const videoCall = mocks.fetchInternalApi.mock.calls.find(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/video-generation-tasks"));
        expect(JSON.parse(String(videoCall?.[1]?.body))).toMatchObject({ references: [{ type: "image", url: "https://cdn.example.com/dependency.png" }] });
        expect(mocks.run?.tasks[1]).toMatchObject({ status: "completed", referenceAssetId: "asset-0", references: [{ assetId: "asset-0", url: "https://cdn.example.com/dependency.png", type: "image" }] });
    });

    it("dispatches explicit video frame roles unchanged to the video route", async () => {
        mocks.run = runFixture({
            surface: "chat",
            projectId: undefined,
            status: "running",
            reviewed: true,
            tasks: [
                {
                    id: "video-frames",
                    title: "首尾衔接视频",
                    type: "video",
                    model: "video-model",
                    prompt: "自然运镜",
                    count: 1,
                    dependencies: [],
                    status: "ready",
                    attempts: 0,
                    references: [
                        { assetId: "first-image", type: "image", url: "https://cdn.example.com/first.png", role: "first_frame" },
                        { assetId: "last-image", type: "image", url: "https://cdn.example.com/last.png", role: "last_frame" },
                    ],
                },
            ],
        });
        const nextSettings = settings("image-model", "image-channel") as unknown as {
            defaultModels: { videoModel: string };
            systemChannels: Array<Record<string, unknown>>;
            logicalModels: Array<Record<string, unknown>>;
        };
        nextSettings.defaultModels.videoModel = "video-model";
        nextSettings.systemChannels.push({ id: "video-channel", name: "视频", enabled: true, baseUrl: "https://api.example.com/v1", apiKey: "video-secret", models: ["vendor/video-model"] });
        nextSettings.logicalModels.push({ id: "video-model", name: "视频", capability: "video", enabled: true, bindings: [{ id: "video-binding", channelId: "video-channel", upstreamModel: "vendor/video-model", enabled: true, priority: 1 }] });
        mocks.getAuthSettings.mockResolvedValue(nextSettings as never);
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (init?.method === "POST" && url.endsWith("/api/video-generation-tasks")) return Response.json({ task: { id: "child-video-frames" } });
            if (url.endsWith("/api/video-tasks/child-video-frames")) return Response.json({ task: { status: "success", result: { remoteUrl: "https://cdn.example.com/result.mp4" } } });
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        const videoCall = mocks.fetchInternalApi.mock.calls.find(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/video-generation-tasks"));
        expect(JSON.parse(String(videoCall?.[1]?.body))).toMatchObject({
            references: [
                { type: "image", url: "https://cdn.example.com/first.png", role: "first_frame" },
                { type: "image", url: "https://cdn.example.com/last.png", role: "last_frame" },
            ],
        });
    });

    it("passes explicit video flags and audio speed to child task routes", async () => {
        mocks.run = runWithTasks([
            { id: "video-one", title: "产品视频", type: "video", model: "video-model", prompt: "生成产品视频", count: 1, ratio: "21:9", quality: "2160", seconds: 60, generateAudio: false, watermark: true, dependencies: [], status: "ready", attempts: 0 },
            { id: "audio-one", title: "产品旁白", type: "audio", model: "audio-model", prompt: "生成产品旁白", count: 1, voice: "nova", format: "wav", speed: 1.25, dependencies: [], status: "ready", attempts: 0 },
        ]);
        const nextSettings = settings("image-model", "image-channel") as unknown as {
            defaultModels: { videoModel: string; audioModel: string };
            systemChannels: Array<Record<string, unknown>>;
            logicalModels: Array<Record<string, unknown>>;
        };
        nextSettings.defaultModels.videoModel = "video-model";
        nextSettings.defaultModels.audioModel = "audio-model";
        nextSettings.systemChannels.push(
            { id: "video-channel", name: "视频", enabled: true, baseUrl: "https://api.example.com/v1", apiKey: "video-secret", models: ["vendor/video-model"] },
            { id: "audio-channel", name: "音频", enabled: true, baseUrl: "https://api.example.com/v1", apiKey: "audio-secret", models: ["vendor/audio-model"] },
        );
        nextSettings.logicalModels.push(
            { id: "video-model", name: "视频", capability: "video", enabled: true, bindings: [{ id: "video-binding", channelId: "video-channel", upstreamModel: "vendor/video-model", enabled: true, priority: 1 }] },
            { id: "audio-model", name: "音频", capability: "audio", enabled: true, bindings: [{ id: "audio-binding", channelId: "audio-channel", upstreamModel: "vendor/audio-model", enabled: true, priority: 1 }] },
        );
        mocks.getAuthSettings.mockResolvedValue(nextSettings as never);
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (init?.method === "POST" && url.endsWith("/api/video-generation-tasks")) return Response.json({ task: { id: "child-video" } });
            if (init?.method === "POST" && url.endsWith("/api/audio-tasks")) return Response.json({ task: { id: "child-audio" } });
            if (url.endsWith("/api/video-tasks/child-video")) return Response.json({ task: { status: "success", result: { remoteUrl: "https://cdn.example.com/result.mp4" } } });
            if (url.endsWith("/api/audio-tasks/child-audio")) return Response.json({ task: { status: "success", result: { remoteUrl: "https://cdn.example.com/result.wav" } } });
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        const videoCall = mocks.fetchInternalApi.mock.calls.find(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/video-generation-tasks"));
        const audioCall = mocks.fetchInternalApi.mock.calls.find(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/audio-tasks"));
        expect(JSON.parse(String(videoCall?.[1]?.body))).toMatchObject({ config: { size: "21:9", vquality: "2160", videoSeconds: "60", videoGenerateAudio: "false", videoWatermark: "true" } });
        expect(JSON.parse(String(audioCall?.[1]?.body))).toMatchObject({ config: { voice: "nova", format: "wav", speed: "1.25" } });
    });

    it("passes drama project context to planning without creating canvas operations", async () => {
        mocks.run = runFixture({ surface: "drama", projectId: "drama-project", snapshot: { episodeId: "episode-one" }, prompt: "这个角色为什么要离开？" });
        mocks.getAuthSettings.mockResolvedValue(canvasSettings("image-default", "image-default-channel"));
        mocks.fetchInternalApi.mockResolvedValue(
            Response.json({
                output: [{ type: "function_call", name: "create_agent_plan", arguments: JSON.stringify({ ...canvasPlan("image-default"), intent: "conversation", reply: "因为当前冲突迫使角色主动离开。", decisions: [], deliverables: [] }) }],
            }),
        );

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        const planningBody = JSON.parse(String(mocks.fetchInternalApi.mock.calls[0][1]?.body)) as { messages: Array<{ content: string }> };
        expect(JSON.parse(planningBody.messages[1].content)).toMatchObject({ surface: "drama", projectId: "drama-project", projectSnapshot: { episodeId: "episode-one" } });
        expect(mocks.events.some((event) => event.type === "canvas.ops")).toBe(false);
        expect(mocks.run?.status).toBe("completed");
    });

    it("emits an idempotent project handoff for chat without creating media tasks", async () => {
        mocks.run = runFixture({ surface: "chat", projectId: undefined, prompt: "把这些内容建立成短剧项目", referencedAssetIds: ["asset-source"] });
        const sourceAsset = {
            id: "asset-source",
            userId: "user",
            conversationId: "conversation",
            ordinal: 0,
            type: "image",
            status: "ready",
            title: "女主设定",
            remoteUrl: "https://cdn.example.com/hero.png",
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
        };
        mocks.getCreativeAssetsByIds.mockResolvedValue([sourceAsset]);
        mocks.getAuthSettings.mockResolvedValue(canvasSettings("image-default", "image-default-channel"));
        const plan = {
            ...canvasPlan("image-default"),
            deliverables: [],
            projectHandoff: { surface: "drama", title: "都市悬疑", summary: "女主追查失踪案", style: "写实电影感", ratio: "9:16", assetIds: ["asset-source"] },
        };
        mocks.fetchInternalApi.mockResolvedValue(Response.json({ output: [{ type: "function_call", name: "create_agent_plan", arguments: JSON.stringify(plan) }] }));

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(mocks.fetchInternalApi.mock.calls.some(([url]) => /\/api\/(?:image|video|audio|text)-tasks/.test(String(url)))).toBe(false);
        expect(mocks.events.find((event) => event.type === "project.handoff")?.data).toMatchObject({
            id: "handoff-agent-run",
            surface: "drama",
            title: "都市悬疑",
            assetIds: ["asset-source"],
            assets: [expect.objectContaining({ id: "asset-source" })],
        });
        expect(mocks.events.filter((event) => event.type === "project.handoff")).toHaveLength(1);
        expect(mocks.events.find((event) => event.type === "run.completed")?.data).toMatchObject({ projectHandoff: { id: "handoff-agent-run" } });
        expect(mocks.run).toMatchObject({ status: "completed", projectHandoffEmitted: true });
    });

    it("ignores an invalid project handoff attached to an ordinary image plan", async () => {
        mocks.run = planningRun("生成森林女子角色设定图");
        mocks.getAuthSettings.mockResolvedValue(canvasSettings("image-default", "image-default-channel"));
        const plan = {
            ...canvasPlan("image-default"),
            projectHandoff: { surface: "canvas", title: "", ratio: "1:1", assetIds: [""] },
        };
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/chat/completions")) return Response.json({ output: [{ type: "function_call", name: "create_agent_plan", arguments: JSON.stringify(plan) }] });
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-image" } });
            if (url.endsWith("/api/image-tasks/child-image")) return Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/forest.png" } } });
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(mocks.run).toMatchObject({ status: "completed", projectHandoff: undefined });
        expect(mocks.fetchInternalApi.mock.calls.some(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"))).toBe(true);
        expect(mocks.events.some((event) => event.type === "project.handoff")).toBe(false);
    });

    it("falls back to the backend default when the planned model is invalid", async () => {
        mocks.run = planningRun();
        mocks.getAuthSettings.mockResolvedValue(canvasSettings("image-default", "image-default-channel"));
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/responses")) return new Response("unsupported endpoint", { status: 404 });
            if (url.endsWith("/chat/completions")) return Response.json({ choices: [{ message: { content: JSON.stringify(canvasPlan("forged-upstream-model")) } }] });
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-default" } });
            if (url.endsWith("/api/image-tasks/child-default")) return Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/default.png" } } });
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        const createCall = mocks.fetchInternalApi.mock.calls.find(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"));
        const createBody = JSON.parse(String(createCall?.[1]?.body)) as { config: { model: string } };
        expect(createBody.config.model).toBe("image-default");
        expect(mocks.run?.tasks[0].model).toBe("image-default");
    });

    it("refunds text planning cost when chat fallback returns prose instead of structured JSON", async () => {
        const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
        mocks.run = planningRun();
        mocks.getAuthSettings.mockResolvedValue(canvasSettings("image-default", "image-default-channel"));
        mocks.fetchInternalApi.mockImplementation(async (url: string) => {
            if (url.endsWith("/responses")) return new Response("unsupported endpoint", { status: 404 });
            if (url.endsWith("/chat/completions")) return Response.json({ choices: [{ message: { content: "我建议使用横版构图。" } }] }, { headers: { "x-vozeb-pro-points-cost": "2", "x-vozeb-pro-points-record-id": "points-agent-plan" } });
            throw new Error(`unexpected request: ${url}`);
        });

        try {
            await executeAndReview(mocks.run, "http://localhost", "session=test");
            expect(mocks.refundUserPoints).toHaveBeenCalledWith("user", "planner", 2, "text", 1, undefined, "points-agent-plan");
            expect(mocks.run).toMatchObject({
                status: "failed",
                failureStage: "planning",
                failure: expect.any(String),
                candidateFailures: [{ channelId: "planner-channel", upstreamModel: "vendor/planner", error: expect.any(String) }],
            });
            expect(diagnostic).toHaveBeenCalledTimes(2);
            for (const [message, details] of diagnostic.mock.calls) {
                expect(message).toBe("[text-planning] structured response has no readable result");
                expect(JSON.parse(String(details))).toMatchObject({ protocol: "chat", tool: "create_agent_plan", choices: 1, messageKeys: ["content"], toolCalls: 0 });
            }
        } finally {
            diagnostic.mockRestore();
        }
    });

    it("refunds a zero-cost planning record when persisting the conversation reply fails", async () => {
        mocks.run = planningRun("你在吗？");
        mocks.getAuthSettings.mockResolvedValue(canvasSettings("image-default", "image-default-channel"));
        mocks.fetchInternalApi.mockResolvedValue(
            Response.json(
                { output: [{ type: "function_call", name: "create_agent_plan", arguments: JSON.stringify(conversationPlan("image-default", "在的。")) }] },
                { headers: { "x-vozeb-pro-points-cost": "0", "x-vozeb-pro-points-record-id": "points-agent-free" } },
            ),
        );
        mocks.updateAgentRunById.mockImplementation(async (_id, patch, event, allowedStatuses, expectedExecutionId) => {
            if (!mocks.run || (allowedStatuses && !allowedStatuses.includes(mocks.run.status)) || (expectedExecutionId && mocks.run.executionId !== expectedExecutionId)) return null;
            if (event?.type === "run.completed") throw new Error("conversation persistence failed");
            mocks.run = { ...mocks.run, ...patch };
            if (event) mocks.events.push(event);
            return mocks.run;
        });

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(mocks.refundUserPoints).toHaveBeenCalledWith("user", "planner", 0, "text", 1, undefined, "points-agent-free");
        expect(mocks.run?.status).toBe("failed");
    });

    it("refunds a completed planning call when the run is cancelled before persistence", async () => {
        mocks.run = planningRun("你在吗？");
        mocks.getAuthSettings.mockResolvedValue(canvasSettings("image-default", "image-default-channel"));
        mocks.fetchInternalApi.mockImplementation(async () => {
            mocks.run = mocks.run ? { ...mocks.run, status: "cancelled" } : null;
            return Response.json(
                { output: [{ type: "function_call", name: "create_agent_plan", arguments: JSON.stringify(conversationPlan("image-default", "在的。")) }] },
                { headers: { "x-vozeb-pro-points-cost": "3", "x-vozeb-pro-points-record-id": "points-agent-cancelled" } },
            );
        });

        await executeAndReview(mocks.run, "http://localhost", "session=test");

        expect(mocks.refundUserPoints).toHaveBeenCalledWith("user", "planner", 3, "text", 1, undefined, "points-agent-cancelled");
        expect(mocks.run?.status).toBe("cancelled");
    });
});

async function frozenReferenceFixture(action: "confirm_purposes" | "retry_analysis") {
    const product = { ...creativeImageAsset("asset-product", "product.png", ""), type: "image" as const, status: "ready" as const, sourceRunId: "upload", remoteUrl: undefined, serverUrl: "/api/reference-assets/product.png" };
    const source = await sharp({ create: { width: 64, height: 48, channels: 3, background: "white" } })
        .png()
        .toBuffer();
    const base = runFixture({ surface: "chat", projectId: undefined, prompt: "修改图片1", referencedAssetIds: [product.id], generationPreferences: { mode: "image" } });
    const planningInput = buildEcommercePlanningInput(base, [product], { summary: "frozen summary", recentMessages: [] });
    const legacy = ecommerceAnalysis("product");
    const analysis = {
        ...legacy,
        analysisVersion: "ecommerce-visual-analysis.v4" as const,
        references: legacy.references.map(({ role: _role, ...reference }) => ({ ...reference, contentType: "isolated_product" as const, visibleStructure: [], cues: [] })),
        purposeSuggestions: [],
        rawAnalysis: {},
        normalizationAudit: [],
    };
    const checkpoint = referenceSourcesLoaded(createEcommerceReferenceCheckpoint(base, planningInput, [product]), [{ assetId: product.id, contentSha256: createHash("sha256").update(source).digest("hex"), sourceSize: { width: 64, height: 48 } }]);
    checkpoint.state = "consumed";
    checkpoint.consumption = { id: "consumption-one", action, acceptedAt: 1, actorId: base.userId };
    if (action === "confirm_purposes") {
        checkpoint.analysis = analysis;
        checkpoint.decision = resolveEcommerceReferenceDecision({ planningInput, analysis });
        checkpoint.analysisStage.state = "completed";
    } else checkpoint.analysisStage.state = "created";
    const run: AgentRun = {
        ...base,
        ecommerceSnapshot: {
            version: "ecommerce-generation.v1",
            mode: "active",
            runId: base.id,
            userId: base.userId,
            input: { userRequest: base.prompt, conversationId: base.conversationId, surface: "chat", assetIds: [product.id] },
            referenceCheckpoint: checkpoint,
            createdAt: 1,
        },
    };
    return { product, source, analysis, run };
}

function ecommerceSettings() {
    const value = settings("image-model", "image-channel") as unknown as {
        systemChannels: Array<{ id: string; apiFormat?: string; models: string[] }>;
        logicalModels: Array<{ id: string; bindings: Array<{ upstreamModel: string }> }>;
        ecommerceGenerationEnabled?: boolean;
        ecommerceVisualQualityCheckEnabled?: boolean;
    };
    value.ecommerceGenerationEnabled = true;
    value.ecommerceVisualQualityCheckEnabled = true;
    const channel = value.systemChannels.find((item) => item.id === "image-channel");
    const model = value.logicalModels.find((item) => item.id === "image-model");
    if (!channel || !model) throw new Error("missing ecommerce image fixture");
    channel.apiFormat = "openai";
    channel.models = ["gpt-image-2.5-flare"];
    model.bindings[0].upstreamModel = "gpt-image-2.5-flare";
    return value as never;
}

function ecommerceSettingsWithQualityFallback() {
    const value = ecommerceSettings() as unknown as {
        systemChannels: Array<Record<string, unknown>>;
        logicalModels: Array<Record<string, unknown>>;
        ecommerceModelRoles?: Record<string, string[]>;
    };
    value.systemChannels.push({
        id: "quality-fallback-channel",
        name: "Quality fallback",
        enabled: true,
        apiFormat: "openai",
        baseUrl: "https://api.example.com/v1",
        apiKey: "quality-fallback-secret",
        models: ["gpt-5.6-sol"],
    });
    value.logicalModels.push({
        id: "quality-fallback",
        name: "Quality fallback",
        capability: "text",
        enabled: true,
        bindings: [{ id: "quality-fallback-binding", channelId: "quality-fallback-channel", upstreamModel: "gpt-5.6-sol", enabled: true, priority: 1 }],
    });
    value.ecommerceModelRoles = { quality_check: ["planner", "quality-fallback"] };
    return value as never;
}

function ecommerceAnalysis(role: "product" | "unknown") {
    return {
        analysisVersion: "ecommerce-visual-analysis.v1" as const,
        modelRole: {
            logicalRole: "vision_analysis" as const,
            logicalModelId: "planner",
            channelId: "planner-channel",
            upstreamModel: "vendor/planner",
        },
        references: [
            role === "product"
                ? {
                      assetId: "asset-product",
                      role,
                      confidence: "high" as const,
                      visualEvidence: { whiteBackground: true, transparentBackground: false, isolatedSubject: true, completeScene: false },
                      productFacts: { identity: "chair", outline: "chair", color: "oak", material: "wood", brandText: [], view: "front" },
                      sceneFacts: null,
                      productCore: { x: 0.3, y: 0.2, width: 0.4, height: 0.6 },
                      fusionHalo: { x: 0.25, y: 0.15, width: 0.5, height: 0.7 },
                      editableTargets: [],
                  }
                : {
                      assetId: "asset-unknown",
                      role,
                      confidence: "low" as const,
                      visualEvidence: { whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: false },
                      productFacts: null,
                      sceneFacts: null,
                      productCore: null,
                      fusionHalo: null,
                      editableTargets: [],
                  },
        ],
    };
}

function ecommercePlan() {
    return {
        planVersion: "ecommerce-edit.v1" as const,
        operation: "product_to_scene" as const,
        source: { productAnchorId: "asset-product", currentSceneBaselineId: null, sceneReferenceIds: [] },
        baseline: {
            productFacts: { identity: "chair", outline: "chair", color: "oak", material: "wood", brandText: [], view: "front" },
            sceneFacts: { space: "living room", composition: "eye level", lighting: "soft daylight" },
        },
        delta: { requestedChanges: ["place in room"], targetObjects: ["scene"], targetRegions: ["background"] },
        preserve: { productCore: ["outline", "brand_text", "color", "material", "scale", "view"], sceneElements: [] },
        strategy: "strict_product" as const,
        modelRoles: { visionAnalysis: "vision-role-private", editPlanning: "planner", generation: "image-model", qualityCheck: "planner" },
        continuity: { parentResultId: null, branchId: "ecommerce-agent-run" },
        validation: { requiredChecks: ["product_identity"] },
    };
}

function passedQualityCheck() {
    return {
        version: "ecommerce-quality.v1" as const,
        status: "passed" as const,
        publicStatus: "passed" as const,
        modelRole: { logicalRole: "quality_check" as const, capability: "text" as const, logicalModelId: "planner", channelId: "planner-channel", upstreamModel: "vendor/planner", apiFormat: "openai" as const },
        checks: [],
        hardFailures: [],
        internalReason: "all required checks passed",
        checkedAt: 1,
    };
}

function blockedQualityCheck() {
    return {
        ...passedQualityCheck(),
        status: "blocked" as const,
        publicStatus: "needs_review" as const,
        checks: [{ resultId: "child-blocked", key: "product_silhouette" as const, status: "failed" as const, reason: "product silhouette changed" }],
        hardFailures: [{ resultId: "child-blocked", key: "product_silhouette" as const, status: "failed" as const, reason: "product silhouette changed" }],
        internalReason: "product silhouette changed",
    };
}

function ecommerceLocalAnalysis() {
    return {
        analysisVersion: "ecommerce-visual-analysis.v1" as const,
        modelRole: { logicalRole: "vision_analysis" as const, logicalModelId: "planner", channelId: "planner-channel", upstreamModel: "vendor/planner" },
        references: [
            {
                assetId: "scene-result",
                role: "scene" as const,
                confidence: "high" as const,
                visualEvidence: { whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: true },
                productFacts: null,
                sceneFacts: { space: "living room", composition: "eye level", lighting: "soft daylight" },
                productCore: { x: 0.4, y: 0.25, width: 0.2, height: 0.5 },
                fusionHalo: { x: 0.35, y: 0.2, width: 0.3, height: 0.6 },
                editableTargets: [
                    { id: "background-main", kind: "background" as const, label: "main background", region: { x: 0, y: 0, width: 1, height: 1 } },
                    { id: "plant-left", kind: "prop" as const, label: "left plant", region: { x: 0.02, y: 0.2, width: 0.2, height: 0.58 } },
                    { id: "plant-right", kind: "prop" as const, label: "right plant", region: { x: 0.72, y: 0.2, width: 0.2, height: 0.58 } },
                ],
            },
            {
                assetId: "product-anchor",
                role: "product" as const,
                confidence: "high" as const,
                visualEvidence: { whiteBackground: true, transparentBackground: false, isolatedSubject: true, completeScene: false },
                productFacts: { identity: "chair", outline: "chair", color: "oak", material: "wood", brandText: [], view: "front" },
                sceneFacts: null,
                productCore: { x: 0.3, y: 0.2, width: 0.4, height: 0.6 },
                fusionHalo: { x: 0.25, y: 0.15, width: 0.5, height: 0.7 },
                editableTargets: [],
            },
        ],
    };
}

function ecommerceLocalPlan(targetObjects: string[], request = "把背景换成厨房") {
    return {
        ...ecommercePlan(),
        operation: "local_edit" as const,
        source: { productAnchorId: "product-anchor", currentSceneBaselineId: "scene-result", sceneReferenceIds: [] },
        baseline: {
            productFacts: { identity: "chair", outline: "chair", color: "oak", material: "wood", brandText: [], view: "front" },
            sceneFacts: { space: "living room", composition: "eye level", lighting: "soft daylight" },
        },
        delta: { requestedChanges: [request], targetObjects, targetRegions: [] },
        continuity: { parentResultId: "scene-result", branchId: "ecommerce-agent-run" },
    };
}

function ecommerceSceneAnalysis() {
    return {
        analysisVersion: "ecommerce-visual-analysis.v1" as const,
        modelRole: {
            logicalRole: "vision_analysis" as const,
            logicalModelId: "planner",
            channelId: "planner-channel",
            upstreamModel: "vendor/planner",
        },
        references: [
            {
                assetId: "asset-scene",
                role: "scene" as const,
                confidence: "high" as const,
                visualEvidence: { whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: true },
                productFacts: null,
                sceneFacts: { space: "living room", composition: "eye level", lighting: "soft daylight" },
                productCore: null,
                fusionHalo: null,
                editableTargets: [
                    {
                        id: "lighting-main",
                        kind: "lighting" as const,
                        label: "main scene lighting",
                        region: { x: 0, y: 0, width: 1, height: 1 },
                    },
                ],
            },
        ],
    };
}

function ecommerceScenePlan() {
    return {
        ...ecommercePlan(),
        operation: "scene_edit" as const,
        source: { productAnchorId: null, currentSceneBaselineId: "asset-scene", sceneReferenceIds: [] },
        baseline: {
            productFacts: null,
            sceneFacts: { space: "living room", composition: "eye level", lighting: "soft daylight" },
        },
        delta: { requestedChanges: ["winter sunlight"], targetObjects: ["lighting-main"], targetRegions: ["whole-scene"] },
        preserve: { productCore: [], sceneElements: ["layout", "furniture", "camera"] },
        strategy: "integrated_scene" as const,
        validation: { requiredChecks: ["requested_edit", "scene_preservation", "composition_lighting"] },
    };
}
