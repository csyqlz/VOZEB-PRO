import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ currentUser: vi.fn(), getTextTask: vi.fn(), getSchedule: vi.fn(), recover: vi.fn(), recoverPriced: vi.fn() }));

vi.mock("next/server", async (importOriginal) => {
    const actual = await importOriginal<typeof import("next/server")>();
    return { ...actual, after: vi.fn() };
});
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.currentUser }));
vi.mock("@/lib/server/text-task-store", () => ({ getTextTask: mocks.getTextTask, transitionTextTask: vi.fn() }));
vi.mock("@/lib/server/generation-task-recovery-service", () => ({ runGenerationTaskRecoveryBatch: mocks.recover }));
vi.mock("@/lib/server/text-task-runtime", () => ({ recoverPricedTextTaskStep: mocks.recoverPriced }));
vi.mock("@/lib/server/generation-task-scheduler", () => ({ scheduleGenerationTask: vi.fn() }));
vi.mock("@/lib/server/generation-task-store", () => ({ getStoredGenerationTaskRecord: mocks.getSchedule }));
vi.mock("@/lib/server/internal-origin", () => ({ resolveInternalOrigin: vi.fn(() => "http://localhost") }));
vi.mock("@/lib/server/points-response", () => ({ pointsResponseHeaders: vi.fn(() => new Headers()) }));
vi.mock("@/lib/server/generation-channel", () => ({ generationModelId: vi.fn(() => "text-model") }));

import { after } from "next/server";
import { GET, POST } from "./route";

describe("GET /api/text-tasks/[id]", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.currentUser.mockResolvedValue({ id: "user", role: "user" });
        mocks.getTextTask.mockResolvedValue({ id: "text-one", userId: "user", status: "running", config: { model: "text-model" } });
        mocks.getSchedule.mockResolvedValue({ executionPhase: "polling" });
    });

    it("reads a running task without running recovery work", async () => {
        const response = await GET(new Request("http://localhost/api/text-tasks/text-one"), { params: Promise.resolve({ id: "text-one" }) });

        expect(response.status).toBe(200);
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

    it("recovers a priced receipt without an upstream task ID and hides internal metering evidence", async () => {
        const task = { id: "text-one", userId: "user", status: "running", billingMode: "official-usage", config: { model: "text-model" }, pricedResponses: [{ content: "public reply", observation: { private: true } }] };
        mocks.getTextTask.mockResolvedValueOnce(task).mockResolvedValue({ ...task, status: "success", result: { content: "public reply" } });
        mocks.recoverPriced.mockResolvedValue({ state: "completed" });
        const response = await POST(new Request("http://localhost/api/text-tasks/text-one", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "recover" }) }), {
            params: Promise.resolve({ id: "text-one" }),
        });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.task).toMatchObject({ status: "success", needsReview: false, result: { content: "public reply" } });
        expect(body.task).not.toHaveProperty("pricedResponses");
        expect(mocks.recoverPriced).toHaveBeenCalledWith(task);
        expect(mocks.recover).not.toHaveBeenCalled();
    });

    it("does not downgrade accounting completed by a concurrent reviewer", async () => {
        const task = { id: "text-one", userId: "user", status: "running", billingMode: "official-usage", billingPending: true, config: { model: "text-model" } };
        mocks.getTextTask.mockResolvedValueOnce(task).mockResolvedValue({ ...task, status: "error", billingPending: false });
        mocks.recoverPriced.mockResolvedValue({ state: "needs_review", error: "stale recovery outcome" });
        const response = await POST(new Request("http://localhost/api/text-tasks/text-one", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "recover" }) }), {
            params: Promise.resolve({ id: "text-one" }),
        });
        expect((await response.json()).task).toMatchObject({ status: "error", needsReview: false, executionPhase: "completed" });
    });
});
