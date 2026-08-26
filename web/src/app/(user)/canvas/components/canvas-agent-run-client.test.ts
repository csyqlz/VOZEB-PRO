import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchCanvasAgentRun } from "./canvas-agent-run-client";
import type { CanvasAgentRunStage } from "./canvas-agent-progress";

const mocks = vi.hoisted(() => ({ getCreativeAgentRun: vi.fn(), stopIfClientSessionExpired: vi.fn(async () => false) }));

vi.mock("@/services/api/creative", () => ({ getCreativeAgentRun: mocks.getCreativeAgentRun }));
vi.mock("@/services/api/session-expiration", () => {
    class ClientSessionExpiredError extends Error {}
    return { ClientSessionExpiredError, stopIfClientSessionExpired: mocks.stopIfClientSessionExpired };
});

class FakeEventSource extends EventTarget {
    static instance: FakeEventSource;
    static created = 0;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    constructor() {
        super();
        FakeEventSource.created += 1;
        FakeEventSource.instance = this;
    }
    close() {
        this.closed = true;
    }
    emit(type: string, data: unknown) {
        this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
    }
}

describe("Canvas Agent 事件流", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        FakeEventSource.created = 0;
        mocks.stopIfClientSessionExpired.mockResolvedValue(false);
    });
    afterEach(() => vi.unstubAllGlobals());

    it("reports thinking stages and the final returned message", async () => {
        vi.stubGlobal("EventSource", FakeEventSource);
        const stages: CanvasAgentRunStage[] = [];
        const messages: string[] = [];
        const details: unknown[] = [];
        const ops: unknown[] = [];
        const promise = watchCanvasAgentRun("run", {
            onPlan: () => undefined,
            onAssistant: (text, detail) => {
                messages.push(text);
                details.push(detail);
            },
            onStage: (stage) => stages.push(stage),
            onPaused: () => undefined,
            onOps: (value) => ops.push(...value),
        });
        FakeEventSource.instance.emit("run.planning", {});
        FakeEventSource.instance.emit("run.planning.context_ready", {});
        FakeEventSource.instance.emit("run.planning.model_connected", {});
        FakeEventSource.instance.emit("run.planning.validating", {});
        FakeEventSource.instance.emit("canvas.ops", { data: { ops: [{ type: "add_node", id: "brief-run" }] } });
        FakeEventSource.instance.emit("task.running", { data: { title: "生成文案", attempts: 1 } });
        FakeEventSource.instance.emit("task.completed", { data: { message: "文案已经返回", outputNodeIds: ["output-run-0"], type: "text", ops: [{ type: "select_nodes", ids: ["output-run-0"] }] } });
        FakeEventSource.instance.emit("run.completed", { data: { reply: "全部任务已经完成" } });
        await promise;
        expect(stages).toEqual([
            { key: "planning", text: "正在理解你的想法，也在看看画布里的内容…" },
            { key: "planning", text: "画布内容已经准备好，正在为你整理创作思路…" },
            { key: "planning", text: "创作思路已经理清，正在安排接下来的步骤…" },
            { key: "plan", text: "正在确认创作步骤，很快就可以开始…" },
            { key: "plan", text: "创作步骤已经准备好，马上开始处理…" },
            { key: "executing", text: "正在执行「生成文案」（第 1 次）" },
        ]);
        expect(messages).toEqual(["文案已经返回", "全部任务已经完成"]);
        expect(details).toEqual([
            { nodeIds: ["output-run-0"], taskType: "text" },
            { nodeIds: ["output-run-0"], taskType: "text" },
        ]);
        expect(ops).toEqual([{ type: "select_nodes", ids: ["output-run-0"] }]);
    });

    it("applies a replayed plan once and restores paused state from snapshots", async () => {
        vi.stubGlobal("EventSource", FakeEventSource);
        const plans: unknown[] = [];
        const paused: boolean[] = [];
        const ops: unknown[] = [];
        const promise = watchCanvasAgentRun("run", {
            onPlan: (ops) => plans.push(ops),
            onAssistant: () => undefined,
            onStage: () => undefined,
            onPaused: (value) => paused.push(value),
            onOps: (value) => ops.push(...value),
        });
        const plan = { data: { ops: [{ type: "add_node", id: "brief-run" }] } };
        FakeEventSource.instance.emit("canvas.ops", plan);
        FakeEventSource.instance.emit("canvas.ops", plan);
        FakeEventSource.instance.emit("run.snapshot", { status: "paused" });
        FakeEventSource.instance.emit("run.snapshot", { status: "paused" });
        FakeEventSource.instance.emit("run.snapshot", { status: "running" });
        FakeEventSource.instance.emit("run.cancelled", { data: { ops: [{ type: "update_node", id: "output-run-0-0", metadata: { status: "cancelled" } }] } });
        await promise;

        expect(plans).toHaveLength(1);
        expect(paused).toEqual([true, false]);
        expect(ops).toEqual([{ type: "update_node", id: "output-run-0-0", metadata: { status: "cancelled" } }]);
    });

    it("keeps failed task identity and applies retry repair operations", async () => {
        vi.stubGlobal("EventSource", FakeEventSource);
        const messages: Array<{ text: string; detail: unknown }> = [];
        const ops: unknown[] = [];
        const promise = watchCanvasAgentRun("run", {
            onPlan: () => undefined,
            onAssistant: (text, detail) => messages.push({ text, detail }),
            onStage: () => undefined,
            onPaused: () => undefined,
            onOps: (value) => ops.push(...value),
        });
        FakeEventSource.instance.emit("task.retry.requested", { data: { ops: [{ type: "update_node", id: "output-run-0-0", metadata: { status: "loading" } }] } });
        FakeEventSource.instance.emit("task.running", { data: { title: "编辑图片", ops: [{ type: "update_node", id: "output-run-0-0", metadata: { status: "loading" } }] } });
        FakeEventSource.instance.emit("task.failed", { data: { taskId: "task", title: "编辑图片", error: "生成渠道暂时无法连接", ops: [{ type: "update_node", id: "output-run-0-0", metadata: { status: "error" } }] } });
        FakeEventSource.instance.emit("run.failed", { data: { message: "生成失败" } });
        await promise;

        expect(ops).toEqual([
            { type: "update_node", id: "output-run-0-0", metadata: { status: "loading" } },
            { type: "update_node", id: "output-run-0-0", metadata: { status: "loading" } },
            { type: "update_node", id: "output-run-0-0", metadata: { status: "error" } },
        ]);
        expect(messages).toEqual([{ text: "「编辑图片」执行失败：生成渠道暂时无法连接", detail: { taskType: undefined, nodeIds: [], taskId: "task", title: "编辑图片", runId: "run" } }]);
    });

    it("applies each child result immediately and keeps successful siblings visible", async () => {
        vi.stubGlobal("EventSource", FakeEventSource);
        const messages: Array<{ text: string; detail: unknown }> = [];
        const stages: CanvasAgentRunStage[] = [];
        const ops: unknown[] = [];
        const promise = watchCanvasAgentRun("run", {
            onPlan: () => undefined,
            onAssistant: (text, detail) => messages.push({ text, detail }),
            onStage: (stage) => stages.push(stage),
            onPaused: () => undefined,
            onOps: (value) => ops.push(...value),
        });

        FakeEventSource.instance.emit("task.child.completed", {
            data: {
                title: "角色图",
                type: "image",
                completedCount: 1,
                failedCount: 0,
                totalCount: 2,
                outputNodeIds: ["output-run-0-0"],
                ops: [{ type: "update_node", id: "output-run-0-0", metadata: { status: "success" } }],
            },
        });
        FakeEventSource.instance.emit("task.child.failed", {
            data: {
                title: "角色图",
                type: "image",
                completedCount: 1,
                failedCount: 1,
                totalCount: 2,
                outputNodeIds: ["output-run-0-1"],
                ops: [{ type: "update_node", id: "output-run-0-1", metadata: { status: "error" } }],
            },
        });
        FakeEventSource.instance.emit("run.completed", { data: { reply: "可用结果已经返回" } });
        await promise;

        expect(ops).toEqual([
            { type: "update_node", id: "output-run-0-0", metadata: { status: "success" } },
            { type: "update_node", id: "output-run-0-1", metadata: { status: "error" } },
        ]);
        expect(stages).toEqual([
            { key: "executing", text: "「角色图」已完成 1/2" },
            { key: "executing", text: "「角色图」已完成 1/2，失败 1" },
        ]);
        expect(messages).toEqual([
            { text: "「角色图」已完成 1/2", detail: { nodeIds: ["output-run-0-0"], taskType: "image" } },
            { text: "「角色图」已完成 1/2，失败 1", detail: { nodeIds: ["output-run-0-0"], taskType: "image" } },
            { text: "可用结果已经返回", detail: { nodeIds: ["output-run-0-0"], taskType: "image" } },
        ]);
    });

    it("exposes planning failures as retryable run failures", async () => {
        vi.stubGlobal("EventSource", FakeEventSource);
        const messages: Array<{ text: string; detail: unknown }> = [];
        const promise = watchCanvasAgentRun("run", {
            onPlan: () => undefined,
            onAssistant: (text, detail) => messages.push({ text, detail }),
            onStage: () => undefined,
            onPaused: () => undefined,
            onOps: () => undefined,
        });
        FakeEventSource.instance.emit("run.failed", { data: { message: "生成渠道暂时无法连接，请稍后重试或联系管理员。" } });
        await promise;

        expect(messages).toEqual([{ text: "生成渠道暂时无法连接，请稍后重试或联系管理员。", detail: { runId: "run", title: "智能任务执行失败" } }]);
    });

    it("keeps a non-terminal Run alive after an event connection interruption", async () => {
        vi.stubGlobal("EventSource", FakeEventSource);
        mocks.getCreativeAgentRun.mockResolvedValue({ id: "run", conversationId: "conversation", inputMessageId: "input", assistantMessageId: "assistant", status: "running", assetIds: [], tasks: [] });
        const stages: CanvasAgentRunStage[] = [];
        const promise = watchCanvasAgentRun("run", {
            onPlan: () => undefined,
            onAssistant: () => undefined,
            onStage: (stage) => stages.push(stage),
            onPaused: () => undefined,
            onOps: () => undefined,
        });

        FakeEventSource.instance.onerror?.();
        await vi.waitFor(() => expect(stages.some((stage) => stage.text === "任务仍在后台运行，正在恢复连接")).toBe(true));
        expect(FakeEventSource.instance.closed).toBe(false);

        FakeEventSource.instance.emit("run.completed", { data: { reply: "完成" } });
        await promise;
    });

    it("uses the persisted terminal state after an event connection interruption", async () => {
        vi.stubGlobal("EventSource", FakeEventSource);
        mocks.getCreativeAgentRun.mockResolvedValue({
            id: "run",
            conversationId: "conversation",
            inputMessageId: "input",
            assistantMessageId: "assistant",
            status: "failed",
            assetIds: [],
            tasks: [{ id: "video", title: "视频", status: "failed", error: "上游明确失败" }],
        });
        const messages: string[] = [];
        const promise = watchCanvasAgentRun("run", {
            onPlan: () => undefined,
            onAssistant: (text) => messages.push(text),
            onStage: () => undefined,
            onPaused: () => undefined,
            onOps: () => undefined,
        });

        FakeEventSource.instance.onerror?.();
        await promise;

        expect(messages).toEqual(["「视频」执行失败：上游明确失败"]);
        expect(FakeEventSource.instance.closed).toBe(true);
    });

    it("stops local observation on abort without applying later events", async () => {
        vi.stubGlobal("EventSource", FakeEventSource);
        const controller = new AbortController();
        const stages: CanvasAgentRunStage[] = [];
        const messages: string[] = [];
        const promise = watchCanvasAgentRun(
            "run",
            {
                onPlan: () => undefined,
                onAssistant: (text) => messages.push(text),
                onStage: (stage) => stages.push(stage),
                onPaused: () => undefined,
                onOps: () => undefined,
            },
            { signal: controller.signal },
        );
        const source = FakeEventSource.instance;

        controller.abort();
        await promise;
        source.emit("run.planning", {});
        source.emit("run.completed", { data: { reply: "不应显示" } });

        expect(source.closed).toBe(true);
        expect(stages).toEqual([]);
        expect(messages).toEqual([]);
    });

    it("does not open an event stream for an already aborted watcher", async () => {
        vi.stubGlobal("EventSource", FakeEventSource);
        const controller = new AbortController();
        controller.abort();

        await watchCanvasAgentRun("run", { onPlan: () => undefined, onAssistant: () => undefined, onStage: () => undefined, onPaused: () => undefined, onOps: () => undefined }, { signal: controller.signal });

        expect(FakeEventSource.created).toBe(0);
    });
});
