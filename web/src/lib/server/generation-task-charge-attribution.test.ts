import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ provider: vi.fn(), query: vi.fn(), auth: vi.fn(), saved: [] as Array<Record<string, unknown>> }));
vi.mock("./database", () => ({ getDatabaseProvider: mocks.provider, ensurePostgresSchema: vi.fn(), postgresQuery: mocks.query }));
vi.mock("@/lib/auth/store-repository", () => ({ readAuthDb: mocks.auth }));
vi.mock("./data-adapter", () => ({
    readJsonDataFile: vi.fn(async () => structuredClone(mocks.saved)),
    withJsonDataFileLock: vi.fn(async (_file: string, callback: () => Promise<unknown>) => callback()),
    writeJsonDataFile: vi.fn(async (_file: string, value: Array<Record<string, unknown>>) => {
        mocks.saved = structuredClone(value);
    }),
}));

import {
    readFileGenerationTaskChargeAttributions,
    recordAgentAuxiliaryCharge,
    recordDramaAnalysisCharge,
    recordGenerationTaskCharges,
    summarizeGenerationProjectChargeDetails,
    summarizeGenerationRunChargeDetails,
    summarizeGenerationRunNetCharges,
    summarizeGenerationTaskNetCharges,
} from "./generation-task-charge-attribution";

const task = { id: "task-one", userId: "user-one", projectId: "project-one", runId: "run-one", billing: { pointsRecordId: "charge-one" }, attempts: [{ pointsRecordId: "charge-one" }, { pointsRecordId: "charge-two" }] };

describe("generation task charge attribution", () => {
    beforeEach(() => {
        mocks.provider.mockReset().mockReturnValue("file");
        mocks.query.mockReset();
        mocks.auth.mockReset().mockResolvedValue({
            pointRecords: [
                { id: "charge-one", userId: "user-one", type: "consume" },
                { id: "charge-two", userId: "user-one", type: "consume" },
            ],
        });
        mocks.saved = [];
    });

    it("stores each charge once against a durable project and task identity", async () => {
        await recordGenerationTaskCharges("image", task);
        await recordGenerationTaskCharges("image", task);
        expect(await readFileGenerationTaskChargeAttributions()).toEqual([
            { recordId: "charge-one", userId: "user-one", taskId: "task-one", projectId: "project-one", taskType: "image", runId: "run-one", purpose: "generation" },
            { recordId: "charge-two", userId: "user-one", taskId: "task-one", projectId: "project-one", taskType: "image", runId: "run-one", purpose: "generation" },
        ]);
    });

    it("retains a Run-only charge and safely adds its project later", async () => {
        await recordGenerationTaskCharges("image", { ...task, projectId: undefined, attempts: [] });
        expect(await readFileGenerationTaskChargeAttributions()).toMatchObject([{ recordId: "charge-one", runId: "run-one" }]);
        expect((await readFileGenerationTaskChargeAttributions())[0].projectId).toBeUndefined();
        await recordGenerationTaskCharges("image", { ...task, attempts: [] });
        expect(await readFileGenerationTaskChargeAttributions()).toMatchObject([{ recordId: "charge-one", runId: "run-one", projectId: "project-one" }]);
        await expect(recordGenerationTaskCharges("image", { ...task, runId: "different-run", attempts: [] })).rejects.toThrow("其他生成任务");
    });

    it("rejects a foreign charge or conflicting project ownership", async () => {
        mocks.auth.mockResolvedValueOnce({ pointRecords: [{ id: "charge-one", userId: "other", type: "consume" }] });
        await expect(recordGenerationTaskCharges("image", { ...task, attempts: [] })).rejects.toThrow("用户身份");
        mocks.saved = [{ recordId: "charge-one", userId: "user-one", taskId: "task-one", projectId: "other", taskType: "image", purpose: "generation" }];
        await expect(recordGenerationTaskCharges("image", { ...task, attempts: [] })).rejects.toThrow("其他生成任务");
    });

    it("uses the owning point record and rejects an existing conflicting PostgreSQL link", async () => {
        mocks.provider.mockReturnValue("postgres");
        mocks.query.mockResolvedValueOnce({ rows: [{ record_id: "charge-one" }] }).mockResolvedValueOnce({ rows: [{ record_id: "charge-two" }] });
        await recordGenerationTaskCharges("video", task);
        expect(mocks.query).toHaveBeenCalledTimes(2);
        expect(mocks.query.mock.calls[0][0]).toContain("FROM point_records WHERE id = $1 AND user_id = $2 AND type = 'consume'");
        expect(mocks.query.mock.calls[0][1]).toEqual(["charge-one", "user-one", "task-one", "project-one", "video", "run-one", "generation", null]);
        mocks.query.mockResolvedValueOnce({ rows: [] });
        await expect(recordGenerationTaskCharges("video", { ...task, attempts: [] })).rejects.toThrow("项目归属");
    });

    it("inserts a Run-only PostgreSQL link and rejects reassignment to another Run", async () => {
        mocks.provider.mockReturnValue("postgres");
        mocks.query.mockResolvedValueOnce({ rows: [{ record_id: "charge-one" }] });
        await recordGenerationTaskCharges("image", { ...task, projectId: undefined, attempts: [] });
        expect(mocks.query.mock.calls[0][1]).toEqual(["charge-one", "user-one", "task-one", null, "image", "run-one", "generation", null]);
        expect(mocks.query.mock.calls[0][0]).toContain("generation_task_charge_attributions.run_id = EXCLUDED.run_id");
        mocks.query.mockResolvedValueOnce({ rows: [] });
        await expect(recordGenerationTaskCharges("image", { ...task, projectId: undefined, runId: "other-run", attempts: [] })).rejects.toThrow("项目归属");
    });

    it("sums settled charges less fixed and priced refund records after tasks expire", async () => {
        mocks.saved = [
            { recordId: "charge-one", userId: "user-one", taskId: "expired-image", projectId: "project-one", taskType: "image", purpose: "generation" },
            { recordId: "charge-two", userId: "user-one", taskId: "expired-video", projectId: "project-one", taskType: "video", purpose: "generation" },
            { recordId: "other-charge", userId: "user-one", taskId: "other", projectId: "project-two", taskType: "image", purpose: "generation" },
        ];
        mocks.auth.mockResolvedValueOnce({
            pointRecords: [
                { id: "charge-one", userId: "user-one", type: "consume", amount: -10 },
                { id: "fixed-refund", userId: "user-one", type: "refund", amount: 3, sourceRecordId: "charge-one" },
                { id: "charge-two", userId: "user-one", type: "consume", amount: -20 },
                { id: "priced-refund", userId: "user-one", type: "refund", amount: 0 },
            ],
            pricingRefunds: [{ userId: "user-one", chargeRecordId: "charge-two", recordId: "priced-refund", calculation: { quotaRefundedPoints: "5" } }],
        });
        expect(await summarizeGenerationTaskNetCharges("user-one", "project-one", ["image", "video"])).toEqual([
            { type: "image", actualPoints: 7 },
            { type: "video", actualPoints: 15 },
        ]);
    });

    it("queries PostgreSQL by project attribution and joins refund receipts by charge", async () => {
        mocks.provider.mockReturnValue("postgres");
        mocks.query.mockResolvedValueOnce({ rows: [{ task_type: "image", purpose: "generation", logical_model_id: null, charged_points: "10.00", refunded_points: "3.00" }] });
        expect(await summarizeGenerationTaskNetCharges("user-one", "project-one", ["image"])).toEqual([{ type: "image", actualPoints: 7 }]);
        const [statement, params] = mocks.query.mock.calls[0];
        expect(statement).toContain("FROM generation_task_charge_attributions attribution");
        expect(statement).toContain("refund.source_record_id = charge.id");
        expect(statement).toContain("receipt.request_id = reservation.request_id");
        expect(params).toEqual(["user-one", "project-one", ["image"]]);
    });

    it("keeps project receipt details separated by model and purpose", async () => {
        mocks.saved = [
            { recordId: "charge-one", userId: "user-one", taskId: "canvas-task", projectId: "canvas-one", taskType: "image", purpose: "generation", logicalModelId: "image-a" },
            { recordId: "charge-two", userId: "user-one", taskId: "canvas-run:planning", projectId: "canvas-one", taskType: "text", purpose: "planning", logicalModelId: "planner" },
        ];
        mocks.auth.mockResolvedValueOnce({
            pointRecords: [
                { id: "charge-one", userId: "user-one", type: "consume", amount: -10 },
                { id: "refund-one", userId: "user-one", type: "refund", amount: 3, sourceRecordId: "charge-one" },
                { id: "charge-two", userId: "user-one", type: "consume", amount: -2 },
            ],
            pricingRefunds: [],
        });
        expect(await summarizeGenerationProjectChargeDetails("user-one", "canvas-one", ["text", "image"])).toEqual([
            { type: "image", purpose: "generation", logicalModelId: "image-a", chargedPoints: 10, refundedPoints: 3, actualPoints: 7 },
            { type: "text", purpose: "planning", logicalModelId: "planner", chargedPoints: 2, refundedPoints: 0, actualPoints: 2 },
        ]);
    });

    it("queries PostgreSQL by Run identity without relying on a project", async () => {
        mocks.provider.mockReturnValue("postgres");
        mocks.query.mockResolvedValueOnce({ rows: [{ task_type: "image", purpose: "generation", logical_model_id: "image-model", charged_points: "24.50", refunded_points: "0.00" }] });
        expect(await summarizeGenerationRunNetCharges("user-one", "run-one", ["image"])).toEqual([{ type: "image", actualPoints: 24.5 }]);
        const [statement, params] = mocks.query.mock.calls[0];
        expect(statement).toContain("attribution.run_id = $2");
        expect(params).toEqual(["user-one", "run-one", ["image"]]);
    });

    it("separates Run charges, confirmed refunds and purposes by logical model", async () => {
        mocks.saved = [
            { recordId: "charge-one", userId: "user-one", taskId: "task-one", runId: "run-one", taskType: "image", purpose: "generation", logicalModelId: "image-model" },
            { recordId: "charge-two", userId: "user-one", taskId: "run-one:planning", runId: "run-one", taskType: "text", purpose: "planning", logicalModelId: "planner" },
        ];
        mocks.auth.mockResolvedValueOnce({
            pointRecords: [
                { id: "charge-one", userId: "user-one", type: "consume", amount: -10 },
                { id: "refund-one", userId: "user-one", type: "refund", amount: 3, sourceRecordId: "charge-one" },
                { id: "charge-two", userId: "user-one", type: "consume", amount: -2 },
            ],
            pricingRefunds: [],
        });
        expect(await summarizeGenerationRunChargeDetails("user-one", "run-one", ["image", "text"])).toEqual([
            { type: "image", purpose: "generation", logicalModelId: "image-model", chargedPoints: 10, refundedPoints: 3, actualPoints: 7 },
            { type: "text", purpose: "planning", logicalModelId: "planner", chargedPoints: 2, refundedPoints: 0, actualPoints: 2 },
        ]);
    });

    it("attributes planning and review receipts separately from text generation", async () => {
        await recordAgentAuxiliaryCharge({ userId: "user-one", runId: "run-one", purpose: "planning", logicalModelId: "planner", pointsRecordId: "charge-one" });
        await recordAgentAuxiliaryCharge({ userId: "user-one", runId: "run-one", purpose: "planning", logicalModelId: "planner", pointsRecordId: "charge-one" });
        await recordAgentAuxiliaryCharge({ userId: "user-one", runId: "run-one", purpose: "review", logicalModelId: "planner", pointsRecordId: "charge-two" });
        expect(await readFileGenerationTaskChargeAttributions()).toEqual([
            { recordId: "charge-one", userId: "user-one", taskId: "run-one:planning", taskType: "text", runId: "run-one", purpose: "planning", logicalModelId: "planner" },
            { recordId: "charge-two", userId: "user-one", taskId: "run-one:review", taskType: "text", runId: "run-one", purpose: "review", logicalModelId: "planner" },
        ]);
        await expect(recordAgentAuxiliaryCharge({ userId: "user-one", runId: "other-run", purpose: "planning", logicalModelId: "planner", pointsRecordId: "charge-one" })).rejects.toThrow("其他生成任务");
    });

    it("keeps a short-drama analysis charge with its project after the analysis request ends", async () => {
        await recordDramaAnalysisCharge({ userId: "user-one", projectId: "project-one", callId: "analysis-call-one", logicalModelId: "planner", pointsRecordId: "charge-one" });
        await recordDramaAnalysisCharge({ userId: "user-one", projectId: "project-one", callId: "analysis-call-one", logicalModelId: "planner", pointsRecordId: "charge-one" });
        expect(await readFileGenerationTaskChargeAttributions()).toEqual([{ recordId: "charge-one", userId: "user-one", taskId: "analysis-call-one", projectId: "project-one", taskType: "text", purpose: "analysis", logicalModelId: "planner" }]);
        await expect(recordDramaAnalysisCharge({ userId: "user-one", projectId: "other-project", callId: "analysis-call-one", logicalModelId: "planner", pointsRecordId: "charge-one" })).rejects.toThrow("其他生成任务");
    });
});
