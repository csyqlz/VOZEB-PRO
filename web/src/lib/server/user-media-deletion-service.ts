import type { CanvasProject } from "@/lib/canvas-project-contract";
import { readJsonDataFile, withJsonDataFileLocks, writeJsonDataFile } from "@/lib/server/data-adapter";
import { ensurePostgresSchema, getDatabaseProvider, withPostgresTransaction, type QueryExecutor } from "@/lib/server/database";
import type { RuntimeFileDatabase } from "@/lib/server/creative-runtime-repository";
import type { GenerationLogDatabase } from "@/lib/server/generation-log-types";
import type { StoredGenerationTaskRecord } from "@/lib/server/generation-task-store";
import { getLocalMediaRegistrations, type LocalMediaRegistration } from "@/lib/server/local-media-registry";
import { deleteRegisteredLocalMediaSnapshots } from "@/lib/server/local-media-storage";
import { cleanCanvasProjectMediaReferences, cleanUserMediaReferences, containsUserMediaReference } from "@/lib/server/user-media-reference-cleanup";

const FILES = ["auth.json", "canvas-projects.json", "creative-runtime.json", "drama-projects.json", "generation-logs.json", "generation-tasks.json", "library-assets.json", "local-media-assets.json"] as const;

type CanvasProjectFile = { version: 1; projects: Array<{ userId: string; project: CanvasProject }> };
type ProjectFile = { version: 1; projects: Array<{ userId: string; project: Record<string, unknown> }> };
type LibraryAssetFile = { version: 1; assets: unknown[] };
type LocalMediaFile = { version: 1; assets: LocalMediaRegistration[] };

export async function deleteUserMediaAssetsCascade(userId: string, storageKeys: string[]) {
    const ownerUserId = userId.trim();
    const requestedKeys = normalizeKeys(storageKeys);
    if (!ownerUserId || !requestedKeys.length) return emptyResult();

    const cleanup = getDatabaseProvider() === "postgres" ? await cleanPostgresReferences(ownerUserId, requestedKeys) : await cleanFileReferences(ownerUserId, requestedKeys);
    if (!cleanup.registrations.length) return emptyResult();
    const deleted = await deleteRegisteredLocalMediaSnapshots(cleanup.registrations);
    return { ...deleted, removedReferences: cleanup.removedReferences };
}

async function cleanPostgresReferences(userId: string, storageKeys: string[]) {
    await ensurePostgresSchema();
    return withPostgresTransaction(async (client) => {
        const registrations = await getLocalMediaRegistrations(storageKeys, { ownerUserId: userId, executor: client, forUpdate: true });
        const keys = registrations.map((item) => item.storageKey);
        if (!keys.length) return { registrations, removedReferences: 0 };
        const removedReferences = await removePostgresReferences(client, userId, keys);
        return { registrations, removedReferences };
    });
}

async function removePostgresReferences(client: QueryExecutor, userId: string, storageKeys: string[]) {
    let removed = 0;
    const assets = await client.query<{ id: string; conversation_id: string; source_run_id?: string }>(
        `DELETE FROM creative_assets
         WHERE user_id = $1
           AND (storage_key = ANY($2::text[]) OR ${matchesJsonColumns("creative_assets", ["server_url", "remote_url", "metadata"])})
         RETURNING id, conversation_id, source_run_id`,
        [userId, storageKeys],
    );
    removed += assets.rowCount || assets.rows.length;
    const assetIds = assets.rows.map((row) => row.id).filter(Boolean);
    const conversationIds = Array.from(new Set(assets.rows.map((row) => row.conversation_id).filter(Boolean)));
    const runIds = Array.from(new Set(assets.rows.map((row) => row.source_run_id).filter((value): value is string => Boolean(value))));

    const messages = await client.query<{ id: string; content: string; metadata: unknown }>(
        `SELECT message.id, message.content, message.metadata
         FROM creative_messages message
         JOIN creative_conversations conversation ON conversation.id = message.conversation_id
         WHERE conversation.user_id = $1
           AND (
               message.conversation_id = ANY($3::text[])
               OR ${matchesJsonColumns("message", ["content", "metadata"])}
           )
         FOR UPDATE OF message`,
        [userId, storageKeys, conversationIds],
    );
    for (const message of messages.rows) {
        const cleaned = cleanUserMediaReferences({ content: message.content, metadata: message.metadata }, storageKeys, assetIds);
        if (!cleaned.changed) continue;
        await client.query("UPDATE creative_messages SET content = $2, metadata = $3::jsonb, updated_at = now() WHERE id = $1", [message.id, String(cleaned.value.content || ""), JSON.stringify(cleaned.value.metadata || {})]);
        removed += 1;
    }

    const events = await client.query<{ id: string | number; data: unknown }>(
        `SELECT event.id, event.data FROM creative_run_events event
         WHERE (
             event.run_id = ANY($3::text[])
             OR EXISTS (
                 SELECT 1 FROM generation_tasks task
                 WHERE task.user_id = $1 AND (task.id = event.run_id OR task.run_id = event.run_id)
             )
         )
           AND ${matchesJsonColumns("event", ["data"])}
         FOR UPDATE OF event`,
        [userId, storageKeys, runIds],
    );
    for (const event of events.rows) {
        const cleaned = cleanUserMediaReferences(event.data, storageKeys, assetIds);
        if (!cleaned.changed) continue;
        await client.query("UPDATE creative_run_events SET data = $2::jsonb WHERE id = $1", [event.id, JSON.stringify(cleaned.value ?? null)]);
        removed += 1;
    }

    removed += await deleteMatchingRows(client, "library_assets", "user_id = $1", matchesJsonColumns("library_assets", ["asset_json"]), userId, storageKeys);
    removed += await cleanPostgresCanvasProjects(client, userId, storageKeys);
    removed += await cleanPostgresJsonProjects(client, "drama_projects", "project_json", userId, storageKeys);
    removed += await cleanPostgresJsonProjects(client, "drama_project_versions", "snapshot", userId, storageKeys);

    const logAssets = await client.query<{ generation_log_id: string }>(
        `DELETE FROM generation_log_assets asset
         USING generation_logs log
         WHERE asset.generation_log_id = log.id
           AND log.user_id = $1
           AND ${matchesJsonColumns("asset", ["url", "server_url", "remote_url"])}
         RETURNING asset.generation_log_id`,
        [userId, storageKeys],
    );
    removed += logAssets.rowCount || logAssets.rows.length;
    const logIds = Array.from(new Set(logAssets.rows.map((row) => row.generation_log_id).filter(Boolean)));
    const logs = await client.query<{ id: string; request_snapshot: unknown }>(
        `SELECT id, request_snapshot FROM generation_logs
         WHERE user_id = $1
           AND (id = ANY($3::text[]) OR ${matchesJsonColumns("generation_logs", ["request_snapshot"])})
         FOR UPDATE`,
        [userId, storageKeys, logIds],
    );
    for (const log of logs.rows) {
        const cleaned = cleanUserMediaReferences(log.request_snapshot, storageKeys, assetIds);
        if (!cleaned.changed && !logIds.includes(log.id)) continue;
        await client.query("UPDATE generation_logs SET request_snapshot = $2::jsonb, updated_at = now() WHERE id = $1 AND user_id = $3", [log.id, JSON.stringify(cleaned.value || {}), userId]);
        removed += 1;
    }

    const tasks = await client.query<{ id: string; status: string; execution_phase: string; payload: unknown; result_payload: unknown }>(
        `SELECT id, status, execution_phase, payload, result_payload FROM generation_tasks
         WHERE user_id = $1
           AND ${matchesJsonColumns("generation_tasks", ["payload", "result_payload"])}
         FOR UPDATE`,
        [userId, storageKeys],
    );
    for (const task of tasks.rows) {
        const inputDeleted = containsUserMediaReference(task.payload, storageKeys);
        const payload = cleanUserMediaReferences(task.payload, storageKeys, assetIds);
        const resultPayload = cleanUserMediaReferences(task.result_payload, storageKeys, assetIds);
        const cancel = inputDeleted && (task.status === "pending" || task.status === "running");
        await client.query(
            `UPDATE generation_tasks SET payload = $2::jsonb, result_payload = $3::jsonb,
                status = CASE WHEN $4::boolean THEN 'cancelled' ELSE status END,
                execution_phase = CASE WHEN $4::boolean THEN 'completed' ELSE execution_phase END,
                next_poll_at = CASE WHEN $4::boolean THEN NULL ELSE next_poll_at END,
                lease_until = CASE WHEN $4::boolean THEN NULL ELSE lease_until END,
                updated_at = now()
             WHERE id = $1 AND user_id = $5`,
            [task.id, JSON.stringify(payload.value || {}), resultPayload.value === undefined ? null : JSON.stringify(resultPayload.value), cancel, userId],
        );
        removed += 1;
    }

    const publishedAssets = await client.query<{ version_id: string }>(
        `DELETE FROM published_work_assets asset
         USING published_work_versions version, published_works work
         WHERE asset.version_id = version.id AND version.work_id = work.id
           AND work.owner_user_id = $1 AND asset.storage_key = ANY($2::text[])
         RETURNING asset.version_id`,
        [userId, storageKeys],
    );
    removed += publishedAssets.rowCount || publishedAssets.rows.length;
    const versionIds = Array.from(new Set(publishedAssets.rows.map((row) => row.version_id).filter(Boolean)));
    if (versionIds.length) {
        const hidden = await client.query(
            `UPDATE published_works work SET published_version_id = NULL, is_featured = false, featured_at = NULL, featured_by_user_id = NULL
             WHERE owner_user_id = $1 AND published_version_id = ANY($2::text[])
               AND NOT EXISTS (SELECT 1 FROM published_work_assets asset WHERE asset.version_id = work.published_version_id AND asset.role = 'content')`,
            [userId, versionIds],
        );
        removed += hidden.rowCount || 0;
    }
    const avatars = await client.query("UPDATE users SET avatar_storage_key = NULL, updated_at = now() WHERE id = $1 AND avatar_storage_key = ANY($2::text[])", [userId, storageKeys]);
    removed += avatars.rowCount || 0;
    return removed;
}

async function cleanPostgresCanvasProjects(client: QueryExecutor, userId: string, storageKeys: string[]) {
    const result = await client.query<{ id: string; project_json: CanvasProject }>(
        `SELECT id, project_json FROM canvas_projects
         WHERE user_id = $1 AND ${matchesJsonColumns("canvas_projects", ["project_json"])}
         FOR UPDATE`,
        [userId, storageKeys],
    );
    let changed = 0;
    for (const row of result.rows) {
        const cleaned = cleanCanvasProjectMediaReferences(row.project_json, storageKeys);
        if (!cleaned.changed) continue;
        const project = withUpdatedAt(cleaned.value);
        await client.query("UPDATE canvas_projects SET project_json = $3::jsonb, updated_at = $4 WHERE user_id = $1 AND id = $2", [userId, row.id, JSON.stringify(project), new Date(project.updatedAt)]);
        changed += 1;
    }
    return changed;
}

async function cleanPostgresJsonProjects(client: QueryExecutor, table: "drama_projects" | "drama_project_versions", column: "project_json" | "snapshot", userId: string, storageKeys: string[]) {
    const result = await client.query<{ id: string; value: Record<string, unknown> }>(
        `SELECT id, ${column} AS value FROM ${table}
         WHERE user_id = $1 AND ${matchesJsonColumns(table, [column])}
         FOR UPDATE`,
        [userId, storageKeys],
    );
    let changed = 0;
    for (const row of result.rows) {
        const cleaned = cleanUserMediaReferences(row.value, storageKeys);
        if (!cleaned.changed) continue;
        const value = table === "drama_projects" ? withUpdatedAt(cleaned.value) : cleaned.value;
        await client.query(
            `UPDATE ${table} SET ${column} = $3::jsonb${table === "drama_projects" ? ", updated_at = $4" : ""} WHERE user_id = $1 AND id = $2`,
            table === "drama_projects" ? [userId, row.id, JSON.stringify(value), new Date(String(value.updatedAt))] : [userId, row.id, JSON.stringify(value)],
        );
        changed += 1;
    }
    return changed;
}

async function cleanFileReferences(userId: string, storageKeys: string[]) {
    return withJsonDataFileLocks([...FILES], async () => {
        const before = await readFileState();
        const registrations = before.media.assets.filter((item) => item.ownerUserId === userId && storageKeys.includes(item.storageKey));
        const keys = registrations.map((item) => item.storageKey);
        if (!keys.length) return { registrations, removedReferences: 0 };
        const next = cleanFileState(before, userId, keys);
        try {
            await writeFileState(next.state);
        } catch (error) {
            await Promise.allSettled(Object.entries(fileStateEntries(before)).map(([name, value]) => writeJsonDataFile(name, value)));
            throw error;
        }
        return { registrations, removedReferences: next.removedReferences };
    });
}

function cleanFileState(state: Awaited<ReturnType<typeof readFileState>>, userId: string, storageKeys: string[]) {
    let removedReferences = 0;
    const conversationIds = new Set(state.runtime.conversations.filter((conversation) => conversation.userId === userId).map((conversation) => conversation.id));
    const userTasks = state.tasks.filter((task) => task.userId === userId);
    const removedAssets = state.runtime.assets.filter((asset) => asset.userId === userId && containsUserMediaReference(asset, storageKeys));
    const assetIds = removedAssets.map((asset) => asset.id);
    const runIds = new Set([...userTasks.flatMap((task) => [task.id, task.runId]), ...removedAssets.map((asset) => asset.sourceRunId)].filter((value): value is string => typeof value === "string" && Boolean(value)));
    removedReferences += removedAssets.length;
    const runtime = {
        ...state.runtime,
        assets: state.runtime.assets.filter((asset) => asset.userId !== userId || !containsUserMediaReference(asset, storageKeys)),
        messages: state.runtime.messages.map((message) => (conversationIds.has(message.conversationId) ? cleanCounted(message, storageKeys, assetIds) : message)),
        events: state.runtime.events.map((event) => (runIds.has(event.runId) ? cleanCounted(event, storageKeys, assetIds) : event)),
    };
    removedReferences += state.library.assets.filter((asset) => ownedBy(asset, userId) && containsUserMediaReference(asset, storageKeys)).length;
    const library = { ...state.library, assets: state.library.assets.filter((asset) => !ownedBy(asset, userId) || !containsUserMediaReference(asset, storageKeys)) };
    const canvas = {
        ...state.canvas,
        projects: state.canvas.projects.map((record) => {
            if (record.userId !== userId) return record;
            const cleaned = cleanCanvasProjectMediaReferences(record.project, storageKeys);
            if (!cleaned.changed) return record;
            removedReferences += 1;
            return { ...record, project: withUpdatedAt(cleaned.value) };
        }),
    };
    const drama = {
        ...state.drama,
        projects: state.drama.projects.map((record) => {
            if (record.userId !== userId) return record;
            const cleaned = cleanUserMediaReferences(record.project, storageKeys, assetIds);
            if (!cleaned.changed) return record;
            removedReferences += 1;
            return { ...record, project: withUpdatedAt(cleaned.value) };
        }),
    };
    const logs = { ...state.logs, logs: state.logs.logs.map((log) => (log.userId === userId ? cleanCounted(log, storageKeys, assetIds) : log)) };
    const tasks = state.tasks.map((task) => {
        if (task.userId !== userId) return task;
        const inputDeleted = containsUserMediaReference(task.payload, storageKeys);
        const cleaned = cleanUserMediaReferences(task, storageKeys, assetIds);
        if (!cleaned.changed) return task;
        removedReferences += 1;
        return inputDeleted && (task.status === "pending" || task.status === "running") ? { ...cleaned.value, status: "cancelled" as const, executionPhase: "completed" as const, nextPollAt: undefined, leaseUntil: undefined } : cleaned.value;
    });
    const users = Array.isArray(state.auth.users)
        ? state.auth.users.map((user) => {
              if (!ownedBy(user, userId)) return user;
              const cleaned = cleanUserMediaReferences(user, storageKeys, assetIds);
              if (cleaned.changed) removedReferences += 1;
              return cleaned.value;
          })
        : state.auth.users;
    return { state: { ...state, runtime, library, canvas, drama, logs, tasks, auth: { ...state.auth, users } }, removedReferences };

    function cleanCounted<T>(value: T, keys: string[], ids: string[]) {
        const cleaned = cleanUserMediaReferences(value, keys, ids);
        if (cleaned.changed) removedReferences += 1;
        return cleaned.value;
    }
}

function ownedBy(value: unknown, userId: string) {
    return Boolean(value && typeof value === "object" && "userId" in value && (value as { userId?: unknown }).userId === userId) || Boolean(value && typeof value === "object" && "id" in value && (value as { id?: unknown }).id === userId);
}

async function readFileState() {
    const [auth, canvas, runtime, drama, logs, tasks, library, media] = await Promise.all([
        readJsonDataFile<Record<string, unknown>>("auth.json", {}),
        readJsonDataFile<CanvasProjectFile>("canvas-projects.json", { version: 1, projects: [] }),
        readJsonDataFile<RuntimeFileDatabase>("creative-runtime.json", { version: 1, nextEventId: 1, conversations: [], messages: [], assets: [], events: [] }),
        readJsonDataFile<ProjectFile>("drama-projects.json", { version: 1, projects: [] }),
        readJsonDataFile<GenerationLogDatabase>("generation-logs.json", { version: 1, logs: [] }),
        readJsonDataFile<StoredGenerationTaskRecord[]>("generation-tasks.json", []),
        readJsonDataFile<LibraryAssetFile>("library-assets.json", { version: 1, assets: [] }),
        readJsonDataFile<LocalMediaFile>("local-media-assets.json", { version: 1, assets: [] }),
    ]);
    return { auth, canvas, runtime, drama, logs, tasks, library, media };
}

async function writeFileState(state: Awaited<ReturnType<typeof readFileState>>) {
    for (const [name, value] of Object.entries(fileStateEntries(state))) await writeJsonDataFile(name, value);
}

function fileStateEntries(state: Awaited<ReturnType<typeof readFileState>>) {
    return {
        "auth.json": state.auth,
        "canvas-projects.json": state.canvas,
        "creative-runtime.json": state.runtime,
        "drama-projects.json": state.drama,
        "generation-logs.json": state.logs,
        "generation-tasks.json": state.tasks,
        "library-assets.json": state.library,
    };
}

async function deleteMatchingRows(client: QueryExecutor, table: "library_assets", ownerCondition: string, referenceCondition: string, userId: string, storageKeys: string[]) {
    const result = await client.query(`DELETE FROM ${table} WHERE ${ownerCondition} AND ${referenceCondition}`, [userId, storageKeys]);
    return result.rowCount || 0;
}

function matchesJsonColumns(alias: string, columns: string[], keyParameter = 2) {
    return `EXISTS (
        SELECT 1 FROM unnest($${keyParameter}::text[]) AS requested(storage_key)
        WHERE ${columns.map((column) => `position(requested.storage_key in COALESCE(${alias}.${column}::text, '')) > 0`).join(" OR ")}
    )`;
}

function withUpdatedAt<T extends Record<string, unknown>>(value: T): T & { updatedAt: string } {
    const previous = Date.parse(String(value.updatedAt || ""));
    return { ...value, updatedAt: new Date(Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0)).toISOString() };
}

function normalizeKeys(values: string[]) {
    return Array.from(new Set(values.map((value) => value.trim().replace(/\\/g, "/").replace(/^\/+/, "")).filter(Boolean)));
}

function emptyResult() {
    return { deletedFiles: 0, deletedBytes: 0, blocked: [] as Array<{ id: string; storageKey: string; referenceCount: number }>, removedReferences: 0 };
}
