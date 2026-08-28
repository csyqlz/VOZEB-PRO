import { randomUUID } from "node:crypto";

import { readJsonDataFile, withJsonDataFileLock, writeJsonDataFile } from "@/lib/server/data-adapter";
import { ensurePostgresSchema, getDatabaseProvider, postgresQuery, withPostgresTransaction, type QueryExecutor } from "@/lib/server/database";
import { getVozebCmsWorkflowRunDefinition, normalizeVozebCmsWorkflowDefinition, type VozebCmsWorkflowDefinition, type VozebCmsWorkflowEvent, type VozebCmsWorkflowRun } from "@/lib/vozeb-cms/workflow-contract";
import type { VozebCmsProjectRef } from "@/lib/vozeb-cms/project-ref";
import { notifyVozebCmsWorkflowEvent } from "./workflow-event-signal";

type WorkflowDatabase = { version: 1; definitions: VozebCmsWorkflowDefinition[]; runs: VozebCmsWorkflowRun[]; events: VozebCmsWorkflowEvent[] };
const FILE_NAME = "vozeb-workflows.json";
let mutationQueue = Promise.resolve();
const fileLeases = new Map<string, { owner: string; leaseUntil: number }>();

export async function createVozebCmsWorkflowDefinition(userId: string, input: unknown) {
    const definition = normalizeVozebCmsWorkflowDefinition(input, userId);
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ id: string }>(
            `INSERT INTO vozeb_workflows (id, user_id, project_id, project_type, name, version, enabled, definition_json, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
             ON CONFLICT (id) DO NOTHING
             RETURNING id`,
            [definition.id, userId, definition.projectId || null, definition.projectRef?.type || null, definition.name, definition.version, definition.enabled, JSON.stringify(definition), new Date(definition.createdAt), new Date(definition.updatedAt)],
        );
        if (!result.rows[0]?.id) throw new VozebCmsWorkflowStoreError("工作流已存在", 409);
        return definition;
    }
    await mutateDatabase((database) => {
        if (database.definitions.some((item) => item.id === definition.id && item.userId === userId)) throw new VozebCmsWorkflowStoreError("工作流已存在", 409);
        return { ...database, definitions: [definition, ...database.definitions] };
    });
    return definition;
}

export async function listVozebCmsWorkflowDefinitions(userId: string, project: string | Pick<VozebCmsProjectRef, "id" | "type"> = "") {
    const projectId = typeof project === "string" ? project : project.id;
    const projectType = typeof project === "string" ? undefined : project.type;
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ definition_json: VozebCmsWorkflowDefinition }>(
            "SELECT definition_json FROM vozeb_workflows WHERE user_id = $1 AND ($2::text IS NULL OR project_id = $2) AND ($3::text IS NULL OR project_type = $3) ORDER BY updated_at DESC, id ASC",
            [userId, projectId || null, projectType || null],
        );
        return result.rows.map((row) => normalizeStoredDefinition(row.definition_json, userId));
    }
    return (await readDatabase()).definitions.filter((item) => item.userId === userId && (!projectId || item.projectId === projectId) && (!projectType || item.projectRef?.type === projectType)).sort((left, right) => right.updatedAt - left.updatedAt);
}

export async function getVozebCmsWorkflowDefinition(userId: string, id: string) {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ definition_json: VozebCmsWorkflowDefinition }>("SELECT definition_json FROM vozeb_workflows WHERE id = $1 AND user_id = $2", [id, userId]);
        return result.rows[0]?.definition_json ? normalizeStoredDefinition(result.rows[0].definition_json, userId) : null;
    }
    return (await readDatabase()).definitions.find((item) => item.id === id && item.userId === userId) || null;
}

export async function createVozebCmsWorkflowRun(run: VozebCmsWorkflowRun) {
    assertRunDefinitionSnapshot(run);
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ run_json: VozebCmsWorkflowRun }>(
            `INSERT INTO vozeb_workflow_runs (id, user_id, workflow_id, project_id, project_type, status, version, idempotency_key, run_json, next_run_at, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
             ON CONFLICT (user_id, workflow_id, idempotency_key) WHERE idempotency_key IS NOT NULL AND idempotency_key <> '' DO NOTHING
             RETURNING run_json`,
            [run.id, run.userId, run.workflowId, run.projectId || null, run.projectRef?.type || null, run.status, run.version, run.idempotencyKey || null, JSON.stringify(run), optionalDate(run.nextRunAt), new Date(run.createdAt), new Date(run.updatedAt)],
        );
        if (result.rows[0]?.run_json) return result.rows[0].run_json;
        if (run.idempotencyKey) {
            const existing = await postgresQuery<{ run_json: VozebCmsWorkflowRun }>("SELECT run_json FROM vozeb_workflow_runs WHERE user_id = $1 AND workflow_id = $2 AND idempotency_key = $3", [run.userId, run.workflowId, run.idempotencyKey]);
            if (existing.rows[0]?.run_json) return existing.rows[0].run_json;
        }
        throw new VozebCmsWorkflowStoreError("工作流运行创建冲突", 409);
    }
    let saved = run;
    await mutateDatabase((database) => {
        const existing = run.idempotencyKey ? database.runs.find((item) => item.userId === run.userId && item.workflowId === run.workflowId && item.idempotencyKey === run.idempotencyKey) : undefined;
        if (existing) {
            saved = existing;
            return database;
        }
        return { ...database, runs: [run, ...database.runs] };
    });
    return saved;
}

export async function getVozebCmsWorkflowRun(userId: string, id: string) {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ run_json: VozebCmsWorkflowRun }>("SELECT run_json FROM vozeb_workflow_runs WHERE id = $1 AND user_id = $2", [id, userId]);
        return result.rows[0]?.run_json ? normalizeStoredRun(result.rows[0].run_json) : null;
    }
    const run = (await readDatabase()).runs.find((item) => item.id === id && item.userId === userId);
    return run ? normalizeStoredRun(run) : null;
}

/** Claim a durable execution lease so only one Worker advances a run at a time. */
export async function claimVozebCmsWorkflowRun(userId: string, runId: string, owner: string, leaseMs: number) {
    const normalizedLeaseMs = Math.max(1_000, Math.min(10 * 60_000, Math.floor(leaseMs)));
    const leaseUntil = new Date(Date.now() + normalizedLeaseMs);
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ run_json: VozebCmsWorkflowRun }>(
            `UPDATE vozeb_workflow_runs
             SET lease_owner = $3, lease_until = $4
             WHERE id = $1 AND user_id = $2
               AND status IN ('pending', 'running', 'waiting')
               AND ((next_run_at IS NOT NULL AND next_run_at <= now()) OR (next_run_at IS NULL AND status IN ('pending', 'running')))
               AND (lease_until IS NULL OR lease_until < now() OR lease_owner = $3)
             RETURNING run_json`,
            [runId, userId, owner, leaseUntil],
        );
        return Boolean(result.rows[0]?.run_json);
    }
    let claimed = false;
    await mutateDatabase((database) => {
        const now = Date.now();
        const currentLease = fileLeases.get(runId);
        const run = database.runs.find((item) => item.id === runId && item.userId === userId);
        if (!run || !workflowRunIsDue(run, now)) return database;
        if (currentLease && currentLease.leaseUntil > now && currentLease.owner !== owner) return database;
        fileLeases.set(runId, { owner, leaseUntil: leaseUntil.getTime() });
        claimed = true;
        return database;
    });
    return claimed;
}

/** Claim a fair, bounded batch for the durable workflow worker. */
export async function claimVozebCmsWorkflowRunsForMaintenance(owner: string, limit = 20, leaseMs = 120_000) {
    const workerId = owner.trim();
    if (!workerId) return [];
    const bounded = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
    const normalizedLeaseMs = Math.max(1_000, Math.min(10 * 60_000, Math.floor(leaseMs)));
    const now = Date.now();
    const leaseUntil = new Date(now + normalizedLeaseMs);
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ run_json: VozebCmsWorkflowRun }>(
            `WITH due AS (
                 SELECT id
                 FROM vozeb_workflow_runs
                 WHERE status IN ('pending', 'running', 'waiting')
                   AND ((next_run_at IS NOT NULL AND next_run_at <= now()) OR (next_run_at IS NULL AND status IN ('pending', 'running')))
                   AND (lease_until IS NULL OR lease_until < now())
                 ORDER BY next_run_at ASC NULLS FIRST, updated_at ASC, id ASC
                 FOR UPDATE SKIP LOCKED
                 LIMIT $1
             )
             UPDATE vozeb_workflow_runs AS run
             SET lease_owner = $2, lease_until = $3, next_run_at = COALESCE(run.next_run_at, now())
             FROM due
             WHERE run.id = due.id
             RETURNING run.run_json`,
            [bounded, workerId, leaseUntil],
        );
        return result.rows.map((row) => normalizeStoredRun(row.run_json));
    }
    let claimed: VozebCmsWorkflowRun[] = [];
    await mutateDatabase((database) => {
        const eligible = database.runs
            .map(normalizeStoredRun)
            .filter((run) => workflowRunIsDue(run, now) && !workflowRunHasActiveFileLease(run.id))
            .sort((left, right) => Number(left.nextRunAt) - Number(right.nextRunAt) || left.updatedAt - right.updatedAt || left.id.localeCompare(right.id))
            .slice(0, bounded);
        const claimedIds = new Set(eligible.map((run) => run.id));
        claimed = eligible;
        const nextRuns = database.runs.map((run) => {
            if (!claimedIds.has(run.id)) return run;
            const normalized = normalizeStoredRun(run);
            fileLeases.set(run.id, { owner: workerId, leaseUntil: leaseUntil.getTime() });
            return normalized;
        });
        return { ...database, runs: nextRuns };
    });
    return claimed;
}

export async function releaseVozebCmsWorkflowRunLease(userId: string, runId: string, owner: string) {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        await postgresQuery("UPDATE vozeb_workflow_runs SET lease_owner = NULL, lease_until = NULL WHERE id = $1 AND user_id = $2 AND lease_owner = $3", [runId, userId, owner]);
        return;
    }
    const lease = fileLeases.get(runId);
    if (lease?.owner === owner) fileLeases.delete(runId);
}

/** Extend a run lease while a provider or adapter is still executing. */
export async function renewVozebCmsWorkflowRunLease(userId: string, runId: string, owner: string, leaseMs: number) {
    const normalizedLeaseMs = Math.max(1_000, Math.min(10 * 60_000, Math.floor(leaseMs)));
    const leaseUntil = new Date(Date.now() + normalizedLeaseMs);
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ id: string }>(
            `UPDATE vozeb_workflow_runs
             SET lease_until = $4
             WHERE id = $1 AND user_id = $2 AND lease_owner = $3
               AND lease_until > now()
               AND status IN ('pending', 'running', 'waiting')
             RETURNING id`,
            [runId, userId, owner, leaseUntil],
        );
        return Boolean(result.rows[0]?.id);
    }
    const lease = fileLeases.get(runId);
    if (!lease || lease.owner !== owner || lease.leaseUntil <= Date.now()) return false;
    lease.leaseUntil = leaseUntil.getTime();
    return true;
}

export async function listVozebCmsWorkflowRunsForMaintenance(limit = 20) {
    const bounded = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ run_json: VozebCmsWorkflowRun }>(
            `SELECT run_json FROM vozeb_workflow_runs
             WHERE status IN ('pending', 'running', 'waiting')
               AND ((next_run_at IS NOT NULL AND next_run_at <= now()) OR (next_run_at IS NULL AND status IN ('pending', 'running')))
               AND (lease_until IS NULL OR lease_until < now())
             ORDER BY next_run_at ASC, updated_at ASC, id ASC LIMIT $1`,
            [bounded],
        );
        return result.rows.map((row) => normalizeStoredRun(row.run_json));
    }
    return (await readDatabase()).runs
        .filter((run) => workflowRunIsDue(run, Date.now()) && !workflowRunHasActiveFileLease(run.id))
        .sort((left, right) => Number(left.nextRunAt) - Number(right.nextRunAt) || left.updatedAt - right.updatedAt || left.id.localeCompare(right.id))
        .slice(0, bounded)
        .map(normalizeStoredRun);
}

export async function getNextVozebCmsWorkflowDueAt() {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ next_due_at?: Date | string | null }>(
            `SELECT min(CASE WHEN lease_until > now() THEN lease_until ELSE COALESCE(next_run_at, now()) END) AS next_due_at
             FROM vozeb_workflow_runs
             WHERE status IN ('pending', 'running', 'waiting')
               AND (next_run_at IS NOT NULL OR status IN ('pending', 'running'))`,
        );
        return optionalTime(result.rows[0]?.next_due_at);
    }
    const now = Date.now();
    const nextDueAt = (await readDatabase()).runs
        .map(normalizeStoredRun)
        .filter((run) => ["pending", "running", "waiting"].includes(run.status) && positiveTime(run.nextRunAt))
        .reduce((earliest, run) => {
            const lease = fileLeases.get(run.id);
            const dueAt = lease && lease.leaseUntil > now ? lease.leaseUntil : Number(run.nextRunAt);
            return Math.min(earliest, dueAt);
        }, Number.POSITIVE_INFINITY);
    return Number.isFinite(nextDueAt) ? nextDueAt : undefined;
}

export async function listVozebCmsWorkflowRuns(userId: string, input: { workflowId?: string; projectId?: string; limit?: number } = {}) {
    const workflowId = input.workflowId?.trim() || "";
    const projectId = input.projectId?.trim() || "";
    const limit = Math.max(1, Math.min(100, Math.floor(Number(input.limit) || 50)));
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ run_json: VozebCmsWorkflowRun }>(
            `SELECT run_json FROM vozeb_workflow_runs
             WHERE user_id = $1
               AND ($2::text = '' OR workflow_id = $2)
               AND ($3::text = '' OR project_id = $3)
             ORDER BY updated_at DESC, id ASC
             LIMIT $4`,
            [userId, workflowId, projectId, limit],
        );
        return result.rows.map((row) => normalizeStoredRun(row.run_json));
    }
    return (await readDatabase()).runs
        .filter((run) => run.userId === userId && (!workflowId || run.workflowId === workflowId) && (!projectId || run.projectId === projectId))
        .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
        .slice(0, limit)
        .map(normalizeStoredRun);
}

export async function mutateVozebCmsWorkflowRun(userId: string, runId: string, mutate: (run: VozebCmsWorkflowRun) => { run: VozebCmsWorkflowRun; event?: Omit<VozebCmsWorkflowEvent, "id" | "runId" | "createdAt"> } | null, leaseOwner?: string) {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const saved = await withPostgresTransaction(async (client) => {
            const result = await client.query<{ run_json: VozebCmsWorkflowRun }>("SELECT run_json FROM vozeb_workflow_runs WHERE id = $1 AND user_id = $2 FOR UPDATE", [runId, userId]);
            const current = result.rows[0]?.run_json ? normalizeStoredRun(result.rows[0].run_json) : undefined;
            if (!current) return null;
            if (leaseOwner && !(await ownsPostgresWorkflowLease(client, runId, userId, leaseOwner))) return null;
            const mutation = mutate(current);
            if (!mutation) return null;
            const next = {
                ...mutation.run,
                id: current.id,
                userId: current.userId,
                workflowId: current.workflowId,
                definitionVersion: current.definitionVersion,
                definitionSnapshot: current.definitionSnapshot,
                version: current.version + 1,
                updatedAt: Date.now(),
            };
            const update = leaseOwner
                ? await client.query("UPDATE vozeb_workflow_runs SET status = $2, version = $3, run_json = $4::jsonb, next_run_at = $5, updated_at = $6 WHERE id = $1 AND user_id = $7 AND lease_owner = $8 AND lease_until > now()", [
                      runId,
                      next.status,
                      next.version,
                      JSON.stringify(next),
                      optionalDate(next.nextRunAt),
                      new Date(next.updatedAt),
                      userId,
                      leaseOwner,
                  ])
                : await client.query("UPDATE vozeb_workflow_runs SET status = $2, version = $3, run_json = $4::jsonb, next_run_at = $5, updated_at = $6 WHERE id = $1 AND user_id = $7", [
                      runId,
                      next.status,
                      next.version,
                      JSON.stringify(next),
                      optionalDate(next.nextRunAt),
                      new Date(next.updatedAt),
                      userId,
                  ]);
            if (!update.rowCount) return null;
            if (mutation.event) await insertPostgresWorkflowEvent(client, { ...mutation.event, id: `workflow-event-${randomUUID()}`, runId, createdAt: next.updatedAt });
            return next;
        });
        if (saved) notifyVozebCmsWorkflowEvent(runId);
        return saved;
    }
    let saved: VozebCmsWorkflowRun | null = null;
    await mutateDatabase((database) => {
        const index = database.runs.findIndex((item) => item.id === runId && item.userId === userId);
        if (index < 0) return database;
        const current = normalizeStoredRun(database.runs[index]);
        const lease = fileLeases.get(runId);
        if (leaseOwner && (!lease || lease.owner !== leaseOwner || lease.leaseUntil <= Date.now())) return database;
        const mutation = mutate(current);
        if (!mutation) return database;
        const next = {
            ...mutation.run,
            id: current.id,
            userId: current.userId,
            workflowId: current.workflowId,
            definitionVersion: current.definitionVersion,
            definitionSnapshot: current.definitionSnapshot,
            version: current.version + 1,
            updatedAt: Date.now(),
        };
        saved = next;
        const event = mutation.event ? { ...mutation.event, id: String(database.events.length + 1), runId, createdAt: next.updatedAt } : undefined;
        return { ...database, runs: database.runs.map((item, itemIndex) => (itemIndex === index ? next : item)), events: event ? [...database.events, event] : database.events };
    });
    if (saved) notifyVozebCmsWorkflowEvent(runId);
    return saved;
}

export async function listVozebCmsWorkflowEvents(userId: string, runId: string, afterId = "") {
    const cursor = Number(afterId) || 0;
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<Record<string, unknown>>(
            "SELECT event_id, run_id, type, data, created_at FROM vozeb_workflow_events WHERE run_id = $1 AND event_id > $2::bigint AND EXISTS (SELECT 1 FROM vozeb_workflow_runs WHERE id = $1 AND user_id = $3) ORDER BY event_id ASC LIMIT 200",
            [runId, cursor, userId],
        );
        return result.rows.map(mapEvent);
    }
    const database = await readDatabase();
    if (!database.runs.some((run) => run.id === runId && run.userId === userId)) return [];
    return database.events
        .filter((event) => event.runId === runId && Number(event.id) > cursor)
        .sort((left, right) => Number(left.id) - Number(right.id))
        .slice(0, 200);
}

async function insertPostgresWorkflowEvent(client: QueryExecutor, event: VozebCmsWorkflowEvent) {
    await client.query("INSERT INTO vozeb_workflow_events (run_id, type, data, created_at) VALUES ($1, $2, $3::jsonb, $4)", [event.runId, event.type, event.data === undefined ? null : JSON.stringify(event.data), new Date(event.createdAt)]);
    await client.query("SELECT pg_notify('vozeb_workflow_events', $1)", [event.runId]);
}

function mapEvent(row: Record<string, unknown>): VozebCmsWorkflowEvent {
    return {
        id: String(row.event_id || ""),
        runId: String(row.run_id || ""),
        type: String(row.type || ""),
        ...(row.data === null || row.data === undefined ? {} : { data: row.data }),
        createdAt: row.created_at instanceof Date ? row.created_at.getTime() : new Date(String(row.created_at || "")).getTime(),
    };
}

function normalizeStoredDefinition(value: unknown, userId: string) {
    return normalizeVozebCmsWorkflowDefinition(value, userId);
}

function normalizeStoredRun(run: VozebCmsWorkflowRun): VozebCmsWorkflowRun {
    const nextRunAt = positiveTime(run.nextRunAt) ?? inferLegacyNextRunAt(run);
    return nextRunAt === undefined || positiveTime(run.nextRunAt) !== undefined ? run : { ...run, nextRunAt };
}

function inferLegacyNextRunAt(run: VozebCmsWorkflowRun) {
    if (run.status === "pending" || run.status === "running") return positiveTime(run.updatedAt) || Date.now();
    if (run.status !== "waiting") return undefined;
    const definition = run.definitionSnapshot;
    return definition?.nodes.some((node) => node.kind !== "manual_review" && run.nodeStates[node.id]?.status === "waiting") ? positiveTime(run.updatedAt) || Date.now() : undefined;
}

async function ownsPostgresWorkflowLease(client: QueryExecutor, runId: string, userId: string, owner: string) {
    const result = await client.query<{ id: string }>("SELECT id FROM vozeb_workflow_runs WHERE id = $1 AND user_id = $2 AND lease_owner = $3 AND lease_until > now()", [runId, userId, owner]);
    return Boolean(result.rows[0]?.id);
}

function assertRunDefinitionSnapshot(run: VozebCmsWorkflowRun) {
    try {
        getVozebCmsWorkflowRunDefinition(run);
    } catch {
        throw new VozebCmsWorkflowStoreError("工作流运行定义快照无效", 400);
    }
}

function workflowRunIsDue(run: VozebCmsWorkflowRun, now: number) {
    const nextRunAt = positiveTime(run.nextRunAt) ?? inferLegacyNextRunAt(run);
    return ["pending", "running", "waiting"].includes(run.status) && nextRunAt !== undefined && nextRunAt <= now;
}

function workflowRunHasActiveFileLease(runId: string) {
    return Number(fileLeases.get(runId)?.leaseUntil || 0) > Date.now();
}

function positiveTime(value: unknown) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function optionalDate(value: unknown) {
    const timestamp = positiveTime(value);
    return timestamp ? new Date(timestamp) : null;
}

function optionalTime(value: unknown) {
    if (!value) return undefined;
    const time = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
    return Number.isFinite(time) && time > 0 ? time : undefined;
}

function readDatabase() {
    return readJsonDataFile<Partial<WorkflowDatabase>>(FILE_NAME, { version: 1, definitions: [], runs: [], events: [] }).then(normalizeDatabase);
}

function mutateDatabase(mutator: (database: WorkflowDatabase) => WorkflowDatabase) {
    const operation = mutationQueue.then(() => withJsonDataFileLock(FILE_NAME, async () => writeJsonDataFile(FILE_NAME, mutator(await readDatabase()))));
    mutationQueue = operation.then(
        () => undefined,
        () => undefined,
    );
    return operation;
}

function normalizeDatabase(value: Partial<WorkflowDatabase>): WorkflowDatabase {
    return { version: 1, definitions: Array.isArray(value.definitions) ? value.definitions : [], runs: Array.isArray(value.runs) ? value.runs : [], events: Array.isArray(value.events) ? value.events : [] };
}

export function normalizeStoredVozebCmsWorkflowRun(value: VozebCmsWorkflowRun) {
    return normalizeStoredRun(value);
}

export class VozebCmsWorkflowStoreError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
    }
}
