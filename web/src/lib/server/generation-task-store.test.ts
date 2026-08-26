import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ records: [] as Array<Record<string, unknown>> }));

vi.mock("@/lib/server/database", () => ({
    ensurePostgresSchema: vi.fn(),
    getDatabaseProvider: vi.fn(() => "file"),
    postgresQuery: vi.fn(),
    withPostgresTransaction: vi.fn(),
}));
vi.mock("@/lib/server/data-adapter", () => ({
    readJsonDataFile: vi.fn(async () => structuredClone(mocks.records)),
    withJsonDataFileLock: vi.fn(async (_fileName: string, callback: () => Promise<unknown>) => callback()),
    writeJsonDataFile: vi.fn(async (_fileName: string, value: Array<Record<string, unknown>>) => {
        mocks.records = structuredClone(value);
    }),
}));

import { getDatabaseProvider, postgresQuery, withPostgresTransaction } from "@/lib/server/database";
import {
    cleanupExpiredStoredGenerationTasks,
    createStoredGenerationTask,
    getStoredGenerationTask,
    getStoredGenerationTaskByRequest,
    getStoredGenerationTaskByUpstream,
    generationCapacityRetryAfterSeconds,
    generationTaskPointsCost,
    listStoredGenerationTaskRecordsByRunIds,
    listStoredGenerationTaskRecords,
    queryStoredGenerationTasks,
    mutateStoredGenerationTask,
    summarizeStoredAgentPerformance,
    summarizeStoredGenerationTaskCosts,
    withGenerationConcurrencyLimit,
} from "./generation-task-store";

type TestTask = {
    id: string;
    userId: string;
    status: string;
    events: string[];
    createdAt: number;
    updatedAt: number;
};

describe("mutateStoredGenerationTask", () => {
    beforeEach(() => {
        vi.mocked(getDatabaseProvider).mockReturnValue("file");
        vi.mocked(postgresQuery).mockReset();
        vi.mocked(withPostgresTransaction).mockReset();
        const now = Date.now();
        mocks.records = [
            {
                id: "agent-one",
                userId: "user",
                type: "agent",
                status: "running",
                payload: { id: "agent-one", userId: "user", status: "running", events: [], createdAt: now, updatedAt: now },
                createdAt: now,
                updatedAt: now,
                expiresAt: now + 60_000,
            },
        ];
    });

    it("serializes file mutations so concurrent events are not lost", async () => {
        await Promise.all([
            mutateStoredGenerationTask<TestTask>("agent", "agent-one", 60_000, (current) => ({ ...current, events: [...current.events, "first"] })),
            mutateStoredGenerationTask<TestTask>("agent", "agent-one", 60_000, (current) => ({ ...current, events: [...current.events, "second"] })),
        ]);

        expect((mocks.records[0].payload as TestTask).events).toEqual(["first", "second"]);
    });

    it("removes only one stable bounded batch of expired file tasks", async () => {
        vi.mocked(getDatabaseProvider).mockReturnValue("file");
        const now = Date.now();
        mocks.records = [
            { id: "expired-new", userId: "user", type: "text", status: "success", payload: {}, createdAt: now - 2_000, updatedAt: now - 2_000, expiresAt: now - 1_000 },
            { id: "active", userId: "user", type: "text", status: "success", payload: {}, createdAt: now, updatedAt: now, expiresAt: now + 1_000 },
            { id: "expired-old", userId: "user", type: "text", status: "success", payload: {}, createdAt: now - 3_000, updatedAt: now - 3_000, expiresAt: now - 2_000 },
        ];

        await expect(cleanupExpiredStoredGenerationTasks({ limit: 1, now: new Date(now) })).resolves.toBe(1);
        expect(mocks.records.map((record) => record.id)).toEqual(["expired-new", "active"]);
    });

    it("uses a bounded PostgreSQL delete for expired tasks", async () => {
        vi.mocked(getDatabaseProvider).mockReturnValue("postgres");
        vi.mocked(postgresQuery).mockResolvedValueOnce({ rows: [{ id: "expired" }], command: "DELETE", rowCount: 1, oid: 0, fields: [] });
        const now = new Date("2026-08-09T12:00:00.000Z");

        await expect(cleanupExpiredStoredGenerationTasks({ limit: 25, now })).resolves.toBe(1);
        expect(vi.mocked(postgresQuery).mock.calls[0][0]).toContain("ORDER BY expires_at ASC, id ASC");
        expect(vi.mocked(postgresQuery).mock.calls[0][0]).toContain("LIMIT $2");
        expect(vi.mocked(postgresQuery).mock.calls[0][1]).toEqual([now.toISOString(), 25]);
        vi.mocked(getDatabaseProvider).mockReturnValue("file");
    });

    it("serializes concurrency checks with task creation", async () => {
        mocks.records = [];
        const create = (id: string) =>
            withGenerationConcurrencyLimit("user", "video", 60_000, 1, async () => {
                const now = Date.now();
                mocks.records.unshift({ id, userId: "user", type: "video", status: "pending", payload: {}, executionPhase: "created", createdAt: now, updatedAt: now, expiresAt: now + 60_000 });
                return id;
            });

        await expect(Promise.all([create("video-one"), create("video-two")])).resolves.toEqual(["video-one", null]);
        expect(mocks.records).toHaveLength(1);
    });

    it("releases the PostgreSQL transaction before running a reserved generation handler", async () => {
        vi.mocked(getDatabaseProvider).mockReturnValue("postgres");
        const events: string[] = [];
        const query = vi.fn(async (statement: string) => {
            events.push(statement.startsWith("INSERT INTO") ? "reservation:insert" : "transaction:query");
            if (statement.includes("SELECT 1 FROM generation_concurrency_reservations")) return { rows: [] };
            if (statement.includes("AS total")) return { rows: [{ total: "0" }] };
            return { rows: [] };
        });
        vi.mocked(withPostgresTransaction).mockImplementation(async (handler) => {
            events.push("transaction:start");
            const result = await handler({ query } as never);
            events.push("transaction:end");
            return result;
        });
        vi.mocked(postgresQuery).mockImplementation(async () => {
            events.push("reservation:delete");
            return { rows: [] } as never;
        });

        await expect(
            withGenerationConcurrencyLimit(
                "user",
                "image",
                60_000,
                1,
                async () => {
                    events.push("handler");
                    return "created";
                },
                undefined,
                "request-one",
            ),
        ).resolves.toBe("created");

        expect(events.indexOf("transaction:end")).toBeLessThan(events.indexOf("handler"));
        expect(events.indexOf("reservation:insert")).toBeLessThan(events.indexOf("transaction:end"));
        expect(events.at(-1)).toBe("reservation:delete");
        const aggregate = query.mock.calls.find(([statement]) => String(statement).includes("AS total"))?.[0];
        expect(aggregate).toContain("NOT EXISTS");
        expect(aggregate).toContain("task.client_request_id = reservation.request_id");
        expect(vi.mocked(postgresQuery)).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM generation_concurrency_reservations"), ["user", "image", "request-one"]);
    });

    it("releases a PostgreSQL concurrency reservation when generation creation fails", async () => {
        vi.mocked(getDatabaseProvider).mockReturnValue("postgres");
        const query = vi.fn(async (statement: string) => {
            if (statement.includes("SELECT 1 FROM generation_concurrency_reservations")) return { rows: [] };
            if (statement.includes("AS total")) return { rows: [{ total: "0" }] };
            return { rows: [] };
        });
        vi.mocked(withPostgresTransaction).mockImplementation(async (handler) => handler({ query } as never));
        vi.mocked(postgresQuery).mockResolvedValue({ rows: [] } as never);

        await expect(
            withGenerationConcurrencyLimit(
                "user",
                "video",
                60_000,
                1,
                async () => {
                    throw new Error("upstream failed");
                },
                undefined,
                "request-two",
            ),
        ).rejects.toThrow("upstream failed");

        expect(vi.mocked(postgresQuery)).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM generation_concurrency_reservations"), ["user", "video", "request-two"]);
    });

    it("does not let tasks awaiting manual review consume generation capacity", async () => {
        const now = Date.now();
        mocks.records = [
            {
                id: "image-review",
                userId: "user",
                type: "image",
                status: "running",
                executionPhase: "needs_review",
                payload: {},
                createdAt: now,
                updatedAt: now,
                expiresAt: now + 60_000,
            },
        ];

        await expect(withGenerationConcurrencyLimit("user", "image", 60_000, 1, async () => "image-retry")).resolves.toBe("image-retry");
    });

    it("excludes the existing task identity when resuming or retrying the same aggregate", async () => {
        const now = Date.now();
        mocks.records = [{ id: "agent-run", userId: "user", type: "agent", status: "running", payload: {}, executionPhase: "created", createdAt: now, updatedAt: now, expiresAt: now + 60_000 }];

        await expect(withGenerationConcurrencyLimit("user", "agent", 60_000, 1, async () => "retried", "agent-run")).resolves.toBe("retried");
        await expect(withGenerationConcurrencyLimit("user", "agent", 60_000, 1, async () => "other-run")).resolves.toBeNull();
    });

    it("derives capacity retry timing from the active task scheduler state", async () => {
        const now = Date.now();
        mocks.records = [
            {
                id: "image-running",
                userId: "user",
                type: "image",
                status: "running",
                executionPhase: "polling",
                nextPollAt: now + 4_000,
                payload: {},
                createdAt: now,
                updatedAt: now,
                expiresAt: now + 60_000,
            },
        ];

        await expect(generationCapacityRetryAfterSeconds("user", "image", 60_000)).resolves.toBeGreaterThanOrEqual(3);
        await expect(generationCapacityRetryAfterSeconds("other", "image", 60_000)).resolves.toBeUndefined();
    });

    it("uses one scoped PostgreSQL aggregate for capacity retry timing", async () => {
        vi.mocked(getDatabaseProvider).mockReturnValue("postgres");
        vi.mocked(postgresQuery).mockResolvedValueOnce({ rows: [{ retry_after_seconds: 6 }], command: "SELECT", rowCount: 1, oid: 0, fields: [] });

        await expect(generationCapacityRetryAfterSeconds("user", "video", 60_000)).resolves.toBe(6);
        const [statement, params] = vi.mocked(postgresQuery).mock.calls[0];
        expect(String(statement)).toContain("MIN(CASE");
        expect(String(statement)).toContain("user_id = $1 AND task_type = $2");
        expect(params).toEqual(["user", "video", expect.any(Date), expect.any(Array)]);
    });

    it("restores a safe review reason for a legacy uncertain submission", async () => {
        const now = Date.now();
        mocks.records = [
            {
                id: "image-review",
                userId: "user",
                type: "image",
                status: "running",
                executionPhase: "needs_review",
                lastUpstreamStatus: "submission_outcome_unknown",
                payload: { id: "image-review", userId: "user", status: "running", events: [], createdAt: now, updatedAt: now },
                createdAt: now,
                updatedAt: now,
                expiresAt: now + 60_000,
            },
        ];

        await expect(getStoredGenerationTask<TestTask>("image", "image-review")).resolves.toMatchObject({ reviewReason: expect.stringContaining("避免重复生成和扣费") });
    });

    it("deduplicates the same request attempt but allows a later retry attempt", async () => {
        mocks.records = [];
        const now = Date.now();
        const first = await createStoredGenerationTask("video", { id: "video-one", userId: "user", status: "pending", clientRequestId: "request-one", attemptNo: 1, createdAt: now, updatedAt: now }, 60_000);
        const duplicate = await createStoredGenerationTask("video", { id: "video-duplicate", userId: "user", status: "pending", clientRequestId: "request-one", attemptNo: 1, createdAt: now, updatedAt: now }, 60_000);
        const retry = await createStoredGenerationTask("video", { id: "video-retry", userId: "user", status: "pending", clientRequestId: "request-one", attemptNo: 2, createdAt: now, updatedAt: now }, 60_000);

        expect(first.id).toBe("video-one");
        expect(duplicate.id).toBe("video-one");
        expect(retry.id).toBe("video-retry");
        expect(mocks.records).toHaveLength(2);
        expect(mocks.records.every((record) => record.executionPhase === "created")).toBe(true);
        await expect(getStoredGenerationTaskByRequest<{ id: string }>("video", "user", "request-one", 1)).resolves.toMatchObject({ id: "video-one" });
        await expect(getStoredGenerationTaskByRequest<{ id: string }>("video", "user", "request-one", 2)).resolves.toMatchObject({ id: "video-retry" });
        await expect(getStoredGenerationTaskByRequest<{ id: string }>("video", "user", "request-one", 3)).resolves.toBeNull();
    });

    it("finds only the current user's exact channel task identity", async () => {
        const now = Date.now();
        mocks.records = [
            { id: "video-one", userId: "user", type: "video", status: "running", channelId: "channel-one", upstreamTaskId: "upstream-one", payload: { config: { model: "vendor-video" } }, createdAt: now, updatedAt: now, expiresAt: now + 60_000 },
        ];

        await expect(getStoredGenerationTaskByUpstream("video", "user", "channel-one", "upstream-one")).resolves.toMatchObject({ id: "video-one" });
        await expect(getStoredGenerationTaskByUpstream("video", "other", "channel-one", "upstream-one")).resolves.toBeNull();
        await expect(getStoredGenerationTaskByUpstream("video", "user", "channel-two", "upstream-one")).resolves.toBeNull();
    });

    it("uses an entity-scoped PostgreSQL lookup for upstream ownership", async () => {
        vi.mocked(getDatabaseProvider).mockReturnValue("postgres");
        vi.mocked(postgresQuery).mockResolvedValueOnce({ rows: [], command: "SELECT", rowCount: 0, oid: 0, fields: [] });

        await getStoredGenerationTaskByUpstream("audio", "user", "channel-one", "upstream-one");

        expect(vi.mocked(postgresQuery).mock.calls[0][0]).toContain("user_id = $1 AND task_type = $2 AND channel_id = $3 AND upstream_task_id = $4");
        expect(vi.mocked(postgresQuery).mock.calls[0][1]).toEqual(["user", "audio", "channel-one", "upstream-one"]);
        vi.mocked(postgresQuery).mockClear();
        vi.mocked(getDatabaseProvider).mockReturnValue("file");
    });

    it("pushes Agent conversation, project and surface filters into PostgreSQL before limiting", async () => {
        vi.mocked(getDatabaseProvider).mockReturnValue("postgres");
        vi.mocked(postgresQuery).mockResolvedValueOnce({ rows: [], command: "SELECT", rowCount: 0, oid: 0, fields: [] });

        await queryStoredGenerationTasks("agent", { userId: "user", conversationId: "conversation-one", projectId: "project-one", surface: "canvas", limit: 50 });

        const [statement, params] = vi.mocked(postgresQuery).mock.calls[0] || [];
        expect(String(statement)).toContain("user_id = $1");
        expect(String(statement)).toContain("task_type = $2");
        expect(String(statement)).toContain("conversation_id = $3");
        expect(String(statement)).toContain("project_id = $4");
        expect(String(statement)).toContain("surface = $5");
        expect(String(statement)).toContain("ORDER BY updated_at DESC, id DESC LIMIT $6");
        expect(params).toEqual(["user", "agent", "conversation-one", "project-one", "canvas", 50]);
        vi.mocked(getDatabaseProvider).mockReturnValue("file");
    });

    it("pushes normalized Agent status filters into PostgreSQL before limiting", async () => {
        vi.mocked(getDatabaseProvider).mockReturnValue("postgres");
        vi.mocked(postgresQuery).mockResolvedValueOnce({ rows: [], command: "SELECT", rowCount: 0, oid: 0, fields: [] });

        await queryStoredGenerationTasks("agent", { userId: "user", statuses: ["planning", "running", "paused", "running"], limit: 4 });

        const [statement, params] = vi.mocked(postgresQuery).mock.calls[0] || [];
        expect(String(statement)).toContain("status = ANY($3::text[])");
        expect(String(statement)).toContain("ORDER BY updated_at DESC, id DESC LIMIT $4");
        expect(params).toEqual(["user", "agent", ["pending", "running", "paused"], 4]);
        vi.mocked(getDatabaseProvider).mockReturnValue("file");
    });

    it("applies the same scoped filters before limiting with the file provider", async () => {
        const now = Date.now();
        mocks.records = [
            { id: "run-new-wrong", userId: "user", type: "agent", status: "running", conversationId: "other", projectId: "project-one", surface: "canvas", payload: { id: "run-new-wrong" }, createdAt: now, updatedAt: now + 2, expiresAt: now + 60_000 },
            { id: "run-match", userId: "user", type: "agent", status: "running", conversationId: "conversation-one", projectId: "project-one", surface: "canvas", payload: { id: "run-match" }, createdAt: now, updatedAt: now + 1, expiresAt: now + 60_000 },
        ];

        await expect(queryStoredGenerationTasks<{ id: string }>("agent", { userId: "user", conversationId: "conversation-one", projectId: "project-one", surface: "canvas", limit: 1 })).resolves.toEqual([{ id: "run-match" }]);
    });

    it("filters file-provider Agent statuses before limiting", async () => {
        const now = Date.now();
        mocks.records = [
            { id: "run-completed", userId: "user", type: "agent", status: "success", surface: "chat", payload: { id: "run-completed" }, createdAt: now, updatedAt: now + 2, expiresAt: now + 60_000 },
            { id: "run-active", userId: "user", type: "agent", status: "running", surface: "chat", payload: { id: "run-active" }, createdAt: now, updatedAt: now + 1, expiresAt: now + 60_000 },
        ];

        await expect(queryStoredGenerationTasks<{ id: string }>("agent", { userId: "user", surface: "chat", statuses: ["planning", "running", "paused"], limit: 1 })).resolves.toEqual([{ id: "run-active" }]);
    });
});

describe("listStoredGenerationTaskRecords", () => {
    it("matches file-provider tasks through resolved public user ids", async () => {
        vi.mocked(getDatabaseProvider).mockReturnValue("file");
        const now = Date.now();
        mocks.records = [
            { id: "task-one", userId: "user-one", type: "image", status: "success", payload: { prompt: "first" }, createdAt: now, updatedAt: now, expiresAt: now + 60_000 },
            { id: "task-two", userId: "user-two", type: "image", status: "success", payload: { prompt: "second" }, createdAt: now, updatedAt: now, expiresAt: now + 60_000 },
        ];

        const result = await listStoredGenerationTaskRecords({ search: "0001", searchUserIds: ["user-one"], includeAll: false });

        expect(result.items.map((item) => item.id)).toEqual(["task-one"]);
    });

    it("loads only child records for the requested Agent runs and counts planner billing", async () => {
        vi.mocked(getDatabaseProvider).mockReturnValue("file");
        const now = Date.now();
        mocks.records = [
            { id: "agent-one", userId: "user", type: "agent", status: "running", runId: "agent-one", payload: {}, createdAt: now, updatedAt: now, expiresAt: now + 60_000 },
            { id: "child-one", userId: "user", type: "image", status: "success", runId: "agent-one", payload: { pointsCost: 2 }, createdAt: now, updatedAt: now, expiresAt: now + 60_000 },
            { id: "child-wrong-owner", userId: "other", type: "image", status: "success", runId: "agent-one", payload: { pointsCost: 9 }, createdAt: now, updatedAt: now, expiresAt: now + 60_000 },
            { id: "child-other", userId: "user", type: "video", status: "success", runId: "agent-two", payload: { pointsCost: 4 }, createdAt: now, updatedAt: now, expiresAt: now + 60_000 },
        ];

        await expect(listStoredGenerationTaskRecordsByRunIds(["agent-one"], ["user"])).resolves.toEqual([expect.objectContaining({ id: "child-one", runId: "agent-one" })]);
        expect(generationTaskPointsCost({ plannerAudit: { pointsCost: 1.25 } })).toBe(1.25);
    });

    it("pushes Agent run and owner scopes into the PostgreSQL child-task query", async () => {
        vi.mocked(getDatabaseProvider).mockReturnValue("postgres");
        vi.mocked(postgresQuery).mockResolvedValueOnce({ rows: [] } as never);

        await listStoredGenerationTaskRecordsByRunIds(["agent-one"], ["user-one"]);

        const [query, params] = vi.mocked(postgresQuery).mock.calls[0] || [];
        expect(String(query)).toContain("run_id = ANY($1::text[])");
        expect(String(query)).toContain("user_id = ANY($2::text[])");
        expect(params).toEqual([["agent-one"], ["user-one"]]);
        vi.mocked(postgresQuery).mockReset();
    });

    it("pushes PostgreSQL filters, pagination and aggregate summary into database queries", async () => {
        vi.mocked(getDatabaseProvider).mockReturnValue("postgres");
        vi.mocked(postgresQuery)
            .mockResolvedValueOnce({
                rows: [
                    {
                        id: "task-one",
                        user_id: "user-one",
                        task_type: "video",
                        status: "success",
                        surface: "chat",
                        project_id: "project-one",
                        payload: { prompt: "needle" },
                        created_at: new Date(1),
                        updated_at: new Date(2),
                        expires_at: new Date(Date.now() + 60_000),
                        total_count: "1",
                    },
                ],
            } as never)
            .mockResolvedValueOnce({ rows: [{ task_type: "video", status: "success", total: "1", completed_total: "1", duration_total_ms: "1", points_cost: "3" }] } as never);

        const result = await listStoredGenerationTaskRecords({ page: 1, pageSize: 20, type: "video", status: "success", surface: "chat", projectId: "project-one", userId: "user-one", search: "needle", searchUserIds: ["user-one"], includeAll: false });
        const [pageQuery, pageParams] = vi.mocked(postgresQuery).mock.calls[0] || [];
        const [summaryQuery, summaryParams] = vi.mocked(postgresQuery).mock.calls[1] || [];

        expect(String(pageQuery)).toContain("payload::text ILIKE");
        expect(String(pageQuery)).toContain("FROM users AS search_users");
        expect(String(pageQuery)).toContain("lpad(search_users.account_id::text, 4, '0') ILIKE");
        expect(String(pageQuery)).toContain("search_users.username ILIKE");
        expect(String(pageQuery)).toContain("coalesce(search_users.email, '') ILIKE");
        expect(String(pageQuery)).toContain("search_users.display_name ILIKE");
        expect(String(pageQuery)).toContain("LIMIT $7 OFFSET $8");
        expect(pageParams).toEqual(["video", "success", "chat", "project-one", "user-one", "needle", 20, 0]);
        expect(String(summaryQuery)).toContain("GROUP BY task_type, status");
        expect(summaryParams).toEqual(["video", "success", "chat", "project-one", "user-one", "needle"]);
        expect(result).toMatchObject({ total: 1, items: [{ id: "task-one", type: "video" }], all: [], summary: { total: 1, totalPointsCost: 3 } });
    });

    it("keeps PostgreSQL list reads paginated even when all records are requested", async () => {
        vi.mocked(getDatabaseProvider).mockReturnValue("postgres");
        vi.mocked(postgresQuery).mockReset();
        vi.mocked(postgresQuery)
            .mockResolvedValueOnce({ rows: [] } as never)
            .mockResolvedValueOnce({ rows: [] } as never);

        const result = await listStoredGenerationTaskRecords({ type: "agent", includeAll: true, page: 2, pageSize: 20 });
        const [pageQuery, pageParams] = vi.mocked(postgresQuery).mock.calls[0] || [];

        expect(String(pageQuery)).toContain("LIMIT $7 OFFSET $8");
        expect(String(pageQuery)).not.toContain("LIMIT 5000");
        expect(pageParams).toEqual(["agent", null, null, null, null, "", 20, 20]);
        expect(result.all).toEqual([]);
    });
});

describe("summarizeStoredAgentPerformance", () => {
    it("computes filtered Agent timing metrics in PostgreSQL", async () => {
        vi.mocked(getDatabaseProvider).mockReturnValue("postgres");
        vi.mocked(postgresQuery).mockReset();
        vi.mocked(postgresQuery).mockResolvedValueOnce({
            rows: [
                {
                    sample_size: "12",
                    planning_p50_ms: "400",
                    planning_p95_ms: "900",
                    first_result_p50_ms: "1500",
                    first_result_p95_ms: "4200",
                    queue_average_ms: "120",
                    upstream_average_ms: "1100",
                    review_average_ms: "300",
                },
            ],
        } as never);

        const result = await summarizeStoredAgentPerformance({ status: "success", surface: "chat", projectId: "project-one", userId: "user-one", search: "needle", searchUserIds: ["user-one"] });
        const [statement, params] = vi.mocked(postgresQuery).mock.calls[0] || [];

        expect(String(statement)).toContain("task_type = 'agent'");
        expect(String(statement)).toContain("percentile_disc(0.95)");
        expect(String(statement)).toContain("payload#>>'{timings,firstResultReadyAt}'");
        expect(String(statement)).toContain("FROM users AS search_users");
        expect(String(statement)).not.toContain("LIMIT 5000");
        expect(params).toEqual(["success", "chat", "project-one", "user-one", "needle"]);
        expect(result).toEqual({ sampleSize: 12, planningP50Ms: 400, planningP95Ms: 900, firstResultP50Ms: 1500, firstResultP95Ms: 4200, queueAverageMs: 120, upstreamAverageMs: 1100, reviewAverageMs: 300 });
    });
});

describe("summarizeStoredGenerationTaskCosts", () => {
    it("aggregates project costs in PostgreSQL without loading task payload rows", async () => {
        vi.mocked(getDatabaseProvider).mockReturnValue("postgres");
        vi.mocked(postgresQuery).mockClear();
        vi.mocked(postgresQuery).mockResolvedValueOnce({
            rows: [
                { task_type: "image", status: "success", task_count: "2", estimated_points: "4", actual_points: "3.5" },
                { task_type: "video", status: "error", task_count: "1", estimated_points: "8", actual_points: "0" },
            ],
        } as never);

        const result = await summarizeStoredGenerationTaskCosts({ userId: "user-one", projectId: "project-one", types: ["image", "video", "image"] });
        const [statement, params] = vi.mocked(postgresQuery).mock.calls[0] || [];

        expect(String(statement)).toContain("GROUP BY task_type, status");
        expect(String(statement)).not.toContain("LIMIT 5000");
        expect(String(statement)).toContain("nullif(sum(");
        expect(String(statement)).toContain("attempt->>'status' IN ('succeeded', 'success')");
        expect(params).toEqual(["user-one", "project-one", ["image", "video"]]);
        expect(result).toEqual([
            { type: "image", status: "success", taskCount: 2, estimatedPoints: 4, actualPoints: 3.5 },
            { type: "video", status: "error", taskCount: 1, estimatedPoints: 8, actualPoints: 0 },
        ]);
    });
});
