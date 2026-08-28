import { nanoid } from "nanoid";

import type { CanvasProject } from "@/lib/canvas-project-contract";
import type { DramaProject } from "@/lib/drama-project-contract";
import { readJsonDataFile, withJsonDataFileLocks, writeJsonDataFile } from "@/lib/server/data-adapter";
import { ensurePostgresSchema, getDatabaseProvider, withPostgresTransaction, type QueryExecutor } from "@/lib/server/database";
import type { RuntimeFileDatabase } from "@/lib/server/creative-runtime-repository";
import type { GenerationLogDatabase } from "@/lib/server/generation-log-types";
import type { StoredGenerationTaskRecord } from "@/lib/server/generation-task-store";
import { collectLocalMediaStorageKeys } from "@/lib/server/local-media-references";
import { notifyVozebCmsTaskEvents } from "@/lib/server/vozeb-cms/task-event-signal";

const FILES = ["canvas-projects.json", "drama-projects.json", "creative-runtime.json", "generation-logs.json", "generation-tasks.json", "local-media-assets.json"] as const;

type CanvasProjectFile = { version: 1; projects: Array<{ userId: string; project: CanvasProject }> };
type DramaProjectFile = { version: 1; projects: Array<{ userId: string; project: DramaProject }> };
type LocalMediaFile = { version: 1; assets: Array<{ ownerUserId: string; storageKey: string; conversationId?: string; projectId?: string; taskId?: string }> };
type DeletionScope = { conversationIds: string[]; projectIds: string[]; assistantProjectId?: string; dramaProjectId?: string; replacementConversationId?: string };

export class CreativeEntityDeletionConflict extends Error {}

export type CreativeEntityDeletionResult = {
    deletedConversations: number;
    deletedProjects: number;
    mediaStorageKeys: string[];
    canvasAssistantState?: Pick<CanvasProject, "chatSessions" | "activeChatId">;
    dramaProject?: DramaProject;
};

export function deleteCreativeConversationAggregates(userId: string, conversationIds: string[]) {
    return deleteCreativeEntities(userId, { conversationIds: normalizeIds(conversationIds), projectIds: [] });
}

export function deleteCanvasAssistantConversationAggregates(userId: string, projectId: string, conversationIds: string[]) {
    return deleteCreativeEntities(userId, { conversationIds: normalizeIds(conversationIds), projectIds: [], assistantProjectId: projectId.trim() });
}

export function deleteDramaConversationAggregate(userId: string, projectId: string, conversationId: string, replacementConversationId?: string) {
    return deleteCreativeEntities(userId, {
        conversationIds: normalizeIds([conversationId]),
        projectIds: [],
        dramaProjectId: projectId.trim(),
        replacementConversationId: replacementConversationId?.trim(),
    });
}

export function deleteCanvasProjectAggregates(userId: string, projectIds: string[]) {
    return deleteCreativeEntities(userId, { conversationIds: [], projectIds: normalizeIds(projectIds) });
}

async function deleteCreativeEntities(userId: string, scope: DeletionScope): Promise<CreativeEntityDeletionResult> {
    const ownerUserId = userId.trim();
    if (!ownerUserId || (!scope.conversationIds.length && !scope.projectIds.length)) return emptyResult();
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        return withPostgresTransaction((client) => deletePostgresEntities(client, ownerUserId, scope));
    }
    return deleteFileEntities(ownerUserId, scope);
}

async function deletePostgresEntities(client: QueryExecutor, userId: string, scope: DeletionScope): Promise<CreativeEntityDeletionResult> {
    const projectResult = await client.query<Record<string, unknown>>(
        `SELECT id, project_json FROM canvas_projects
         WHERE user_id = $1 AND id = ANY($2::text[]) FOR UPDATE`,
        [userId, scope.projectIds],
    );
    const projectIds = projectResult.rows.map((row) => text(row.id)).filter(Boolean);
    const linkedConversationIds = projectResult.rows.flatMap((row) => collectProjectConversationIds(row.project_json));
    const assistantProjectResult = scope.assistantProjectId
        ? await client.query<{ project_json: CanvasProject }>(
              `SELECT project_json FROM canvas_projects
               WHERE user_id = $1 AND id = $2
               FOR UPDATE`,
              [userId, scope.assistantProjectId],
          )
        : { rows: [] };
    if (scope.assistantProjectId && !assistantProjectResult.rows[0]?.project_json) throw new CreativeEntityDeletionConflict("Agent 对话与当前画布不匹配");
    const dramaProjectResult = scope.dramaProjectId
        ? await client.query<{ project_json: DramaProject }>(
              `SELECT project_json FROM drama_projects
               WHERE user_id = $1 AND id = $2
               FOR UPDATE`,
              [userId, scope.dramaProjectId],
          )
        : { rows: [] };
    if (scope.dramaProjectId && !dramaProjectResult.rows[0]?.project_json) throw new CreativeEntityDeletionConflict("Agent 对话与当前短剧项目不匹配");
    const conversationResult = await client.query<Record<string, unknown>>(
        `SELECT id, surface, project_id FROM creative_conversations
         WHERE user_id = $1
           AND (
               id = ANY($2::text[])
               OR (surface = 'canvas' AND project_id = ANY($3::text[]))
               OR (surface = 'canvas' AND id = ANY($4::text[]))
           )
         FOR UPDATE`,
        [userId, normalizeIds([...scope.conversationIds, ...linkedConversationIds]), scope.projectIds, linkedConversationIds],
    );
    let canvasAssistantState: CreativeEntityDeletionResult["canvasAssistantState"];
    let dramaProject: DramaProject | undefined;
    if (scope.assistantProjectId) {
        const project = assistantProjectResult.rows[0].project_json;
        validateCanvasAssistantDeletion(project, scope.conversationIds, conversationResult.rows, scope.assistantProjectId);
        const update = removeCanvasAssistantConversations(project, scope.conversationIds);
        canvasAssistantState = update.state;
        if (update.changed) {
            await client.query("UPDATE canvas_projects SET project_json = $3::jsonb WHERE user_id = $1 AND id = $2", [userId, scope.assistantProjectId, JSON.stringify(update.project)]);
        }
    }
    if (scope.dramaProjectId) {
        const project = dramaProjectResult.rows[0].project_json;
        validateDramaConversationDeletion(project, scope.conversationIds, conversationResult.rows, scope.dramaProjectId);
        if (project.creativeConversationId && scope.conversationIds.includes(project.creativeConversationId)) {
            const replacementResult = await client.query<Record<string, unknown>>(
                `SELECT id, surface, project_id FROM creative_conversations
                 WHERE user_id = $1 AND id = $2
                 FOR UPDATE`,
                [userId, scope.replacementConversationId || ""],
            );
            validateDramaReplacementConversation(replacementResult.rows[0], scope.dramaProjectId);
            dramaProject = replaceDramaProjectConversation(project, scope.replacementConversationId!);
            await client.query("UPDATE drama_projects SET project_json = $3::jsonb, updated_at = $4 WHERE user_id = $1 AND id = $2", [userId, scope.dramaProjectId, JSON.stringify(dramaProject), new Date(dramaProject.updatedAt)]);
        }
    }
    const conversationIds = conversationResult.rows.map((row) => text(row.id)).filter(Boolean);
    if (!conversationIds.length && !projectIds.length) return { ...emptyResult(), ...(canvasAssistantState ? { canvasAssistantState } : {}) };

    const messageRunResult = await client.query<{ run_id: string }>(
        `SELECT DISTINCT run_id FROM creative_messages
         WHERE conversation_id = ANY($1::text[]) AND run_id IS NOT NULL`,
        [conversationIds],
    );
    const messageRunIds = messageRunResult.rows.map((row) => text(row.run_id)).filter(Boolean);
    const taskRows = await selectPostgresTasks(client, userId, conversationIds, projectIds, messageRunIds);
    const taskIds = taskRows.map((row) => text(row.id)).filter(Boolean);
    const logResult = await client.query<Record<string, unknown>>(
        `SELECT id, request_snapshot FROM generation_logs
         WHERE user_id = $1
           AND (conversation_id = ANY($2::text[]) OR task_id = ANY($3::text[]))
         FOR UPDATE`,
        [userId, conversationIds, taskIds],
    );
    const logIds = logResult.rows.map((row) => text(row.id)).filter(Boolean);
    const assetResult = await client.query<Record<string, unknown>>(
        `SELECT storage_key, server_url, remote_url, metadata FROM creative_assets
         WHERE user_id = $1 AND conversation_id = ANY($2::text[])
         FOR UPDATE`,
        [userId, conversationIds],
    );
    const logAssetResult = await client.query<Record<string, unknown>>(
        `SELECT url, remote_url, server_url FROM generation_log_assets
         WHERE generation_log_id = ANY($1::text[])
         FOR UPDATE`,
        [logIds],
    );
    const mediaRegistrationResult = await client.query<Record<string, unknown>>(
        `SELECT storage_key FROM local_media_assets
         WHERE owner_user_id = $1
           AND (conversation_id = ANY($2::text[]) OR project_id = ANY($3::text[]) OR task_id = ANY($4::text[]))
         FOR UPDATE`,
        [userId, conversationIds, projectIds, taskIds],
    );
    const mediaStorageKeys = collectDeletionMediaKeys([...projectResult.rows, ...taskRows, ...logResult.rows, ...assetResult.rows, ...logAssetResult.rows, ...mediaRegistrationResult.rows]);
    const runIds = normalizeIds([...messageRunIds, ...taskRows.flatMap((row) => [text(row.id), text(row.run_id)])]);

    if (runIds.length) await client.query("DELETE FROM creative_run_events WHERE run_id = ANY($1::text[])", [runIds]);
    if (logIds.length) await client.query("DELETE FROM generation_logs WHERE user_id = $1 AND id = ANY($2::text[])", [userId, logIds]);
    if (taskIds.length) await client.query("DELETE FROM generation_tasks WHERE user_id = $1 AND id = ANY($2::text[])", [userId, taskIds]);
    if (conversationIds.length) await client.query("DELETE FROM creative_conversations WHERE user_id = $1 AND id = ANY($2::text[])", [userId, conversationIds]);
    if (projectIds.length) await client.query("DELETE FROM canvas_projects WHERE user_id = $1 AND id = ANY($2::text[])", [userId, projectIds]);

    return { deletedConversations: conversationIds.length, deletedProjects: projectIds.length, mediaStorageKeys, ...(canvasAssistantState ? { canvasAssistantState } : {}), ...(dramaProject ? { dramaProject } : {}) };
}

async function selectPostgresTasks(client: QueryExecutor, userId: string, conversationIds: string[], projectIds: string[], rootRunIds: string[]) {
    const rows: Record<string, unknown>[] = [];
    const ids = new Set<string>();
    let parentIds: string[] = [];
    do {
        const result = parentIds.length
            ? await client.query<Record<string, unknown>>(
                  `SELECT id, run_id, parent_task_id, payload, result_payload FROM generation_tasks
                   WHERE user_id = $1 AND (parent_task_id = ANY($2::text[]) OR run_id = ANY($2::text[]))
                   FOR UPDATE`,
                  [userId, parentIds],
              )
            : await client.query<Record<string, unknown>>(
                  `SELECT id, run_id, parent_task_id, payload, result_payload FROM generation_tasks
                   WHERE user_id = $1
                     AND (conversation_id = ANY($2::text[]) OR project_id = ANY($3::text[]) OR id = ANY($4::text[]) OR run_id = ANY($4::text[]))
                   FOR UPDATE`,
                  [userId, conversationIds, projectIds, rootRunIds],
              );
        parentIds = result.rows.map((row) => text(row.id)).filter((id) => id && !ids.has(id));
        for (const row of result.rows) {
            const id = text(row.id);
            if (!id || ids.has(id)) continue;
            ids.add(id);
            rows.push(row);
        }
    } while (parentIds.length);
    return rows;
}

async function deleteFileEntities(userId: string, scope: DeletionScope): Promise<CreativeEntityDeletionResult> {
    return withJsonDataFileLocks([...FILES], async () => {
        const before = await readDeletionFiles();
        const projects = before.canvas.projects.filter((record) => record.userId === userId && scope.projectIds.includes(record.project.id));
        const projectIds = projects.map((record) => record.project.id);
        const linkedConversationIds = projects.flatMap((record) => collectProjectConversationIds(record.project));
        const requestedConversationIds = new Set([...scope.conversationIds, ...linkedConversationIds]);
        const assistantProjectRecord = scope.assistantProjectId ? before.canvas.projects.find((record) => record.userId === userId && record.project.id === scope.assistantProjectId) : undefined;
        if (scope.assistantProjectId && !assistantProjectRecord) throw new CreativeEntityDeletionConflict("Agent 对话与当前画布不匹配");
        let assistantProjectUpdate: ReturnType<typeof removeCanvasAssistantConversations> | undefined;
        if (assistantProjectRecord && scope.assistantProjectId) {
            const requestedRows = before.runtime.conversations.filter((conversation) => conversation.userId === userId && requestedConversationIds.has(conversation.id));
            validateCanvasAssistantDeletion(assistantProjectRecord.project, scope.conversationIds, requestedRows, scope.assistantProjectId);
            assistantProjectUpdate = removeCanvasAssistantConversations(assistantProjectRecord.project, scope.conversationIds);
        }
        const dramaProjectRecord = scope.dramaProjectId ? before.drama.projects.find((record) => record.userId === userId && record.project.id === scope.dramaProjectId) : undefined;
        if (scope.dramaProjectId && !dramaProjectRecord) throw new CreativeEntityDeletionConflict("Agent 对话与当前短剧项目不匹配");
        let dramaProjectUpdate: DramaProject | undefined;
        if (dramaProjectRecord && scope.dramaProjectId) {
            const requestedRows = before.runtime.conversations.filter((conversation) => conversation.userId === userId && requestedConversationIds.has(conversation.id));
            validateDramaConversationDeletion(dramaProjectRecord.project, scope.conversationIds, requestedRows, scope.dramaProjectId);
            if (dramaProjectRecord.project.creativeConversationId && scope.conversationIds.includes(dramaProjectRecord.project.creativeConversationId)) {
                const replacement = before.runtime.conversations.find((conversation) => conversation.userId === userId && conversation.id === scope.replacementConversationId);
                validateDramaReplacementConversation(replacement, scope.dramaProjectId);
                dramaProjectUpdate = replaceDramaProjectConversation(dramaProjectRecord.project, scope.replacementConversationId!);
            }
        }
        const conversations = before.runtime.conversations.filter(
            (conversation) =>
                conversation.userId === userId &&
                (requestedConversationIds.has(conversation.id) || (conversation.surface === "canvas" && (linkedConversationIds.includes(conversation.id) || (Boolean(conversation.projectId) && scope.projectIds.includes(conversation.projectId!))))),
        );
        const conversationIds = new Set(conversations.map((conversation) => conversation.id));
        if (!conversationIds.size && !projectIds.length && !assistantProjectUpdate?.changed) return { ...emptyResult(), ...(assistantProjectUpdate ? { canvasAssistantState: assistantProjectUpdate.state } : {}) };

        const messageRunIds = new Set(before.runtime.messages.filter((message) => conversationIds.has(message.conversationId) && message.runId).map((message) => message.runId!));
        const tasks = selectFileTasks(before.tasks, userId, conversationIds, new Set(projectIds), messageRunIds);
        const taskIds = new Set(tasks.map((task) => task.id));
        const logs = before.logs.logs.filter((log) => log.userId === userId && ((Boolean(log.conversationId) && conversationIds.has(log.conversationId!)) || (Boolean(log.taskId) && taskIds.has(log.taskId!))));
        const logIds = new Set(logs.map((log) => log.id));
        const deletedAssets = before.runtime.assets.filter((asset) => asset.userId === userId && conversationIds.has(asset.conversationId));
        const runIds = new Set([...messageRunIds, ...tasks.flatMap((task) => [task.id, task.runId || ""]).filter(Boolean)]);
        const mediaRegistrations = before.media.assets.filter(
            (asset) => asset.ownerUserId === userId && ((asset.conversationId && conversationIds.has(asset.conversationId)) || (asset.projectId && projectIds.includes(asset.projectId)) || (asset.taskId && taskIds.has(asset.taskId))),
        );
        const mediaStorageKeys = collectDeletionMediaKeys([...projects, ...deletedAssets, ...logs, ...tasks, ...mediaRegistrations]);

        const next = {
            runtime: {
                ...before.runtime,
                conversations: before.runtime.conversations.filter((conversation) => !conversationIds.has(conversation.id)),
                messages: before.runtime.messages.filter((message) => !conversationIds.has(message.conversationId)),
                assets: before.runtime.assets.filter((asset) => !conversationIds.has(asset.conversationId)),
                events: before.runtime.events.filter((event) => !runIds.has(event.runId)),
            },
            logs: { ...before.logs, logs: before.logs.logs.filter((log) => !logIds.has(log.id)) },
            tasks: before.tasks.filter((task) => !taskIds.has(task.id)),
            canvas: {
                ...before.canvas,
                projects: before.canvas.projects
                    .filter((record) => !(record.userId === userId && projectIds.includes(record.project.id)))
                    .map((record) => (assistantProjectUpdate && record.userId === userId && record.project.id === scope.assistantProjectId ? { ...record, project: assistantProjectUpdate.project } : record)),
            },
            drama: {
                ...before.drama,
                projects: before.drama.projects.map((record) => (dramaProjectUpdate && record.userId === userId && record.project.id === scope.dramaProjectId ? { ...record, project: dramaProjectUpdate } : record)),
            },
            media: before.media,
        };
        try {
            await writeDeletionFiles(next);
            notifyVozebCmsTaskEvents(taskIds);
        } catch (error) {
            await Promise.allSettled([
                writeJsonDataFile("creative-runtime.json", before.runtime),
                writeJsonDataFile("generation-tasks.json", before.tasks),
                writeJsonDataFile("generation-logs.json", before.logs),
                writeJsonDataFile("canvas-projects.json", before.canvas),
                writeJsonDataFile("drama-projects.json", before.drama),
            ]);
            throw error;
        }
        return {
            deletedConversations: conversationIds.size,
            deletedProjects: projectIds.length,
            mediaStorageKeys,
            ...(assistantProjectUpdate ? { canvasAssistantState: assistantProjectUpdate.state } : {}),
            ...(dramaProjectUpdate ? { dramaProject: dramaProjectUpdate } : {}),
        };
    });
}

function validateCanvasAssistantDeletion(project: CanvasProject, requestedIds: string[], conversationRows: Array<Record<string, unknown>>, projectId: string) {
    const requested = new Set(requestedIds);
    if (project.creativeConversationId && requested.has(project.creativeConversationId)) throw new CreativeEntityDeletionConflict("Agent 对话与当前画布不匹配");
    const linked = new Set((Array.isArray(project.chatSessions) ? project.chatSessions : []).map((session) => session.conversationId).filter((id): id is string => Boolean(id)));
    for (const row of conversationRows) {
        const id = text(row.id);
        if (requested.has(id) && (row.surface !== "canvas" || text(row.projectId ?? row.project_id) !== projectId || !linked.has(id))) {
            throw new CreativeEntityDeletionConflict("Agent 对话与当前画布不匹配");
        }
    }
}

function validateDramaConversationDeletion(project: DramaProject, requestedIds: string[], conversationRows: Array<Record<string, unknown>>, projectId: string) {
    const requested = new Set(requestedIds);
    const matched = new Set<string>();
    for (const row of conversationRows) {
        const id = text(row.id);
        if (!requested.has(id)) continue;
        if (row.surface !== "drama" || text(row.projectId ?? row.project_id) !== projectId) throw new CreativeEntityDeletionConflict("Agent 对话与当前短剧项目不匹配");
        matched.add(id);
    }
    if (matched.size !== requested.size || project.id !== projectId) throw new CreativeEntityDeletionConflict("Agent 对话与当前短剧项目不匹配");
}

function validateDramaReplacementConversation(row: Record<string, unknown> | undefined, projectId: string) {
    if (!row || row.surface !== "drama" || text(row.projectId ?? row.project_id) !== projectId) throw new CreativeEntityDeletionConflict("替代对话与当前短剧项目不匹配");
}

function replaceDramaProjectConversation(project: DramaProject, conversationId: string): DramaProject {
    return { ...project, creativeConversationId: conversationId, updatedAt: new Date(Math.max(Date.now(), Date.parse(project.updatedAt) + 1)).toISOString() };
}

function removeCanvasAssistantConversations(project: CanvasProject, conversationIds: string[]) {
    const removed = new Set(conversationIds);
    const currentSessions = Array.isArray(project.chatSessions) ? project.chatSessions : [];
    let chatSessions = currentSessions.filter((session) => !session.conversationId || !removed.has(session.conversationId));
    const changed = chatSessions.length !== currentSessions.length;
    if (changed && !chatSessions.length) chatSessions = [emptyCanvasAssistantSession()];
    const activeChatId = project.activeChatId && chatSessions.some((session) => session.id === project.activeChatId) ? project.activeChatId : chatSessions[0]?.id || null;
    return {
        changed,
        project: changed ? { ...project, chatSessions, activeChatId } : project,
        state: { chatSessions, activeChatId },
    };
}

function emptyCanvasAssistantSession(): CanvasProject["chatSessions"][number] {
    const now = new Date().toISOString();
    return { id: nanoid(), title: "新对话", messages: [], createdAt: now, updatedAt: now };
}

function selectFileTasks(tasks: StoredGenerationTaskRecord[], userId: string, conversationIds: Set<string>, projectIds: Set<string>, rootRunIds: Set<string>) {
    const selected = new Set(
        tasks
            .filter(
                (task) => task.userId === userId && ((task.conversationId && conversationIds.has(task.conversationId)) || (task.projectId && projectIds.has(task.projectId)) || rootRunIds.has(task.id) || Boolean(task.runId && rootRunIds.has(task.runId))),
            )
            .map((task) => task.id),
    );
    let changed = true;
    while (changed) {
        changed = false;
        for (const task of tasks) {
            if (task.userId !== userId || selected.has(task.id) || (!task.parentTaskId && !task.runId)) continue;
            if ((task.parentTaskId && selected.has(task.parentTaskId)) || (task.runId && selected.has(task.runId))) {
                selected.add(task.id);
                changed = true;
            }
        }
    }
    return tasks.filter((task) => selected.has(task.id));
}

async function readDeletionFiles() {
    const [canvas, drama, runtime, logs, tasks, media] = await Promise.all([
        readJsonDataFile<CanvasProjectFile>("canvas-projects.json", { version: 1, projects: [] }),
        readJsonDataFile<DramaProjectFile>("drama-projects.json", { version: 1, projects: [] }),
        readJsonDataFile<RuntimeFileDatabase>("creative-runtime.json", { version: 1, nextEventId: 1, conversations: [], messages: [], assets: [], events: [] }),
        readJsonDataFile<GenerationLogDatabase>("generation-logs.json", { version: 1, logs: [] }),
        readJsonDataFile<StoredGenerationTaskRecord[]>("generation-tasks.json", []),
        readJsonDataFile<LocalMediaFile>("local-media-assets.json", { version: 1, assets: [] }),
    ]);
    return { canvas, drama, runtime, logs, tasks, media };
}

async function writeDeletionFiles(value: Awaited<ReturnType<typeof readDeletionFiles>>) {
    await writeJsonDataFile("creative-runtime.json", value.runtime);
    await writeJsonDataFile("generation-tasks.json", value.tasks);
    await writeJsonDataFile("generation-logs.json", value.logs);
    await writeJsonDataFile("canvas-projects.json", value.canvas);
    await writeJsonDataFile("drama-projects.json", value.drama);
}

function collectDeletionMediaKeys(values: unknown[]) {
    return Array.from(new Set(values.flatMap(collectLocalMediaStorageKeys))).sort();
}

function collectProjectConversationIds(value: unknown) {
    const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    return normalizeIds([text(source.creativeConversationId), text(source.creative_conversation_id)]);
}

function normalizeIds(values: string[]) {
    return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function text(value: unknown) {
    return typeof value === "string" ? value.trim() : value === null || value === undefined ? "" : String(value).trim();
}

function emptyResult(): CreativeEntityDeletionResult {
    return { deletedConversations: 0, deletedProjects: 0, mediaStorageKeys: [] };
}
