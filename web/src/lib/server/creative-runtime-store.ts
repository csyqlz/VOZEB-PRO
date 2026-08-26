import { nanoid } from "nanoid";

import { creativeConversationSourceForSurface, type CreativeAsset, type CreativeConversation, type CreativeConversationContext, type CreativeConversationSource, type CreativeMessage, type CreativeSurface } from "@/lib/creative-runtime-contract";
import { ensurePostgresSchema, getDatabaseProvider, postgresQuery, withPostgresTransaction } from "@/lib/server/database";
import { withGenerationTaskFileMutation } from "@/lib/server/generation-task-store";
import {
    applyRuntimeMutation,
    boundedLimit,
    cleanText,
    CREATIVE_CONVERSATION_CONTEXT_MESSAGE_LIMIT,
    createPostgresRunBundle,
    insertPostgresMessage,
    isUniqueViolation,
    mapAsset,
    mapConversation,
    mapEvent,
    mapMessage,
    message,
    mutatePostgresRun,
    mutateRuntimeFile,
    nextFileEvent,
    nextMessageSequence,
    normalizeTaskStatus,
    prepareConversationContext,
    queueRuntimeFileOperation,
    readRuntimeFile,
    resolveFileConversation,
    taskRecord,
    upsertPostgresAsset,
    validateAssetOwnership,
    writeRuntimeFile,
    type AgentRunBase,
    type CreateRunBundleInput,
    type CreativeRunBundleResult,
    type NewAsset,
    type NewConversationExchange,
    type RunMutation,
} from "./creative-runtime-repository";
import { notifyCreativeRunEvent } from "./creative-run-event-signal";

export { CreativeStoreConflict, CREATIVE_CONVERSATION_CONTEXT_MESSAGE_LIMIT } from "./creative-runtime-repository";
import { CreativeStoreConflict } from "./creative-runtime-repository";

export async function createCreativeConversation(userId: string, input: { surface: CreativeSurface; source?: CreativeConversationSource; projectId?: string; title?: string }) {
    const now = Date.now();
    const conversation: CreativeConversation = {
        id: `conversation-${nanoid()}`,
        userId,
        surface: input.surface,
        source: input.source || creativeConversationSourceForSurface(input.surface),
        projectId: input.projectId,
        title: cleanText(input.title, 120) || "新对话",
        status: "active",
        contextSummary: "",
        contextSummaryThroughSequence: 0,
        createdAt: now,
        updatedAt: now,
        lastMessageAt: now,
    };
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        await postgresQuery(
            `INSERT INTO creative_conversations (id, user_id, surface, source, project_id, title, status, created_at, updated_at, last_message_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $8)`,
            [conversation.id, userId, conversation.surface, conversation.source, conversation.projectId || null, conversation.title, conversation.status, new Date(now)],
        );
        return conversation;
    }
    await mutateRuntimeFile((db) => ({ ...db, conversations: [conversation, ...db.conversations] }));
    return conversation;
}

export async function listCreativeConversations(userId: string, input: { surface?: CreativeSurface; source?: CreativeConversationSource; projectId?: string; status?: CreativeConversation["status"]; limit?: number; offset?: number } = {}) {
    const limit = boundedLimit(input.limit, 50);
    const offset = Math.max(0, Math.floor(Number(input.offset) || 0));
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery(
            `SELECT * FROM creative_conversations
             WHERE user_id = $1 AND ($2::text IS NULL OR surface = $2) AND ($3::text IS NULL OR source = $3)
               AND ($4::text IS NULL OR project_id = $4) AND ($5::text IS NULL OR status = $5)
             ORDER BY updated_at DESC, id ASC LIMIT $6 OFFSET $7`,
            [userId, input.surface || null, input.source || null, input.projectId || null, input.status || null, limit, offset],
        );
        return result.rows.map(mapConversation);
    }
    const db = await readRuntimeFile();
    return db.conversations
        .filter(
            (item) =>
                item.userId === userId && (!input.surface || item.surface === input.surface) && (!input.source || item.source === input.source) && (!input.projectId || item.projectId === input.projectId) && (!input.status || item.status === input.status),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(offset, offset + limit);
}

export async function getCreativeConversation(id: string, userId: string) {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery("SELECT * FROM creative_conversations WHERE id = $1 AND user_id = $2", [id, userId]);
        return result.rows[0] ? mapConversation(result.rows[0]) : null;
    }
    return (await readRuntimeFile()).conversations.find((item) => item.id === id && item.userId === userId) || null;
}

export async function getCreativeConversationsByIds(userId: string, ids: string[]) {
    const uniqueIds = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
    if (!uniqueIds.length) return [];
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery("SELECT * FROM creative_conversations WHERE user_id = $1 AND id = ANY($2::text[])", [userId, uniqueIds]);
        return result.rows.map(mapConversation);
    }
    const idSet = new Set(uniqueIds);
    return (await readRuntimeFile()).conversations.filter((item) => item.userId === userId && idSet.has(item.id));
}

export async function updateCreativeConversation(id: string, userId: string, patch: { title?: string; status?: CreativeConversation["status"] }) {
    const title = patch.title === undefined ? undefined : cleanText(patch.title, 120) || "新对话";
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery(
            `UPDATE creative_conversations SET title = COALESCE($3, title), status = COALESCE($4, status), updated_at = now()
             WHERE id = $1 AND user_id = $2 RETURNING *`,
            [id, userId, title ?? null, patch.status ?? null],
        );
        return result.rows[0] ? mapConversation(result.rows[0]) : null;
    }
    let updated: CreativeConversation | null = null;
    await mutateRuntimeFile((db) => ({
        ...db,
        conversations: db.conversations.map((item) => {
            if (item.id !== id || item.userId !== userId) return item;
            updated = { ...item, ...(title !== undefined ? { title } : {}), ...(patch.status ? { status: patch.status } : {}), updatedAt: Date.now() };
            return updated;
        }),
    }));
    return updated;
}

export async function listCreativeMessages(conversationId: string, afterSequence = 0, limit = 100, beforeSequence = 0) {
    const size = boundedLimit(limit, 100);
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        if (beforeSequence > 0) {
            const result = await postgresQuery("SELECT * FROM creative_messages WHERE conversation_id = $1 AND sequence < $2 ORDER BY sequence DESC LIMIT $3", [conversationId, beforeSequence, size]);
            return result.rows.map(mapMessage).reverse();
        }
        if (afterSequence > 0) {
            const result = await postgresQuery("SELECT * FROM creative_messages WHERE conversation_id = $1 AND sequence > $2 ORDER BY sequence ASC LIMIT $3", [conversationId, afterSequence, size]);
            return result.rows.map(mapMessage);
        }
        const result = await postgresQuery("SELECT * FROM creative_messages WHERE conversation_id = $1 ORDER BY sequence DESC LIMIT $2", [conversationId, size]);
        return result.rows.map(mapMessage).reverse();
    }
    const messages = (await readRuntimeFile()).messages.filter((item) => item.conversationId === conversationId);
    if (beforeSequence > 0)
        return messages
            .filter((item) => item.sequence < beforeSequence)
            .sort((a, b) => b.sequence - a.sequence)
            .slice(0, size)
            .reverse();
    if (afterSequence > 0)
        return messages
            .filter((item) => item.sequence > afterSequence)
            .sort((a, b) => a.sequence - b.sequence)
            .slice(0, size);
    return messages
        .sort((a, b) => b.sequence - a.sequence)
        .slice(0, size)
        .reverse();
}

export async function appendCreativeConversationExchange(input: NewConversationExchange) {
    const userContent = cleanText(input.userContent, 4000);
    const assistantContent = cleanText(input.assistantContent, 12000);
    if (!userContent || !assistantContent) throw new CreativeStoreConflict("创作消息不能为空", 400);
    const now = Date.now();
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        return withPostgresTransaction(async (client) => {
            const conversationResult = await client.query("SELECT * FROM creative_conversations WHERE id = $1 AND user_id = $2 FOR UPDATE", [input.conversationId, input.userId]);
            if (!conversationResult.rows[0]) throw new CreativeStoreConflict("创作会话不存在", 404);
            const conversation = mapConversation(conversationResult.rows[0]);
            if (conversation.status !== "active") throw new CreativeStoreConflict("归档会话不能追加消息", 409);
            if (input.runId) {
                const existingResult = await client.query("SELECT * FROM creative_messages WHERE conversation_id = $1 AND run_id = $2 AND role IN ('user', 'assistant') ORDER BY sequence ASC", [input.conversationId, input.runId]);
                const existingUser = existingResult.rows.find((row) => row.role === "user");
                const existingAssistant = existingResult.rows.find((row) => row.role === "assistant");
                if (existingUser && existingAssistant) return { userMessage: mapMessage(existingUser), assistantMessage: mapMessage(existingAssistant) };
                if (existingUser || existingAssistant) throw new CreativeStoreConflict("工作台请求记录不完整，无法安全重试", 409);
            }
            const sequenceResult = await client.query<{ sequence: number }>("SELECT COALESCE(MAX(sequence), 0)::int AS sequence FROM creative_messages WHERE conversation_id = $1", [input.conversationId]);
            const sequence = Number(sequenceResult.rows[0]?.sequence || 0) + 1;
            const userMessage = message(`message-${nanoid()}`, input.conversationId, sequence, "user", "completed", userContent, input.runId || "", input.userMetadata || {}, now);
            const assistantMessage = message(`message-${nanoid()}`, input.conversationId, sequence + 1, "assistant", "completed", assistantContent, input.runId || "", input.assistantMetadata || {}, now);
            await insertPostgresMessage(client, userMessage);
            await insertPostgresMessage(client, assistantMessage);
            const title = conversation.title === "新对话" ? cleanText(userContent, 120) || conversation.title : conversation.title;
            await client.query("UPDATE creative_conversations SET title = $2, updated_at = $3, last_message_at = $3 WHERE id = $1", [input.conversationId, title, new Date(now)]);
            return { userMessage, assistantMessage };
        });
    }
    let exchange: { userMessage: CreativeMessage; assistantMessage: CreativeMessage } | null = null;
    await mutateRuntimeFile((db) => {
        const conversation = db.conversations.find((item) => item.id === input.conversationId && item.userId === input.userId);
        if (!conversation) throw new CreativeStoreConflict("创作会话不存在", 404);
        if (conversation.status !== "active") throw new CreativeStoreConflict("归档会话不能追加消息", 409);
        if (input.runId) {
            const existing = db.messages.filter((item) => item.conversationId === input.conversationId && item.runId === input.runId && (item.role === "user" || item.role === "assistant"));
            const existingUser = existing.find((item) => item.role === "user");
            const existingAssistant = existing.find((item) => item.role === "assistant");
            if (existingUser && existingAssistant) {
                exchange = { userMessage: existingUser, assistantMessage: existingAssistant };
                return db;
            }
            if (existingUser || existingAssistant) throw new CreativeStoreConflict("工作台请求记录不完整，无法安全重试", 409);
        }
        const sequence = nextMessageSequence(db.messages, input.conversationId);
        const userMessage = message(`message-${nanoid()}`, input.conversationId, sequence, "user", "completed", userContent, input.runId || "", input.userMetadata || {}, now);
        const assistantMessage = message(`message-${nanoid()}`, input.conversationId, sequence + 1, "assistant", "completed", assistantContent, input.runId || "", input.assistantMetadata || {}, now);
        exchange = { userMessage, assistantMessage };
        return {
            ...db,
            conversations: db.conversations.map((item) => (item.id === input.conversationId ? { ...item, title: item.title === "新对话" ? cleanText(userContent, 120) || item.title : item.title, updatedAt: now, lastMessageAt: now } : item)),
            messages: [...db.messages, userMessage, assistantMessage],
        };
    });
    return exchange!;
}

export async function getCreativeConversationContext(conversationId: string, userId: string, excludeRunId?: string): Promise<CreativeConversationContext> {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ context_summary: unknown; context_summary_through_sequence: unknown; recent_messages: unknown }>(
            `SELECT conversation.context_summary,
                    conversation.context_summary_through_sequence,
                    COALESCE((
                        SELECT jsonb_agg(to_jsonb(recent_message) ORDER BY recent_message.sequence ASC)
                        FROM (
                            SELECT message.*
                            FROM creative_messages message
                            WHERE message.conversation_id = conversation.id
                              AND ($3::text IS NULL OR message.run_id IS DISTINCT FROM $3)
                              AND message.sequence > conversation.context_summary_through_sequence
                              AND message.role IN ('user', 'assistant')
                              AND message.status <> 'running'
                            ORDER BY message.sequence DESC
                            LIMIT $4
                        ) recent_message
                    ), '[]'::jsonb) AS recent_messages
             FROM creative_conversations conversation
             WHERE conversation.id = $1 AND conversation.user_id = $2`,
            [conversationId, userId, excludeRunId || null, CREATIVE_CONVERSATION_CONTEXT_MESSAGE_LIMIT],
        );
        const row = result.rows[0];
        if (!row) throw new CreativeStoreConflict("创作会话不存在", 404);
        return {
            summary: typeof row.context_summary === "string" ? row.context_summary : "",
            summaryThroughSequence: Math.max(0, Number(row.context_summary_through_sequence) || 0),
            recentMessages: Array.isArray(row.recent_messages) ? row.recent_messages.map(mapMessage) : [],
        };
    }
    return queueRuntimeFileOperation(async () => {
        const db = await readRuntimeFile();
        const conversation = db.conversations.find((item) => item.id === conversationId && item.userId === userId);
        if (!conversation) throw new CreativeStoreConflict("创作会话不存在", 404);
        const messages = db.messages
            .filter(
                (item) =>
                    item.conversationId === conversationId && item.sequence > conversation.contextSummaryThroughSequence && (!excludeRunId || item.runId !== excludeRunId) && (item.role === "user" || item.role === "assistant") && item.status !== "running",
            )
            .sort((left, right) => left.sequence - right.sequence)
            .slice(-CREATIVE_CONVERSATION_CONTEXT_MESSAGE_LIMIT);
        return prepareConversationContext(conversation, messages).context;
    });
}

export async function listCreativeAssets(conversationId: string, userId: string) {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery("SELECT * FROM creative_assets WHERE conversation_id = $1 AND user_id = $2 AND status <> 'deleted' ORDER BY created_at ASC, ordinal ASC", [conversationId, userId]);
        return result.rows.map(mapAsset);
    }
    return (await readRuntimeFile()).assets.filter((item) => item.conversationId === conversationId && item.userId === userId && item.status !== "deleted").sort((a, b) => a.createdAt - b.createdAt || a.ordinal - b.ordinal);
}

export async function listRecentCreativeMediaAssets(conversationId: string, userId: string, limit = 20) {
    const boundedLimit = Math.max(1, Math.min(20, Math.floor(limit)));
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery("SELECT * FROM creative_assets WHERE conversation_id = $1 AND user_id = $2 AND status = 'ready' AND type IN ('image', 'video') ORDER BY created_at DESC, ordinal DESC LIMIT $3", [
            conversationId,
            userId,
            boundedLimit,
        ]);
        return result.rows.map(mapAsset);
    }
    return (await readRuntimeFile()).assets
        .filter((item) => item.conversationId === conversationId && item.userId === userId && item.status === "ready" && (item.type === "image" || item.type === "video"))
        .sort((a, b) => b.createdAt - a.createdAt || b.ordinal - a.ordinal)
        .slice(0, boundedLimit);
}

export async function getCreativeAsset(id: string, userId: string) {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery("SELECT * FROM creative_assets WHERE id = $1 AND user_id = $2", [id, userId]);
        return result.rows[0] ? mapAsset(result.rows[0]) : null;
    }
    return (await readRuntimeFile()).assets.find((item) => item.id === id && item.userId === userId) || null;
}

export async function getCreativeAssetsByIds(ids: string[], userId: string) {
    const uniqueIds = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
    if (!uniqueIds.length) return [];
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery("SELECT * FROM creative_assets WHERE id = ANY($1::text[]) AND user_id = $2 AND status <> 'deleted'", [uniqueIds, userId]);
        return result.rows.map(mapAsset);
    }
    const wanted = new Set(uniqueIds);
    return (await readRuntimeFile()).assets.filter((item) => wanted.has(item.id) && item.userId === userId && item.status !== "deleted");
}

export async function createCreativeRunBundle<T extends AgentRunBase>(userId: string, input: CreateRunBundleInput<T>) {
    if (getDatabaseProvider() === "postgres") {
        try {
            const result = await createPostgresRunBundle(userId, input);
            if (result.created) notifyCreativeRunEvent(input.run.id);
            return result;
        } catch (error) {
            if (!isUniqueViolation(error)) throw error;
            const run = await getCreativeRunByClientRequestId<T>(userId, input.run.clientRequestId);
            if (run) return { run, created: false };
            throw error;
        }
    }
    const result = await queueRuntimeFileOperation(() =>
        withGenerationTaskFileMutation<CreativeRunBundleResult<T>>(async (tasks) => {
            const existing = tasks.find((item) => item.userId === userId && item.clientRequestId === input.run.clientRequestId && item.type === "agent");
            if (existing) return { tasks, result: { run: existing.payload as T, created: false } };
            const db = await readRuntimeFile();
            const conversation = resolveFileConversation(db, userId, input);
            validateAssetOwnership(db.assets, input.assetIds, userId);
            const preparedConversation = input.conversationId
                ? prepareConversationContext(
                      conversation,
                      db.messages.filter((item) => item.conversationId === conversation.id),
                  ).conversation
                : conversation;
            const now = input.run.createdAt;
            const sequence = nextMessageSequence(db.messages, conversation.id);
            const userMessage = message(input.run.inputMessageId, conversation.id, sequence, "user", "completed", input.prompt, input.run.id, { assetIds: input.assetIds }, now);
            const assistantMessage = message(input.run.assistantMessageId, conversation.id, sequence + 1, "assistant", "running", input.acknowledgement || "已收到你的需求。", input.run.id, {}, now);
            const event = nextFileEvent(db, input.run.id, "run.created", undefined, now);
            const nextConversation = { ...preparedConversation, title: preparedConversation.title === "新对话" ? input.title : preparedConversation.title, updatedAt: now, lastMessageAt: now };
            await writeRuntimeFile({
                ...db,
                conversations: [nextConversation, ...db.conversations.filter((item) => item.id !== conversation.id)],
                messages: [...db.messages, userMessage, assistantMessage],
                events: [...db.events, event],
                nextEventId: Number(event.id) + 1,
            });
            const record = taskRecord(input.run, input.ttlMs);
            return { tasks: [record, ...tasks.filter((item) => item.id !== input.run.id)], result: { run: input.run, conversation: nextConversation, userMessage, assistantMessage, created: true } };
        }),
    );
    if (result.created) notifyCreativeRunEvent(input.run.id);
    return result;
}

export async function getCreativeRunByClientRequestId<T extends AgentRunBase>(userId: string, clientRequestId: string) {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ payload: T }>("SELECT payload FROM generation_tasks WHERE user_id = $1 AND client_request_id = $2 AND task_type = 'agent' LIMIT 1", [userId, clientRequestId]);
        return result.rows[0]?.payload || null;
    }
    return withGenerationTaskFileMutation<T | null>(async (items) => ({
        tasks: items,
        result: (items.find((item) => item.userId === userId && item.clientRequestId === clientRequestId && item.type === "agent")?.payload as T | undefined) || null,
    }));
}

export async function mutateCreativeRun<T extends AgentRunBase>(id: string, ttlMs: number, mutate: (current: T) => RunMutation<T> | null, allowedStatuses?: string[], expectedExecutionId?: string) {
    if (getDatabaseProvider() === "postgres") {
        const result = await mutatePostgresRun(id, ttlMs, mutate, allowedStatuses, expectedExecutionId);
        if (result) notifyCreativeRunEvent(id);
        return result;
    }
    const result = await queueRuntimeFileOperation(() =>
        withGenerationTaskFileMutation(async (tasks) => {
            const index = tasks.findIndex((item) => item.id === id && item.type === "agent" && item.expiresAt > Date.now());
            if (index < 0) return { tasks, result: null };
            const current = tasks[index].payload as T & { executionId?: string };
            if (allowedStatuses && !allowedStatuses.includes(current.status)) return { tasks, result: null };
            if (expectedExecutionId && current.executionId !== expectedExecutionId) return { tasks, result: null };
            const mutation = mutate(current);
            if (!mutation) return { tasks, result: null };
            const now = Date.now();
            const run = { ...mutation.run, id: current.id, userId: current.userId, createdAt: current.createdAt, updatedAt: now };
            const db = await readRuntimeFile();
            const nextDb = applyRuntimeMutation(db, run, mutation, now);
            await writeRuntimeFile(nextDb);
            const nextTasks = [...tasks];
            nextTasks[index] = { ...tasks[index], status: normalizeTaskStatus(run.status), payload: run as unknown as Record<string, unknown>, updatedAt: now, expiresAt: now + ttlMs };
            return { tasks: nextTasks, result: run };
        }),
    );
    if (result) notifyCreativeRunEvent(id);
    return result;
}

export const CREATIVE_RUN_EVENT_BATCH_SIZE = 500;

export async function listCreativeRunEvents(runId: string, afterId = "") {
    const cursor = Math.max(0, Number(afterId) || 0);
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery("SELECT * FROM creative_run_events WHERE run_id = $1 AND id > $2 ORDER BY id ASC LIMIT $3", [runId, cursor, CREATIVE_RUN_EVENT_BATCH_SIZE]);
        return result.rows.map(mapEvent);
    }
    return (await readRuntimeFile()).events
        .filter((item) => item.runId === runId && Number(item.id) > cursor)
        .sort((a, b) => Number(a.id) - Number(b.id))
        .slice(0, CREATIVE_RUN_EVENT_BATCH_SIZE);
}

export async function getLatestCreativeRunEventId(runId: string, type: string) {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ id: string | number }>("SELECT id FROM creative_run_events WHERE run_id = $1 AND type = $2 ORDER BY id DESC LIMIT 1", [runId, type]);
        return result.rows[0] ? String(result.rows[0].id) : "";
    }
    return (await readRuntimeFile()).events.filter((item) => item.runId === runId && item.type === type).reduce((latest, item) => (Number(item.id) > Number(latest || 0) ? item.id : latest), "");
}

export async function registerCreativeAssets(inputs: NewAsset[]) {
    if (!inputs.length) return [];
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        return withPostgresTransaction(async (client) => {
            const assets: CreativeAsset[] = [];
            for (const input of inputs) assets.push(await upsertPostgresAsset(client, input));
            return assets;
        });
    }
    let registered: CreativeAsset[] = [];
    await mutateRuntimeFile((db) => {
        const now = Date.now();
        const assets = [...db.assets];
        registered = inputs.map((input) => {
            const index = assets.findIndex((item) => item.sourceRunId === input.sourceRunId && item.sourceTaskId === input.sourceTaskId && item.ordinal === input.ordinal);
            const existing = index >= 0 ? assets[index] : undefined;
            const asset: CreativeAsset = { ...input, id: existing?.id || input.id || `asset-${nanoid()}`, status: input.status || "ready", metadata: input.metadata || {}, createdAt: existing?.createdAt || now, updatedAt: now };
            if (index >= 0) assets[index] = asset;
            else assets.push(asset);
            return asset;
        });
        return { ...db, assets };
    });
    return registered;
}
