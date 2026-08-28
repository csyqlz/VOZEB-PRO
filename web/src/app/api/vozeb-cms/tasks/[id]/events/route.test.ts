import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    session: vi.fn(),
    capability: vi.fn(),
    getTask: vi.fn(),
    waitTask: vi.fn(),
    waitWorkflow: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.session }));
vi.mock("@/app/api/vozeb-cms-capability", () => ({ requireVozebCmsCapability: mocks.capability }));
vi.mock("@/lib/server/vozeb-cms/unified-task-service", () => ({
    getVozebCmsTask: mocks.getTask,
    vozebCmsTaskCapabilityId: (type: string) => (type === "workflow" ? "workflow.run" : `${type}.generate`),
}));
vi.mock("@/lib/server/vozeb-cms/task-event-signal", () => ({ waitForVozebCmsTaskEvent: mocks.waitTask }));
vi.mock("@/lib/server/vozeb-cms/workflow-event-signal", () => ({ waitForVozebCmsWorkflowEvent: mocks.waitWorkflow }));

import { GET } from "./route";

const runningTask = {
    id: "task-one",
    type: "image",
    status: "running",
    source: "generation",
    input: { prompt: "公开需求" },
    owner: "user-one",
    cost: 2,
    metadata: { attemptNo: 1 },
    created_at: "2026-08-26T00:00:00.000Z",
    updated_at: "2026-08-26T00:00:01.000Z",
    execution_phase: "polling",
};

describe("VOZEBCMS unified task SSE", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.session.mockResolvedValue({ id: "user-one" });
        mocks.capability.mockResolvedValue(null);
        mocks.getTask.mockResolvedValue({ ...runningTask, status: "success", updated_at: "2026-08-26T00:00:02.000Z", execution_phase: "completed" });
        mocks.waitTask.mockResolvedValue(true);
        mocks.waitWorkflow.mockResolvedValue(true);
    });

    it("requires authentication before opening the stream", async () => {
        mocks.session.mockResolvedValueOnce(null);

        const response = await GET(new Request("http://localhost/api/vozeb-cms/tasks/task-one/events"), { params: Promise.resolve({ id: "task-one" }) });

        expect(response.status).toBe(401);
        expect(mocks.capability).not.toHaveBeenCalled();
        expect(mocks.getTask).not.toHaveBeenCalled();
    });

    it("checks resource and task capabilities before streaming", async () => {
        const blocked = new Response("图片生成模块已停用", { status: 403 });
        mocks.capability.mockResolvedValueOnce(null).mockResolvedValueOnce(blocked);
        mocks.getTask.mockResolvedValueOnce(runningTask);

        const response = await GET(new Request("http://localhost/api/vozeb-cms/tasks/task-one/events"), { params: Promise.resolve({ id: "task-one" }) });

        expect(response.status).toBe(403);
        expect(mocks.capability).toHaveBeenNthCalledWith(1, "asset.manage", "user-one");
        expect(mocks.capability).toHaveBeenNthCalledWith(2, "image.generate", "user-one");
    });

    it("does not expose a task outside the authenticated owner scope", async () => {
        mocks.getTask.mockResolvedValueOnce(null);

        const response = await GET(new Request("http://localhost/api/vozeb-cms/tasks/other-task/events"), { params: Promise.resolve({ id: "other-task" }) });

        expect(response.status).toBe(404);
        expect(mocks.getTask).toHaveBeenCalledWith("user-one", "other-task");
    });

    it("emits authoritative snapshots until the task reaches a terminal state", async () => {
        const completed = { ...runningTask, status: "success", updated_at: "2026-08-26T00:00:03.000Z", execution_phase: "completed", output: { url: "/media/result.webp" } };
        mocks.getTask.mockResolvedValueOnce(runningTask).mockResolvedValueOnce(runningTask).mockResolvedValueOnce(completed);

        const response = await GET(new Request("http://localhost/api/vozeb-cms/tasks/task-one/events", { headers: { "last-event-id": "stale-cursor" } }), { params: Promise.resolve({ id: "task-one" }) });
        const body = await response.text();

        expect(response.headers.get("content-type")).toContain("text/event-stream");
        expect(response.headers.get("x-accel-buffering")).toBe("no");
        expect(body.match(/event: task\.snapshot/g)).toHaveLength(2);
        expect(body).toContain("2026-08-26T00:00:01.000Z");
        expect(body).toContain("2026-08-26T00:00:03.000Z");
        expect(body).toContain('"url":"/media/result.webp"');
        expect(mocks.waitTask).toHaveBeenCalledWith("task-one", 2_500, expect.any(AbortSignal));
        expect(mocks.waitWorkflow).not.toHaveBeenCalled();
    });

    it("waits on workflow events for workflow task projections", async () => {
        const workflow = { ...runningTask, id: "workflow-one", type: "workflow", source: "workflow", status: "waiting", execution_phase: "waiting" };
        const completed = { ...workflow, status: "success", execution_phase: "completed", updated_at: "2026-08-26T00:00:03.000Z" };
        mocks.getTask.mockResolvedValueOnce(workflow).mockResolvedValueOnce(workflow).mockResolvedValueOnce(completed);

        const response = await GET(new Request("http://localhost/api/vozeb-cms/tasks/workflow-one/events"), { params: Promise.resolve({ id: "workflow-one" }) });
        await response.text();

        expect(mocks.capability).toHaveBeenNthCalledWith(2, "workflow.run", "user-one");
        expect(mocks.waitWorkflow).toHaveBeenCalledWith("workflow-one", 2_500, expect.any(AbortSignal));
        expect(mocks.waitTask).not.toHaveBeenCalled();
    });
});
