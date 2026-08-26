import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getAgentRun: vi.fn(), getLatestCreativeRunEventId: vi.fn(), listCreativeRunEvents: vi.fn(), recover: vi.fn() }));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: vi.fn(async () => ({ id: "user" })) }));
vi.mock("@/lib/server/agent-run-store", () => ({ getAgentRun: mocks.getAgentRun }));
vi.mock("@/lib/server/creative-runtime-store", () => ({ CREATIVE_RUN_EVENT_BATCH_SIZE: 500, getLatestCreativeRunEventId: mocks.getLatestCreativeRunEventId, listCreativeRunEvents: mocks.listCreativeRunEvents }));
vi.mock("@/lib/server/generation-task-recovery-service", () => ({ runGenerationTaskRecoveryBatch: mocks.recover }));
vi.mock("@/lib/server/internal-origin", () => ({ resolveInternalOrigin: vi.fn(() => "http://localhost") }));

import { GET } from "./route";

describe("Agent Run SSE", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getAgentRun.mockResolvedValue({
            id: "run",
            userId: "user",
            status: "completed",
            tasks: [],
            updatedAt: 3,
        });
        mocks.listCreativeRunEvents.mockResolvedValue([{ id: "2", runId: "run", type: "run.completed", createdAt: 2, data: { reply: "完成" } }]);
        mocks.getLatestCreativeRunEventId.mockResolvedValue("");
    });

    it("resumes after Last-Event-ID and closes after the terminal snapshot", async () => {
        const response = await GET(new Request("http://localhost/api/agent/runs/run/events", { headers: { "last-event-id": "1" } }), { params: Promise.resolve({ id: "run" }) });
        const body = await response.text();

        expect(response.headers.get("content-type")).toContain("text/event-stream");
        expect(body).not.toContain("id: 1");
        expect(body).toContain("id: 2");
        expect(body).toContain("event: run.snapshot");
        expect(body).toContain('"status":"completed"');
        expect(mocks.getAgentRun).toHaveBeenCalledTimes(1);
        expect(mocks.listCreativeRunEvents).toHaveBeenCalledWith("run", "1");
    });

    it("drains every persisted event batch before closing a terminal run", async () => {
        const firstBatch = Array.from({ length: 500 }, (_, index) => ({ id: String(index + 2), runId: "run", type: "run.planning", createdAt: index + 2 }));
        mocks.listCreativeRunEvents.mockResolvedValueOnce(firstBatch).mockResolvedValueOnce([{ id: "502", runId: "run", type: "run.completed", createdAt: 502, data: { reply: "完成" } }]);

        const response = await GET(new Request("http://localhost/api/agent/runs/run/events", { headers: { "last-event-id": "1" } }), { params: Promise.resolve({ id: "run" }) });
        const body = await response.text();

        expect(body).toContain("id: 501");
        expect(body).toContain("id: 502");
        expect(body.indexOf("id: 502")).toBeLessThan(body.indexOf("event: run.snapshot"));
        expect(mocks.listCreativeRunEvents).toHaveBeenNthCalledWith(1, "run", "1");
        expect(mocks.listCreativeRunEvents).toHaveBeenNthCalledWith(2, "run", "501");
        expect(mocks.getAgentRun).toHaveBeenCalledTimes(1);
    });

    it("starts after the latest manual retry instead of replaying an older failure", async () => {
        mocks.getAgentRun.mockResolvedValue({ id: "run", userId: "user", status: "running", tasks: [], updatedAt: 4 });
        mocks.getLatestCreativeRunEventId.mockImplementation(async (_runId, type) => (type === "run.retry.requested" ? "11" : "8"));
        mocks.listCreativeRunEvents.mockResolvedValueOnce([{ id: "12", runId: "run", type: "run.planning", createdAt: 4 }]).mockResolvedValue([]);

        const response = await GET(new Request("http://localhost/api/agent/runs/run/events"), { params: Promise.resolve({ id: "run" }) });
        const reader = response.body!.getReader();
        const first = await reader.read();
        await reader.cancel();

        expect(new TextDecoder().decode(first.value)).toContain("id: 12");
        expect(mocks.recover).not.toHaveBeenCalled();
        expect(mocks.getLatestCreativeRunEventId).toHaveBeenCalledWith("run", "task.retry.requested");
        expect(mocks.getLatestCreativeRunEventId).toHaveBeenCalledWith("run", "run.retry.requested");
        expect(mocks.listCreativeRunEvents).toHaveBeenCalledWith("run", "11");
    });

    it("does not expose internal prompts, results, review details or execution identity", async () => {
        mocks.getAgentRun.mockResolvedValue({
            id: "run",
            userId: "user",
            conversationId: "conversation",
            inputMessageId: "input",
            assistantMessageId: "assistant",
            surface: "chat",
            prompt: "用户原文",
            status: "completed",
            executionId: "execution-secret",
            assetIds: [],
            referencedAssetIds: [],
            tasks: [{ id: "image", title: "图片", type: "image", model: "image-pro", prompt: "internal-prompt-secret", count: 1, dependencies: [], status: "completed", attempts: 1, taskId: "child-secret", result: { raw: "result-secret" } }],
            foundation: { secret: true },
            review: { summary: "review-secret" },
            updatedAt: 3,
        });
        mocks.listCreativeRunEvents.mockResolvedValue([
            { id: "2", runId: "run", type: "run.review.needs_revision", createdAt: 2, data: { review: { summary: "review-event-secret" } } },
            { id: "3", runId: "run", type: "run.completed", createdAt: 3, data: { reply: "完成" } },
        ]);

        const response = await GET(new Request("http://localhost/api/agent/runs/run/events", { headers: { "last-event-id": "1" } }), { params: Promise.resolve({ id: "run" }) });
        const body = await response.text();

        expect(body).toContain('"title":"图片"');
        expect(body).not.toContain("internal-prompt-secret");
        expect(body).not.toContain("execution-secret");
        expect(body).not.toContain("child-secret");
        expect(body).not.toContain("result-secret");
        expect(body).not.toContain("review-secret");
        expect(body).not.toContain("review-event-secret");
    });
});
