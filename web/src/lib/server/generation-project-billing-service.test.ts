import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ charges: vi.fn(), pending: vi.fn() }));
vi.mock("./generation-task-charge-attribution", () => ({ summarizeGenerationProjectChargeDetails: mocks.charges }));
vi.mock("./generation-billing-pending-service", () => ({ readGenerationPendingHolds: mocks.pending }));

import { getGenerationProjectBillingSummary } from "./generation-project-billing-service";

describe("generation project billing summary", () => {
    it("reports confirmed net charges and open holds as separate totals", async () => {
        mocks.charges.mockResolvedValueOnce([{ type: "image", purpose: "generation", logicalModelId: "image-a", chargedPoints: 10, refundedPoints: 3, actualPoints: 7 }]);
        mocks.pending.mockResolvedValueOnce([{ type: "image", logicalModelId: "image-a", heldPoints: 4.25, count: 1 }]);
        expect(await getGenerationProjectBillingSummary("user", "canvas-one")).toEqual({
            actualPoints: 7,
            pendingHeldPoints: 4.25,
            charges: [{ type: "image", purpose: "generation", logicalModelId: "image-a", chargedPoints: 10, refundedPoints: 3, actualPoints: 7 }],
            pending: [{ type: "image", logicalModelId: "image-a", heldPoints: 4.25, count: 1 }],
        });
        expect(mocks.pending).toHaveBeenCalledWith("user", { kind: "project", id: "canvas-one" });
    });
});
