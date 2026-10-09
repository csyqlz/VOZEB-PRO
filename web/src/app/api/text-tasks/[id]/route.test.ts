import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ currentUser: vi.fn(), getTextTask: vi.fn(), getSchedule: vi.fn(), recover: vi.fn() }));

vi.mock("next/server", async (importOriginal) => {
    const actual = await importOriginal<typeof import("next/server")>();
    return { ...actual, after: vi.fn() };
});
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.currentUser }));
vi.mock("@/lib/server/text-task-store", () => ({ getTextTask: mocks.getTextTask, transitionTextTask: vi.fn() }));
vi.mock("@/lib/server/generation-task-recovery-service", () => ({ runGenerationTaskRecoveryBatch: mocks.recover }));
vi.mock("@/lib/server/generation-task-store", () => ({ getStoredGenerationTaskRecord: mocks.getSchedule }));
vi.mock("@/lib/server/internal-origin", () => ({ resolveInternalOrigin: vi.fn(() => "http://localhost") }));
vi.mock("@/lib/server/points-response", () => ({ pointsResponseHeaders: vi.fn(() => new Headers()) }));
vi.mock("@/lib/server/generation-channel", () => ({ generationModelId: vi.fn(() => "text-model") }));

import { after } from "next/server";
import { GET } from "./route";

describe("GET /api/text-tasks/[id]", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.currentUser.mockResolvedValue({ id: "user", role: "user" });
        mocks.getTextTask.mockResolvedValue({ id: "text-one", userId: "user", status: "running", config: { model: "text-model" } });
        mocks.getSchedule.mockResolvedValue({ executionPhase: "polling", lastUpstreamStatus: "analyzing_segment" });
    });

    it("reads a running task without running recovery work", async () => {
        const response = await GET(new Request("http://localhost/api/text-tasks/text-one"), { params: Promise.resolve({ id: "text-one" }) });

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ task: { executionPhase: "polling", lastUpstreamStatus: "analyzing_segment" } });
        expect(after).not.toHaveBeenCalled();
        expect(mocks.recover).not.toHaveBeenCalled();
    });

    it("does not wake a completed task", async () => {
        mocks.getTextTask.mockResolvedValue({ id: "text-one", userId: "user", status: "success", config: { model: "text-model" } });
        mocks.getSchedule.mockResolvedValue({ executionPhase: "completed" });

        await GET(new Request("http://localhost/api/text-tasks/text-one"), { params: Promise.resolve({ id: "text-one" }) });

        expect(after).not.toHaveBeenCalled();
    });

    it("returns the manual review reason without waking the task", async () => {
        mocks.getTextTask.mockResolvedValue({ id: "text-one", userId: "user", status: "running", reviewReason: "文本提交结果无法确认", config: { model: "text-model" } });
        mocks.getSchedule.mockResolvedValue({ executionPhase: "needs_review" });

        const response = await GET(new Request("http://localhost/api/text-tasks/text-one"), { params: Promise.resolve({ id: "text-one" }) });

        expect(after).not.toHaveBeenCalled();
        expect((await response.json()).task).toMatchObject({ needsReview: true, reviewReason: "文本提交结果无法确认" });
    });
});
