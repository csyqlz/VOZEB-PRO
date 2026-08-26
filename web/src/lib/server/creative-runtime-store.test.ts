import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentRun } from "./agent-run-store";

const mocks = vi.hoisted(() => ({
    files: new Map<string, unknown>(),
    databaseProvider: "file" as "file" | "postgres",
    query: vi.fn(),
    transaction: vi.fn(),
}));

vi.mock("@/lib/server/database", () => ({
    ensurePostgresSchema: vi.fn(),
    getDatabaseProvider: vi.fn(() => mocks.databaseProvider),
    postgresQuery: mocks.query,
    withPostgresTransaction: mocks.transaction,
}));
vi.mock("@/lib/server/data-adapter", () => ({
    readJsonDataFile: vi.fn(async (fileName: string, fallback: unknown) => structuredClone(mocks.files.has(fileName) ? mocks.files.get(fileName) : fallback)),
    withJsonDataFileLock: vi.fn(async (_fileName: string, callback: () => Promise<unknown>) => callback()),
    writeJsonDataFile: vi.fn(async (fileName: string, value: unknown) => {
        mocks.files.set(fileName, structuredClone(value));
    }),
}));

import {
    appendCreativeConversationExchange,
    CREATIVE_CONVERSATION_CONTEXT_MESSAGE_LIMIT,
    CREATIVE_RUN_EVENT_BATCH_SIZE,
    createCreativeConversation,
    createCreativeRunBundle,
    CreativeStoreConflict,
    getCreativeConversationContext,
    getCreativeConversation,
    getCreativeConversationsByIds,
    getCreativeAsset,
    getCreativeAssetsByIds,
    getCreativeRunByClientRequestId,
    listCreativeConversations,
    listCreativeMessages,
    listCreativeRunEvents,
    mutateCreativeRun,
    registerCreativeAssets,
} from "./creative-runtime-store";

describe("creative runtime file provider", () => {
    beforeEach(() => {
        mocks.files = new Map();
        mocks.databaseProvider = "file";
        mocks.query.mockReset();
        mocks.transaction.mockReset();
    });

    it("creates a run bundle once and keeps message sequence stable", async () => {
        const first = await createBundle(run({ id: "run-one" }));
        const duplicate = await createBundle(run({ id: "run-two" }));

        expect(first.created).toBe(true);
        expect(duplicate).toMatchObject({ created: false, run: { id: "run-one" } });
        expect(await getCreativeRunByClientRequestId<AgentRun>("user", "request-one")).toMatchObject({ id: "run-one" });
        expect(await listCreativeMessages("conversation", 0, 10)).toMatchObject([
            { sequence: 1, role: "user", status: "completed", content: "生成一张图" },
            { sequence: 2, role: "assistant", status: "running", runId: "run-one" },
        ]);
        expect(mocks.files.get("generation-tasks.json")).toMatchObject([
            {
                id: "run-one",
                executionPhase: "created",
                nextPollAt: expect.any(Number),
                lastUpstreamStatus: "created",
            },
        ]);
    });

    it("keeps the completed first round in the next Agent run context", async () => {
        await createBundle(run({ id: "run-one" }));
        await mutateCreativeRun<AgentRun>(
            "run-one",
            60_000,
            (current) => ({
                run: { ...current, status: "completed" },
                assistant: { status: "completed", content: "上一轮确定使用红色跑车。" },
            }),
            ["planning"],
        );
        const nextRun = run({
            id: "run-two",
            clientRequestId: "request-two",
            inputMessageId: "input-message-two",
            assistantMessageId: "assistant-message-two",
            prompt: "继续上一轮，把背景改成夜景",
        });
        await createBundle(nextRun, [], "conversation");

        const context = await getCreativeConversationContext("conversation", "user", "run-two");

        expect(context.recentMessages.map((item) => ({ role: item.role, content: item.content }))).toEqual([
            { role: "user", content: "生成一张图" },
            { role: "assistant", content: "上一轮确定使用红色跑车。" },
        ]);
    });

    it("replays events after a numeric cursor without duplication", async () => {
        await createBundle(run());
        await mutateCreativeRun<AgentRun>("run-one", 60_000, (current) => ({ run: { ...current, status: "running" }, event: { type: "run.running" } }), ["planning"]);

        expect((await listCreativeRunEvents("run-one")).map((event) => event.type)).toEqual(["run.created", "run.running"]);
        expect((await listCreativeRunEvents("run-one", "1")).map((event) => event.type)).toEqual(["run.running"]);
    });

    it("uses the shared event batch size for PostgreSQL cursor pagination", async () => {
        mocks.databaseProvider = "postgres";
        mocks.query.mockResolvedValue({ rows: [] });

        await expect(listCreativeRunEvents("run-one", "17")).resolves.toEqual([]);

        expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("LIMIT $3"), ["run-one", 17, CREATIVE_RUN_EVENT_BATCH_SIZE]);
    });

    it("queries PostgreSQL conversation history by project before pagination", async () => {
        mocks.databaseProvider = "postgres";
        mocks.query.mockResolvedValue({ rows: [] });

        await expect(listCreativeConversations("user-one", { surface: "drama", source: "drama", projectId: "project-one", status: "active", limit: 21, offset: 4 })).resolves.toEqual([]);

        expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("project_id = $4"), ["user-one", "drama", "drama", "project-one", "active", 21, 4]);
    });

    it("loads only owned file conversations by unique stable ids", async () => {
        const owned = await createCreativeConversation("user", { surface: "canvas", projectId: "canvas-one", title: "Owned" });
        const foreign = await createCreativeConversation("other-user", { surface: "canvas", projectId: "canvas-one", title: "Foreign" });

        await expect(getCreativeConversationsByIds("user", ["", ` ${owned.id} `, owned.id, foreign.id])).resolves.toMatchObject([{ id: owned.id, userId: "user", title: "Owned" }]);
        await expect(getCreativeConversationsByIds("user", [" "])).resolves.toEqual([]);
    });

    it("queries PostgreSQL conversations by owner and unique stable ids", async () => {
        mocks.databaseProvider = "postgres";
        mocks.query.mockResolvedValue({
            rows: [
                {
                    id: "conversation-one",
                    user_id: "user",
                    surface: "canvas",
                    source: "canvas-agent",
                    project_id: "canvas-one",
                    title: "Agent",
                    status: "active",
                    context_summary: "",
                    context_summary_through_sequence: 0,
                    created_at: new Date(0),
                    updated_at: new Date(0),
                    last_message_at: new Date(0),
                },
            ],
        });

        await expect(getCreativeConversationsByIds("user", [" conversation-one ", "conversation-one", "conversation-two"])).resolves.toMatchObject([{ id: "conversation-one", userId: "user", surface: "canvas", projectId: "canvas-one" }]);
        expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("WHERE user_id = $1 AND id = ANY($2::text[])"), ["user", ["conversation-one", "conversation-two"]]);
    });

    it("applies owner scope when loading a conversation or asset by id", async () => {
        mocks.databaseProvider = "postgres";
        mocks.query.mockResolvedValue({ rows: [] });

        await expect(getCreativeConversation("conversation-one", "user-one")).resolves.toBeNull();
        await expect(getCreativeAsset("asset-one", "user-one")).resolves.toBeNull();
        await expect(getCreativeAssetsByIds([" asset-one ", "asset-one"], "user-one")).resolves.toEqual([]);

        expect(mocks.query).toHaveBeenNthCalledWith(1, expect.stringContaining("id = $1 AND user_id = $2"), ["conversation-one", "user-one"]);
        expect(mocks.query).toHaveBeenNthCalledWith(2, expect.stringContaining("id = $1 AND user_id = $2"), ["asset-one", "user-one"]);
        expect(mocks.query).toHaveBeenNthCalledWith(3, expect.stringContaining("id = ANY($1::text[]) AND user_id = $2"), [["asset-one"], "user-one"]);
    });

    it("upserts a stable asset for the same run task and ordinal", async () => {
        await createBundle(run());
        const first = await registerCreativeAssets([
            {
                userId: "user",
                conversationId: "conversation",
                messageId: "assistant-message",
                sourceRunId: "run-one",
                sourceTaskId: "child-one",
                ordinal: 0,
                type: "image",
                title: "第一版",
                remoteUrl: "https://cdn.example.com/one.png",
                storageKind: "remote",
            },
        ]);
        const second = await registerCreativeAssets([
            {
                userId: "user",
                conversationId: "conversation",
                messageId: "assistant-message",
                sourceRunId: "run-one",
                sourceTaskId: "child-one",
                ordinal: 0,
                type: "image",
                title: "更新标题",
                remoteUrl: "https://cdn.example.com/one.png",
                storageKind: "remote",
            },
        ]);

        expect(second[0]).toMatchObject({ id: first[0].id, title: "更新标题" });
        expect((mocks.files.get("creative-runtime.json") as { assets: unknown[] }).assets).toHaveLength(1);
    });

    it("rejects foreign assets and immutable conversation scope changes", async () => {
        const foreign = await registerCreativeAssets([
            {
                userId: "other-user",
                conversationId: "other-conversation",
                sourceRunId: "other-run",
                sourceTaskId: "other-task",
                ordinal: 0,
                type: "image",
                title: "他人资产",
                remoteUrl: "https://cdn.example.com/other.png",
                storageKind: "remote",
            },
        ]);
        await expect(createBundle(run(), [foreign[0].id])).rejects.toMatchObject({ status: 403 });

        const conversation = await createCreativeConversation("user", { surface: "canvas", projectId: "project-one" });
        await expect(createBundle(run({ conversationId: conversation.id, surface: "canvas", projectId: "project-two" }), [], conversation.id)).rejects.toBeInstanceOf(CreativeStoreConflict);
    });

    it("rolls older file messages into the persistent summary before the next Agent run", async () => {
        const now = Date.now();
        mocks.files.set("creative-runtime.json", {
            version: 1,
            nextEventId: 1,
            conversations: [
                {
                    id: "conversation",
                    userId: "user",
                    surface: "chat",
                    title: "长对话",
                    status: "active",
                    contextSummary: "",
                    contextSummaryThroughSequence: 0,
                    createdAt: now,
                    updatedAt: now,
                    lastMessageAt: now,
                },
            ],
            messages: Array.from({ length: 16 }, (_, index) => ({
                id: `message-${index + 1}`,
                conversationId: "conversation",
                sequence: index + 1,
                role: index % 2 ? "assistant" : "user",
                status: "completed",
                content: `第 ${index + 1} 条历史内容`,
                metadata: {},
                createdAt: now + index,
                updatedAt: now + index,
            })),
            assets: [],
            events: [],
        });

        await createBundle(run(), [], "conversation");
        const first = await getCreativeConversationContext("conversation", "user", "run-one");
        const second = await getCreativeConversationContext("conversation", "user", "run-one");

        expect(first.recentMessages.map((item) => item.sequence)).toEqual(Array.from({ length: CREATIVE_CONVERSATION_CONTEXT_MESSAGE_LIMIT }, (_, index) => index + 5));
        expect(first.summary).toContain("第 1 条历史内容");
        expect(first.summary).toContain("第 4 条历史内容");
        expect(first.summaryThroughSequence).toBe(4);
        expect(second).toEqual(first);
        expect((mocks.files.get("creative-runtime.json") as { conversations: Array<{ contextSummaryThroughSequence: number }> }).conversations[0].contextSummaryThroughSequence).toBe(4);
    });

    it("does not advance the summary past an unfinished older message", async () => {
        const now = Date.now();
        mocks.files.set("creative-runtime.json", {
            version: 1,
            nextEventId: 1,
            conversations: [{ id: "conversation", userId: "user", surface: "chat", title: "并发", status: "active", contextSummary: "", contextSummaryThroughSequence: 0, createdAt: now, updatedAt: now, lastMessageAt: now }],
            messages: Array.from({ length: 16 }, (_, index) => ({
                id: `message-${index + 1}`,
                conversationId: "conversation",
                sequence: index + 1,
                role: index === 1 ? "assistant" : index % 2 ? "assistant" : "user",
                status: index === 1 ? "running" : "completed",
                content: `第 ${index + 1} 条历史内容`,
                metadata: {},
                createdAt: now + index,
                updatedAt: now + index,
            })),
            assets: [],
            events: [],
        });

        await createBundle(run(), [], "conversation");

        const conversation = (mocks.files.get("creative-runtime.json") as { conversations: Array<{ contextSummaryThroughSequence: number; contextSummary: string }> }).conversations[0];
        expect(conversation.contextSummaryThroughSequence).toBe(1);
        expect(conversation.contextSummary).toContain("第 1 条历史内容");
        expect(conversation.contextSummary).not.toContain("第 3 条历史内容");

        const runtime = mocks.files.get("creative-runtime.json") as {
            messages: Array<{ id: string; status: "completed" | "running" }>;
        };
        runtime.messages = runtime.messages.map((item) => (item.id === "message-2" ? { ...item, status: "completed" } : item));
        mocks.files.set("creative-runtime.json", runtime);
        await mutateCreativeRun<AgentRun>(
            "run-one",
            60_000,
            (current) => ({
                run: { ...current, status: "completed" },
                assistant: { status: "completed", content: "第一轮已经完成。" },
            }),
            ["planning"],
        );
        await createBundle(
            run({
                id: "run-two",
                clientRequestId: "request-two",
                inputMessageId: "input-message-two",
                assistantMessageId: "assistant-message-two",
                prompt: "继续处理",
            }),
            [],
            "conversation",
        );

        const resumed = await getCreativeConversationContext("conversation", "user", "run-two");
        expect(resumed.summaryThroughSequence).toBe(6);
        expect(resumed.summary).toContain("第 2 条历史内容");
        expect(resumed.summary).toContain("第 6 条历史内容");
        expect(resumed.recentMessages.map((item) => item.sequence)).toEqual(Array.from({ length: CREATIVE_CONVERSATION_CONTEXT_MESSAGE_LIMIT }, (_, index) => index + 7));
    });

    it("queries owned PostgreSQL conversation context once with an ordered bounded message subquery", async () => {
        mocks.databaseProvider = "postgres";
        mocks.query.mockResolvedValue({
            rows: [
                {
                    context_summary: "已压缩内容",
                    context_summary_through_sequence: 120,
                    recent_messages: [
                        {
                            id: "message-121",
                            conversation_id: "conversation",
                            sequence: 121,
                            role: "user",
                            status: "completed",
                            content: "继续完善分镜",
                            metadata: {},
                            created_at: new Date(0),
                            updated_at: new Date(0),
                        },
                    ],
                },
            ],
        });

        await expect(getCreativeConversationContext("conversation", "user", "current-run")).resolves.toMatchObject({ summary: "已压缩内容", summaryThroughSequence: 120, recentMessages: [{ sequence: 121, content: "继续完善分镜" }] });

        expect(mocks.query).toHaveBeenCalledTimes(1);
        const [sql, parameters] = mocks.query.mock.calls[0] || [];
        expect(String(sql)).toContain("conversation.id = $1 AND conversation.user_id = $2");
        expect(String(sql)).toContain("message.sequence > conversation.context_summary_through_sequence");
        expect(String(sql)).toContain("ORDER BY message.sequence DESC");
        expect(String(sql)).toContain("LIMIT $4");
        expect(String(sql)).not.toContain("FOR UPDATE");
        expect(parameters).toEqual(["conversation", "user", "current-run", CREATIVE_CONVERSATION_CONTEXT_MESSAGE_LIMIT]);
    });

    it("persists PostgreSQL rolling context before appending the next Agent round", async () => {
        mocks.databaseProvider = "postgres";
        const queries: Array<{ sql: string; parameters: unknown[] | undefined }> = [];
        const now = Date.now();
        const conversationRow = {
            id: "conversation",
            user_id: "user",
            surface: "chat",
            source: "agent",
            project_id: null,
            title: "长对话",
            status: "active",
            context_summary: "",
            context_summary_through_sequence: 0,
            created_at: new Date(now),
            updated_at: new Date(now),
            last_message_at: new Date(now),
        };
        const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
            queries.push({ sql, parameters });
            if (sql.startsWith("SELECT payload")) return { rows: [] };
            if (sql.includes("FROM creative_conversations WHERE id = $1 AND user_id = $2 FOR UPDATE")) return { rows: [conversationRow] };
            if (sql.startsWith("WITH context_messages")) return { rows: [{ summary_additions: "用户：较早需求\n助手：较早回复", summary_through_sequence: 4 }] };
            if (sql.startsWith("SELECT COALESCE(MAX")) return { rows: [{ sequence: 16 }] };
            if (sql.startsWith("INSERT INTO creative_run_events")) return { rows: [{ id: 1, run_id: "run-one", type: "run.created", data: null, created_at: new Date(now) }] };
            if (sql.startsWith("UPDATE creative_conversations SET title"))
                return {
                    rows: [{ ...conversationRow, context_summary: "用户：较早需求\n助手：较早回复", context_summary_through_sequence: 4, updated_at: new Date(now), last_message_at: new Date(now) }],
                };
            return { rows: [] };
        });
        mocks.transaction.mockImplementation(async (handler: (client: { query: typeof query }) => Promise<unknown>) => handler({ query }));

        await expect(createBundle(run({ createdAt: now, updatedAt: now }), [], "conversation")).resolves.toMatchObject({ created: true, conversation: { contextSummary: "用户：较早需求\n助手：较早回复", contextSummaryThroughSequence: 4 } });

        const summaryQuery = queries.find((item) => item.sql.startsWith("WITH context_messages"));
        expect(summaryQuery?.parameters).toEqual(["conversation", 0, CREATIVE_CONVERSATION_CONTEXT_MESSAGE_LIMIT]);
        expect(summaryQuery?.sql).toContain("OFFSET $3 LIMIT 1");
        expect(summaryQuery?.sql).toContain("MIN(message.sequence) - 1");
        expect(queries).toContainEqual({
            sql: "UPDATE creative_conversations SET context_summary = $2, context_summary_through_sequence = $3 WHERE id = $1",
            parameters: ["conversation", "用户：较早需求\n助手：较早回复", 4],
        });
    });

    it("inserts PostgreSQL Agent tasks with their initial recovery schedule atomically", async () => {
        mocks.databaseProvider = "postgres";
        const queries: Array<{ sql: string; parameters: unknown[] | undefined }> = [];
        const now = Date.now();
        const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
            queries.push({ sql, parameters });
            if (sql.startsWith("SELECT payload")) return { rows: [] };
            if (sql.startsWith("SELECT COALESCE(MAX")) return { rows: [{ sequence: 0 }] };
            if (sql.startsWith("INSERT INTO creative_run_events")) return { rows: [{ id: 1, run_id: "run-one", type: "run.created", data: null, created_at: new Date(now) }] };
            if (sql.startsWith("UPDATE creative_conversations"))
                return {
                    rows: [
                        {
                            id: "conversation",
                            user_id: "user",
                            surface: "chat",
                            source: "agent",
                            project_id: null,
                            title: "测试会话",
                            status: "active",
                            context_summary: "",
                            context_summary_through_sequence: 0,
                            created_at: new Date(now),
                            updated_at: new Date(now),
                            last_message_at: new Date(now),
                        },
                    ],
                };
            return { rows: [] };
        });
        mocks.transaction.mockImplementation(async (handler: (client: { query: typeof query }) => Promise<unknown>) => handler({ query }));

        await expect(createBundle(run({ createdAt: now, updatedAt: now }))).resolves.toMatchObject({ created: true, run: { id: "run-one" } });

        const taskInsert = queries.find((item) => item.sql.includes("INSERT INTO generation_tasks"));
        expect(taskInsert?.sql).toContain("execution_phase, next_poll_at, last_upstream_status");
        expect(taskInsert?.sql).toContain("'created', $4, 'created'");
    });

    it("appends a workbench exchange atomically and advances the sequence", async () => {
        await createCreativeConversation("user", { surface: "chat", source: "image-workbench" });
        const conversation = (mocks.files.get("creative-runtime.json") as { conversations: Array<{ id: string }> }).conversations[0];

        const exchange = await appendCreativeConversationExchange({
            userId: "user",
            conversationId: conversation.id,
            userContent: "生成产品主图",
            assistantContent: "已选择横向商业摄影方案。",
            assistantMetadata: { workspace: "image" },
        });

        expect(exchange).toMatchObject({ userMessage: { sequence: 1, role: "user" }, assistantMessage: { sequence: 2, role: "assistant" } });
        expect(await listCreativeMessages(conversation.id)).toHaveLength(2);
        await expect(appendCreativeConversationExchange({ userId: "other", conversationId: conversation.id, userContent: "test", assistantContent: "reply" })).rejects.toMatchObject({ status: 404 });
    });

    it("is idempotent for the same request identity but keeps identical prompts from new requests", async () => {
        const conversation = await createCreativeConversation("user", { surface: "chat", source: "image-workbench" });
        const input = { userId: "user", conversationId: conversation.id, userContent: "相同提示词", assistantContent: "已收到生成需求。", runId: "request-one" };
        const first = await appendCreativeConversationExchange(input);
        const replay = await appendCreativeConversationExchange(input);
        const second = await appendCreativeConversationExchange({ ...input, runId: "request-two" });

        expect(replay).toEqual(first);
        expect(second.userMessage.id).not.toBe(first.userMessage.id);
        expect((await listCreativeMessages(conversation.id)).filter((message) => message.role === "user")).toHaveLength(2);
    });

    it("filters conversation sources before applying pagination", async () => {
        const agent = await createCreativeConversation("user", { surface: "chat", source: "agent", title: "Agent" });
        await createCreativeConversation("user", { surface: "chat", source: "image-workbench", title: "Image" });
        await createCreativeConversation("user", { surface: "chat", source: "video-workbench", title: "Video" });

        expect(await listCreativeConversations("user", { surface: "chat", source: "agent", limit: 1 })).toEqual([agent]);
    });

    it("filters project conversations before applying pagination", async () => {
        const first = await createCreativeConversation("user", { surface: "drama", source: "drama", projectId: "project-one", title: "第一条" });
        await createCreativeConversation("user", { surface: "drama", source: "drama", projectId: "project-two", title: "其他项目" });
        const second = await createCreativeConversation("user", { surface: "drama", source: "drama", projectId: "project-one", title: "第二条" });

        expect(await listCreativeConversations("user", { surface: "drama", source: "drama", projectId: "project-one", limit: 2 })).toEqual([second, first]);
    });

    it("loads the newest page first and can page backward through long conversations", async () => {
        const now = Date.now();
        mocks.files.set("creative-runtime.json", {
            version: 1,
            nextEventId: 1,
            conversations: [],
            assets: [],
            events: [],
            messages: Array.from({ length: 240 }, (_, index) => ({
                id: `message-${index + 1}`,
                conversationId: "long",
                sequence: index + 1,
                role: index % 2 ? "assistant" : "user",
                status: "completed",
                content: String(index + 1),
                metadata: {},
                createdAt: now,
                updatedAt: now,
            })),
        });

        const latest = await listCreativeMessages("long", 0, 200);
        const older = await listCreativeMessages("long", 0, 200, latest[0].sequence);

        expect(latest[0].sequence).toBe(41);
        expect(latest.at(-1)?.sequence).toBe(240);
        expect(older.map((item) => item.sequence)).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
    });
});

function createBundle(value: AgentRun, assetIds: string[] = [], conversationId?: string) {
    return createCreativeRunBundle("user", { run: value, conversationId, prompt: value.prompt, title: "测试会话", assetIds, ttlMs: 60_000 });
}

function run(patch: Partial<AgentRun> = {}): AgentRun {
    const now = Date.now();
    return {
        id: "run-one",
        userId: "user",
        conversationId: "conversation",
        clientRequestId: "request-one",
        surface: "chat",
        inputMessageId: "input-message",
        assistantMessageId: "assistant-message",
        prompt: "生成一张图",
        referencedAssetIds: [],
        assetIds: [],
        status: "planning",
        tasks: [],
        reviewed: false,
        createdAt: now,
        updatedAt: now,
        ...patch,
    };
}
