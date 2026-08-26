import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    provider: "file" as "file" | "postgres",
    records: [] as Array<Record<string, unknown>>,
    postgresQuery: vi.fn(),
    transactionQuery: vi.fn(),
}));

vi.mock("@/lib/server/database", () => ({
    ensurePostgresSchema: vi.fn(),
    getDatabaseProvider: vi.fn(() => mocks.provider),
    postgresQuery: mocks.postgresQuery,
    withPostgresTransaction: vi.fn(async (handler: (client: { query: typeof mocks.transactionQuery }) => unknown) => handler({ query: mocks.transactionQuery })),
}));
vi.mock("@/lib/server/generation-task-store", () => ({
    listStoredGenerationTaskRecords: vi.fn(async () => ({ all: structuredClone(mocks.records) })),
    withGenerationTaskFileMutation: vi.fn(async (mutate: (records: Array<Record<string, unknown>>) => Promise<{ tasks: Array<Record<string, unknown>>; result: unknown }>) => {
        const result = await mutate(structuredClone(mocks.records));
        mocks.records = structuredClone(result.tasks);
        return result.result;
    }),
}));

import { claimDueGenerationTasks, generationTaskNextPollAt, getNextGenerationTaskDueAt, releaseGenerationTaskLease, renewGenerationTaskLeases, scheduleGenerationTask } from "./generation-task-scheduler";

describe("generation task scheduler", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.provider = "file";
        mocks.records = [record("due", 900), record("future", 2_000)];
    });

    it("claims each due task once and only renews the current owner lease", async () => {
        const claimed = await claimDueGenerationTasks({ workerId: "worker-one", now: 1_000, leaseMs: 60_000 });

        expect(claimed.map((item) => item.id)).toEqual(["due"]);
        expect(await claimDueGenerationTasks({ workerId: "worker-two", now: 1_001, leaseMs: 60_000 })).toEqual([]);
        expect(await renewGenerationTaskLeases("worker-two", ["due"], 60_000, 2_000)).toBe(0);
        expect(await renewGenerationTaskLeases("worker-one", ["due"], 60_000, 2_000)).toBe(1);
        expect(mocks.records.find((item) => item.id === "due")).toMatchObject({ workerId: "worker-one", leaseUntil: 62_000, lastHeartbeatAt: 2_000, updatedAt: 100 });
    });

    it("reports the earliest schedulable file task without treating expired work as due", async () => {
        mocks.records.push({ ...record("expired", 500), expiresAt: 999 });
        await expect(getNextGenerationTaskDueAt(1_000)).resolves.toBe(900);

        await claimDueGenerationTasks({ workerId: "worker-one", now: 1_000, leaseMs: 60_000 });
        await expect(getNextGenerationTaskDueAt(1_001)).resolves.toBe(2_000);
    });

    it("requires lease ownership when releasing and clears next poll for terminal phases", async () => {
        await claimDueGenerationTasks({ workerId: "worker-one", now: 1_000, leaseMs: 60_000 });

        await expect(releaseGenerationTaskLease("image", "due", "worker-two", { executionPhase: "completed", nextPollAt: undefined })).resolves.toBeNull();
        expect(mocks.records[0]).toMatchObject({ workerId: "worker-one" });

        await expect(releaseGenerationTaskLease("image", "due", "worker-one", { executionPhase: "completed", nextPollAt: undefined, lastUpstreamStatus: "persisted" })).resolves.toMatchObject({
            executionPhase: "completed",
            nextPollAt: undefined,
            workerId: undefined,
            leaseUntil: undefined,
        });
    });

    it("preserves upstream identity while moving a result into persistence", async () => {
        await scheduleGenerationTask("image", "due", { executionPhase: "submitted", upstreamTaskId: "upstream-one", channelId: "channel-one", submittedAt: 500, nextPollAt: 1_500 });
        await scheduleGenerationTask("image", "due", { executionPhase: "result_ready", resultPayload: { url: "https://cdn.example/result.png" }, nextPollAt: 1_000 });

        expect(mocks.records[0]).toMatchObject({
            executionPhase: "result_ready",
            upstreamTaskId: "upstream-one",
            channelId: "channel-one",
            resultPayload: { url: "https://cdn.example/result.png" },
        });
    });

    it("clears the previous upstream identity before an automatic retry", async () => {
        mocks.records[0] = {
            ...mocks.records[0],
            workerId: "worker-one",
            leaseUntil: 60_000,
            upstreamTaskId: "upstream-failed",
            queryPath: "/jobs/upstream-failed",
            submittedAt: 500,
            lastPollAt: 900,
            resultPayload: { previous: true },
        };

        await releaseGenerationTaskLease("image", "due", "worker-one", { executionPhase: "created", nextPollAt: 1_000, lastUpstreamStatus: "automatic_retry_after_upstream_failure" }, { resetUpstreamIdentity: true });

        expect(mocks.records[0]).toMatchObject({ executionPhase: "created", nextPollAt: 1_000, lastUpstreamStatus: "automatic_retry_after_upstream_failure" });
        expect(mocks.records[0].upstreamTaskId).toBeUndefined();
        expect(mocks.records[0].queryPath).toBeUndefined();
        expect(mocks.records[0].submittedAt).toBeUndefined();
        expect(mocks.records[0].lastPollAt).toBeUndefined();
        expect(mocks.records[0].resultPayload).toBeUndefined();
    });

    it("claims a completed Agent only while a persistent review is due", async () => {
        mocks.records = [{ ...record("review", 900), type: "agent", status: "success", executionPhase: "review_pending" }];

        await expect(claimDueGenerationTasks({ workerId: "review-worker", now: 1_000 })).resolves.toEqual([expect.objectContaining({ id: "review", status: "success", executionPhase: "review_pending" })]);
    });

    it("uses SKIP LOCKED and an owner-qualified release in PostgreSQL", async () => {
        mocks.provider = "postgres";
        mocks.transactionQuery.mockResolvedValueOnce({ rows: [] });
        mocks.postgresQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ next_due_at: new Date(2_000) }] });

        await claimDueGenerationTasks({ workerId: "worker-one", now: 1_000, taskIds: ["due"] });
        await releaseGenerationTaskLease("image", "due", "worker-one", { executionPhase: "polling", nextPollAt: 2_000 });
        await expect(getNextGenerationTaskDueAt(1_000)).resolves.toBe(2_000);

        expect(String(mocks.transactionQuery.mock.calls[0]?.[0])).toContain("FOR UPDATE SKIP LOCKED");
        expect(mocks.transactionQuery.mock.calls[0]?.[1]).toEqual([new Date(1_000), 20, "worker-one", ["due"], new Date(91_000), ["image", "video", "audio", "text", "agent"]]);
        expect(String(mocks.postgresQuery.mock.calls[0]?.[0])).toContain("worker_id = $3");
        expect(mocks.postgresQuery.mock.calls[0]?.[1]).toHaveLength(15);
        expect(String(mocks.postgresQuery.mock.calls[1]?.[0])).toContain("min(GREATEST(next_poll_at");
        expect(mocks.postgresQuery.mock.calls[1]?.[1]).toEqual([["image", "video", "audio", "text", "agent"], new Date(1_000)]);
    });

    it("uses adaptive polling and bounded network-error backoff", () => {
        expect(generationTaskNextPollAt({ submittedAt: 1_000, now: 10_000 })).toBe(15_000);
        expect(generationTaskNextPollAt({ submittedAt: 1_000, now: 60_000 })).toBe(70_000);
        expect(generationTaskNextPollAt({ submittedAt: 1_000, now: 180_000 })).toBe(205_000);
        expect(generationTaskNextPollAt({ now: 1_000, consecutiveErrors: 1 })).toBe(11_000);
        expect(generationTaskNextPollAt({ now: 1_000, consecutiveErrors: 99 })).toBe(61_000);
    });
});

function record(id: string, nextPollAt: number) {
    return {
        id,
        userId: "user-one",
        type: "image",
        status: "running",
        payload: {},
        executionPhase: "polling",
        nextPollAt,
        createdAt: 100,
        updatedAt: 100,
        expiresAt: 100_000,
    };
}
