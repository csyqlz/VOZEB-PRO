import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentRun } from "./agent-run-store";

const mocks = vi.hoisted(() => ({ createCreativeRunBundle: vi.fn(), getCreativeAssetsByIds: vi.fn(), getDramaProject: vi.fn(), mutateCreativeRun: vi.fn() }));

vi.mock("./creative-runtime-store", () => ({
    createCreativeRunBundle: mocks.createCreativeRunBundle,
    getCreativeAssetsByIds: mocks.getCreativeAssetsByIds,
    getCreativeRunByClientRequestId: vi.fn(),
    mutateCreativeRun: mocks.mutateCreativeRun,
}));
vi.mock("./drama-project-store", () => ({ getDramaProject: mocks.getDramaProject }));
vi.mock("./generation-task-store", () => ({ getStoredGenerationTask: vi.fn(), listStoredGenerationTasks: vi.fn() }));

import { createAgentRun, setAgentRunStatus, updateAgentRunById, updateAgentRunTaskById } from "./agent-run-store";

describe("createAgentRun video frames", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.createCreativeRunBundle.mockImplementation(async (_userId, input) => input.run);
    });

    it("accepts ready image frames owned by the current user", async () => {
        mocks.getCreativeAssetsByIds.mockResolvedValue([
            { id: "first-image", userId: "user", type: "image", status: "ready" },
            { id: "last-image", userId: "user", type: "image", status: "ready" },
        ]);

        await expect(createAgentRun("user", frameRunRequest())).resolves.toMatchObject({
            referencedAssetIds: ["first-image", "last-image"],
            generationPreferences: { video: { referenceMode: "first_last", firstFrameAssetId: "first-image", lastFrameAssetId: "last-image" } },
        });
    });

    it.each([
        [[{ id: "first-image", userId: "other-user", type: "image", status: "ready" }], "视频首尾帧图片不存在或已失效"],
        [[{ id: "first-image", userId: "user", type: "video", status: "ready" }], "视频首尾帧只能使用图片素材"],
        [[{ id: "first-image", userId: "user", type: "image", status: "deleted" }], "视频首尾帧图片不存在或已失效"],
    ])("rejects invalid frame assets", async (assets, message) => {
        mocks.getCreativeAssetsByIds.mockResolvedValue(assets);

        await expect(createAgentRun("user", frameRunRequest({ lastFrameAssetId: undefined, referenceMode: "first_frame", assetIds: ["first-image"] }))).rejects.toThrow(message);
        expect(mocks.createCreativeRunBundle).not.toHaveBeenCalled();
    });
});

describe("createAgentRun Canvas snapshot", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.createCreativeRunBundle.mockImplementation(async (_userId, input) => input);
    });

    it("persists one trusted compact snapshot with exact config size and one-hop context", async () => {
        const created = await createAgentRun("user", {
            clientRequestId: "request-canvas",
            surface: "canvas",
            projectId: "trusted-project",
            prompt: "按当前配置修改商品图",
            assetIds: [],
            skillIds: [],
            modelIds: [],
            snapshot: {
                projectId: "spoofed-project",
                imageSize: "1:1",
                selectedNodeIds: ["selected", "selected"],
                nodes: [
                    { id: "config", type: "config", title: "配置", metadata: { size: "1824x1024" } },
                    {
                        id: "selected",
                        type: "image",
                        title: "商品",
                        width: 400,
                        height: 600,
                        metadata: { content: `data:image/png;base64,${"binary-marker".repeat(20_000)}`, prompt: "红色商品包装", serverUrl: "/api/reference-assets/current", naturalWidth: 800, naturalHeight: 1200 },
                    },
                    { id: "related", type: "text", title: "文案", metadata: { content: "红色包装" } },
                    { id: "unrelated", type: "image", title: "旧图", metadata: { serverUrl: "/api/reference-assets/old" } },
                ],
                connections: [{ id: "edge", fromNodeId: "related", toNodeId: "selected" }],
                viewport: { x: 100, y: 200, k: 0.5 },
            },
        });

        expect(created.run.snapshot).toMatchObject({
            canvasSnapshotVersion: 1,
            projectId: "trusted-project",
            imageSize: "1:1",
            selectedNodeIds: ["selected"],
            analysis: { nodeCount: 4, selectedNodeTypes: ["image"] },
        });
        expect((created.run.snapshot as { nodes: Array<{ id: string; metadata: Record<string, unknown> }> }).nodes.map((node) => node.id)).toEqual(["config", "selected", "related"]);
        expect((created.run.snapshot as { nodes: Array<{ id: string; metadata: Record<string, unknown> }> }).nodes[0]?.metadata.size).toBe("1824x1024");
        expect((created.run.snapshot as { nodes: Array<{ id: string; metadata: Record<string, unknown> }> }).nodes[1]?.metadata).toMatchObject({ content: "红色商品包装", url: "/api/reference-assets/current" });
        expect(JSON.stringify(created.run.snapshot)).not.toContain("binary-marker");
        expect(created.run.snapshot).not.toHaveProperty("viewport");
        expect(mocks.createCreativeRunBundle).toHaveBeenCalledWith("user", expect.objectContaining({ run: expect.objectContaining({ snapshot: created.run.snapshot }) }));
    });

    it("keeps the complete compact Canvas when the current turn has no selected nodes", async () => {
        const created = await createAgentRun("user", {
            clientRequestId: "request-canvas-all",
            surface: "canvas",
            projectId: "project",
            prompt: "总结当前画布",
            assetIds: [],
            skillIds: [],
            modelIds: [],
            snapshot: {
                selectedNodeIds: [],
                nodes: [
                    { id: "one", type: "text", title: "一", metadata: { content: "第一段" } },
                    { id: "two", type: "image", title: "二", metadata: { url: "/api/reference-assets/two" } },
                ],
                connections: [{ id: "edge", fromNodeId: "one", toNodeId: "two" }],
            },
        });

        expect((created.run.snapshot as { nodes: unknown[]; connections: unknown[]; analysis: { nodeCount: number } }).nodes).toHaveLength(2);
        expect((created.run.snapshot as { nodes: unknown[]; connections: unknown[]; analysis: { nodeCount: number } }).connections).toHaveLength(1);
        expect((created.run.snapshot as { nodes: unknown[]; connections: unknown[]; analysis: { nodeCount: number } }).analysis.nodeCount).toBe(2);
    });
});

describe("createAgentRun Drama snapshot", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.createCreativeRunBundle.mockImplementation(async (_userId, input) => input);
        mocks.getDramaProject.mockResolvedValue({
            id: "drama-project",
            title: "短剧",
            summary: "项目摘要",
            style: "电影感",
            ratio: "9:16",
            status: "active",
            activeEpisodeId: "episode-current",
            characters: [{ id: "character-one" }],
            scenes: [],
            props: [],
            clues: [],
            episodes: [{ id: "episode-current", title: "第一集", script: "权威剧本", shots: [] }],
        });
    });

    it("hydrates the authoritative project while keeping only transient turn fields from the client", async () => {
        const created = await createAgentRun("user", {
            clientRequestId: "request-drama",
            surface: "drama",
            projectId: "drama-project",
            prompt: "继续当前剧本",
            assetIds: [],
            skillIds: [],
            modelIds: [],
            snapshot: {
                currentStage: "storyboard",
                selectedShotId: "shot-one",
                currentTurnReferences: [{ id: "asset-one" }],
                characters: [{ id: "spoofed-character" }],
            },
        });

        expect(mocks.getDramaProject).toHaveBeenCalledWith("drama-project", "user");
        expect(created.run.snapshot).toMatchObject({
            id: "drama-project",
            currentStage: "storyboard",
            selectedShotId: "shot-one",
            currentTurnReferences: [{ id: "asset-one" }],
            project: { ratio: "9:16" },
            episode: { id: "episode-current", script: "权威剧本" },
            characters: [{ id: "character-one" }],
        });
    });
});

describe("setAgentRunStatus", () => {
    beforeEach(() => vi.clearAllMocks());

    it("settles active Canvas tasks and emits terminal node operations when cancelled", async () => {
        const run = canvasRun();
        let mutation: Record<string, unknown> | null = null;
        mocks.mutateCreativeRun.mockImplementation(async (_id, _ttl, mutate) => {
            mutation = mutate(run);
            return mutation && "run" in mutation ? mutation.run : null;
        });

        const updated = await setAgentRunStatus(run, "cancelled");

        expect(updated).toMatchObject({ status: "cancelled", tasks: [{ status: "cancelled", childTasks: [{ status: "cancelled" }] }, { status: "completed" }] });
        expect(mutation).toMatchObject({
            event: {
                type: "run.cancelled",
                data: {
                    ops: [
                        { type: "update_node", id: "task-run-0", metadata: { agentTaskStatus: "cancelled", agentTaskError: "任务已取消" } },
                        { type: "update_node", id: "output-run-0-0", metadata: { status: "cancelled", agentTaskStatus: "cancelled", errorDetails: "任务已取消" } },
                    ],
                },
            },
        });
    });

    it("merges concurrent child task and asset updates without dropping earlier results", async () => {
        let current = canvasRun();
        current = { ...current, tasks: [{ ...current.tasks[0], count: 2, status: "running", childTasks: [] }], assetIds: [] };
        const events: Array<Record<string, unknown>> = [];
        mocks.mutateCreativeRun.mockImplementation(async (_id, _ttl, mutate) => {
            const mutation = mutate(current);
            if (!mutation) return null;
            events.push(mutation.event);
            current = mutation.run;
            return current;
        });

        await Promise.all([
            updateAgentRunTaskById("run", "image", { taskIds: ["child-one"], childTasks: [{ id: "child-one", status: "completed", attempt: 1, result: { url: "one" } }], assetIds: ["asset-one"] }, "task.child.completed", "execution"),
            updateAgentRunTaskById("run", "image", { taskIds: ["child-two"], childTasks: [{ id: "child-two", status: "completed", attempt: 1, result: { url: "two" } }], assetIds: ["asset-two"] }, "task.child.completed", "execution"),
        ]);

        expect(current.assetIds).toEqual(["asset-one", "asset-two"]);
        expect(current.timings?.firstResultReadyAt).toEqual(expect.any(Number));
        expect(current.tasks[0]).toMatchObject({
            taskIds: ["child-one", "child-two"],
            assetIds: ["asset-one", "asset-two"],
            childTasks: [
                { id: "child-one", status: "completed", result: { url: "one" } },
                { id: "child-two", status: "completed", result: { url: "two" } },
            ],
        });
        expect(events).toEqual([
            expect.objectContaining({ data: expect.objectContaining({ completedCount: 1, failedCount: 0, totalCount: 2, outputNodeIds: ["output-run-0-0"] }) }),
            expect.objectContaining({ data: expect.objectContaining({ completedCount: 2, failedCount: 0, totalCount: 2, outputNodeIds: ["output-run-0-1"] }) }),
        ]);
    });

    it("marks only the failed child output and keeps successful sibling assets", async () => {
        let current = { ...canvasRun(), tasks: [{ ...canvasRun().tasks[0], count: 2, childTasks: [] }], assetIds: [] };
        const events: Array<Record<string, unknown>> = [];
        mocks.mutateCreativeRun.mockImplementation(async (_id, _ttl, mutate) => {
            const mutation = mutate(current);
            if (!mutation) return null;
            events.push(mutation.event);
            current = mutation.run;
            return current;
        });

        await updateAgentRunTaskById("run", "image", { taskIds: ["child-one"], childTasks: [{ id: "child-one", status: "completed", attempt: 1, result: { serverUrl: "/one.webp" } }], assetIds: ["asset-one"] }, "task.child.completed", "execution");
        await updateAgentRunTaskById("run", "image", { taskIds: ["child-two"], childTasks: [{ id: "child-two", status: "failed", attempt: 1, error: "上游拒绝" }] }, "task.child.failed", "execution");

        expect(current.assetIds).toEqual(["asset-one"]);
        expect(current.tasks[0].childTasks).toEqual([expect.objectContaining({ id: "child-one", status: "completed" }), expect.objectContaining({ id: "child-two", status: "failed" })]);
        expect(events[1]).toMatchObject({
            data: {
                completedCount: 1,
                failedCount: 1,
                totalCount: 2,
                outputNodeIds: ["output-run-0-1"],
                ops: [
                    { type: "update_node", id: "output-run-0-1", metadata: { status: "error", errorDetails: "上游拒绝" } },
                    { type: "update_node", id: "task-run-0", metadata: { agentTaskStatus: "running", agentTaskCompletedCount: 1, agentTaskFailedCount: 1 } },
                ],
            },
        });
    });

    it("keeps internal foundation and review out of the completed conversation message", async () => {
        const run = {
            ...canvasRun(),
            foundation: { complexity: "simple" as const, brief: { objective: "内部简报" }, direction: { summary: "内部方向" } },
            review: { mode: "text" as const, status: "passed" as const, summary: "内部复盘", issues: [], retryTaskIds: [] },
        };
        let mutation: Record<string, unknown> | null = null;
        mocks.mutateCreativeRun.mockImplementation(async (_id, _ttl, mutate) => {
            mutation = mutate(run);
            return mutation && "run" in mutation ? mutation.run : null;
        });

        await updateAgentRunById("run", { status: "completed" }, { type: "run.completed", data: { reply: "创作任务已完成。" } }, ["running"]);

        expect(mutation).toMatchObject({
            assistant: {
                status: "completed",
                content: "创作任务已完成。",
                metadata: { assetIds: [], taskIds: [] },
            },
        });
        expect((mutation as { assistant?: { metadata?: Record<string, unknown> } } | null)?.assistant?.metadata).not.toHaveProperty("foundation");
        expect((mutation as { assistant?: { metadata?: Record<string, unknown> } } | null)?.assistant?.metadata).not.toHaveProperty("review");
    });

    it("persists background review without rewriting the completed assistant message", async () => {
        const run = { ...canvasRun(), status: "completed" as const };
        let mutation: Record<string, unknown> | null = null;
        mocks.mutateCreativeRun.mockImplementation(async (_id, _ttl, mutate) => {
            mutation = mutate(run);
            return mutation && "run" in mutation ? mutation.run : null;
        });

        await updateAgentRunById("run", { reviewed: true }, { type: "run.review.background", data: { status: "passed", issueCount: 0 } }, ["completed"]);

        expect(mutation).toMatchObject({ run: { status: "completed", reviewed: true }, event: { type: "run.review.background" } });
        expect((mutation as { assistant?: unknown } | null)?.assistant).toBeUndefined();
    });
});

function canvasRun(): AgentRun {
    return {
        id: "run",
        userId: "user",
        conversationId: "conversation",
        clientRequestId: "request",
        surface: "canvas",
        projectId: "project",
        inputMessageId: "input",
        assistantMessageId: "assistant",
        prompt: "prompt",
        referencedAssetIds: [],
        assetIds: [],
        status: "running",
        executionId: "execution",
        tasks: [
            { id: "image", title: "图片", type: "image", prompt: "prompt", count: 1, dependencies: [], status: "running", attempts: 1, childTasks: [{ id: "child", status: "pending", attempt: 1 }] },
            { id: "text", title: "文案", type: "text", prompt: "prompt", count: 1, dependencies: [], status: "completed", attempts: 1 },
        ],
        reviewed: false,
        createdAt: 1,
        updatedAt: 2,
    };
}

function frameRunRequest(overrides: { referenceMode?: "first_frame" | "first_last"; firstFrameAssetId?: string; lastFrameAssetId?: string; assetIds?: string[] } = {}) {
    return {
        clientRequestId: "request-frames",
        surface: "chat" as const,
        prompt: "让首尾画面自然衔接",
        assetIds: overrides.assetIds || ["first-image", "last-image"],
        skillIds: [],
        modelIds: [],
        preferences: {
            mode: "video" as const,
            video: {
                referenceMode: overrides.referenceMode || "first_last",
                firstFrameAssetId: overrides.firstFrameAssetId || "first-image",
                ...(overrides.lastFrameAssetId === undefined && overrides.referenceMode === "first_frame" ? {} : { lastFrameAssetId: overrides.lastFrameAssetId || "last-image" }),
            },
        },
    };
}
