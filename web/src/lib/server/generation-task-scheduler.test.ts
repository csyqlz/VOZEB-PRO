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
import type { StoredGenerationTaskRecord } from "./generation-task-store";

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

    it("accepts one explicit unsubmitted reference recovery and rejects the second scheduler mutation", async () => {
        mocks.records = [{ ...record("due", 0), executionPhase: "needs_review", lastUpstreamStatus: "reference_source_unavailable:check original", payload: { runId: "same-run", referenceDispatch: { inputId: "same-input" }, attempts: [] } }];
        const patch = { executionPhase: "created" as const, nextPollAt: 1_000, lastUpstreamStatus: "reference_recovery_requested" };
        const results = [await scheduleGenerationTask("image", "due", patch, { unsubmittedReferenceRecovery: true }), await scheduleGenerationTask("image", "due", patch, { unsubmittedReferenceRecovery: true })];
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(mocks.records[0]).toMatchObject({ executionPhase: "created", nextPollAt: 1_000, payload: { runId: "same-run", referenceDispatch: { inputId: "same-input" }, attempts: [] } });
    });

    it("recovers the confirmed unsubmitted mask child once, using a frozen payload CAS", async () => {
        const original = maskReviewRecord();
        mocks.records = [structuredClone(original)];
        const patch = { executionPhase: "created" as const, nextPollAt: 1_000, lastUpstreamStatus: "scene_mask_recovery_requested" };
        const options = { unsubmittedMaskRecovery: original };
        expect(await scheduleGenerationTask("image", "due", patch, options)).not.toBeNull();
        expect(await scheduleGenerationTask("image", "due", patch, options)).toBeNull();
        expect(mocks.records[0].payload).toEqual(original.payload);
    });

    it.each(["submitted", "upstream", "attempts", "billing", "result", "unknown", "lease", "payload", "protocol", "kind"])("rejects masked recovery after protected state changes (%s)", async (drift) => {
        const original = maskReviewRecord();
        const current = structuredClone(original);
        if (drift === "submitted") current.submittedAt = 1;
        if (drift === "upstream") current.upstreamTaskId = "already-submitted";
        if (drift === "lease") current.workerId = "worker";
        if (drift === "unknown") current.lastUpstreamStatus = "submission_outcome_unknown";
        if (drift === "attempts") current.payload.attempts = [{ attemptNo: 1 }];
        if (drift === "billing") current.payload.billing = {};
        if (drift === "result") current.payload.result = { dataUrl: "stored-result" };
        if (drift === "payload") current.payload.prompt = "changed edit";
        if (drift === "protocol") (current.payload.config as { advancedConfig: { protocol: string } }).advancedConfig.protocol = "custom";
        if (drift === "kind") delete current.payload.kind;
        mocks.records = [current];
        const before = structuredClone(mocks.records);
        expect(await scheduleGenerationTask("image", "due", { executionPhase: "created", nextPollAt: 1_000 }, { unsubmittedMaskRecovery: original })).toBeNull();
        expect(mocks.records).toEqual(before);
    });

    it.each([
        { lastUpstreamStatus: "reference_source_changed:changed" },
        { lastUpstreamStatus: "submission_outcome_unknown" },
        { executionPhase: "submitting" },
        { submittedAt: 1 },
        { upstreamTaskId: "same-upstream" },
        { resultPayload: { url: "/api/generation-log-assets/ready.png" } },
        { payload: { runId: "same-run", referenceDispatch: {}, attempts: [{ attemptNo: 1 }] } },
        { payload: { runId: "same-run", referenceDispatch: {}, upstream: { id: "same-upstream" } } },
        { payload: { runId: "same-run", referenceDispatch: {}, billing: { pointsRecordId: "same-billing" } } },
        { payload: { runId: "same-run", referenceDispatch: {}, result: { dataUrl: "/api/generation-log-assets/ready.png" } } },
        { payload: { runId: "same-run", attempts: [] } },
        { type: "video" },
        { status: "cancelled" },
    ])("refuses reference recovery when a protected submission field is present (%j)", async (drift) => {
        mocks.records = [{ ...record("due", 0), executionPhase: "needs_review", lastUpstreamStatus: "reference_source_unavailable:check original", payload: { runId: "same-run", referenceDispatch: { inputId: "same-input" }, attempts: [] }, ...drift }];
        const before = structuredClone(mocks.records);
        expect(await scheduleGenerationTask("image", "due", { executionPhase: "created", nextPollAt: 1_000 }, { unsubmittedReferenceRecovery: true })).toBeNull();
        expect(mocks.records).toEqual(before);
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

function maskReviewRecord(): StoredGenerationTaskRecord {
    return {
        ...record("due", 0),
        type: "image",
        status: "pending",
        executionPhase: "needs_review",
        lastUpstreamStatus: "strict_product_mask_review_required",
        runId: "same-run",
        conversationId: "same-conversation",
        payload: {
            kind: "edit",
            runId: "same-run",
            attempts: [],
            prompt: "add vase",
            references: [{ id: "scene", ecommerceRole: "scene" }],
            mask: { dataUrl: "same-alpha-mask" },
            config: { apiFormat: "openai", model: "gpt-image-2.5-sunburst", baseUrl: "https://image.example.com", advancedConfig: { protocol: "sub2api" } },
            sceneProtection: { sourceAssetId: "scene", selectionSource: "user_selection", mask: { dataUrl: "same-alpha-mask" } },
            ecommerceExecution: { protection: { scope: "local" }, mask: { required: true }, referenceRoles: [{ assetId: "scene" }] },
        },
    };
}
