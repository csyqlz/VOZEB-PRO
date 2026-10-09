import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    currentUser: vi.fn(),
    getImageTask: vi.fn(),
    getSchedule: vi.fn(),
    recover: vi.fn(),
    schedule: vi.fn(),
    settings: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => {
    const actual = await importOriginal<typeof import("next/server")>();
    return { ...actual, after: vi.fn() };
});
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.currentUser }));
vi.mock("@/lib/auth/store", () => ({ getAuthSettings: mocks.settings }));
vi.mock("@/app/api/image-tasks/image-task-reference-urls", () => ({ requestPublicOrigin: vi.fn(() => "https://public.example.com") }));
vi.mock("@/lib/server/image-task-store", () => ({ getImageTask: mocks.getImageTask, transitionImageTask: vi.fn() }));
vi.mock("@/lib/server/generation-task-recovery-service", () => ({ runGenerationTaskRecoveryBatch: mocks.recover }));
vi.mock("@/lib/server/generation-task-store", () => ({ getStoredGenerationTaskRecord: mocks.getSchedule }));
vi.mock("@/lib/server/generation-task-scheduler", async (original) => ({ ...(await original<typeof import("@/lib/server/generation-task-scheduler")>()), scheduleGenerationTask: mocks.schedule }));
vi.mock("@/lib/server/internal-origin", () => ({ resolveInternalOrigin: vi.fn(() => "http://localhost") }));
vi.mock("@/lib/server/points-response", () => ({ pointsResponseHeaders: vi.fn(() => new Headers()) }));
vi.mock("@/lib/server/generation-channel", async (original) => ({ ...(await original<typeof import("@/lib/server/generation-channel")>()), generationModelId: vi.fn(() => "image-model") }));

import { after } from "next/server";
import { GET, POST } from "./route";

const context = { params: Promise.resolve({ id: "image-one" }) };

describe("GET /api/image-tasks/[id]", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.currentUser.mockResolvedValue({ id: "user", role: "user" });
        mocks.getSchedule.mockResolvedValue({ executionPhase: "polling" });
        mocks.schedule.mockResolvedValue({ executionPhase: "polling" });
        mocks.recover.mockResolvedValue({ claimed: 1 });
    });

    it("keeps actual public media dimensions while hiding internal canvas evidence", async () => {
        const media = {
            dataUrl: "/api/generation-log-assets/native.png",
            width: 2880,
            height: 2880,
            canvasEvidence: { constraint: { source: "user_text" }, nativeUrl: "private-native-file" },
            sceneProtectionEvidence: { maskUrl: "private-mask", nativeUrl: "private-local-native" },
        };
        mocks.getImageTask.mockResolvedValue(imageTask({ status: "success", result: { ...media, results: [media] } }));
        const response = await GET(new Request("http://localhost/api/image-tasks/image-one"), context);
        const body = await response.json();
        expect(body.task.result).toMatchObject({ width: 2880, height: 2880, results: [{ width: 2880, height: 2880 }] });
        expect(JSON.stringify(body)).not.toContain("canvasEvidence");
        expect(JSON.stringify(body)).not.toContain("private-native-file");
        expect(JSON.stringify(body)).not.toContain("sceneProtectionEvidence");
        expect(JSON.stringify(body)).not.toContain("private-mask");
    });

    it("whitelists public media fields and never exposes original batch failures or private result identities", async () => {
        const publicMedia = { dataUrl: "/api/generation-log-assets/ready.png", remoteUrl: "https://fixture.example/result.png", serverUrl: "/api/generation-log-assets/ready.png", width: 6, height: 4, bytes: 123, mimeType: "image/png" };
        const privateMedia = { ...publicMedia, resultId: "private-child:3", batchEvidence: [{ resultId: "private-child:1", nativeStatus: "unavailable", failureReason: "private-read-failure" }], privateUnknown: "private-future-field" };
        mocks.getImageTask.mockResolvedValue(imageTask({ status: "success", result: { ...privateMedia, results: [privateMedia] } }));
        const body = await (await GET(new Request("http://localhost/api/image-tasks/image-one"), context)).json();
        expect(body.task.result).toEqual({ ...publicMedia, results: [publicMedia] });
        expect(JSON.stringify(body)).not.toContain("private-");
        expect(JSON.stringify(body)).not.toContain("batchEvidence");
        expect(JSON.stringify(body)).not.toContain("resultId");
    });

    it("returns the current image state without running recovery work", async () => {
        mocks.getImageTask.mockResolvedValue(imageTask());

        const response = await GET(new Request("http://localhost/api/image-tasks/image-one", { headers: { cookie: "session=test" } }), context);

        expect(response.status).toBe(200);
        expect((await response.json()).task).toMatchObject({ id: "image-one", status: "running" });
        expect(after).not.toHaveBeenCalled();
        expect(mocks.recover).not.toHaveBeenCalled();
    });

    it("wakes a due active image task after returning its current state", async () => {
        mocks.getImageTask.mockResolvedValue(imageTask());
        mocks.getSchedule.mockResolvedValue({ executionPhase: "polling", nextPollAt: Date.now() - 1 });
        const request = new Request("http://localhost/api/image-tasks/image-one", { headers: { cookie: "session=test" } });

        const response = await GET(request, context);

        expect(response.status).toBe(200);
        expect(after).toHaveBeenCalledTimes(1);
        const wake = vi.mocked(after).mock.calls[0]?.[0] as () => Promise<unknown>;
        await wake();
        expect(mocks.recover).toHaveBeenCalledWith({
            origin: "http://localhost",
            publicOrigin: "https://public.example.com",
            cookie: "session=test",
            limit: 1,
            taskIds: ["image-one"],
        });
    });

    it("does not wake an image task before its persisted poll time", async () => {
        mocks.getImageTask.mockResolvedValue(imageTask());
        mocks.getSchedule.mockResolvedValue({ executionPhase: "polling", nextPollAt: Date.now() + 60_000 });

        await GET(new Request("http://localhost/api/image-tasks/image-one"), context);

        expect(after).not.toHaveBeenCalled();
    });

    it.each(["success", "error", "cancelled"])("does not wake a %s task", async (status) => {
        mocks.getImageTask.mockResolvedValue(imageTask({ status }));
        mocks.getSchedule.mockResolvedValue({ executionPhase: "completed" });

        await GET(new Request("http://localhost/api/image-tasks/image-one"), context);

        expect(after).not.toHaveBeenCalled();
    });

    it("leaves an uncertain submission for manual review", async () => {
        mocks.getImageTask.mockResolvedValue(imageTask({ reviewReason: "图片提交结果无法确认" }));
        mocks.getSchedule.mockResolvedValue({ executionPhase: "needs_review" });

        const response = await GET(new Request("http://localhost/api/image-tasks/image-one"), context);

        expect(after).not.toHaveBeenCalled();
        expect((await response.json()).task).toMatchObject({ needsReview: true, reviewReason: "图片提交结果无法确认" });
    });
});

describe("POST /api/image-tasks/[id] recover", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.currentUser.mockResolvedValue({ id: "user", role: "user" });
        mocks.schedule.mockResolvedValue({ executionPhase: "polling" });
        mocks.recover.mockResolvedValue({ claimed: 1 });
    });

    it.each(["pending", "running"] as const)("continues the same %s mask child after pre-submission protocol rejection", async (status) => {
        const task = maskTask(status);
        const schedule = { type: "image", status, payload: task, executionPhase: "needs_review", lastUpstreamStatus: "strict_product_mask_review_required" };
        mocks.getImageTask.mockResolvedValue(task);
        mocks.getSchedule.mockResolvedValue(schedule);
        mocks.settings.mockResolvedValue(maskSettings());
        const response = await POST(recoverRequest(), context);
        expect(response.status).toBe(200);
        expect(mocks.schedule).toHaveBeenCalledExactlyOnceWith("image", "image-one", expect.objectContaining({ executionPhase: "created", lastUpstreamStatus: "scene_mask_recovery_requested" }), { unsubmittedMaskRecovery: schedule });
        expect(mocks.recover).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ taskIds: ["image-one"], userRequested: true }));
        expect((await response.json()).task.id).toBe("image-one");
    });

    it("rejects a changed live mask contract before scheduling or creating an upstream task", async () => {
        const task = maskTask("pending");
        mocks.getImageTask.mockResolvedValue(task);
        mocks.getSchedule.mockResolvedValue({ type: "image", status: "pending", payload: task, executionPhase: "needs_review", lastUpstreamStatus: "strict_product_mask_review_required" });
        mocks.settings.mockResolvedValue(maskSettings("openai"));
        const response = await POST(recoverRequest(), context);
        expect(response.status).toBe(409);
        expect(mocks.schedule).not.toHaveBeenCalled();
        expect(mocks.recover).not.toHaveBeenCalled();
    });

    it.each(["reference_source_unavailable", "reference_validation_unavailable"])("checks and resumes the same unsubmitted reference child after %s", async (failure) => {
        const task = imageTask({ runId: "same-run", referenceDispatch: { inputId: "frozen-input" }, attempts: [], references: [{ id: "original", url: "/api/reference-assets/original.png", dataUrl: "" }] });
        mocks.getImageTask.mockResolvedValue(task);
        mocks.getSchedule.mockResolvedValue({ type: "image", status: "running", payload: task, executionPhase: "needs_review", lastUpstreamStatus: `${failure}:check original task` });
        const response = await POST(recoverRequest(), context);
        expect(response.status).toBe(200);
        expect(mocks.schedule).toHaveBeenCalledExactlyOnceWith("image", "image-one", expect.objectContaining({ executionPhase: "created", lastUpstreamStatus: "reference_recovery_requested" }), { unsubmittedReferenceRecovery: true });
        expect(mocks.recover).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ taskIds: ["image-one"], userRequested: true }));
        expect((await response.json()).task.id).toBe("image-one");
    });

    it("rejects a stale unsubmitted recovery when the scheduler CAS finds the task already submitting", async () => {
        const task = imageTask({ runId: "same-run", referenceDispatch: { inputId: "frozen-input" }, attempts: [] });
        mocks.getImageTask.mockResolvedValue(task);
        mocks.getSchedule.mockResolvedValue({ type: "image", status: "running", payload: task, executionPhase: "needs_review", lastUpstreamStatus: "reference_source_unavailable:check original task" });
        mocks.schedule.mockResolvedValue(null);
        const response = await POST(recoverRequest(), context);
        expect(response.status).toBe(409);
        expect(mocks.recover).not.toHaveBeenCalled();
    });

    it("reuses the saved upstream task and persists a ready result in the same user action", async () => {
        const running = imageTask({ upstream: { id: "upstream-one", explicitPollUrl: "/images/upstream-one" } });
        mocks.getImageTask.mockResolvedValueOnce(running).mockResolvedValueOnce(imageTask({ status: "success", result: { dataUrl: "/api/generation-log-assets/result.png" } }));
        mocks.getSchedule
            .mockResolvedValueOnce({ executionPhase: "needs_review", submittedAt: 1_000 })
            .mockResolvedValueOnce({ executionPhase: "result_ready" })
            .mockResolvedValueOnce({ executionPhase: "completed" })
            .mockResolvedValueOnce({ executionPhase: "completed" });

        const response = await POST(recoverRequest(), context);

        expect(response.status).toBe(200);
        expect(mocks.schedule).toHaveBeenCalledWith("image", "image-one", expect.objectContaining({ executionPhase: "polling", upstreamTaskId: "upstream-one", queryPath: "/images/upstream-one", submittedAt: 1_000 }));
        expect(mocks.recover).toHaveBeenCalledTimes(2);
        expect((await response.json()).task).toMatchObject({ id: "image-one", status: "success", executionPhase: "completed" });
    });

    it("recovers from the upstream identity stored in the scheduler record", async () => {
        mocks.getImageTask.mockResolvedValueOnce(imageTask()).mockResolvedValueOnce(imageTask());
        mocks.getSchedule
            .mockResolvedValueOnce({ executionPhase: "needs_review", upstreamTaskId: "scheduled-upstream", queryPath: "/jobs/scheduled-upstream" })
            .mockResolvedValueOnce({ executionPhase: "polling" })
            .mockResolvedValueOnce({ executionPhase: "polling" });

        const response = await POST(recoverRequest(), context);

        expect(response.status).toBe(200);
        expect(mocks.schedule).toHaveBeenCalledWith("image", "image-one", expect.objectContaining({ upstreamTaskId: "scheduled-upstream", queryPath: "/jobs/scheduled-upstream" }));
        expect(mocks.recover).toHaveBeenCalledTimes(1);
    });

    it("refuses to create another task when no upstream identity was saved", async () => {
        mocks.getImageTask.mockResolvedValue(imageTask());
        mocks.getSchedule.mockResolvedValue({ executionPhase: "needs_review" });

        const response = await POST(recoverRequest(), context);

        expect(response.status).toBe(409);
        expect(mocks.schedule).not.toHaveBeenCalled();
        expect(mocks.recover).not.toHaveBeenCalled();
    });
});

function recoverRequest() {
    return new Request("http://localhost/api/image-tasks/image-one", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: "session=test" },
        body: JSON.stringify({ action: "recover" }),
    });
}

function imageTask(patch: Record<string, unknown> = {}) {
    return {
        id: "image-one",
        userId: "user",
        kind: "generation",
        status: "running",
        config: { channelId: "channel", baseUrl: "/api/ai/system/channel", apiKey: "system", apiFormat: "openai", model: "image-model" },
        ...patch,
    };
}

function maskSettings(protocol = "sub2api") {
    return {
        defaultModels: { imageModel: "image" },
        logicalModels: [{ id: "image", name: "image", capability: "image", enabled: true, bindings: [{ id: "binding", channelId: "channel", upstreamModel: "gpt-image-2.5-sunburst", enabled: true, priority: 1 }] }],
        systemChannels: [{ id: "channel", name: "image", enabled: true, baseUrl: "https://image.example.com", apiKey: "fixture-key", apiFormat: "openai", models: ["gpt-image-2.5-sunburst"], advancedConfig: { protocol } }],
    };
}

function maskTask(status: "pending" | "running") {
    return imageTask({
        status,
        kind: "edit",
        runId: "same-run",
        attempts: [],
        references: [{ id: "scene", ecommerceRole: "scene", dataUrl: "source" }],
        mask: { dataUrl: "alpha-mask" },
        sceneProtection: { sourceAssetId: "scene", selectionSource: "user_selection", mask: { dataUrl: "alpha-mask" } },
        ecommerceExecution: {
            state: "ready",
            prompt: "add vase",
            compilerVersion: "ecommerce-openai-image-2.5.v2",
            providerProfileId: "gpt-image-2.5-sunburst",
            protection: { scope: "local", protectedObjectIds: [], preserveOutsideMask: true, allowLightingChange: false },
            mask: { required: true, mode: "independent" },
            referenceRoles: [{ assetId: "scene", role: "scene" }],
            modelSnapshot: { logicalRole: "image_generation", capability: "image", logicalModelId: "image", channelId: "channel", upstreamModel: "gpt-image-2.5-sunburst", apiFormat: "openai" },
        },
        config: { apiSource: "system", channelId: "channel", logicalModel: "image", apiFormat: "openai", model: "gpt-image-2.5-sunburst", baseUrl: "/api/ai/system/channel", advancedConfig: { protocol: "sub2api" } },
    });
}
