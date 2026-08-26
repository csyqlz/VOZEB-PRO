import { nanoid } from "nanoid";

import { creativeConversationSourceForSurface, normalizeCreativeConversationSource, type CreativeAsset, type CreativeConversation, type CreativeMessage, type CreativeRunEvent, type CreativeSurface } from "@/lib/creative-runtime-contract";
import { readJsonDataFile, withJsonDataFileLock, writeJsonDataFile } from "@/lib/server/data-adapter";
import { ensurePostgresSchema, withPostgresTransaction, type QueryExecutor } from "@/lib/server/database";
import type { StoredGenerationTaskRecord } from "@/lib/server/generation-task-store";

export type RuntimeFileDatabase = {
    version: 1;
    nextEventId: number;
    conversations: CreativeConversation[];
    messages: CreativeMessage[];
    assets: CreativeAsset[];
    events: CreativeRunEvent[];
};

export type AgentRunBase = {
    id: string;
    userId: string;
    conversationId: string;
    clientRequestId: string;
    surface: CreativeSurface;
    projectId?: string;
    inputMessageId: string;
    assistantMessageId: string;
    status: string;
    createdAt: number;
    updatedAt: number;
};

export type CreateRunBundleInput<T extends AgentRunBase> = {
    run: T;
    title: string;
    prompt: string;
    conversationId?: string;
    assetIds: string[];
    acknowledgement?: string;
    ttlMs: number;
};

export type RunMutation<T extends AgentRunBase> = {
    run: T;
    event?: { type: string; data?: unknown };
    assistant?: { status: CreativeMessage["status"]; content?: string; metadata?: Record<string, unknown> };
};

export type NewAsset = Omit<CreativeAsset, "id" | "createdAt" | "updatedAt" | "status" | "metadata"> & { id?: string; status?: CreativeAsset["status"]; metadata?: Record<string, unknown> };
export type NewConversationExchange = {
    userId: string;
    conversationId: string;
    userContent: string;
    assistantContent: string;
    runId?: string;
    userMetadata?: Record<string, unknown>;
    assistantMetadata?: Record<string, unknown>;
};
export type CreativeRunBundleResult<T extends AgentRunBase> = {
    run: T;
    created: boolean;
    conversation?: CreativeConversation;
    userMessage?: CreativeMessage;
    assistantMessage?: CreativeMessage;
};

const RUNTIME_FILE = "creative-runtime.json";
const CREATIVE_RUN_NOTIFY_CHANNEL = "vozeb_pro_run_events";
export const CREATIVE_CONVERSATION_CONTEXT_MESSAGE_LIMIT = 12;

export async function createPostgresRunBundle<T extends AgentRunBase>(userId: string, input: CreateRunBundleInput<T>) {
    await ensurePostgresSchema();
    return withPostgresTransaction(async (client) => {
        const existing = await client.query<{ payload: T }>("SELECT payload FROM generation_tasks WHERE user_id = $1 AND client_request_id = $2 AND task_type = 'agent'", [userId, input.run.clientRequestId]);
        if (existing.rows[0]) return { run: existing.rows[0].payload, created: false };
        let conversation = await resolvePostgresConversation(client, userId, input);
        if (input.conversationId) conversation = await rollPostgresConversationContext(client, conversation);
        await validatePostgresAssets(client, input.assetIds, userId);
        const sequenceResult = await client.query<{ sequence: number }>("SELECT COALESCE(MAX(sequence), 0)::int AS sequence FROM creative_messages WHERE conversation_id = $1", [conversation.id]);
        const sequence = Number(sequenceResult.rows[0]?.sequence || 0) + 1;
        const now = input.run.createdAt;
        const userMessage = message(input.run.inputMessageId, conversation.id, sequence, "user", "completed", input.prompt, input.run.id, { assetIds: input.assetIds }, now);
        const assistantMessage = message(input.run.assistantMessageId, conversation.id, sequence + 1, "assistant", "running", input.acknowledgement || "已收到你的需求。", input.run.id, {}, now);
        await insertPostgresMessage(client, userMessage);
        await insertPostgresMessage(client, assistantMessage);
        await client.query(
            `INSERT INTO generation_tasks (
                id, user_id, task_type, status, payload, created_at, updated_at, expires_at,
                conversation_id, run_id, surface, project_id, client_request_id,
                execution_phase, next_poll_at, last_upstream_status
             ) VALUES ($1, $2, 'agent', 'pending', $3::jsonb, $4, $4, $5, $6, $1, $7, $8, $9, 'created', $4, 'created')`,
            [input.run.id, userId, JSON.stringify(input.run), new Date(now), new Date(now + input.ttlMs), conversation.id, input.run.surface, input.run.projectId || null, input.run.clientRequestId],
        );
        const eventResult = await client.query("INSERT INTO creative_run_events (run_id, type, data, created_at) VALUES ($1, 'run.created', NULL, $2) RETURNING *", [input.run.id, new Date(now)]);
        await client.query(`SELECT pg_notify('${CREATIVE_RUN_NOTIFY_CHANNEL}', $1)`, [input.run.id]);
        const nextTitle = conversation.title === "新对话" ? input.title : conversation.title;
        const conversationResult = await client.query("UPDATE creative_conversations SET title = $2, updated_at = $3, last_message_at = $3 WHERE id = $1 RETURNING *", [conversation.id, nextTitle, new Date(now)]);
        return { run: input.run, conversation: mapConversation(conversationResult.rows[0]), userMessage, assistantMessage, event: mapEvent(eventResult.rows[0]), created: true };
    });
}

export async function mutatePostgresRun<T extends AgentRunBase>(id: string, ttlMs: number, mutate: (current: T) => RunMutation<T> | null, allowedStatuses?: string[], expectedExecutionId?: string) {
    await ensurePostgresSchema();
    return withPostgresTransaction(async (client) => {
        const result = await client.query<{ payload: T & { executionId?: string } }>("SELECT payload FROM generation_tasks WHERE id = $1 AND task_type = 'agent' AND expires_at > now() FOR UPDATE", [id]);
        const current = result.rows[0]?.payload;
        if (!current || (allowedStatuses && !allowedStatuses.includes(current.status)) || (expectedExecutionId && current.executionId !== expectedExecutionId)) return null;
        const mutation = mutate(current as T);
        if (!mutation) return null;
        const now = Date.now();
        const run = { ...mutation.run, id: current.id, userId: current.userId, createdAt: current.createdAt, updatedAt: now };
        await client.query("UPDATE generation_tasks SET status = $2, payload = $3::jsonb, updated_at = $4, expires_at = $5 WHERE id = $1", [id, normalizeTaskStatus(run.status), JSON.stringify(run), new Date(now), new Date(now + ttlMs)]);
        if (mutation.event) {
            await client.query("INSERT INTO creative_run_events (run_id, type, data, created_at) VALUES ($1, $2, $3::jsonb, $4)", [id, mutation.event.type, mutation.event.data === undefined ? null : JSON.stringify(mutation.event.data), new Date(now)]);
            await client.query(`SELECT pg_notify('${CREATIVE_RUN_NOTIFY_CHANNEL}', $1)`, [id]);
        }
        if (mutation.assistant) await updatePostgresAssistant(client, run.assistantMessageId, mutation.assistant, now);
        return run;
    });
}

export function resolveFileConversation<T extends AgentRunBase>(db: RuntimeFileDatabase, userId: string, input: CreateRunBundleInput<T>) {
    if (input.conversationId) {
        const conversation = db.conversations.find((item) => item.id === input.conversationId && item.userId === userId);
        if (!conversation) throw new CreativeStoreConflict("创作会话不存在", 404);
        validateConversationScope(conversation, input.run.surface, input.run.projectId);
        return conversation;
    }
    const now = input.run.createdAt;
    return {
        id: input.run.conversationId,
        userId,
        surface: input.run.surface,
        source: creativeConversationSourceForSurface(input.run.surface),
        projectId: input.run.projectId,
        title: "新对话",
        status: "active",
        contextSummary: "",
        contextSummaryThroughSequence: 0,
        createdAt: now,
        updatedAt: now,
        lastMessageAt: now,
    } satisfies CreativeConversation;
}

export async function resolvePostgresConversation<T extends AgentRunBase>(client: QueryExecutor, userId: string, input: CreateRunBundleInput<T>) {
    if (input.conversationId) {
        const result = await client.query("SELECT * FROM creative_conversations WHERE id = $1 AND user_id = $2 FOR UPDATE", [input.conversationId, userId]);
        if (!result.rows[0]) throw new CreativeStoreConflict("创作会话不存在", 404);
        const conversation = mapConversation(result.rows[0]);
        validateConversationScope(conversation, input.run.surface, input.run.projectId);
        return conversation;
    }
    const now = input.run.createdAt;
    const conversation: CreativeConversation = {
        id: input.run.conversationId,
        userId,
        surface: input.run.surface,
        source: creativeConversationSourceForSurface(input.run.surface),
        projectId: input.run.projectId,
        title: "新对话",
        status: "active",
        contextSummary: "",
        contextSummaryThroughSequence: 0,
        createdAt: now,
        updatedAt: now,
        lastMessageAt: now,
    };
    await client.query("INSERT INTO creative_conversations (id, user_id, surface, source, project_id, title, status, created_at, updated_at, last_message_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $8)", [
        conversation.id,
        userId,
        conversation.surface,
        conversation.source,
        conversation.projectId || null,
        conversation.title,
        conversation.status,
        new Date(now),
    ]);
    return conversation;
}

export function applyRuntimeMutation<T extends AgentRunBase>(db: RuntimeFileDatabase, run: T, mutation: RunMutation<T>, now: number) {
    let next = db;
    if (mutation.event) {
        const event = nextFileEvent(next, run.id, mutation.event.type, mutation.event.data, now);
        next = { ...next, events: [...next.events, event], nextEventId: Number(event.id) + 1 };
    }
    if (mutation.assistant) {
        next = {
            ...next,
            messages: next.messages.map((item) =>
                item.id === run.assistantMessageId
                    ? {
                          ...item,
                          status: mutation.assistant!.status,
                          ...(mutation.assistant!.content !== undefined ? { content: mutation.assistant!.content } : {}),
                          ...(mutation.assistant!.metadata ? { metadata: { ...item.metadata, ...mutation.assistant!.metadata } } : {}),
                          updatedAt: now,
                      }
                    : item,
            ),
        };
    }
    return next;
}

export async function updatePostgresAssistant(client: QueryExecutor, id: string, update: NonNullable<RunMutation<AgentRunBase>["assistant"]>, now: number) {
    await client.query(`UPDATE creative_messages SET status = $2, content = COALESCE($3, content), metadata = metadata || $4::jsonb, updated_at = $5 WHERE id = $1`, [
        id,
        update.status,
        update.content ?? null,
        JSON.stringify(update.metadata || {}),
        new Date(now),
    ]);
}

export async function validatePostgresAssets(client: QueryExecutor, ids: string[], userId: string) {
    if (!ids.length) return;
    const result = await client.query<{ id: string }>("SELECT id FROM creative_assets WHERE id = ANY($1::text[]) AND user_id = $2 AND status <> 'deleted'", [ids, userId]);
    if (result.rows.length !== ids.length) throw new CreativeStoreConflict("引用资产不存在或无权访问", 403);
}

export function validateAssetOwnership(assets: CreativeAsset[], ids: string[], userId: string) {
    if (!ids.length) return;
    const owned = new Set(assets.filter((item) => item.userId === userId && item.status !== "deleted").map((item) => item.id));
    if (ids.some((id) => !owned.has(id))) throw new CreativeStoreConflict("引用资产不存在或无权访问", 403);
}

export function validateConversationScope(conversation: CreativeConversation, surface: CreativeSurface, projectId?: string) {
    if (conversation.surface !== surface || conversation.source !== creativeConversationSourceForSurface(surface) || (conversation.projectId || "") !== (projectId || "")) throw new CreativeStoreConflict("会话的创作入口、来源或项目不匹配", 409);
    if (conversation.status !== "active") throw new CreativeStoreConflict("归档会话不能创建新任务", 409);
}

export async function insertPostgresMessage(client: QueryExecutor, item: CreativeMessage) {
    await client.query(
        `INSERT INTO creative_messages (id, conversation_id, sequence, role, status, content, run_id, metadata, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $9)`,
        [item.id, item.conversationId, item.sequence, item.role, item.status, item.content, item.runId || null, JSON.stringify(item.metadata), new Date(item.createdAt)],
    );
}

export async function upsertPostgresAsset(client: QueryExecutor, input: NewAsset) {
    const now = Date.now();
    const result = await client.query(
        `INSERT INTO creative_assets (
            id, user_id, conversation_id, message_id, source_run_id, source_task_id, parent_asset_id, ordinal, type, status, title,
            text_content, storage_kind, storage_key, remote_url, server_url, mime_type, width, height, duration_ms, bytes, metadata, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22::jsonb, $23, $23)
         ON CONFLICT (source_run_id, source_task_id, ordinal) DO UPDATE SET
            message_id = EXCLUDED.message_id, parent_asset_id = EXCLUDED.parent_asset_id, status = EXCLUDED.status, title = EXCLUDED.title,
            text_content = EXCLUDED.text_content, storage_kind = EXCLUDED.storage_kind, storage_key = EXCLUDED.storage_key,
            remote_url = EXCLUDED.remote_url, server_url = EXCLUDED.server_url, mime_type = EXCLUDED.mime_type,
            width = EXCLUDED.width, height = EXCLUDED.height, duration_ms = EXCLUDED.duration_ms, bytes = EXCLUDED.bytes,
            metadata = EXCLUDED.metadata, updated_at = EXCLUDED.updated_at RETURNING *`,
        [
            input.id || `asset-${nanoid()}`,
            input.userId,
            input.conversationId,
            input.messageId || null,
            input.sourceRunId || null,
            input.sourceTaskId || null,
            input.parentAssetId || null,
            input.ordinal,
            input.type,
            input.status || "ready",
            input.title,
            input.textContent || null,
            input.storageKind || null,
            input.storageKey || null,
            input.remoteUrl || null,
            input.serverUrl || null,
            input.mimeType || null,
            input.width || null,
            input.height || null,
            input.durationMs || null,
            input.bytes || null,
            JSON.stringify(input.metadata || {}),
            new Date(now),
        ],
    );
    return mapAsset(result.rows[0]);
}

export function taskRecord<T extends AgentRunBase>(run: T, ttlMs: number): StoredGenerationTaskRecord {
    return {
        id: run.id,
        userId: run.userId,
        type: "agent",
        status: normalizeTaskStatus(run.status),
        payload: run as unknown as Record<string, unknown>,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        expiresAt: run.updatedAt + ttlMs,
        conversationId: run.conversationId,
        runId: run.id,
        surface: run.surface,
        projectId: run.projectId,
        clientRequestId: run.clientRequestId,
        executionPhase: "created",
        nextPollAt: run.createdAt,
        lastUpstreamStatus: "created",
    };
}

export function message(id: string, conversationId: string, sequence: number, role: CreativeMessage["role"], status: CreativeMessage["status"], content: string, runId: string, metadata: Record<string, unknown>, now: number): CreativeMessage {
    return { id, conversationId, sequence, role, status, content, runId, metadata, createdAt: now, updatedAt: now };
}

export function nextFileEvent(db: RuntimeFileDatabase, runId: string, type: string, data: unknown, now: number): CreativeRunEvent {
    return { id: String(Math.max(1, db.nextEventId)), runId, type, ...(data === undefined ? {} : { data }), createdAt: now };
}

export function nextMessageSequence(messages: CreativeMessage[], conversationId: string) {
    return messages.reduce((max, item) => (item.conversationId === conversationId ? Math.max(max, item.sequence) : max), 0) + 1;
}

export function normalizeTaskStatus(status: string): StoredGenerationTaskRecord["status"] {
    if (["planning", "queued", "created", "pending"].includes(status)) return "pending";
    if (["processing", "in_progress", "running"].includes(status)) return "running";
    if (["completed", "succeeded", "success"].includes(status)) return "success";
    if (status === "paused") return "paused";
    if (status === "cancelled" || status === "canceled") return "cancelled";
    return "error";
}

export function mapConversation(row: Record<string, unknown>): CreativeConversation {
    return {
        id: dbText(row.id),
        userId: dbText(row.user_id),
        surface: row.surface === "canvas" || row.surface === "drama" ? row.surface : "chat",
        source: normalizeCreativeConversationSource(row.source) || creativeConversationSourceForSurface(row.surface === "canvas" || row.surface === "drama" ? row.surface : "chat"),
        projectId: dbOptionalText(row.project_id),
        title: dbText(row.title),
        status: row.status === "archived" ? "archived" : "active",
        contextSummary: dbText(row.context_summary),
        contextSummaryThroughSequence: Math.max(0, Number(row.context_summary_through_sequence) || 0),
        createdAt: dbTime(row.created_at),
        updatedAt: dbTime(row.updated_at),
        lastMessageAt: dbTime(row.last_message_at),
    };
}

export function mapMessage(row: Record<string, unknown>): CreativeMessage {
    return {
        id: dbText(row.id),
        conversationId: dbText(row.conversation_id),
        sequence: Number(row.sequence) || 0,
        role: row.role === "assistant" || row.role === "system" || row.role === "tool" ? row.role : "user",
        status: row.status === "running" || row.status === "failed" || row.status === "cancelled" ? row.status : "completed",
        content: dbText(row.content),
        runId: dbOptionalText(row.run_id),
        metadata: dbObject(row.metadata),
        createdAt: dbTime(row.created_at),
        updatedAt: dbTime(row.updated_at),
    };
}

export function mapAsset(row: Record<string, unknown>): CreativeAsset {
    const storageKind = row.storage_kind === "local" || row.storage_kind === "object" || row.storage_kind === "remote" ? row.storage_kind : undefined;
    return {
        id: dbText(row.id),
        userId: dbText(row.user_id),
        conversationId: dbText(row.conversation_id),
        messageId: dbOptionalText(row.message_id),
        sourceRunId: dbOptionalText(row.source_run_id),
        sourceTaskId: dbOptionalText(row.source_task_id),
        parentAssetId: dbOptionalText(row.parent_asset_id),
        ordinal: Number(row.ordinal) || 0,
        type: row.type === "image" || row.type === "video" || row.type === "audio" ? row.type : "text",
        status: row.status === "failed" || row.status === "deleted" ? row.status : "ready",
        title: dbText(row.title),
        textContent: dbOptionalText(row.text_content),
        storageKind,
        storageKey: dbOptionalText(row.storage_key),
        remoteUrl: dbOptionalText(row.remote_url),
        serverUrl: dbOptionalText(row.server_url),
        mimeType: dbOptionalText(row.mime_type),
        width: dbOptionalNumber(row.width),
        height: dbOptionalNumber(row.height),
        durationMs: dbOptionalNumber(row.duration_ms),
        bytes: dbOptionalNumber(row.bytes),
        metadata: dbObject(row.metadata),
        createdAt: dbTime(row.created_at),
        updatedAt: dbTime(row.updated_at),
    };
}

export function mapEvent(row: Record<string, unknown>): CreativeRunEvent {
    return { id: dbText(row.id), runId: dbText(row.run_id), type: dbText(row.type), ...(row.data === null || row.data === undefined ? {} : { data: row.data }), createdAt: dbTime(row.created_at) };
}

export function readRuntimeFile() {
    return readJsonDataFile<RuntimeFileDatabase>(RUNTIME_FILE, emptyRuntimeDb()).then(normalizeRuntimeDb);
}

export function writeRuntimeFile(db: RuntimeFileDatabase) {
    return writeJsonDataFile(RUNTIME_FILE, normalizeRuntimeDb(db));
}

let runtimeMutationQueue = Promise.resolve();
export function mutateRuntimeFile(mutator: (db: RuntimeFileDatabase) => RuntimeFileDatabase) {
    return queueRuntimeFileOperation(async () => writeRuntimeFile(mutator(await readRuntimeFile())));
}

export function queueRuntimeFileOperation<T>(operation: () => Promise<T>) {
    const run = runtimeMutationQueue.then(() => withJsonDataFileLock(RUNTIME_FILE, operation));
    runtimeMutationQueue = run.then(
        () => undefined,
        () => undefined,
    );
    return run;
}

export function normalizeRuntimeDb(value: RuntimeFileDatabase): RuntimeFileDatabase {
    return {
        version: 1,
        nextEventId: Math.max(1, Number(value?.nextEventId) || 1),
        conversations: Array.isArray(value?.conversations)
            ? value.conversations.map((item) => ({
                  ...item,
                  source: normalizeCreativeConversationSource(item.source) || creativeConversationSourceForSurface(item.surface),
                  contextSummary: typeof item.contextSummary === "string" ? item.contextSummary.trim() : "",
                  contextSummaryThroughSequence: Math.max(0, Number(item.contextSummaryThroughSequence) || 0),
              }))
            : [],
        messages: Array.isArray(value?.messages) ? value.messages : [],
        assets: Array.isArray(value?.assets) ? value.assets : [],
        events: Array.isArray(value?.events) ? value.events : [],
    };
}

export function emptyRuntimeDb(): RuntimeFileDatabase {
    return { version: 1, nextEventId: 1, conversations: [], messages: [], assets: [], events: [] };
}

export function prepareConversationContext(conversation: CreativeConversation, messages: CreativeMessage[]) {
    const ordered = messages.filter((item) => item.role === "user" || item.role === "assistant").sort((a, b) => a.sequence - b.sequence);
    const completed = ordered.filter((item) => item.status !== "running" && item.content.trim());
    const recentMessages = completed.slice(-CREATIVE_CONVERSATION_CONTEXT_MESSAGE_LIMIT);
    const summaryCutoff = recentMessages.length ? recentMessages[0].sequence - 1 : completed.at(-1)?.sequence || 0;
    const runningBarrier = ordered.find((item) => item.sequence > conversation.contextSummaryThroughSequence && item.status === "running")?.sequence;
    const safeSummaryCutoff = runningBarrier ? Math.min(summaryCutoff, runningBarrier - 1) : summaryCutoff;
    const additions = completed.filter((item) => item.sequence > conversation.contextSummaryThroughSequence && item.sequence <= safeSummaryCutoff);
    if (!additions.length)
        return {
            conversation,
            context: {
                summary: conversation.contextSummary,
                summaryThroughSequence: conversation.contextSummaryThroughSequence,
                recentMessages,
            },
        };
    const summary = trimContextSummary([conversation.contextSummary, ...additions.map(conversationSummaryLine)].filter(Boolean).join("\n"));
    const nextConversation = { ...conversation, contextSummary: summary, contextSummaryThroughSequence: additions.at(-1)!.sequence };
    return {
        conversation: nextConversation,
        context: {
            summary,
            summaryThroughSequence: nextConversation.contextSummaryThroughSequence,
            recentMessages,
        },
    };
}

export async function rollPostgresConversationContext(client: QueryExecutor, conversation: CreativeConversation) {
    const result = await client.query<{ summary_additions: unknown; summary_through_sequence: unknown }>(
        `WITH context_messages AS (
             SELECT message.sequence, message.role, message.status, message.content, message.metadata
             FROM creative_messages message
             WHERE message.conversation_id = $1
               AND message.sequence > $2
               AND message.role IN ('user', 'assistant')
         ), recent_cutoff AS (
             SELECT message.sequence
             FROM context_messages message
             WHERE message.status <> 'running' AND btrim(message.content) <> ''
             ORDER BY message.sequence DESC
             OFFSET $3 LIMIT 1
         ), summary_limit AS (
             SELECT CASE
                        WHEN recent_cutoff.sequence IS NULL THEN NULL
                        ELSE LEAST(
                            recent_cutoff.sequence,
                            COALESCE((SELECT MIN(message.sequence) - 1 FROM context_messages message WHERE message.status = 'running'), recent_cutoff.sequence)
                        )
                    END AS sequence
             FROM (SELECT (SELECT sequence FROM recent_cutoff) AS sequence) recent_cutoff
         ), summary_messages AS (
             SELECT message.*
             FROM context_messages message
             WHERE message.status <> 'running'
               AND message.sequence <= (SELECT sequence FROM summary_limit)
         )
         SELECT COALESCE(
                    string_agg(
                        CASE WHEN btrim(message.content) = '' THEN NULL ELSE
                            (CASE WHEN message.role = 'user' THEN '用户：' ELSE '助手：' END) ||
                            btrim(regexp_replace(message.content, '[[:space:]]+', ' ', 'g')) ||
                            COALESCE((
                                SELECT '；产物：' || string_agg(asset.id, '、' ORDER BY asset.ordinality)
                                FROM jsonb_array_elements_text(
                                    CASE WHEN jsonb_typeof(message.metadata -> 'assetIds') = 'array'
                                         THEN message.metadata -> 'assetIds'
                                         ELSE '[]'::jsonb
                                    END
                                ) WITH ORDINALITY AS asset(id, ordinality)
                                WHERE btrim(asset.id) <> ''
                            ), '')
                        END,
                        E'\n' ORDER BY message.sequence
                    ),
                    ''
                ) AS summary_additions,
                COALESCE(MAX(message.sequence), $2)::int AS summary_through_sequence
         FROM summary_messages message`,
        [conversation.id, conversation.contextSummaryThroughSequence, CREATIVE_CONVERSATION_CONTEXT_MESSAGE_LIMIT],
    );
    const row = result.rows[0];
    const summaryThroughSequence = Math.max(conversation.contextSummaryThroughSequence, Number(row?.summary_through_sequence) || 0);
    if (summaryThroughSequence <= conversation.contextSummaryThroughSequence) return conversation;
    const additions = typeof row?.summary_additions === "string" ? row.summary_additions.trim() : "";
    const contextSummary = trimContextSummary([conversation.contextSummary, additions].filter(Boolean).join("\n"));
    await client.query("UPDATE creative_conversations SET context_summary = $2, context_summary_through_sequence = $3 WHERE id = $1", [conversation.id, contextSummary, summaryThroughSequence]);
    return { ...conversation, contextSummary, contextSummaryThroughSequence: summaryThroughSequence };
}

export function conversationSummaryLine(message: CreativeMessage) {
    const role = message.role === "user" ? "用户" : "助手";
    const content = message.content.replace(/\s+/g, " ").trim();
    const assetIds = Array.isArray(message.metadata.assetIds) ? message.metadata.assetIds.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
    return `${role}：${content}${assetIds.length ? `；产物：${assetIds.join("、")}` : ""}`;
}

export function trimContextSummary(value: string) {
    return value.trim();
}

export function cleanText(value: unknown, max: number) {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function boundedLimit(value: number | undefined, fallback: number) {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) && number > 0 ? Math.min(200, number) : fallback;
}

export function dbText(value: unknown) {
    return value === null || value === undefined ? "" : String(value);
}

export function dbOptionalText(value: unknown) {
    return dbText(value) || undefined;
}

export function dbOptionalNumber(value: unknown) {
    if (value === null || value === undefined) return undefined;
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
}

export function dbObject(value: unknown) {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function dbTime(value: unknown) {
    const time = value instanceof Date ? value.getTime() : new Date(dbText(value)).getTime();
    return Number.isFinite(time) ? time : Date.now();
}

export function isUniqueViolation(error: unknown) {
    return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "23505");
}

export class CreativeStoreConflict extends Error {
    constructor(
        message: string,
        public readonly status: number,
    ) {
        super(message);
    }
}
