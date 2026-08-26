import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    runRecovery: vi.fn(),
    schedule: vi.fn(),
    getRecord: vi.fn(),
}));

vi.mock("@/lib/server/generation-task-recovery-service", () => ({ runGenerationTaskRecoveryBatch: mocks.runRecovery }));
vi.mock("@/lib/server/generation-task-scheduler", () => ({ scheduleGenerationTask: mocks.schedule }));
vi.mock("@/lib/server/generation-task-store", () => ({ getStoredGenerationTaskRecord: mocks.getRecord }));

import { recoverGenerationTaskFromUpstream } from "@/lib/server/generation-task-user-recovery";

describe("user generation task recovery", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.schedule.mockResolvedValue({ id: "video-one" });
        mocks.runRecovery.mockResolvedValue({ claimed: 1 });
    });

    it("queries one original upstream task and returns a pending result to a checkable state", async () => {
        mocks.getRecord.mockResolvedValueOnce({ executionPhase: "polling" }).mockResolvedValueOnce({
            id: "video-one",
            status: "running",
            executionPhase: "polling",
            lastUpstreamStatus: "processing",
            resultPayload: { trace: "kept" },
        });

        await expect(
            recoverGenerationTaskFromUpstream({
                type: "video",
                id: "video-one",
                upstreamTaskId: "upstream-one",
                submittedAt: 1_000,
                origin: "http://internal",
            }),
        ).resolves.toBe(true);

        expect(mocks.runRecovery).toHaveBeenCalledTimes(1);
        expect(mocks.runRecovery).toHaveBeenCalledWith(expect.objectContaining({ taskIds: ["video-one"], limit: 1, userRequested: true }));
        expect(mocks.schedule).toHaveBeenLastCalledWith(
            "video",
            "video-one",
            expect.objectContaining({
                executionPhase: "needs_review",
                nextPollAt: undefined,
                lastUpstreamStatus: "processing",
                resultPayload: { trace: "kept", reviewReason: "上游任务仍在处理中，请稍后点击“检查状态”继续查询原任务" },
            }),
        );
    });

    it("persists an already returned result in the same user check", async () => {
        mocks.getRecord.mockResolvedValueOnce({ executionPhase: "result_ready" }).mockResolvedValueOnce({ id: "image-one", status: "success", executionPhase: "completed", resultPayload: { url: "https://cdn.example.com/result.png" } });

        await recoverGenerationTaskFromUpstream({
            type: "image",
            id: "image-one",
            upstreamTaskId: "upstream-image",
            submittedAt: 1_000,
            origin: "http://internal",
        });

        expect(mocks.runRecovery).toHaveBeenCalledTimes(2);
        expect(mocks.schedule).toHaveBeenCalledTimes(1);
    });
});
