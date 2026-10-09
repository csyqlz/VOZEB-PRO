import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentRun } from "./agent-run-store";

const mocks = vi.hoisted(() => ({
    createCreativeRunBundle: vi.fn(),
    getCanvasProject: vi.fn(),
    getCreativeAssetsByIds: vi.fn(),
    getDramaProject: vi.fn(),
    getStoredGenerationTask: vi.fn(),
    mutateCreativeRun: vi.fn(),
    queryStoredGenerationTasks: vi.fn(),
}));

vi.mock("./creative-runtime-store", () => ({
    createCreativeRunBundle: mocks.createCreativeRunBundle,
    getCreativeAssetsByIds: mocks.getCreativeAssetsByIds,
    getCreativeRunByClientRequestId: vi.fn(),
    mutateCreativeRun: mocks.mutateCreativeRun,
}));
vi.mock("./drama-project-store", () => ({ getDramaProject: mocks.getDramaProject }));
vi.mock("./generation-task-store", () => ({ getStoredGenerationTask: mocks.getStoredGenerationTask, listStoredGenerationTasks: vi.fn(), queryStoredGenerationTasks: mocks.queryStoredGenerationTasks }));
vi.mock("./canvas-project-store", () => ({ getCanvasProject: mocks.getCanvasProject }));

import { createAgentRun, createEditBranch, selectCurrentSceneBaseline, setAgentRunStatus, updateAgentRunById, updateAgentRunTaskById } from "./agent-run-store";

describe("ecommerce result continuity store", () => {
    beforeEach(() => vi.clearAllMocks());

    it.each(["disabled", "advisory"])("inherits delivered %s results without requiring visual approval", async (qualityPolicy) => {
        const run = {
            ...canvasRun(),
            id: "delivered",
            surface: "chat",
            status: "completed",
            assetIds: ["delivered-image"],
            ecommerceSnapshot: {
                ...passedSnapshot(),
                mode: "active",
                qualityPolicy,
                technicalCheck: { status: "passed", checks: [], hardFailures: [] },
                qualityCheck: qualityPolicy === "disabled" ? undefined : { status: "blocked", publicStatus: "needs_review", checks: [], hardFailures: [{ key: "protected_structure", status: "failed" }] },
            },
        } as unknown as AgentRun;
        const result = { id: "delivered-image", userId: "user", conversationId: "conversation", type: "image", status: "ready", sourceRunId: run.id, parentAssetId: "product", metadata: { ecommerceContinuity: { productAnchorId: "product" } } };
        const sources = [productAsset("product"), result];
        mocks.queryStoredGenerationTasks.mockResolvedValue([run]);
        mocks.getStoredGenerationTask.mockResolvedValue(run);
        mocks.getCreativeAssetsByIds.mockImplementation(async (ids: string[]) => sources.filter((asset) => ids.includes(asset.id)));
        await expect(selectCurrentSceneBaseline("conversation", undefined, "user")).resolves.toMatchObject({ id: result.id });
        await expect(selectCurrentSceneBaseline("conversation", result.id, "user")).resolves.toMatchObject({ id: result.id });
        result.userId = "other-user";
        await expect(selectCurrentSceneBaseline("conversation", result.id, "user")).resolves.toBeNull();
        result.userId = "user";
        sources.shift();
        await expect(selectCurrentSceneBaseline("conversation", undefined, "user")).resolves.toBeNull();
    });

    it("selects only passed scene results and preserves explicitly selected adjustment evidence", async () => {
        const root = { id: "scene-root", userId: "user", conversationId: "conversation", type: "image", status: "ready", sourceRunId: "upload", metadata: {} };
        const quality = { status: "passed", publicStatus: "passed", checks: [], hardFailures: [] };
        const passed = {
            ...canvasRun(),
            id: "run-scene-passed",
            surface: "chat",
            status: "completed",
            assetIds: ["asset-scene-passed"],
            updatedAt: 10,
            ecommerceSnapshot: { plan: { operation: "scene_edit", source: { productAnchorId: null, currentSceneBaselineId: root.id } }, continuity: { sceneRootAssetId: root.id, parentResultId: null, branchId: "scene-branch" }, qualityCheck: quality },
        } as unknown as AgentRun;
        const adjustment = {
            ...passed,
            id: "run-scene-adjustment",
            assetIds: ["asset-scene-adjustment"],
            updatedAt: 20,
            ecommerceSnapshot: { ...passed.ecommerceSnapshot, qualityCheck: { ...quality, status: "needs_adjustment", publicStatus: "needs_adjustment", checks: [{ key: "scene_aesthetics", status: "failed", reason: "vase is too large" }] } },
        } as unknown as AgentRun;
        const assets = [
            root,
            ...[passed, adjustment].map((run) => ({
                id: run.assetIds[0],
                userId: "user",
                conversationId: "conversation",
                type: "image",
                status: "ready",
                sourceRunId: run.id,
                parentAssetId: root.id,
                metadata: { ecommerceContinuity: run.ecommerceSnapshot!.continuity },
            })),
        ];
        mocks.queryStoredGenerationTasks.mockResolvedValue([adjustment, passed]);
        mocks.getStoredGenerationTask.mockImplementation(async (_type, id) => [passed, adjustment].find((run) => run.id === id));
        mocks.getCreativeAssetsByIds.mockImplementation(async (ids: string[]) => assets.filter((asset) => ids.includes(asset.id)));
        await expect(selectCurrentSceneBaseline("conversation", undefined, "user")).resolves.toMatchObject({ id: "asset-scene-passed" });
        await expect(selectCurrentSceneBaseline("conversation", "asset-scene-adjustment", "user")).resolves.toMatchObject({
            id: "asset-scene-adjustment",
            metadata: { ecommerceContinuity: { parentQualityCheck: { status: "needs_adjustment", checks: [{ reason: "vase is too large" }] } } },
        });
        await expect(selectCurrentSceneBaseline("other-conversation", "asset-scene-passed", "user")).resolves.toBeNull();
        await expect(selectCurrentSceneBaseline("conversation", "asset-scene-passed", "other-user")).resolves.toBeNull();
        for (const status of ["blocked", "unavailable"] as const) {
            adjustment.ecommerceSnapshot!.qualityCheck = { ...adjustment.ecommerceSnapshot!.qualityCheck!, status, publicStatus: "needs_review" };
            await expect(selectCurrentSceneBaseline("conversation", undefined, "user")).resolves.toMatchObject({ id: "asset-scene-passed" });
            await expect(selectCurrentSceneBaseline("conversation", "asset-scene-adjustment", "user")).resolves.toBeNull();
        }
        root.conversationId = "other-conversation";
        await expect(selectCurrentSceneBaseline("conversation", "asset-scene-passed", "user")).resolves.toBeNull();
    });

    it("does not switch to an older branch when its background review updates later", async () => {
        const earlier = { ...canvasRun(), id: "earlier", surface: "chat", status: "completed", assetIds: ["earlier-result"], createdAt: 10, updatedAt: 100, ecommerceSnapshot: passedSnapshot() };
        const latest = { ...earlier, id: "latest", assetIds: ["latest-result"], createdAt: 20, updatedAt: 30 };
        mocks.queryStoredGenerationTasks.mockResolvedValue([earlier, latest]);
        const assets = [
            productAsset("product"),
            ...[earlier, latest].map((run) => ({
                id: run.assetIds[0],
                userId: "user",
                conversationId: "conversation",
                type: "image",
                status: "ready",
                sourceRunId: run.id,
                parentAssetId: "product",
                metadata: { ecommerceContinuity: { productAnchorId: "product" } },
            })),
        ];
        mocks.getCreativeAssetsByIds.mockImplementation(async (ids: string[]) => assets.filter((asset) => ids.includes(asset.id)));
        await expect(selectCurrentSceneBaseline("conversation", undefined, "user")).resolves.toMatchObject({ id: "latest-result" });
    });

    it("selects the newest successful image result and skips failed or unrelated runs", async () => {
        const earlier = { ...canvasRun(), id: "run-earlier", surface: "chat" as const, status: "completed" as const, assetIds: ["result-earlier"], updatedAt: 10, ecommerceSnapshot: passedSnapshot() };
        const newer = { ...earlier, id: "run-newer", assetIds: ["result-newer"], updatedAt: 20 };
        const failed = { ...earlier, id: "run-failed", status: "failed" as const, assetIds: ["result-failed"], updatedAt: 30 };
        mocks.queryStoredGenerationTasks.mockResolvedValue([failed, earlier, newer]);
        mocks.getCreativeAssetsByIds.mockResolvedValue([
            productAsset("product"),
            { id: "result-earlier", userId: "user", conversationId: "conversation", type: "image", status: "ready", sourceRunId: earlier.id, parentAssetId: "product", metadata: { ecommerceContinuity: { productAnchorId: "product" } } },
            { id: "result-newer", userId: "user", conversationId: "conversation", type: "image", status: "ready", sourceRunId: newer.id, parentAssetId: "product", metadata: { ecommerceContinuity: { productAnchorId: "product" } } },
        ]);

        await expect(selectCurrentSceneBaseline("conversation", undefined, "user")).resolves.toMatchObject({ id: "result-newer" });
        expect(mocks.queryStoredGenerationTasks).toHaveBeenCalledWith("agent", expect.objectContaining({ userId: "user", conversationId: "conversation" }));
    });

    it("does not promote an unrelated completed image with a parent asset into the scene baseline", async () => {
        const generic = { ...canvasRun(), id: "run-generic", surface: "chat" as const, status: "completed" as const, assetIds: ["result-generic"] };
        mocks.queryStoredGenerationTasks.mockResolvedValue([generic]);
        mocks.getCreativeAssetsByIds.mockResolvedValue([{ id: "result-generic", userId: "user", conversationId: "conversation", type: "image", status: "ready", sourceRunId: generic.id, parentAssetId: "generic-reference", metadata: {} }]);

        await expect(selectCurrentSceneBaseline("conversation", undefined, "user")).resolves.toBeNull();
    });

    it("does not automatically inherit a legacy result without QA evidence", async () => {
        const prior = {
            ...canvasRun(),
            id: "run-legacy-ecommerce",
            surface: "chat" as const,
            status: "completed" as const,
            assetIds: ["result-legacy-ecommerce"],
            ecommerceSnapshot: { plan: { source: { productAnchorId: "product-original" } } } as AgentRun["ecommerceSnapshot"],
        };
        mocks.queryStoredGenerationTasks.mockResolvedValue([prior]);
        mocks.getCreativeAssetsByIds.mockResolvedValue([{ id: "result-legacy-ecommerce", userId: "user", conversationId: "conversation", type: "image", status: "ready", sourceRunId: prior.id, parentAssetId: "product-original", metadata: {} }]);

        await expect(selectCurrentSceneBaseline("conversation", undefined, "user")).resolves.toBeNull();
    });

    it("selects an explicit older result by ID and rejects another user's result", async () => {
        const previous = { ...canvasRun(), id: "run-previous", surface: "chat" as const, status: "completed" as const, assetIds: ["result-previous"], ecommerceSnapshot: passedSnapshot() };
        mocks.queryStoredGenerationTasks.mockResolvedValue([previous]);
        mocks.getStoredGenerationTask.mockResolvedValue(previous);
        mocks.getCreativeAssetsByIds.mockResolvedValue([
            productAsset("product"),
            { id: "result-previous", userId: "user", conversationId: "conversation", type: "image", status: "ready", sourceRunId: previous.id, parentAssetId: "product", metadata: { ecommerceContinuity: { productAnchorId: "product" } } },
        ]);

        await expect(selectCurrentSceneBaseline("conversation", "result-previous", "user")).resolves.toMatchObject({ id: "result-previous" });
        mocks.getCreativeAssetsByIds.mockResolvedValue([
            { id: "result-previous", userId: "other-user", conversationId: "conversation", type: "image", status: "ready", sourceRunId: previous.id, parentAssetId: "product", metadata: { ecommerceContinuity: { productAnchorId: "product" } } },
        ]);
        await expect(selectCurrentSceneBaseline("conversation", "result-previous", "user")).resolves.toBeNull();
    });

    it("rejects an explicit generic image while retaining explicit older ecommerce selection", async () => {
        const generic = { ...canvasRun(), id: "run-generic", surface: "chat" as const, status: "completed" as const, assetIds: ["result-generic"] };
        const ecommerce = { ...generic, id: "run-ecommerce", assetIds: ["result-ecommerce"], ecommerceSnapshot: { ...passedSnapshot(), plan: { source: { productAnchorId: "product-original" } } } as AgentRun["ecommerceSnapshot"] };
        const assets = [
            productAsset("product-original"),
            { id: "result-generic", userId: "user", conversationId: "conversation", type: "image", status: "ready", sourceRunId: generic.id, parentAssetId: "generic-reference", metadata: {} },
            { id: "result-ecommerce", userId: "user", conversationId: "conversation", type: "image", status: "ready", sourceRunId: ecommerce.id, parentAssetId: "product-original", metadata: {} },
        ];
        mocks.getCreativeAssetsByIds.mockImplementation(async (ids: string[]) => assets.filter((asset) => ids.includes(asset.id)));
        mocks.getStoredGenerationTask.mockImplementation(async (_type: string, id: string) => (id === generic.id ? generic : ecommerce));

        await expect(selectCurrentSceneBaseline("conversation", generic.assetIds[0], "user")).resolves.toBeNull();
        await expect(selectCurrentSceneBaseline("conversation", ecommerce.assetIds[0], "user")).resolves.toMatchObject({ id: "result-ecommerce" });
    });

    it("persists a new branch on the current run without mutating the parent result", async () => {
        const parent = { id: "result-parent", metadata: { ecommerceContinuity: { productAnchorId: "product-original" } } };
        const previous = { ...canvasRun(), id: "parent-run", surface: "chat", status: "completed", assetIds: [parent.id], ecommerceSnapshot: passedSnapshot("product-original") };
        mocks.getStoredGenerationTask.mockResolvedValue(previous);
        mocks.getCreativeAssetsByIds.mockResolvedValue([productAsset("product-original"), { ...parent, userId: "user", conversationId: "conversation", sourceRunId: previous.id, type: "image", status: "ready", parentAssetId: "product-original" }]);
        let current = { ...canvasRun(), id: "run-child", surface: "chat" as const, status: "running" as const };
        mocks.mutateCreativeRun.mockImplementation(async (id, _ttl, mutate) => {
            expect(id).toBe(current.id);
            const mutation = mutate(current);
            current = mutation.run;
            return current;
        });

        const branch = await createEditBranch(parent.id, current);
        const recovered = JSON.parse(JSON.stringify(current)) as AgentRun;

        expect(branch).toMatchObject({ parentResultId: parent.id, branchId: "ecommerce-run-child" });
        expect(recovered.ecommerceSnapshot?.continuity).toEqual(branch);
        expect(parent).toEqual({ id: "result-parent", metadata: { ecommerceContinuity: { productAnchorId: "product-original" } } });
    });
});

function productAsset(id: string) {
    return { id, userId: "user", conversationId: "conversation", type: "image", status: "ready", sourceRunId: "upload", metadata: {} };
}

function passedSnapshot(productAnchorId = "product"): AgentRun["ecommerceSnapshot"] {
    return { plan: { source: { productAnchorId } }, qualityCheck: { status: "passed", publicStatus: "passed", hardFailures: [], checks: [] } } as unknown as AgentRun["ecommerceSnapshot"];
}

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
        mocks.getCanvasProject.mockImplementation(async (projectId: string) => ({ id: projectId }));
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
describe("large Canvas snapshot", () => {
    it("hydrates an oversized client snapshot from the authorized Canvas project", async () => {
        mocks.createCreativeRunBundle.mockImplementation(async (_userId, input) => input);
        mocks.getCanvasProject.mockResolvedValue({
            id: "large-project",
            title: "服务端画布",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            nodes: [{ id: "image", type: "image", title: "图片", width: 100, height: 100, position: { x: 0, y: 0 }, metadata: { prompt: "服务端内容", serverUrl: "/api/reference-assets/image" } }],
            connections: [],
            chatSessions: [],
            activeChatId: null,
            backgroundMode: "grid",
            showImageInfo: false,
            viewport: { x: 0, y: 0, k: 1 },
        });
        const created = await createAgentRun("user", {
            clientRequestId: "request-canvas-large",
            surface: "canvas",
            projectId: "large-project",
            prompt: "继续编辑",
            assetIds: [],
            skillIds: [],
            modelIds: [],
            snapshot: { selectedNodeIds: ["image"], value: "x".repeat(513 * 1024) },
        });

        expect(mocks.getCanvasProject).toHaveBeenCalledWith("large-project", "user");
        expect(created.run.snapshot).toMatchObject({ projectId: "large-project", title: "服务端画布", selectedNodeIds: ["image"] });
        expect(JSON.stringify(created.run.snapshot)).not.toContain("x".repeat(1_000));
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

    it("rejects stale scene selection when tasks changed before the locked resume mutation", async () => {
        const original = { ...canvasRun(), status: "paused" as const, tasks: [{ ...canvasRun().tasks[0], status: "needs_review" as const, attempts: 0, childTasks: [] }] };
        let current = structuredClone(original);
        mocks.mutateCreativeRun.mockImplementation(async (_id, _ttl, mutate) => {
            const mutation = mutate(current);
            if (!mutation) return null;
            current = mutation.run;
            return current;
        });
        const tasks = [{ ...original.tasks[0], status: "ready" as const }];
        await expect(updateAgentRunById("run", { status: "running", tasks }, { type: "run.resumed" }, ["paused"], undefined, original.tasks)).resolves.toMatchObject({ status: "running", tasks });
        current = { ...current, status: "paused", tasks: [{ ...current.tasks[0], attempts: 1, taskId: "submitted-child" }] };
        const submitted = structuredClone(current);
        await expect(updateAgentRunById("run", { status: "running", tasks }, { type: "run.resumed" }, ["paused"], undefined, original.tasks)).resolves.toBeNull();
        expect(current).toEqual(submitted);
    });

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

    it("persists an actionable clarification question when a task needs review", async () => {
        const run = canvasRun();
        let mutation: Record<string, unknown> | null = null;
        mocks.mutateCreativeRun.mockImplementation(async (_id, _ttl, mutate) => {
            mutation = mutate(run);
            return mutation && "run" in mutation ? mutation.run : null;
        });

        await updateAgentRunById(
            "run",
            {
                status: "paused",
                tasks: [{ ...run.tasks[0], status: "needs_review", error: "请确认这张图片是商品图还是场景参考图。" }, run.tasks[1]],
            },
            { type: "task.needs_review", data: { taskId: "image", title: "商品图", error: "请确认这张图片是商品图还是场景参考图。" } },
            ["running"],
        );

        expect(mutation).toMatchObject({
            run: { status: "paused", tasks: [{ status: "needs_review" }, { status: "completed" }] },
            assistant: { status: "running", content: "请确认这张图片是商品图还是场景参考图。" },
        });
    });

    it.each([
        ["当前协议不支持可信独立蒙版，请选择支持局部编辑的模型。", "当前协议不支持可信独立蒙版，请选择支持局部编辑的模型。"],
        ["provider https://private.fixture.invalid api key fixture-secret", "生成渠道暂时无法连接，请稍后重试或联系管理员。"],
    ])("persists the saved review reason on pause instead of event text: %s", async (reason, expected) => {
        const original = canvasRun();
        const run = { ...original, tasks: [{ ...original.tasks[0], status: "needs_review" as const, error: reason }] };
        let mutation: Record<string, unknown> | null = null;
        mocks.mutateCreativeRun.mockImplementation(async (_id, _ttl, mutate) => {
            mutation = mutate(run);
            return mutation && "run" in mutation ? mutation.run : null;
        });

        await updateAgentRunById("run", { status: "paused" }, { type: "run.paused", data: { message: "untrusted https://event.fixture.invalid api key event-secret" } }, ["running"]);

        expect(mutation).toMatchObject({ assistant: { status: "running", content: expected } });
    });

    it.each([
        ["needs_review", undefined],
        ["needs_review", "   "],
        ["running", "existing progress"],
    ] as const)("does not rewrite the assistant for a pause without a saved review reason (%s, %s)", async (status, error) => {
        const original = canvasRun();
        const run = { ...original, tasks: [{ ...original.tasks[0], status, error }] };
        let mutation: Record<string, unknown> | null = null;
        mocks.mutateCreativeRun.mockImplementation(async (_id, _ttl, mutate) => {
            mutation = mutate(run);
            return mutation && "run" in mutation ? mutation.run : null;
        });

        await updateAgentRunById("run", { status: "paused" }, { type: "run.paused", data: { message: "任务已暂停" } }, ["running"]);

        expect((mutation as { assistant?: unknown } | null)?.assistant).toBeUndefined();
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
