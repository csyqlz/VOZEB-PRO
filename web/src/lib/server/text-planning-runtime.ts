import type { SystemModelChannel } from "@/lib/auth/store";
import { recordChannelRuntimeFailure, recordChannelRuntimeSuccess } from "@/lib/server/channel-runtime-health";
import { fetchInternalApi } from "@/lib/server/internal-origin";
import { resolveModelRequestTimeoutMs } from "@/lib/server/model-request-policy";
import { buildProviderRequest, isProviderBusinessError, readProviderError, readProviderString, readProviderValue } from "@/lib/server/provider-task-config";
import { extractJsonObjectText } from "@/lib/server/structured-model-output";
import { SYSTEM_AI_LOGICAL_MODEL_HEADER, SYSTEM_AI_POINTS_IDEMPOTENCY_HEADER, SYSTEM_AI_UPSTREAM_MODEL_HEADER, systemAiBillingHeaders } from "@/lib/server/system-ai-billing";
import { interpolateModelPath, resolveTextProtocol } from "@/lib/server/text-protocol-resolver";
import { resolveChannelModelConfig } from "@/lib/channel-protocol-registry";

export type TextPlanningProtocol = "responses" | "chat" | "gemini" | "custom";
export type TextPlanningCandidate = {
    channelId: string;
    upstreamModel: string;
    channel: SystemModelChannel;
    capabilityProfile?: { timeoutMs?: number };
};
export type TextPlanningTool = { name: string; description: string; parameters: Record<string, unknown> };
export type TextPlanningCall = { arguments: string; headers: Headers; protocol: TextPlanningProtocol; elapsedMs: number; transport?: "stream" | "complete"; fallbackReason?: string };
type TextPlanningRequestErrorReason = "http" | "transport" | "invalid-structure";
export type StructuredTextFailureCode = "invalid-response-json" | "missing-structured-result" | "invalid-structured-result";

type RuntimeState = {
    preferred?: TextPlanningProtocol;
    consecutiveFailures: number;
    cooldownUntil?: number;
    successCount: number;
    failureCount: number;
    averageLatencyMs?: number;
    lastFailureAt?: number;
    lastSuccessAt?: number;
};

export type StructuredTextRequest = {
    origin: string;
    cookie: string;
    candidate: TextPlanningCandidate;
    messages: Array<{ role: string; content: string }>;
    tool: TextPlanningTool;
    headers?: HeadersInit;
    fallbackHeaders?: HeadersInit;
    signal?: AbortSignal;
    allowNaturalLanguage?: boolean;
    preferNativeTools?: boolean;
    allowRepair?: boolean;
    validateArguments?: (argumentsText: string) => boolean;
    onInvalidResponse?: (headers: Headers) => Promise<unknown>;
    stream?: boolean;
    streamFallback?: boolean;
    onStreamStart?: () => Promise<void> | void;
};

type ProtocolRequest = {
    protocol: TextPlanningProtocol;
    variant: "json" | "tool" | "repair";
    path: string;
    body: Record<string, unknown>;
    resultField?: string;
    stream?: boolean;
    streamFormat?: "sse" | "ndjson";
};

const FAILURE_COOLDOWN_MS = 30_000;
const TEXT_RESULT_KEYS = ["output_text", "text", "content", "response", "result"];
const states = new Map<string, RuntimeState>();

export class TextPlanningRequestError extends Error {
    constructor(
        message: string,
        readonly status = 502,
        readonly retryable = status >= 500 || status === 408 || status === 429,
        readonly reason: TextPlanningRequestErrorReason = "http",
        readonly failureCode?: StructuredTextFailureCode,
    ) {
        super(message);
        this.name = "TextPlanningRequestError";
    }
}

export function isStructuredTextFailure(error: unknown): error is TextPlanningRequestError {
    return error instanceof TextPlanningRequestError && error.reason === "invalid-structure";
}

export function rankTextPlanningCandidates<T extends TextPlanningCandidate>(candidates: T[], now = Date.now()) {
    return candidates
        .map((candidate, index) => ({ candidate, index, state: states.get(runtimeKey(candidate)) }))
        .sort((left, right) => candidateScore(left.state, now) - candidateScore(right.state, now) || left.index - right.index)
        .map(({ candidate }) => candidate);
}

export function preferredTextPlanningProtocol(candidate: TextPlanningCandidate): TextPlanningProtocol {
    return planningProtocolRequest(candidate, [], "json").protocol;
}

export async function requestStructuredText(input: StructuredTextRequest): Promise<TextPlanningCall> {
    const startedAt = Date.now();
    const messages = planningMessages(input);
    const requests = planningProtocolRequests(input, messages);
    try {
        for (const [index, request] of requests.entries()) {
            try {
                const response = await requestTextProtocol(input, request);
                if (request.stream) await input.onStreamStart?.();
                return await readStructuredResponse(input, request, response, startedAt);
            } catch (error) {
                if (input.stream && input.streamFallback !== false && index === 0 && shouldFallbackFromStream(error)) {
                    const fallback = await requestStructuredText({
                        ...input,
                        headers: streamFallbackHeaders(input.headers, input.candidate.upstreamModel),
                        fallbackHeaders: streamFallbackHeaders(input.fallbackHeaders, input.candidate.upstreamModel),
                        stream: false,
                        streamFallback: false,
                    });
                    return { ...fallback, fallbackReason: error instanceof Error ? error.message : "上游不支持流式规划" };
                }
                if (index === requests.length - 1 || (!shouldFallbackFromNativeTool(error, request) && !shouldRepairStructuredResponse(error, request))) throw error;
            }
        }
        throw new TextPlanningRequestError("模型没有返回所需的结构化结果", 502, false);
    } catch (error) {
        recordTextFailure(input.candidate, error);
        throw error;
    }
}

export function getTextPlanningRuntime(candidate: TextPlanningCandidate) {
    const current = states.get(runtimeKey(candidate));
    return current ? { ...current } : undefined;
}

export function resetTextPlanningRuntime() {
    states.clear();
}

function planningProtocolRequests(input: StructuredTextRequest, messages: Array<{ role: string; content: string }>) {
    const promptRequest = planningProtocolRequest(input.candidate, messages, "json", undefined, input.stream === true);
    if (input.allowRepair === false) {
        return input.preferNativeTools && promptRequest.protocol !== "custom" ? [planningProtocolRequest(input.candidate, messages, "tool", input.tool), promptRequest] : [promptRequest];
    }
    const recoveryRequest = planningProtocolRequest(input.candidate, planningMessages(input, true), "repair");
    if (!input.preferNativeTools || promptRequest.protocol === "custom") return [promptRequest, recoveryRequest];
    return [planningProtocolRequest(input.candidate, messages, "tool", input.tool), promptRequest, recoveryRequest];
}

function planningProtocolRequest(candidate: TextPlanningCandidate, messages: Array<{ role: string; content: string }>, variant: ProtocolRequest["variant"], tool?: TextPlanningTool, requestedStream = false): ProtocolRequest {
    const resolved = resolveTextProtocol({
        model: candidate.upstreamModel,
        apiFormat: candidate.channel.apiFormat,
        advancedConfig: candidate.channel.advancedConfig,
        throughSystemProxy: true,
    });
    const modelStreaming = resolveChannelModelConfig(candidate.channel.advancedConfig, candidate.upstreamModel)?.streaming;
    const streaming = modelStreaming || candidate.channel.advancedConfig?.streaming;
    const hasExplicitStreamPath = Boolean(streaming?.path?.trim());
    const streamEnabled = streaming?.enabled === true || (streaming?.enabled !== false && resolved.kind !== "custom" && resolved.kind !== "gemini");
    const stream = requestedStream && variant === "json" && streamEnabled && (resolved.kind === "chat" || resolved.kind === "responses" || hasExplicitStreamPath);
    const streamPath = resolved.kind === "gemini" ? interpolateModelPath(streaming?.path || resolved.path, candidate.upstreamModel) : streaming?.path || resolved.path;
    const streamFormat = streaming?.format || (resolved.kind === "gemini" ? "ndjson" : "sse");
    if (resolved.kind === "responses") return responsesRequest(candidate.upstreamModel, messages, stream ? streamPath : resolved.path, variant === "tool" ? tool : undefined, variant, stream);
    if (resolved.kind === "gemini") return geminiRequest(candidate.upstreamModel, messages, stream ? streamPath : resolved.path, variant === "tool" ? tool : undefined, variant, stream, streamFormat);
    if (resolved.kind === "custom") return customRequest(candidate.upstreamModel, stream ? streamPath : resolved.path, resolved.requestTemplate!, resolved.resultField!, messages, variant, stream, streamFormat);
    return chatRequest(candidate.upstreamModel, messages, stream ? streamPath : resolved.path, variant === "tool" ? tool : undefined, variant, stream, streamFormat);
}

function chatRequest(
    model: string,
    messages: Array<{ role: string; content: string }>,
    path = "/chat/completions",
    tool?: TextPlanningTool,
    variant: ProtocolRequest["variant"] = "json",
    stream = false,
    streamFormat: ProtocolRequest["streamFormat"] = "sse",
): ProtocolRequest {
    return {
        protocol: "chat",
        variant,
        path,
        body: {
            model,
            messages,
            ...(tool ? { tools: [{ type: "function", function: tool }], tool_choice: { type: "function", function: { name: tool.name } } } : variant === "json" || variant === "repair" ? { response_format: { type: "json_object" } } : {}),
            ...(stream ? { stream: true } : {}),
        },
        ...(stream ? { stream: true, streamFormat } : {}),
    };
}

function responsesRequest(model: string, messages: Array<{ role: string; content: string }>, path = "/responses", tool?: TextPlanningTool, variant: ProtocolRequest["variant"] = "json", stream = false): ProtocolRequest {
    return {
        protocol: "responses",
        variant,
        path,
        body: {
            model,
            input: messages,
            ...(tool ? { tools: [{ type: "function", ...tool }], tool_choice: { type: "function", name: tool.name } } : variant === "json" || variant === "repair" ? { text: { format: { type: "json_object" } } } : {}),
            ...(stream ? { stream: true } : {}),
        },
        ...(stream ? { stream: true, streamFormat: "sse" } : {}),
    };
}

function geminiRequest(
    model: string,
    messages: Array<{ role: string; content: string }>,
    configuredPath: string,
    tool?: TextPlanningTool,
    variant: ProtocolRequest["variant"] = "json",
    stream = false,
    streamFormat: ProtocolRequest["streamFormat"] = "ndjson",
): ProtocolRequest {
    const systemText = messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n\n");
    const path = configuredPath || `/models/${encodeURIComponent(model.replace(/^models\//, ""))}:generateContent`;
    return {
        protocol: "gemini",
        variant,
        path,
        body: {
            contents: messages.filter((message) => message.role !== "system").map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] })),
            ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
            ...(tool
                ? { tools: [{ functionDeclarations: [tool] }], toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [tool.name] } } }
                : variant === "json" || variant === "repair"
                  ? { generationConfig: { responseMimeType: "application/json" } }
                  : {}),
            ...(stream ? { stream: true } : {}),
        },
        ...(stream ? { stream: true, streamFormat } : {}),
    };
}

function customRequest(
    model: string,
    configuredPath: string,
    requestTemplate: string,
    resultField: string,
    messages: Array<{ role: string; content: string }>,
    variant: ProtocolRequest["variant"],
    stream = false,
    streamFormat: ProtocolRequest["streamFormat"] = "sse",
): ProtocolRequest {
    const prompt = messages.map((message) => `${message.role}: ${message.content}`).join("\n\n");
    const promptJson = messages.find((message) => message.role === "user")?.content || "";
    const values = { model, messages, prompt, input: prompt, text: prompt, prompt_json: parsePromptJsonValue(promptJson), stream };
    return { protocol: "custom", variant, path: configuredPath, body: buildProviderRequest(requestTemplate, values, values), resultField, ...(stream ? { stream: true, streamFormat } : {}) };
}

function parsePromptJsonValue(value: string) {
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

async function requestTextProtocol(input: StructuredTextRequest, request: ProtocolRequest) {
    const base = `${input.origin}/api/ai/system/${encodeURIComponent(input.candidate.channelId)}`;
    const headers = request.variant === "repair" ? repairRequestHeaders(input) : new Headers(request.variant !== "tool" && input.fallbackHeaders ? input.fallbackHeaders : input.headers);
    headers.set("content-type", "application/json");
    if (input.cookie) headers.set("cookie", input.cookie);
    scopeProtocolIdempotency(headers, request.protocol, request.variant, request.stream);
    const timeoutSignal = AbortSignal.timeout(resolveModelRequestTimeoutMs(input.candidate, "text"));
    const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
    try {
        return await fetchInternalApi(`${base}${normalizePath(request.path)}`, { method: "POST", headers, body: JSON.stringify(request.body), cache: "no-store", signal });
    } catch (error) {
        if (input.signal?.aborted) throw error;
        throw new TextPlanningRequestError(isTimeoutError(error) ? "文本模型规划响应超时，正在切换备用渠道" : "文本模型渠道暂时无法连接", 504, true, "transport");
    }
}

function repairRequestHeaders(input: StructuredTextRequest) {
    const headers = new Headers(input.fallbackHeaders || input.headers);
    const logicalModel = headers.get(SYSTEM_AI_LOGICAL_MODEL_HEADER)?.trim();
    const businessRequestId = headers.get(SYSTEM_AI_POINTS_IDEMPOTENCY_HEADER)?.trim();
    const upstreamModel = headers.get(SYSTEM_AI_UPSTREAM_MODEL_HEADER)?.trim() || input.candidate.upstreamModel;
    if (!logicalModel || !businessRequestId) return headers;
    Object.entries(systemAiBillingHeaders(logicalModel, `${businessRequestId}:repair`, upstreamModel)).forEach(([name, value]) => headers.set(name, value));
    return headers;
}

function streamFallbackHeaders(source: HeadersInit | undefined, candidateUpstreamModel: string) {
    if (!source) return undefined;
    const headers = new Headers(source);
    const logicalModel = headers.get(SYSTEM_AI_LOGICAL_MODEL_HEADER)?.trim();
    const businessRequestId = headers.get(SYSTEM_AI_POINTS_IDEMPOTENCY_HEADER)?.trim();
    const upstreamModel = headers.get(SYSTEM_AI_UPSTREAM_MODEL_HEADER)?.trim() || candidateUpstreamModel;
    if (logicalModel && businessRequestId) Object.entries(systemAiBillingHeaders(logicalModel, `${businessRequestId}:stream-fallback`, upstreamModel)).forEach(([name, value]) => headers.set(name, value));
    return headers;
}

function scopeProtocolIdempotency(headers: Headers, protocol: TextPlanningProtocol, variant: ProtocolRequest["variant"], stream = false) {
    for (const name of ["idempotency-key", "x-client-request-id"]) {
        const value = headers.get(name)?.trim();
        if (value) headers.set(name, `${value}:${protocol}-${variant}${stream ? "-stream" : ""}`);
    }
}

async function readStructuredResponse(input: StructuredTextRequest, request: ProtocolRequest, response: Response, startedAt: number): Promise<TextPlanningCall> {
    if (!response.ok) {
        const raw = await response.text();
        throw new TextPlanningRequestError(safeUpstreamError(raw, response.status), response.status, retryableStatus(response.status));
    }
    const streamed = request.stream ? createStreamAccumulator(request.protocol, input.tool.name, request.resultField, input.allowNaturalLanguage) : undefined;
    const body = request.stream ? await readResponseBody(response, streamed) : await response.text();
    const raw = typeof body === "string" ? body : body.raw;
    let payload: Record<string, unknown> | null = null;
    try {
        const parsed = JSON.parse(raw.replace(/^\uFEFF/u, "").trim());
        payload = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
        if (request.stream) {
            const streamedArguments = (typeof body === "string" ? undefined : body.arguments) || extractStreamedArguments(raw, request.protocol, input.tool.name, request.resultField, input.allowNaturalLanguage);
            if (streamedArguments) return finalizeStructuredArguments(input, request, response, startedAt, streamedArguments);
        }
        await input.onInvalidResponse?.(response.headers);
        console.error("[text-planning] structured response is not JSON", JSON.stringify({ protocol: request.protocol, status: response.status, responseBytes: Buffer.byteLength(raw, "utf8") }));
        throw new TextPlanningRequestError(`文本模型返回了无效 JSON（协议：${request.protocol}）`, 502, false, "invalid-structure", "invalid-response-json");
    }
    if (!payload) {
        await input.onInvalidResponse?.(response.headers);
        console.error("[text-planning] structured response has invalid top-level value", JSON.stringify({ protocol: request.protocol, status: response.status, responseBytes: Buffer.byteLength(raw, "utf8") }));
        throw new TextPlanningRequestError(`文本模型返回的顶层数据无效（协议：${request.protocol}）`, 502, false, "invalid-structure", "invalid-response-json");
    }
    if (request.protocol === "custom" && isProviderBusinessError(payload)) {
        await input.onInvalidResponse?.(response.headers);
        throw new TextPlanningRequestError(readProviderError(payload) || "自定义文本协议返回失败");
    }
    const argumentsText = readProtocolArguments(payload, input.tool.name, request, input.allowNaturalLanguage);
    return finalizeStructuredArguments(input, request, response, startedAt, argumentsText, payload);
}

async function finalizeStructuredArguments(input: StructuredTextRequest, request: ProtocolRequest, response: Response, startedAt: number, argumentsText: string, payload: Record<string, unknown> = {}) {
    if (!argumentsText) {
        await input.onInvalidResponse?.(response.headers);
        console.error("[text-planning] structured response has no readable result", JSON.stringify({ protocol: request.protocol, tool: input.tool.name, ...describeStructuredPayload(payload) }));
        throw new TextPlanningRequestError(`文本模型没有返回可识别的结构化结果（协议：${request.protocol}）`, 502, false, "invalid-structure", "missing-structured-result");
    }
    if (!validArguments(input, argumentsText)) {
        await input.onInvalidResponse?.(response.headers);
        console.error("[text-planning] structured response failed argument validation", JSON.stringify({ protocol: request.protocol, tool: input.tool.name, ...describeStructuredPayload(payload) }));
        throw new TextPlanningRequestError(`文本模型返回了 JSON，但字段不符合 ${input.tool.name} 要求`, 502, false, "invalid-structure", "invalid-structured-result");
    }
    const elapsedMs = Date.now() - startedAt;
    recordTextSuccess(input.candidate, request.protocol, elapsedMs);
    return { arguments: argumentsText, headers: response.headers, protocol: request.protocol, elapsedMs, transport: request.stream ? ("stream" as const) : ("complete" as const) };
}

async function readResponseBody(response: Response, accumulator?: StreamAccumulator): Promise<string | { raw: string; arguments: string }> {
    if (!response.body) return response.text();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let output = "";
    const consume = (value: string, flush = false) => {
        pending += value;
        const lines = pending.split(/\r?\n/);
        pending = flush ? "" : lines.pop() || "";
        for (const line of lines) {
            output += `${line}\n`;
            accumulator?.append(line);
        }
        if (flush && pending) {
            output += pending;
            accumulator?.append(pending);
            pending = "";
        }
    };
    while (true) {
        const next = await reader.read();
        if (next.done) {
            consume(decoder.decode(), true);
            return accumulator ? { raw: output, arguments: accumulator.result() } : output;
        }
        consume(decoder.decode(next.value, { stream: true }));
    }
}

function extractStreamedArguments(raw: string, protocol: TextPlanningProtocol, toolName: string, resultField?: string, allowNaturalLanguage = false) {
    const accumulator = createStreamAccumulator(protocol, toolName, resultField, allowNaturalLanguage);
    raw.split(/\r?\n/).forEach((line) => accumulator.append(line));
    return accumulator.result();
}

type StreamAccumulator = { append: (line: string) => void; result: () => string };

function createStreamAccumulator(protocol: TextPlanningProtocol, toolName: string, resultField?: string, allowNaturalLanguage = false): StreamAccumulator {
    let content = "";
    let argumentsText = "";
    return {
        append(line) {
            const value = line.trim().startsWith("data:") ? line.trim().slice(5).trim() : line.trim();
            if (!value || value === "[DONE]") return;
            let payload: Record<string, unknown>;
            try {
                const parsed = JSON.parse(value) as unknown;
                if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
                payload = parsed as Record<string, unknown>;
            } catch {
                return;
            }
            if (protocol === "chat") {
                const delta = record(firstRecord(payload.choices)?.delta) || record(firstRecord(payload.choices)?.message);
                const call = records(delta?.tool_calls).find((item) => !toolName || record(item.function)?.name === toolName || !record(item.function)?.name);
                argumentsText += typeof record(call?.function)?.arguments === "string" ? String(record(call?.function)?.arguments) : "";
                content += textContent(delta?.content);
            } else if (protocol === "responses") {
                const eventType = typeof payload.type === "string" ? payload.type : "";
                if (eventType.endsWith(".delta") && typeof payload.delta === "string") {
                    if (eventType.includes("function_call") && eventType.includes("arguments")) argumentsText += payload.delta;
                    else content += payload.delta;
                }
                const output = records(payload.output);
                const call = output.find((item) => item.type === "function_call" && (!item.name || item.name === toolName));
                argumentsText += typeof call?.arguments === "string" ? call.arguments : "";
                content += textContent(payload.output_text);
            } else if (protocol === "gemini") {
                const parts = records(record(firstRecord(payload.candidates)?.content)?.parts);
                const call = parts.map((part) => record(part.functionCall)).find((item) => item?.name === toolName);
                if (call?.args) argumentsText += JSON.stringify(call.args);
                content += parts.map((part) => (typeof part.text === "string" ? part.text : "")).join("");
            } else {
                const configured = readProviderValue(payload, resultField);
                argumentsText += jsonObjectArguments(configured) || "";
                content += readProviderString(payload, resultField, TEXT_RESULT_KEYS);
            }
        },
        result() {
            return extractJsonObjectText(argumentsText) || extractJsonObjectText(content) || (allowNaturalLanguage ? content.trim() : "");
        },
    };
}

function readProtocolArguments(payload: Record<string, unknown>, toolName: string, request: ProtocolRequest, allowNaturalLanguage = false) {
    if (request.protocol === "responses") return responsesArguments(payload, toolName, allowNaturalLanguage);
    if (request.protocol === "gemini") return geminiArguments(payload, toolName, allowNaturalLanguage);
    if (request.protocol === "custom") {
        const configured = readProviderValue(payload, request.resultField);
        const content = jsonObjectArguments(configured) || readProviderString(payload, request.resultField, TEXT_RESULT_KEYS);
        return extractJsonObjectText(content) || (allowNaturalLanguage ? content : "");
    }
    return chatArguments(payload, toolName, allowNaturalLanguage);
}

function planningMessages(input: StructuredTextRequest, recovery = false) {
    const instruction = `${recovery ? "上一轮响应没有通过结构校验。请重新执行，不要解释失败原因，也不要复述输入。" : "请先在模型内部完成需求理解、约束分析、模型选择、任务拆分与依赖规划，再"}只返回一个严格 JSON 对象，作为 ${input.tool.name} 的最终参数。任务用途：${input.tool.description}。不要使用 Markdown、代码围栏、解释或额外文字。JSON 必须符合以下 Schema：${JSON.stringify(input.tool.parameters)}`;
    if (input.messages[0]?.role === "system") return [{ ...input.messages[0], content: `${instruction}\n\n${input.messages[0].content}` }, ...input.messages.slice(1)];
    return [{ role: "system", content: instruction }, ...input.messages];
}

function chatArguments(payload: Record<string, unknown>, toolName: string, allowNaturalLanguage: boolean) {
    const message = firstRecord(payload.choices)?.message as Record<string, unknown> | undefined;
    const toolCalls = records(message?.tool_calls);
    const call = toolCalls.find((item) => record(item.function)?.name === toolName) || (toolCalls.length === 1 ? toolCalls[0] : undefined);
    const argumentsText = jsonObjectArguments(record(call?.function)?.arguments);
    if (argumentsText) return argumentsText;
    const content = textContent(message?.content);
    if (content) return extractJsonObjectText(content) || (allowNaturalLanguage ? content : "");
    // Some compatible gateways wrap a Chat result as a Responses payload.
    return responsesArguments(payload, toolName, allowNaturalLanguage) || directStructuredObject(payload);
}

function responsesArguments(payload: Record<string, unknown>, toolName: string, allowNaturalLanguage: boolean) {
    const output = records(payload.output);
    const call = output.find((item) => item.type === "function_call" && item.name === toolName);
    const argumentsText = jsonObjectArguments(call?.arguments);
    if (argumentsText) return argumentsText;
    const direct = typeof payload.output_text === "string" ? payload.output_text.trim() : "";
    const content =
        direct ||
        output
            .flatMap((item) => [typeof item.text === "string" ? item.text : "", ...records(item.content).map((content) => (typeof content.text === "string" ? content.text : ""))])
            .join("")
            .trim();
    return extractJsonObjectText(content) || (allowNaturalLanguage ? content : "") || directStructuredObject(payload);
}

function geminiArguments(payload: Record<string, unknown>, toolName: string, allowNaturalLanguage: boolean) {
    const parts = records(record(firstRecord(payload.candidates)?.content)?.parts);
    const call = parts.map((part) => record(part.functionCall)).find((item) => item?.name === toolName);
    const callArguments = jsonObjectArguments(call?.args);
    if (callArguments) return callArguments;
    const content = parts
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .join("")
        .trim();
    return extractJsonObjectText(content) || (allowNaturalLanguage ? content : "") || directStructuredObject(payload);
}

function directStructuredObject(payload: Record<string, unknown>) {
    const hasProtocolEnvelope = Array.isArray(payload.choices) || Array.isArray(payload.output) || Array.isArray(payload.candidates);
    const values = hasProtocolEnvelope ? [payload.data, payload.result, payload.response] : [payload, payload.data, payload.result, payload.response];
    for (const value of values) {
        const argumentsText = jsonObjectArguments(value);
        if (argumentsText) return argumentsText;
    }
    return "";
}

function describeStructuredPayload(payload: Record<string, unknown>) {
    const choices = records(payload.choices);
    const message = record(choices[0]?.message);
    const output = records(payload.output);
    return {
        topLevelKeys: Object.keys(payload).slice(0, 16),
        choices: choices.length,
        messageKeys: message ? Object.keys(message).slice(0, 12) : [],
        toolCalls: records(message?.tool_calls).length,
        output: output.length,
        candidates: records(payload.candidates).length,
        resultTypes: ["data", "result", "response", "output_text"].map((key) => `${key}:${valueType(payload[key])}`),
    };
}

function valueType(value: unknown) {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    return typeof value;
}

function candidateScore(state: RuntimeState | undefined, now: number) {
    if (!state) return 10_000;
    if ((state.cooldownUntil || 0) > now) return 1_000_000 + (state.cooldownUntil || 0) - now;
    const total = state.successCount + state.failureCount;
    return (total ? state.failureCount / total : 0) * 100_000 + (state.averageLatencyMs || 10_000);
}

function recordTextSuccess(candidate: TextPlanningCandidate, protocol: TextPlanningProtocol, elapsedMs: number) {
    const key = runtimeKey(candidate);
    const current = states.get(key) || emptyState();
    states.set(key, {
        ...current,
        preferred: protocol,
        consecutiveFailures: 0,
        cooldownUntil: undefined,
        successCount: current.successCount + 1,
        averageLatencyMs: current.averageLatencyMs === undefined ? elapsedMs : Math.round(current.averageLatencyMs * 0.7 + elapsedMs * 0.3),
        lastSuccessAt: Date.now(),
    });
    recordChannelRuntimeSuccess(candidate.channelId, "text");
}

function recordTextFailure(candidate: TextPlanningCandidate, error: unknown) {
    const key = runtimeKey(candidate);
    const current = states.get(key) || emptyState();
    const consecutiveFailures = current.consecutiveFailures + 1;
    states.set(key, { ...current, consecutiveFailures, failureCount: current.failureCount + 1, cooldownUntil: Date.now() + FAILURE_COOLDOWN_MS * Math.min(4, consecutiveFailures), lastFailureAt: Date.now() });
    recordChannelRuntimeFailure(candidate.channelId, "text", error instanceof Error ? error.message : String(error || "文本规划失败"));
}

function emptyState(): RuntimeState {
    return { consecutiveFailures: 0, successCount: 0, failureCount: 0 };
}

function runtimeKey(candidate: TextPlanningCandidate) {
    return `${candidate.channelId}:${candidate.upstreamModel.toLowerCase()}`;
}

function safeUpstreamError(value: string, status: number) {
    const fallback =
        status === 401 || status === 403
            ? "文本模型渠道鉴权失败，请管理员检查密钥"
            : status === 413
              ? "提交给文本模型的内容过大，请减少单次分析内容后重试"
              : status === 429
                ? "文本模型渠道请求过于频繁，请稍后重试"
                : status >= 500
                  ? `文本模型渠道暂不可用（HTTP ${status}）`
                  : "文本模型调用失败";
    if (status === 413) return fallback;
    if (!value.trim() || /<!doctype\s+html|<html\b|<title>|<body\b|\bnginx\b|\bcloudflare\b/i.test(value)) return fallback;
    try {
        const payload = JSON.parse(value) as { msg?: unknown; error?: unknown };
        const error = payload.error && typeof payload.error === "object" ? (payload.error as { message?: unknown }) : undefined;
        return (
            [payload.msg, typeof payload.error === "string" ? payload.error : undefined, error?.message]
                .find((item): item is string => typeof item === "string" && Boolean(item.trim()))
                ?.trim()
                .slice(0, 300) || fallback
        );
    } catch {
        return value.trim().slice(0, 300) || fallback;
    }
}

function normalizePath(value: string) {
    return `/${value.trim().replace(/^\/+/, "")}`;
}

function records(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function firstRecord(value: unknown) {
    return records(value)[0];
}

function jsonObjectArguments(value: unknown) {
    if (typeof value === "string") return extractJsonObjectText(value);
    const object = record(value);
    if (!object) return "";
    try {
        return extractJsonObjectText(JSON.stringify(object));
    } catch {
        return "";
    }
}

function textContent(value: unknown) {
    if (typeof value === "string") return value.trim();
    return records(value)
        .map((item) => (typeof item.text === "string" ? item.text : ""))
        .join("")
        .trim();
}

function validArguments(input: StructuredTextRequest, argumentsText: string) {
    if (!input.validateArguments) return true;
    try {
        return input.validateArguments(argumentsText);
    } catch {
        return false;
    }
}

function retryableStatus(status: number) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
}

function shouldFallbackFromNativeTool(error: unknown, request: ProtocolRequest) {
    return request.variant === "tool" && error instanceof TextPlanningRequestError && (error.reason === "invalid-structure" || error.status === 400 || error.status === 422);
}

function shouldRepairStructuredResponse(error: unknown, request: ProtocolRequest) {
    return request.variant === "json" && error instanceof TextPlanningRequestError && error.reason === "invalid-structure";
}

function shouldFallbackFromStream(error: unknown) {
    return error instanceof TextPlanningRequestError && [400, 404, 405, 415, 422, 501].includes(error.status);
}

function isTimeoutError(error: unknown) {
    return error instanceof Error && (error.name === "TimeoutError" || /timeout|timed out/i.test(error.message));
}
