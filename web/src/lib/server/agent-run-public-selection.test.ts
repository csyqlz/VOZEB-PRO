import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRun } from "./agent-run-store";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CreativeReferenceReviewPanel } from "@/app/(user)/create/components/creative-reference-review-panel";

const mocks = vi.hoisted(() => ({ assets: vi.fn(), fetch: vi.fn() }));
vi.mock("./creative-runtime-store", () => ({ getCreativeAssetsByIds: mocks.assets }));
vi.mock("./internal-origin", () => ({ fetchInternalApi: mocks.fetch, resolveInternalOrigin: (origin: string) => origin }));
import { publicAgentRunForRequest, publicAgentRunSnapshotForRequest } from "./agent-run-public-selection";
import { resolveEcommerceReferenceDecision } from "./ecommerce-reference-purpose";
import type { EcommerceVisualAnalysisV4 } from "./ecommerce-visual-analysis";
import { confirmedReferenceDecision } from "./ecommerce-reference-recovery";
import type { StoredGenerationTaskRecord } from "./generation-task-types";

const taskRecords = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("./generation-task-store", () => ({ listStoredGenerationTaskRecordsByRunIds: taskRecords.list }));

const request = new Request("http://fixture.local/api/agent/runs/run", { headers: { cookie: "fixture-session" } });
const asset = { id: "scene", userId: "user", conversationId: "conversation", type: "image", status: "ready", serverUrl: "/api/reference-assets/scene.png", width: 999, height: 999, metadata: { private: "private-marker" } };
describe("original run status recovery action", () => {
    it.each(["pending", "running"] as const)("exposes a status action for the confirmed unsubmitted %s mask child", async (status) => {
        const run = {
            id: "run",
            userId: "user",
            conversationId: "conversation",
            surface: "chat",
            status: "paused",
            assetIds: [],
            tasks: [{ id: "image", type: "image", status: "needs_review", attempts: 1, count: 1, taskId: "same-child" }],
        } as unknown as AgentRun;
        taskRecords.list.mockResolvedValue([
            {
                id: "same-child",
                type: "image",
                userId: "user",
                runId: run.id,
                conversationId: run.conversationId,
                status,
                executionPhase: "needs_review",
                lastUpstreamStatus: "strict_product_mask_review_required",
                payload: {
                    runId: run.id,
                    kind: "edit",
                    attempts: [],
                    references: [{ id: "scene" }],
                    mask: { dataUrl: "alpha-mask" },
                    sceneProtection: { sourceAssetId: "scene", selectionSource: "user_selection", mask: { dataUrl: "alpha-mask" } },
                    ecommerceExecution: { protection: { scope: "local" }, mask: { required: true }, referenceRoles: [{ assetId: "scene" }] },
                    config: { apiFormat: "openai", model: "gpt-image-2.5-sunburst", advancedConfig: { protocol: "sub2api" } },
                },
            },
        ]);
        const view = await publicAgentRunForRequest(run, request);
        expect(view.canCheckStatus).toBe(true);
        expect(view.ecommerceSceneSelection).toBeUndefined();
        expect(view.id).toBe(run.id);
        expect(JSON.stringify(view)).not.toContain("alpha-mask");
    });
    it.each(["created", "created_attempted", "created_submitted", "created_billing", "created_result", "created_lease", "created_changed", "created_unknown", "polling", "completed", "changed", "unknown", "owner", "run", "conversation", "missing"])(
        "keeps recovery available with an owned %s sibling only when every child can continue safely",
        async (state) => {
            const run = {
                id: "run",
                userId: "user",
                conversationId: "conversation",
                surface: "chat",
                status: "paused",
                assetIds: [],
                tasks: [
                    {
                        id: "image",
                        type: "image",
                        status: "needs_review",
                        attempts: 1,
                        count: 2,
                        taskIds: ["private-source", "private-sibling"],
                        childTasks: [
                            { id: "private-source", status: "needs_review", attempt: 1 },
                            { id: "private-sibling", status: "needs_review", attempt: 1 },
                        ],
                    },
                ],
            } as unknown as AgentRun;
            const source = {
                id: "private-source",
                type: "image",
                userId: "user",
                runId: run.id,
                conversationId: run.conversationId,
                status: "running",
                executionPhase: "needs_review",
                lastUpstreamStatus: "reference_source_unavailable",
                payload: { runId: run.id, referenceDispatch: { inputId: "private-input" }, attempts: [] },
                resultPayload: { reviewReason: "参考图片暂时无法读取" },
            } as unknown as StoredGenerationTaskRecord;
            const sibling = {
                ...source,
                id: "private-sibling",
                executionPhase: state === "completed" ? "completed" : "polling",
                status: state === "completed" ? "success" : "running",
                upstreamTaskId: "private-upstream",
                submittedAt: 1,
                payload: { attempts: [{ attemptNo: 1 }], billing: {}, upstream: { id: "private-upstream" } },
            } as StoredGenerationTaskRecord;
            if (state.startsWith("created")) {
                sibling.status = "pending";
                sibling.executionPhase = "created";
                sibling.upstreamTaskId = undefined;
                sibling.submittedAt = undefined;
                sibling.payload = { ...source.payload };
                sibling.resultPayload = undefined;
                sibling.lastUpstreamStatus = "created";
                if (state === "created_attempted") sibling.payload.attempts = [{ attemptNo: 1 }];
                if (state === "created_submitted") sibling.submittedAt = 1;
                if (state === "created_billing") sibling.payload.billing = {};
                if (state === "created_result") sibling.payload.result = { serverUrl: "/private-result" };
                if (state === "created_lease") sibling.workerId = "other-worker";
                if (state === "created_changed") sibling.lastUpstreamStatus = "reference_source_changed";
                if (state === "created_unknown") sibling.lastUpstreamStatus = "submission_outcome_unknown";
            }
            if (state === "changed" || state === "unknown") {
                sibling.executionPhase = "needs_review";
                sibling.upstreamTaskId = undefined;
                sibling.submittedAt = undefined;
                sibling.payload = { ...source.payload };
                sibling.lastUpstreamStatus = state === "changed" ? "reference_source_changed" : "submission_outcome_unknown";
            }
            if (state === "owner") sibling.userId = "other";
            if (state === "run") sibling.runId = "other";
            if (state === "conversation") sibling.conversationId = "other";
            taskRecords.list.mockResolvedValue(state === "missing" ? [source] : [source, sibling]);
            const before = structuredClone(run);
            const http = await publicAgentRunForRequest(run, request);
            const snapshot = await publicAgentRunSnapshotForRequest(run, request);
            const expected = ["created", "polling", "completed"].includes(state);
            expect(http.canCheckStatus).toBe(expected);
            expect(snapshot.canCheckStatus).toBe(expected);
            expect(run).toEqual(before);
            expect(JSON.stringify({ http, snapshot })).not.toMatch(/private-source|private-sibling|private-upstream|private-input|referenceDispatch/);
            expect(taskRecords.list).toHaveBeenCalledWith([run.id], [run.userId]);
        },
    );
    it.each(["source", "validation", "upstream", "changed", "unknown", "attempted", "submitted", "billing", "result", "owner", "run", "conversation", "cancelled", "quality", "lease"])(
        "exposes a checkable boolean only for the recoverable original %s child",
        async (state) => {
            const run = {
                id: "run",
                userId: "user",
                conversationId: "conversation",
                surface: "chat",
                status: "paused",
                assetIds: [],
                tasks: [{ id: "image", type: "image", status: "needs_review", attempts: 1, taskIds: ["private-child"], childTasks: [{ id: "private-child", status: "needs_review", attempt: 1 }] }],
            } as unknown as AgentRun;
            const record = {
                id: "private-child",
                type: "image",
                userId: "user",
                runId: run.id,
                conversationId: run.conversationId,
                status: "running",
                executionPhase: "needs_review",
                expiresAt: Date.now() + 10_000,
                lastUpstreamStatus: state === "validation" ? "reference_validation_unavailable" : "reference_source_unavailable",
                payload: { runId: run.id, referenceDispatch: { inputId: "private-input" }, attempts: [] },
                resultPayload: { reviewReason: "参考图片暂时无法读取" },
            } as unknown as StoredGenerationTaskRecord;
            if (state === "upstream") {
                record.lastUpstreamStatus = "submission_outcome_unknown";
                record.upstreamTaskId = "private-upstream";
                record.submittedAt = 1;
            }
            if (state === "changed") record.lastUpstreamStatus = "reference_source_changed";
            if (state === "unknown") record.lastUpstreamStatus = "submission_outcome_unknown";
            if (state === "attempted") record.payload.attempts = [{ attemptNo: 1 }];
            if (state === "submitted") record.submittedAt = 1;
            if (state === "billing") record.payload.billing = {};
            if (state === "result") record.payload.result = { serverUrl: "/private-result" };
            if (state === "owner") record.userId = "other";
            if (state === "run") record.runId = "other";
            if (state === "conversation") record.conversationId = "other";
            if (state === "cancelled") run.cancellation = { requestedAt: 1, pendingChildTaskIds: [] };
            if (state === "quality") run.ecommerceSnapshot = { qualityCheck: {} } as never;
            if (state === "lease") record.workerId = "other-worker";
            taskRecords.list.mockResolvedValue([record]);
            const expected = ["source", "validation", "upstream"].includes(state);
            const http = await publicAgentRunForRequest(run, request);
            const snapshot = await publicAgentRunSnapshotForRequest(run, request);
            expect(http).toHaveProperty("canCheckStatus", expected);
            expect(snapshot).toHaveProperty("canCheckStatus", expected);
            expect(JSON.stringify({ http, snapshot })).not.toMatch(/private-child|private-upstream|private-input|referenceDispatch/);
        },
    );
});
function waitingRun(version = "ecommerce-edit.v4"): AgentRun {
    return {
        id: "run",
        userId: "user",
        conversationId: "conversation",
        surface: "chat",
        status: "paused",
        tasks: [{ id: "task", status: "needs_review", attempts: 0, ecommerceExecution: { state: "ready", prompt: "compiledPrompt-private" } }],
        ecommerceSnapshot: {
            version: "ecommerce-generation.v1",
            mode: "active",
            fallback: { reason: "scene_selection_required" },
            plan: {
                planVersion: version,
                ...(version === "ecommerce-edit.v5" ? { photography: { private: "photography-private" } } : {}),
                operation: "scene_edit",
                protection: { scope: "local", preserveOutsideMask: true },
                source: { currentSceneBaselineId: "scene" },
                canvas: { mode: "exact", size: { width: 6, height: 4 } },
                delta: { manualRegion: { x: 0, y: 0, width: 1, height: 1 } },
            },
        },
    } as unknown as AgentRun;
}
describe("owned public scene selection action", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        mocks.assets.mockResolvedValue([asset]);
        const bytes = await sharp({ create: { width: 6, height: 4, channels: 3, background: "blue" } })
            .png()
            .toBuffer();
        mocks.fetch.mockResolvedValue(new Response(bytes, { headers: { "content-type": "image/png" } }));
    });
    it.each(["ecommerce-edit.v3", "ecommerce-edit.v4", "ecommerce-edit.v5"])("offers only real decoded owned media for a legal %s pause", async (version) => {
        const run = waitingRun(version);
        const before = structuredClone(run);
        const expected = { action: "confirm_scene_selection", baselineAssetId: "scene", url: "/api/reference-assets/scene.png", width: 6, height: 4 };
        expect(await publicAgentRunForRequest(run, request)).toMatchObject({ ecommerceSceneSelection: expected });
        mocks.fetch.mockResolvedValue(
            new Response(
                await sharp({ create: { width: 6, height: 4, channels: 3, background: "blue" } })
                    .png()
                    .toBuffer(),
                { headers: { "content-type": "image/png" } },
            ),
        );
        expect(await publicAgentRunSnapshotForRequest(run, request)).toMatchObject({ id: "run", ecommerceSceneSelection: expected });
        expect(mocks.assets).toHaveBeenCalledWith(["scene"], "user");
        expect(run).toEqual(before);
        expect(JSON.stringify(await publicAgentRunForRequest(run, request))).not.toMatch(/compiledPrompt|manualRegion|private-marker|photography-private/);
    });
    it("projects only a stable media pathname and drops unrelated private URL parameters", async () => {
        mocks.assets.mockResolvedValue([{ ...asset, serverUrl: "/api/reference-assets/scene.png?format=webp&width=2&private=private-marker#private" }]);
        const projected = await publicAgentRunForRequest(waitingRun(), request);
        expect(projected.ecommerceSceneSelection?.url).toBe("/api/reference-assets/scene.png");
        expect(JSON.stringify(projected)).not.toContain("private-marker");
    });
    it.each(["v1", "v2", "running", "child", "taskIds", "attempted", "confirmed", "qa", "other_pause", "global", "cancelled", "legacy"])("does not expose an action for %s", async (state) => {
        const run = waitingRun();
        if (state === "v1" || state === "v2") run.ecommerceSnapshot!.plan!.planVersion = `ecommerce-edit.${state}` as never;
        if (state === "running") run.status = "running";
        if (state === "child") run.tasks[0].childTasks = [{ id: "submitted" }] as never;
        if (state === "taskIds") run.tasks[0].taskIds = ["submitted"];
        if (state === "attempted") run.tasks[0].attempts = 1;
        if (state === "confirmed") run.tasks[0].sceneProtection = {} as never;
        if (state === "qa") run.ecommerceSnapshot!.qualityCheck = {} as never;
        if (state === "other_pause") run.ecommerceSnapshot!.fallback!.reason = "provider_unsupported";
        if (state === "global") run.ecommerceSnapshot!.plan!.protection!.scope = "global";
        if (state === "cancelled") run.cancellation = { requestedAt: 1, pendingChildTaskIds: [] };
        if (state === "legacy") run.ecommerceSnapshot!.mode = "legacy";
        expect((await publicAgentRunForRequest(run, request)).ecommerceSceneSelection).toBeUndefined();
        expect(mocks.assets).not.toHaveBeenCalled();
        expect(mocks.fetch).not.toHaveBeenCalled();
    });
    it.each(["owner", "conversation", "unreadable", "canvas", "remote"])("hides the action when baseline %s cannot be proved", async (state) => {
        const run = waitingRun();
        if (state === "owner") mocks.assets.mockResolvedValue([{ ...asset, userId: "other" }]);
        if (state === "conversation") mocks.assets.mockResolvedValue([{ ...asset, conversationId: "other" }]);
        if (state === "unreadable") mocks.fetch.mockRejectedValue(new Error("private-fetch-error"));
        if (state === "canvas") run.ecommerceSnapshot!.plan!.canvas!.size.width = 8;
        if (state === "remote") mocks.assets.mockResolvedValue([{ ...asset, serverUrl: undefined, remoteUrl: "https://private.example/asset" }]);
        expect((await publicAgentRunForRequest(run, request)).ecommerceSceneSelection).toBeUndefined();
        expect(JSON.stringify(await publicAgentRunForRequest(run, request))).not.toContain("private-fetch-error");
    });
});

describe("owned public reference review", () => {
    const ownedAssets = [
        { ...asset, id: "product", serverUrl: "/api/reference-assets/product.png?format=webp&width=120&private=private-marker" },
        { ...asset, id: "scene", serverUrl: "/api/reference-assets/scene.png?format=webp&width=120&private=private-marker" },
    ];
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.assets.mockResolvedValue(ownedAssets);
    });

    it("projects the same actionable purpose review whitelist for HTTP and SSE snapshots", async () => {
        const run = referenceReviewRun(ownedAssets);
        const before = structuredClone(run);
        const expected = {
            version: "ecommerce-reference-review.v1",
            reviewId: "reference-review-one",
            kind: "confirm_purposes",
            question: expect.any(String),
            assets: [
                { assetId: "product", assetVersion: "product-version", alias: "图片1", previewUrl: "/api/reference-assets/product.png", purposes: [], allowedPurposes: ["edit_target", "product_identity"] },
                { assetId: "scene", assetVersion: "scene-version", alias: "图片2", previewUrl: "/api/reference-assets/scene.png", purposes: [], allowedPurposes: ["lighting"] },
            ],
        };
        const http = await publicAgentRunForRequest(run, request);
        const snapshot = await publicAgentRunSnapshotForRequest(run, request);
        expect(http).toMatchObject({ ecommerceReferenceReview: expected });
        expect(snapshot).toMatchObject({ ecommerceReferenceReview: expected });
        expect(http.ecommerceReferenceReview).toEqual(snapshot.ecommerceReferenceReview);
        expect(Object.keys(http.ecommerceReferenceReview!).sort()).toEqual(["assets", "kind", "question", "reviewId", "version"]);
        expect(JSON.stringify(http)).not.toMatch(/contentSha256|vision-private|issue-private|private-marker|referenceCheckpoint|rawAnalysis|source-url-private/);
        expect(run).toEqual(before);
    });

    it("projects an owned inherited target for the same lighting-only binding the real resolver accepts", async () => {
        const { run, assets } = inheritedReferenceReviewRun();
        mocks.assets.mockResolvedValue(assets);
        const before = structuredClone(run);
        const projection = await publicAgentRunForRequest(run, request);
        const review = projection.ecommerceReferenceReview!;
        expect(review.kind).toBe("confirm_purposes");
        const decision = confirmedReferenceDecision(run.ecommerceSnapshot!.referenceCheckpoint!, {
            action: "confirm_purposes",
            reviewId: review.reviewId,
            decisionVersion: "ecommerce-reference-decision.v1",
            bindings: review.assets.map((item) => ({ assetId: item.assetId, assetVersion: item.assetVersion, purposes: ["lighting"] })),
        });
        expect(decision?.decision).toMatchObject({ state: "resolved", editTargetId: "current", productAnchorId: "original", issues: [] });
        expect(review).toMatchObject({ assets: [{ assetId: "auxiliary", allowedPurposes: ["lighting"] }], inheritedEditTarget: { assetId: "current", previewUrl: "/api/reference-assets/current.png" } });
        expect((await publicAgentRunSnapshotForRequest(run, request)).ecommerceReferenceReview).toEqual(review);
        expect(run).toEqual(before);
        expect(JSON.stringify(review)).not.toMatch(/contentSha256|rawAnalysis|private-marker|referenceCheckpoint/);
    });

    it("enables the real panel for a lighting-only reference with an inherited target while preserving the server's unique target", async () => {
        const { run, assets } = inheritedReferenceReviewRun();
        mocks.assets.mockResolvedValue(assets);
        const projected = (await publicAgentRunForRequest(run, request)).ecommerceReferenceReview!;
        // This is the public contract requested by the previous test; no target
        // or product purpose is added to the auxiliary image's submitted binding.
        const unselected = renderToStaticMarkup(createElement(CreativeReferenceReviewPanel, { runId: run.id, review: { ...projected, assets: projected.assets.map((item) => ({ ...item, purposes: [] })) }, onRecover: async () => undefined }));
        expect(unselected.match(/<button\b[^>]*>/)?.[0]).toContain("disabled");
        const review = { ...projected, assets: projected.assets.map((item) => ({ ...item, purposes: ["lighting" as const] })) };
        const markup = renderToStaticMarkup(createElement(CreativeReferenceReviewPanel, { runId: run.id, review, onRecover: async () => undefined }));
        expect(markup.match(/<button\b[^>]*>/)?.[0]).not.toContain("disabled");
        expect(markup).toContain("继续修改当前图片");
        expect(markup).toContain("/api/reference-assets/current.png");
        expect(markup).toContain("参考光线");
        expect(markup).not.toContain("保留商品身份");
    });

    it("offers analysis retry for low lighting evidence without allowing a high style cue to confirm lighting", async () => {
        const run = referenceReviewRun(ownedAssets, "low-lighting");
        const projection = await publicAgentRunForRequest(run, request);
        expect(projection.ecommerceReferenceReview).toMatchObject({ kind: "retry_analysis", reviewId: "reference-review-one" });
        expect(projection.ecommerceReferenceReview!.assets[1]).toMatchObject({ purposes: ["style", "lighting"], allowedPurposes: ["style"] });
        expect(projection.ecommerceReferenceReview!.question).toContain("光线");
        expect(JSON.stringify(projection)).not.toContain("issue-private");
    });

    it("offers analysis retry for exhausted service failures while hiding raw attempts and source URLs", async () => {
        const run = referenceReviewRun(ownedAssets, "service-failure");
        const projection = await publicAgentRunForRequest(run, request);
        expect(projection.ecommerceReferenceReview).toMatchObject({ kind: "retry_analysis", reviewId: "reference-review-one" });
        expect(JSON.stringify(projection)).not.toMatch(/vision-private|service-private|source-url-private|rawAnalysis|attempts/);
    });

    it.each([false, true])("offers purpose confirmation only when two product references have a legal assignment (reliable cue: %s)", async (hasCue) => {
        const run = referenceReviewRun(ownedAssets);
        const checkpoint = run.ecommerceSnapshot!.referenceCheckpoint!;
        const analysis = checkpoint.analysis!;
        analysis.references[1] = { ...structuredClone(analysis.references[0]), assetId: "scene", cues: hasCue ? [{ id: "second-light", facet: "lighting", description: "soft light", confidence: "high" }] : [] };
        checkpoint.decision = resolveEcommerceReferenceDecision({ planningInput: checkpoint.planningInput, analysis });
        expect(checkpoint.decision.issues.every((issue) => ["reference_expression_unresolved", "edit_target_required", "reference_purpose_required"].includes(issue.code))).toBe(true);
        const before = structuredClone(checkpoint);
        const projection = await publicAgentRunForRequest(run, request);
        expect(projection.ecommerceReferenceReview?.kind).toBe(hasCue ? "confirm_purposes" : "retry_analysis");
        if (!hasCue) expect(projection.ecommerceReferenceReview?.question).toContain("重新分析");
        expect(checkpoint).toEqual(before);
    });

    it.each(["consumed", "running", "cancelled", "submitted", "result", "quality", "wrong-owner", "wrong-conversation", "changed-source"])("explicitly clears reference review when %s", async (state) => {
        const run = referenceReviewRun(ownedAssets);
        if (state === "consumed") (run.ecommerceSnapshot!.referenceCheckpoint as { state: string }).state = "consumed";
        if (state === "running") run.status = "running";
        if (state === "cancelled") run.cancellation = { requestedAt: 1, pendingChildTaskIds: [] };
        if (state === "submitted") run.tasks[0].taskId = "child";
        if (state === "result") run.assetIds = ["result"];
        if (state === "quality") run.ecommerceSnapshot!.qualityCheck = {} as never;
        if (state === "wrong-owner") mocks.assets.mockResolvedValue(ownedAssets.map((value) => ({ ...value, userId: "other" })));
        if (state === "wrong-conversation") mocks.assets.mockResolvedValue(ownedAssets.map((value) => ({ ...value, conversationId: "other" })));
        if (state === "changed-source") mocks.assets.mockResolvedValue(ownedAssets.map((value) => ({ ...value, serverUrl: "/api/reference-assets/replaced.png" })));
        expect((await publicAgentRunForRequest(run, request)).ecommerceReferenceReview).toBeNull();
        expect((await publicAgentRunSnapshotForRequest(run, request)).ecommerceReferenceReview).toBeNull();
    });
});

function referenceReviewRun(assets: Array<typeof asset>, mode?: "low-lighting" | "service-failure"): AgentRun {
    const planningInput = {
        userRequest: mode === "low-lighting" ? "参考图片2的风格和光线，修改图片1" : "图片1和图片2",
        conversationId: "conversation",
        surface: "chat" as const,
        referenceAliases: [
            { assetId: "product", alias: "图片1" },
            { assetId: "scene", alias: "图片2" },
        ],
        assetCandidates: assets.map((value) => ({ id: value.id, title: value.id, type: "image" as const, url: value.serverUrl })),
        conversationContext: { summary: "source-url-private", recentMessages: [] },
    };
    const analysis: EcommerceVisualAnalysisV4 = {
        analysisVersion: "ecommerce-visual-analysis.v4",
        modelRole: { logicalRole: "vision_analysis", logicalModelId: "vision-private", channelId: "vision-private", upstreamModel: "vision-private" },
        rawAnalysis: { internal: "rawAnalysis-private" },
        normalizationAudit: [],
        purposeSuggestions: [],
        references: [
            {
                assetId: "product",
                contentType: "isolated_product",
                confidence: "high",
                visualEvidence: { whiteBackground: true, transparentBackground: false, isolatedSubject: true, completeScene: false },
                productFacts: { identity: "oak table", outline: "round top and legs", color: "oak", material: "wood", brandText: [], view: "front" },
                sceneFacts: null,
                productCore: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 },
                fusionHalo: { x: 0.1, y: 0.1, width: 0.7, height: 0.7 },
                editableTargets: [],
                visibleStructure: [],
                cues: [],
            },
            {
                assetId: "scene",
                contentType: "product_detail",
                confidence: "medium",
                visualEvidence: { whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: false },
                productFacts: null,
                sceneFacts: null,
                productCore: null,
                fusionHalo: null,
                editableTargets: [],
                visibleStructure: [],
                cues: [
                    { id: "light", facet: "lighting", description: "soft light", confidence: mode === "low-lighting" ? "low" : "high" },
                    ...(mode === "low-lighting" ? [{ id: "style", facet: "style" as const, description: "simple style", confidence: "high" as const }] : []),
                ],
            },
        ],
    };
    const decision = resolveEcommerceReferenceDecision({ planningInput, analysis });
    decision.issues.forEach((issue) => (issue.message = "issue-private"));
    const failure =
        mode === "service-failure"
            ? { analysisVersion: "ecommerce-visual-analysis.v4", kind: "service_unavailable", attempts: [{ modelRole: analysis.modelRole, kind: "service_unavailable", status: 503, elapsedMs: 1, failureCode: "service-private" }] }
            : undefined;
    return {
        id: "run",
        userId: "user",
        conversationId: "conversation",
        inputMessageId: "input-original",
        assistantMessageId: "assistant-original",
        surface: "chat",
        status: "paused",
        assetIds: [],
        tasks: [{ id: "placeholder", status: "needs_review", attempts: 0 }],
        ecommerceSnapshot: {
            version: "ecommerce-generation.v1",
            mode: "active",
            fallback: { reason: mode === "service-failure" ? "visual_analysis_unavailable" : mode === "low-lighting" ? "reference_cue_unreliable" : "reference_purpose_confirmation_required" },
            ...(mode === "service-failure" ? { visualAnalysisFailure: failure } : { visualAnalysis: analysis, referenceDecision: decision }),
            referenceCheckpoint: {
                version: "ecommerce-reference-checkpoint.v1",
                reviewId: "reference-review-one",
                inputId: "input-one",
                decisionId: "decision-one",
                state: "needs_review",
                planningInput,
                analysisStage: { requestId: "analysis-one", state: mode === "service-failure" ? "failed" : "completed" },
                assets: assets.map((value, index) => ({ asset: value, assetVersion: index ? "scene-version" : "product-version", alias: index ? "图片2" : "图片1", contentSha256: "contentSha256-private" })),
                ...(mode === "service-failure" ? { failure } : { analysis, decision }),
            },
        },
    } as unknown as AgentRun;
}

function inheritedReferenceReviewRun() {
    const assets = ["current", "original", "auxiliary"].map((id) => ({ ...asset, id, serverUrl: `/api/reference-assets/${id}.png` }));
    const run = referenceReviewRun(assets);
    const checkpoint = run.ecommerceSnapshot!.referenceCheckpoint!;
    checkpoint.assets = assets.map((value) => ({ asset: value as never, assetVersion: `${value.id}-version`, alias: value.id === "auxiliary" ? "图片1" : "", contentSha256: "a".repeat(64) }));
    checkpoint.planningInput = { ...checkpoint.planningInput, userRequest: "图片1", referenceAliases: [{ assetId: "auxiliary", alias: "图片1" }], inheritedReferences: { editTargetId: "current", productAnchorId: "original" } };
    const [product, detail] = checkpoint.analysis!.references;
    checkpoint.analysis!.references = [
        {
            ...detail,
            assetId: "current",
            contentType: "interior_scene",
            confidence: "high",
            visualEvidence: { whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: true },
            sceneFacts: { space: "living room", composition: "eye level", lighting: "soft daylight" },
            cues: [],
        },
        { ...product, assetId: "original" },
        { ...detail, assetId: "auxiliary" },
    ];
    checkpoint.analysis!.purposeSuggestions = [{ assetId: "auxiliary", purposes: ["lighting"], confidence: "high" }];
    checkpoint.decision = resolveEcommerceReferenceDecision({ planningInput: checkpoint.planningInput, analysis: checkpoint.analysis! });
    return { run, assets };
}
