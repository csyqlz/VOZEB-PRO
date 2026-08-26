import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ refreshUserPointsIfSystem: vi.fn(async () => undefined), stopIfClientSessionExpired: vi.fn(async () => false) }));

vi.mock("@/services/api/points", () => ({ refreshUserPointsIfSystem: mocks.refreshUserPointsIfSystem }));
vi.mock("@/services/api/session-expiration", () => {
    class ClientSessionExpiredError extends Error {}
    return {
        ClientSessionExpiredError,
        stopIfClientSessionExpired: mocks.stopIfClientSessionExpired,
        throwIfClientSessionExpired: (response: Response) => {
            if (response.status === 401) throw new ClientSessionExpiredError();
        },
    };
});

import { controlCreativeAgentRun, createCreativeAgentRun, listCreativeAgentRuns, listCreativeConversationPage, listCreativeMessages, retryCreativeAgentTask, watchCreativeAgentRun } from "./creative";
import type { CreativeProjectHandoff } from "@/lib/creative-runtime-contract";

class FakeEventSource extends EventTarget {
    static instance: FakeEventSource;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    constructor(public readonly url: string) {
        super();
        FakeEventSource.instance = this;
    }
    close() {
        this.closed = true;
    }
    emit(type: string, data: unknown) {
        this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
    }
}

describe("统一创作 Agent 事件流", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.stopIfClientSessionExpired.mockResolvedValue(false);
    });
    afterEach(() => vi.unstubAllGlobals());

    it("returns planning, task and final replies to one conversation", () => {
        vi.stubGlobal("EventSource", FakeEventSource);
        const progress: string[] = [];
        const terminal: unknown[] = [];
        const completed: unknown[] = [];
        const stop = watchCreativeAgentRun("run-one", {
            onProgress: (text) => progress.push(text),
            onTerminal: (status, text) => terminal.push({ status, text }),
            onConnectionError: () => undefined,
            onTaskCompleted: (value) => completed.push(value),
        });

        FakeEventSource.instance.emit("run.planned", { data: { reply: "已选择图片模型和 1:1 画幅" } });
        FakeEventSource.instance.emit("task.running", { data: { title: "角色图" } });
        FakeEventSource.instance.emit("task.child.completed", { data: { taskId: "images", title: "角色图", completedCount: 1, failedCount: 0, totalCount: 4 } });
        FakeEventSource.instance.emit("task.child.failed", { data: { taskId: "images", title: "角色图", completedCount: 1, failedCount: 1, totalCount: 4 } });
        FakeEventSource.instance.emit("task.completed", { data: { message: "角色图已经生成" } });
        FakeEventSource.instance.emit("run.completed", { data: { reply: "四张角色图已经完成" } });

        expect(FakeEventSource.instance.url).toBe("/api/agent/runs/run-one/events");
        expect(progress).toEqual(["已选择图片模型和 1:1 画幅", "正在处理「角色图」", "「角色图」已完成 1/4", "「角色图」已完成 1/4，失败 1", "角色图已经生成"]);
        expect(completed).toEqual([{ taskId: "images", title: "角色图", completedCount: 1, failedCount: 0, totalCount: 4 }, undefined]);
        expect(terminal).toEqual([{ status: "completed", text: "四张角色图已经完成" }]);
        expect(FakeEventSource.instance.closed).toBe(true);
        FakeEventSource.instance.emit("run.failed", { data: { message: "迟到失败事件" } });
        expect(terminal).toEqual([{ status: "completed", text: "四张角色图已经完成" }]);
        expect(mocks.refreshUserPointsIfSystem).toHaveBeenCalledWith("system");
        stop();
    });

    it("maps safe planning progress events without exposing planner payloads", () => {
        vi.stubGlobal("EventSource", FakeEventSource);
        const progress: string[] = [];
        watchCreativeAgentRun("run-planning", {
            onProgress: (text) => progress.push(text),
            onTerminal: () => undefined,
            onConnectionError: () => undefined,
        });

        FakeEventSource.instance.emit("run.planning.context_ready", { data: { promptJson: "must stay private" } });
        FakeEventSource.instance.emit("run.planning.model_connected", { data: { internalReason: "must stay private" } });
        FakeEventSource.instance.emit("run.planning.validating", { data: { plan: "must stay private" } });

        expect(progress).toEqual(["需要的内容已经准备好，正在为你整理创作思路…", "创作思路已经理清，正在安排接下来的步骤…", "正在确认创作步骤，很快就可以开始…"]);
        expect(progress.join(" ")).not.toContain("must stay private");
    });

    it("reports terminal failure without asking the user to choose a target", () => {
        vi.stubGlobal("EventSource", FakeEventSource);
        const terminal: unknown[] = [];
        watchCreativeAgentRun("run-two", {
            onProgress: () => undefined,
            onTerminal: (status, text) => terminal.push({ status, text }),
            onConnectionError: () => undefined,
        });
        FakeEventSource.instance.emit("run.failed", { data: { message: "视频渠道暂时不可用" } });
        expect(terminal).toEqual([{ status: "failed", text: "视频渠道暂时不可用" }]);
    });

    it("shows a persisted upstream waiting reason without closing the stream", () => {
        vi.stubGlobal("EventSource", FakeEventSource);
        const progress: string[] = [];
        watchCreativeAgentRun("run-waiting", {
            onProgress: (text) => progress.push(text),
            onTerminal: () => undefined,
            onConnectionError: () => undefined,
        });

        FakeEventSource.instance.emit("task.waiting", { data: { title: "西瓜海报", error: "上游创建状态待人工确认" } });

        expect(progress).toEqual(["上游创建状态待人工确认"]);
        expect(FakeEventSource.instance.url).toBe("/api/agent/runs/run-waiting/events");
    });

    it("forwards a persistent project handoff before the run completes", () => {
        vi.stubGlobal("EventSource", FakeEventSource);
        const handoffs: CreativeProjectHandoff[] = [];
        const handoff: CreativeProjectHandoff = {
            id: "handoff-run-three",
            sourceRunId: "run-three",
            conversationId: "conversation-three",
            surface: "drama",
            title: "雨夜来信",
            summary: "将当前内容整理为短剧项目",
            ratio: "9:16",
            assetIds: [],
            assets: [],
        };
        watchCreativeAgentRun("run-three", {
            onProgress: () => undefined,
            onTerminal: () => undefined,
            onConnectionError: () => undefined,
            onProjectHandoff: (value) => handoffs.push(value),
        });

        FakeEventSource.instance.emit("project.handoff", { data: { projectHandoff: handoff } });
        FakeEventSource.instance.emit("run.completed", { data: { projectHandoff: handoff, reply: "短剧项目资料已经整理完成" } });

        expect(handoffs).toEqual([handoff]);
    });

    it("closes the stream when the caller leaves the conversation", () => {
        vi.stubGlobal("EventSource", FakeEventSource);
        const terminal: unknown[] = [];
        const stop = watchCreativeAgentRun("run-dispose", {
            onProgress: () => undefined,
            onTerminal: (status) => terminal.push(status),
            onConnectionError: () => undefined,
        });

        stop();
        FakeEventSource.instance.emit("run.completed", { data: { reply: "迟到结果" } });

        expect(FakeEventSource.instance.closed).toBe(true);
        expect(terminal).toEqual([]);
    });

    it("keeps observing a non-terminal backend run after an SSE interruption", async () => {
        vi.stubGlobal("EventSource", FakeEventSource);
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => Response.json({ code: 0, data: { run: { id: "run-recover", conversationId: "conversation", inputMessageId: "input", assistantMessageId: "assistant", status: "running", assetIds: [], tasks: [] } }, msg: "OK" })),
        );
        const progress: string[] = [];
        const terminal: unknown[] = [];
        const errors: string[] = [];
        watchCreativeAgentRun("run-recover", {
            onProgress: (text) => progress.push(text),
            onTerminal: (status) => terminal.push(status),
            onConnectionError: (message) => errors.push(message),
        });

        FakeEventSource.instance.onerror?.();
        await vi.waitFor(() => expect(progress).toContain("任务仍在后台运行，正在恢复连接"));

        expect(FakeEventSource.instance.closed).toBe(false);
        expect(terminal).toEqual([]);
        expect(errors).toEqual([]);
    });

    it("uses the persisted terminal state after an SSE interruption", async () => {
        vi.stubGlobal("EventSource", FakeEventSource);
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                Response.json({
                    code: 0,
                    data: {
                        run: { id: "run-failed", conversationId: "conversation", inputMessageId: "input", assistantMessageId: "assistant", status: "failed", assetIds: [], tasks: [{ id: "video", title: "视频", status: "failed", error: "上游明确失败" }] },
                    },
                    msg: "OK",
                }),
            ),
        );
        const terminal: unknown[] = [];
        watchCreativeAgentRun("run-failed", {
            onProgress: () => undefined,
            onTerminal: (status, text) => terminal.push({ status, text }),
            onConnectionError: () => undefined,
        });

        FakeEventSource.instance.onerror?.();
        await vi.waitFor(() => expect(terminal).toEqual([{ status: "failed", text: "上游明确失败" }]));

        expect(FakeEventSource.instance.closed).toBe(true);
    });

    it("does not turn an expired login into a business failure", async () => {
        vi.stubGlobal("EventSource", FakeEventSource);
        mocks.stopIfClientSessionExpired.mockResolvedValue(true);
        const terminal: unknown[] = [];
        const errors: string[] = [];
        watchCreativeAgentRun("run-auth", {
            onProgress: () => undefined,
            onTerminal: (status) => terminal.push(status),
            onConnectionError: (message) => errors.push(message),
        });

        FakeEventSource.instance.onerror?.();
        await vi.waitFor(() => expect(errors).toEqual(["登录状态已失效，任务仍可能在后台运行；重新登录后可继续查看"]));

        expect(terminal).toEqual([]);
        expect(FakeEventSource.instance.closed).toBe(true);
    });
});

describe("创作会话来源", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("requests only the selected workbench source", async () => {
        const fetchMock = vi.fn(async (_input: string | URL | Request) => Response.json({ code: 0, data: { conversations: [], hasMore: false }, msg: "ok" }));
        vi.stubGlobal("fetch", fetchMock);

        await listCreativeConversationPage({ source: "video-workbench", offset: 10, limit: 20 });

        const url = new URL(String(fetchMock.mock.calls[0]?.[0]), "http://localhost");
        expect(Object.fromEntries(url.searchParams)).toMatchObject({ surface: "chat", source: "video-workbench", status: "active", offset: "10", limit: "20" });
    });

    it("requests only the selected drama project conversations", async () => {
        const fetchMock = vi.fn(async (_input: string | URL | Request) => Response.json({ code: 0, data: { conversations: [], hasMore: false }, msg: "ok" }));
        vi.stubGlobal("fetch", fetchMock);

        await listCreativeConversationPage({ surface: "drama", source: "drama", projectId: "project-one", limit: 20 });

        const url = new URL(String(fetchMock.mock.calls[0]?.[0]), "http://localhost");
        expect(Object.fromEntries(url.searchParams)).toMatchObject({ surface: "drama", source: "drama", projectId: "project-one", status: "active", limit: "20" });
    });

    it("requests one bounded page of older conversation messages", async () => {
        const fetchMock = vi.fn(async (_input: string | URL | Request) => Response.json({ code: 0, data: { messages: [] }, msg: "ok" }));
        vi.stubGlobal("fetch", fetchMock);

        await listCreativeMessages("conversation-one", 51, 50);

        const url = new URL(String(fetchMock.mock.calls[0]?.[0]), "http://localhost");
        expect(Object.fromEntries(url.searchParams)).toEqual({ limit: "50", beforeSequence: "51" });
    });

    it("explicitly retries a failed planning run in place", async () => {
        const run = { id: "run-one", conversationId: "conversation-one", inputMessageId: "input-one", assistantMessageId: "assistant-one", status: "planning", assetIds: [], tasks: [] };
        const fetchMock = vi.fn(async () => Response.json({ code: 0, data: { run }, msg: "OK" }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(controlCreativeAgentRun("run-one", "retry", "conversation-one")).resolves.toEqual({ run });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/agent/runs/run-one/retry",
            expect.objectContaining({
                method: "POST",
                cache: "no-store",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ conversationId: "conversation-one" }),
            }),
        );
    });

    it("scopes Canvas run recovery and failed task retries to stable identities", async () => {
        const run = { id: "run-one", conversationId: "conversation-one", inputMessageId: "input-one", assistantMessageId: "assistant-one", status: "running", assetIds: [], tasks: [] };
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ code: 0, data: { runs: [run], run }, msg: "OK" }));
        vi.stubGlobal("fetch", fetchMock);

        await listCreativeAgentRuns("canvas", { activeOnly: true, projectId: "project-one" });
        await retryCreativeAgentTask("run-one", "task-one", "conversation-one");

        expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/agent/runs?surface=canvas&status=active&projectId=project-one");
        expect(fetchMock.mock.calls[1]).toEqual([
            "/api/agent/runs/run-one/tasks/task-one/retry",
            expect.objectContaining({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId: "conversation-one", taskIds: ["task-one"] }), cache: "no-store" }),
        ]);
    });

    it.each([
        [400, "生成参数无效"],
        [429, "Agent 请求过于频繁，请稍后重试"],
        [503, "当前模型暂无健康渠道"],
    ])("preserves the backend error message for HTTP %i", async (status, message) => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => Response.json({ code: status, data: null, msg: message }, { status })),
        );

        await expect(createCreativeAgentRun({ clientRequestId: `request-${status}`, surface: "chat", prompt: "生成一张图片", assetIds: [], skillIds: [], modelIds: [] })).rejects.toThrow(message);
    });
});
