import { getDatabaseProvider, ensurePostgresSchema, postgresQuery, withPostgresTransaction } from "@/lib/server/database";
import { resolveGenerationReviewReason } from "@/lib/server/generation-task-review-reason";
import { readJsonDataFile, withJsonDataFileLock, writeJsonDataFile } from "@/lib/server/data-adapter";
import type {
    GenerationTaskContext,
    GenerationTaskCostAggregate,
    GenerationTaskExecutionState,
    GenerationTaskPerformanceSummary,
    GenerationTaskRecordListOptions,
    GenerationTaskRecordSummary,
    GenerationTaskStatus,
    GenerationTaskType,
    StoredGenerationTaskRecord,
} from "@/lib/server/generation-task-types";

export type { GenerationTaskContext, GenerationTaskCostAggregate, GenerationTaskPerformanceSummary, GenerationTaskRecordListOptions, GenerationTaskRecordSummary, GenerationTaskType, StoredGenerationTaskRecord } from "@/lib/server/generation-task-types";

type GenerationTaskSummaryAccumulator = Omit<GenerationTaskRecordSummary, "averageDurationMs"> & {
    averageDurationMs: number;
    completedCount: number;
};

const TASK_FILE = "generation-tasks.json";
const ACTIVE_CONCURRENCY_PHASES = ["created", "submitting", "submitted", "polling", "result_ready", "persisting"] as const;
let fileMutationQueue = Promise.resolve();
const concurrencyQueues = new Map<string, Promise<void>>();

export async function createStoredGenerationTask<T extends { id: string; userId: string; status: string; createdAt: number; updatedAt: number }>(type: GenerationTaskType, task: T, ttlMs: number) {
    return insertTask(type, task, ttlMs);
}

export async function cleanupExpiredStoredGenerationTasks(input: { limit: number; now?: Date }) {
    const now = input.now || new Date();
    const limit = Math.max(1, Math.min(500, Math.floor(input.limit)));
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ id: string }>(
            `WITH candidates AS (
                SELECT id FROM generation_tasks
                WHERE expires_at <= $1
                ORDER BY expires_at ASC, id ASC
                LIMIT $2
            )
            DELETE FROM generation_tasks
            USING candidates
            WHERE generation_tasks.id = candidates.id
            RETURNING generation_tasks.id`,
            [now.toISOString(), limit],
        );
        return result.rows.length;
    }
    return withGenerationTaskFileMutation(async (tasks) => {
        const expiredIds = new Set(
            tasks
                .filter((task) => task.expiresAt <= now.getTime())
                .toSorted((left, right) => left.expiresAt - right.expiresAt || left.id.localeCompare(right.id))
                .slice(0, limit)
                .map((task) => task.id),
        );
        return { tasks: tasks.filter((task) => !expiredIds.has(task.id)), result: expiredIds.size };
    });
}

export async function getStoredGenerationTask<T>(type: GenerationTaskType, id: string): Promise<(T & GenerationTaskExecutionState) | null> {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ payload: T; execution_phase?: unknown; last_upstream_status?: unknown; result_payload?: unknown }>(
            "SELECT payload, execution_phase, last_upstream_status, result_payload FROM generation_tasks WHERE id = $1 AND task_type = $2 AND expires_at > now()",
            [id, type],
        );
        const row = result.rows[0];
        return row?.payload ? withExecutionState(row.payload, row.execution_phase, row.last_upstream_status, row.result_payload) : null;
    }
    const tasks = await readFileTasks();
    const record = tasks.find((task) => task.id === id && task.type === type && task.expiresAt > Date.now());
    return record ? withExecutionState(record.payload as T, record.executionPhase, record.lastUpstreamStatus, record.resultPayload) : null;
}

export async function getStoredGenerationTaskRecord(type: GenerationTaskType, id: string): Promise<StoredGenerationTaskRecord | null> {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<Record<string, unknown>>("SELECT * FROM generation_tasks WHERE id = $1 AND task_type = $2 AND expires_at > now()", [id, type]);
        return result.rows[0] ? mapStoredTaskRecord(result.rows[0]) : null;
    }
    return (await readFileTasks()).find((task) => task.id === id && task.type === type && task.expiresAt > Date.now()) || null;
}

export async function listStoredGenerationTaskRecordsByRunIds(runIds: string[], userIds: string[] = []) {
    const ids = Array.from(new Set(runIds.map(cleanContextText).filter(Boolean)));
    const owners = Array.from(new Set(userIds.map(cleanContextText).filter(Boolean)));
    if (!ids.length) return [];
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<Record<string, unknown>>(
            `SELECT * FROM generation_tasks
             WHERE expires_at > now() AND run_id = ANY($1::text[]) AND task_type <> 'agent'
               AND (cardinality($2::text[]) = 0 OR user_id = ANY($2::text[]))
             ORDER BY run_id ASC, created_at ASC, id ASC`,
            [ids, owners],
        );
        return result.rows.map(mapStoredTaskRecord);
    }
    return (await readFileTasks())
        .filter((task) => task.expiresAt > Date.now() && task.type !== "agent" && task.runId && ids.includes(task.runId) && (!owners.length || owners.includes(task.userId)))
        .sort((left, right) => String(left.runId).localeCompare(String(right.runId)) || left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

export async function getStoredGenerationTaskByRequest<T>(type: GenerationTaskType, userId: string, clientRequestId: string, attemptNo?: number): Promise<T | null> {
    const requestId = cleanContextText(clientRequestId);
    if (!requestId) return null;
    const attempt = normalizedAttemptNo(attemptNo);
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ payload: T }>("SELECT payload FROM generation_tasks WHERE user_id = $1 AND task_type = $2 AND client_request_id = $3 AND COALESCE(attempt_no, 0) = $4 AND expires_at > now() LIMIT 1", [
            userId,
            type,
            requestId,
            attempt,
        ]);
        return result.rows[0]?.payload || null;
    }
    const tasks = await readFileTasks();
    return (tasks.find((task) => sameTaskRequest(task, type, userId, requestId, attempt) && task.expiresAt > Date.now())?.payload as T | undefined) || null;
}

export async function getStoredGenerationTaskByUpstream(type: GenerationTaskType, userId: string, channelId: string, upstreamTaskId: string): Promise<StoredGenerationTaskRecord | null> {
    const normalizedChannelId = cleanContextText(channelId);
    const normalizedUpstreamTaskId = cleanUpstreamTaskId(upstreamTaskId);
    if (!normalizedChannelId || !normalizedUpstreamTaskId) return null;
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<Record<string, unknown>>(
            `SELECT * FROM generation_tasks
             WHERE user_id = $1 AND task_type = $2 AND channel_id = $3 AND upstream_task_id = $4 AND expires_at > now()
             LIMIT 1`,
            [userId, type, normalizedChannelId, normalizedUpstreamTaskId],
        );
        return result.rows[0] ? mapStoredTaskRecord(result.rows[0]) : null;
    }
    return (await readFileTasks()).find((task) => task.userId === userId && task.type === type && task.channelId === normalizedChannelId && task.upstreamTaskId === normalizedUpstreamTaskId && task.expiresAt > Date.now()) || null;
}

export async function listStoredGenerationTasks<T>(type: GenerationTaskType, userId: string, limit = 20): Promise<T[]> {
    return queryStoredGenerationTasks<T>(type, { userId, limit });
}

export async function queryStoredGenerationTasks<T>(type: GenerationTaskType, options: { userId: string; conversationId?: string; projectId?: string; surface?: string; statuses?: string[]; limit?: number }): Promise<T[]> {
    const userId = options.userId.trim();
    const conversationId = cleanContextText(options.conversationId);
    const projectId = cleanContextText(options.projectId);
    const surface = cleanContextText(options.surface);
    const statuses = [...new Set((options.statuses || []).map(normalizeGenerationTaskStatus))];
    const limit = Math.max(1, Math.min(100, Math.floor(Number(options.limit) || 20)));
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const values: unknown[] = [userId, type];
        const filters = ["user_id = $1", "task_type = $2", "expires_at > now()"];
        const addFilter = (column: string, value?: string) => {
            if (!value) return;
            values.push(value);
            filters.push(`${column} = $${values.length}`);
        };
        addFilter("conversation_id", conversationId);
        addFilter("project_id", projectId);
        addFilter("surface", surface);
        if (statuses.length) {
            values.push(statuses);
            filters.push(`status = ANY($${values.length}::text[])`);
        }
        values.push(limit);
        const result = await postgresQuery<{ payload: T }>(`SELECT payload FROM generation_tasks WHERE ${filters.join(" AND ")} ORDER BY updated_at DESC, id DESC LIMIT $${values.length}`, values);
        return result.rows.map((row) => row.payload);
    }
    const tasks = await readFileTasks();
    return tasks
        .filter(
            (task) =>
                task.userId === userId &&
                task.type === type &&
                task.expiresAt > Date.now() &&
                (!conversationId || task.conversationId === conversationId) &&
                (!projectId || task.projectId === projectId) &&
                (!surface || task.surface === surface) &&
                (!statuses.length || statuses.includes(task.status)),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))
        .slice(0, limit)
        .map((task) => task.payload as T);
}

export async function listStoredGenerationTaskRecords(options: GenerationTaskRecordListOptions = {}) {
    let records: StoredGenerationTaskRecord[];
    let summary: GenerationTaskRecordSummary | null = null;
    const projectId = options.projectId?.trim() || null;
    const page = Math.max(1, Math.floor(Number(options.page) || 1));
    const pageSize = Math.max(1, Math.min(100, Math.floor(Number(options.pageSize) || 20)));
    const includeAll = options.includeAll !== false;
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const type = isTaskType(options.type) ? options.type : null;
        const status = isTaskStatus(options.status) ? options.status : null;
        const surface = isTaskSurface(options.surface) ? options.surface : null;
        const userId = options.userId?.trim() || null;
        const search = (options.search || "").trim().slice(0, 160);
        const params = [type, status, surface, projectId, userId, search];
        const [pageResult, summaryResult] = await Promise.all([
            postgresQuery<Record<string, unknown>>(
                `${generationTaskSelect()}
                 ${generationTaskWhere()}
                 ORDER BY updated_at DESC
                 LIMIT $7 OFFSET $8`,
                [...params, pageSize, (page - 1) * pageSize],
            ),
            postgresQuery<Record<string, unknown>>(`${generationTaskSummarySelect()} ${generationTaskWhere()} GROUP BY task_type, status`, params),
        ]);
        records = pageResult.rows.map(mapStoredTaskRecord);
        summary = mapGenerationTaskSummary(summaryResult.rows);
        return { items: records, total: summary.total, page, pageSize, all: [], summary };
    } else {
        records = (await readFileTasks()).filter((record) => record.expiresAt > Date.now());
    }
    const search = (options.search || "").trim().toLowerCase();
    const searchUserIds = new Set((options.searchUserIds || []).map((id) => id.trim()).filter(Boolean));
    const filtered = records
        .filter((record) => (isTaskType(options.type) ? record.type === options.type : true))
        .filter((record) => (isTaskStatus(options.status) ? record.status === options.status : true))
        .filter((record) => (isTaskSurface(options.surface) ? record.surface === options.surface : true))
        .filter((record) => (projectId ? record.projectId === projectId : true))
        .filter((record) => (options.userId ? record.userId === options.userId : true))
        .filter(
            (record) =>
                !search ||
                [record.id, record.userId, record.conversationId, record.runId, record.projectId, JSON.stringify(record.payload)].some((value) =>
                    String(value || "")
                        .toLowerCase()
                        .includes(search),
                ) ||
                searchUserIds.has(record.userId),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt);
    const offset = (page - 1) * pageSize;
    summary = summarizeGenerationTaskRecords(filtered);
    return { items: filtered.slice(offset, offset + pageSize), total: summary.total, page, pageSize, all: includeAll ? filtered : [], summary };
}

export async function summarizeStoredAgentPerformance(options: GenerationTaskRecordListOptions = {}): Promise<GenerationTaskPerformanceSummary> {
    if (getDatabaseProvider() !== "postgres") {
        const result = await listStoredGenerationTaskRecords({ ...options, type: "agent", includeAll: true, page: 1, pageSize: 1 });
        return summarizeAgentPerformanceRecords(result.all);
    }
    await ensurePostgresSchema();
    const status = isTaskStatus(options.status) ? options.status : null;
    const surface = isTaskSurface(options.surface) ? options.surface : null;
    const projectId = options.projectId?.trim() || null;
    const userId = options.userId?.trim() || null;
    const search = (options.search || "").trim().slice(0, 160);
    const result = await postgresQuery<Record<string, unknown>>(
        `WITH scoped AS (
            SELECT
                ${numericJsonValue("payload#>>'{timings,planningStartedAt}'")} AS planning_started_at,
                ${numericJsonValue("payload#>>'{timings,planningCompletedAt}'")} AS planning_completed_at,
                ${numericJsonValue("payload#>>'{timings,requestAcceptedAt}'")} AS request_accepted_at,
                ${numericJsonValue("payload#>>'{timings,firstTaskSubmittedAt}'")} AS first_task_submitted_at,
                ${numericJsonValue("payload#>>'{timings,firstResultReadyAt}'")} AS first_result_ready_at,
                ${numericJsonValue("payload#>>'{timings,allResultsReadyAt}'")} AS all_results_ready_at,
                ${numericJsonValue("payload#>>'{timings,reviewCompletedAt}'")} AS review_completed_at
            FROM generation_tasks
            WHERE expires_at > now() AND task_type = 'agent'
              AND ($1::text IS NULL OR status = $1)
              AND ($2::text IS NULL OR surface = $2)
              AND ($3::text IS NULL OR project_id = $3)
              AND ($4::text IS NULL OR user_id = $4)
              AND (
                  $5 = ''
                  OR id ILIKE '%' || $5 || '%'
                  OR user_id ILIKE '%' || $5 || '%'
                  OR coalesce(conversation_id, '') ILIKE '%' || $5 || '%'
                  OR coalesce(run_id, '') ILIKE '%' || $5 || '%'
                  OR coalesce(project_id, '') ILIKE '%' || $5 || '%'
                  OR payload::text ILIKE '%' || $5 || '%'
                  OR ${generationTaskUserSearch("generation_tasks.user_id", 5)}
              )
        ), durations AS (
            SELECT
                CASE WHEN planning_completed_at >= planning_started_at THEN planning_completed_at - planning_started_at END AS planning_ms,
                CASE WHEN first_result_ready_at >= request_accepted_at THEN first_result_ready_at - request_accepted_at END AS first_result_ms,
                CASE WHEN first_task_submitted_at >= planning_completed_at THEN first_task_submitted_at - planning_completed_at END AS queue_ms,
                CASE WHEN first_result_ready_at >= first_task_submitted_at THEN first_result_ready_at - first_task_submitted_at END AS upstream_ms,
                CASE WHEN review_completed_at >= all_results_ready_at THEN review_completed_at - all_results_ready_at END AS review_ms
            FROM scoped
        )
        SELECT
            greatest(count(*) FILTER (WHERE planning_ms > 0), count(*) FILTER (WHERE first_result_ms > 0))::int AS sample_size,
            coalesce(percentile_disc(0.5) WITHIN GROUP (ORDER BY planning_ms) FILTER (WHERE planning_ms > 0), 0) AS planning_p50_ms,
            coalesce(percentile_disc(0.95) WITHIN GROUP (ORDER BY planning_ms) FILTER (WHERE planning_ms > 0), 0) AS planning_p95_ms,
            coalesce(percentile_disc(0.5) WITHIN GROUP (ORDER BY first_result_ms) FILTER (WHERE first_result_ms > 0), 0) AS first_result_p50_ms,
            coalesce(percentile_disc(0.95) WITHIN GROUP (ORDER BY first_result_ms) FILTER (WHERE first_result_ms > 0), 0) AS first_result_p95_ms,
            coalesce(round(avg(queue_ms) FILTER (WHERE queue_ms >= 0)), 0) AS queue_average_ms,
            coalesce(round(avg(upstream_ms) FILTER (WHERE upstream_ms > 0)), 0) AS upstream_average_ms,
            coalesce(round(avg(review_ms) FILTER (WHERE review_ms > 0)), 0) AS review_average_ms
        FROM durations`,
        [status, surface, projectId, userId, search],
    );
    const row = result.rows[0] || {};
    return {
        sampleSize: nonNegativeInteger(row.sample_size),
        planningP50Ms: nonNegativeInteger(row.planning_p50_ms),
        planningP95Ms: nonNegativeInteger(row.planning_p95_ms),
        firstResultP50Ms: nonNegativeInteger(row.first_result_p50_ms),
        firstResultP95Ms: nonNegativeInteger(row.first_result_p95_ms),
        queueAverageMs: nonNegativeInteger(row.queue_average_ms),
        upstreamAverageMs: nonNegativeInteger(row.upstream_average_ms),
        reviewAverageMs: nonNegativeInteger(row.review_average_ms),
    };
}

export function generationTaskPointsCost(payload: Record<string, unknown>) {
    const config = recordObject(payload.config);
    const upstream = recordObject(payload.upstream);
    const plannerAudit = recordObject(payload.plannerAudit);
    const tasks = Array.isArray(payload.tasks) ? payload.tasks.map(recordObject) : [];
    const attempts = Array.isArray(payload.attempts) ? payload.attempts.map(recordObject) : [];
    return (
        positiveNumber(payload.pointsCost, recordObject(payload.billing).pointsCost, upstream.pointsCost, plannerAudit.pointsCost) ||
        tasks.reduce((total, task) => total + positiveNumber(task.pointsCost, recordObject(task.billing).pointsCost), 0) ||
        attempts.filter((attempt) => attempt.status === "succeeded" || attempt.status === "success").reduce((total, attempt) => total + positiveNumber(attempt.pointsCost, recordObject(attempt.billing).pointsCost), 0)
    );
}

export async function summarizeStoredGenerationTaskCosts(input: { userId: string; projectId: string; types: GenerationTaskType[] }): Promise<GenerationTaskCostAggregate[]> {
    const userId = cleanContextText(input.userId);
    const projectId = cleanContextText(input.projectId);
    const types = Array.from(new Set(input.types.filter(isTaskType)));
    if (!userId || !projectId || !types.length) return [];
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<Record<string, unknown>>(
            `SELECT task_type, status, count(*)::int AS task_count,
                    coalesce(sum(coalesce(${numericJsonValue("payload->>'estimatedPoints'")}, 0)), 0) AS estimated_points,
                    coalesce(sum(CASE WHEN status = 'success' THEN ${generationTaskPointsSql()} ELSE 0 END), 0) AS actual_points
             FROM generation_tasks
             WHERE expires_at > now() AND user_id = $1 AND project_id = $2 AND task_type = ANY($3::text[])
             GROUP BY task_type, status`,
            [userId, projectId, types],
        );
        return result.rows.flatMap(mapGenerationTaskCostAggregate);
    }
    const groups = new Map<string, GenerationTaskCostAggregate>();
    for (const record of await readFileTasks()) {
        if (record.expiresAt <= Date.now() || record.userId !== userId || record.projectId !== projectId || !types.includes(record.type)) continue;
        const key = `${record.type}:${record.status}`;
        const current = groups.get(key) || { type: record.type, status: record.status, taskCount: 0, estimatedPoints: 0, actualPoints: 0 };
        current.taskCount += 1;
        current.estimatedPoints += positiveNumber(record.estimatedPoints, record.payload.estimatedPoints);
        if (record.status === "success") current.actualPoints += generationTaskPointsCost(record.payload);
        groups.set(key, current);
    }
    return Array.from(groups.values()).map((item) => ({ ...item, estimatedPoints: Number(item.estimatedPoints.toFixed(2)), actualPoints: Number(item.actualPoints.toFixed(2)) }));
}

function generationTaskSelect() {
    return `SELECT generation_tasks.*, count(*) OVER() AS total_count FROM generation_tasks`;
}

function generationTaskWhere() {
    return `WHERE expires_at > now()
              AND ($1::text IS NULL OR task_type = $1)
              AND ($2::text IS NULL OR status = $2)
              AND ($3::text IS NULL OR surface = $3)
              AND ($4::text IS NULL OR project_id = $4)
              AND ($5::text IS NULL OR user_id = $5)
              AND (
                  $6 = ''
                  OR id ILIKE '%' || $6 || '%'
                  OR user_id ILIKE '%' || $6 || '%'
                  OR coalesce(conversation_id, '') ILIKE '%' || $6 || '%'
                  OR coalesce(run_id, '') ILIKE '%' || $6 || '%'
                  OR coalesce(project_id, '') ILIKE '%' || $6 || '%'
                  OR payload::text ILIKE '%' || $6 || '%'
                  OR ${generationTaskUserSearch("generation_tasks.user_id", 6)}
              )`;
}

function generationTaskUserSearch(userIdExpression: string, parameterIndex: number) {
    return `EXISTS (
                      SELECT 1
                      FROM users AS search_users
                      WHERE search_users.id = ${userIdExpression}
                        AND (
                            lpad(search_users.account_id::text, 4, '0') ILIKE '%' || $${parameterIndex} || '%'
                            OR search_users.username ILIKE '%' || $${parameterIndex} || '%'
                            OR coalesce(search_users.email, '') ILIKE '%' || $${parameterIndex} || '%'
                            OR search_users.display_name ILIKE '%' || $${parameterIndex} || '%'
                        )
                  )`;
}

function generationTaskSummarySelect() {
    return `SELECT
                task_type,
                status,
                count(*)::int AS total,
                count(*) FILTER (WHERE status IN ('success', 'error', 'cancelled'))::int AS completed_total,
                coalesce(sum(CASE WHEN status IN ('success', 'error', 'cancelled') THEN greatest(0, extract(epoch FROM updated_at - created_at) * 1000) ELSE 0 END), 0) AS duration_total_ms,
                coalesce(sum(${generationTaskPointsSql()}), 0) AS points_cost
            FROM generation_tasks`;
}

function generationTaskPointsSql() {
    return `coalesce(
                nullif(${numericJsonValue("payload->>'pointsCost'")}, 0),
                nullif(${numericJsonValue("payload#>>'{billing,pointsCost}'")}, 0),
                nullif(${numericJsonValue("payload#>>'{upstream,pointsCost}'")}, 0),
                (SELECT nullif(sum(${numericJsonValue("task->>'pointsCost'")}), 0)
                 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(payload->'tasks') = 'array' THEN payload->'tasks' ELSE '[]'::jsonb END) AS task),
                (SELECT nullif(sum(${numericJsonValue("attempt->>'pointsCost'")}), 0)
                 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(payload->'attempts') = 'array' THEN payload->'attempts' ELSE '[]'::jsonb END) AS attempt
                 WHERE attempt->>'status' IN ('succeeded', 'success')),
                0
            )`;
}

function numericJsonValue(expression: string) {
    return `CASE WHEN coalesce(${expression}, '') ~ '^[0-9]+(?:\\.[0-9]+)?$' THEN (${expression})::numeric ELSE NULL END`;
}

function summarizeGenerationTaskRecords(records: StoredGenerationTaskRecord[]): GenerationTaskRecordSummary {
    const summary = emptyGenerationTaskSummary();
    for (const record of records) {
        summary.total += 1;
        summary.byType[record.type] = (summary.byType[record.type] || 0) + 1;
        summary.byStatus[record.status] = (summary.byStatus[record.status] || 0) + 1;
        if (record.status === "pending" || record.status === "running" || record.status === "paused") summary.active += 1;
        if (record.status === "success") summary.success += 1;
        if (record.status === "error") summary.failed += 1;
        if (record.status === "success" || record.status === "error" || record.status === "cancelled") {
            summary.averageDurationMs += Math.max(0, record.updatedAt - record.createdAt);
            summary.completedCount += 1;
        }
        summary.totalPointsCost += generationTaskPointsCost(record.payload);
    }
    return finalizeGenerationTaskSummary(summary);
}

function mapGenerationTaskSummary(rows: Array<Record<string, unknown>>): GenerationTaskRecordSummary {
    const summary = emptyGenerationTaskSummary();
    for (const row of rows) {
        const type = isTaskType(row.task_type) ? row.task_type : "agent";
        const status = isTaskStatus(row.status) ? row.status : "error";
        const total = Math.max(0, Math.floor(Number(row.total) || 0));
        summary.total += total;
        summary.byType[type] = (summary.byType[type] || 0) + total;
        summary.byStatus[status] = (summary.byStatus[status] || 0) + total;
        if (status === "pending" || status === "running" || status === "paused") summary.active += total;
        if (status === "success") summary.success += total;
        if (status === "error") summary.failed += total;
        summary.completedCount += Math.max(0, Math.floor(Number(row.completed_total) || 0));
        summary.averageDurationMs += Math.max(0, Number(row.duration_total_ms) || 0);
        summary.totalPointsCost += Math.max(0, Number(row.points_cost) || 0);
    }
    return finalizeGenerationTaskSummary(summary);
}

function emptyGenerationTaskSummary(): GenerationTaskSummaryAccumulator {
    return { total: 0, active: 0, success: 0, failed: 0, averageDurationMs: 0, completedCount: 0, totalPointsCost: 0, byType: {}, byStatus: {} };
}

function finalizeGenerationTaskSummary(summary: GenerationTaskSummaryAccumulator): GenerationTaskRecordSummary {
    return {
        total: summary.total,
        active: summary.active,
        success: summary.success,
        failed: summary.failed,
        averageDurationMs: summary.completedCount ? Math.round(summary.averageDurationMs / summary.completedCount) : 0,
        totalPointsCost: Number(summary.totalPointsCost.toFixed(2)),
        byType: summary.byType,
        byStatus: summary.byStatus,
    };
}

function summarizeAgentPerformanceRecords(records: StoredGenerationTaskRecord[]): GenerationTaskPerformanceSummary {
    const timings = records.map((record) => recordObject(record.payload.timings));
    const planning = timings.map((item) => elapsed(item.planningStartedAt, item.planningCompletedAt)).filter(positive);
    const firstResult = timings.map((item) => elapsed(item.requestAcceptedAt, item.firstResultReadyAt)).filter(positive);
    const queue = timings.map((item) => elapsed(item.planningCompletedAt, item.firstTaskSubmittedAt)).filter(nonNegative);
    const upstream = timings.map((item) => elapsed(item.firstTaskSubmittedAt, item.firstResultReadyAt)).filter(positive);
    const review = timings.map((item) => elapsed(item.allResultsReadyAt, item.reviewCompletedAt)).filter(positive);
    return {
        sampleSize: Math.max(planning.length, firstResult.length),
        planningP50Ms: percentile(planning, 0.5),
        planningP95Ms: percentile(planning, 0.95),
        firstResultP50Ms: percentile(firstResult, 0.5),
        firstResultP95Ms: percentile(firstResult, 0.95),
        queueAverageMs: average(queue),
        upstreamAverageMs: average(upstream),
        reviewAverageMs: average(review),
    };
}

function elapsed(start: unknown, end: unknown) {
    const from = Number(start);
    const to = Number(end);
    return Number.isFinite(from) && Number.isFinite(to) && to >= from ? to - from : -1;
}

function positive(value: number) {
    return value > 0;
}

function nonNegative(value: number) {
    return value >= 0;
}

function percentile(values: number[], ratio: number) {
    if (!values.length) return 0;
    const sorted = [...values].sort((left, right) => left - right);
    return Math.round(sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)]);
}

function average(values: number[]) {
    return values.length ? Math.round(values.reduce((total, value) => total + value, 0) / values.length) : 0;
}

function nonNegativeInteger(value: unknown) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

export async function updateStoredGenerationTask<T extends { id: string; userId: string; status: string; createdAt: number; updatedAt: number }>(type: GenerationTaskType, task: T, ttlMs: number) {
    await upsertTask(type, task, ttlMs);
    return task;
}

export async function transitionStoredGenerationTask<T extends { id: string; userId: string; status: string; createdAt: number; updatedAt: number }>(
    type: GenerationTaskType,
    id: string,
    userId: string,
    allowedStatuses: string[],
    patch: Partial<T> & { status: string },
    ttlMs: number,
    executionPatch?: import("@/lib/server/generation-task-scheduler").GenerationTaskSchedulePatch,
): Promise<T | null> {
    const updatedAt = Date.now();
    const nextPatch = { ...patch, updatedAt };
    const execution = executionPatch ? normalizeExecutionPatch(executionPatch) : null;
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ payload: T }>(
            `UPDATE generation_tasks
             SET status = $5, payload = payload || $6::jsonb, updated_at = $7, expires_at = $8,
                 execution_phase = CASE WHEN $9::boolean THEN COALESCE($10, execution_phase) ELSE execution_phase END,
                 upstream_task_id = CASE WHEN $9::boolean THEN COALESCE($11, upstream_task_id) ELSE upstream_task_id END,
                 channel_id = CASE WHEN $9::boolean THEN COALESCE($12, channel_id) ELSE channel_id END,
                 provider = CASE WHEN $9::boolean THEN COALESCE($13, provider) ELSE provider END,
                 query_path = CASE WHEN $9::boolean THEN COALESCE($14, query_path) ELSE query_path END,
                 submitted_at = CASE WHEN $9::boolean THEN COALESCE($15, submitted_at) ELSE submitted_at END,
                 next_poll_at = CASE WHEN $9::boolean THEN $16 ELSE next_poll_at END,
                 last_poll_at = CASE WHEN $9::boolean THEN COALESCE($17, last_poll_at) ELSE last_poll_at END,
                 last_upstream_status = CASE WHEN $9::boolean THEN COALESCE($18, last_upstream_status) ELSE last_upstream_status END,
                 result_payload = CASE WHEN $9::boolean THEN COALESCE($19::jsonb, result_payload) ELSE result_payload END,
                 worker_id = CASE WHEN $9::boolean THEN NULL ELSE worker_id END,
                 lease_until = CASE WHEN $9::boolean THEN NULL ELSE lease_until END
             WHERE id = $1 AND task_type = $2 AND user_id = $3 AND status = ANY($4::text[]) AND expires_at > now()
             RETURNING payload`,
            [
                id,
                type,
                userId,
                allowedStatuses.map(normalizeGenerationTaskStatus),
                normalizeGenerationTaskStatus(patch.status),
                JSON.stringify(nextPatch),
                new Date(updatedAt),
                new Date(updatedAt + ttlMs),
                Boolean(execution),
                execution?.executionPhase || null,
                execution?.upstreamTaskId || null,
                execution?.channelId || null,
                execution?.provider || null,
                execution?.queryPath || null,
                optionalDate(execution?.submittedAt),
                optionalDate(execution?.nextPollAt),
                optionalDate(execution?.lastPollAt),
                execution?.lastUpstreamStatus || null,
                execution?.resultPayload ? JSON.stringify(execution.resultPayload) : null,
            ],
        );
        return result.rows[0]?.payload || null;
    }
    let transitioned: T | null = null;
    const allowed = new Set(allowedStatuses.map(normalizeGenerationTaskStatus));
    await mutateFileTasks((tasks) =>
        tasks.map((record) => {
            if (record.id !== id || record.type !== type || record.userId !== userId || record.expiresAt <= updatedAt || !allowed.has(record.status)) return record;
            transitioned = { ...(record.payload as T), ...nextPatch };
            return {
                ...record,
                status: normalizeGenerationTaskStatus(patch.status),
                payload: transitioned as unknown as Record<string, unknown>,
                updatedAt,
                expiresAt: updatedAt + ttlMs,
                ...(execution ? applyExecutionPatch(execution) : {}),
                ...(execution ? { workerId: undefined, leaseUntil: undefined } : {}),
            };
        }),
    );
    return transitioned;
}

export async function mutateStoredGenerationTask<T extends { id: string; userId: string; status: string; createdAt: number; updatedAt: number }>(type: GenerationTaskType, id: string, ttlMs: number, mutate: (current: T) => T | null): Promise<T | null> {
    const updatedAt = Date.now();
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        return withPostgresTransaction(async (client) => {
            const result = await client.query<{ payload: T }>("SELECT payload FROM generation_tasks WHERE id = $1 AND task_type = $2 AND expires_at > now() FOR UPDATE", [id, type]);
            const current = result.rows[0]?.payload;
            if (!current) return null;
            const next = normalizeMutation(current, mutate(current), updatedAt);
            if (!next) return null;
            const updated = await client.query<{ payload: T }>(
                `UPDATE generation_tasks
                 SET status = $3, payload = $4::jsonb, updated_at = $5, expires_at = $6
                 WHERE id = $1 AND task_type = $2
                 RETURNING payload`,
                [id, type, normalizeGenerationTaskStatus(next.status), JSON.stringify(next), new Date(updatedAt), new Date(updatedAt + ttlMs)],
            );
            return updated.rows[0]?.payload || null;
        });
    }
    let mutated: T | null = null;
    await mutateFileTasks((tasks) =>
        tasks.map((record) => {
            if (record.id !== id || record.type !== type || record.expiresAt <= updatedAt) return record;
            const current = record.payload as T;
            const next = normalizeMutation(current, mutate(current), updatedAt);
            if (!next) return record;
            mutated = next;
            return { ...record, status: normalizeGenerationTaskStatus(next.status), payload: next as unknown as Record<string, unknown>, updatedAt, expiresAt: updatedAt + ttlMs };
        }),
    );
    return mutated;
}

export async function touchStoredGenerationTask(type: GenerationTaskType, id: string, updatedAt: number, ttlMs: number) {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        await postgresQuery("UPDATE generation_tasks SET updated_at = $3, expires_at = $4, payload = jsonb_set(payload, '{updatedAt}', to_jsonb($5::bigint)) WHERE id = $1 AND task_type = $2", [
            id,
            type,
            new Date(updatedAt),
            new Date(updatedAt + ttlMs),
            updatedAt,
        ]);
        return;
    }
    await mutateFileTasks((tasks) => tasks.map((task) => (task.id === id && task.type === type ? { ...task, updatedAt, expiresAt: updatedAt + ttlMs, payload: { ...task.payload, updatedAt } } : task)));
}

export async function linkStoredGenerationTask(type: GenerationTaskType, id: string, context: GenerationTaskContext) {
    const normalized = normalizeGenerationTaskContext(context);
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        await postgresQuery(
            `UPDATE generation_tasks
             SET conversation_id = COALESCE($3, conversation_id), run_id = COALESCE($4, run_id), surface = COALESCE($5, surface),
                 project_id = COALESCE($6, project_id), parent_task_id = COALESCE($7, parent_task_id), attempt_no = COALESCE($8, attempt_no),
                 client_request_id = COALESCE($9, client_request_id), payload = payload || $10::jsonb
             WHERE id = $1 AND task_type = $2`,
            [
                id,
                type,
                normalized.conversationId || null,
                normalized.runId || null,
                normalized.surface || null,
                normalized.projectId || null,
                normalized.parentTaskId || null,
                normalized.attemptNo ?? null,
                normalized.clientRequestId || null,
                JSON.stringify(normalized),
            ],
        );
        return;
    }
    await mutateFileTasks((tasks) => tasks.map((task) => (task.id === id && task.type === type ? { ...task, ...normalized, payload: { ...task.payload, ...normalized } } : task)));
}

export async function countActiveStoredGenerationTasks(userId: string, type: GenerationTaskType, staleMs: number, excludeTaskId?: string) {
    const activeAfter = Date.now() - staleMs;
    const concurrencyClassFilter = type === "image" ? " AND COALESCE(payload->>'concurrencyClass', '') <> 'canvas-layer'" : "";
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ total: string | number }>(
            `SELECT count(*) AS total FROM generation_tasks WHERE user_id = $1 AND task_type = $2 AND status IN ('pending', 'running') AND execution_phase = ANY($4::text[]) AND updated_at >= $3 AND expires_at > now()${excludeTaskId ? " AND id <> $5" : ""}${concurrencyClassFilter}`,
            [userId, type, new Date(activeAfter), ACTIVE_CONCURRENCY_PHASES, ...(excludeTaskId ? [excludeTaskId] : [])],
        );
        return Number(result.rows[0]?.total || 0);
    }
    const tasks = await readFileTasks();
    return tasks.filter(
        (task) =>
            task.id !== excludeTaskId &&
            task.userId === userId &&
            task.type === type &&
            countsTowardGenerationConcurrency(task) &&
            ["pending", "running"].includes(task.status) &&
            isActiveConcurrencyPhase(task.executionPhase) &&
            task.updatedAt >= activeAfter &&
            task.expiresAt > Date.now(),
    ).length;
}

export async function generationCapacityRetryAfterSeconds(userId: string, type: GenerationTaskType, staleMs: number, excludeTaskId?: string) {
    const now = Date.now();
    const activeAfter = now - staleMs;
    const concurrencyClassFilter = type === "image" ? " AND COALESCE(payload->>'concurrencyClass', '') <> 'canvas-layer'" : "";
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ retry_after_seconds?: string | number }>(
            `SELECT CASE WHEN count(*) = 0 THEN NULL ELSE GREATEST(1, CEIL(EXTRACT(EPOCH FROM (
                 MIN(CASE
                     WHEN lease_until > now() THEN lease_until
                     WHEN next_poll_at > now() THEN next_poll_at
                     ELSE now()
                 END) - now()
             ))))::integer END AS retry_after_seconds
             FROM generation_tasks
             WHERE user_id = $1 AND task_type = $2 AND status IN ('pending', 'running')
               AND execution_phase = ANY($4::text[]) AND updated_at >= $3 AND expires_at > now()${excludeTaskId ? " AND id <> $5" : ""}${concurrencyClassFilter}`,
            [userId, type, new Date(activeAfter), ACTIVE_CONCURRENCY_PHASES, ...(excludeTaskId ? [excludeTaskId] : [])],
        );
        const seconds = Number(result.rows[0]?.retry_after_seconds);
        return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
    }
    const retryAt = (await readFileTasks())
        .filter(
            (task) =>
                task.id !== excludeTaskId &&
                task.userId === userId &&
                task.type === type &&
                countsTowardGenerationConcurrency(task) &&
                ["pending", "running"].includes(task.status) &&
                isActiveConcurrencyPhase(task.executionPhase) &&
                task.updatedAt >= activeAfter &&
                task.expiresAt > now,
        )
        .reduce((earliest, task) => Math.min(earliest, task.leaseUntil && task.leaseUntil > now ? task.leaseUntil : task.nextPollAt && task.nextPollAt > now ? task.nextPollAt : now), Number.POSITIVE_INFINITY);
    return Number.isFinite(retryAt) ? Math.max(1, Math.ceil((retryAt - now) / 1000)) : undefined;
}

export async function withGenerationConcurrencyLimit<T>(userId: string, type: GenerationTaskType, staleMs: number, limit: number, handler: () => Promise<T>, excludeTaskId?: string, requestId?: string): Promise<T | null> {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const reservationId = requestId?.trim() || `reservation:${crypto.randomUUID()}`;
        const admitted = await withPostgresTransaction(async (client) => {
            await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [userId, type]);
            await client.query("DELETE FROM generation_concurrency_reservations WHERE expires_at <= now()");
            const duplicate = await client.query("SELECT 1 FROM generation_concurrency_reservations WHERE user_id = $1 AND task_type = $2 AND request_id = $3 AND expires_at > now()", [userId, type, reservationId]);
            if (duplicate.rows.length) return false;
            const result = await client.query<{ total: string | number }>(
                `SELECT
                    (SELECT count(*) FROM generation_tasks WHERE user_id = $1 AND task_type = $2 AND status IN ('pending', 'running') AND execution_phase = ANY($4::text[]) AND updated_at >= $3 AND expires_at > now()${excludeTaskId ? " AND id <> $5" : ""}${type === "image" ? " AND COALESCE(payload->>'concurrencyClass', '') <> 'canvas-layer'" : ""})
                    +
                    (SELECT count(*) FROM generation_concurrency_reservations AS reservation
                     WHERE reservation.user_id = $1 AND reservation.task_type = $2 AND reservation.expires_at > now()
                       AND NOT EXISTS (
                           SELECT 1 FROM generation_tasks AS task
                           WHERE task.user_id = reservation.user_id AND task.task_type = reservation.task_type
                             AND task.client_request_id = reservation.request_id AND task.status IN ('pending', 'running')
                             AND task.execution_phase = ANY($4::text[]) AND task.updated_at >= $3 AND task.expires_at > now()
                       )) AS total`,
                [userId, type, new Date(Date.now() - staleMs), ACTIVE_CONCURRENCY_PHASES, ...(excludeTaskId ? [excludeTaskId] : [])],
            );
            if (Number(result.rows[0]?.total || 0) >= limit) return false;
            await client.query("INSERT INTO generation_concurrency_reservations (user_id, task_type, request_id, expires_at) VALUES ($1, $2, $3, $4)", [userId, type, reservationId, new Date(Date.now() + staleMs)]);
            return true;
        });
        if (!admitted) return null;
        try {
            return await handler();
        } finally {
            await postgresQuery("DELETE FROM generation_concurrency_reservations WHERE user_id = $1 AND task_type = $2 AND request_id = $3", [userId, type, reservationId]);
        }
    }

    const key = `${userId}:${type}`;
    const previous = concurrencyQueues.get(key) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
        release = resolve;
    });
    const queued = previous.then(() => current);
    concurrencyQueues.set(key, queued);
    await previous;
    try {
        return (await countActiveStoredGenerationTasks(userId, type, staleMs, excludeTaskId)) >= limit ? null : handler();
    } finally {
        release();
        if (concurrencyQueues.get(key) === queued) concurrencyQueues.delete(key);
    }
}

function isActiveConcurrencyPhase(phase: StoredGenerationTaskRecord["executionPhase"]) {
    return !phase || ACTIVE_CONCURRENCY_PHASES.includes(phase as (typeof ACTIVE_CONCURRENCY_PHASES)[number]);
}

function countsTowardGenerationConcurrency(task: StoredGenerationTaskRecord) {
    return task.concurrencyClass !== "canvas-layer";
}

async function upsertTask<T extends { id: string; userId: string; status: string; createdAt: number; updatedAt: number }>(type: GenerationTaskType, task: T, ttlMs: number) {
    const status = normalizeGenerationTaskStatus(task.status);
    const context = normalizeGenerationTaskContext(task as GenerationTaskContext);
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        await postgresQuery(
            `INSERT INTO generation_tasks (
                id, user_id, task_type, status, payload, created_at, updated_at, expires_at,
                conversation_id, run_id, surface, project_id, parent_task_id, attempt_no, client_request_id
             )
             VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
             ON CONFLICT (id) DO UPDATE SET
                status = EXCLUDED.status, payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at, expires_at = EXCLUDED.expires_at,
                conversation_id = COALESCE(EXCLUDED.conversation_id, generation_tasks.conversation_id),
                run_id = COALESCE(EXCLUDED.run_id, generation_tasks.run_id), surface = COALESCE(EXCLUDED.surface, generation_tasks.surface),
                project_id = COALESCE(EXCLUDED.project_id, generation_tasks.project_id), parent_task_id = COALESCE(EXCLUDED.parent_task_id, generation_tasks.parent_task_id),
                attempt_no = COALESCE(EXCLUDED.attempt_no, generation_tasks.attempt_no), client_request_id = COALESCE(EXCLUDED.client_request_id, generation_tasks.client_request_id)`,
            [
                task.id,
                task.userId,
                type,
                status,
                JSON.stringify(task),
                new Date(task.createdAt),
                new Date(task.updatedAt),
                new Date(task.updatedAt + ttlMs),
                context.conversationId || null,
                context.runId || null,
                context.surface || null,
                context.projectId || null,
                context.parentTaskId || null,
                context.attemptNo ?? null,
                context.clientRequestId || null,
            ],
        );
        return;
    }
    await mutateFileTasks((tasks) => {
        const previous = tasks.find((item) => item.id === task.id);
        const record: StoredGenerationTaskRecord = {
            id: task.id,
            userId: task.userId,
            type,
            status,
            payload: task as unknown as Record<string, unknown>,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
            expiresAt: task.updatedAt + ttlMs,
            ...preserveTaskContext(previous, context),
            ...preserveTaskExecution(previous),
        };
        return [record, ...tasks.filter((item) => item.id !== task.id)];
    });
}

async function insertTask<T extends { id: string; userId: string; status: string; createdAt: number; updatedAt: number }>(type: GenerationTaskType, task: T, ttlMs: number): Promise<T> {
    const status = normalizeGenerationTaskStatus(task.status);
    const context = normalizeGenerationTaskContext(task as GenerationTaskContext);
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const values = taskValues(type, task, ttlMs, status, context);
        const inserted = await postgresQuery<{ payload: T }>(
            `INSERT INTO generation_tasks (
                id, user_id, task_type, status, payload, created_at, updated_at, expires_at,
                conversation_id, run_id, surface, project_id, parent_task_id, attempt_no, client_request_id
             )
             VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
             ON CONFLICT DO NOTHING
             RETURNING payload`,
            values,
        );
        if (inserted.rows[0]?.payload) return inserted.rows[0].payload;
        const existing = context.clientRequestId ? await getStoredGenerationTaskByRequest<T>(type, task.userId, context.clientRequestId, context.attemptNo) : await getStoredGenerationTask<T>(type, task.id);
        if (existing) return existing;
        throw new Error("生成任务写入冲突，请重试");
    }
    return withGenerationTaskFileMutation(async (tasks) => {
        const duplicate = tasks.find((item) => item.id === task.id || (context.clientRequestId && sameTaskRequest(item, type, task.userId, context.clientRequestId, normalizedAttemptNo(context.attemptNo))));
        if (duplicate) return { tasks, result: duplicate.payload as T };
        const record: StoredGenerationTaskRecord = {
            id: task.id,
            userId: task.userId,
            type,
            status,
            payload: task as unknown as Record<string, unknown>,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
            expiresAt: task.updatedAt + ttlMs,
            executionPhase: "created",
            ...context,
        };
        return { tasks: [record, ...tasks], result: task };
    });
}

function taskValues<T extends { id: string; userId: string; createdAt: number; updatedAt: number }>(type: GenerationTaskType, task: T, ttlMs: number, status: GenerationTaskStatus, context: GenerationTaskContext) {
    return [
        task.id,
        task.userId,
        type,
        status,
        JSON.stringify(task),
        new Date(task.createdAt),
        new Date(task.updatedAt),
        new Date(task.updatedAt + ttlMs),
        context.conversationId || null,
        context.runId || null,
        context.surface || null,
        context.projectId || null,
        context.parentTaskId || null,
        context.attemptNo ?? null,
        context.clientRequestId || null,
    ];
}

async function readFileTasks() {
    return readJsonDataFile<StoredGenerationTaskRecord[]>(TASK_FILE, []);
}

function mutateFileTasks(mutator: (tasks: StoredGenerationTaskRecord[]) => StoredGenerationTaskRecord[]) {
    return withGenerationTaskFileMutation(async (tasks) => ({ tasks: mutator(tasks), result: undefined }));
}

export function withGenerationTaskFileMutation<T>(mutator: (tasks: StoredGenerationTaskRecord[]) => Promise<{ tasks: StoredGenerationTaskRecord[]; result: T }>) {
    const run = fileMutationQueue.then(async () => {
        return withJsonDataFileLock(TASK_FILE, async () => {
            const mutation = await mutator(await readFileTasks());
            await writeJsonDataFile(TASK_FILE, mutation.tasks);
            return mutation.result;
        });
    });
    fileMutationQueue = run.then(
        () => undefined,
        () => undefined,
    );
    return run;
}

function normalizeGenerationTaskContext(context: GenerationTaskContext): GenerationTaskContext {
    const attempt = Number(context.attemptNo);
    return {
        conversationId: cleanContextText(context.conversationId),
        runId: cleanContextText(context.runId),
        surface: context.surface === "chat" || context.surface === "canvas" || context.surface === "drama" ? context.surface : undefined,
        projectId: cleanContextText(context.projectId),
        episodeId: cleanContextText(context.episodeId),
        shotId: cleanContextText(context.shotId),
        estimatedPoints: positiveContextNumber(context.estimatedPoints),
        parentTaskId: cleanContextText(context.parentTaskId),
        attemptNo: Number.isFinite(attempt) && attempt >= 0 ? Math.floor(attempt) : undefined,
        clientRequestId: cleanContextText(context.clientRequestId),
        generationLogId: cleanContextText(context.generationLogId),
        generationSlotId: cleanContextText(context.generationSlotId),
        concurrencyClass: context.concurrencyClass === "canvas-layer" ? "canvas-layer" : undefined,
    };
}

function preserveTaskContext(previous: StoredGenerationTaskRecord | undefined, next: GenerationTaskContext): GenerationTaskContext {
    return {
        conversationId: next.conversationId || previous?.conversationId,
        runId: next.runId || previous?.runId,
        surface: next.surface || previous?.surface,
        projectId: next.projectId || previous?.projectId,
        episodeId: next.episodeId || previous?.episodeId,
        shotId: next.shotId || previous?.shotId,
        estimatedPoints: next.estimatedPoints ?? previous?.estimatedPoints,
        parentTaskId: next.parentTaskId || previous?.parentTaskId,
        attemptNo: next.attemptNo ?? previous?.attemptNo,
        clientRequestId: next.clientRequestId || previous?.clientRequestId,
        generationLogId: next.generationLogId || previous?.generationLogId,
        generationSlotId: next.generationSlotId || previous?.generationSlotId,
        concurrencyClass: next.concurrencyClass || previous?.concurrencyClass,
    };
}

function preserveTaskExecution(previous?: StoredGenerationTaskRecord) {
    if (!previous) return { executionPhase: "created" as const };
    return {
        executionPhase: previous.executionPhase,
        upstreamTaskId: previous.upstreamTaskId,
        channelId: previous.channelId,
        provider: previous.provider,
        queryPath: previous.queryPath,
        submittedAt: previous.submittedAt,
        nextPollAt: previous.nextPollAt,
        lastPollAt: previous.lastPollAt,
        lastUpstreamStatus: previous.lastUpstreamStatus,
        resultPayload: previous.resultPayload,
        workerId: previous.workerId,
        leaseUntil: previous.leaseUntil,
        lastHeartbeatAt: previous.lastHeartbeatAt,
    };
}

function cleanContextText(value?: string) {
    return value?.trim().slice(0, 160) || undefined;
}

function cleanUpstreamTaskId(value?: string) {
    return value?.trim().slice(0, 500) || undefined;
}

function normalizedAttemptNo(value: unknown) {
    const attempt = Number(value);
    return Number.isFinite(attempt) && attempt >= 0 ? Math.floor(attempt) : 0;
}

function sameTaskRequest(task: StoredGenerationTaskRecord, type: GenerationTaskType, userId: string, clientRequestId: string, attemptNo: number) {
    return task.type === type && task.userId === userId && task.clientRequestId === clientRequestId && normalizedAttemptNo(task.attemptNo) === attemptNo;
}

function positiveContextNumber(value: unknown) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Number(number.toFixed(2)) : undefined;
}

function normalizeGenerationTaskStatus(status: string): GenerationTaskStatus {
    const value = status.trim().toLowerCase();
    if (["planning", "queued", "created", "pending"].includes(value)) return "pending";
    if (["processing", "in_progress", "running"].includes(value)) return "running";
    if (["completed", "succeeded", "success"].includes(value)) return "success";
    if (["failed", "failure", "error", "expired"].includes(value)) return "error";
    if (value === "paused") return "paused";
    if (value === "cancelled" || value === "canceled") return "cancelled";
    return "error";
}

function mapStoredTaskRecord(row: Record<string, unknown>): StoredGenerationTaskRecord {
    const payload = row.payload && typeof row.payload === "object" ? (row.payload as Record<string, unknown>) : {};
    return {
        id: String(row.id || ""),
        userId: String(row.user_id || ""),
        type: isTaskType(row.task_type) ? row.task_type : "text",
        status: isTaskStatus(row.status) ? row.status : "error",
        payload,
        createdAt: databaseTime(row.created_at),
        updatedAt: databaseTime(row.updated_at),
        expiresAt: databaseTime(row.expires_at),
        conversationId: cleanContextText(String(row.conversation_id || "")),
        runId: cleanContextText(String(row.run_id || "")),
        surface: isTaskSurface(row.surface) ? row.surface : undefined,
        projectId: cleanContextText(String(row.project_id || "")),
        episodeId: cleanContextText(String(payload.episodeId || "")),
        shotId: cleanContextText(String(payload.shotId || "")),
        estimatedPoints: positiveContextNumber(payload.estimatedPoints),
        parentTaskId: cleanContextText(String(row.parent_task_id || "")),
        attemptNo: row.attempt_no === null || row.attempt_no === undefined ? undefined : Math.max(0, Math.floor(Number(row.attempt_no) || 0)),
        clientRequestId: cleanContextText(String(row.client_request_id || "")),
        executionPhase: isExecutionPhase(row.execution_phase) ? row.execution_phase : undefined,
        upstreamTaskId: cleanUpstreamTaskId(String(row.upstream_task_id || "")),
        channelId: cleanContextText(String(row.channel_id || "")),
        provider: cleanContextText(String(row.provider || "")),
        queryPath: typeof row.query_path === "string" ? row.query_path.trim().slice(0, 1_000) || undefined : undefined,
        submittedAt: optionalDatabaseTime(row.submitted_at),
        nextPollAt: optionalDatabaseTime(row.next_poll_at),
        lastPollAt: optionalDatabaseTime(row.last_poll_at),
        lastUpstreamStatus: cleanContextText(String(row.last_upstream_status || "")),
        resultPayload: recordObject(row.result_payload),
        workerId: cleanContextText(String(row.worker_id || "")),
        leaseUntil: optionalDatabaseTime(row.lease_until),
        lastHeartbeatAt: optionalDatabaseTime(row.last_heartbeat_at),
    };
}

function mapGenerationTaskCostAggregate(row: Record<string, unknown>): GenerationTaskCostAggregate[] {
    if (!isTaskType(row.task_type) || !isTaskStatus(row.status)) return [];
    return [
        {
            type: row.task_type,
            status: row.status,
            taskCount: Math.max(0, Math.floor(Number(row.task_count) || 0)),
            estimatedPoints: Math.max(0, Number(row.estimated_points) || 0),
            actualPoints: Math.max(0, Number(row.actual_points) || 0),
        },
    ];
}

function isTaskType(value: unknown): value is GenerationTaskType {
    return value === "text" || value === "image" || value === "video" || value === "audio" || value === "agent" || value === "render";
}

function isTaskStatus(value: unknown): value is GenerationTaskStatus {
    return value === "pending" || value === "running" || value === "success" || value === "error" || value === "paused" || value === "cancelled";
}

function isTaskSurface(value: unknown): value is NonNullable<GenerationTaskContext["surface"]> {
    return value === "chat" || value === "canvas" || value === "drama";
}

function isExecutionPhase(value: unknown): value is NonNullable<StoredGenerationTaskRecord["executionPhase"]> {
    return (
        value === "created" ||
        value === "submitting" ||
        value === "submitted" ||
        value === "polling" ||
        value === "result_ready" ||
        value === "persisting" ||
        value === "cancel_requested" ||
        value === "cancel_polling" ||
        value === "needs_review" ||
        value === "review_pending" ||
        value === "reviewing" ||
        value === "review_unavailable" ||
        value === "completed"
    );
}

function normalizeExecutionPatch(patch: import("@/lib/server/generation-task-scheduler").GenerationTaskSchedulePatch) {
    return {
        executionPhase: isExecutionPhase(patch.executionPhase) ? patch.executionPhase : undefined,
        upstreamTaskId: cleanUpstreamTaskId(patch.upstreamTaskId),
        channelId: cleanContextText(patch.channelId),
        provider: cleanContextText(patch.provider)?.slice(0, 80),
        queryPath: typeof patch.queryPath === "string" ? patch.queryPath.trim().slice(0, 1_000) || undefined : undefined,
        submittedAt: positiveTimestamp(patch.submittedAt),
        nextPollAt: positiveTimestamp(patch.nextPollAt),
        lastPollAt: positiveTimestamp(patch.lastPollAt),
        lastUpstreamStatus: cleanContextText(patch.lastUpstreamStatus),
        resultPayload: recordObject(patch.resultPayload),
    } satisfies import("@/lib/server/generation-task-scheduler").GenerationTaskSchedulePatch;
}

function applyExecutionPatch(patch: import("@/lib/server/generation-task-scheduler").GenerationTaskSchedulePatch) {
    return {
        ...(patch.executionPhase ? { executionPhase: patch.executionPhase } : {}),
        ...(patch.upstreamTaskId ? { upstreamTaskId: patch.upstreamTaskId } : {}),
        ...(patch.channelId ? { channelId: patch.channelId } : {}),
        ...(patch.provider ? { provider: patch.provider } : {}),
        ...(patch.queryPath ? { queryPath: patch.queryPath } : {}),
        ...(patch.submittedAt ? { submittedAt: patch.submittedAt } : {}),
        nextPollAt: patch.nextPollAt,
        ...(patch.lastPollAt ? { lastPollAt: patch.lastPollAt } : {}),
        ...(patch.lastUpstreamStatus ? { lastUpstreamStatus: patch.lastUpstreamStatus } : {}),
        ...(patch.resultPayload ? { resultPayload: patch.resultPayload } : {}),
    };
}

function positiveTimestamp(value: unknown) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function optionalDate(value: unknown) {
    const timestamp = positiveTimestamp(value);
    return timestamp ? new Date(timestamp) : null;
}

function databaseTime(value: unknown) {
    const time = value instanceof Date ? value.getTime() : new Date(String(value || "")).getTime();
    return Number.isFinite(time) ? time : 0;
}

function optionalDatabaseTime(value: unknown) {
    return value ? databaseTime(value) || undefined : undefined;
}

function withExecutionState<T>(payload: T, phase: unknown, status: unknown, resultPayload: unknown): T & GenerationTaskExecutionState {
    const executionPhase = isExecutionPhase(phase) ? phase : undefined;
    const lastUpstreamStatus = cleanContextText(typeof status === "string" ? status : "");
    return {
        ...payload,
        executionPhase,
        lastUpstreamStatus,
        reviewReason: resolveGenerationReviewReason({ executionPhase, lastUpstreamStatus, resultPayload }),
    };
}

function recordObject(value: unknown) {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function positiveNumber(...values: unknown[]) {
    for (const value of values) {
        const number = Number(value);
        if (Number.isFinite(number) && number > 0) return number;
    }
    return 0;
}

function normalizeMutation<T extends { id: string; userId: string; status: string; createdAt: number; updatedAt: number }>(current: T, next: T | null, updatedAt: number) {
    return next ? { ...next, id: current.id, userId: current.userId, createdAt: current.createdAt, updatedAt } : null;
}
