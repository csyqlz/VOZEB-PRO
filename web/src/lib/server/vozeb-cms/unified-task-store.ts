import { readJsonDataFile } from "@/lib/server/data-adapter";
import { ensurePostgresSchema, getDatabaseProvider, postgresQuery } from "@/lib/server/database";
import { mapStoredGenerationTaskRecord, type StoredGenerationTaskRecord } from "@/lib/server/generation-task-store";
import { normalizeStoredVozebCmsWorkflowRun } from "@/lib/server/vozeb-cms/workflow-store";
import type { GenerationTaskStatus, GenerationTaskType } from "@/lib/server/generation-task-types";
import type { VozebCmsWorkflowRun, VozebCmsWorkflowRunStatus } from "@/lib/vozeb-cms/workflow-contract";
import { comesBeforeVozebCmsResourceCursor, compareVozebCmsResourceCursor, type VozebCmsResourceCursor } from "./unified-resource-cursor";

export type VozebCmsUnifiedTaskRecord = { source: "generation"; id: string; updatedAt: number; record: StoredGenerationTaskRecord } | { source: "workflow"; id: string; updatedAt: number; run: VozebCmsWorkflowRun };

type CursorInput = {
    userId: string;
    projectId?: string;
    generationTypes: GenerationTaskType[];
    generationStatuses?: GenerationTaskStatus[];
    includeWorkflow: boolean;
    workflowStatuses?: VozebCmsWorkflowRunStatus[];
    cursor?: VozebCmsResourceCursor;
    limit: number;
};

export async function listVozebCmsUnifiedTaskRecords(input: CursorInput) {
    const userId = input.userId.trim();
    const projectId = input.projectId?.trim() || "";
    const generationTypes = Array.from(new Set(input.generationTypes));
    const generationStatuses = Array.from(new Set(input.generationStatuses || []));
    const workflowStatuses = Array.from(new Set(input.workflowStatuses || []));
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit)));
    if (!userId || (!generationTypes.length && !input.includeWorkflow)) return { items: [] as VozebCmsUnifiedTaskRecord[], total: 0, hasMore: false };
    if (getDatabaseProvider() === "postgres") return listPostgresRecords({ ...input, userId, projectId, generationTypes, generationStatuses, workflowStatuses, limit });
    return listFileRecords({ ...input, userId, projectId, generationTypes, generationStatuses, workflowStatuses, limit });
}

async function listPostgresRecords(input: CursorInput & { projectId: string; generationStatuses: GenerationTaskStatus[]; workflowStatuses: VozebCmsWorkflowRunStatus[] }) {
    await ensurePostgresSchema();
    const before = input.cursor ? new Date(input.cursor.time) : null;
    const params = [
        input.userId,
        input.projectId || null,
        input.generationTypes.length > 0,
        input.generationTypes,
        input.generationStatuses,
        input.includeWorkflow,
        input.workflowStatuses,
        before,
        input.cursor?.source || null,
        input.cursor?.id || null,
        input.limit + 1,
    ];
    const result = await postgresQuery<Record<string, unknown>>(
        `WITH unified AS (
             SELECT 'generation'::text AS source, task.id, task.updated_at, to_jsonb(task) AS source_json
             FROM generation_tasks task
             WHERE $3::boolean
               AND task.expires_at > now()
               AND task.user_id = $1
               AND ($2::text IS NULL OR task.project_id = $2)
               AND task.task_type = ANY($4::text[])
               AND (cardinality($5::text[]) = 0 OR task.status = ANY($5::text[]))
             UNION ALL
             SELECT 'workflow'::text AS source, run.id, run.updated_at, run.run_json AS source_json
             FROM vozeb_workflow_runs run
             WHERE $6::boolean
               AND run.user_id = $1
               AND ($2::text IS NULL OR run.project_id = $2)
               AND (cardinality($7::text[]) = 0 OR run.status = ANY($7::text[]))
         ), totals AS (
             SELECT count(*)::integer AS total FROM unified
         ), page_items AS (
             SELECT * FROM unified
             WHERE $8::timestamptz IS NULL
                OR updated_at < $8
                OR (updated_at = $8 AND (source < $9 OR (source = $9 AND id < $10)))
             ORDER BY updated_at DESC, source DESC, id DESC
             LIMIT $11
         )
         SELECT page_items.source, page_items.id, page_items.updated_at, page_items.source_json, totals.total
         FROM totals LEFT JOIN page_items ON TRUE
         ORDER BY page_items.updated_at DESC NULLS LAST, page_items.source DESC, page_items.id DESC`,
        params,
    );
    const items = result.rows.flatMap(mapPostgresRecord);
    return { items: items.slice(0, input.limit), total: Math.max(0, Number(result.rows[0]?.total) || 0), hasMore: items.length > input.limit };
}

async function listFileRecords(input: CursorInput & { projectId: string; generationStatuses: GenerationTaskStatus[]; workflowStatuses: VozebCmsWorkflowRunStatus[] }) {
    const [tasks, workflowDatabase] = await Promise.all([readJsonDataFile<StoredGenerationTaskRecord[]>("generation-tasks.json", []), readJsonDataFile<{ runs?: VozebCmsWorkflowRun[] }>("vozeb-workflows.json", { runs: [] })]);
    const now = Date.now();
    const generation = input.generationTypes.length
        ? tasks
              .filter(
                  (record) =>
                      record.expiresAt > now &&
                      record.userId === input.userId &&
                      (!input.projectId || record.projectId === input.projectId) &&
                      input.generationTypes.includes(record.type) &&
                      (!input.generationStatuses.length || input.generationStatuses.includes(record.status)),
              )
              .map((record): VozebCmsUnifiedTaskRecord => ({ source: "generation", id: record.id, updatedAt: record.updatedAt, record }))
        : [];
    const workflows = input.includeWorkflow
        ? (Array.isArray(workflowDatabase.runs) ? workflowDatabase.runs : [])
              .map(normalizeStoredVozebCmsWorkflowRun)
              .filter((run) => run.userId === input.userId && (!input.projectId || run.projectId === input.projectId) && (!input.workflowStatuses.length || input.workflowStatuses.includes(run.status)))
              .map((run): VozebCmsUnifiedTaskRecord => ({ source: "workflow", id: run.id, updatedAt: run.updatedAt, run }))
        : [];
    const all = [...generation, ...workflows].sort((left, right) => compareVozebCmsResourceCursor(recordCursor(left), recordCursor(right)));
    const page = all.filter((record) => comesBeforeVozebCmsResourceCursor(recordCursor(record), input.cursor)).slice(0, input.limit + 1);
    return { items: page.slice(0, input.limit), total: all.length, hasMore: page.length > input.limit };
}

function mapPostgresRecord(row: Record<string, unknown>): VozebCmsUnifiedTaskRecord[] {
    const source = row.source === "workflow" ? "workflow" : row.source === "generation" ? "generation" : undefined;
    const sourceJson = object(row.source_json);
    if (!source || !row.id || !row.updated_at) return [];
    if (source === "generation") {
        const record = mapStoredGenerationTaskRecord(sourceJson);
        return record.id ? [{ source, id: record.id, updatedAt: record.updatedAt, record }] : [];
    }
    const run = normalizeStoredVozebCmsWorkflowRun(sourceJson as unknown as VozebCmsWorkflowRun);
    return run.id ? [{ source, id: run.id, updatedAt: run.updatedAt, run }] : [];
}

function recordCursor(record: VozebCmsUnifiedTaskRecord): VozebCmsResourceCursor {
    return { time: record.updatedAt, source: record.source, id: record.id };
}

function object(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
