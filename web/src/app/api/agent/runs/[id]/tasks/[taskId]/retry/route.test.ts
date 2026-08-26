import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    countActive: vi.fn(),
    runGenerationTaskRecoveryBatch: vi.fn(),
    scheduleGenerationTask: vi.fn(),
    getAuthSettings: vi.fn(),
    getAgentRun: vi.fn(),
    updateAgentRunById: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => {
    const actual = await importOriginal<typeof import("next/server")>();
    return { ...actual, after: vi.fn((callback: () => unknown) => callback()) };
});
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: vi.fn(async () => ({ id: "user" })) }));
vi.mock("@/lib/auth/store", () => ({ getAuthSettings: mocks.getAuthSettings }));
vi.mock("@/lib/server/agent-run-store", () => ({ getAgentRun: mocks.getAgentRun, updateAgentRunById: mocks.updateAgentRunById }));
vi.mock("@/lib/server/generation-task-recovery-service", () => ({ runGenerationTaskRecoveryBatch: mocks.runGenerationTaskRecoveryBatch }));
vi.mock("@/lib/server/generation-task-scheduler", () => ({ scheduleGenerationTask: mocks.scheduleGenerationTask }));
vi.mock("@/lib/server/generation-task-store", () => ({ withGenerationConcurrencyLimit: vi.fn(async (_userId, _type, _staleMs, limit, handler, excludeTaskId) => ((await mocks.countActive(excludeTaskId)) >= limit ? null : handler())) }));
vi.mock("@/lib/server/internal-origin", () => ({ resolveInternalOrigin: vi.fn(() => "http://localhost") }));

import { POST } from "./route";

describe("Agent child task retry concurrency", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getAgentRun.mockResolvedValue({ id: "run", userId: "user", conversationId: "conversation-one", status: "failed", tasks: [{ id: "task", status: "failed" }] });
        mocks.countActive.mockResolvedValue(1);
        mocks.getAuthSettings.mockResolvedValue({ generationConcurrency: { agent: 1 }, generationDefaults: { imageSize: "1:1" } });
    });

    it("rejects a retry issued from a different conversation", async () => {
        const response = await POST(
            new Request("http://localhost/api/agent/runs/run/tasks/task/retry", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ conversationId: "conversation-two" }),
            }),
            { params: Promise.resolve({ id: "run", taskId: "task" }) },
        );

        expect(response.status).toBe(409);
        expect(mocks.getAuthSettings).not.toHaveBeenCalled();
        expect(mocks.updateAgentRunById).not.toHaveBeenCalled();
    });

    it("uses the current backend limit before changing the failed task", async () => {
        const response = await POST(new Request("http://localhost/api/agent/runs/run/tasks/task/retry", { method: "POST" }), { params: Promise.resolve({ id: "run", taskId: "task" }) });

        expect(response.status).toBe(429);
        expect(mocks.getAuthSettings).toHaveBeenCalledTimes(1);
        expect(mocks.updateAgentRunById).not.toHaveBeenCalled();
    });

    it("does not count the existing scheduler record for the same Run against a multi-task retry", async () => {
        mocks.countActive.mockImplementation(async (excludeTaskId) => (excludeTaskId === "run" ? 0 : 1));
        mocks.updateAgentRunById.mockImplementation(async (_id, patch) => ({ ...(await mocks.getAgentRun()), ...patch }));

        const response = await POST(new Request("http://localhost/api/agent/runs/run/tasks/task/retry", { method: "POST" }), { params: Promise.resolve({ id: "run", taskId: "task" }) });

        expect(response.status).toBe(200);
        expect(mocks.countActive).toHaveBeenCalledWith("run");
        expect(mocks.updateAgentRunById).toHaveBeenCalledTimes(1);
    });

    it("retries every requested failed task in one Run update and one scheduler request", async () => {
        const run = {
            id: "run",
            userId: "user",
            conversationId: "conversation-one",
            status: "failed",
            tasks: [
                { id: "task-one", status: "failed", attempts: 1, error: "图片失败" },
                { id: "task-two", status: "failed", attempts: 2, error: "视频失败" },
                { id: "task-complete", status: "completed", attempts: 1, result: "完成" },
            ],
        };
        mocks.countActive.mockResolvedValue(0);
        mocks.getAgentRun.mockResolvedValue(run);
        mocks.updateAgentRunById.mockImplementation(async (_id, patch) => ({ ...run, ...patch }));

        const response = await POST(
            new Request("http://localhost/api/agent/runs/run/tasks/task-one/retry", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ conversationId: "conversation-one", taskIds: ["task-one", "task-two"] }),
            }),
            { params: Promise.resolve({ id: "run", taskId: "task-one" }) },
        );

        expect(response.status).toBe(200);
        expect(mocks.updateAgentRunById).toHaveBeenCalledTimes(1);
        const tasks = mocks.updateAgentRunById.mock.calls[0]?.[1]?.tasks;
        expect(tasks).toEqual([
            expect.objectContaining({ id: "task-one", status: "ready", error: undefined }),
            expect.objectContaining({ id: "task-two", status: "ready", error: undefined }),
            expect.objectContaining({ id: "task-complete", status: "completed", result: "完成" }),
        ]);
        expect(mocks.updateAgentRunById.mock.calls[0]?.[2]).toMatchObject({ type: "task.retry.requested", data: { taskId: "task-one", taskIds: ["task-one", "task-two"] } });
        expect(mocks.scheduleGenerationTask).toHaveBeenCalledTimes(1);
        expect(mocks.runGenerationTaskRecoveryBatch).toHaveBeenCalledTimes(1);
    });

    it("discards failed child task IDs before starting a new retry", async () => {
        const run = {
            id: "run",
            userId: "user",
            status: "failed",
            tasks: [
                {
                    id: "task",
                    status: "failed",
                    attempts: 3,
                    taskId: "child-failed",
                    taskIds: ["child-failed"],
                    childTasks: [{ id: "child-failed", status: "failed", attempt: 3, error: "上游超时" }],
                    error: "视频生成超时",
                },
            ],
        };
        mocks.countActive.mockResolvedValue(0);
        mocks.getAgentRun.mockResolvedValue(run);
        mocks.updateAgentRunById.mockImplementation(async (_id, patch) => ({ ...run, ...patch }));

        const response = await POST(new Request("http://localhost/api/agent/runs/run/tasks/task/retry", { method: "POST" }), { params: Promise.resolve({ id: "run", taskId: "task" }) });

        expect(response.status).toBe(200);
        const tasks = mocks.updateAgentRunById.mock.calls[0]?.[1]?.tasks;
        expect(tasks).toEqual([expect.objectContaining({ id: "task", status: "ready", attempts: 3, taskId: undefined, taskIds: undefined, childTasks: undefined, result: undefined, error: undefined })]);
        expect(mocks.scheduleGenerationTask).toHaveBeenCalledWith("agent", "run", expect.objectContaining({ executionPhase: "created", nextPollAt: expect.any(Number), lastUpstreamStatus: "task_retry" }));
    });

    it("repairs legacy canvas image references and invalid ratios before retrying", async () => {
        const run = {
            id: "run",
            userId: "user",
            surface: "canvas",
            status: "failed",
            requestedImageSize: undefined,
            snapshot: {
                selectedNodeIds: ["reference"],
                nodes: [{ id: "reference", type: "image", title: "当前参考图", metadata: { url: "/api/reference-assets/current.webp", naturalWidth: 360, naturalHeight: 640 } }],
            },
            tasks: [{ id: "task", title: "编辑图片", type: "image", prompt: "换成紫色毛发", count: 1, ratio: "原图比例", dependencies: [], status: "failed", attempts: 1, references: [], error: "尺寸无效" }],
        };
        mocks.countActive.mockResolvedValue(0);
        mocks.getAgentRun.mockResolvedValue(run);
        mocks.updateAgentRunById.mockImplementation(async (_id, patch) => ({ ...run, ...patch }));

        const response = await POST(new Request("http://localhost/api/agent/runs/run/tasks/task/retry", { method: "POST" }), { params: Promise.resolve({ id: "run", taskId: "task" }) });

        expect(response.status).toBe(200);
        const [retried] = mocks.updateAgentRunById.mock.calls[0]?.[1]?.tasks;
        expect(retried).toMatchObject({ status: "ready", targetNodeId: "reference", referenceUrl: "/api/reference-assets/current.webp", referenceType: "image", ratio: "9:16" });
        expect(mocks.updateAgentRunById.mock.calls[0]?.[2]).toMatchObject({
            type: "task.retry.requested",
            data: {
                taskId: "task",
                ops: [
                    {
                        type: "update_node",
                        id: "task-run-0",
                        metadata: { targetNodeId: "reference", agentTaskStatus: "ready", agentTaskError: "", agentTaskAttempts: 1, agentTaskOutputNodeIds: ["output-run-0-0"], agentGenerationTaskIds: [] },
                    },
                    { type: "update_node", id: "output-run-0-0", metadata: expect.objectContaining({ agentRunId: "run", agentTaskId: "task", status: "loading", errorDetails: "", size: "9:16" }) },
                    { type: "connect_nodes", fromNodeId: "reference", toNodeId: "task-run-0" },
                    { type: "connect_nodes", fromNodeId: "reference", toNodeId: "output-run-0-0" },
                ],
            },
        });
    });
});
