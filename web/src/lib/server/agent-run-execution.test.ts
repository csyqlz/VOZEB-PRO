import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSettings } from "@/lib/auth/store";
import { emptyAdvancedConfig } from "@/lib/channel-protocol-registry";
import type { EcommerceEditPlan } from "./ecommerce-edit-plan";
import type { AgentRunTask } from "./agent-run-store";
import type { ImageTask, StoredImageTaskMediaResult } from "./image-task-store";
import { compileEcommerceImageRequest, resolveEcommerceImageProviderProfile } from "./ecommerce-image-compiler";
import { routeEcommerceRole } from "./ecommerce-model-routing";
import { toSystemGenerationChannel } from "./generation-channel";
import { buildSceneEditProtection } from "./ecommerce-product-regions";

const boundary = vi.hoisted(() => ({ request: vi.fn(), create: vi.fn(), poll: vi.fn(), structured: vi.fn(), refund: vi.fn(), rejectedBytes: new Set<string>(), unreadableStoredBytes: new Set<string>(), settings: {} as AuthSettings }));
vi.mock("./database", async (original) => ({ ...(await original<typeof import("./database")>()), getDatabaseProvider: () => "file" }));
vi.mock("@/lib/auth/store", async (original) => ({ ...(await original<typeof import("@/lib/auth/store")>()), getAuthSettings: async () => boundary.settings, refundUserPoints: boundary.refund }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: async () => ({ id: "batch-user", role: "user" }) }));
vi.mock("./internal-origin", async (original) => ({ ...(await original<typeof import("./internal-origin")>()), fetchInternalApi: boundary.request }));
vi.mock("./safe-outbound-fetch", () => ({
    fetchSafeOutbound: () => {
        throw new Error("fixture forbids external requests");
    },
}));
vi.mock("@/app/api/image-tasks/image-task-openai", () => ({ runOpenAiImageTask: boundary.create }));
vi.mock("@/app/api/image-tasks/image-task-support", async (original) => ({
    ...(await original<typeof import("@/app/api/image-tasks/image-task-support")>()),
    pollOpenAiImageTask: boundary.poll,
    inlineRemoteImageResult: async (dataUrl: string, _origin: string, _auth: string, remoteUrl?: string) => (dataUrl.startsWith("data:image/") ? { dataUrl, remoteUrl } : null),
}));
vi.mock("./text-planning-runtime", async (original) => ({ ...(await original<typeof import("./text-planning-runtime")>()), requestStructuredText: boundary.structured }));
vi.mock("./object-storage-service", async (original) => ({
    ...(await original<typeof import("./object-storage-service")>()),
    persistExternalMediaIfEnabled: async ({ bytes }: { bytes: Buffer }) => {
        if (boundary.rejectedBytes.has(bytes.toString("base64"))) throw new Error("private-storage-detail");
        return null;
    },
}));
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), after: vi.fn() }));

import { imageTask, settings } from "./agent-run-executor.test-fixtures";

describe("agent canvas batch evidence through real file/runtime/QA services", () => {
    let directory: string;
    let childIds: string[];
    let nativeResults: Array<{ dataUrl: string; remoteUrl?: string }>;
    let legacyEmptyResults: boolean;
    let legacyResult: { shape: "top_level" | "media_list"; knownSize: boolean } | undefined;
    let childBeforeQuality: ImageTask | undefined;
    let baseline: string;
    let getPublicImageTask: typeof import("@/app/api/image-tasks/[id]/route").GET;
    let recoverPublicImageTask: typeof import("@/app/api/image-tasks/[id]/route").POST;
    let runTaskWithRetry: typeof import("./agent-run-execution").runTaskWithRetry;
    let executeTasks: typeof import("./agent-run-execution").executeTasks;
    let createAgentRun: typeof import("./agent-run-store").createAgentRun;
    let getAgentRun: typeof import("./agent-run-store").getAgentRun;
    let updateAgentRunById: typeof import("./agent-run-store").updateAgentRunById;
    let publicAgentRun: typeof import("./agent-run-public").publicAgentRun;
    let publicAgentRunEvent: typeof import("./agent-run-public").publicAgentRunEvent;
    let createCreativeConversation: typeof import("./creative-runtime-store").createCreativeConversation;
    let listCreativeRunEvents: typeof import("./creative-runtime-store").listCreativeRunEvents;
    let listCreativeMessages: typeof import("./creative-runtime-store").listCreativeMessages;
    let schedulePreparedImageTask: typeof import("./ecommerce-image-task-orchestration").schedulePreparedImageTask;
    let getStoredGenerationTaskRecord: typeof import("./generation-task-store").getStoredGenerationTaskRecord;
    let createImageTask: typeof import("./image-task-store").createImageTask;
    let getImageTask: typeof import("./image-task-store").getImageTask;
    let updateImageTask: typeof import("./image-task-store").updateImageTask;
    let createImageTaskUpstreamStep: typeof import("./image-task-runtime").createImageTaskUpstreamStep;
    let persistImageTaskResult: typeof import("./image-task-runtime").persistImageTaskResult;
    let queryImageTaskUpstreamStep: typeof import("./image-task-runtime").queryImageTaskUpstreamStep;
    let localAssetUrlToPath: typeof import("./generation-log-repository").localAssetUrlToPath;
    let listGenerationLogs: typeof import("./generation-log-store").listGenerationLogs;
    let ECOMMERCE_QUALITY_CHECK_KEYS: typeof import("./ecommerce-quality-check").ECOMMERCE_QUALITY_CHECK_KEYS;
    const structure = [{ objectId: "cabinet", feature: "drawers" as const, count: 3, certainty: "confirmed" as const, evidenceRegion: { x: 0, y: 0, width: 120, height: 160 } }];
    const observation = { readable: true, logo: "absent", packagingText: "absent", visibleStructure: structure };

    beforeAll(async () => {
        directory = await mkdtemp(join(tmpdir(), "vozeb-agent-batch-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
        ({ GET: getPublicImageTask, POST: recoverPublicImageTask } = await import("@/app/api/image-tasks/[id]/route"));
        ({ runTaskWithRetry, executeTasks } = await import("./agent-run-execution"));
        ({ createAgentRun, getAgentRun, updateAgentRunById } = await import("./agent-run-store"));
        ({ publicAgentRun, publicAgentRunEvent } = await import("./agent-run-public"));
        ({ createCreativeConversation, listCreativeRunEvents, listCreativeMessages } = await import("./creative-runtime-store"));
        ({ schedulePreparedImageTask } = await import("./ecommerce-image-task-orchestration"));
        ({ getStoredGenerationTaskRecord } = await import("./generation-task-store"));
        ({ createImageTask, getImageTask, updateImageTask } = await import("./image-task-store"));
        ({ createImageTaskUpstreamStep, persistImageTaskResult, queryImageTaskUpstreamStep } = await import("./image-task-runtime"));
        ({ localAssetUrlToPath } = await import("./generation-log-repository"));
        ({ listGenerationLogs } = await import("./generation-log-store"));
        ({ ECOMMERCE_QUALITY_CHECK_KEYS } = await import("./ecommerce-quality-check"));
    });

    beforeEach(async () => {
        vi.clearAllMocks();
        boundary.rejectedBytes.clear();
        boundary.unreadableStoredBytes.clear();
        boundary.settings = settings("image-model", "image-channel");
        boundary.settings.systemChannels.find((channel) => channel.id === "image-channel")!.models = ["nano-banana-2"];
        boundary.settings.logicalModels.find((model) => model.id === "image-model")!.bindings[0].upstreamModel = "nano-banana-2";
        childIds = [];
        legacyEmptyResults = false;
        legacyResult = undefined;
        childBeforeQuality = undefined;
        baseline = await image(120, 160, "blue");
        boundary.create.mockResolvedValue({ pending: { id: "original-upstream", mediaBaseUrl: "https://fixture.example/media", pollBaseUrl: "http://fixture.local/api/ai/system/image-channel" } });
        boundary.poll.mockImplementation(async () => ({ dataUrl: nativeResults[0].dataUrl, results: nativeResults }));
        boundary.structured.mockImplementation(async ({ messages }) => {
            const content = messages.find((message: { role: string }) => message.role === "user").content;
            const payload = content
                .filter((part: { text?: string }) => part.text?.startsWith("{"))
                .map((part: { text: string }) => JSON.parse(part.text))
                .find((value: { resultIds?: string[] }) => value.resultIds);
            return {
                arguments: JSON.stringify({
                    baselineObservation: observation,
                    results: payload.resultIds.map((resultId: string) => ({
                        resultId,
                        observation,
                        checks: ECOMMERCE_QUALITY_CHECK_KEYS.map((key) => ({ key, status: key === "brand_logo" || key === "packaging_text" ? "not_applicable" : "passed", reason: "fixture observed" })),
                    })),
                }),
                headers: new Headers(),
                protocol: "chat",
                elapsedMs: 1,
            };
        });
        boundary.request.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/api/image-tasks") && init?.method === "POST") {
                const body = JSON.parse(String(init.body));
                const child = await createImageTask({
                    ...body,
                    ...body.context,
                    userId: "batch-user",
                    username: "fixture-user",
                    displayName: "Fixture User",
                    config: { ...body.config, ...toSystemGenerationChannel(routeEcommerceRole(boundary.settings, "image_generation")!) },
                });
                childIds.push(child.id);
                expect(await createImageTaskUpstreamStep(child, "http://fixture.local", "https://public.example", "session=fixture")).toMatchObject({ state: "pending" });
                const submitted = (await getImageTask(child.id))!;
                const step = await queryImageTaskUpstreamStep(submitted, "http://fixture.local", "session=fixture");
                if (step.state === "result_ready") await persistImageTaskResult(submitted, "http://fixture.local", step.resultUrl, "session=fixture");
                else expect(step).toEqual({ state: "completed" });
                if (legacyEmptyResults || legacyResult) {
                    const media = (await getImageTask(child.id))!.result!;
                    const legacyMedia = (item: StoredImageTaskMediaResult, index: number) => ({
                        dataUrl: item.dataUrl,
                        remoteUrl: item.remoteUrl,
                        serverUrl: item.serverUrl,
                        width: item.width,
                        height: item.height,
                        bytes: item.bytes,
                        mimeType: item.mimeType,
                        canvasEvidence: legacyResult?.knownSize === false && index === (legacyResult.shape === "media_list" ? 1 : 0) ? undefined : item.canvasEvidence,
                    });
                    const results = legacyResult?.shape === "media_list" ? media.results!.map(legacyMedia) : [];
                    await updateImageTask(child.id, { result: { ...legacyMedia(media, 0), results } });
                }
                childBeforeQuality = (await getImageTask(child.id))!;
                return Response.json({ task: { id: child.id } });
            }
            if (/\/api\/image-tasks\//.test(url)) return getPublicImageTask(new Request(url), { params: Promise.resolve({ id: url.split("/").at(-1)! }) });
            if (/\/api\/generation-log-assets\//.test(url)) {
                const bytes = await readFile(localAssetUrlToPath(new URL(url).pathname));
                if (boundary.unreadableStoredBytes.has(bytes.toString("base64"))) throw new Error("fixture stored media temporarily unavailable");
                return new Response(new Uint8Array(bytes), { headers: { "content-type": "image/png" } });
            }
            throw new Error("unexpected fixture transport");
        });
    });

    afterAll(async () => {
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    });

    it.each(["disabled", "advisory_blocked", "advisory_unavailable", "advisory_late", "unreadable", "wrong_native"] as const)("delivers before optional background quality while retaining technical gates (%s)", async (condition) => {
        nativeResults = [{ dataUrl: condition === "unreadable" ? "https://fixture.invalid/unreadable.png" : condition === "wrong_native" ? await image(120, 120, "blue") : baseline }];
        const conversation = await createCreativeConversation("batch-user", { surface: "chat" });
        const initial = (await createAgentRun("batch-user", { clientRequestId: `delivery-${condition}`, conversationId: conversation.id, surface: "chat", prompt: "调整光线", assetIds: [], skillIds: [], modelIds: [] })).run;
        const advisory = condition.startsWith("advisory");
        const plan: EcommerceEditPlan = {
            planVersion: "ecommerce-edit.v5",
            operation: "scene_edit",
            source: { productAnchorId: null, currentSceneBaselineId: "scene-root", sceneReferenceIds: [] },
            baseline: { productFacts: null, sceneFacts: { space: "living room", composition: "eye level", lighting: "daylight" } },
            delta: { requestedChanges: ["adjust lighting"], targetObjects: ["lighting"], targetRegions: ["whole-scene"] },
            preserve: { productCore: [], sceneElements: ["cabinet"] },
            strategy: "integrated_scene",
            modelRoles: { visionAnalysis: "planner", editPlanning: "planner", generation: "image-model", qualityCheck: advisory ? "planner" : null },
            continuity: { parentResultId: null, branchId: "delivery-branch" },
            validation: { requiredChecks: ["requested_edit"] },
            canvas: { mode: "exact", size: { width: 120, height: 160 }, source: "baseline", allowReframe: false },
            protection: { scope: "global", protectedObjectIds: ["cabinet"], preserveOutsideMask: false, allowLightingChange: true },
            visibleStructure: structure,
        };
        const task: AgentRunTask = {
            id: "scene-edit",
            title: "scene edit",
            type: "image",
            prompt: "调整光线",
            optimizedPrompt: "调整光线",
            count: 1,
            dependencies: [],
            status: "ready",
            attempts: 0,
            references: [{ assetId: "scene-root", url: baseline, type: "image", ecommerceRole: "scene" }],
            ecommerceExecution: compileEcommerceImageRequest(plan, resolveEcommerceImageProviderProfile(routeEcommerceRole(boundary.settings, "image_generation")!.snapshot)!),
        };
        task.prompt = task.ecommerceExecution!.prompt;
        const run = (await updateAgentRunById(
            initial.id,
            {
                status: "running",
                executionId: "delivery-executor",
                tasks: [task],
                reviewed: !advisory,
                ecommerceSnapshot: {
                    version: "ecommerce-generation.v1",
                    mode: "active",
                    qualityPolicy: advisory ? "advisory" : "disabled",
                    input: { userRequest: initial.prompt, assetIds: ["scene-root"], conversationId: conversation.id, surface: "chat" },
                    plan,
                    createdAt: Date.now(),
                    runId: initial.id,
                    userId: initial.userId,
                },
            },
            undefined,
            ["planning"],
        ))!;
        await executeTasks(run.id, "http://fixture.local", "session=fixture", "delivery-executor", boundary.settings);
        const delivered = (await getAgentRun(run.id))!;
        expect(boundary.structured).not.toHaveBeenCalled();
        expect(boundary.create).toHaveBeenCalledTimes(1);
        if (condition === "unreadable" || condition === "wrong_native") {
            expect(delivered).toMatchObject({ status: "paused", assetIds: [], ecommerceSnapshot: { technicalCheck: { status: condition === "wrong_native" ? "blocked" : "unavailable" } } });
            return;
        }
        expect(delivered).toMatchObject({ status: "completed", ecommerceSnapshot: { technicalCheck: { status: "passed" } } });
        expect(delivered.assetIds).toHaveLength(1);
        expect(publicAgentRun(delivered).assetIds).toEqual(delivered.assetIds);
        const messageBefore = (await listCreativeMessages(conversation.id)).find((message) => message.id === delivered.assistantMessageId);
        const logsBefore = await listGenerationLogs({ userId: "batch-user", includeEcommerceTrace: true });
        expect(logsBefore.items[0]?.ecommerceTrace?.stages.find((stage) => stage.key === "quality_check")).toMatchObject({ status: "not_run", output: { policy: advisory ? "advisory" : "disabled" } });
        const { processAgentRunReview } = await import("./agent-run-execution");
        if (advisory) {
            expect(delivered.reviewStatus).toBe("review_pending");
            expect(await getStoredGenerationTaskRecord("agent", delivered.id)).toMatchObject({ status: "success", executionPhase: "review_pending", nextPollAt: expect.any(Number) });
            const { claimDueGenerationTasks, releaseGenerationTaskLease } = await import("./generation-task-scheduler");
            expect(await claimDueGenerationTasks({ workerId: "fixture-delivery-review", taskIds: [delivered.id] })).toMatchObject([{ id: delivered.id, executionPhase: "review_pending", payload: { status: "completed" } }]);
            await releaseGenerationTaskLease("agent", delivered.id, "fixture-delivery-review", { executionPhase: "review_pending", nextPollAt: Date.now() });
            const originalCall = boundary.structured.getMockImplementation()!;
            if (condition === "advisory_late") {
                let enter!: () => void;
                let release!: () => void;
                const entered = new Promise<void>((resolve) => {
                    enter = resolve;
                });
                const pending = new Promise<void>((resolve) => {
                    release = resolve;
                });
                boundary.structured.mockImplementationOnce(async (input) => {
                    enter();
                    await pending;
                    const response = await originalCall(input);
                    const value = JSON.parse(response.arguments);
                    value.results[0].observation = { ...observation, visibleStructure: [{ ...structure[0], count: 4 }] };
                    return { ...response, arguments: JSON.stringify(value) };
                });
                const firstReview = processAgentRunReview(delivered, "http://fixture.local", "session=fixture");
                await entered;
                try {
                    const current = (await getAgentRun(delivered.id))!;
                    expect(current).toMatchObject({ reviewAttempts: 1, reviewed: false });
                    await processAgentRunReview(current, "http://fixture.local", "session=fixture");
                    const frozen = (await getAgentRun(delivered.id))!;
                    expect(frozen).toMatchObject({ status: "completed", reviewAttempts: 2, reviewed: true, ecommerceSnapshot: { qualityCheck: { status: "passed" } } });
                    const childTrace = (await getImageTask(frozen.tasks[0].taskIds![0]))?.ecommerceTrace;
                    const logTrace = (await listGenerationLogs({ userId: "batch-user", includeEcommerceTrace: true })).items[0]?.ecommerceTrace;
                    const messages = await listCreativeMessages(conversation.id);
                    const events = await listCreativeRunEvents(frozen.id);
                    release();
                    await firstReview;
                    expect(await getAgentRun(frozen.id)).toEqual(frozen);
                    expect((await getImageTask(frozen.tasks[0].taskIds![0]))?.ecommerceTrace).toEqual(childTrace);
                    expect((await listGenerationLogs({ userId: "batch-user", includeEcommerceTrace: true })).items[0]?.ecommerceTrace).toEqual(logTrace);
                    expect(await listCreativeMessages(conversation.id)).toEqual(messages);
                    expect(await listCreativeRunEvents(frozen.id)).toEqual(events);
                    expect(boundary.create).toHaveBeenCalledTimes(1);
                } finally {
                    release();
                    await firstReview;
                }
                return;
            }
            boundary.structured.mockImplementation(async (input) => {
                if (condition === "advisory_unavailable") throw new Error("fixture visual model unavailable");
                const response = await originalCall(input);
                const value = JSON.parse(response.arguments);
                value.results[0].observation = { ...observation, visibleStructure: [{ ...structure[0], count: 4 }] };
                return { ...response, arguments: JSON.stringify(value) };
            });
            await processAgentRunReview(delivered, "http://fixture.local", "session=fixture");
            const checked = (await getAgentRun(delivered.id))!;
            expect(checked).toMatchObject({ status: "completed", assetIds: delivered.assetIds, tasks: [{ status: "completed", attempts: 1 }], ecommerceSnapshot: { qualityCheck: { status: condition === "advisory_blocked" ? "blocked" : "unavailable" } } });
            expect(publicAgentRun(checked)).toMatchObject({ assetIds: delivered.assetIds, ecommerceQualityStatus: "needs_adjustment" });
            expect((await listCreativeMessages(conversation.id)).find((message) => message.id === delivered.assistantMessageId)).toEqual(messageBefore);
            expect(boundary.create).toHaveBeenCalledTimes(1);
            const { attachEcommerceTraceToGenerationLogs } = await import("./generation-log-store");
            const initialTrace = logsBefore.items[0].ecommerceTrace!;
            expect(await attachEcommerceTraceToGenerationLogs(checked.tasks[0].taskIds!, initialTrace, initialTrace)).toEqual({ updated: 0 });
            expect((await listGenerationLogs({ userId: "batch-user", includeEcommerceTrace: true })).items[0].ecommerceTrace?.stages.find((stage) => stage.key === "quality_check")?.status).toBe(
                condition === "advisory_blocked" ? "blocked" : "unavailable",
            );
        } else {
            const staleReview = (await updateAgentRunById(delivered.id, { reviewed: false }, undefined, ["completed"]))!;
            await processAgentRunReview(staleReview, "http://fixture.local", "session=fixture");
            expect(boundary.structured).not.toHaveBeenCalled();
            expect((await getAgentRun(delivered.id))?.reviewed).toBe(true);
        }
    });

    it("persists the pre-submission review reason from the child GET through the agent and assistant", async () => {
        const reason = "当前协议不支持可信独立蒙版，请选择支持局部编辑的模型。";
        const conversation = await createCreativeConversation("batch-user", { surface: "chat" });
        const initial = (await createAgentRun("batch-user", { clientRequestId: "pre-submission-review", conversationId: conversation.id, surface: "chat", prompt: "只修改选区内的花瓶", assetIds: [], skillIds: [], modelIds: [] })).run;
        const run = (await updateAgentRunById(initial.id, { status: "running", executionId: "review-executor", reviewed: true, tasks: [{ ...imageTask("local-edit"), model: "image-model" }] }))!;
        boundary.request.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/api/image-tasks") && init?.method === "POST") {
                const body = JSON.parse(String(init.body));
                const child = await createImageTask({
                    ...body,
                    ...body.context,
                    userId: "batch-user",
                    username: "fixture-user",
                    displayName: "Fixture User",
                    config: { ...body.config, ...toSystemGenerationChannel(routeEcommerceRole(boundary.settings, "image_generation")!) },
                });
                childIds.push(child.id);
                await schedulePreparedImageTask(child, reason);
                return Response.json({ task: { id: child.id } });
            }
            if (/\/api\/image-tasks\//.test(url) && !init?.method) return getPublicImageTask(new Request(url), { params: Promise.resolve({ id: url.split("/").at(-1)! }) });
            throw new Error("unexpected fixture transport");
        });

        await executeTasks(run.id, "http://fixture.local", "session=fixture", "review-executor", boundary.settings);

        const paused = (await getAgentRun(run.id))!;
        expect(paused).toMatchObject({
            status: "paused",
            tasks: [{ status: "needs_review", attempts: 1, taskId: childIds[0], taskIds: childIds, error: reason, childTasks: [{ id: childIds[0], status: "needs_review", attempt: 1, error: reason }] }],
        });
        expect(publicAgentRun(paused).tasks[0]).toMatchObject({ status: "needs_review", error: reason });
        const events = await listCreativeRunEvents(run.id);
        expect(events.map(publicAgentRunEvent)).toEqual(
            expect.arrayContaining([expect.objectContaining({ type: "task.needs_review", data: expect.objectContaining({ error: reason }) }), expect.objectContaining({ type: "run.paused", data: { message: reason } })]),
        );
        expect((await listCreativeMessages(conversation.id)).find((message) => message.id === run.assistantMessageId)).toMatchObject({ content: reason, status: "running" });
        const schedule = await getStoredGenerationTaskRecord("image", childIds[0]);
        expect(schedule).toMatchObject({ executionPhase: "needs_review", lastUpstreamStatus: "strict_product_mask_review_required" });
        expect(schedule?.submittedAt).toBeFalsy();
        expect((await getImageTask(childIds[0]))?.upstream).toBeUndefined();
        await executeTasks(run.id, "http://fixture.local", "session=fixture", "review-executor", boundary.settings);
        expect(await getAgentRun(run.id)).toEqual(paused);
        expect((await listCreativeMessages(conversation.id)).find((message) => message.id === run.assistantMessageId)?.content).toBe(reason);
        expect(childIds).toHaveLength(1);
        expect(boundary.create).not.toHaveBeenCalled();
        expect(boundary.poll).not.toHaveBeenCalled();
    });

    it("resumes the same unsubmitted pending masked child without creating another child", async () => {
        const channel = boundary.settings.systemChannels.find((value) => value.id === "image-channel")!;
        channel.models = ["gpt-image-2.5-flare"];
        channel.advancedConfig = { ...emptyAdvancedConfig(), protocol: "sub2api", supportsReferenceImage: true };
        boundary.settings.logicalModels.find((model) => model.id === "image-model")!.bindings[0].upstreamModel = "gpt-image-2.5-flare";
        const candidate = routeEcommerceRole(boundary.settings, "image_generation")!;
        const config = toSystemGenerationChannel(candidate);
        const source = Buffer.from(baseline.split(",")[1], "base64");
        const region = { x: 20, y: 50, width: 35, height: 30 };
        const sceneProtection = { ...(await buildSceneEditProtection(source, "scene-root", region, ["vase", "contact shadow"], "user_selection")), confirmation: { actorUserId: "batch-user", confirmedAt: Date.now() } };
        const conversation = await createCreativeConversation("batch-user", { surface: "chat" });
        const initial = (await createAgentRun("batch-user", { clientRequestId: "pending-mask-recovery", conversationId: conversation.id, surface: "chat", prompt: "只修改选区内的花瓶", assetIds: [], skillIds: [], modelIds: [] })).run;
        const plan: EcommerceEditPlan = {
            planVersion: "ecommerce-edit.v4",
            operation: "scene_edit",
            source: { productAnchorId: null, currentSceneBaselineId: "scene-root", sceneReferenceIds: [] },
            baseline: { productFacts: null, sceneFacts: { space: "living room", composition: "eye level", lighting: "daylight" } },
            delta: { requestedChanges: ["replace vase"], targetObjects: ["vase"], targetRegions: ["cabinet top"], manualRegion: region },
            preserve: { productCore: [], sceneElements: ["cabinet"] },
            strategy: "integrated_scene",
            modelRoles: { visionAnalysis: "planner", editPlanning: "planner", generation: "image-model", qualityCheck: null },
            continuity: { parentResultId: null, branchId: "pending-mask-branch" },
            validation: { requiredChecks: ["requested_edit"] },
            canvas: { mode: "exact", size: { width: 120, height: 160 }, source: "baseline", allowReframe: false },
            protection: { scope: "local", protectedObjectIds: ["cabinet"], preserveOutsideMask: true, allowLightingChange: false },
        };
        const execution = compileEcommerceImageRequest(plan, resolveEcommerceImageProviderProfile(candidate.snapshot)!);
        expect(execution).toMatchObject({ state: "ready", mask: { mode: "independent", required: true }, modelSnapshot: { imageEdit: { protocol: "sub2api", transport: "json", supportsIndependentMask: true } } });
        const child = await createImageTask({
            userId: initial.userId,
            username: "fixture-user",
            displayName: "Fixture User",
            runId: initial.id,
            conversationId: conversation.id,
            parentTaskId: "local-edit",
            source: "agent",
            kind: "edit",
            prompt: execution.prompt,
            config: { ...config, size: "120x160" },
            references: [{ id: "scene-root", name: "scene.png", dataUrl: baseline, ecommerceRole: "scene" }],
            mask: sceneProtection.mask,
            sceneProtection,
            ecommerceExecution: execution,
            attempts: [],
        });
        const reason = "当前协议不支持可信独立蒙版，请选择支持局部编辑的模型。";
        await schedulePreparedImageTask(child, reason);
        const task: AgentRunTask = {
            ...imageTask("local-edit"),
            prompt: execution.prompt,
            optimizedPrompt: initial.prompt,
            status: "needs_review",
            attempts: 1,
            taskId: child.id,
            taskIds: [child.id],
            childTasks: [{ id: child.id, status: "needs_review", attempt: 1, error: reason }],
            references: [{ assetId: "scene-root", url: baseline, type: "image", ecommerceRole: "scene" }],
            sceneProtection,
            ecommerceExecution: execution,
            error: reason,
        };
        const paused = (await updateAgentRunById(initial.id, {
            status: "paused",
            tasks: [task],
            reviewed: true,
            ecommerceSnapshot: {
                version: "ecommerce-generation.v1",
                mode: "active",
                qualityPolicy: "disabled",
                input: { userRequest: initial.prompt, assetIds: ["scene-root"], conversationId: conversation.id, surface: "chat" },
                plan,
                createdAt: Date.now(),
                runId: initial.id,
                userId: initial.userId,
            },
        }))!;
        expect(await getStoredGenerationTaskRecord("image", child.id)).toMatchObject({ status: "pending", executionPhase: "needs_review" });
        expect((await getImageTask(child.id))?.attempts).toEqual([]);
        const { publicAgentRunForRequest } = await import("./agent-run-public-selection");
        expect(await publicAgentRunForRequest(paused, new Request("http://fixture.local/api/agent-runs/fixture"))).toMatchObject({ canCheckStatus: true });
        boundary.create.mockResolvedValue({ dataUrl: await image(120, 160, "red") });
        const originalTransport = boundary.request.getMockImplementation()!;
        boundary.request.mockImplementation(async (url: string, init?: RequestInit) => {
            if (init?.method === "POST") {
                expect(url).toBe(`http://fixture.local/api/image-tasks/${child.id}`);
                expect(JSON.parse(String(init.body))).toEqual({ action: "recover" });
                return recoverPublicImageTask(new Request(url, init), { params: Promise.resolve({ id: child.id }) });
            }
            return originalTransport(url, init);
        });
        const resumed = (await updateAgentRunById(paused.id, { status: "running", executionId: "mask-resume-executor" }, undefined, ["paused"]))!;
        await executeTasks(resumed.id, "http://fixture.local", "session=fixture", "mask-resume-executor", boundary.settings);
        expect(await getAgentRun(resumed.id)).toMatchObject({ status: "running", tasks: [{ taskId: child.id, taskIds: [child.id], attempts: 1 }] });
        expect(await getStoredGenerationTaskRecord("image", child.id)).toMatchObject({ executionPhase: "result_ready" });
        const { runGenerationTaskRecoveryBatch } = await import("./generation-task-recovery-service");
        expect(await runGenerationTaskRecoveryBatch({ origin: "http://fixture.local", publicOrigin: "https://public.example", cookie: "session=fixture", limit: 1, taskIds: [child.id] })).toMatchObject({ claimed: 1, completed: 1 });
        await executeTasks(resumed.id, "http://fixture.local", "session=fixture", "mask-resume-executor", boundary.settings);
        const completed = (await getAgentRun(resumed.id))!;
        const recovered = (await getImageTask(child.id))!;
        expect(completed).toMatchObject({ status: "completed", tasks: [{ taskId: child.id, taskIds: [child.id], attempts: 1, childTasks: [{ id: child.id, status: "completed", attempt: 1 }] }] });
        expect(recovered).toMatchObject({ status: "success", sceneProtection, mask: sceneProtection.mask, attempts: [{ attemptNo: 1, status: "succeeded" }] });
        expect(recovered.result?.sceneProtectionEvidence).toMatchObject({ nativeOutsideChangedPixels: 18150, compositeOutsideChangedPixels: 0 });
        expect(boundary.create).toHaveBeenCalledTimes(1);
        expect(boundary.create.mock.calls[0][0]).toMatchObject({ id: child.id, sceneProtection, mask: sceneProtection.mask });
        expect(boundary.poll).not.toHaveBeenCalled();
        expect(boundary.structured).not.toHaveBeenCalled();
        expect(boundary.request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
        expect(childIds).toEqual([]);
        await executeTasks(completed.id, "http://fixture.local", "session=fixture", "mask-resume-executor", boundary.settings);
        expect(boundary.create).toHaveBeenCalledTimes(1);
        expect((await getAgentRun(completed.id))?.tasks[0].taskIds).toEqual([child.id]);
    });

    it.each(["unreadable_first", "unreadable_middle", "unreadable_last", "save_failed", "wrong_native", "stored_wrong_unreadable", "stored_valid_unreadable", "all_unreadable", "all_save_failed", "complete_shared_url", "legacy_empty_results"] as const)(
        "retains the original child/upstream and private QA evidence across %s recovery",
        async (condition) => {
            const missingIndex = condition === "unreadable_first" ? 0 : condition === "unreadable_last" ? 2 : 1;
            const wrongNative = condition === "wrong_native" || condition === "stored_wrong_unreadable";
            const second = await image(120, wrongNative ? 120 : 160, "red");
            nativeResults = [baseline, second, baseline].map((dataUrl, index) => ({
                dataUrl: condition === "all_unreadable" || (condition.startsWith("unreadable_") && index === missingIndex) ? "https://fixture.invalid/unreadable.png" : dataUrl,
                remoteUrl: "https://fixture.example/shared-result.png",
            }));
            if (condition === "legacy_empty_results") {
                legacyEmptyResults = true;
                nativeResults = nativeResults.slice(0, 1);
            }
            if (["save_failed", "wrong_native", "all_save_failed"].includes(condition)) boundary.rejectedBytes.add(second.split(",")[1]);
            if (condition.startsWith("stored_")) boundary.unreadableStoredBytes.add(second.split(",")[1]);
            if (condition === "all_save_failed") boundary.rejectedBytes.add(baseline.split(",")[1]);
            const conversation = await createCreativeConversation("batch-user", { surface: "chat" });
            const initial = (await createAgentRun("batch-user", { clientRequestId: `batch-${condition}`, conversationId: conversation.id, surface: "chat", prompt: "保持画幅调整场景", assetIds: [], skillIds: [], modelIds: [] })).run;
            const plan: EcommerceEditPlan = {
                planVersion: "ecommerce-edit.v5",
                operation: "scene_edit",
                source: { productAnchorId: null, currentSceneBaselineId: "scene-root", sceneReferenceIds: [] },
                baseline: { productFacts: null, sceneFacts: { space: "living room", composition: "eye level", lighting: "daylight" } },
                delta: { requestedChanges: ["adjust scene"], targetObjects: ["lighting"], targetRegions: ["whole-scene"] },
                preserve: { productCore: [], sceneElements: ["cabinet"] },
                strategy: "integrated_scene",
                modelRoles: { visionAnalysis: "planner", editPlanning: "planner", generation: "image-model", qualityCheck: "planner" },
                continuity: { parentResultId: null, branchId: "batch-branch" },
                validation: { requiredChecks: ["requested_edit"] },
                canvas: { mode: "exact", size: { width: 120, height: 160 }, source: "baseline", allowReframe: false },
                protection: { scope: "global", protectedObjectIds: ["cabinet"], preserveOutsideMask: false, allowLightingChange: true },
                visibleStructure: structure,
            };
            const task: AgentRunTask = {
                id: "scene-edit",
                title: "scene edit",
                type: "image",
                prompt: "保持画幅调整场景",
                optimizedPrompt: "保持画幅调整场景",
                count: 1,
                dependencies: [],
                status: "ready",
                attempts: 0,
                references: [{ assetId: "scene-root", url: baseline, type: "image", ecommerceRole: "scene" }],
                ecommerceExecution: compileEcommerceImageRequest(plan, resolveEcommerceImageProviderProfile(routeEcommerceRole(boundary.settings, "image_generation")!.snapshot)!),
            };
            task.prompt = task.ecommerceExecution!.prompt;
            const run = (await updateAgentRunById(
                initial.id,
                {
                    status: "running",
                    executionId: "executor-one",
                    tasks: [task],
                    ecommerceSnapshot: {
                        version: "ecommerce-generation.v1",
                        mode: "active",
                        input: { userRequest: initial.prompt, assetIds: ["scene-root"], conversationId: conversation.id, surface: "chat" },
                        plan,
                        createdAt: Date.now(),
                        runId: initial.id,
                        userId: "batch-user",
                    },
                },
                undefined,
                ["planning"],
            ))!;
            const outcome = await runTaskWithRetry(run.id, task, "http://fixture.local", "session=fixture", "executor-one", boundary.settings);
            const checked = (await getAgentRun(run.id))!;
            const success = condition === "complete_shared_url" || legacyEmptyResults;
            expect(outcome, checked.tasks[0]?.error || checked.ecommerceSnapshot?.qualityCheck?.internalReason).toBe(success ? "completed" : "needs_review");
            expect(checked.ecommerceSnapshot?.qualityCheck).toMatchObject({ status: success ? "passed" : wrongNative ? "blocked" : "unavailable", publicStatus: success ? "passed" : "needs_review" });
            expect(checked.ecommerceSnapshot?.qualityCheck?.canvasEvidence?.map((slot) => slot.resultId)).toEqual((legacyEmptyResults ? [1] : [1, 2, 3]).map((index) => `${childIds[0]}:${index}`));
            if (wrongNative) expect(checked.ecommerceSnapshot?.qualityCheck?.hardFailures).toContainEqual(expect.objectContaining({ resultId: `${childIds[0]}:2`, key: "canvas_geometry", status: "failed" }));
            const child = (await getImageTask(childIds[0]))!;
            const expectedCount = legacyEmptyResults ? 0 : success || condition.startsWith("stored_") ? 3 : condition.startsWith("all_") ? 0 : 2;
            expect(child).toMatchObject({ status: "success", upstream: { id: "original-upstream" }, retryable: false, result: { results: expect.any(Array) } });
            expect(child.result?.results).toHaveLength(expectedCount);
            if (legacyEmptyResults) {
                expect(child.result).not.toHaveProperty("batchEvidence");
                expect(child.result).not.toHaveProperty("resultId");
                expect(checked.ecommerceSnapshot?.qualityCheck?.canvasEvidence?.[0]).not.toHaveProperty("resultIndex");
            } else expect(child.result?.batchEvidence).toHaveLength(3);
            for (const media of child.result!.results!)
                expect(await sharp(await readFile(localAssetUrlToPath(media.serverUrl!))).metadata()).toMatchObject({ width: 120, height: condition === "stored_wrong_unreadable" && media.resultId === `${child.id}:2` ? 120 : 160 });
            if (condition.startsWith("stored_")) {
                expect(child.result?.batchEvidence?.[1]).toMatchObject({ resultId: `${child.id}:2`, nativeStatus: "readable", nativeSize: { width: 120, height: wrongNative ? 120 : 160 }, storageStatus: "stored" });
                expect(checked.ecommerceSnapshot?.qualityCheck?.canvasEvidence?.[1]).toMatchObject({
                    resultId: `${child.id}:2`,
                    nativeSize: { width: 120, height: wrongNative ? 120 : 160 },
                    nativeMatches: !wrongNative,
                    storedStatus: "unavailable",
                    storedMatches: null,
                });
            }
            const admin = await listGenerationLogs({ userId: "batch-user", includeEcommerceTrace: true });
            expect(admin.items[0]?.ecommerceTrace?.finalStatus).toBe(success ? "passed" : "needs_review");
            expect(admin.items[0]?.ecommerceTrace?.stages.find((stage) => stage.key === "quality_check")?.output).toMatchObject({ canvasEvidence: checked.ecommerceSnapshot!.qualityCheck!.canvasEvidence });
            const publicData = { run: publicAgentRun(checked), events: (await listCreativeRunEvents(checked.id, "batch-user")).map(publicAgentRunEvent), logs: await listGenerationLogs({ userId: "batch-user" }) };
            expect(JSON.stringify(publicData)).not.toContain("batchEvidence");
            expect(JSON.stringify(publicData)).not.toContain("canvasEvidence");
            expect(JSON.stringify(publicData)).not.toContain("failureReason");
            if (!success) {
                expect(publicAgentRun(checked)).toMatchObject({ status: "paused", assetIds: [], ecommerceQualityStatus: "needs_review" });
                expect(checked.tasks[0].assetIds).toEqual([]);
                const resumed = (await updateAgentRunById(run.id, { status: "running", executionId: "executor-two" }, undefined, ["paused"]))!;
                expect(await runTaskWithRetry(run.id, resumed.tasks[0], "http://fixture.local", "session=fixture", "executor-two", boundary.settings)).toBe("needs_review");
                expect((await getImageTask(child.id))?.result?.batchEvidence).toEqual(child.result?.batchEvidence);
                expect((await getAgentRun(run.id))?.tasks[0].taskIds).toEqual([child.id]);
            }
            expect(childIds).toHaveLength(1);
            expect(boundary.create).toHaveBeenCalledTimes(1);
            expect(boundary.poll).toHaveBeenCalledTimes(1);
            expect(boundary.refund).not.toHaveBeenCalled();
            expect(JSON.stringify(await readFile(join(directory, "generation-tasks.json"), "utf8"))).not.toContain("private-storage-detail");
        },
    );
    it.each([
        { shape: "top_level", native: "wrong" },
        { shape: "top_level", native: "valid" },
        { shape: "top_level", native: "unknown" },
        { shape: "media_list", native: "wrong" },
        { shape: "media_list", native: "valid" },
        { shape: "media_list", native: "unknown" },
    ] as const)("preserves legacy durable native facts through File/Agent/QA recovery ($shape, $native)", async ({ shape, native }) => {
        const wrong = native === "wrong";
        const generated = await image(120, wrong ? 120 : 160, "red");
        const originalBytes = Buffer.from(generated.split(",")[1], "base64");
        const actualSize = await sharp(originalBytes).metadata();
        legacyResult = { shape, knownSize: native !== "unknown" };
        nativeResults = (shape === "media_list" ? [baseline, generated, baseline] : [generated]).map((dataUrl) => ({ dataUrl, remoteUrl: "https://fixture.example/legacy-result.png" }));
        boundary.unreadableStoredBytes.add(originalBytes.toString("base64"));
        const conversation = await createCreativeConversation("batch-user", { surface: "chat" });
        const initial = (await createAgentRun("batch-user", { clientRequestId: "legacy-" + shape + "-" + native, conversationId: conversation.id, surface: "chat", prompt: "保持画幅调整场景", assetIds: [], skillIds: [], modelIds: [] })).run;
        const plan: EcommerceEditPlan = {
            planVersion: "ecommerce-edit.v4",
            operation: "scene_edit",
            source: { productAnchorId: null, currentSceneBaselineId: "scene-root", sceneReferenceIds: [] },
            baseline: { productFacts: null, sceneFacts: { space: "living room", composition: "eye level", lighting: "daylight" } },
            delta: { requestedChanges: ["adjust scene"], targetObjects: ["lighting"], targetRegions: ["whole-scene"] },
            preserve: { productCore: [], sceneElements: ["cabinet"] },
            strategy: "integrated_scene",
            modelRoles: { visionAnalysis: "planner", editPlanning: "planner", generation: "image-model", qualityCheck: "planner" },
            continuity: { parentResultId: null, branchId: "legacy-branch" },
            validation: { requiredChecks: ["requested_edit"] },
            canvas: { mode: "exact", size: { width: 120, height: 160 }, source: "baseline", allowReframe: false },
            protection: { scope: "global", protectedObjectIds: ["cabinet"], preserveOutsideMask: false, allowLightingChange: true },
            visibleStructure: structure,
        };
        const { validateEcommerceEditPlan } = await import("./ecommerce-edit-plan");
        expect(() => validateEcommerceEditPlan(plan)).not.toThrow();
        const task: AgentRunTask = {
            id: "legacy-scene-edit",
            title: "legacy scene edit",
            type: "image",
            prompt: "保持画幅调整场景",
            optimizedPrompt: "保持画幅调整场景",
            count: 1,
            dependencies: [],
            status: "ready",
            attempts: 0,
            references: [{ assetId: "scene-root", url: baseline, type: "image", ecommerceRole: "scene" }],
            ecommerceExecution: compileEcommerceImageRequest(plan, resolveEcommerceImageProviderProfile(routeEcommerceRole(boundary.settings, "image_generation")!.snapshot)!),
        };
        task.prompt = task.ecommerceExecution!.prompt;
        const run = (await updateAgentRunById(
            initial.id,
            {
                status: "running",
                executionId: "legacy-executor-one",
                tasks: [task],
                ecommerceSnapshot: {
                    version: "ecommerce-generation.v1",
                    mode: "active",
                    input: { userRequest: initial.prompt, assetIds: ["scene-root"], conversationId: conversation.id, surface: "chat" },
                    plan,
                    createdAt: Date.now(),
                    runId: initial.id,
                    userId: "batch-user",
                },
            },
            undefined,
            ["planning"],
        ))!;
        expect(await runTaskWithRetry(run.id, task, "http://fixture.local", "session=fixture", "legacy-executor-one", boundary.settings)).toBe("needs_review");
        const checked = (await getAgentRun(run.id))!;
        const child = (await getImageTask(childIds[0]))!;
        const targetIndex = shape === "media_list" ? 1 : 0;
        const storedMedia = shape === "media_list" ? child.result!.results! : [child.result!];
        const quality = checked.ecommerceSnapshot!.qualityCheck!;
        const evidence = quality.canvasEvidence![targetIndex];
        expect(child.result).toEqual(childBeforeQuality!.result);
        expect(child).toMatchObject({
            status: "success",
            upstream: { id: "original-upstream" },
            retryable: false,
            createdAt: childBeforeQuality!.createdAt,
            attempts: childBeforeQuality!.attempts,
            ecommerceExecution: { compilerVersion: "ecommerce-nano-banana-2.v2" },
        });
        expect(checked.ecommerceSnapshot?.plan?.planVersion).toBe("ecommerce-edit.v4");
        expect(child.result).not.toHaveProperty("batchEvidence");
        expect(child.result).not.toHaveProperty("resultId");
        expect(child.result?.results).toHaveLength(shape === "media_list" ? 3 : 0);
        for (const media of storedMedia) {
            expect(media).not.toHaveProperty("resultId");
            expect(media).not.toHaveProperty("resultIndex");
        }
        expect(quality.canvasEvidence).toHaveLength(storedMedia.length);
        expect(quality.canvasEvidence?.every((slot) => !("resultIndex" in slot))).toBe(true);
        expect((await readFile(localAssetUrlToPath(storedMedia[targetIndex].serverUrl!))).equals(originalBytes)).toBe(true);
        expect(quality).toMatchObject({ status: wrong ? "blocked" : "unavailable", publicStatus: "needs_review" });
        expect(evidence).toMatchObject({ resultId: child.id + ":" + (targetIndex + 1), nativeMatches: native === "unknown" ? null : !wrong, storedStatus: "unavailable", storedMatches: null });
        if (native === "unknown") {
            expect(evidence).not.toHaveProperty("nativeSize");
            expect(storedMedia[targetIndex].canvasEvidence).toBeUndefined();
        } else {
            expect(evidence.nativeSize).toEqual({ width: actualSize.width, height: actualSize.height });
            expect(storedMedia[targetIndex].canvasEvidence?.nativeSize).toEqual(evidence.nativeSize);
        }
        expect(quality.hardFailures).toEqual(wrong ? [expect.objectContaining({ resultId: child.id + ":" + (targetIndex + 1), key: "canvas_geometry", status: "failed", source: "media" })] : []);
        const admin = await listGenerationLogs({ userId: "batch-user", includeEcommerceTrace: true });
        expect(admin.items[0]?.ecommerceTrace?.finalStatus).toBe("needs_review");
        expect(admin.items[0]?.ecommerceTrace?.stages.find((stage) => stage.key === "quality_check")?.output).toMatchObject({ canvasEvidence: quality.canvasEvidence, hardFailures: quality.hardFailures });
        const publicData = { run: publicAgentRun(checked), events: (await listCreativeRunEvents(checked.id, "batch-user")).map(publicAgentRunEvent), logs: await listGenerationLogs({ userId: "batch-user" }) };
        expect(publicAgentRun(checked)).toMatchObject({ status: "paused", assetIds: [], ecommerceQualityStatus: "needs_review" });
        expect(checked.tasks[0].assetIds).toEqual([]);
        for (const field of ["batchEvidence", "canvasEvidence", "failureReason", "nativeSize"]) expect(JSON.stringify(publicData)).not.toContain(field);
        const resumed = (await updateAgentRunById(run.id, { status: "running", executionId: "legacy-executor-two" }, undefined, ["paused"]))!;
        expect(await runTaskWithRetry(run.id, resumed.tasks[0], "http://fixture.local", "session=fixture", "legacy-executor-two", boundary.settings)).toBe("needs_review");
        const restored = (await getImageTask(child.id))!;
        expect(restored.result).toEqual(childBeforeQuality!.result);
        expect(restored.upstream).toEqual(childBeforeQuality!.upstream);
        expect(restored.createdAt).toBe(childBeforeQuality!.createdAt);
        expect(restored.attempts).toEqual(childBeforeQuality!.attempts);
        expect((await getAgentRun(run.id))?.tasks[0].taskIds).toEqual([child.id]);
        expect((await getAgentRun(run.id))?.ecommerceSnapshot?.qualityCheck).toMatchObject({ status: wrong ? "blocked" : "unavailable", hardFailures: quality.hardFailures, canvasEvidence: quality.canvasEvidence });
        expect(childIds).toHaveLength(1);
        expect(boundary.create).toHaveBeenCalledTimes(1);
        expect(boundary.poll).toHaveBeenCalledTimes(1);
        expect(boundary.structured).not.toHaveBeenCalled();
        expect(boundary.refund).not.toHaveBeenCalled();
    });
});

async function image(width: number, height: number, background: string) {
    return (
        "data:image/png;base64," +
        (
            await sharp({ create: { width, height, channels: 3, background } })
                .png()
                .toBuffer()
        ).toString("base64")
    );
}
