import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    currentUser: vi.fn(),
    getVideoTask: vi.fn(),
    getSchedule: vi.fn(),
    recover: vi.fn(),
    schedule: vi.fn(),
    refund: vi.fn(),
    transition: vi.fn(),
    writeLog: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => {
    const actual = await importOriginal<typeof import("next/server")>();
    return { ...actual, after: vi.fn() };
});
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.currentUser }));
vi.mock("@/lib/auth/store", () => ({ refundUserPoints: mocks.refund }));
vi.mock("@/lib/server/internal-origin", () => ({ fetchInternalApi: vi.fn(), resolveInternalOrigin: vi.fn(() => "http://localhost") }));
vi.mock("@/lib/server/points-response", () => ({ pointsResponseHeaders: vi.fn(() => new Headers()) }));
vi.mock("@/lib/server/generation-task-recovery-service", () => ({ runGenerationTaskRecoveryBatch: mocks.recover }));
vi.mock("@/lib/server/generation-task-store", () => ({ getStoredGenerationTaskRecord: mocks.getSchedule }));
vi.mock("@/lib/server/generation-task-scheduler", () => ({ scheduleGenerationTask: mocks.schedule }));
vi.mock("@/lib/server/video-task-log", () => ({ writeVideoGenerationLog: mocks.writeLog }));
vi.mock("@/lib/server/video-task-store", () => ({
    canReconcileVideoTask: (task: { status: string; error?: string }) => task.status === "running" || (task.status === "error" && /视频生成超时|视频任务长时间未更新/.test(task.error || "")),
    getVideoTask: mocks.getVideoTask,
    transitionVideoTask: mocks.transition,
}));

import { GET, PATCH, POST } from "./route";

const context = { params: Promise.resolve({ id: "local-video" }) };

describe("GET /api/video-tasks/[id]", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.currentUser.mockResolvedValue({ id: "user", role: "user", pointsBalance: 100 });
        mocks.getSchedule.mockResolvedValue({ executionPhase: "polling" });
        mocks.schedule.mockResolvedValue({ executionPhase: "polling" });
        mocks.recover.mockResolvedValue({ claimed: 1 });
        mocks.writeLog.mockResolvedValue(undefined);
    });

    it("returns a running task without running recovery work", async () => {
        const task = videoTask();
        mocks.getVideoTask.mockResolvedValue(task);

        const response = await GET(new Request("http://localhost/api/video-tasks/local-video", { headers: { cookie: "session=test" } }), context);

        expect(response.status).toBe(200);
        expect(after).not.toHaveBeenCalled();
        expect(mocks.recover).not.toHaveBeenCalled();
        expect((await response.json()).task).toMatchObject({ status: "running" });
    });

    it("returns a legacy local timeout without running recovery work", async () => {
        const task = videoTask({ status: "error", error: "视频任务长时间未更新，请重新查询或生成。" });
        mocks.getVideoTask.mockResolvedValue(task);

        await GET(new Request("http://localhost/api/video-tasks/local-video"), context);

        expect(after).not.toHaveBeenCalled();
        expect(mocks.recover).not.toHaveBeenCalled();
    });

    it.each([
        ["cancelled", "任务已取消"],
        ["error", "The output video may contain sensitive information"],
    ])("does not reconcile a %s terminal task", async (status, error) => {
        mocks.getVideoTask.mockResolvedValue(videoTask({ status, error }));
        mocks.getSchedule.mockResolvedValue({ executionPhase: "completed" });

        await GET(new Request("http://localhost/api/video-tasks/local-video"), context);

        expect(after).not.toHaveBeenCalled();
    });

    it("returns the existing local state when upstream reconciliation is temporarily unavailable", async () => {
        const task = videoTask();
        mocks.getVideoTask.mockResolvedValue(task);
        const response = await GET(new Request("http://localhost/api/video-tasks/local-video"), context);

        expect(response.status).toBe(200);
        expect((await response.json()).task).toMatchObject({ status: "running" });
    });

    it("returns the persisted manual review reason", async () => {
        mocks.getVideoTask.mockResolvedValue(videoTask({ reviewReason: "视频提交结果无法确认" }));
        mocks.getSchedule.mockResolvedValue({ executionPhase: "needs_review" });

        const response = await GET(new Request("http://localhost/api/video-tasks/local-video"), context);

        expect((await response.json()).task).toMatchObject({ needsReview: true, reviewReason: "视频提交结果无法确认" });
    });

    it("does not let a stale schedule payload replace the normalized review reason", async () => {
        mocks.getVideoTask.mockResolvedValue(videoTask({ reviewReason: "上游提交结果暂时无法确认" }));
        mocks.getSchedule.mockResolvedValue({ executionPhase: "needs_review", resultPayload: { reviewReason: "参考素材无法提交" } });

        const response = await GET(new Request("http://localhost/api/video-tasks/local-video"), context);

        expect((await response.json()).task).toMatchObject({ needsReview: true, reviewReason: "上游提交结果暂时无法确认" });
    });

    it("checks the same upstream video task and persists a ready result", async () => {
        const running = videoTask();
        mocks.getVideoTask.mockResolvedValueOnce(running).mockResolvedValueOnce(videoTask({ status: "success", result: { url: "/api/generation-log-assets/result.mp4" } }));
        mocks.getSchedule
            .mockResolvedValueOnce({ executionPhase: "needs_review", submittedAt: 1_000 })
            .mockResolvedValueOnce({ executionPhase: "result_ready" })
            .mockResolvedValueOnce({ executionPhase: "completed" })
            .mockResolvedValueOnce({ executionPhase: "completed" });

        const response = await POST(
            new Request("http://localhost/api/video-tasks/local-video", {
                method: "POST",
                headers: { "content-type": "application/json", cookie: "session=test" },
                body: JSON.stringify({ action: "recover" }),
            }),
            context,
        );

        expect(response.status).toBe(200);
        expect(mocks.schedule).toHaveBeenCalledWith("video", "local-video", expect.objectContaining({ executionPhase: "polling", upstreamTaskId: "upstream-video", submittedAt: 1_000 }));
        expect(mocks.recover).toHaveBeenCalledTimes(2);
        expect((await response.json()).task).toMatchObject({ status: "success", executionPhase: "completed" });
    });

    it("rejects browser attempts to submit a terminal status or result URL", async () => {
        mocks.getVideoTask.mockResolvedValue(videoTask());

        const response = await PATCH(
            new Request("http://localhost/api/video-tasks/local-video", {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ status: "success", result: { url: "https://attacker.example/result.mp4" } }),
            }),
            context,
        );

        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: "视频任务终态和结果只能由服务端更新" });
        expect(mocks.transition).not.toHaveBeenCalled();
    });

    it("keeps cancellation as a server-controlled action", async () => {
        const task = videoTask({ upstream: { id: "upstream-video", provider: "generation", model: "video-model", pointsCost: 2, pointsRecordId: "points-one" } });
        mocks.getVideoTask.mockResolvedValue(task);
        mocks.transition.mockResolvedValue({ ...task, status: "cancelled" });

        const response = await PATCH(
            new Request("http://localhost/api/video-tasks/local-video", {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ action: "cancel" }),
            }),
            context,
        );

        expect(response.status).toBe(200);
        expect(mocks.transition).toHaveBeenCalledWith(task, { status: "cancelled", error: "任务已取消", retryable: false }, expect.objectContaining({ executionPhase: "cancel_requested", upstreamTaskId: "upstream-video" }));
        expect(mocks.writeLog).toHaveBeenCalledWith(expect.objectContaining({ status: "cancelled" }), "failed", "任务已取消", false);
        expect(mocks.refund).not.toHaveBeenCalled();
    });
});

import { after } from "next/server";

function videoTask(patch: Record<string, unknown> = {}) {
    return {
        id: "local-video",
        userId: "user",
        status: "running",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        config: { channelId: "channel", baseUrl: "/api/ai/system/channel", apiKey: "system", apiFormat: "openai", model: "video-model" },
        upstream: { id: "upstream-video", provider: "generation", model: "video-model" },
        requestedDurationSeconds: 5,
        ...patch,
    };
}
