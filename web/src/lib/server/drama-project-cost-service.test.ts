import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getProject: vi.fn(), summarizeCosts: vi.fn(), summarizeBilling: vi.fn() }));

vi.mock("@/lib/server/drama-project-service", () => ({ getDramaProjectForUser: mocks.getProject }));
vi.mock("@/lib/server/generation-task-store", () => ({ summarizeStoredGenerationTaskCosts: mocks.summarizeCosts }));
vi.mock("@/lib/server/generation-project-billing-service", () => ({ getGenerationProjectBillingSummary: mocks.summarizeBilling }));

import { getDramaProjectCostSummary } from "./drama-project-cost-service";

describe("drama project cost summary", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getProject.mockResolvedValue({ id: "project-one" });
        mocks.summarizeCosts.mockResolvedValue([
            { type: "image", status: "success", taskCount: 1, estimatedPoints: 2, actualPoints: 1.5 },
            { type: "video", status: "success", taskCount: 1, estimatedPoints: 8, actualPoints: 7 },
            { type: "audio", status: "error", taskCount: 1, estimatedPoints: 1, actualPoints: 0 },
            { type: "text", status: "success", taskCount: 0, estimatedPoints: 0, actualPoints: 2.5 },
        ]);
        mocks.summarizeBilling.mockResolvedValue({
            actualPoints: 11,
            pendingHeldPoints: 4.25,
            charges: [
                { type: "image", purpose: "generation", logicalModelId: "image-a", chargedPoints: 2, refundedPoints: 0.5, actualPoints: 1.5 },
                { type: "video", purpose: "generation", logicalModelId: "video-a", chargedPoints: 8, refundedPoints: 1, actualPoints: 7 },
                { type: "text", purpose: "analysis", logicalModelId: "text-a", chargedPoints: 3, refundedPoints: 0.5, actualPoints: 2.5 },
            ],
            pending: [{ type: "image", logicalModelId: "image-a", heldPoints: 4.25, count: 1 }],
        });
    });

    it("aggregates only the current project and excludes refunded failures", async () => {
        await expect(getDramaProjectCostSummary("user-one", "project-one")).resolves.toEqual({
            estimatedPoints: 11,
            actualPoints: 11,
            pendingHeldPoints: 4.25,
            taskCount: 3,
            successCount: 2,
            failedCount: 1,
            byType: {
                image: { tasks: 1, estimatedPoints: 2, actualPoints: 1.5 },
                video: { tasks: 1, estimatedPoints: 8, actualPoints: 7 },
                audio: { tasks: 1, estimatedPoints: 1, actualPoints: 0 },
                text: { tasks: 0, estimatedPoints: 0, actualPoints: 2.5 },
            },
            charges: [
                { type: "image", purpose: "generation", logicalModelId: "image-a", chargedPoints: 2, refundedPoints: 0.5, actualPoints: 1.5 },
                { type: "video", purpose: "generation", logicalModelId: "video-a", chargedPoints: 8, refundedPoints: 1, actualPoints: 7 },
                { type: "text", purpose: "analysis", logicalModelId: "text-a", chargedPoints: 3, refundedPoints: 0.5, actualPoints: 2.5 },
            ],
            pending: [{ type: "image", logicalModelId: "image-a", heldPoints: 4.25, count: 1 }],
        });
        expect(mocks.summarizeCosts).toHaveBeenCalledWith({ userId: "user-one", projectId: "project-one", types: ["text", "image", "video", "audio"] });
        expect(mocks.summarizeBilling).toHaveBeenCalledWith("user-one", "project-one");
    });

    it("does not read billing for a project owned by someone else", async () => {
        mocks.getProject.mockRejectedValueOnce(new Error("not found"));
        await expect(getDramaProjectCostSummary("other-user", "project-one")).rejects.toThrow("not found");
        expect(mocks.summarizeCosts).not.toHaveBeenCalled();
        expect(mocks.summarizeBilling).not.toHaveBeenCalled();
    });
});
