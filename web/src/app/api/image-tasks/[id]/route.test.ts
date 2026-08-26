import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    currentUser: vi.fn(),
    getImageTask: vi.fn(),
    getSchedule: vi.fn(),
    recover: vi.fn(),
    schedule: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => {
    const actual = await importOriginal<typeof import("next/server")>();
    return { ...actual, after: vi.fn() };
});
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.currentUser }));
vi.mock("@/app/api/image-tasks/image-task-reference-urls", () => ({ requestPublicOrigin: vi.fn(() => "https://public.example.com") }));
vi.mock("@/lib/server/image-task-store", () => ({ getImageTask: mocks.getImageTask, transitionImageTask: vi.fn() }));
vi.mock("@/lib/server/generation-task-recovery-service", () => ({ runGenerationTaskRecoveryBatch: mocks.recover }));
vi.mock("@/lib/server/generation-task-store", () => ({ getStoredGenerationTaskRecord: mocks.getSchedule }));
vi.mock("@/lib/server/generation-task-scheduler", () => ({ scheduleGenerationTask: mocks.schedule }));
vi.mock("@/lib/server/internal-origin", () => ({ resolveInternalOrigin: vi.fn(() => "http://localhost") }));
vi.mock("@/lib/server/points-response", () => ({ pointsResponseHeaders: vi.fn(() => new Headers()) }));
vi.mock("@/lib/server/generation-channel", () => ({ generationModelId: vi.fn(() => "image-model") }));

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
