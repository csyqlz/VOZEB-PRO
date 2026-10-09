import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/safe-outbound-fetch", () => ({ fetchSafeOutbound: (url: string | URL, init?: RequestInit) => fetch(url, init) }));
vi.mock("@/lib/server/internal-origin", () => ({ fetchInternalApi: (url: string | URL, init?: RequestInit) => fetch(url, init), isInternalApiBaseUrl: (baseUrl: string) => baseUrl.startsWith("/") }));

const mocks = vi.hoisted(() => ({
    getTask: vi.fn(),
    updateTask: vi.fn(),
    transitionTask: vi.fn(),
    schedule: vi.fn(),
    refund: vi.fn(),
}));

vi.mock("@/lib/auth/store", () => ({ refundUserPoints: mocks.refund }));
vi.mock("@/lib/server/proxy-dispatcher", () => ({ configureServerProxyDispatcher: vi.fn() }));
vi.mock("@/lib/server/generation-task-scheduler", () => ({ scheduleGenerationTask: mocks.schedule }));
vi.mock("@/lib/server/text-task-store", () => ({
    getTextTask: mocks.getTask,
    updateTextTask: mocks.updateTask,
    transitionTextTask: mocks.transitionTask,
}));

import { emptyAdvancedConfig } from "@/lib/channel-protocol-registry";
import { createProtocolFixtureServer } from "../../../scripts/protocol-fixture-server.mjs";
import { maintenanceWorkerContext } from "./maintenance-auth";
import { markTextTaskFailed, runTextTaskStep, taskHeaders } from "./text-task-runtime";
import type { TextTask, TextTaskConfig } from "./text-task-store";

describe("text task runtime recovery", () => {
    let state: TextTask;

    beforeEach(() => {
        vi.clearAllMocks();
        state = textTask(customConfig("channel-one", "https://one.example"));
        mocks.getTask.mockImplementation(async () => state);
        mocks.updateTask.mockImplementation(async (_id: string, patch: Partial<TextTask>) => {
            state = { ...state, ...patch };
            return state;
        });
        mocks.transitionTask.mockImplementation(async (_task: TextTask, allowed: string[], patch: Partial<TextTask>) => {
            if (!allowed.includes(state.status)) return null;
            state = { ...state, ...patch };
            return state;
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    it("preserves maintenance authorization for the internal system proxy", () => {
        const token = "m".repeat(32);
        vi.stubEnv("VOZEB_PRO_MAINTENANCE_TOKEN", `${token}-maintenance`);
        vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", token);

        const headers = taskHeaders({ ...openAiConfig("channel-one", "/api/ai/system/channel-one"), apiKey: "system" }, maintenanceWorkerContext("user-one"), "text-task:test:attempt:1");

        expect(headers.get("authorization")).toBe(`Bearer ${token}`);
        expect(headers.get("x-vozeb-pro-worker-user-id")).toBe("user-one");
        expect(headers.get("x-vozeb-pro-logical-model")).toBe("text-model");
        expect(headers.get("x-vozeb-pro-points-idempotency-key")).toBe("text-task:test:attempt:1");
    });

    it("completes through a live OpenAI-compatible fixture", async () => {
        const fixture = createProtocolFixtureServer();
        await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        const address = fixture.server.address();
        if (!address || typeof address === "string") throw new Error("Protocol fixture did not bind a TCP port");
        const origin = `http://127.0.0.1:${address.port}`;
        state = textTask(openAiConfig("fixture-text", `${origin}/v1`));

        try {
            await expect(runTextTaskStep(state, "http://internal", "")).resolves.toEqual({ state: "completed" });
            expect(state).toMatchObject({ status: "success", result: { content: "协议测试文本返回成功" } });
            expect(fixture.requests).toHaveLength(1);
            expect(fixture.requests[0]).toMatchObject({ method: "POST", path: "/v1/chat/completions" });
            expect(fixture.requests[0]?.headers.authorization).toBe("Bearer key");
        } finally {
            await new Promise<void>((resolve, reject) => fixture.server.close((error) => (error ? reject(error) : resolve())));
        }
    });

    it("runs a queued drama visual analysis through the authenticated worker route", async () => {
        const token = "w".repeat(32);
        vi.stubEnv("VOZEB_PRO_MAINTENANCE_TOKEN", `${token}-maintenance`);
        vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", token);
        state = {
            ...textTask(openAiConfig("text-channel", "/api/ai/system/text-channel")),
            surface: "drama",
            projectId: "project-one",
            episodeId: "episode-one",
            dramaAnalysis: { body: { requestId: "drama-visual-one", projectId: "project-one", phase: "visual", shots: [{ id: "shot-one" }] } },
        };
        const fetchMock = vi.fn().mockResolvedValue(Response.json({ code: 0, data: { shots: [{ shotId: "shot-one", imagePrompt: "画面", videoPrompt: "视频" }] } }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(runTextTaskStep(state, "http://internal", "session=test")).resolves.toEqual({ state: "completed" });

        expect(fetchMock).toHaveBeenCalledWith("http://internal/api/drama/analyze", expect.objectContaining({ method: "POST", headers: expect.objectContaining({ authorization: `Bearer ${token}`, "x-vozeb-pro-worker-user-id": "user-one" }) }));
        expect(state.status).toBe("success");
        expect(JSON.parse(state.result?.content || "{}")).toMatchObject({ shots: [{ shotId: "shot-one" }] });
    });

    it("runs queued drama content analysis through the same authenticated worker route", async () => {
        const token = "w".repeat(32);
        vi.stubEnv("VOZEB_PRO_MAINTENANCE_TOKEN", `${token}-maintenance`);
        vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", token);
        state = {
            ...textTask(openAiConfig("text-channel", "/api/ai/system/text-channel")),
            surface: "drama",
            projectId: "project-one",
            episodeId: "episode-one",
            dramaAnalysis: { body: { requestId: "drama-content-one", projectId: "project-one", episodeId: "episode-one", phase: "content", script: "剧本原文" } },
        };
        const fetchMock = vi.fn().mockResolvedValue(Response.json({ code: 0, data: { episode: { outline: "大纲" }, characters: [], scenes: [], props: [], clues: [], shots: [] } }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(runTextTaskStep(state, "http://internal", "session=test")).resolves.toEqual({ state: "completed" });

        expect(fetchMock).toHaveBeenCalledWith(
            "http://internal/api/drama/analyze",
            expect.objectContaining({ method: "POST", headers: expect.objectContaining({ authorization: `Bearer ${token}`, "x-vozeb-pro-worker-user-id": "user-one", "x-vozeb-pro-generation-task-id": state.id }) }),
        );
        expect(state.status).toBe("success");
        expect(JSON.parse(state.result?.content || "{}")).toMatchObject({ episode: { outline: "大纲" } });
        expect(mocks.schedule).toHaveBeenCalledWith("text", state.id, { executionPhase: "persisting", lastUpstreamStatus: "persisting" });
    });

    it("persists an asynchronous task ID and queries only one step per worker run", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(Response.json({ task_id: "upstream-one", status: "queued" }))
            .mockResolvedValueOnce(Response.json({ status: "processing" }))
            .mockResolvedValueOnce(Response.json({ status: "completed", data: { output: "最终结果" } }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(runTextTaskStep(state, "http://internal", "")).resolves.toMatchObject({ state: "pending", upstreamTaskId: "upstream-one" });
        expect(state.upstream).toEqual({ id: "upstream-one", createPath: "/jobs" });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        await expect(runTextTaskStep(state, "http://internal", "")).resolves.toMatchObject({ state: "pending", status: "processing" });
        expect(fetchMock).toHaveBeenCalledTimes(2);

        await expect(runTextTaskStep(state, "http://internal", "")).resolves.toEqual({ state: "completed" });
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(state.status).toBe("success");
        expect(state.result?.content).toBe("最终结果");
    });

    it("does not create through another channel after a network-uncertain submission", async () => {
        state = textTask(openAiConfig("channel-one", "https://one.example"), [openAiConfig("channel-two", "https://two.example")]);
        const fetchMock = vi.fn().mockRejectedValueOnce(new Error("socket closed"));
        vi.stubGlobal("fetch", fetchMock);

        await expect(runTextTaskStep(state, "http://internal", "")).resolves.toMatchObject({ state: "needs_review" });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(state.config.channelId).toBe("channel-one");
        expect(state.candidateConfigs).toHaveLength(1);
        expect(state.attempts?.map(({ status }) => status)).toEqual(["running"]);
    });

    it("automatically switches to the next text model after a timeout", async () => {
        state = textTask(openAiConfig("channel-one", "https://one.example"), [openAiConfig("channel-two", "https://two.example")]);
        const fetchMock = vi
            .fn()
            .mockRejectedValueOnce(Object.assign(new Error("request timed out"), { name: "TimeoutError" }))
            .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "备用文本结果" } }] }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(runTextTaskStep(state, "http://internal", "")).resolves.toEqual({ state: "completed" });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://one.example/v1/chat/completions");
        expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://two.example/v1/chat/completions");
        expect(state.config.channelId).toBe("channel-two");
        expect(state.attempts?.map(({ status }) => status)).toEqual(["failed", "succeeded"]);
    });

    it("switches channels after a deterministic 422 rejection", async () => {
        state = textTask(openAiConfig("channel-one", "https://one.example"), [{ ...openAiConfig("channel-two", "https://two.example"), apiFormat: "gemini" }]);
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(Response.json({ error: { message: "参数不受支持" } }, { status: 422 }))
            .mockResolvedValueOnce(Response.json({ candidates: [{ content: { parts: [{ text: "备用渠道结果" }] } }] }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(runTextTaskStep(state, "http://internal", "")).resolves.toEqual({ state: "completed" });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(state.config.channelId).toBe("channel-two");
        expect(state.attempts?.map(({ status }) => status)).toEqual(["failed", "succeeded"]);
        expect(state.result?.content).toBe("备用渠道结果");
    });

    it("switches channels after an explicit synchronous 5xx response", async () => {
        state = textTask(openAiConfig("channel-one", "https://one.example"), [openAiConfig("channel-two", "https://two.example")]);
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(Response.json({ error: { message: "渠道暂不可用" } }, { status: 503 }))
            .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "备用渠道成功" } }] }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(runTextTaskStep(state, "http://internal", "")).resolves.toEqual({ state: "completed" });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(state.config.channelId).toBe("channel-two");
        expect(state.attempts?.map(({ status }) => status)).toEqual(["failed", "succeeded"]);
    });

    it("switches models instead of trying another protocol on the same model", async () => {
        state = textTask(responsesConfig("channel-one", "https://one.example"), [openAiConfig("channel-two", "https://two.example")]);
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(Response.json({ error: { message: "/backend-api/conversation failed: status=422, body=" } }, { status: 422 }))
            .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "Chat 兼容返回" } }] }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(runTextTaskStep(state, "http://internal", "")).resolves.toEqual({ state: "completed" });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://one.example/v1/responses");
        expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://two.example/v1/chat/completions");
        expect(state.config.channelId).toBe("channel-two");
        expect(state.attempts?.map(({ status }) => status)).toEqual(["failed", "succeeded"]);
        expect(state.result?.content).toBe("Chat 兼容返回");
    });

    it("marks a 2xx invalid JSON response for manual review", async () => {
        state = textTask(openAiConfig("channel-one", "https://one.example"), [openAiConfig("channel-two", "https://two.example")]);
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValueOnce(
                new Response("not-json", {
                    status: 200,
                    headers: { "content-type": "application/json", "x-vozeb-pro-points-cost": "1.5", "x-vozeb-pro-points-record-id": "text-points-unknown" },
                }),
            ),
        );

        await expect(runTextTaskStep(state, "http://internal", "")).resolves.toMatchObject({ state: "needs_review" });
        expect(state.config.channelId).toBe("channel-one");
        expect(state.billing).toEqual({ pointsCost: 1.5, pointsRecordId: "text-points-unknown", refunded: false });
        expect(mocks.refund).not.toHaveBeenCalled();
    });

    it("refunds a zero-point recorded charge when the upstream task fails", async () => {
        const headers = { "x-vozeb-pro-points-cost": "0", "x-vozeb-pro-points-record-id": "record-zero" };
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(Response.json({ task_id: "upstream-zero", status: "queued" }, { headers }))
            .mockResolvedValueOnce(Response.json({ status: "failed", error: { message: "upstream failed" } }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(runTextTaskStep(state, "http://internal", "")).resolves.toMatchObject({ state: "pending" });
        expect(state.billing).toMatchObject({ pointsCost: 0, pointsRecordId: "record-zero", refunded: false });
        await expect(runTextTaskStep(state, "http://internal", "")).resolves.toMatchObject({ state: "failed" });

        expect(mocks.refund).toHaveBeenCalledWith("user-one", "text-model", 0, "text", 1, "text-task:text-one:attempt:1:refund", "record-zero");
    });

    it("does not refund when text success wins the failure transition race", async () => {
        state = { ...textTask(openAiConfig("channel-one", "https://one.example")), status: "running", billing: { pointsCost: 2, pointsRecordId: "text-race", refunded: false } };
        mocks.transitionTask.mockImplementationOnce(async () => {
            state = { ...state, status: "success" };
            return null;
        });

        await expect(markTextTaskFailed(state, "late failure")).resolves.toEqual({ state: "completed" });
        expect(mocks.refund).not.toHaveBeenCalled();
    });

    it("commits the text error state before refunding", async () => {
        state = { ...textTask(openAiConfig("channel-one", "https://one.example")), status: "running", attemptNo: 1, billing: { pointsCost: 2, pointsRecordId: "text-failed", refunded: false } };
        mocks.refund.mockImplementationOnce(async () => {
            expect(state.status).toBe("error");
            return undefined;
        });

        await expect(markTextTaskFailed(state, "provider failed")).resolves.toEqual({ state: "failed", error: "provider failed" });
        expect(state).toMatchObject({ status: "error", billing: { refunded: true } });
        expect(mocks.refund).toHaveBeenCalledOnce();
    });
});

function textTask(config: TextTaskConfig, candidateConfigs: TextTaskConfig[] = []): TextTask {
    return {
        id: "text-one",
        userId: "user-one",
        status: "pending",
        createdAt: 1,
        updatedAt: 1,
        config,
        candidateConfigs,
        messages: [{ role: "user", content: "test" }],
    };
}

function customConfig(channelId: string, baseUrl: string): TextTaskConfig {
    return {
        baseUrl,
        apiKey: "key",
        apiFormat: "openai",
        model: "text-model",
        channelId,
        advancedConfig: {
            ...emptyAdvancedConfig(),
            protocol: "custom",
            createPath: "/jobs",
            queryPath: "/jobs/{taskId}",
            requestTemplate: '{"prompt":"{{prompt}}"}',
            resultField: "data.output",
            statusField: "status",
        },
    };
}

function openAiConfig(channelId: string, baseUrl: string): TextTaskConfig {
    return { baseUrl, apiKey: "key", apiFormat: "openai", model: "text-model", channelId };
}

function responsesConfig(channelId: string, baseUrl: string): TextTaskConfig {
    return {
        ...openAiConfig(channelId, baseUrl),
        advancedConfig: {
            ...emptyAdvancedConfig(),
            protocol: "compatible",
            createPath: "/responses",
        },
    };
}
