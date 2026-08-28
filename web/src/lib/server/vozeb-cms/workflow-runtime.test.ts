import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredGenerationTaskRecord } from "@/lib/server/generation-task-types";
import type { VozebCmsWorkflowDefinition, VozebCmsWorkflowRun } from "@/lib/vozeb-cms/workflow-contract";

const mocks = vi.hoisted(() => ({
    definition: null as VozebCmsWorkflowDefinition | null,
    run: null as VozebCmsWorkflowRun | null,
    task: null as StoredGenerationTaskRecord | null,
    tasks: [] as StoredGenerationTaskRecord[],
    disabledModule: "" as string,
    events: [] as string[],
    assetError: null as Error | null,
    renewLease: vi.fn(),
    persistAsset: vi.fn(),
    controlTask: vi.fn(),
}));

vi.mock("@/lib/server/vozeb-cms/workflow-store", () => ({
    createVozebCmsWorkflowRun: vi.fn(async (run) => {
        mocks.run = run;
        return run;
    }),
    getVozebCmsWorkflowDefinition: vi.fn(async () => mocks.definition),
    getVozebCmsWorkflowRun: vi.fn(async () => mocks.run),
    claimVozebCmsWorkflowRun: vi.fn(async () => true),
    releaseVozebCmsWorkflowRunLease: vi.fn(async () => undefined),
    renewVozebCmsWorkflowRunLease: mocks.renewLease,
    mutateVozebCmsWorkflowRun: vi.fn(async (_userId, _runId, mutator) => {
        const mutation = mutator(mocks.run!);
        if (!mutation) return null;
        if (mutation.event) mocks.events.push(mutation.event.type);
        mocks.run = { ...mutation.run, version: mocks.run!.version + 1, updatedAt: Date.now() };
        return mocks.run;
    }),
}));
vi.mock("@/lib/server/generation-task-store", () => ({
    getStoredGenerationTaskRecordForUser: vi.fn(async (id: string) => mocks.tasks.find((task) => task.id === id) || (mocks.task?.id === id ? mocks.task : null)),
    listStoredGenerationTaskRecordsByRunIds: vi.fn(async () => [...(mocks.task ? [mocks.task] : []), ...mocks.tasks]),
}));
vi.mock("@/lib/server/vozeb-cms/unified-task-service", () => ({ controlVozebCmsTask: mocks.controlTask }));
vi.mock("@/lib/server/vozeb-cms/workflow-output", () => ({
    persistVozebCmsWorkflowOutputAssets: vi.fn(async () => {
        mocks.persistAsset();
        if (mocks.assetError) throw mocks.assetError;
    }),
}));
vi.mock("@/lib/server/vozeb-cms/module-service", () => {
    class VozebCmsModuleAccessError extends Error {
        constructor(
            message: string,
            readonly status: number,
        ) {
            super(message);
        }
    }
    return {
        VozebCmsModuleAccessError,
        assertVozebCmsModuleEnabled: vi.fn(async (moduleId: string) => {
            if (moduleId === mocks.disabledModule) throw new VozebCmsModuleAccessError(`${moduleId}模块已停用`, 403);
        }),
        assertVozebCmsUserCapability: vi.fn(async () => undefined),
    };
});

import { advanceVozebCmsWorkflowRun, controlVozebCmsWorkflowRun, createVozebCmsWorkflowRunForUser, reviewVozebCmsWorkflowNode } from "./workflow-runtime";
import { createVozebCmsWorkflowRun as createRun, normalizeVozebCmsWorkflowDefinition } from "@/lib/vozeb-cms/workflow-contract";

describe("VOZEBCMS workflow runtime", () => {
    beforeEach(() => {
        mocks.task = null;
        mocks.tasks = [];
        mocks.disabledModule = "";
        mocks.events = [];
        mocks.assetError = null;
        mocks.renewLease.mockReset().mockResolvedValue(true);
        mocks.persistAsset.mockReset();
        mocks.controlTask.mockReset();
        mocks.controlTask.mockResolvedValue(null);
        mocks.definition = normalizeVozebCmsWorkflowDefinition(
            {
                id: "workflow-drama",
                name: "短剧生产",
                nodes: [
                    { id: "script", kind: "condition", name: "剧本条件", config: { path: "scriptReady", equals: true } },
                    { id: "review", kind: "manual_review", name: "内容审核", dependsOn: ["script"] },
                    { id: "render", kind: "task", name: "视频生成", dependsOn: ["review"], config: { output: { assetId: "asset-video" } } },
                ],
            },
            "user-one",
        );
        mocks.run = createRun(mocks.definition!, "user-one", { scriptReady: true }, "request-one");
    });

    it("executes condition, waits for manual review, then completes the DAG", async () => {
        const created = await createVozebCmsWorkflowRunForUser("user-one", "workflow-drama", { scriptReady: true }, "request-one");
        expect(created.status).toBe("pending");
        const waiting = await advanceVozebCmsWorkflowRun("user-one", created.id);
        expect(waiting).toMatchObject({ status: "waiting", nodeStates: { script: { status: "success" }, review: { status: "waiting" } } });

        const completed = await reviewVozebCmsWorkflowNode("user-one", created.id, "review", "approved");
        expect(completed).toMatchObject({ status: "completed", nodeStates: { review: { status: "success", reviewDecision: "approved" }, render: { status: "success", output: { assetId: "asset-video" } } } });
    });

    it("keeps the run on its immutable definition revision after the stored definition changes", async () => {
        const created = await createVozebCmsWorkflowRunForUser("user-one", "workflow-drama", { scriptReady: true }, "request-one");
        mocks.definition = normalizeVozebCmsWorkflowDefinition(
            {
                id: "workflow-drama",
                name: "已更新流程",
                version: 2,
                nodes: [{ id: "replacement", kind: "task", name: "替代节点", config: { output: { changed: true } } }],
            },
            "user-one",
        );

        const waiting = await advanceVozebCmsWorkflowRun("user-one", created.id);
        expect(waiting).toMatchObject({ definitionVersion: 1, status: "waiting", nodeStates: { script: { status: "success" }, review: { status: "waiting" }, render: { status: "pending" } } });
        expect(waiting?.nodeStates.replacement).toBeUndefined();

        const completed = await reviewVozebCmsWorkflowNode("user-one", created.id, "review", "approved");
        expect(completed).toMatchObject({ definitionVersion: 1, status: "completed", nodeStates: { render: { status: "success", output: { assetId: "asset-video" } } } });
        expect(completed?.definitionSnapshot.nodes.map((node) => node.id)).toEqual(["script", "review", "render"]);
    });

    it("skips the dependent branch when a condition is false", async () => {
        mocks.run = createRun(mocks.definition!, "user-one", { scriptReady: false });
        const result = await advanceVozebCmsWorkflowRun("user-one", mocks.run.id);
        expect(result).toMatchObject({ status: "completed", nodeStates: { script: { status: "success", output: { result: false } }, review: { status: "skipped" }, render: { status: "skipped" } } });
    });

    it("rechecks a waiting task and continues after the existing worker task succeeds", async () => {
        mocks.definition = normalizeVozebCmsWorkflowDefinition({ id: "workflow-task", name: "任务恢复", nodes: [{ id: "generate", kind: "task", name: "生成", config: { taskId: "task-one" } }] }, "user-one");
        mocks.run = createRun(mocks.definition, "user-one", {});
        mocks.task = { id: "task-one", userId: "user-one", type: "video", status: "running", payload: {}, createdAt: 1, updatedAt: 1, expiresAt: Date.now() + 60_000 };

        const waiting = await advanceVozebCmsWorkflowRun("user-one", mocks.run.id);
        expect(waiting).toMatchObject({ status: "waiting", nodeStates: { generate: { status: "waiting", attempts: 1, taskId: "task-one" } } });

        mocks.task = { ...mocks.task, status: "success", resultPayload: { url: "https://example.test/result.mp4" } };
        const completed = await advanceVozebCmsWorkflowRun("user-one", mocks.run.id);
        expect(completed).toMatchObject({ status: "completed", nodeStates: { generate: { status: "success", attempts: 1, taskId: "task-one" } } });
    });

    it("keeps manual review outside maintenance polling and uses the bound task next poll time", async () => {
        const manual = await advanceVozebCmsWorkflowRun("user-one", mocks.run!.id);
        expect(manual).toMatchObject({ status: "waiting", nextRunAt: undefined, nodeStates: { review: { status: "waiting" } } });

        mocks.definition = normalizeVozebCmsWorkflowDefinition({ id: "workflow-task", name: "任务调度", nodes: [{ id: "generate", kind: "task", name: "生成", config: { taskId: "task-one" } }] }, "user-one");
        mocks.run = createRun(mocks.definition, "user-one", {});
        mocks.task = { id: "task-one", userId: "user-one", type: "video", status: "running", payload: {}, createdAt: 1, updatedAt: 1, expiresAt: Date.now() + 60_000, nextPollAt: 9_000 };

        const waiting = await advanceVozebCmsWorkflowRun("user-one", mocks.run.id);
        expect(waiting).toMatchObject({ status: "waiting", nextRunAt: 9_000 });
    });

    it("does not append duplicate events while repeatedly checking the same waiting task", async () => {
        mocks.definition = normalizeVozebCmsWorkflowDefinition({ id: "workflow-task", name: "任务恢复", nodes: [{ id: "generate", kind: "task", name: "生成", config: { taskId: "task-one" } }] }, "user-one");
        mocks.run = createRun(mocks.definition, "user-one", {});
        mocks.task = { id: "task-one", userId: "user-one", type: "video", status: "running", payload: {}, createdAt: 1, updatedAt: 1, expiresAt: Date.now() + 60_000, nextPollAt: 9_000 };

        await advanceVozebCmsWorkflowRun("user-one", mocks.run.id);
        const eventsAfterFirstCheck = [...mocks.events];
        await advanceVozebCmsWorkflowRun("user-one", mocks.run.id);

        expect(mocks.events).toEqual(eventsAfterFirstCheck);
    });

    it("delegates cancel and retry to the existing generation task state machine", async () => {
        mocks.definition = normalizeVozebCmsWorkflowDefinition({ id: "workflow-task", name: "任务控制", nodes: [{ id: "generate", kind: "task", name: "生成", config: { taskId: "task-one" } }] }, "user-one");
        mocks.run = createRun(mocks.definition, "user-one", {});
        mocks.run = { ...mocks.run, status: "waiting", nodeStates: { generate: { status: "waiting", attempts: 1, taskId: "task-one", updatedAt: 1 } } };
        mocks.task = { id: "task-one", userId: "user-one", type: "video", status: "running", payload: {}, createdAt: 1, updatedAt: 1, expiresAt: Date.now() + 60_000 };

        await controlVozebCmsWorkflowRun("user-one", mocks.run.id, "cancel");
        expect(mocks.controlTask).toHaveBeenCalledWith({ userId: "user-one", id: "task-one", action: "cancel", origin: "" });

        mocks.controlTask.mockClear();
        mocks.run = { ...mocks.run, status: "failed", nodeStates: { generate: { status: "failed", attempts: 1, taskId: "task-one", error: "失败", updatedAt: 1 } } };
        mocks.task = { ...mocks.task, status: "error", payload: { retryable: true } };
        await controlVozebCmsWorkflowRun("user-one", mocks.run.id, "retry");
        expect(mocks.controlTask).toHaveBeenCalledWith({ userId: "user-one", id: "task-one", action: "retry", origin: "" });
    });

    it("delegates cancellation for every task bound to a multi-shot node", async () => {
        mocks.definition = normalizeVozebCmsWorkflowDefinition({ id: "workflow-multi", name: "多镜头任务控制", nodes: [{ id: "video", kind: "task", name: "视频生成", config: { output: [] } }] }, "user-one");
        mocks.run = createRun(mocks.definition, "user-one", {});
        mocks.run = { ...mocks.run, status: "waiting", nodeStates: { video: { status: "waiting", attempts: 1, taskIds: ["task-one", "task-two"], updatedAt: 1 } } };
        mocks.tasks = [
            { id: "task-one", userId: "user-one", type: "video", status: "running", payload: {}, createdAt: 1, updatedAt: 1, expiresAt: Date.now() + 60_000 },
            { id: "task-two", userId: "user-one", type: "video", status: "pending", payload: {}, createdAt: 1, updatedAt: 1, expiresAt: Date.now() + 60_000 },
        ];

        await controlVozebCmsWorkflowRun("user-one", mocks.run.id, "cancel");

        expect(mocks.controlTask).toHaveBeenCalledTimes(2);
        expect(mocks.controlTask).toHaveBeenCalledWith({ userId: "user-one", id: "task-one", action: "cancel", origin: "" });
        expect(mocks.controlTask).toHaveBeenCalledWith({ userId: "user-one", id: "task-two", action: "cancel", origin: "" });
    });

    it("fails an unbound production node instead of polling forever", async () => {
        mocks.definition = normalizeVozebCmsWorkflowDefinition({ id: "workflow-unbound", name: "缺失 Action", nodes: [{ id: "generate", kind: "task", name: "生成", config: {} }] }, "user-one");
        mocks.run = createRun(mocks.definition, "user-one", {});

        await expect(advanceVozebCmsWorkflowRun("user-one", mocks.run.id)).resolves.toMatchObject({ status: "failed", error: "生成 尚未绑定 Action、任务或执行适配器" });
    });

    it("blocks a run once while a required module is disabled and resumes the same nodes after re-enable", async () => {
        mocks.definition = normalizeVozebCmsWorkflowDefinition({ id: "workflow-video", name: "视频生产", nodes: [{ id: "generate", kind: "task", name: "视频生成", config: { moduleId: "video", output: { assetId: "asset-video" } } }] }, "user-one");
        mocks.run = createRun(mocks.definition, "user-one", {});
        mocks.disabledModule = "video";

        const blocked = await advanceVozebCmsWorkflowRun("user-one", mocks.run.id);
        expect(blocked).toMatchObject({ status: "waiting", error: "video模块已停用", nodeStates: { generate: { status: "pending", attempts: 0 } } });
        expect(mocks.events).toEqual(["workflow.blocked"]);

        await advanceVozebCmsWorkflowRun("user-one", mocks.run.id);
        expect(mocks.events).toEqual(["workflow.blocked"]);

        mocks.disabledModule = "";
        const completed = await advanceVozebCmsWorkflowRun("user-one", mocks.run.id);
        expect(completed).toMatchObject({ status: "completed", error: undefined, nodeStates: { generate: { status: "success", attempts: 1 } } });
        expect(mocks.events).toContain("workflow.unblocked");
    });

    it("rejects create, resume and manual review while a required module is disabled", async () => {
        mocks.definition = normalizeVozebCmsWorkflowDefinition(
            {
                id: "workflow-video-review",
                name: "视频审核",
                nodes: [
                    { id: "generate", kind: "task", name: "视频生成", config: { moduleId: "video", output: { assetId: "asset-video" } } },
                    { id: "review", kind: "manual_review", name: "内容审核", dependsOn: ["generate"], config: { moduleId: "video" } },
                ],
            },
            "user-one",
        );
        mocks.run = createRun(mocks.definition, "user-one", {});
        mocks.disabledModule = "video";

        await expect(createVozebCmsWorkflowRunForUser("user-one", mocks.definition.id, {})).rejects.toMatchObject({ status: 403 });
        mocks.run = { ...mocks.run, status: "waiting" };
        await expect(controlVozebCmsWorkflowRun("user-one", mocks.run.id, "resume")).rejects.toMatchObject({ status: 403 });
        await expect(reviewVozebCmsWorkflowNode("user-one", mocks.run.id, "review", "approved")).rejects.toMatchObject({ status: 403 });
        expect(mocks.run.nodeStates.review.status).toBe("pending");
    });

    it("fails the node when a successful execution cannot write its asset provenance", async () => {
        mocks.definition = normalizeVozebCmsWorkflowDefinition({ id: "workflow-asset", name: "资产回写", nodes: [{ id: "asset", kind: "task", name: "资产回写", config: { output: { assetId: "asset-video" } } }] }, "user-one");
        mocks.run = createRun(mocks.definition, "user-one", {});
        mocks.assetError = new Error("工作流资产回写失败");

        const failed = await advanceVozebCmsWorkflowRun("user-one", mocks.run.id);
        expect(failed).toMatchObject({ status: "failed", error: "工作流资产回写失败", nodeStates: { asset: { status: "failed", error: "工作流资产回写失败" } } });
    });

    it("does not register assets or write a terminal node state after losing the execution lease", async () => {
        mocks.definition = normalizeVozebCmsWorkflowDefinition({ id: "workflow-lease", name: "租约保护", nodes: [{ id: "asset", kind: "task", name: "生成资产", config: { output: { url: "https://example.test/result.png" } } }] }, "user-one");
        mocks.run = createRun(mocks.definition, "user-one", {});
        mocks.renewLease.mockResolvedValueOnce(false);

        const result = await advanceVozebCmsWorkflowRun("user-one", mocks.run.id);

        expect(result).toMatchObject({ status: "running", nodeStates: { asset: { status: "running", attempts: 1 } } });
        expect(mocks.persistAsset).not.toHaveBeenCalled();
        expect(mocks.events).toEqual(["workflow.started", "node.started"]);
    });
});
