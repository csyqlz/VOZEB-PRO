import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";

vi.mock("@/lib/server/safe-outbound-fetch", () => ({ fetchSafeOutbound: (url: string | URL, init?: RequestInit) => fetch(url, init) }));

const mocks = vi.hoisted(() => ({
    getTask: vi.fn(),
    updateTask: vi.fn(),
    transitionTask: vi.fn(),
    schedule: vi.fn(),
    refund: vi.fn(),
    recoverPriced: vi.fn(),
    refundPriced: vi.fn(),
    finishBilling: vi.fn(),
}));

vi.mock("@/lib/auth/store", () => ({ refundUserPoints: mocks.refund }));
vi.mock("./model-pricing-text-task", () => ({ recoverPricedTextTask: mocks.recoverPriced, refundPricedTextTask: mocks.refundPriced }));
vi.mock("@/lib/server/proxy-dispatcher", () => ({ configureServerProxyDispatcher: vi.fn() }));
vi.mock("@/lib/server/generation-task-scheduler", () => ({ scheduleGenerationTask: mocks.schedule }));
vi.mock("@/lib/server/text-task-store", () => ({
    getTextTask: mocks.getTask,
    updateTextTask: mocks.updateTask,
    transitionTextTask: mocks.transitionTask,
    finishTextTaskBilling: mocks.finishBilling,
}));

import { emptyAdvancedConfig } from "@/lib/channel-protocol-registry";
import { createProtocolFixtureServer } from "../../../scripts/protocol-fixture-server.mjs";
import { maintenanceWorkerContext } from "./maintenance-auth";
import { markTextTaskFailed, recoverPricedTextTaskStep, runTextTaskStep, taskHeaders } from "./text-task-runtime";
import type { TextTask, TextTaskConfig } from "./text-task-store";
import { readVerifiedSystemAiBillingRequest } from "./system-ai-billing";
import * as internalOrigin from "./internal-origin";

describe("text task runtime recovery", () => {
    let state: TextTask;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.recoverPriced.mockReset().mockResolvedValue(null);
        mocks.refundPriced.mockReset().mockResolvedValue(false);
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
        vi.restoreAllMocks();
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

    it("recovers billing for an already delivered answer without submitting or replacing the result", async () => {
        state = {
            ...textTask(openAiConfig("channel-one", "/api/ai/system/channel-one")),
            status: "success",
            result: { content: "已交付内容" },
            billingMode: "official-usage",
            billingPending: true,
            attemptNo: 1,
            billingRequests: [{ attemptNo: 1, requestId: "original", requestFingerprint: "fingerprint", businessRequestId: "business", channelId: "channel-one", logicalModel: "text-model", upstreamModel: "text-model" }],
        };
        mocks.recoverPriced.mockResolvedValue({ state: "completed", content: "已交付内容", pointsCost: 1, pointsRecordId: "point", pointsRemaining: 9 });
        await expect(recoverPricedTextTaskStep(state)).resolves.toEqual({ state: "completed" });
        expect(mocks.finishBilling).toHaveBeenCalledWith({ taskId: state.id, userId: state.userId, requestId: "original", requestFingerprint: "fingerprint" });
        expect(mocks.transitionTask).not.toHaveBeenCalled();
    });

    it("sends the persisted attempt identity to the internal proxy", async () => {
        state = textTask(openAiConfig("channel-one", "/api/ai/system/channel-one"));
        let verified: ReturnType<typeof readVerifiedSystemAiBillingRequest>;
        const server = createServer((request, response) => {
            verified = readVerifiedSystemAiBillingRequest(new Headers(request.headers as Record<string, string>), "text-model", state.config.model);
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ choices: [{ message: { content: "reply" } }] }));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Fixture did not bind");
        try {
            await expect(runTextTaskStep(state, `http://127.0.0.1:${address.port}`, "")).resolves.toEqual({ state: "completed" });
            expect(state.attemptNo).toBe(1);
            expect(verified).toMatchObject({ textTask: { taskId: state.id, attemptNo: 1 } });
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        }
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

    it("sends an explicitly native Anthropic text task to the local Messages fixture", async () => {
        const fixture = createProtocolFixtureServer({ mountPrefixes: ["/v1"] });
        await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        const address = fixture.server.address();
        if (!address || typeof address === "string") throw new Error("Protocol fixture did not bind a TCP port");
        state = textTask({ ...openAiConfig("claude-channel", `http://127.0.0.1:${address.port}`), model: "claude-fable-5", advancedConfig: { ...emptyAdvancedConfig(), protocol: "anthropic" } });
        try {
            await expect(runTextTaskStep(state, "http://internal", "")).resolves.toEqual({ state: "completed" });
            expect(state).toMatchObject({ status: "success", result: { content: "协议测试文本返回成功" } });
            expect(fixture.requests).toHaveLength(1);
            expect(fixture.requests[0]).toMatchObject({ method: "POST", path: "/v1/messages" });
            expect(JSON.parse(fixture.requests[0].body.toString())).toMatchObject({ model: "claude-fable-5", max_tokens: 4096, messages: [{ role: "user" }] });
        } finally {
            await new Promise<void>((resolve, reject) => fixture.server.close((error) => (error ? reject(error) : resolve())));
        }
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

    it("keeps an official-usage timeout on the same attempt and recovers without another paid call", async () => {
        state = { ...textTask(openAiConfig("channel-one", "/api/ai/system/channel-one"), [openAiConfig("channel-two", "/api/ai/system/channel-two")]), billingMode: "official-usage" };
        const fetchMock = vi.fn().mockRejectedValueOnce(Object.assign(new Error("request timed out"), { name: "TimeoutError" }));
        vi.spyOn(internalOrigin, "fetchInternalApi").mockImplementation(fetchMock);
        await expect(runTextTaskStep(state, "http://internal", "")).resolves.toMatchObject({ state: "needs_review" });
        expect(fetchMock).toHaveBeenCalledOnce();
        const attemptNo = state.attemptNo;
        mocks.recoverPriced.mockResolvedValue({ state: "completed", content: "已保存结果", pointsCost: 0.25, pointsRecordId: "priced-record", pointsRemaining: 9.75 });
        await expect(runTextTaskStep(state, "http://internal", "")).resolves.toEqual({ state: "completed" });
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(state.attemptNo).toBe(attemptNo);
        expect(state.result?.content).toBe("已保存结果");
        expect(state.billing).toMatchObject({ pointsCost: 0.25, pointsRecordId: "priced-record" });
        expect(mocks.refund).not.toHaveBeenCalled();
    });

    it.each(["chat", "responses", "claude", "gemini"] as const)("drains the native %s priced stream before recovering its saved answer", async (kind) => {
        const config = openAiConfig("channel-one", "/api/ai/system/channel-one");
        config.advancedConfig = { ...emptyAdvancedConfig(), streaming: { enabled: true }, ...(kind === "responses" ? { createPath: "/responses" } : kind === "claude" ? { protocol: "anthropic" as const } : {}) };
        if (kind === "gemini") config.apiFormat = "gemini";
        state = { ...textTask(config), billingMode: "official-usage" };
        let reads = 0;
        const fetcher = vi.spyOn(internalOrigin, "fetchInternalApi").mockImplementation(
            async () =>
                new Response(
                    new ReadableStream(
                        {
                            pull(controller) {
                                if (reads++ === 0) controller.enqueue(new TextEncoder().encode('data: {"internal":"raw event"}\n\n'));
                                else {
                                    mocks.recoverPriced.mockResolvedValue({ state: "completed", content: "已保存结果", pointsCost: 0.25, pointsRecordId: "priced-record", pointsRemaining: 9.75 });
                                    controller.close();
                                }
                            },
                        },
                        { highWaterMark: 0 },
                    ),
                    { headers: { "content-type": "text/event-stream", "x-vozeb-pro-pricing-state": "streaming" } },
                ),
        );
        await expect(runTextTaskStep(state, "http://internal", "")).resolves.toEqual({ state: "completed" });
        expect(reads).toBe(2);
        expect(fetcher).toHaveBeenCalledOnce();
        const [url, init] = fetcher.mock.calls[0];
        const expected = { chat: "/chat/completions", responses: "/responses", claude: "/v1/messages", gemini: "/models/text-model:streamGenerateContent?alt=sse" }[kind];
        expect(String(url)).toBe(`http://internal/api/ai/system/channel-one${expected}`);
        const body = JSON.parse(String(init?.body));
        if (kind === "gemini") {
            expect(body.contents).toBeDefined();
            expect(body.stream).toBeUndefined();
        } else expect(body.stream).toBe(true);
        if (kind === "chat") expect(body.stream_options).toEqual({ include_usage: true });
        if (kind === "claude") expect(body.messages).toBeDefined();
        expect(state.result?.content).toBe("已保存结果");
        expect(state.billing).toMatchObject({ pointsCost: 0.25, pointsRecordId: "priced-record" });
        expect(state.attemptNo).toBe(1);
        expect(mocks.refund).not.toHaveBeenCalled();
    });

    it("uses the saved model streaming path and format over channel defaults", async () => {
        const config = openAiConfig("channel-one", "/api/ai/system/channel-one");
        config.apiFormat = "gemini";
        config.advancedConfig = { ...emptyAdvancedConfig(), streaming: { enabled: false }, modelConfigs: { "text-model": { capability: "text", streaming: { enabled: true, path: "/v1beta/models/:model:streamGenerateContent", format: "ndjson" } } } };
        state = { ...textTask(config), billingMode: "official-usage" };
        const fetcher = vi.spyOn(internalOrigin, "fetchInternalApi").mockResolvedValue(new Response("", { headers: { "x-vozeb-pro-pricing-state": "streaming" } }));
        await runTextTaskStep(state, "http://internal", "");
        expect(String(fetcher.mock.calls[0][0])).toBe("http://internal/api/ai/system/channel-one/v1beta/models/text-model:streamGenerateContent");
        expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).stream).toBeUndefined();
    });

    it("keeps a broken priced stream on its original attempt and recovers without a new call", async () => {
        state = { ...textTask(openAiConfig("channel-one", "/api/ai/system/channel-one"), [openAiConfig("channel-two", "/api/ai/system/channel-two")]), billingMode: "official-usage" };
        const fetcher = vi.spyOn(internalOrigin, "fetchInternalApi").mockResolvedValue(
            new Response(
                new ReadableStream(
                    {
                        pull(controller) {
                            controller.error(new Error("fixture disconnected"));
                        },
                    },
                    { highWaterMark: 0 },
                ),
                { headers: { "x-vozeb-pro-pricing-state": "streaming" } },
            ),
        );
        await expect(runTextTaskStep(state, "http://internal", "")).resolves.toMatchObject({ state: "needs_review" });
        expect(fetcher).toHaveBeenCalledOnce();
        const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
        expect(body.stream).not.toBe(true);
        expect(state.config.channelId).toBe("channel-one");
        expect(state.attemptNo).toBe(1);
        mocks.recoverPriced.mockResolvedValue({ state: "completed", content: "已恢复答案", pointsCost: 0.25, pointsRecordId: "priced-record" });
        await expect(runTextTaskStep(state, "http://internal", "")).resolves.toEqual({ state: "completed" });
        expect(fetcher).toHaveBeenCalledOnce();
        expect(state.result?.content).toBe("已恢复答案");
    });

    it("reuses a running priced attempt and stops at a pending proxy receipt", async () => {
        state = {
            ...textTask(openAiConfig("channel-one", "/api/ai/system/channel-one")),
            billingMode: "official-usage",
            status: "running",
            attemptNo: 1,
            attempts: [{ attemptNo: 1, channelId: "channel-one", model: "text-model", capability: "text", status: "running", startedAt: Date.now() }],
        };
        const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: "pending" }, { status: 409, headers: { "x-vozeb-pro-pricing-state": "pending" } }));
        vi.spyOn(internalOrigin, "fetchInternalApi").mockImplementation(fetchMock);
        await expect(runTextTaskStep(state, "http://internal", "")).resolves.toMatchObject({ state: "needs_review" });
        expect(state.attemptNo).toBe(1);
        expect(state.attempts).toHaveLength(1);
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(new Headers(fetchMock.mock.calls[0][1].headers).get("x-vozeb-pro-points-idempotency-key")).toContain(":attempt:1:");
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

    it("keeps a string-form preflight rejection reason instead of replacing it with status 422", async () => {
        state = textTask(openAiConfig("channel-one", "https://one.example"));
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "积分不足以预留本次预扣" }, { status: 422 })));
        await expect(runTextTaskStep(state, "http://internal", "")).resolves.toEqual({ state: "failed", error: "积分不足" });
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
