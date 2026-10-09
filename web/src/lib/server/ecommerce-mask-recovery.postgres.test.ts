import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { StoredGenerationTaskRecord } from "./generation-task-types";

const enabled = process.env.VOZEB_PRO_RUN_ECOMMERCE_POSTGRES_INTEGRATION === "1";
const postgresDescribe = enabled ? describe : describe.skip;
const reviewReason = "strict_product_mask_review_required";

postgresDescribe("isolated PostgreSQL unsubmitted local-mask recovery", () => {
    let database: typeof import("./database");
    let scheduler: typeof import("./generation-task-scheduler");
    let tasks: typeof import("./generation-task-store");
    const userId = `fixture-mask-${randomUUID()}`;
    const runId = `fixture-run-${randomUUID()}`;

    beforeAll(async () => {
        if (process.env.VOZEB_PRO_ECOMMERCE_ISOLATED_DATABASE !== "1" || process.env.VOZEB_PRO_DATABASE_PROVIDER !== "postgres" || !process.env.DATABASE_URL) throw new Error("Explicit isolated PostgreSQL fixture authorization is required");
        const url = new URL(process.env.DATABASE_URL);
        if (url.hostname !== "127.0.0.1" || !url.port || url.port === "5432" || url.username !== "fixture" || url.pathname !== "/fixture") throw new Error("Local-mask recovery requires a disposable loopback PostgreSQL fixture");
        [database, scheduler, tasks] = await Promise.all([import("./database"), import("./generation-task-scheduler"), import("./generation-task-store")]);
        await database.initializePostgresSchema();
        await database.postgresQuery("INSERT INTO users (id, username, display_name, password_hash) VALUES ($1, $2, $3, $4)", [userId, userId, "Fixture mask recovery", "fixture-only"]);
    }, 120_000);

    afterEach(async () => {
        if (!database) return;
        await database.postgresQuery("DELETE FROM generation_tasks WHERE user_id = $1", [userId]);
        const result = await database.postgresQuery<{ count: number }>("SELECT count(*)::int AS count FROM generation_tasks WHERE user_id = $1", [userId]);
        expect(result.rows[0].count).toBe(0);
    });

    afterAll(async () => {
        if (!database) return;
        await database.postgresQuery("DELETE FROM users WHERE id = $1", [userId]);
        const result = await database.postgresQuery<{ count: number }>("SELECT count(*)::int AS count FROM users WHERE id = $1", [userId]);
        expect(result.rows[0].count).toBe(0);
    });

    it.each(["pending", "running"] as const)("restores only the existing %s child and preserves the frozen payload", async (status) => {
        const original = await insertRecord(status);
        const frozen = structuredClone(original.payload);
        const restored = await recover(original);
        expect(restored).toMatchObject({ id: original.id, userId, type: "image", status, executionPhase: "created", payload: frozen });
        expect(restored?.upstreamTaskId).toBeUndefined();
        expect(restored?.submittedAt).toBeUndefined();
        expect(restored?.workerId).toBeUndefined();
        expect(restored?.leaseUntil).toBeUndefined();
        expect(original.payload).toEqual(frozen);
        expect((await readRecord(original.id)).payload).toEqual(frozen);
        const count = await database.postgresQuery<{ count: number }>("SELECT count(*)::int AS count FROM generation_tasks WHERE user_id = $1 AND run_id = $2", [userId, runId]);
        expect(count.rows[0].count).toBe(1);
        expect(await recover(original)).toBeNull();
    });

    it.each(["pending", "running"] as const)("allows exactly one of two concurrent recoveries of a %s child", async (status) => {
        const original = await insertRecord(status);
        const outcomes = await Promise.all([recover(original), recover(original)]);
        expect(outcomes.filter(Boolean)).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome === null)).toHaveLength(1);
        expect(outcomes.find(Boolean)).toMatchObject({ id: original.id, userId, status, executionPhase: "created", payload: original.payload });
        expect(await readRecord(original.id)).toMatchObject({ id: original.id, runId, payload: original.payload, executionPhase: "created" });
    });

    it("rejects a stale recovery after the real PostgreSQL row lock protects a concurrent payload change", async () => {
        const original = await insertRecord("pending");
        const frozen = structuredClone(original.payload);
        const replacement = { ...frozen, prompt: "A different confirmed edit" };
        let recovery: ReturnType<typeof recover> | undefined;
        await database.withPostgresTransaction(async (client) => {
            await client.query("SELECT id FROM generation_tasks WHERE id = $1 AND user_id = $2 FOR UPDATE", [original.id, userId]);
            const holder = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
            recovery = recover(original);
            await vi.waitFor(async () => {
                const blocked = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND $1::int = ANY(pg_blocking_pids(pid))", [holder.rows[0].pid]);
                expect(blocked.rows[0].count).toBe(1);
            });
            await client.query("UPDATE generation_tasks SET payload = $3::jsonb WHERE id = $1 AND user_id = $2", [original.id, userId, JSON.stringify(replacement)]);
        });
        expect(await recovery).toBeNull();
        expect(original.payload).toEqual(frozen);
        expect(await readRecord(original.id)).toMatchObject({ executionPhase: "needs_review", lastUpstreamStatus: reviewReason, payload: replacement });
    });

    it.each([
        ["submitted timestamp", "submitted_at = now()"],
        ["upstream identity", "upstream_task_id = 'fixture-upstream'"],
        ["worker ownership", "worker_id = 'fixture-worker'"],
        ["lease", "lease_until = now() + interval '1 minute'"],
        ["unknown submission", "last_upstream_status = 'submission_outcome_unknown'"],
        ["cancelled child", "status = 'cancelled'"],
        ["changed phase", "execution_phase = 'submitting'"],
        ["upstream result", 'result_payload = \'{"reviewReason":"strict_product_mask_review_required","response":{}}\'::jsonb'],
    ] as const)("rejects a stale snapshot after %s is persisted", async (_label, change) => {
        const original = await insertRecord("pending");
        await database.postgresQuery(`UPDATE generation_tasks SET ${change} WHERE id = $1 AND user_id = $2`, [original.id, userId]);
        const before = await readRecord(original.id);
        expect(await recover(original)).toBeNull();
        expect(await readRecord(original.id)).toEqual(before);
        expect(original.payload).toEqual(before.payload);
    });

    it.each([
        ["attempt evidence", { attempts: [{ id: "fixture-attempt" }] }],
        ["billing evidence", { billing: { id: "fixture-billing" } }],
        ["upstream evidence", { upstream: { taskId: "fixture-upstream" } }],
        ["saved result", { result: { imageUrl: "/fixture.png" } }],
        ["generation kind", { kind: "generation" }],
        ["missing edit kind", { kind: undefined }],
    ] as const)("rejects a fresh child containing %s without changing its payload", async (_label, change) => {
        const original = await insertRecord("pending", change);
        expect(await recover(original)).toBeNull();
        expect(await readRecord(original.id)).toEqual(original);
    });

    it("rejects a mismatched confirmed independent mask", async () => {
        const original = await insertRecord("pending", { mask: { dataUrl: "different-mask" } });
        expect(await recover(original)).toBeNull();
        expect(await readRecord(original.id)).toEqual(original);
    });

    function recover(original: StoredGenerationTaskRecord) {
        return scheduler.scheduleGenerationTask("image", original.id, { executionPhase: "created", nextPollAt: Date.now(), lastUpstreamStatus: "created", resultPayload: {} }, { unsubmittedMaskRecovery: original });
    }

    async function readRecord(id: string) {
        const record = await tasks.getStoredGenerationTaskRecord("image", id);
        if (!record) throw new Error("Fixture child is missing");
        return record;
    }

    async function insertRecord(status: "pending" | "running", change: Record<string, unknown> = {}) {
        const id = `fixture-child-${randomUUID()}`;
        const now = Date.now();
        const payload = {
            id,
            userId,
            kind: "edit",
            status,
            createdAt: now,
            updatedAt: now,
            runId,
            conversationId: "fixture-conversation",
            attempts: [],
            prompt: "Add one vase inside the confirmed region",
            references: [{ id: "fixture-scene", ecommerceRole: "scene" }],
            mask: { dataUrl: "fixture-alpha-mask" },
            config: { apiFormat: "openai", model: "fixture-image", baseUrl: "http://127.0.0.1:1/v1", advancedConfig: { protocol: "sub2api" } },
            sceneProtection: { sourceAssetId: "fixture-scene", selectionSource: "user_selection", mask: { dataUrl: "fixture-alpha-mask" } },
            ecommerceExecution: {
                protection: { scope: "local" },
                mask: { required: true },
                referenceRoles: [{ assetId: "fixture-scene" }],
                modelSnapshot: { imageEdit: { protocol: "sub2api", editPath: "/images/edits", transport: "json", supportsIndependentMask: true } },
            },
            ...change,
        };
        await database.postgresQuery(
            `INSERT INTO generation_tasks (id, user_id, task_type, status, payload, created_at, updated_at, expires_at, run_id, conversation_id, execution_phase, last_upstream_status, result_payload)
             VALUES ($1, $2, 'image', $3, $4::jsonb, $5, $5, $6, $7, $8, 'needs_review', $9, $10::jsonb)`,
            [id, userId, status, JSON.stringify(payload), new Date(now), new Date(now + 60_000), runId, payload.conversationId, reviewReason, JSON.stringify({ reviewReason })],
        );
        return readRecord(id);
    }
});
