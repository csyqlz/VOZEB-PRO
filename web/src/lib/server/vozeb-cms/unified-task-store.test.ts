import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ provider: "file", read: vi.fn(), query: vi.fn(), ensure: vi.fn() }));

vi.mock("@/lib/server/data-adapter", () => ({ readJsonDataFile: mocks.read }));
vi.mock("@/lib/server/database", () => ({
    getDatabaseProvider: vi.fn(() => mocks.provider),
    ensurePostgresSchema: mocks.ensure,
    postgresQuery: mocks.query,
}));

import { listVozebCmsUnifiedTaskRecords } from "./unified-task-store";

describe("VOZEBCMS unified task store", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.provider = "file";
        mocks.read.mockImplementation(async (name: string) => {
            if (name === "generation-tasks.json") return fileTasks();
            if (name === "vozeb-workflows.json") return { runs: fileRuns() };
            return [];
        });
    });

    it("mixes generation and workflow records in a stable cursor order", async () => {
        const first = await listVozebCmsUnifiedTaskRecords({ userId: "user-one", projectId: "project-one", generationTypes: ["image", "video"], includeWorkflow: true, limit: 2 });

        expect(first.items.map((item) => item.id)).toEqual(["workflow-new", "video-same-time"]);
        expect(first).toMatchObject({ total: 3, hasMore: true });

        const cursorRecord = first.items.at(-1)!;
        const second = await listVozebCmsUnifiedTaskRecords({
            userId: "user-one",
            projectId: "project-one",
            generationTypes: ["image", "video"],
            includeWorkflow: true,
            cursor: { time: cursorRecord.updatedAt, source: cursorRecord.source, id: cursorRecord.id },
            limit: 2,
        });
        expect(second.items.map((item) => item.id)).toEqual(["image-old"]);
        expect(second).toMatchObject({ total: 3, hasMore: false });
    });

    it("enforces user, project, type and status filters before pagination", async () => {
        const result = await listVozebCmsUnifiedTaskRecords({
            userId: "user-one",
            projectId: "project-one",
            generationTypes: ["image"],
            generationStatuses: ["success"],
            includeWorkflow: true,
            workflowStatuses: ["completed"],
            limit: 10,
        });

        expect(result.items.map((item) => item.id)).toEqual(["workflow-new", "image-old"]);
        expect(result.items.every((item) => (item.source === "generation" ? item.record.userId === "user-one" && item.record.projectId === "project-one" : item.run.userId === "user-one" && item.run.projectId === "project-one"))).toBe(true);
    });

    it("uses a targeted PostgreSQL union with ownership, project and cursor predicates", async () => {
        mocks.provider = "postgres";
        mocks.query.mockResolvedValue({ rows: [{ source: null, total: 0 }] });

        await listVozebCmsUnifiedTaskRecords({
            userId: "user-one",
            projectId: "project-one",
            generationTypes: ["video"],
            generationStatuses: ["running"],
            includeWorkflow: true,
            workflowStatuses: ["waiting"],
            cursor: { time: Date.parse("2026-08-26T00:00:01.000Z"), source: "workflow", id: "workflow-one" },
            limit: 25,
        });

        const [sql, params] = mocks.query.mock.calls[0];
        expect(sql).toContain("UNION ALL");
        expect(sql).toContain("task.user_id = $1");
        expect(sql).toContain("run.user_id = $1");
        expect(sql).toContain("task.project_id = $2");
        expect(sql).toContain("run.project_id = $2");
        expect(sql).toContain("updated_at < $8");
        expect(sql).toContain("LIMIT $11");
        expect(params).toEqual(expect.arrayContaining(["user-one", "project-one", ["video"], ["running"], ["waiting"], 26]));
    });
});

function fileTasks() {
    const future = Date.parse("2027-01-01T00:00:00.000Z");
    return [
        task("video-same-time", "user-one", "project-one", "video", "running", Date.parse("2026-08-26T00:00:02.000Z"), future),
        task("image-old", "user-one", "project-one", "image", "success", Date.parse("2026-08-26T00:00:01.000Z"), future),
        task("other-project", "user-one", "project-two", "image", "success", Date.parse("2026-08-26T00:00:04.000Z"), future),
        task("other-user", "user-two", "project-one", "image", "success", Date.parse("2026-08-26T00:00:05.000Z"), future),
    ];
}

function fileRuns() {
    return [run("workflow-new", "user-one", "project-one", "completed", Date.parse("2026-08-26T00:00:02.000Z")), run("workflow-other-user", "user-two", "project-one", "completed", Date.parse("2026-08-26T00:00:06.000Z"))];
}

function task(id: string, userId: string, projectId: string, type: "image" | "video", status: "running" | "success", updatedAt: number, expiresAt: number) {
    return { id, userId, projectId, type, status, payload: {}, createdAt: updatedAt - 1_000, updatedAt, expiresAt };
}

function run(id: string, userId: string, projectId: string, status: "completed", updatedAt: number) {
    const definition = {
        id: `definition-${id}`,
        userId,
        projectId,
        name: id,
        version: 1,
        enabled: true,
        nodes: [{ id: "task", kind: "task", name: "任务", dependsOn: [], config: { output: true } }],
        createdAt: updatedAt - 2_000,
        updatedAt: updatedAt - 2_000,
    };
    return {
        id,
        userId,
        projectId,
        workflowId: definition.id,
        definitionVersion: 1,
        definitionSnapshot: definition,
        status,
        version: 1,
        context: {},
        nodeStates: { task: { status: "success", attempts: 1, updatedAt } },
        createdAt: updatedAt - 1_000,
        updatedAt,
    };
}
