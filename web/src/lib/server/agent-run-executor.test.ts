import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreativeConversationContext } from "@/lib/creative-runtime-contract";
import { AGENT_PLAN_SCHEMA_VERSION } from "./agent-run-audit";
import type { AgentRun, AgentRunTask } from "./agent-run-store";
import { canvasPlan, canvasSettings, conversationPlan, creativeImageAsset, disabledSettings, imageTask, plannerFailoverSettings, planningRun, runFixture, runWithTasks, settings } from "./agent-run-executor.test-fixtures";

const mocks = vi.hoisted(() => ({
    fetchInternalApi: vi.fn(),
    getAuthSettings: vi.fn(),
    refundUserPoints: vi.fn(async () => undefined),
    getCreativeAssetsByIds: vi.fn(async (_ids: string[] = []): Promise<Array<Record<string, unknown>>> => []),
    listRecentCreativeMediaAssets: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []),
    getCreativeConversationContext: vi.fn(async (): Promise<CreativeConversationContext> => ({ summary: "", summaryThroughSequence: 0, recentMessages: [] })),
    registerCreativeAssets: vi.fn(),
    reviewCreativeOutputs: vi.fn(),
    linkStoredGenerationTask: vi.fn(async () => undefined),
    events: [] as Array<{ type: string; data?: unknown }>,
    run: null as AgentRun | null,
    updateAgentRunById: vi.fn(),
    updateAgentRunTaskById: vi.fn(),
    scheduleGenerationTask: vi.fn(async () => undefined),
}));

vi.mock("@/lib/auth/store", () => ({
    getAuthSettings: mocks.getAuthSettings,
    refundUserPoints: mocks.refundUserPoints,
}));
vi.mock("@/lib/server/internal-origin", () => ({ fetchInternalApi: mocks.fetchInternalApi }));
vi.mock("@/lib/server/creative-runtime-store", () => ({
    getCreativeAssetsByIds: mocks.getCreativeAssetsByIds,
    getCreativeConversationContext: mocks.getCreativeConversationContext,
    listRecentCreativeMediaAssets: mocks.listRecentCreativeMediaAssets,
    registerCreativeAssets: mocks.registerCreativeAssets,
}));
vi.mock("@/lib/server/generation-task-store", () => ({ linkStoredGenerationTask: mocks.linkStoredGenerationTask }));
vi.mock("@/lib/server/generation-task-scheduler", () => ({ scheduleGenerationTask: mocks.scheduleGenerationTask }));
vi.mock("@/lib/server/creative-review-service", () => ({ reviewCreativeOutputs: mocks.reviewCreativeOutputs }));
vi.mock("@/lib/server/agent-run-store", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/server/agent-run-store")>();
    return {
        ...actual,
        getAgentRun: vi.fn(async () => mocks.run),
        updateAgentRunById: mocks.updateAgentRunById,
        updateAgentRunTaskById: mocks.updateAgentRunTaskById,
    };
});

import { executeAgentRun } from "./agent-run-executor";
import { processAgentRunReview, taskResultOps } from "./agent-run-execution";
import { resetTextPlanningRuntime } from "./text-planning-runtime";

describe("executeAgentRun backend settings", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetTextPlanningRuntime();
        mocks.events = [];
        mocks.getCreativeAssetsByIds.mockResolvedValue([]);
        mocks.listRecentCreativeMediaAssets.mockResolvedValue([]);
        mocks.getCreativeConversationContext.mockResolvedValue({ summary: "", summaryThroughSequence: 0, recentMessages: [] });
        mocks.reviewCreativeOutputs.mockResolvedValue({ mode: "visual", status: "passed", summary: "检查通过", issues: [], retryTaskIds: [] });
        mocks.registerCreativeAssets.mockImplementation(async (inputs: Array<Record<string, unknown>>) => inputs.map((input, index) => ({ ...input, id: `asset-${index}`, status: "ready", createdAt: 1, updatedAt: 1 })));
        mocks.updateAgentRunById.mockImplementation(async (_id, patch, event, allowedStatuses, expectedExecutionId) => {
            if (!mocks.run || (allowedStatuses && !allowedStatuses.includes(mocks.run.status)) || (expectedExecutionId && mocks.run.executionId !== expectedExecutionId)) return null;
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

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        const createCall = mocks.fetchInternalApi.mock.calls.find((call) => call[1]?.method === "POST");
        const body = JSON.parse(String(createCall?.[1]?.body)) as { config: { model: string; baseUrl: string; apiKey: string } };
        expect(body.config).toMatchObject({ model: "old-image", baseUrl: "/api/ai/system/old-channel", apiKey: "" });
        expect(mocks.run?.status).toBe("completed");
    });

    it("completes a single media run and schedules its persistent review", async () => {
        mocks.run = { ...runWithTasks([imageTask("image-one")]), reviewed: false };
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.run?.status).toBe("completed");
        expect(mocks.run?.reviewed).toBe(false);
        expect(mocks.run?.reviewStatus).toBe("review_pending");
        expect(mocks.events.at(-1)?.type).toBe("run.completed");
        expect(mocks.reviewCreativeOutputs).not.toHaveBeenCalled();
        expect(mocks.scheduleGenerationTask).toHaveBeenCalledWith("agent", "agent-run", expect.objectContaining({ executionPhase: "review_pending", lastUpstreamStatus: "review_pending" }));
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

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.fetchInternalApi.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
        expect(mocks.run).toMatchObject({ status: "completed", reviewed: true, reviewStatus: "review_completed", review: { status: "needs_revision", retryTaskIds: ["image-one"] } });
        expect(mocks.run?.tasks).toEqual([
            expect.objectContaining({ id: "image-one", status: "completed", taskId: expect.any(String), assetIds: expect.any(Array), result: expect.any(Object) }),
            expect.objectContaining({ id: "image-two", status: "completed", taskId: expect.any(String), assetIds: expect.any(Array), result: expect.any(Object) }),
        ]);
        expect(mocks.events.some((event) => event.type === "run.review.needs_revision")).toBe(true);
    });

    it("runs an explicitly selected generation model without a default text model", async () => {
        mocks.run = runFixture({ surface: "chat", projectId: undefined, prompt: "生成商品主图", requestedModelIds: ["image-model"] });
        mocks.getCreativeConversationContext.mockResolvedValue({
            summary: "同一商品使用红色包装",
            summaryThroughSequence: 1,
            recentMessages: [],
        });
        const manualSettings = settings("image-model", "image-channel") as unknown as {
            defaultModels: { textModel: string };
            systemChannels: Array<{ id: string }>;
            logicalModels: Array<{ capability: string }>;
        };
        manualSettings.defaultModels.textModel = "";
        manualSettings.systemChannels = manualSettings.systemChannels.filter((channel) => channel.id !== "planner-channel");
        manualSettings.logicalModels = manualSettings.logicalModels.filter((model) => model.capability !== "text");
        mocks.getAuthSettings.mockResolvedValue(manualSettings as never);

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.getCreativeConversationContext).toHaveBeenCalledWith("conversation", "user", "agent-run");
        expect(mocks.listRecentCreativeMediaAssets).not.toHaveBeenCalled();
        expect(mocks.fetchInternalApi.mock.calls.some(([url]) => String(url).endsWith("/responses") || String(url).endsWith("/chat/completions"))).toBe(false);
        expect(mocks.fetchInternalApi.mock.calls.some(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"))).toBe(true);
        expect(mocks.run?.tasks[0]).toMatchObject({ optimizedPrompt: "生成商品主图" });
        expect(mocks.run?.tasks[0]?.prompt).toContain("同一商品使用红色包装");
        expect(mocks.run?.status).toBe("completed");
    });

    it("creates Canvas plan nodes when a generation model is selected explicitly", async () => {
        mocks.run = runFixture({ surface: "canvas", prompt: "生成商品主图", requestedModelIds: ["image-model"] });
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

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

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

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

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(postCountsAtPoll).toEqual([2, 2]);
        expect(mocks.run?.tasks).toEqual([expect.objectContaining({ status: "completed" }), expect.objectContaining({ status: "completed" })]);
    });

    it("does not change channel settings halfway through a run", async () => {
        mocks.run = runWithTasks([imageTask("image-one"), imageTask("image-two")]);
        mocks.getAuthSettings.mockResolvedValueOnce(settings("image-model", "image-channel")).mockResolvedValueOnce(settings("image-model", "image-channel")).mockResolvedValue(disabledSettings("image-model", "image-channel"));

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(2);
        expect(mocks.run?.tasks[1]).toMatchObject({ status: "completed", attempts: 1 });
        expect(mocks.run?.status).toBe("completed");
    });

    it("resumes polling an in-flight child task instead of failing the run", async () => {
        mocks.run = runWithTasks([{ ...imageTask("image-one"), status: "running", attempts: 1, taskId: "child-existing" }]);
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(0);
        expect(mocks.fetchInternalApi.mock.calls.some(([url]) => String(url).endsWith("/api/image-tasks/child-existing"))).toBe(true);
        expect(mocks.run?.status).toBe("completed");
    });

    it("persists every child result for a multi-copy image task", async () => {
        mocks.run = runWithTasks([{ ...imageTask("image-one"), count: 2 }]);
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

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

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

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

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

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

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

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

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
        expect(polls).toBe(1);
        expect(mocks.run?.status).toBe("running");
        expect(mocks.run?.tasks[0]).toMatchObject({ status: "running", taskId: "child-transient", childTasks: [{ id: "child-transient", status: "pending" }], error: "生成任务查询暂时不可用" });
        expect(mocks.events.filter((event) => event.type === "task.waiting")).toHaveLength(1);

        await executeAgentRun(mocks.run!, "http://localhost", "session=test");

        expect(mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
        expect(polls).toBe(2);
        expect(mocks.events.filter((event) => event.type === "task.running")).toHaveLength(1);
        expect(mocks.run?.status).toBe("completed");
    });

    it("pauses on needs_review and resumes the same child without another upstream creation", async () => {
        mocks.run = runWithTasks([imageTask("image-one")]);
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));
        let polls = 0;
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-review" } });
            if (url.endsWith("/api/image-tasks/child-review")) {
                polls += 1;
                return polls === 1
                    ? Response.json({ task: { status: "running", needsReview: true, reviewReason: "图片上游接口 /v1/images/edits 返回 HTTP 502" } })
                    : Response.json({ task: { status: "success", result: { url: "https://cdn.example.com/recovered.png" } } });
            }
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
        expect(mocks.run).toMatchObject({
            status: "paused",
            tasks: [
                expect.objectContaining({
                    status: "needs_review",
                    error: "图片上游接口 /v1/images/edits 返回 HTTP 502",
                    taskId: "child-review",
                    childTasks: [expect.objectContaining({ id: "child-review", status: "needs_review", error: "图片上游接口 /v1/images/edits 返回 HTTP 502" })],
                }),
            ],
        });
        expect(mocks.events.some((event) => event.type === "task.needs_review")).toBe(true);
        expect(mocks.events.some((event) => event.type === "run.paused")).toBe(true);

        mocks.run = { ...mocks.run!, status: "running" };
        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST" && String(call[0]).endsWith("/api/image-tasks"))).toHaveLength(1);
        expect(mocks.fetchInternalApi.mock.calls.filter((call) => call[1]?.method === "POST" && String(call[0]).endsWith("/api/image-tasks/child-review"))).toHaveLength(1);
        expect(polls).toBe(2);
        expect(mocks.run?.status).toBe("completed");
    });

    it("does not create another child after an upstream task reports an error", async () => {
        mocks.run = runWithTasks([imageTask("image-one")]);
        mocks.getAuthSettings.mockResolvedValue(settings("image-model", "image-channel"));
        mocks.fetchInternalApi.mockImplementation(async (url: string, init?: RequestInit) => {
            if (init?.method === "POST" && url.endsWith("/api/image-tasks")) return Response.json({ task: { id: "child-error" } });
            if (url.endsWith("/api/image-tasks/child-error")) return Response.json({ task: { status: "error", error: "上游生成失败" } });
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

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

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

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

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

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

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

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

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

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

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

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

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

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

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

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

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

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

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.run?.status).toBe("completed");
        expect(mocks.events.find((event) => event.type === "run.completed")?.data).toMatchObject({ completed: 0, reply: "在的，你可以直接告诉我想创作什么。" });
        expect(mocks.refundUserPoints).not.toHaveBeenCalled();
    });

    it("rejects an unstructured prose planner response instead of pretending generation completed", async () => {
        mocks.run = planningRun("你在吗？");
        mocks.getAuthSettings.mockResolvedValue(canvasSettings("image-default", "image-default-channel"));
        mocks.fetchInternalApi.mockImplementation(async (url: string) => {
            if (url.endsWith("/responses")) return new Response("unsupported", { status: 404 });
            if (url.endsWith("/chat/completions")) return Response.json({ choices: [{ message: { content: "在的，需要我帮你做什么？" } }] });
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.run?.status).toBe("failed");
        expect(mocks.events.some((event) => event.type === "run.completed")).toBe(false);
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
            await executeAgentRun(mocks.run, "http://localhost", "session=test");
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

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

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

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        const primaryCalls = mocks.fetchInternalApi.mock.calls.filter(([url]) => String(url).includes("/planner-primary/"));
        const backupCalls = mocks.fetchInternalApi.mock.calls.filter(([url]) => String(url).includes("/planner-backup/"));
        expect(primaryCalls).toHaveLength(1);
        expect(backupCalls).toHaveLength(1);
        expect(mocks.run?.status).toBe("completed");
        expect(mocks.events.some((event) => event.type === "run.completed")).toBe(true);
    });

    it("plans chat media without canvas ops, links the child task and registers a stable asset", async () => {
        mocks.run = runFixture({ surface: "chat", projectId: undefined, prompt: "把这张图改成红色服装", referencedAssetIds: ["asset-source"], requestedImageSize: "1080x1213" });
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

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

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

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

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

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

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

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

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

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

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

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

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

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

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

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        const createCall = mocks.fetchInternalApi.mock.calls.find(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/image-tasks"));
        const createBody = JSON.parse(String(createCall?.[1]?.body)) as { config: { model: string } };
        expect(createBody.config.model).toBe("image-default");
        expect(mocks.run?.tasks[0].model).toBe("image-default");
    });

    it("refunds text planning cost when chat fallback returns prose instead of structured JSON", async () => {
        mocks.run = planningRun();
        mocks.getAuthSettings.mockResolvedValue(canvasSettings("image-default", "image-default-channel"));
        mocks.fetchInternalApi.mockImplementation(async (url: string) => {
            if (url.endsWith("/responses")) return new Response("unsupported endpoint", { status: 404 });
            if (url.endsWith("/chat/completions")) return Response.json({ choices: [{ message: { content: "我建议使用横版构图。" } }] }, { headers: { "x-vozeb-pro-points-cost": "2", "x-vozeb-pro-points-record-id": "points-agent-plan" } });
            throw new Error(`unexpected request: ${url}`);
        });

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.refundUserPoints).toHaveBeenCalledWith("user", "planner", 2, "text", 1, undefined, "points-agent-plan");
        expect(mocks.run).toMatchObject({
            status: "failed",
            failureStage: "planning",
            failure: expect.any(String),
            candidateFailures: [{ channelId: "planner-channel", upstreamModel: "vendor/planner", error: expect.any(String) }],
        });
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

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

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

        await executeAgentRun(mocks.run, "http://localhost", "session=test");

        expect(mocks.refundUserPoints).toHaveBeenCalledWith("user", "planner", 3, "text", 1, undefined, "points-agent-cancelled");
        expect(mocks.run?.status).toBe("cancelled");
    });
});
