import { describe, expect, it, vi } from "vitest";
import { createShadowStreamObserver, observeShadowTextStream } from "./model-pricing-shadow-stream";
import type { TokenUsageProtocol } from "./model-pricing-token-usage";

const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const usage = { prompt_tokens: 8, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 } };
const chat = event({ model: "fixture", service_tier: "default", choices: [{ index: 0, delta: { content: "你好" } }] }) + event({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + event({ usage }) + "data: [DONE]\n\n";
const responses =
    event({ type: "response.created", response: { model: "fixture", service_tier: "default" } }) +
    event({ type: "response.output_text.delta", delta: "你好" }) +
    event({
        type: "response.completed",
        response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "你好" }] }], usage: { input_tokens: 8, output_tokens: 8, input_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 } } },
    });
const anthropic =
    event({
        type: "message_start",
        message: {
            model: "fixture",
            content: [],
            usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 1, cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 0 }, service_tier: "standard" },
        },
    }) +
    event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
    event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好" } }) +
    event({ type: "content_block_stop", index: 0 }) +
    event({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 8 } }) +
    event({ type: "message_stop" });
const gemini =
    event({ modelVersion: "fixture", candidates: [{ index: 0, content: { parts: [{ text: "你好" }] } }] }) +
    event({ candidates: [{ index: 0, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 8, cachedContentTokenCount: 2, candidatesTokenCount: 7, thoughtsTokenCount: 1, serviceTier: "standard" } });
const geminiLines = gemini.replaceAll("data: ", "").replaceAll("\n\n", "\r\n");

describe("shadow stream usage", () => {
    it.each(["\r\n", "\n", ""])("observes split Gemini NDJSON with trailing delimiter %j without changing bytes", async (ending) => {
        const raw = geminiLines.trimEnd() + ending;
        const bytes = new TextEncoder().encode(raw);
        let offset = 0;
        const source = new ReadableStream<Uint8Array>(
            {
                pull(controller) {
                    if (offset < bytes.length) controller.enqueue(bytes.slice(offset, ++offset));
                    else controller.close();
                },
            },
            { highWaterMark: 0 },
        );
        const observe = vi.fn(async () => undefined);
        expect(await new Response(observeShadowTextStream(source, "gemini-generate", observe, "ndjson")).text()).toBe(raw);
        expect(observe).toHaveBeenCalledExactlyOnceWith({
            stream: { complete: true, observation: expect.objectContaining({ reportedModel: "fixture", quantities: expect.objectContaining({ inputTokens: "6", cachedInputTokens: "2", outputTokens: "8" }), missing: [] }) },
        });
        expect(JSON.stringify(observe.mock.calls)).not.toContain("你好");
    });

    it.each([
        ["partial final object", geminiLines + '{"usageMetadata":'],
        ["invalid JSON", geminiLines + "{bad}\n"],
        ["array instead of event", geminiLines + "[]\n"],
        ["upstream error", geminiLines + JSON.stringify({ error: { message: "private error" } }) + "\n"],
        ["changed model", geminiLines + JSON.stringify({ modelVersion: "other" }) + "\n"],
        ["non-text output", geminiLines.replace('"text":"你好"', '"functionCall":{}')],
    ])("keeps Gemini NDJSON unpriced for %s", (_name, raw) => {
        const observer = createShadowStreamObserver("gemini-generate", "ndjson");
        observer.append(raw);
        const result = observer.finish();
        expect(result.unavailable).toBeTruthy();
        expect(JSON.stringify(result)).not.toContain("private error");
    });

    it("requires a finished candidate and explicit usage in NDJSON", () => {
        const observer = createShadowStreamObserver("gemini-generate", "ndjson");
        observer.append(geminiLines.split("\r\n")[0] + "\n");
        expect(observer.finish().stream).toMatchObject({ complete: false, observation: { missing: expect.arrayContaining(["promptTokenCount", "candidatesTokenCount"]) } });
    });

    it("uses the final cumulative NDJSON usage and requires every candidate to finish", () => {
        const start = JSON.stringify({ usageMetadata: { promptTokenCount: 8, cachedContentTokenCount: 2, candidatesTokenCount: 1, thoughtsTokenCount: 0 } }) + "\n";
        const complete = createShadowStreamObserver("gemini-generate", "ndjson");
        complete.append(start + geminiLines);
        expect(complete.finish().stream).toMatchObject({ complete: true, observation: { quantities: { outputTokens: "8" } } });
        const unfinished = createShadowStreamObserver("gemini-generate", "ndjson");
        unfinished.append(geminiLines + JSON.stringify({ candidates: [{ index: 1, content: { parts: [{ text: "unfinished candidate" }] } }] }) + "\n");
        expect(unfinished.finish().stream?.complete).toBe(false);
    });

    it.each([
        ["openai-chat", chat],
        ["openai-responses", responses],
        ["anthropic-messages", anthropic],
        ["gemini-generate", gemini],
    ] as [TokenUsageProtocol, string][])("preserves split UTF-8 bytes and records only cumulative usage for %s", async (protocol, raw) => {
        const bytes = new TextEncoder().encode(raw);
        let offset = 0;
        const source = new ReadableStream<Uint8Array>(
            {
                pull(controller) {
                    if (offset < bytes.length) controller.enqueue(bytes.slice(offset, ++offset));
                    else controller.close();
                },
            },
            { highWaterMark: 0 },
        );
        const observe = vi.fn(async () => undefined);
        const result = observeShadowTextStream(source, protocol, observe);
        expect(observe).not.toHaveBeenCalled();
        expect(await new Response(result).text()).toBe(raw);
        expect(observe).toHaveBeenCalledOnce();
        expect(observe.mock.calls[0]).toEqual([
            expect.objectContaining({ stream: expect.objectContaining({ complete: true, observation: expect.objectContaining({ reportedModel: "fixture", quantities: expect.objectContaining({ outputTokens: "8" }), missing: [] }) }) }),
        ]);
        expect(JSON.stringify(observe.mock.calls)).not.toContain("你好");
    });

    it("keeps Kimi K2.6 cache hits from the final Chat usage without inventing cache writes", () => {
        const finalUsage = { prompt_tokens: 8, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 2 } };
        const raw = chat.replace('"model":"fixture"', '"model":"kimi-k2.6"').replace(event({ usage }), event({ choices: [], usage: finalUsage }));
        const observer = createShadowStreamObserver("openai-chat");
        observer.append(raw);
        expect(observer.finish()).toMatchObject({
            stream: {
                complete: true,
                observation: {
                    reportedModel: "kimi-k2.6",
                    quantities: { uncachedInputTokens: "6", cachedInputTokens: "2", outputTokens: "8" },
                    missing: ["cache_write_tokens"],
                },
            },
        });
        const noFinalUsage = createShadowStreamObserver("openai-chat");
        noFinalUsage.append(raw.replace(event({ choices: [], usage: finalUsage }), ""));
        expect(noFinalUsage.finish().stream?.observation.missing).toEqual(expect.arrayContaining(["prompt_tokens", "completion_tokens"]));
    });

    it("combines Kimi K3 final Chat usage with original TTL headers without exposing them", async () => {
        const raw = chat.replace('"model":"fixture"', '"model":"kimi-k3"').replace(
            event({ usage }),
            event({
                choices: [],
                usage: {
                    prompt_tokens: 8,
                    completion_tokens: 8,
                    prompt_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 },
                },
            }),
        );
        const headers = new Headers({ "Msh-Usage-Cache-Write-Tokens-5m": "0", "Msh-Usage-Cache-Write-Tokens-1h": "1" });
        const observe = vi.fn(async () => undefined);
        expect(await new Response(observeShadowTextStream(new Response(raw).body!, "openai-chat", observe, "sse", undefined, headers)).text()).toBe(raw);
        expect(observe).toHaveBeenCalledWith({
            stream: {
                complete: true,
                observation: expect.objectContaining({
                    quantities: expect.objectContaining({
                        inputTokens: "5",
                        cachedInputTokens: "2",
                        cacheWrite5mTokens: "0",
                        cacheWrite1hTokens: "1",
                        outputTokens: "8",
                    }),
                }),
            },
        });
        expect(JSON.stringify(observe.mock.calls)).not.toContain("你好");
    });

    it("emits public Anthropic blocks separately and keeps text out of its metering receipt", () => {
        const parts = new Map<number, string>();
        const observer = createShadowStreamObserver("anthropic-messages", "sse", (index, text, replace) => parts.set(index, replace ? text : (parts.get(index) || "") + text));
        const extra =
            event({ type: "content_block_start", index: 1, content_block: { type: "text", text: "，第二段" } }) +
            event({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "结束" } }) +
            event({ type: "content_block_stop", index: 1 });
        observer.append(anthropic.replace(event({ type: "message_stop" }), extra + event({ type: "message_stop" })));
        const result = observer.finish();
        expect([...parts.values()].join("")).toBe("你好，第二段结束");
        expect(result.stream?.complete).toBe(true);
        expect(result.unavailable).toBeUndefined();
        expect(JSON.stringify(result)).not.toContain("第二段");
    });

    it("accepts completed Anthropic thinking as an output detail without retaining its content", () => {
        const thinking =
            event({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "private thought" } }) +
            event({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "more private thought" } }) +
            event({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "private signature" } }) +
            event({ type: "content_block_stop", index: 0 });
        const raw =
            event({
                type: "message_start",
                message: { model: "fixture", content: [], usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 1, cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 0 } } },
            }) +
            thinking +
            event({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }) +
            event({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "你好" } }) +
            event({ type: "content_block_stop", index: 1 }) +
            event({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 8, output_tokens_details: { thinking_tokens: 3 } } }) +
            event({ type: "message_stop" });
        const observer = createShadowStreamObserver("anthropic-messages");
        observer.append(raw);
        expect(observer.finish()).toMatchObject({ stream: { complete: true, responseMeta: { stopReason: "end_turn", contentBlockTypes: ["thinking", "text"], terminalSeen: true, blocksClosed: true }, observation: { quantities: { outputTokens: "8" } } } });
        expect(JSON.stringify(observer.finish())).not.toContain("private thought");
        expect(JSON.stringify(observer.finish())).not.toContain("private signature");
    });

    it("retains safe Anthropic stop and block types while blocking tool output", () => {
        const observer = createShadowStreamObserver("anthropic-messages");
        observer.append(anthropic.replace('"type":"text","text":""', '"type":"tool_use","id":"private tool id"'));
        expect(observer.finish()).toMatchObject({ unavailable: "流式输出包含尚未验证的内容类型", stream: { complete: false, responseMeta: { contentBlockTypes: ["tool_use"] } } });
        expect(JSON.stringify(observer.finish())).not.toContain("private tool id");
    });

    it.each([
        ["openai-chat", chat.replace(event({ usage }), event({ choices: [{ index: 0, delta: { content: "late" } }] }) + event({ usage }))],
        ["anthropic-messages", anthropic.replace(event({ type: "message_stop" }), event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "late" } }) + event({ type: "message_stop" }))],
        ["gemini-generate", gemini + event({ candidates: [{ index: 0, content: { parts: [{ text: "late" }] } }] })],
    ] as [TokenUsageProtocol, string][])("rejects text arriving after a finished output in %s", (protocol, raw) => {
        const observer = createShadowStreamObserver(protocol);
        observer.append(raw);
        expect(observer.finish().unavailable).toBeTruthy();
    });

    it("handles SSE comments, CRLF and multiline data without guessing a terminal marker", () => {
        const observer = createShadowStreamObserver("openai-chat");
        observer.append(': heartbeat\r\nevent: message\r\ndata: {"model":"fixture",\r\ndata: "service_tier":"default","choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}]}\r\n\r\n');
        observer.append(event({ usage }));
        observer.append("data: [DONE]");
        expect(observer.finish().stream?.complete).toBe(false);
    });

    it.each([
        ["missing usage", chat.replace(event({ usage }), ""), "missing"],
        ["no end marker", chat.replace("data: [DONE]\n\n", ""), "incomplete"],
        ["unfinished choice", chat.replace('"finish_reason":"stop"', '"finish_reason":null'), "incomplete"],
        ["upstream error", chat + event({ error: { message: "private upstream error" } }), "unavailable"],
        ["tool output", chat.replace('"content":"你好"', '"tool_calls":[{}]'), "unavailable"],
        ["audio output", chat.replace('"content":"你好"', '"audio":{}'), "unavailable"],
        ["changed identity", chat.replace(event({ usage }), event({ model: "other", usage })), "unavailable"],
        ["invalid JSON", chat.replace(event({ usage }), "data: {broken\n\n"), "unavailable"],
    ])("does not silently price %s", (_name, raw, reason) => {
        const observer = createShadowStreamObserver("openai-chat");
        observer.append(raw);
        const result = observer.finish();
        if (reason === "missing") expect(result.stream?.observation.missing.length).toBeGreaterThan(0);
        if (reason === "incomplete") expect(result.stream?.complete).toBe(false);
        if (reason === "unavailable") expect(result.unavailable).toBeTruthy();
        expect(JSON.stringify(result)).not.toContain("private upstream error");
    });

    it.each(["sse", "ndjson"] as const)("does not consume %s ahead of the reader and forwards cancellation once", async (format) => {
        const cancel = vi.fn();
        const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => controller.enqueue(new TextEncoder().encode(event({ choices: [{ index: 0, delta: { content: "partial" } }] }))));
        const observe = vi.fn(async () => undefined);
        const result = observeShadowTextStream(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), format === "ndjson" ? "gemini-generate" : "openai-chat", observe, format);
        expect(pull).not.toHaveBeenCalled();
        const reader = result.getReader();
        await reader.read();
        expect(pull).toHaveBeenCalledOnce();
        await reader.cancel("client canceled");
        expect(cancel).toHaveBeenCalledWith("client canceled");
        expect(observe).toHaveBeenCalledExactlyOnceWith({ failure: "流式响应读取已取消" });
    });

    it.each(["sse", "ndjson"] as const)("preserves an upstream %s read error without an invented zero quote", async (format) => {
        const failure = new Error("broken stream");
        const observe = vi.fn(async () => undefined);
        const source = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.error(failure);
            },
        });
        await expect(new Response(observeShadowTextStream(source, format === "ndjson" ? "gemini-generate" : "openai-chat", observe, format)).text()).rejects.toThrow("broken stream");
        expect(observe).toHaveBeenCalledExactlyOnceWith({ failure: "上游流式响应未完整读取" });
    });

    it("handles a rejected upstream cancellation while observation storage is still pending", async () => {
        const stored = Promise.withResolvers<void>();
        const failure = new Error("upstream cancellation failed");
        const observe = vi.fn(() => stored.promise);
        const source = new ReadableStream<Uint8Array>({
            cancel() {
                return Promise.reject(failure);
            },
        });
        const reader = observeShadowTextStream(source, "openai-chat", observe).getReader();
        const canceled = reader.cancel();
        await expect(canceled).rejects.toBe(failure);
        expect(observe).toHaveBeenCalledExactlyOnceWith({ failure: "流式响应读取已取消" });
        stored.resolve();
    });
});
