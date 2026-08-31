import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SystemChannelAdvancedConfig, SystemModelChannel } from "@/lib/auth/store";
import { fetchInternalApi } from "@/lib/server/internal-origin";
import { getTextPlanningRuntime, isStructuredTextFailure, rankTextPlanningCandidates, requestStructuredText, resetTextPlanningRuntime, type TextPlanningCandidate } from "./text-planning-runtime";

vi.mock("@/lib/server/internal-origin", () => ({ fetchInternalApi: vi.fn() }));
vi.mock("@/lib/server/channel-runtime-health", () => ({ recordChannelRuntimeFailure: vi.fn(), recordChannelRuntimeSuccess: vi.fn() }));

const mockedFetch = vi.mocked(fetchInternalApi);
const tool = { name: "make_plan", description: "创建计划", parameters: { type: "object", properties: { result: { type: "string" } } } };

describe("text planning runtime protocol matrix", () => {
    beforeEach(() => {
        resetTextPlanningRuntime();
        mockedFetch.mockReset();
        vi.useRealTimers();
    });

    it.each(["openai", "sub2api", "newapi"] as const)("%s 严格预设直接使用基础 Chat", async (protocol) => {
        mockedFetch.mockResolvedValue(chatJsonResponse());

        const result = await requestStructuredText(requestInput(candidate(protocol, { createPath: "/responses" })));

        expect(result).toMatchObject({ protocol: "chat", arguments: "{}" });
        expect(mockedFetch).toHaveBeenCalledTimes(1);
        expect(String(mockedFetch.mock.calls[0]?.[0])).toContain("/chat/completions");
        expectBasicJsonMessages(requestBody());
    });

    it("需要结构化结果时优先使用 Chat 原生函数工具", async () => {
        mockedFetch.mockResolvedValue(
            Response.json({
                choices: [{ message: { tool_calls: [{ type: "function", function: { name: "make_plan", arguments: '{"result":"ok"}' } }] } }],
            }),
        );

        const result = await requestStructuredText({ ...requestInput(candidate("newapi")), preferNativeTools: true });

        expect(result.arguments).toBe('{"result":"ok"}');
        expect(requestBody()).toMatchObject({
            tools: [{ type: "function", function: tool }],
            tool_choice: { type: "function", function: { name: "make_plan" } },
        });
    });

    it("接受代理返回的对象型工具参数和 Chat 文本数组", async () => {
        mockedFetch
            .mockResolvedValueOnce(Response.json({ choices: [{ message: { tool_calls: [{ function: { name: "make_plan", arguments: { result: "object" } } }] } }] }))
            .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: [{ type: "text", text: '{"result":"array"}' }] } }] }));

        await expect(requestStructuredText(requestInput(candidate("newapi")))).resolves.toMatchObject({ arguments: '{"result":"object"}' });
        await expect(requestStructuredText(requestInput(candidate("newapi")))).resolves.toMatchObject({ arguments: '{"result":"array"}' });
    });

    it("为 Responses 和 Gemini 发送各自的原生函数声明", async () => {
        mockedFetch
            .mockResolvedValueOnce(Response.json({ output: [{ type: "function_call", name: "make_plan", arguments: '{"result":"responses"}' }] }))
            .mockResolvedValueOnce(Response.json({ candidates: [{ content: { parts: [{ functionCall: { name: "make_plan", args: { result: "gemini" } } }] } }] }));

        await requestStructuredText({ ...requestInput(candidate("compatible", { createPath: "/responses" })), preferNativeTools: true });
        expect(requestBody()).toMatchObject({ tools: [{ type: "function", name: "make_plan", parameters: tool.parameters }], tool_choice: { type: "function", name: "make_plan" } });

        await requestStructuredText({ ...requestInput(candidate("compatible", { apiFormat: "gemini", createPath: "/models/:model:generateContent" })), preferNativeTools: true });
        expect(requestBody()).toMatchObject({
            tools: [{ functionDeclarations: [tool] }],
            toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["make_plan"] } },
        });
    });

    it("原生工具被代理忽略时退款无效响应并降级到严格 JSON 提示词", async () => {
        const onInvalidResponse = vi.fn();
        mockedFetch.mockResolvedValueOnce(Response.json({ choices: [{ message: { content: '{"script":"输入回显"}' } }] })).mockResolvedValueOnce(chatJsonResponse());

        const result = await requestStructuredText({
            ...requestInput(candidate("newapi")),
            headers: { "idempotency-key": "planning-one", "x-vozeb-pro-points-idempotency-key": "billing-tool" },
            fallbackHeaders: { "idempotency-key": "planning-one", "x-vozeb-pro-points-idempotency-key": "billing-json" },
            preferNativeTools: true,
            validateArguments: (argumentsText) => !("script" in JSON.parse(argumentsText)),
            onInvalidResponse,
        });

        expect(result.arguments).toBe("{}");
        expect(mockedFetch).toHaveBeenCalledTimes(2);
        expect(JSON.parse(String(mockedFetch.mock.calls[0]?.[1]?.body))).toHaveProperty("tools");
        expect(JSON.parse(String(mockedFetch.mock.calls[1]?.[1]?.body))).not.toHaveProperty("tools");
        expect(new Headers(mockedFetch.mock.calls[0]?.[1]?.headers).get("idempotency-key")).toBe("planning-one:chat-tool");
        expect(new Headers(mockedFetch.mock.calls[1]?.[1]?.headers).get("idempotency-key")).toBe("planning-one:chat-json");
        expect(new Headers(mockedFetch.mock.calls[0]?.[1]?.headers).get("x-vozeb-pro-points-idempotency-key")).toBe("billing-tool");
        expect(new Headers(mockedFetch.mock.calls[1]?.[1]?.headers).get("x-vozeb-pro-points-idempotency-key")).toBe("billing-json");
        expect(onInvalidResponse).toHaveBeenCalledOnce();
    });

    it("工具和普通 JSON 都失败时只执行一次结构修复请求", async () => {
        const onInvalidResponse = vi.fn();
        mockedFetch
            .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "我会分析后返回结果" } }] }))
            .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: '{"script":"输入回显"}' } }] }))
            .mockResolvedValueOnce(chatJsonResponse());

        const result = await requestStructuredText({
            ...requestInput(candidate("newapi")),
            headers: { "idempotency-key": "planning-repair", "x-vozeb-pro-logical-model": "planner", "x-vozeb-pro-points-idempotency-key": "billing-tool" },
            fallbackHeaders: { "idempotency-key": "planning-repair", "x-vozeb-pro-logical-model": "planner", "x-vozeb-pro-points-idempotency-key": "billing-json" },
            preferNativeTools: true,
            validateArguments: (argumentsText) => !("script" in JSON.parse(argumentsText)),
            onInvalidResponse,
        });

        expect(result.arguments).toBe("{}");
        expect(mockedFetch).toHaveBeenCalledTimes(3);
        const repairBody = JSON.parse(String(mockedFetch.mock.calls[2]?.[1]?.body)) as Record<string, unknown>;
        expect(repairBody).not.toHaveProperty("tools");
        expect(repairBody).toMatchObject({ response_format: { type: "json_object" } });
        expect(JSON.stringify(repairBody.messages)).toContain("上一轮响应没有通过结构校验");
        expect(new Headers(mockedFetch.mock.calls[2]?.[1]?.headers).get("idempotency-key")).toBe("planning-repair:chat-repair");
        expect(new Headers(mockedFetch.mock.calls[2]?.[1]?.headers).get("x-vozeb-pro-points-idempotency-key")).toBe("billing-json:repair");
        expect(onInvalidResponse).toHaveBeenCalledTimes(2);
    });

    it("可以关闭同一输入的结构修复请求", async () => {
        mockedFetch.mockResolvedValue(Response.json({ choices: [{ message: { content: "不是 JSON" } }] }));

        const error = await requestStructuredText({ ...requestInput(candidate("newapi")), allowRepair: false }).catch((value) => value);
        expect(error).toMatchObject({ failureCode: "missing-structured-result", reason: "invalid-structure" });
        expect(isStructuredTextFailure(error)).toBe(true);
        expect(mockedFetch).toHaveBeenCalledOnce();
    });

    it("接受自定义结果字段直接返回的结构化对象", async () => {
        mockedFetch.mockResolvedValue(Response.json({ data: { plan: { result: "object" } } }));

        const result = await requestStructuredText(
            requestInput(
                candidate("custom", {
                    createPath: "/planner/run",
                    requestTemplate: '{"prompt":"{{prompt}}"}',
                    resultField: "data.plan",
                }),
            ),
        );

        expect(result.arguments).toBe('{"result":"object"}');
        expect(mockedFetch).toHaveBeenCalledOnce();
    });

    it("接受没有协议外层包装的直接结构化对象", async () => {
        mockedFetch.mockResolvedValue(Response.json({ result: "direct" }));

        const result = await requestStructuredText(requestInput(candidate("newapi")));

        expect(result.arguments).toBe('{"result":"direct"}');
        expect(mockedFetch).toHaveBeenCalledOnce();
    });

    it("reports invalid upstream JSON instead of collapsing it into a generic structure error", async () => {
        const onInvalidResponse = vi.fn();
        mockedFetch.mockResolvedValue(new Response("not-json", { status: 200, headers: { "content-type": "text/plain" } }));

        const error = await requestStructuredText({ ...requestInput(candidate("newapi")), allowRepair: false, onInvalidResponse }).catch((value) => value);

        expect(error).toMatchObject({ failureCode: "invalid-response-json", reason: "invalid-structure" });
        expect(error.message).toContain("协议：chat");
        expect(onInvalidResponse).toHaveBeenCalledOnce();
    });

    it("从上游包装文本中只接受可解析的 JSON 对象", async () => {
        mockedFetch.mockResolvedValue(Response.json({ choices: [{ message: { content: "结果如下：{'result':'ok'}" } }] }));

        await expect(requestStructuredText(requestInput(candidate("newapi")))).resolves.toMatchObject({ arguments: '{"result":"ok"}' });
    });

    it("compatible 模型明确配置 Responses 时直接使用 Responses", async () => {
        mockedFetch.mockResolvedValue(Response.json({ output_text: "{}" }));

        const result = await requestStructuredText(requestInput(candidate("compatible", { createPath: "/responses" })));

        expect(result).toMatchObject({ protocol: "responses", arguments: "{}" });
        expect(mockedFetch).toHaveBeenCalledTimes(1);
        expect(String(mockedFetch.mock.calls[0]?.[0])).toContain("/responses");
        expect(requestBody()).toMatchObject({ model: "model-one", input: expect.any(Array) });
        expect(requestBody()).not.toHaveProperty("tools");
        expect(requestBody()).not.toHaveProperty("reasoning");
    });

    it("保留显式 /v1/responses 配置并交给系统代理处理版本前缀", async () => {
        mockedFetch.mockResolvedValue(Response.json({ output_text: "{}" }));

        const result = await requestStructuredText(requestInput(candidate("compatible", { createPath: "/v1/responses" })));

        expect(result).toMatchObject({ protocol: "responses", arguments: "{}" });
        expect(String(mockedFetch.mock.calls[0]?.[0])).toContain("/v1/responses");
    });

    it("模型级 Responses 预设覆盖 New API 渠道的默认 Chat", async () => {
        const configured = candidate("newapi", {
            modelConfigs: {
                "model-one": { capability: "text", protocol: "compatible", createPath: "/responses" },
            },
        });
        mockedFetch.mockResolvedValue(Response.json({ output_text: "{}" }));

        const result = await requestStructuredText(requestInput(configured));

        expect(result.protocol).toBe("responses");
        expect(String(mockedFetch.mock.calls[0]?.[0])).toContain("/responses");
    });

    it("模型级自定义协议不会因路径名为 responses 被误判", async () => {
        const configured = candidate("compatible", {
            modelConfigs: {
                "model-one": { capability: "text", protocol: "custom", createPath: "/responses", requestTemplate: '{"deployment":"{{model}}","prompt":"{{prompt}}"}', resultField: "payload.plan" },
            },
        });
        mockedFetch.mockResolvedValue(Response.json({ payload: { plan: "{}" } }));

        const result = await requestStructuredText(requestInput(configured));

        expect(result.protocol).toBe("custom");
        expect(requestBody()).toMatchObject({ deployment: "model-one", prompt: expect.stringContaining("user: test") });
    });

    it("GlobalAiOpc Responses 预设直接使用 Responses", async () => {
        mockedFetch.mockResolvedValue(Response.json({ output: [{ type: "function_call", name: "make_plan", arguments: "{}" }] }));

        const result = await requestStructuredText(requestInput(candidate("globalaiopc", { globalAiOpcPreset: "text-openai-responses" })));

        expect(result.protocol).toBe("responses");
        expect(String(mockedFetch.mock.calls[0]?.[0])).toContain("/responses");
    });

    it.each(["text-gemini-native", "text-claude-native"] as const)("GlobalAiOpc %s 通过系统代理的 Chat 适配调用", async (globalAiOpcPreset) => {
        mockedFetch.mockResolvedValue(chatJsonResponse());

        const result = await requestStructuredText(requestInput(candidate("globalaiopc", { globalAiOpcPreset })));

        expect(result.protocol).toBe("chat");
        expect(String(mockedFetch.mock.calls[0]?.[0])).toContain("/chat/completions");
        expectBasicJsonMessages(requestBody());
    });

    it("Gemini 原生预设使用 generateContent 并解析候选文本", async () => {
        mockedFetch.mockResolvedValue(Response.json({ candidates: [{ content: { parts: [{ text: "{}" }] } }] }));

        const result = await requestStructuredText(
            requestInput(
                candidate("compatible", {
                    apiFormat: "gemini",
                    createPath: "/models/:model:generateContent",
                }),
            ),
        );

        expect(result).toMatchObject({ protocol: "gemini", arguments: "{}" });
        expect(String(mockedFetch.mock.calls[0]?.[0])).toContain("/models/model-one:generateContent");
        expect(requestBody()).toMatchObject({ contents: [{ role: "user", parts: [{ text: "test" }] }], systemInstruction: { parts: [{ text: expect.stringContaining("严格 JSON") }] } });
    });

    it("自定义文本协议使用管理员模板、路径和结果字段", async () => {
        mockedFetch.mockResolvedValue(Response.json({ data: { plan: "{}" } }));

        const result = await requestStructuredText(
            requestInput(
                candidate("custom", {
                    createPath: "/planner/run",
                    requestTemplate: '{"deployment":"{{model}}","conversation":"{{messages}}"}',
                    resultField: "data.plan",
                }),
            ),
        );

        expect(result).toMatchObject({ protocol: "custom", arguments: "{}" });
        expect(String(mockedFetch.mock.calls[0]?.[0])).toContain("/planner/run");
        expect(requestBody()).toMatchObject({ deployment: "model-one", conversation: expect.arrayContaining([{ role: "user", content: "test" }]) });
    });

    it("自定义模板可以接收结构化 prompt_json 占位符", async () => {
        mockedFetch.mockResolvedValue(Response.json({ data: { plan: "{}" } }));

        await requestStructuredText(
            requestInput(
                candidate("custom", {
                    createPath: "/planner/run",
                    requestTemplate: '{"prompt_json":"{{prompt_json}}"}',
                    resultField: "data.plan",
                }),
            ),
        );

        expect(requestBody()).toMatchObject({ prompt_json: "test" });
    });

    it("只为上游协议作用域追加后缀，不改写服务端计费身份", async () => {
        mockedFetch.mockResolvedValue(chatJsonResponse());

        await requestStructuredText({
            ...requestInput(candidate("newapi")),
            headers: { "x-vozeb-pro-points-idempotency-key": "planning-one", "idempotency-key": "planning-one" },
        });

        const headers = new Headers(mockedFetch.mock.calls[0]?.[1]?.headers);
        expect(headers.get("x-vozeb-pro-points-idempotency-key")).toBe("planning-one");
        expect(headers.get("idempotency-key")).toBe("planning-one:chat-json");
    });

    it("上游返回 422 时不会在同一候选内自动重复请求", async () => {
        mockedFetch.mockResolvedValueOnce(new Response("/backend-api/conversation failed: status=422, body=", { status: 422 }));

        await expect(requestStructuredText(requestInput(candidate("newapi")))).rejects.toMatchObject({ status: 422 });
        expect(mockedFetch).toHaveBeenCalledTimes(1);
    });

    it("上游拒绝过大请求体时不暴露代理内部错误", async () => {
        mockedFetch.mockResolvedValueOnce(new Response("/backend-api/conversation failed: status=413, body=", { status: 413 }));

        await expect(requestStructuredText(requestInput(candidate("newapi")))).rejects.toThrow("提交给文本模型的内容过大");
    });

    it("同一渠道不同模型的协议预设互不污染", async () => {
        const channel = candidate("compatible", {
            modelConfigs: {
                "model-one": { capability: "text", protocol: "compatible", createPath: "/responses" },
                "model-two": { capability: "text", protocol: "compatible", createPath: "/chat/completions" },
            },
        }).channel;
        mockedFetch.mockResolvedValueOnce(Response.json({ output_text: "{}" })).mockResolvedValueOnce(chatJsonResponse());

        const first = await requestStructuredText(requestInput({ channelId: channel.id, upstreamModel: "model-one", channel }));
        const second = await requestStructuredText(requestInput({ channelId: channel.id, upstreamModel: "model-two", channel }));

        expect([first.protocol, second.protocol]).toEqual(["responses", "chat"]);
        expect(mockedFetch.mock.calls.map(([url]) => String(url))).toEqual([expect.stringContaining("/responses"), expect.stringContaining("/chat/completions")]);
    });

    it("优先排列近期成功且延迟更低的候选", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        const slow = candidate("newapi", { id: "slow" });
        const fast = candidate("newapi", { id: "fast" });
        mockedFetch.mockImplementationOnce(async () => {
            vi.advanceTimersByTime(900);
            return chatJsonResponse();
        });
        await requestStructuredText(requestInput(slow));
        mockedFetch.mockImplementationOnce(async () => {
            vi.advanceTimersByTime(80);
            return chatJsonResponse();
        });
        await requestStructuredText(requestInput(fast));

        expect(rankTextPlanningCandidates([slow, fast])).toEqual([fast, slow]);
    });

    it("失败候选进入短期冷却并排在健康候选之后", async () => {
        const failed = candidate("newapi", { id: "failed" });
        const healthy = candidate("newapi", { id: "healthy" });
        mockedFetch.mockRejectedValueOnce(new Error("connection refused"));
        await expect(requestStructuredText(requestInput(failed))).rejects.toThrow("暂时无法连接");
        mockedFetch.mockResolvedValueOnce(chatJsonResponse());
        await requestStructuredText(requestInput(healthy));

        expect(rankTextPlanningCandidates([failed, healthy])).toEqual([healthy, failed]);
        expect(getTextPlanningRuntime(failed)?.cooldownUntil).toBeGreaterThan(Date.now());
    });

    it("不会把 HTML 网关错误原文返回给用户", async () => {
        mockedFetch.mockResolvedValue(new Response("<!doctype html><title>Bad gateway</title><body>nginx secret trace</body>", { status: 502 }));

        await expect(requestStructuredText(requestInput(candidate("newapi")))).rejects.toThrow("文本模型渠道暂不可用（HTTP 502）");
    });

    it("把超时转换为可读且可切换渠道的错误", async () => {
        mockedFetch.mockRejectedValue(Object.assign(new Error("timed out"), { name: "TimeoutError" }));

        await expect(requestStructuredText(requestInput(candidate("newapi")))).rejects.toThrow("文本模型规划响应超时");
    });

    it("文本规划候选使用绑定配置的超时", async () => {
        const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
        mockedFetch.mockResolvedValueOnce(chatJsonResponse()).mockResolvedValueOnce(chatJsonResponse());

        await requestStructuredText(requestInput(candidate("newapi")));
        await requestStructuredText(requestInput({ ...candidate("newapi", { id: "long-reasoning" }), capabilityProfile: { timeoutMs: 8 * 60_000 } }));

        expect(timeoutSpy).toHaveBeenNthCalledWith(1, 3 * 60_000);
        expect(timeoutSpy).toHaveBeenNthCalledWith(2, 8 * 60_000);
    });

    it("增量解析 Chat SSE 中的结构化 JSON", async () => {
        mockedFetch.mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"{\\"result\\":\\"ok\\"}"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }));

        await expect(requestStructuredText({ ...requestInput(candidate("newapi")), stream: true })).resolves.toMatchObject({ arguments: '{"result":"ok"}' });
        expect(requestBody()).toMatchObject({ stream: true });
    });

    it("在 SSE 行跨网络分片时仍按事件边界解析", async () => {
        const encoder = new TextEncoder();
        const chunks = ['data: {"choices":[{"delta":{"content":"{\\"result', '\\":\\"chunked\\"}"}}]}\n\n', "data: [DONE]\n\n"];
        mockedFetch.mockResolvedValue(
            new Response(
                new ReadableStream({
                    start(controller) {
                        chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
                        controller.close();
                    },
                }),
                { headers: { "content-type": "text/event-stream" } },
            ),
        );

        await expect(requestStructuredText({ ...requestInput(candidate("newapi")), stream: true })).resolves.toMatchObject({ arguments: '{"result":"chunked"}' });
    });

    it("增量解析 Responses 事件流和 Gemini NDJSON", async () => {
        mockedFetch
            .mockResolvedValueOnce(new Response('data: {"type":"response.output_text.delta","delta":"{\\"result\\":\\"responses\\"}"}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }))
            .mockResolvedValueOnce(new Response('{"candidates":[{"content":{"parts":[{"text":"{\\"result\\":\\"gemini\\"}"}]}}]}\n', { headers: { "content-type": "application/x-ndjson" } }));

        await expect(requestStructuredText({ ...requestInput(candidate("compatible", { createPath: "/responses" })), stream: true })).resolves.toMatchObject({ arguments: '{"result":"responses"}' });
        await expect(
            requestStructuredText({
                ...requestInput(candidate("compatible", { apiFormat: "gemini", createPath: "/models/:model:generateContent", streaming: { enabled: true, path: "/models/:model:streamGenerateContent", format: "ndjson" } })),
                stream: true,
            }),
        ).resolves.toMatchObject({ arguments: '{"result":"gemini"}' });
        expect(String(mockedFetch.mock.calls[1]?.[0])).toContain("/models/model-one:streamGenerateContent");
    });

    it("Gemini 未配置已验证流式路径时保持完整响应", async () => {
        mockedFetch.mockResolvedValue(Response.json({ candidates: [{ content: { parts: [{ text: "{}" }] } }] }));

        await expect(requestStructuredText({ ...requestInput(candidate("compatible", { apiFormat: "gemini", createPath: "/models/:model:generateContent" })), stream: true })).resolves.toMatchObject({ transport: "complete" });
        expect(requestBody()).not.toHaveProperty("stream");
        expect(String(mockedFetch.mock.calls[0]?.[0])).toContain(":generateContent");
    });

    it("渠道关闭流式时强制使用完整响应", async () => {
        mockedFetch.mockResolvedValue(chatJsonResponse());

        await expect(requestStructuredText({ ...requestInput(candidate("newapi", { streaming: { enabled: false } })), stream: true })).resolves.toMatchObject({ transport: "complete" });
        expect(requestBody()).not.toHaveProperty("stream");
        expect(mockedFetch).toHaveBeenCalledTimes(1);
    });

    it("模型级流式配置覆盖渠道级设置", async () => {
        mockedFetch.mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"{}"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }));

        await expect(
            requestStructuredText({
                ...requestInput(
                    candidate("newapi", {
                        streaming: { enabled: false },
                        modelConfigs: { "model-one": { capability: "text", streaming: { enabled: true, path: "/chat/stream", format: "sse" } } },
                    }),
                ),
                stream: true,
            }),
        ).resolves.toMatchObject({ transport: "stream" });
        expect(String(mockedFetch.mock.calls[0]?.[0])).toContain("/chat/stream");
    });

    it("自定义协议只使用管理员声明的流式路径", async () => {
        mockedFetch.mockResolvedValue(new Response('data: {"data":{"plan":"{}"}}\n\n', { headers: { "content-type": "text/event-stream" } }));

        await expect(
            requestStructuredText({
                ...requestInput(candidate("custom", { createPath: "/planner/run", requestTemplate: '{"prompt":"{{prompt}}"}', resultField: "data.plan", streaming: { enabled: true, path: "/planner/stream", format: "sse" } })),
                stream: true,
            }),
        ).resolves.toMatchObject({ transport: "stream", arguments: "{}" });
        expect(String(mockedFetch.mock.calls[0]?.[0])).toContain("/planner/stream");
    });

    it("流式请求被渠道拒绝时回退一次完整 JSON 请求", async () => {
        mockedFetch.mockResolvedValueOnce(new Response("stream unsupported", { status: 422 })).mockResolvedValueOnce(chatJsonResponse());

        await expect(requestStructuredText({ ...requestInput(candidate("newapi")), headers: { "idempotency-key": "stream-fallback" }, stream: true })).resolves.toMatchObject({ arguments: "{}" });
        expect(mockedFetch).toHaveBeenCalledTimes(2);
        expect(JSON.parse(String(mockedFetch.mock.calls[0]?.[1]?.body))).toMatchObject({ stream: true });
        expect(JSON.parse(String(mockedFetch.mock.calls[1]?.[1]?.body))).not.toHaveProperty("stream");
        expect(new Headers(mockedFetch.mock.calls[0]?.[1]?.headers).get("idempotency-key")).toContain(":chat-json-stream");
        expect(new Headers(mockedFetch.mock.calls[1]?.[1]?.headers).get("idempotency-key")).toContain(":chat-json");
    });
});

function requestInput(configured: TextPlanningCandidate) {
    return {
        origin: "http://127.0.0.1:3000",
        cookie: "session=test",
        candidate: configured,
        messages: [{ role: "user", content: "test" }],
        tool,
    };
}

function candidate(protocol: NonNullable<SystemChannelAdvancedConfig>["protocol"], options: Partial<SystemChannelAdvancedConfig> & { id?: string; apiFormat?: "openai" | "gemini" } = {}): TextPlanningCandidate {
    const id = options.id || `${protocol}-channel`;
    const advancedConfig = {
        protocol,
        textModel: "model-one",
        imageModel: "",
        videoModel: "",
        createPath: "",
        queryPath: "",
        requestTemplate: "",
        resultField: "",
        statusField: "",
        durationRange: "",
        referenceRule: "",
        supportsReferenceImage: false,
        supportsReferenceVideo: false,
        supportsReferenceAudio: false,
        ...options,
    } satisfies SystemChannelAdvancedConfig;
    const channel = {
        id,
        name: id,
        baseUrl: "https://example.com/v1",
        apiKey: "secret",
        apiFormat: options.apiFormat || "openai",
        models: ["model-one", "model-two"],
        enabled: true,
        advancedConfig,
    } satisfies SystemModelChannel;
    return { channelId: id, upstreamModel: "model-one", channel };
}

function requestBody() {
    return JSON.parse(String(mockedFetch.mock.calls.at(-1)?.[1]?.body)) as Record<string, unknown>;
}

function expectBasicJsonMessages(body: Record<string, unknown>) {
    expect(body).toMatchObject({ model: "model-one", messages: expect.arrayContaining([{ role: "user", content: "test" }]) });
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("max_completion_tokens");
}

function chatJsonResponse() {
    return Response.json({ choices: [{ message: { content: "{}" } }] });
}
