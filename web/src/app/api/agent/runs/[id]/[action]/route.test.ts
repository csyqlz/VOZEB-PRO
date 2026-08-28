import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    countActive: vi.fn(),
    runGenerationTaskRecoveryBatch: vi.fn(),
    scheduleGenerationTask: vi.fn(),
    getAuthSettings: vi.fn(),
    getAgentRun: vi.fn(),
    setAgentRunStatus: vi.fn(),
    updateAgentRunById: vi.fn(),
    fetchInternalApi: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => {
    const actual = await importOriginal<typeof import("next/server")>();
    return { ...actual, after: vi.fn((callback: () => unknown) => callback()) };
});
vi.mock("@/app/api/generation-resource-access", () => ({ requireGenerationResourceAccess: vi.fn(async () => null) }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: vi.fn(async () => ({ id: "user" })) }));
vi.mock("@/lib/auth/store", () => ({ getAuthSettings: mocks.getAuthSettings }));
vi.mock("@/lib/server/agent-run-executor", () => ({ abortAgentRun: vi.fn() }));
vi.mock("@/lib/server/agent-run-store", () => ({ getAgentRun: mocks.getAgentRun, setAgentRunStatus: mocks.setAgentRunStatus, updateAgentRunById: mocks.updateAgentRunById }));
vi.mock("@/lib/server/generation-task-recovery-service", () => ({ runGenerationTaskRecoveryBatch: mocks.runGenerationTaskRecoveryBatch }));
vi.mock("@/lib/server/generation-task-scheduler", () => ({ scheduleGenerationTask: mocks.scheduleGenerationTask }));
vi.mock("@/lib/server/generation-task-store", () => ({ withGenerationConcurrencyLimit: vi.fn(async (_userId, _type, _staleMs, limit, handler, excludeTaskId) => ((await mocks.countActive(excludeTaskId)) >= limit ? null : handler())) }));
vi.mock("@/lib/server/internal-origin", () => ({ fetchInternalApi: mocks.fetchInternalApi, resolveInternalOrigin: vi.fn(() => "http://localhost") }));

import { POST } from "./route";

describe("Agent Run resume concurrency", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        const run = { id: "run", userId: "user", status: "paused", tasks: [] };
        mocks.getAgentRun.mockResolvedValue(run);
        mocks.setAgentRunStatus.mockResolvedValue({ ...run, status: "running" });
        mocks.countActive.mockResolvedValue(1);
        mocks.getAuthSettings.mockResolvedValueOnce({ generationConcurrency: { agent: 2 } }).mockResolvedValueOnce({ generationConcurrency: { agent: 1 } });
    });

    it("reads the latest backend concurrency limit on every resume request", async () => {
        const first = await POST(request(), context());
        const second = await POST(request(), context());

        expect(first.status).toBe(200);
        expect(second.status).toBe(429);
        expect(mocks.getAuthSettings).toHaveBeenCalledTimes(2);
        expect(mocks.setAgentRunStatus).toHaveBeenCalledTimes(1);
    });

    it("retries a planning failure in the same run and replaces its assistant state", async () => {
        const run = { id: "run", userId: "user", status: "failed", tasks: [], assetIds: ["old"] };
        mocks.getAgentRun.mockResolvedValue(run);
        mocks.countActive.mockResolvedValue(0);
        mocks.getAuthSettings.mockReset().mockResolvedValue({ generationConcurrency: { agent: 2 } });
        mocks.updateAgentRunById.mockImplementation(async (_id, patch) => ({ ...run, ...patch }));

        const response = await POST(new Request("http://localhost/api/agent/runs/run/retry", { method: "POST" }), { params: Promise.resolve({ id: "run", action: "retry" }) });

        expect(response.status).toBe(200);
        expect(mocks.updateAgentRunById).toHaveBeenCalledWith("run", expect.objectContaining({ status: "planning", tasks: [], reviewed: false, assetIds: [] }), { type: "run.retry.requested" }, ["failed"]);
        expect(mocks.scheduleGenerationTask).toHaveBeenCalledWith("agent", "run", expect.objectContaining({ executionPhase: "created", nextPollAt: expect.any(Number), lastUpstreamStatus: "retry" }));
    });

    it("does not use whole-run retry when a failed child task exists", async () => {
        mocks.getAgentRun.mockResolvedValue({ id: "run", userId: "user", status: "failed", tasks: [{ id: "task", status: "failed" }] });

        const response = await POST(new Request("http://localhost/api/agent/runs/run/retry", { method: "POST" }), { params: Promise.resolve({ id: "run", action: "retry" }) });

        expect(response.status).toBe(409);
        expect(mocks.updateAgentRunById).not.toHaveBeenCalled();
    });

    it("checks the latest concurrency limit before retrying a planning failure", async () => {
        mocks.getAgentRun.mockResolvedValue({ id: "run", userId: "user", status: "failed", tasks: [] });
        mocks.countActive.mockResolvedValue(1);
        mocks.getAuthSettings.mockReset().mockResolvedValue({ generationConcurrency: { agent: 1 } });

        const response = await POST(new Request("http://localhost/api/agent/runs/run/retry", { method: "POST" }), { params: Promise.resolve({ id: "run", action: "retry" }) });

        expect(response.status).toBe(429);
        expect(mocks.updateAgentRunById).not.toHaveBeenCalled();
    });

    it("cancels every unfinished child task without cancelling completed outputs", async () => {
        const run = {
            id: "run",
            userId: "user",
            status: "running",
            tasks: [
                {
                    id: "images",
                    type: "image",
                    status: "running",
                    taskId: "image-latest",
                    taskIds: ["image-pending", "image-completed", "image-latest"],
                    childTasks: [
                        { id: "image-pending", status: "pending" },
                        { id: "image-completed", status: "completed" },
                    ],
                },
                {
                    id: "videos",
                    type: "video",
                    status: "running",
                    childTasks: [
                        { id: "video-one", status: "pending" },
                        { id: "video-two", status: "pending" },
                        { id: "video-failed", status: "failed" },
                    ],
                },
                { id: "audio", type: "audio", status: "running", taskIds: ["audio-one", "audio-two", "audio-one"] },
                { id: "text", type: "text", status: "running", taskId: "text-one" },
                { id: "done", type: "image", status: "completed", taskId: "image-done" },
            ],
        };
        let current = run;
        mocks.getAgentRun.mockImplementation(async () => current);
        mocks.updateAgentRunById.mockImplementation(async (_id, patch) => (current = { ...current, ...patch }));
        mocks.setAgentRunStatus.mockImplementation(async (_run, status) => (current = { ...current, status }));
        mocks.fetchInternalApi.mockImplementation(async () => Response.json({ task: { status: "cancelled" } }));

        const response = await POST(new Request("http://localhost/api/agent/runs/run/cancel", { method: "POST", headers: { cookie: "session=test" } }), {
            params: Promise.resolve({ id: "run", action: "cancel" }),
        });

        expect(response.status).toBe(200);
        expect(mocks.fetchInternalApi.mock.calls.map(([url]) => url).sort()).toEqual(
            [
                "http://localhost/api/audio-tasks/audio-one",
                "http://localhost/api/audio-tasks/audio-two",
                "http://localhost/api/image-tasks/image-latest",
                "http://localhost/api/image-tasks/image-pending",
                "http://localhost/api/text-tasks/text-one",
                "http://localhost/api/video-tasks/video-one",
                "http://localhost/api/video-tasks/video-two",
            ].sort(),
        );
        expect(mocks.fetchInternalApi).not.toHaveBeenCalledWith(expect.stringContaining("image-completed"), expect.anything());
        expect(mocks.fetchInternalApi).not.toHaveBeenCalledWith(expect.stringContaining("video-failed"), expect.anything());
        expect(mocks.fetchInternalApi).not.toHaveBeenCalledWith(expect.stringContaining("image-done"), expect.anything());
        expect(mocks.fetchInternalApi).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: "PATCH", headers: { "Content-Type": "application/json", cookie: "session=test" }, body: JSON.stringify({ status: "cancelled" }) }));
        expect(mocks.updateAgentRunById).toHaveBeenCalledWith(
            "run",
            expect.objectContaining({ status: "paused", executionId: undefined, cancellation: expect.objectContaining({ pendingChildTaskIds: expect.arrayContaining(["image-pending", "video-one"]) }) }),
            expect.objectContaining({ type: "run.cancel.requested" }),
            ["planning", "running", "paused"],
        );
        expect(mocks.setAgentRunStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "paused" }), "cancelled");
    });

    it("keeps the Agent paused when a child cancellation result cannot be confirmed", async () => {
        const run = {
            id: "run",
            userId: "user",
            status: "running",
            tasks: [
                { id: "image", type: "image", status: "running", taskId: "image-one" },
                { id: "video", type: "video", status: "running", taskId: "video-one" },
            ],
        };
        let current = run;
        mocks.getAgentRun.mockImplementation(async () => current);
        mocks.updateAgentRunById.mockImplementation(async (_id, patch) => (current = { ...current, ...patch }));
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith("image-one")) return Response.json({ task: { status: "cancelled" } });
            if (url.endsWith("video-one") && init?.method === "PATCH") throw new Error("connection reset");
            throw new Error("status unavailable");
        });

        const response = await POST(new Request("http://localhost/api/agent/runs/run/cancel", { method: "POST", headers: { cookie: "session=test" } }), {
            params: Promise.resolve({ id: "run", action: "cancel" }),
        });

        expect(response.status).toBe(502);
        await expect(response.json()).resolves.toMatchObject({ data: { run: { status: "paused", cancellation: { pendingCount: 1 } }, pendingCount: 1 } });
        expect(mocks.setAgentRunStatus).not.toHaveBeenCalled();
        expect(mocks.scheduleGenerationTask).toHaveBeenCalledWith("agent", "run", expect.objectContaining({ executionPhase: "completed", lastUpstreamStatus: "cancel_requested" }));
    });

    it("confirms an already accepted child cancellation through GET on retry", async () => {
        const run = {
            id: "run",
            userId: "user",
            status: "paused",
            cancellation: { requestedAt: 100, pendingChildTaskIds: ["video-one"] },
            tasks: [{ id: "video", type: "video", status: "running", taskId: "video-one" }],
        };
        let current = run;
        mocks.getAgentRun.mockImplementation(async () => current);
        mocks.updateAgentRunById.mockImplementation(async (_id, patch) => (current = { ...current, ...patch }));
        mocks.setAgentRunStatus.mockImplementation(async (_run, status) => (current = { ...current, status }));
        mocks.fetchInternalApi.mockImplementation(async (_url: string, init?: RequestInit) => (init?.method === "PATCH" ? Response.json({ error: "当前任务无法取消" }, { status: 409 }) : Response.json({ task: { status: "cancelled" } })));

        const response = await POST(new Request("http://localhost/api/agent/runs/run/cancel", { method: "POST", headers: { cookie: "session=test" } }), {
            params: Promise.resolve({ id: "run", action: "cancel" }),
        });

        expect(response.status).toBe(200);
        expect(mocks.fetchInternalApi).toHaveBeenCalledWith("http://localhost/api/video-tasks/video-one", { headers: { cookie: "session=test" } });
        expect(mocks.setAgentRunStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "paused" }), "cancelled");
    });

    it("accepts a child that reached a successful terminal state during cancellation", async () => {
        const run = { id: "run", userId: "user", status: "running", tasks: [{ id: "image", type: "image", status: "running", taskId: "image-one" }] };
        let current = run;
        mocks.getAgentRun.mockImplementation(async () => current);
        mocks.updateAgentRunById.mockImplementation(async (_id, patch) => (current = { ...current, ...patch }));
        mocks.setAgentRunStatus.mockImplementation(async (_run, status) => (current = { ...current, status }));
        mocks.fetchInternalApi.mockImplementation(async (_url: string, init?: RequestInit) => (init?.method === "PATCH" ? Response.json({ error: "当前任务无法取消" }, { status: 409 }) : Response.json({ task: { status: "success" } })));

        const response = await POST(new Request("http://localhost/api/agent/runs/run/cancel", { method: "POST" }), { params: Promise.resolve({ id: "run", action: "cancel" }) });

        expect(response.status).toBe(200);
        expect(mocks.setAgentRunStatus).toHaveBeenCalledOnce();
    });

    it("does not resume a Run with a persisted cancellation request", async () => {
        mocks.getAgentRun.mockResolvedValue({ id: "run", userId: "user", status: "paused", cancellation: { requestedAt: 100, pendingChildTaskIds: ["video-one"] }, tasks: [] });

        const response = await POST(request(), context());

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({ msg: "任务正在取消，无法恢复" });
        expect(mocks.setAgentRunStatus).not.toHaveBeenCalled();
    });

    it("rejects a control request when the visible conversation does not own the run", async () => {
        const run = { id: "run", userId: "user", conversationId: "conversation-a", status: "running", tasks: [] };
        mocks.getAgentRun.mockResolvedValue(run);

        const response = await POST(
            new Request("http://localhost/api/agent/runs/run/cancel", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ conversationId: "conversation-b" }),
            }),
            { params: Promise.resolve({ id: "run", action: "cancel" }) },
        );

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({ msg: "当前对话与 Agent 任务不匹配" });
        expect(mocks.setAgentRunStatus).not.toHaveBeenCalled();
        expect(mocks.fetchInternalApi).not.toHaveBeenCalled();
        expect(mocks.scheduleGenerationTask).not.toHaveBeenCalled();
    });

    it("rejects an empty expected conversation before reading or changing the run", async () => {
        const response = await POST(
            new Request("http://localhost/api/agent/runs/run/cancel", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ conversationId: " " }),
            }),
            { params: Promise.resolve({ id: "run", action: "cancel" }) },
        );

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ msg: "对话标识无效" });
        expect(mocks.getAgentRun).not.toHaveBeenCalled();
        expect(mocks.setAgentRunStatus).not.toHaveBeenCalled();
    });
});

function request() {
    return new Request("http://localhost/api/agent/runs/run/resume", { method: "POST" });
}

function context() {
    return { params: Promise.resolve({ id: "run", action: "resume" }) };
}
