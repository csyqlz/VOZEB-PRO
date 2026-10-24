import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ provider: vi.fn(), query: vi.fn(), auth: vi.fn(), runTasks: vi.fn(), projectTasks: vi.fn() }));
vi.mock("./database", () => ({ getDatabaseProvider: mocks.provider, ensurePostgresSchema: vi.fn(), postgresQuery: mocks.query }));
vi.mock("@/lib/auth/store-repository", () => ({ readAuthDb: mocks.auth }));
vi.mock("./generation-task-store", () => ({ listStoredGenerationTaskRecordsByRunIds: mocks.runTasks, listStoredGenerationTaskRecordsByProjectIds: mocks.projectTasks }));

import { readGenerationPendingHolds } from "./generation-billing-pending-service";

describe("pending generation billing", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.provider.mockReturnValue("file");
        mocks.projectTasks.mockResolvedValue([
            { id: "image-one", type: "image" },
            { id: "image-two", type: "image" },
        ]);
        mocks.runTasks.mockResolvedValue([{ id: "run-task", type: "text" }]);
        mocks.auth.mockResolvedValue({
            pricingReservations: [
                { userId: "user", status: "reserved", modelId: "image-a", preparation: { taskId: "image-one" }, allocation: { heldPoints: "10" }, estimatedHold: { heldPoints: "4.25" } },
                { userId: "user", status: "reserved", modelId: "image-a", preparation: { taskId: "image-two" }, allocation: { heldPoints: "2.50" } },
                { userId: "user", status: "settled", modelId: "image-a", preparation: { taskId: "image-one" }, allocation: { heldPoints: "8" } },
                { userId: "other", status: "reserved", modelId: "image-a", preparation: { taskId: "image-one" }, allocation: { heldPoints: "20" } },
                { userId: "user", status: "reserved", modelId: "text-a", preparation: { taskId: "run-task" }, allocation: { heldPoints: "1.25" } },
            ],
        });
    });

    it("keeps a project's open reservations separate from other users, tasks and settled charges", async () => {
        expect(await readGenerationPendingHolds("user", { kind: "project", id: "canvas-one" })).toEqual([{ type: "image", logicalModelId: "image-a", heldPoints: 6.75, count: 2 }]);
        expect(mocks.projectTasks).toHaveBeenCalledWith(["canvas-one"], "user");
        expect(mocks.runTasks).not.toHaveBeenCalled();
    });

    it("preserves the Run scope after sharing the pending reader", async () => {
        expect(await readGenerationPendingHolds("user", { kind: "run", id: "run-one" })).toEqual([{ type: "text", logicalModelId: "text-a", heldPoints: 1.25, count: 1 }]);
        expect(mocks.runTasks).toHaveBeenCalledWith(["run-one"], ["user"]);
    });

    it("uses a directed PostgreSQL join to the owning project's original task", async () => {
        mocks.provider.mockReturnValue("postgres");
        mocks.query.mockResolvedValueOnce({ rows: [{ task_type: "image", model_id: "image-a", held_points: "6.75", hold_count: 2 }] });
        expect(await readGenerationPendingHolds("user", { kind: "project", id: "canvas-one" })).toEqual([{ type: "image", logicalModelId: "image-a", heldPoints: 6.75, count: 2 }]);
        const [statement, params] = mocks.query.mock.calls[0];
        expect(statement).toContain("task.id = reservation.data #>> '{preparation,taskId}' AND task.user_id = reservation.user_id");
        expect(statement).toContain("task.project_id = $2 AND reservation.status = 'reserved'");
        expect(params).toEqual(["user", "canvas-one", ["text", "image", "video", "audio"]]);
        expect(mocks.auth).not.toHaveBeenCalled();
    });
});
