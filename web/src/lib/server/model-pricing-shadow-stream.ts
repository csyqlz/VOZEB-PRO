import { JSONParser } from "@streamparser/json";
import { createParser } from "eventsource-parser";
import { safeAnthropicBlockType, safeAnthropicStopReason, type ShadowTextOutcome } from "./model-pricing-shadow-call";
import { inspectProviderTokenUsage, type TokenUsageProtocol } from "./model-pricing-token-usage";

export type PublicStreamText = (index: number, text: string, replace?: boolean) => void;

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const records = (value: unknown) => (Array.isArray(value) ? value.map(record) : []);

/** Retain only usage and identity; an opt-in consumer may collect public text separately. */
export function createShadowStreamObserver(protocol: TokenUsageProtocol, format: "sse" | "ndjson" = "sse", onPublicText?: PublicStreamText, responseHeaders?: Headers) {
    const identity: Record<string, unknown> = {};
    let usage: Record<string, unknown> = {};
    let terminal = false;
    let anthropicMessageStopSeen = false;
    let unavailable: string | undefined;
    const outputs = new Map<number, { text: boolean; finished: boolean; kind?: string }>();
    const reject = (reason: string) => {
        unavailable ||= reason;
    };
    const observeIdentity = (body: Record<string, unknown>) => {
        for (const key of ["model", "modelVersion", "service_tier"]) {
            if (body[key] === undefined) continue;
            if (identity[key] !== undefined && identity[key] !== body[key]) reject("流式响应的模型或服务档位发生变化");
            identity[key] = body[key];
        }
    };
    const output = (index: unknown) => {
        if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) {
            reject("流式输出缺少有效序号");
            return { text: false, finished: false, kind: undefined };
        }
        if (!outputs.has(index)) outputs.set(index, { text: false, finished: false });
        return outputs.get(index)!;
    };
    const consume = (value: unknown, eventType?: string) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            reject("流式事件不是有效 JSON 对象");
            return;
        }
        const body = record(value);
        if (body.type === "ping") return;
        if (terminal) reject("流式结束标记后仍收到响应事件");
        if (body.error || body.type === "error" || eventType === "error") reject("上游流式响应包含错误事件");
        if (protocol === "openai-chat") {
            observeIdentity(body);
            if (body.usage) usage = record(body.usage);
            for (const choice of records(body.choices)) {
                const state = output(choice.index);
                const delta = record(choice.delta);
                if (delta.tool_calls || delta.function_call || delta.audio) reject("流式输出包含尚未验证的工具或音频费用");
                if (delta.content !== undefined && delta.content !== null) {
                    if (typeof delta.content !== "string") reject("流式输出不是纯文本");
                    else {
                        if (state.finished && delta.content) reject("已结束的输出仍收到文本增量");
                        state.text = true;
                        if (choice.index === 0) onPublicText?.(0, delta.content);
                    }
                }
                if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
                    state.finished = ["stop", "length"].includes(String(choice.finish_reason));
                    if (!state.finished) reject("流式输出没有正常结束");
                }
            }
        } else if (protocol === "openai-responses") {
            const response = record(body.response);
            observeIdentity(response);
            if (response.usage) usage = record(response.usage);
            if (["response.failed", "response.incomplete", "response.error"].includes(String(body.type))) reject("上游流式响应未完成");
            if (body.type === "response.completed") {
                terminal = response.status === "completed";
                const items = records(response.output);
                if (!items.length || items.some((item) => item.type !== "reasoning" && (item.type !== "message" || !records(item.content).length || records(item.content).some((part) => part.type !== "output_text" || typeof part.text !== "string"))))
                    reject("流式完成响应包含未验证的输出类型");
                onPublicText?.(
                    0,
                    items
                        .filter((item) => item.type === "message")
                        .flatMap((item) => records(item.content))
                        .filter((part) => part.type === "output_text" && typeof part.text === "string")
                        .map((part) => part.text)
                        .join(""),
                    true,
                );
            }
        } else if (protocol === "anthropic-messages") {
            if (body.type === "message_start") {
                const message = record(body.message);
                observeIdentity(message);
                usage = { ...usage, ...record(message.usage) };
                if (records(message.content).length) reject("流式初始内容未验证");
            }
            if (body.type === "content_block_start") {
                const block = record(body.content_block);
                const state = output(body.index);
                state.kind = safeAnthropicBlockType(block.type);
                state.text = block.type === "text" && typeof block.text === "string";
                if (!state.text && !(block.type === "thinking" && typeof block.thinking === "string")) reject("流式输出包含尚未验证的内容类型");
                else if (state.text && typeof body.index === "number") onPublicText?.(body.index, String(block.text), true);
            }
            if (body.type === "content_block_delta") {
                const delta = record(body.delta);
                const state = output(body.index);
                if (
                    state.finished ||
                    (state.kind === "text" && (delta.type !== "text_delta" || typeof delta.text !== "string")) ||
                    (state.kind === "thinking" && !((delta.type === "thinking_delta" && typeof delta.thinking === "string") || (delta.type === "signature_delta" && typeof delta.signature === "string"))) ||
                    !["text", "thinking"].includes(state.kind || "")
                )
                    reject("流式输出包含非文本或顺序无效的增量");
                else if (state.text && typeof body.index === "number") onPublicText?.(body.index, String(delta.text));
            }
            if (body.type === "content_block_stop") output(body.index).finished = true;
            if (body.type === "message_delta") {
                usage = { ...usage, ...record(body.usage) };
                const stop = record(body.delta).stop_reason;
                if (stop != null) identity.stop_reason = stop;
            }
            if (body.type === "message_stop") {
                anthropicMessageStopSeen = true;
                terminal = ["end_turn", "max_tokens", "stop_sequence"].includes(String(identity.stop_reason));
            }
        } else {
            observeIdentity(body);
            if (body.usageMetadata) usage = record(body.usageMetadata);
            for (const candidate of records(body.candidates)) {
                const state = output(candidate.index);
                for (const part of records(record(candidate.content).parts)) {
                    if (typeof part.text !== "string" || part.inlineData || part.fileData || part.functionCall) reject("流式输出不是纯文本");
                    else {
                        if (state.finished && part.text) reject("已结束的输出仍收到文本增量");
                        state.text = true;
                        if (candidate.index === 0 && !part.thought) onPublicText?.(0, String(part.text));
                    }
                }
                if (candidate.finishReason != null) {
                    state.finished = ["STOP", "MAX_TOKENS"].includes(String(candidate.finishReason));
                    if (!state.finished) reject("流式输出没有正常结束");
                }
            }
        }
    };
    const parser = createParser({
        onError(error) {
            if (error.type !== "invalid-retry" && error.type !== "unknown-field") reject("流式事件格式无法解析");
        },
        onEvent(event) {
            if (event.data === "[DONE]") {
                if (protocol === "openai-chat") terminal = true;
                return;
            }
            try {
                consume(JSON.parse(event.data), event.event);
            } catch {
                reject("流式事件不是有效 JSON");
            }
        },
    });
    const jsonParser = format === "ndjson" ? new JSONParser({ separator: "\n", paths: ["$"] }) : undefined;
    if (jsonParser) {
        jsonParser.onValue = ({ value }) => consume(value);
        jsonParser.onError = () => reject("NDJSON 响应未完整解析");
    }

    return {
        append(chunk: string) {
            try {
                if (jsonParser) jsonParser.write(chunk);
                else parser.feed(chunk);
            } catch {
                reject("流式事件无法解析");
            }
        },
        finish(): ShadowTextOutcome {
            if (jsonParser) {
                try {
                    jsonParser.end();
                } catch {
                    reject("NDJSON 响应未完整解析");
                }
            }
            const finishedOutputs = outputs.size > 0 && [...outputs.values()].every((value) => value.text && value.finished);
            const anthropicBlocks = [...outputs.entries()].sort(([left], [right]) => left - right).map(([, value]) => value);
            const anthropicComplete = anthropicBlocks.some((value) => value.text) && anthropicBlocks.every((value) => value.finished && ["text", "thinking"].includes(value.kind || ""));
            const complete = protocol === "openai-responses" ? terminal : protocol === "gemini-generate" ? finishedOutputs : terminal && (protocol === "anthropic-messages" ? anthropicComplete : finishedOutputs);
            parser.reset();
            return {
                stream: {
                    observation: inspectProviderTokenUsage(protocol, { ...identity, [protocol === "gemini-generate" ? "usageMetadata" : "usage"]: usage }, responseHeaders),
                    complete,
                    ...(protocol === "anthropic-messages"
                        ? {
                              responseMeta: {
                                  stopReason: safeAnthropicStopReason(identity.stop_reason),
                                  contentBlockTypes: anthropicBlocks.map((value) => value.kind || "missing"),
                                  terminalSeen: anthropicMessageStopSeen,
                                  blocksClosed: anthropicBlocks.every((value) => value.finished),
                              },
                          }
                        : {}),
                },
                ...(unavailable ? { unavailable } : {}),
            };
        },
    };
}

/** Read on demand, preserve original bytes/backpressure, and forward cancellation upstream. */
export function observeShadowTextStream(
    body: ReadableStream<Uint8Array>,
    protocol: TokenUsageProtocol,
    observe: (outcome: ShadowTextOutcome) => Promise<unknown> | undefined,
    format: "sse" | "ndjson" = "sse",
    onPublicText?: PublicStreamText,
    responseHeaders?: Headers,
) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const observer = createShadowStreamObserver(protocol, format, onPublicText, responseHeaders);
    let settled = false;
    const finish = async (outcome: ShadowTextOutcome) => {
        if (settled) return;
        settled = true;
        await observe(outcome);
    };
    return new ReadableStream<Uint8Array>(
        {
            async pull(controller) {
                try {
                    const next = await reader.read();
                    if (settled) return;
                    if (next.done) {
                        observer.append(decoder.decode());
                        await finish(observer.finish());
                        controller.close();
                        reader.releaseLock();
                    } else {
                        observer.append(decoder.decode(next.value, { stream: true }));
                        controller.enqueue(next.value);
                    }
                } catch (error) {
                    await finish({ failure: "上游流式响应未完整读取" });
                    controller.error(error);
                    reader.releaseLock();
                }
            },
            async cancel(reason) {
                try {
                    await Promise.all([reader.cancel(reason), finish({ failure: "流式响应读取已取消" })]);
                } finally {
                    reader.releaseLock();
                }
            },
        },
        { highWaterMark: 0 },
    );
}
