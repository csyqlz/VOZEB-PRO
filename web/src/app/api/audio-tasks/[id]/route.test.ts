import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    getAudioTask: vi.fn(),
    transitionAudioTask: vi.fn(),
    refundAudioTask: vi.fn(),
    recover: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => {
    const actual = await importOriginal<typeof import("next/server")>();
    return { ...actual, after: vi.fn() };
});
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/server/audio-task-store", () => ({ getAudioTask: mocks.getAudioTask, transitionAudioTask: mocks.transitionAudioTask }));
vi.mock("@/lib/server/audio-task-refund", () => ({ refundAudioTask: mocks.refundAudioTask }));
vi.mock("@/lib/server/internal-origin", () => ({ fetchInternalApi: vi.fn(), resolveInternalOrigin: vi.fn(() => "http://localhost") }));
vi.mock("@/lib/server/generation-channel", () => ({ generationModelId: vi.fn(() => "voice") }));
vi.mock("@/lib/server/generation-task-recovery-service", () => ({ runGenerationTaskRecoveryBatch: mocks.recover }));

import { after } from "next/server";
import { GET, PATCH } from "./route";

const task = {
    id: "audio-one",
    userId: "user",
    status: "running",
    config: { baseUrl: "https://api.example.com/v1", apiKey: "secret", apiFormat: "openai", model: "voice" },
    billing: { pointsCost: 8, pointsRecordId: "points-one", refunded: false },
};

describe("audio task cancellation refund", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCurrentUser.mockResolvedValue({ id: "user", pointsBalance: 100 });
        mocks.getAudioTask.mockResolvedValue(task);
        mocks.transitionAudioTask.mockImplementation(async (_task, _statuses, patch) => ({ ...task, ...patch }));
        mocks.refundAudioTask.mockImplementation(async (value) => ({ ...value, billing: { ...value.billing, refunded: true } }));
    });

    it("reads a running task without running recovery work", async () => {
        const response = await GET(new Request("http://localhost/api/audio-tasks/audio-one"), { params: Promise.resolve({ id: "audio-one" }) });

        expect(response.status).toBe(200);
        expect(after).not.toHaveBeenCalled();
        expect(mocks.recover).not.toHaveBeenCalled();
    });

    it("returns the manual review reason without waking the task", async () => {
        mocks.getAudioTask.mockResolvedValue({ ...task, executionPhase: "needs_review", reviewReason: "音频提交结果无法确认" });

        const response = await GET(new Request("http://localhost/api/audio-tasks/audio-one"), { params: Promise.resolve({ id: "audio-one" }) });

        expect(after).not.toHaveBeenCalled();
        expect((await response.json()).task).toMatchObject({ needsReview: true, reviewReason: "音频提交结果无法确认" });
    });

    it("keeps billing refundable while cancellation awaits an upstream terminal state", async () => {
        const response = await PATCH(new Request("http://localhost/api/audio-tasks/audio-one", { method: "PATCH", body: JSON.stringify({ status: "cancelled" }) }), { params: Promise.resolve({ id: "audio-one" }) });

        expect(response.status).toBe(200);
        expect(mocks.transitionAudioTask).toHaveBeenCalledWith(
            task,
            ["pending", "running"],
            expect.objectContaining({ status: "cancelled", billing: { pointsCost: 8, pointsRecordId: "points-one", refunded: false } }),
            expect.objectContaining({ executionPhase: "cancel_requested" }),
        );
        expect(mocks.refundAudioTask).not.toHaveBeenCalled();
        expect((await response.json()).task.billing.refunded).toBe(false);
    });
});
