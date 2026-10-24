import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ provider: vi.fn(), query: vi.fn(), auth: vi.fn(), tasks: vi.fn(), charges: vi.fn() }));
vi.mock("./database", () => ({ getDatabaseProvider: mocks.provider, ensurePostgresSchema: vi.fn(), postgresQuery: mocks.query }));
vi.mock("@/lib/auth/store-repository", () => ({ readAuthDb: mocks.auth }));
vi.mock("./generation-task-store", () => ({ listStoredGenerationTaskRecordsByRunIds: mocks.tasks, listStoredGenerationTaskRecordsByProjectIds: vi.fn() }));
vi.mock("./generation-task-charge-attribution", () => ({ summarizeGenerationRunChargeDetails: mocks.charges }));

import { getGenerationRunBillingSummary } from "./generation-run-billing-service";

describe("generation Run billing summary", () => {
    beforeEach(() => {
        mocks.provider.mockReset().mockReturnValue("file");
        mocks.query.mockReset();
        mocks.tasks.mockReset().mockResolvedValue([
            { id: "image-task", type: "image" },
            { id: "text-task", type: "text" },
        ]);
        mocks.charges.mockReset().mockResolvedValue([{ type: "image", purpose: "generation", logicalModelId: "image-model", chargedPoints: 10, refundedPoints: 3, actualPoints: 7 }]);
        mocks.auth.mockReset().mockResolvedValue({
            pricingReservations: [
                { userId: "user", status: "reserved", modelId: "image-model", preparation: { taskId: "image-task" }, allocation: { heldPoints: "9" }, estimatedHold: { heldPoints: "4.25" } },
                { userId: "user", status: "settled", modelId: "image-model", preparation: { taskId: "image-task" }, allocation: { heldPoints: "9" } },
                { userId: "other", status: "reserved", modelId: "image-model", preparation: { taskId: "image-task" }, allocation: { heldPoints: "2" } },
                { userId: "user", status: "reserved", modelId: "other-model", preparation: { taskId: "other-task" }, allocation: { heldPoints: "8" } },
            ],
        });
    });

    it("keeps settled net cost and open holds separate", async () => {
        expect(await getGenerationRunBillingSummary("user", "run")).toEqual({
            chargedPoints: 10,
            refundedPoints: 3,
            actualPoints: 7,
            pendingHeldPoints: 4.25,
            charges: [{ type: "image", purpose: "generation", logicalModelId: "image-model", chargedPoints: 10, refundedPoints: 3, actualPoints: 7 }],
            pending: [{ type: "image", logicalModelId: "image-model", heldPoints: 4.25, count: 1 }],
        });
        expect(mocks.tasks).toHaveBeenCalledWith(["run"], ["user"]);
        expect(mocks.charges).toHaveBeenCalledWith("user", "run", ["text", "image", "video", "audio"]);
    });

    it("queries only this user's open reservations attached to this Run", async () => {
        mocks.provider.mockReturnValue("postgres");
        mocks.query.mockResolvedValueOnce({ rows: [{ task_type: "text", model_id: "planner", held_points: "2.50", hold_count: 1 }] });
        expect((await getGenerationRunBillingSummary("user", "run")).pending).toEqual([{ type: "text", logicalModelId: "planner", heldPoints: 2.5, count: 1 }]);
        const [statement, params] = mocks.query.mock.calls[0];
        expect(statement).toContain("task.id = reservation.data #>> '{preparation,taskId}'");
        expect(statement).toContain("task.run_id = $2 AND reservation.status = 'reserved'");
        expect(params).toEqual(["user", "run", ["text", "image", "video", "audio"]]);
        expect(mocks.auth).not.toHaveBeenCalled();
    });
});
