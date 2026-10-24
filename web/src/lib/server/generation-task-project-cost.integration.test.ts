import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { emptyDb } from "@/lib/auth/store-normalizers";
import { writeAuthDb } from "@/lib/auth/store-repository";
import { readFileGenerationTaskChargeAttributions, recordAgentAuxiliaryCharge, recordDramaAnalysisCharge, summarizeGenerationRunNetCharges } from "./generation-task-charge-attribution";
import { getGenerationRunBillingSummary } from "./generation-run-billing-service";
import { getGenerationProjectBillingSummary } from "./generation-project-billing-service";
import { cleanupExpiredStoredGenerationTasks, createStoredGenerationTask, mutateStoredGenerationTask, summarizeStoredGenerationTaskCosts } from "./generation-task-store";

describe("project cost from retained charge receipts", () => {
    let directory: string;
    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "vozeb-project-cost-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
    });
    afterEach(async () => {
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    });

    it("retains net project cost after the generation task expires", async () => {
        const now = new Date().toISOString();
        const db = emptyDb();
        db.users.push({
            id: "user-one",
            accountId: "0001",
            username: "fixture",
            displayName: "fixture",
            bio: "",
            role: "user",
            adminPermissions: [],
            status: "active",
            pointsBalance: 93,
            passwordHash: "fixture",
            planId: db.settings.entitlements.defaultPlanId,
            createdAt: now,
            updatedAt: now,
        });
        db.pointRecords.push(
            { id: "charge-one", userId: "user-one", type: "consume", amount: -10, balanceAfter: 90, permanentAmount: -10, dailyAmount: 0, permanentBalanceAfter: 90, dailyBalanceAfter: 0, description: "fixture charge", createdAt: now },
            {
                id: "refund-one",
                userId: "user-one",
                type: "refund",
                amount: 3,
                balanceAfter: 93,
                permanentAmount: 3,
                dailyAmount: 0,
                permanentBalanceAfter: 93,
                dailyBalanceAfter: 0,
                description: "fixture refund",
                sourceRecordId: "charge-one",
                createdAt: now,
            },
        );
        await writeAuthDb(db);
        const createdAt = Date.now();
        await createStoredGenerationTask(
            "image",
            { id: "task-one", userId: "user-one", projectId: "project-one", status: "running", estimatedPoints: 8, config: { logicalModel: "image-a", model: "upstream-image" }, createdAt, updatedAt: createdAt },
            1_000,
        );
        await mutateStoredGenerationTask("image", "task-one", 1_000, (task) => ({ ...task, status: "success", billing: { pointsRecordId: "charge-one" } }));
        expect(await readFileGenerationTaskChargeAttributions()).toMatchObject([{ recordId: "charge-one", taskId: "task-one", projectId: "project-one" }]);
        expect(await summarizeStoredGenerationTaskCosts({ userId: "user-one", projectId: "project-one", types: ["image"] })).toMatchObject([{ taskCount: 1, estimatedPoints: 8, actualPoints: 7 }]);
        expect(await getGenerationProjectBillingSummary("user-one", "project-one")).toMatchObject({ actualPoints: 7, charges: [{ type: "image", logicalModelId: "image-a", chargedPoints: 10, refundedPoints: 3, actualPoints: 7 }] });
        await rm(join(directory, "generation-task-charge-attributions.json"));
        await cleanupExpiredStoredGenerationTasks({ limit: 10, now: new Date(Date.now() + 2_000) });
        expect(await readFileGenerationTaskChargeAttributions()).toMatchObject([{ recordId: "charge-one", taskId: "task-one" }]);
        expect(await summarizeStoredGenerationTaskCosts({ userId: "user-one", projectId: "project-one", types: ["image"] })).toMatchObject([{ taskCount: 0, estimatedPoints: 0, actualPoints: 7 }]);
        expect(await getGenerationProjectBillingSummary("user-one", "project-one")).toMatchObject({ actualPoints: 7, charges: [{ type: "image", logicalModelId: "image-a", actualPoints: 7 }] });
    });

    it("does not persist a task update when its charge cannot be attributed", async () => {
        const createdAt = Date.now();
        await createStoredGenerationTask("image", { id: "task-one", userId: "user-one", projectId: "project-one", status: "running", createdAt, updatedAt: createdAt }, 1_000);
        await expect(mutateStoredGenerationTask("image", "task-one", 1_000, (task) => ({ ...task, status: "success", billing: { pointsRecordId: "missing-charge" } }))).rejects.toThrow("生成任务消费流水与用户身份不一致");
        expect(await summarizeStoredGenerationTaskCosts({ userId: "user-one", projectId: "project-one", types: ["image"] })).toMatchObject([{ taskCount: 1, actualPoints: 0 }]);
    });

    it("shows a Canvas project's open hold without adding it to settled cost after task expiry", async () => {
        const db = emptyDb();
        db.pricingReservations.push({
            userId: "user-one",
            status: "reserved",
            modelId: "image-a",
            preparation: { taskId: "canvas-task" },
            allocation: { heldPoints: "9" },
            estimatedHold: { heldPoints: "4.25" },
        } as (typeof db.pricingReservations)[number]);
        await writeAuthDb(db);
        const createdAt = Date.now();
        await createStoredGenerationTask("image", { id: "canvas-task", userId: "user-one", projectId: "canvas-one", status: "running", billingMode: "official-usage", billingPending: true, createdAt, updatedAt: createdAt }, 1_000);
        await cleanupExpiredStoredGenerationTasks({ limit: 10, now: new Date(Date.now() + 2_000) });
        expect(await getGenerationProjectBillingSummary("user-one", "canvas-one")).toEqual({
            actualPoints: 0,
            pendingHeldPoints: 4.25,
            charges: [],
            pending: [{ type: "image", logicalModelId: "image-a", heldPoints: 4.25, count: 1 }],
        });
        expect(await getGenerationProjectBillingSummary("other", "canvas-one")).toEqual({ actualPoints: 0, pendingHeldPoints: 0, charges: [], pending: [] });
    });

    it("includes charged short-drama analysis calls and their confirmed refunds without a generation task", async () => {
        const now = new Date().toISOString();
        const db = emptyDb();
        db.pointRecords.push(
            { id: "analysis-charge", userId: "user-one", type: "consume", amount: -2.5, balanceAfter: 97.5, permanentAmount: -2.5, dailyAmount: 0, permanentBalanceAfter: 97.5, dailyBalanceAfter: 0, description: "analysis", createdAt: now },
            {
                id: "analysis-refund",
                userId: "user-one",
                type: "refund",
                amount: 1,
                balanceAfter: 98.5,
                permanentAmount: 1,
                dailyAmount: 0,
                permanentBalanceAfter: 98.5,
                dailyBalanceAfter: 0,
                description: "refund",
                sourceRecordId: "analysis-charge",
                createdAt: now,
            },
        );
        await writeAuthDb(db);
        await recordDramaAnalysisCharge({ userId: "user-one", projectId: "project-one", callId: "analysis-call", logicalModelId: "planner", pointsRecordId: "analysis-charge" });

        expect(await summarizeStoredGenerationTaskCosts({ userId: "user-one", projectId: "project-one", types: ["text", "image", "video", "audio"] })).toEqual([{ type: "text", status: "success", taskCount: 0, estimatedPoints: 0, actualPoints: 1.5 }]);
        expect(await summarizeStoredGenerationTaskCosts({ userId: "user-one", projectId: "other-project", types: ["text", "image", "video", "audio"] })).toEqual([]);
    });

    it("keeps a Run-only media charge after its task expires", async () => {
        const now = new Date().toISOString();
        const db = emptyDb();
        db.pointRecords.push(
            { id: "run-charge", userId: "user-one", type: "consume", amount: -4, balanceAfter: 96, permanentAmount: -4, dailyAmount: 0, permanentBalanceAfter: 96, dailyBalanceAfter: 0, description: "fixture charge", createdAt: now },
            { id: "text-charge", userId: "user-one", type: "consume", amount: -2, balanceAfter: 94, permanentAmount: -2, dailyAmount: 0, permanentBalanceAfter: 94, dailyBalanceAfter: 0, description: "fixture text charge", createdAt: now },
        );
        await writeAuthDb(db);
        const createdAt = Date.now();
        await createStoredGenerationTask("image", { id: "run-task", userId: "user-one", runId: "run-one", status: "running", createdAt, updatedAt: createdAt }, 1_000);
        await mutateStoredGenerationTask("image", "run-task", 1_000, (task) => ({ ...task, status: "success", billing: { pointsRecordId: "run-charge" } }));
        await createStoredGenerationTask("text", { id: "text-task", userId: "user-one", runId: "run-one", status: "running", createdAt, updatedAt: createdAt }, 1_000);
        await mutateStoredGenerationTask("text", "text-task", 1_000, (task) => ({ ...task, status: "success", billing: { pointsRecordId: "text-charge" } }));
        expect(await summarizeGenerationRunNetCharges("user-one", "run-one", ["image", "text"])).toEqual([
            { type: "image", actualPoints: 4 },
            { type: "text", actualPoints: 2 },
        ]);
        expect(await getGenerationRunBillingSummary("user-one", "run-one")).toMatchObject({ chargedPoints: 6, refundedPoints: 0, actualPoints: 6, pendingHeldPoints: 0 });
        await cleanupExpiredStoredGenerationTasks({ limit: 10, now: new Date(Date.now() + 2_000) });
        expect(await summarizeGenerationRunNetCharges("user-one", "run-one", ["image", "text"])).toEqual([
            { type: "image", actualPoints: 4 },
            { type: "text", actualPoints: 2 },
        ]);
        expect(await getGenerationRunBillingSummary("user-one", "run-one")).toMatchObject({ chargedPoints: 6, actualPoints: 6, pendingHeldPoints: 0 });
    });

    it("keeps independent same-capability model charges, both refund types and open holds across Run and project after expiry", async () => {
        const now = new Date().toISOString();
        const db = emptyDb();
        db.pointRecords.push(
            { id: "fixed-charge", userId: "user-one", type: "consume", amount: -5, balanceAfter: 95, permanentAmount: -5, dailyAmount: 0, permanentBalanceAfter: 95, dailyBalanceAfter: 0, description: "fixed", createdAt: now },
            {
                id: "fixed-refund",
                userId: "user-one",
                type: "refund",
                amount: 2,
                balanceAfter: 97,
                permanentAmount: 2,
                dailyAmount: 0,
                permanentBalanceAfter: 97,
                dailyBalanceAfter: 0,
                description: "fixed refund",
                sourceRecordId: "fixed-charge",
                createdAt: now,
            },
            { id: "metered-charge", userId: "user-one", type: "consume", amount: -7.25, balanceAfter: 89.75, permanentAmount: -7.25, dailyAmount: 0, permanentBalanceAfter: 89.75, dailyBalanceAfter: 0, description: "metered", createdAt: now },
            { id: "metered-refund", userId: "user-one", type: "refund", amount: 0, balanceAfter: 89.75, permanentAmount: 0, dailyAmount: 0, permanentBalanceAfter: 89.75, dailyBalanceAfter: 0, description: "metered refund", createdAt: now },
            { id: "planning-charge", userId: "user-one", type: "consume", amount: -1.5, balanceAfter: 88.25, permanentAmount: -1.5, dailyAmount: 0, permanentBalanceAfter: 88.25, dailyBalanceAfter: 0, description: "planning", createdAt: now },
        );
        db.pricingRefunds.push({ userId: "user-one", chargeRecordId: "metered-charge", recordId: "metered-refund", calculation: { quotaRefundedPoints: "1.25" } } as (typeof db.pricingRefunds)[number]);
        db.pricingReservations.push(
            { userId: "user-one", status: "settled", modelId: "image-b", chargeRecordId: "metered-charge", preparation: { taskId: "metered-task" } } as (typeof db.pricingReservations)[number],
            { userId: "user-one", status: "reserved", modelId: "image-c", preparation: { taskId: "pending-task" }, estimatedHold: { heldPoints: "4.5" }, allocation: { heldPoints: "9" } } as (typeof db.pricingReservations)[number],
        );
        await writeAuthDb(db);
        const createdAt = Date.now();
        for (const [id, logicalModel, pointsRecordId] of [
            ["fixed-task", "image-a", "fixed-charge"],
            ["metered-task", "image-b", "metered-charge"],
        ]) {
            await createStoredGenerationTask(
                "image",
                { id, userId: "user-one", projectId: "project-one", runId: "run-one", status: "running", billingMode: id === "metered-task" ? "official-usage" : "fixed-points", config: { logicalModel }, createdAt, updatedAt: createdAt },
                1_000,
            );
            await mutateStoredGenerationTask("image", id, 1_000, (task) => ({ ...task, status: "success", billing: { pointsRecordId } }));
        }
        await createStoredGenerationTask(
            "image",
            { id: "pending-task", userId: "user-one", projectId: "project-one", runId: "run-one", status: "running", config: { logicalModel: "image-c" }, billingMode: "official-usage", billingPending: true, createdAt, updatedAt: createdAt },
            1_000,
        );
        await recordAgentAuxiliaryCharge({ userId: "user-one", projectId: "project-one", runId: "run-one", purpose: "planning", logicalModelId: "planner", pointsRecordId: "planning-charge" });

        const expectedCharges = [
            { type: "image", purpose: "generation", logicalModelId: "image-a", chargedPoints: 5, refundedPoints: 2, actualPoints: 3 },
            { type: "image", purpose: "generation", logicalModelId: "image-b", chargedPoints: 7.25, refundedPoints: 1.25, actualPoints: 6 },
            { type: "text", purpose: "planning", logicalModelId: "planner", chargedPoints: 1.5, refundedPoints: 0, actualPoints: 1.5 },
        ];
        const expectedPending = [{ type: "image", logicalModelId: "image-c", heldPoints: 4.5, count: 1 }];
        const run = await getGenerationRunBillingSummary("user-one", "run-one");
        expect(run).toMatchObject({ chargedPoints: 13.75, refundedPoints: 3.25, actualPoints: 10.5, pendingHeldPoints: 4.5, pending: expectedPending });
        expect(run.charges).toEqual(expectedCharges);
        expect(await getGenerationProjectBillingSummary("user-one", "project-one")).toEqual({ actualPoints: 10.5, pendingHeldPoints: 4.5, charges: expectedCharges, pending: expectedPending });
        await cleanupExpiredStoredGenerationTasks({ limit: 10, now: new Date(Date.now() + 2_000) });
        expect(await getGenerationRunBillingSummary("user-one", "run-one")).toEqual(run);
        expect(await getGenerationProjectBillingSummary("other", "project-one")).toEqual({ actualPoints: 0, pendingHeldPoints: 0, charges: [], pending: [] });
    });
});
