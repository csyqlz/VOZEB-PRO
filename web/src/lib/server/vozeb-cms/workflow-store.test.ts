import { beforeEach, describe, expect, it, vi } from "vitest";
import { createVozebCmsWorkflowRun as createRun } from "@/lib/vozeb-cms/workflow-contract";

type WorkflowFixture = { version: number; definitions: unknown[]; runs: unknown[]; events: unknown[] };

const mocks = vi.hoisted(() => ({
    provider: "file" as "file" | "postgres",
    database: { version: 1, definitions: [], runs: [], events: [] } as WorkflowFixture,
    query: vi.fn(),
}));

vi.mock("@/lib/server/data-adapter", () => ({
    readJsonDataFile: vi.fn(async () => mocks.database),
    writeJsonDataFile: vi.fn(async (_name, value) => {
        mocks.database = value;
    }),
    withJsonDataFileLock: vi.fn(async (_name, operation) => operation()),
}));
vi.mock("@/lib/server/database", () => ({
    ensurePostgresSchema: vi.fn(),
    getDatabaseProvider: () => mocks.provider,
    postgresQuery: mocks.query,
    withPostgresTransaction: vi.fn(),
}));
vi.mock("./workflow-event-signal", () => ({ notifyVozebCmsWorkflowEvent: vi.fn() }));

import {
    claimVozebCmsWorkflowRunsForMaintenance,
    createVozebCmsWorkflowDefinition,
    createVozebCmsWorkflowRun,
    getVozebCmsWorkflowRun,
    getNextVozebCmsWorkflowDueAt,
    listVozebCmsWorkflowEvents,
    listVozebCmsWorkflowRuns,
    mutateVozebCmsWorkflowRun,
    VozebCmsWorkflowStoreError,
} from "./workflow-store";

describe("VOZEBCMS workflow store", () => {
    beforeEach(() => {
        mocks.provider = "file";
        mocks.database = { version: 1, definitions: [], runs: [], events: [] };
        mocks.query.mockReset();
    });

    it("persists a definition, idempotent run, mutation and event on the file provider", async () => {
        const definition = await createVozebCmsWorkflowDefinition("user-one", {
            id: "workflow-one",
            name: "短剧流程",
            nodes: [{ id: "task", kind: "task", name: "视频任务", config: { taskId: "task-one" } }],
        });
        const run = { ...createRun(definition, "user-one", {}, "request-one"), id: "run-one" };
        await expect(createVozebCmsWorkflowRun(run)).resolves.toEqual(run);
        await expect(createVozebCmsWorkflowRun({ ...run, id: "run-duplicate" })).resolves.toEqual(run);
        await mutateVozebCmsWorkflowRun("user-one", "run-one", (current) => ({ run: { ...current, status: "waiting" }, event: { type: "workflow.waiting", data: { nodeId: "task" } } }));

        await expect(getVozebCmsWorkflowRun("user-one", "run-one")).resolves.toMatchObject({ status: "waiting", version: 2 });
        await expect(listVozebCmsWorkflowRuns("user-one", { workflowId: "workflow-one" })).resolves.toMatchObject([{ id: "run-one", status: "waiting" }]);
        await expect(listVozebCmsWorkflowEvents("user-one", "run-one")).resolves.toMatchObject([{ type: "workflow.waiting", data: { nodeId: "task" } }]);
        await expect(listVozebCmsWorkflowEvents("user-two", "run-one")).resolves.toEqual([]);
    });

    it("preserves the immutable definition snapshot across run mutations", async () => {
        const definition = await createVozebCmsWorkflowDefinition("user-one", {
            id: "workflow-one",
            name: "原始流程",
            version: 3,
            nodes: [{ id: "task", kind: "task", name: "原始任务", config: { taskId: "task-one" } }],
        });
        const run = { ...createRun(definition, "user-one", {}), id: "run-one" };
        await createVozebCmsWorkflowRun(run);
        await mutateVozebCmsWorkflowRun("user-one", "run-one", (current) => ({
            run: {
                ...current,
                definitionVersion: 99,
                definitionSnapshot: { ...current.definitionSnapshot, version: 99, name: "被篡改流程", nodes: [] },
                status: "waiting",
            },
        }));

        await expect(getVozebCmsWorkflowRun("user-one", "run-one")).resolves.toMatchObject({
            definitionVersion: 3,
            definitionSnapshot: { version: 3, name: "原始流程", nodes: [{ id: "task", name: "原始任务" }] },
            status: "waiting",
        });
    });

    it("claims due file runs fairly while leaving manual review dormant", async () => {
        const definition = await createVozebCmsWorkflowDefinition("user-one", {
            id: "workflow-one",
            name: "调度流程",
            nodes: [
                { id: "task", kind: "task", name: "任务", config: {} },
                { id: "review", kind: "manual_review", name: "审核", dependsOn: ["task"], config: {} },
            ],
        });
        const now = Date.now();
        const later = { ...createRun(definition, "user-one", {}), id: "run-later", nextRunAt: now + 10_000 };
        const due = { ...createRun(definition, "user-one", {}), id: "run-due", nextRunAt: now - 1_000 };
        const review = {
            ...createRun(definition, "user-one", {}),
            id: "run-review",
            status: "waiting" as const,
            nextRunAt: undefined,
            nodeStates: {
                task: { status: "success" as const, attempts: 1, updatedAt: now },
                review: { status: "waiting" as const, attempts: 1, updatedAt: now },
            },
        };
        mocks.database.runs = [later, review, due];

        await expect(claimVozebCmsWorkflowRunsForMaintenance("worker-one", 10)).resolves.toMatchObject([{ id: "run-due" }]);
        await expect(getNextVozebCmsWorkflowDueAt()).resolves.toBe(now + 10_000);
        await expect(claimVozebCmsWorkflowRunsForMaintenance("worker-two", 10)).resolves.toEqual([]);
    });

    it("claims PostgreSQL runs with due-time fairness, expired-lease takeover and row locking", async () => {
        mocks.provider = "postgres";
        mocks.query.mockResolvedValueOnce({ rows: [] });

        await expect(claimVozebCmsWorkflowRunsForMaintenance("worker-one", 7, 60_000)).resolves.toEqual([]);

        const [sql, values] = mocks.query.mock.calls[0] || [];
        expect(String(sql)).toContain("next_run_at <= now()");
        expect(String(sql)).toContain("lease_until IS NULL OR lease_until < now()");
        expect(String(sql)).toContain("ORDER BY next_run_at ASC NULLS FIRST, updated_at ASC, id ASC");
        expect(String(sql)).toContain("FOR UPDATE SKIP LOCKED");
        expect(String(sql)).toContain("LIMIT $1");
        expect(values?.[0]).toBe(7);
        expect(values?.[1]).toBe("worker-one");
        expect(values?.[2]).toBeInstanceOf(Date);
    });

    it("returns a PostgreSQL conflict when a definition id was not inserted", async () => {
        mocks.provider = "postgres";
        mocks.query.mockResolvedValueOnce({ rows: [{ id: "workflow-one" }] }).mockResolvedValueOnce({ rows: [] });
        const input = {
            id: "workflow-one",
            name: "短剧流程",
            nodes: [{ id: "task", kind: "task", name: "视频任务", config: { taskId: "task-one" } }],
        };

        await expect(createVozebCmsWorkflowDefinition("user-one", input)).resolves.toMatchObject({ id: "workflow-one" });
        const duplicate = createVozebCmsWorkflowDefinition("user-one", input);
        await expect(duplicate).rejects.toBeInstanceOf(VozebCmsWorkflowStoreError);
        await expect(duplicate).rejects.toMatchObject({ message: "工作流已存在", status: 409 });
        expect(String(mocks.query.mock.calls[0]?.[0])).toContain("RETURNING id");
    });
});
