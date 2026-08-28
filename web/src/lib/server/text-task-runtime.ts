import { refundUserPoints } from "@/lib/auth/store";
import { configureServerProxyDispatcher } from "@/lib/server/proxy-dispatcher";
import { fetchSafeOutbound } from "@/lib/server/safe-outbound-fetch";
import { scheduleGenerationTask } from "@/lib/server/generation-task-scheduler";
import { fetchInternalApi, isInternalApiBaseUrl } from "@/lib/server/internal-origin";
import { toSafeGenerationErrorMessage } from "@/lib/server/generation-errors";
import { generationModelId } from "@/lib/server/generation-channel";
import { finishGenerationAttempt, startGenerationAttempt } from "@/lib/server/generation-attempt";
import { getTextTask, transitionTextTask, type TextTask, type TextTaskConfig } from "@/lib/server/text-task-store";
import { updateTextTask } from "@/lib/server/text-task-store";
import type { AiTextMessage } from "@/types/ai";
import { hasSystemAiCharge, readSystemAiBilling, systemAiBillingHeaders } from "@/lib/server/system-ai-billing";
import { resolveModelRequestTimeoutMs } from "@/lib/server/model-request-policy";
import { buildProviderRequest, isProviderBusinessError, providerQueryPaths, readProviderError, readProviderString } from "@/lib/server/provider-task-config";
import { maintenanceWorkerContext, maintenanceWorkerContextHeaders } from "@/lib/server/maintenance-auth";
import { GenerationSubmissionSafeFailure, GenerationSubmissionUncertainError, generationSubmissionResponseError, generationSubmissionUncertainError } from "@/lib/server/generation-submission-error";
import { resolveTextProtocol, type ResolvedTextProtocol } from "@/lib/server/text-protocol-resolver";
import { refundTextTask, textTaskRefundIdempotencyKey } from "@/lib/server/text-task-refund";

configureServerProxyDispatcher();

const TEXT_RESULT_KEYS = ["output_text", "text", "content", "response", "result"];
const TASK_ID_KEYS = ["task_id", "taskId", "id", "job_id", "jobId", "request_id", "requestId"];
const TASK_STATUS_KEYS = ["status", "state", "task_status", "taskStatus"];
const FAILED_TASK_STATUSES = new Set(["failed", "failure", "error", "cancelled", "canceled", "expired"]);
const PENDING_TASK_STATUSES = new Set(["", "pending", "queued", "running", "processing", "in_progress", "created", "submitted"]);

export type TextTaskStep = { state: "pending"; status: string; upstreamTaskId: string; createPath: string } | { state: "completed" } | { state: "failed"; error: string } | { state: "needs_review"; error: string };

type ResponseInputContent = { type: "input_text"; text: string } | { type: "input_image"; image_url: string };
type ResponseInputItem = { role: "system" | "user" | "assistant"; content: string | ResponseInputContent[] };
type ResponseApiPayload = {
    output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
    output_text?: string;
    error?: { message?: string };
    code?: number;
    msg?: string;
};
type ChatCompletionPayload = {
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
    error?: { message?: string };
    code?: number;
    msg?: string;
};
type GeminiPart = {
    text?: string;
    inlineData?: { mimeType?: string; data?: string };
    fileData?: { mimeType?: string; fileUri?: string };
};
type GeminiPayload = {
    candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
    error?: { message?: string };
    promptFeedback?: { blockReason?: string };
};
type ClaudePayload = {
    content?: Array<{ type?: string; text?: string }>;
    error?: { message?: string };
};

export async function runTextTaskStep(task: TextTask, origin: string, cookie: string): Promise<TextTaskStep> {
    const current = await getTextTask(task.id);
    if (!current || current.status === "success") return { state: "completed" };
    if (current.status === "error" || current.status === "cancelled") return { state: "failed", error: current.error || "文本任务已结束" };
    const running = current.status === "pending" ? await transitionTextTask(current, ["pending"], { status: "running" }) : current;
    if (!running) return { state: "failed", error: "文本任务状态已变化" };
    if (running.dramaAnalysis) return runDramaAnalysisTextTask(running, origin);
    if (running.upstream?.id) return queryCustomTextTaskStep(running, origin, cookie);

    const candidates = [running.config, ...(running.candidateConfigs || [])];
    let attempts = running.attempts || [];
    let latestError: unknown;
    for (const [index, config] of candidates.entries()) {
        const started = startGenerationAttempt(attempts, { channelId: config.channelId, model: generationModelId(config), capability: "text" });
        attempts = started.attempts;
        const candidateTask = { ...running, config, candidateConfigs: candidates.slice(index + 1), attemptNo: started.attempt.attemptNo, attempts };
        await updateTextTask(task.id, { config, candidateConfigs: candidateTask.candidateConfigs, attemptNo: candidateTask.attemptNo, attempts });
        await scheduleGenerationTask("text", task.id, {
            executionPhase: "submitting",
            channelId: config.channelId,
            provider: config.advancedConfig?.protocol || config.apiFormat,
            queryPath: config.advancedConfig?.queryPath,
            nextPollAt: Date.now(),
            lastUpstreamStatus: "submitting",
        });
        try {
            const protocol = resolveTextProtocol({ model: config.model, apiFormat: config.apiFormat, advancedConfig: config.advancedConfig, throughSystemProxy: config.baseUrl.startsWith("/") });
            const result = await runResolvedTextTask(candidateTask, origin, cookie, protocol);
            if ("state" in result) {
                const billing = hasSystemAiCharge(result) ? { pointsCost: result.pointsCost, pointsRecordId: result.pointsRecordId, refunded: false } : undefined;
                await updateTextTask(task.id, { upstream: { id: result.upstreamTaskId, createPath: result.createPath }, billing });
                return { state: "pending", status: result.status, upstreamTaskId: result.upstreamTaskId, createPath: result.createPath };
            }
            return completeTextTask(candidateTask, result.content, result, attempts);
        } catch (error) {
            latestError = error;
            const message = toSafeGenerationErrorMessage(error, "文本生成失败");
            const latest = await getTextTask(task.id);
            if (latest?.status === "cancelled" || latest?.status === "success") return latest.status === "success" ? { state: "completed" } : { state: "failed", error: latest.error || "任务已取消" };
            if (error instanceof GenerationSubmissionUncertainError) return { state: "needs_review", error: message };
            if (!(error instanceof GenerationSubmissionSafeFailure)) return { state: "needs_review", error: generationSubmissionUncertainError(error, message).message };
            attempts = finishGenerationAttempt(attempts, candidateTask.attemptNo, { status: "failed", error: message });
            await updateTextTask(task.id, { attempts, attemptNo: candidateTask.attemptNo });
        }
    }
    return failTextTask((await getTextTask(task.id)) || running, latestError instanceof Error ? latestError.message : "没有可用的文本渠道", attempts);
}

async function runDramaAnalysisTextTask(task: TextTask, origin: string): Promise<TextTaskStep> {
    const analysis = task.dramaAnalysis;
    const label = analysis?.body.phase === "visual" ? "视觉方案" : "内容整理";
    if (!analysis) return failTextTask(task, "短剧分析任务参数不完整", task.attempts || []);
    await scheduleGenerationTask("text", task.id, {
        executionPhase: "submitting",
        channelId: task.config.channelId,
        provider: task.config.advancedConfig?.protocol || task.config.apiFormat,
        nextPollAt: Date.now(),
        lastUpstreamStatus: "submitting",
    });
    try {
        const workerHeaders = maintenanceWorkerContextHeaders(maintenanceWorkerContext(task.userId));
        if (!workerHeaders) throw new Error("生成任务 Worker 鉴权不可用");
        const response = await fetchInternalApi(`${origin}/api/drama/analyze`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-vozeb-pro-generation-task-id": task.id, ...workerHeaders },
            body: JSON.stringify(analysis.body),
            cache: "no-store",
        });
        const payload = (await response.json().catch(() => null)) as { data?: unknown; msg?: string } | null;
        if (!response.ok || !payload?.data) return failTextTask(task, payload?.msg || `AI ${label}失败`, task.attempts || []);
        await scheduleGenerationTask("text", task.id, { executionPhase: "persisting", lastUpstreamStatus: "persisting" });
        const remaining = Number(response.headers.get("x-vozeb-pro-points-remaining"));
        return completeTextTask(task, JSON.stringify(payload.data), { pointsRemaining: Number.isFinite(remaining) ? remaining : undefined }, task.attempts || []);
    } catch (error) {
        return failTextTask(task, error instanceof Error ? error.message : `AI ${label}失败`, task.attempts || []);
    }
}

function runResolvedTextTask(task: TextTask, origin: string, cookie: string, protocol: ResolvedTextProtocol) {
    if (protocol.kind === "custom") return createCustomTextTaskStep(task, origin, cookie, protocol);
    if (protocol.kind === "responses") return runOpenAiResponsesTask(task, origin, cookie, protocol);
    if (protocol.kind === "gemini") return runGeminiTextTask(task, origin, cookie, protocol);
    if (protocol.kind === "claude") return runClaudeTextTask(task, origin, cookie, protocol);
    return runOpenAiChatCompletionTask(task, origin, cookie, protocol);
}

async function runOpenAiResponsesTask(task: TextTask, origin: string, cookie: string, protocol: ResolvedTextProtocol) {
    const config = task.config;
    const headers = taskHeaders(config, cookie, pointsIdempotencyKey(task, protocol));
    headers.set("content-type", "application/json");
    const response = await submissionFetch(config, taskUrl(config, protocol.path, origin), {
        method: "POST",
        headers,
        body: JSON.stringify({ model: config.model, input: toResponseInput(withSystemMessage(config, task.messages)) }),
        cache: "no-store",
    });
    if (!response.ok) {
        const errorMessage = await readFetchError(response, "文本生成失败");
        throw new GenerationSubmissionSafeFailure(errorMessage, response.status);
    }
    const payload = await parseTextSubmissionJson<ResponseApiPayload>(task, response);
    try {
        validateResponsePayload(payload);
    } catch (error) {
        const message = error instanceof Error ? error.message : "文本生成失败";
        await refundChargedTextResponse(task, response.headers);
        throw new GenerationSubmissionSafeFailure(message);
    }
    const content = parseOpenAiContent(payload);
    if (!content.trim()) {
        await refundChargedTextResponse(task, response.headers);
        throw new GenerationSubmissionSafeFailure("文本模型没有返回有效内容");
    }
    return { content, ...readBilling(response.headers) };
}

async function createCustomTextTaskStep(task: TextTask, origin: string, cookie: string, protocol: ResolvedTextProtocol) {
    const config = task.config;
    const createPath = protocol.path;
    const messages = toChatMessages(withSystemMessage(config, task.messages));
    const prompt = messages
        .filter((message) => message.role === "user")
        .map((message) => readMessageText(message.content))
        .filter(Boolean)
        .join("\n\n");
    const values = { model: config.model, prompt, input: prompt, text: prompt, messages };
    let payload: Record<string, unknown>;
    try {
        payload = buildProviderRequest(protocol.requestTemplate!, values, values);
    } catch (error) {
        throw new GenerationSubmissionSafeFailure(error instanceof Error ? error.message : "自定义文本请求模板无效");
    }
    const headers = taskHeaders(config, cookie, pointsIdempotencyKey(task, protocol));
    headers.set("content-type", "application/json");
    const response = await submissionFetch(config, taskUrl(config, createPath, origin), { method: "POST", headers, body: JSON.stringify(payload), cache: "no-store" });
    if (!response.ok) {
        const message = await readFetchError(response, "自定义文本接口调用失败");
        const responseError = generationSubmissionResponseError(response.status, message);
        if (responseError instanceof GenerationSubmissionUncertainError) await persistTextResponseBilling(task, response.headers);
        throw responseError;
    }
    const data = await parseTextSubmissionJson<unknown>(task, response);
    if (isProviderBusinessError(data)) {
        await refundChargedTextResponse(task, response.headers);
        throw new GenerationSubmissionSafeFailure(readProviderError(data) || "自定义文本接口返回失败");
    }
    const content = readProviderString(data, protocol.resultField, TEXT_RESULT_KEYS);
    if (content) return { content, ...readBilling(response.headers) };
    const taskId = readProviderString(data, undefined, TASK_ID_KEYS);
    if (taskId && config.advancedConfig?.queryPath) return { state: "pending" as const, status: "submitted", upstreamTaskId: taskId, createPath, ...readBilling(response.headers) };
    throw new GenerationSubmissionUncertainError("自定义文本接口没有按配置返回内容或任务 ID");
}

async function queryCustomTextTaskStep(task: TextTask, origin: string, cookie: string): Promise<TextTaskStep> {
    const config = task.config;
    const upstream = task.upstream;
    if (!upstream?.id) return { state: "needs_review", error: "文本任务缺少上游任务 ID" };
    let lastError = "";
    for (const path of providerQueryPaths(config.advancedConfig, upstream.id, [])) {
        const response = await taskFetch(config, taskUrl(config, path, origin), { headers: taskHeaders(config, cookie), cache: "no-store" });
        if (!response.ok) {
            lastError = await readFetchError(response, "自定义文本任务查询失败");
            continue;
        }
        const data = (await response.json().catch(() => null)) as unknown;
        if (!data || isProviderBusinessError(data)) return failTextTask(task, readProviderError(data) || "自定义文本任务查询失败", task.attempts || []);
        const content = readProviderString(data, config.advancedConfig?.resultField, TEXT_RESULT_KEYS);
        if (content) return completeTextTask(task, content, task.billing || {}, task.attempts || []);
        const status = readProviderString(data, config.advancedConfig?.statusField, TASK_STATUS_KEYS).toLowerCase();
        if (FAILED_TASK_STATUSES.has(status)) return failTextTask(task, readProviderError(data) || "自定义文本任务执行失败", task.attempts || []);
        if (PENDING_TASK_STATUSES.has(status)) return { state: "pending", status: status || "processing", upstreamTaskId: upstream.id, createPath: upstream.createPath };
        return failTextTask(task, "自定义文本任务已结束但没有返回内容", task.attempts || []);
    }
    throw new Error(lastError || "自定义文本任务查询失败");
}

export async function queryCancelledTextTaskUpstreamStep(task: TextTask, origin: string, cookie: string) {
    const config = task.config;
    const upstream = task.upstream;
    if (!upstream?.id) return { state: "terminal" as const, status: "missing_upstream_id" };
    let lastError = "";
    for (const path of providerQueryPaths(config.advancedConfig, upstream.id, [])) {
        const response = await taskFetch(config, taskUrl(config, path, origin), { headers: taskHeaders(config, cookie), cache: "no-store" });
        if (!response.ok) {
            lastError = await readFetchError(response, "自定义文本任务查询失败");
            continue;
        }
        const data = (await response.json().catch(() => null)) as unknown;
        if (!data || isProviderBusinessError(data)) return { state: "terminal" as const, status: "failed" };
        if (readProviderString(data, config.advancedConfig?.resultField, TEXT_RESULT_KEYS)) return { state: "terminal" as const, status: "completed" };
        const status = readProviderString(data, config.advancedConfig?.statusField, TASK_STATUS_KEYS).toLowerCase();
        if (FAILED_TASK_STATUSES.has(status)) return { state: "terminal" as const, status };
        if (PENDING_TASK_STATUSES.has(status)) return { state: "pending" as const, status: status || "processing" };
        return { state: "terminal" as const, status: status || "completed" };
    }
    throw new Error(lastError || "自定义文本任务查询失败");
}

function readMessageText(content: AiTextMessage["content"]) {
    if (typeof content === "string") return content;
    return content.map((item) => (item.type === "text" ? item.text : item.image_url.url)).join("\n");
}

async function runOpenAiChatCompletionTask(task: TextTask, origin: string, cookie: string, protocol: ResolvedTextProtocol) {
    const config = task.config;
    const headers = taskHeaders(config, cookie, pointsIdempotencyKey(task, protocol));
    headers.set("content-type", "application/json");
    const response = await submissionFetch(config, taskUrl(config, protocol.path, origin), {
        method: "POST",
        headers,
        body: JSON.stringify({ model: config.model, messages: toChatMessages(withSystemMessage(config, task.messages)) }),
        cache: "no-store",
    });
    if (!response.ok) {
        const message = await readFetchError(response, "文本生成失败");
        throw new GenerationSubmissionSafeFailure(message, response.status);
    }
    const payload = await parseTextSubmissionJson<ChatCompletionPayload>(task, response);
    try {
        validateChatCompletionPayload(payload);
    } catch (error) {
        await refundChargedTextResponse(task, response.headers);
        throw new GenerationSubmissionSafeFailure(error instanceof Error ? error.message : "文本生成失败");
    }
    const content = parseChatCompletionContent(payload);
    if (!content.trim()) {
        await refundChargedTextResponse(task, response.headers);
        throw new GenerationSubmissionSafeFailure("文本模型没有返回有效内容");
    }
    return { content, ...readBilling(response.headers) };
}

async function runGeminiTextTask(task: TextTask, origin: string, cookie: string, protocol: ResolvedTextProtocol) {
    const config = task.config;
    const response = await submissionFetch(config, taskUrl(config, protocol.path, origin, "gemini"), {
        method: "POST",
        headers: geminiHeaders(config, cookie, pointsIdempotencyKey(task, protocol)),
        body: JSON.stringify(toGeminiBody(config, task.messages)),
        cache: "no-store",
    });
    if (!response.ok) {
        const message = await readFetchError(response, "文本生成失败");
        throw new GenerationSubmissionSafeFailure(message, response.status);
    }
    const payload = await parseTextSubmissionJson<GeminiPayload>(task, response);
    try {
        validateGeminiPayload(payload);
    } catch (error) {
        await refundChargedTextResponse(task, response.headers);
        throw new GenerationSubmissionSafeFailure(error instanceof Error ? error.message : "Gemini 文本生成失败");
    }
    const content = parseGeminiContent(payload);
    if (!content.trim()) {
        await refundChargedTextResponse(task, response.headers);
        throw new GenerationSubmissionSafeFailure("Gemini 没有返回有效文本内容");
    }
    return { content, ...readBilling(response.headers) };
}

async function runClaudeTextTask(task: TextTask, origin: string, cookie: string, protocol: ResolvedTextProtocol) {
    const config = task.config;
    const messages = toChatMessages(withSystemMessage(config, task.messages));
    const system = messages
        .filter((message) => message.role === "system")
        .map((message) => readMessageText(message.content))
        .join("\n\n");
    const headers = taskHeaders(config, cookie, pointsIdempotencyKey(task, protocol));
    headers.set("content-type", "application/json");
    const response = await submissionFetch(config, taskUrl(config, protocol.path, origin), {
        method: "POST",
        headers,
        body: JSON.stringify({
            model: config.model,
            max_tokens: 4096,
            ...(system ? { system } : {}),
            messages: messages.filter((message) => message.role !== "system"),
        }),
        cache: "no-store",
    });
    if (!response.ok) {
        const message = await readFetchError(response, "文本生成失败");
        throw new GenerationSubmissionSafeFailure(message, response.status);
    }
    const payload = await parseTextSubmissionJson<ClaudePayload>(task, response);
    const content = payload.content
        ?.map((item) => (item.type === "text" && typeof item.text === "string" ? item.text : ""))
        .join("")
        .trim();
    if (!content) {
        await refundChargedTextResponse(task, response.headers);
        throw new GenerationSubmissionSafeFailure(payload.error?.message || "Claude 没有返回有效文本内容");
    }
    return { content, ...readBilling(response.headers) };
}

async function completeTextTask(task: TextTask, content: string, billing: { pointsRemaining?: number; pointsCost?: number; pointsRecordId?: string }, attempts: NonNullable<TextTask["attempts"]>): Promise<TextTaskStep> {
    const succeeded = finishGenerationAttempt(attempts, task.attemptNo || attempts.at(-1)?.attemptNo || 1, {
        status: "succeeded",
        pointsCost: billing.pointsCost,
        pointsRecordId: billing.pointsRecordId,
    });
    const current = await getTextTask(task.id);
    if (!current || current.status === "cancelled") {
        if (current?.status === "cancelled" && current.billing?.pointsRecordId) await refundTextTask(current);
        else if (hasSystemAiCharge(billing)) await refundUserPoints(task.userId, generationModelId(task.config), billing.pointsCost, "text", 1, textTaskRefundIdempotencyKey(task), billing.pointsRecordId);
        return { state: "failed", error: current?.error || "文本任务已取消" };
    }
    const completed = await transitionTextTask(current, ["running"], {
        status: "success",
        result: { content: content || "没有返回内容" },
        pointsRemaining: billing.pointsRemaining,
        messages: [],
        config: clearSecret(current.config),
        billing: hasSystemAiCharge(billing) ? { pointsCost: billing.pointsCost, pointsRecordId: billing.pointsRecordId, refunded: false } : current.billing,
    });
    await updateTextTask(task.id, { config: clearSecret(current.config), candidateConfigs: [], attempts: succeeded, attemptNo: task.attemptNo || succeeded.at(-1)?.attemptNo });
    if (!completed && hasSystemAiCharge(billing)) await refundUserPoints(task.userId, generationModelId(task.config), billing.pointsCost, "text", 1, textTaskRefundIdempotencyKey(task), billing.pointsRecordId);
    return completed ? { state: "completed" } : { state: "failed", error: "文本任务状态已变化" };
}

async function failTextTask(task: TextTask, error: string, attempts: NonNullable<TextTask["attempts"]>): Promise<TextTaskStep> {
    const current = (await getTextTask(task.id)) || task;
    if (current.status === "success") return { state: "completed" };
    if (current.status === "cancelled") return { state: "failed", error: current.error || "文本任务已取消" };
    const message = toSafeGenerationErrorMessage(error, "文本生成失败");
    const failedAttempts = finishGenerationAttempt(attempts, current.attemptNo || attempts.at(-1)?.attemptNo || 1, {
        status: "failed",
        error: message,
        pointsCost: current.billing?.pointsCost,
        pointsRecordId: current.billing?.pointsRecordId,
    });
    const failed = await transitionTextTask(current, ["pending", "running"], { status: "error", error: message, messages: [], config: clearSecret(current.config), billing: current.billing });
    if (!failed) {
        const latest = await getTextTask(current.id);
        if (latest?.status === "success") return { state: "completed" };
        if (latest?.status === "error" || latest?.status === "cancelled") {
            await refundTextTask(latest);
            return { state: "failed", error: latest.error || message };
        }
        return { state: "failed", error: "文本任务状态已变化" };
    }
    await updateTextTask(current.id, { config: clearSecret(current.config), candidateConfigs: [], attempts: failedAttempts, attemptNo: failedAttempts.at(-1)?.attemptNo });
    await refundTextTask(failed);
    return { state: "failed", error: message };
}

export function markTextTaskFailed(task: TextTask, error: string) {
    return failTextTask(task, error, task.attempts || []);
}

function clearSecret(config: TextTaskConfig): TextTaskConfig {
    return { ...config, apiKey: "" };
}

function withSystemMessage(config: TextTaskConfig, messages: AiTextMessage[]) {
    const systemPrompt = (config.systemPrompt || "").trim();
    return systemPrompt ? [{ role: "system" as const, content: systemPrompt }, ...messages] : messages;
}

function toResponseInput(messages: AiTextMessage[]): ResponseInputItem[] {
    return messages.map((message) => ({ role: message.role, content: toResponseContent(message.content) }));
}

function toResponseContent(content: AiTextMessage["content"]): string | ResponseInputContent[] {
    if (!Array.isArray(content)) return String(content || "");
    return content.map((item) => (item.type === "text" ? { type: "input_text" as const, text: item.text } : { type: "input_image" as const, image_url: item.image_url.url }));
}

function toChatMessages(messages: AiTextMessage[]) {
    return messages.map((message) => ({ role: message.role, content: message.content }));
}

function toGeminiBody(config: TextTaskConfig, messages: AiTextMessage[]) {
    const systemText = [(config.systemPrompt || "").trim(), ...messages.flatMap((message) => (message.role === "system" ? [geminiTextContent(message.content)] : []))].filter(Boolean).join("\n\n");
    return {
        contents: messages.filter((message) => message.role !== "system").map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: toGeminiParts(message.content) })),
        ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
    };
}

function toGeminiParts(content: AiTextMessage["content"]): GeminiPart[] {
    if (!Array.isArray(content)) return [{ text: String(content || "") }];
    return content.map((item) => (item.type === "text" ? { text: item.text } : toGeminiImagePart(item.image_url.url)));
}

function toGeminiImagePart(url: string): GeminiPart {
    const match = url.match(/^data:([^;,]+);base64,(.+)$/);
    if (match) return { inlineData: { mimeType: match[1], data: match[2] } };
    return { fileData: { fileUri: url, mimeType: "image/png" } };
}

function geminiTextContent(content: AiTextMessage["content"]) {
    if (!Array.isArray(content)) return String(content || "");
    return content.map((item) => (item.type === "text" ? item.text : item.image_url.url)).join("\n");
}

function parseOpenAiContent(payload: ResponseApiPayload) {
    return (
        payload.output_text ||
        payload.output
            ?.flatMap((item) => (item.type === "message" ? item.content || [] : []))
            .map((item) => item.text || "")
            .join("") ||
        ""
    );
}

function parseChatCompletionContent(payload: ChatCompletionPayload) {
    return payload.choices?.map((choice) => readChatContent(choice.message?.content)).join("") || "";
}

function readChatContent(content?: string | Array<{ type?: string; text?: string }>) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.map((item) => item.text || "").join("");
}

function parseGeminiContent(payload: GeminiPayload) {
    return (
        payload.candidates
            ?.flatMap((candidate) => candidate.content?.parts || [])
            .map((part) => part.text || "")
            .join("") || ""
    );
}

function validateResponsePayload(payload: ResponseApiPayload) {
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(payload.msg || "请求失败");
    if (payload.error?.message) throw new Error(payload.error.message);
}

function validateChatCompletionPayload(payload: ChatCompletionPayload) {
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(payload.msg || "请求失败");
    if (payload.error?.message) throw new Error(payload.error.message);
}

function validateGeminiPayload(payload: GeminiPayload) {
    if (payload.error?.message) throw new Error(payload.error.message);
    if (payload.promptFeedback?.blockReason) throw new Error(`Gemini 拒绝了本次请求：${payload.promptFeedback.blockReason}`);
}

async function readFetchError(response: Response, fallback: string) {
    const text = await response.text();
    if (!text) return readStatusError(response.status, fallback);
    try {
        const payload = JSON.parse(text) as { error?: { message?: string }; msg?: string; response?: { error?: { message?: string } } };
        return payload.msg || payload.error?.message || payload.response?.error?.message || readStatusError(response.status, fallback);
    } catch {
        return text.slice(0, 300) || readStatusError(response.status, fallback);
    }
}

function readStatusError(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return "鉴权失败，请检查 API Key、套餐权限或模型权限";
    if (status === 429) return "请求被限流或额度不足，请稍后重试";
    return status ? `${fallback}，状态码 ${status}` : fallback;
}

function taskUrl(config: TextTaskConfig, path: string, origin: string, apiFormat = config.apiFormat) {
    const apiBase = normalizeApiBaseUrl(config.baseUrl, apiFormat, origin);
    return `${apiBase}${path}`;
}

function normalizeApiBaseUrl(baseUrl: string, apiFormat: "openai" | "gemini", origin: string) {
    const absoluteBase = baseUrl.startsWith("/") ? `${origin}${baseUrl}` : baseUrl;
    const normalized = absoluteBase.trim().replace(/\/+$/, "");
    const lower = normalized.toLowerCase();
    if (isInternalSystemProxyBase(normalized)) return normalized;
    if (lower.endsWith("/v1") || lower.endsWith("/v1beta") || lower.endsWith("/api/v3") || lower.endsWith("/api/plan/v3")) return normalized;
    if (apiFormat === "gemini") return `${normalized}/v1beta`;
    return `${normalized}/v1`;
}

function isInternalSystemProxyBase(value: string) {
    try {
        return /^\/api\/ai\/system\/[^/]+$/i.test(new URL(value).pathname);
    } catch {
        return false;
    }
}

export function taskHeaders(config: TextTaskConfig, cookie: string, pointsIdempotencyKey?: string) {
    const headers = new Headers();
    const internal = config.baseUrl.startsWith("/");
    const workerHeaders = maintenanceWorkerContextHeaders(cookie);
    if (internal && workerHeaders) Object.entries(workerHeaders).forEach(([key, value]) => headers.set(key, value));
    else if (internal && cookie) headers.set("cookie", cookie);
    if (internal) {
        Object.entries(systemAiBillingHeaders(generationModelId(config), pointsIdempotencyKey, config.model)).forEach(([key, value]) => headers.set(key, value));
    }
    if (!internal && config.apiFormat === "gemini") headers.set("x-goog-api-key", config.apiKey);
    else if (!internal) headers.set("authorization", `Bearer ${config.apiKey}`);
    return headers;
}

function taskFetch(config: TextTaskConfig, url: string, init: RequestInit) {
    const nextInit = {
        ...init,
        signal: init.signal || AbortSignal.timeout(resolveModelRequestTimeoutMs(config, "text")),
    };
    return isInternalApiBaseUrl(config.baseUrl) ? fetchInternalApi(url, nextInit) : fetchSafeOutbound(url, nextInit);
}

async function submissionFetch(config: TextTaskConfig, url: string, init: RequestInit) {
    try {
        return await taskFetch(config, url, init);
    } catch (error) {
        if (isTextRequestTimeout(error)) throw new GenerationSubmissionSafeFailure("文本模型响应超时，正在切换备用模型", 504);
        throw generationSubmissionUncertainError(error, toSafeGenerationErrorMessage(error, "文本任务创建结果未知"));
    }
}

function isTextRequestTimeout(error: unknown) {
    if (!(error instanceof Error)) return false;
    return error.name === "TimeoutError" || /timeout|timed out|aborted due to timeout/i.test(error.message);
}

async function parseTextSubmissionJson<T>(task: TextTask, response: Response): Promise<T> {
    try {
        return (await response.json()) as T;
    } catch {
        await persistTextResponseBilling(task, response.headers);
        throw new GenerationSubmissionUncertainError("文本接口返回了无效 JSON，创建结果待确认");
    }
}

async function persistTextResponseBilling(task: TextTask, headers: Headers) {
    const billing = readSystemAiBilling(headers);
    if (hasSystemAiCharge(billing)) await updateTextTask(task.id, { billing: { pointsCost: billing.pointsCost, pointsRecordId: billing.pointsRecordId, refunded: false } });
}

function geminiHeaders(config: TextTaskConfig, cookie: string, pointsIdempotencyKey?: string) {
    const headers = taskHeaders(config, cookie, pointsIdempotencyKey);
    headers.set("content-type", "application/json");
    return headers;
}

function pointsIdempotencyKey(task: TextTask, protocol: ResolvedTextProtocol) {
    return `text-task:${task.id}:attempt:${task.attemptNo || 1}:${protocol.kind}`;
}

function readPointsRemaining(headers: Headers) {
    const value = Number(headers.get("x-vozeb-pro-points-remaining"));
    return Number.isFinite(value) ? value : undefined;
}

function readBilling(headers: Headers) {
    return {
        pointsRemaining: readPointsRemaining(headers),
        ...readSystemAiBilling(headers),
    };
}

async function refundChargedTextResponse(task: TextTask, headers: Headers) {
    const billing = readSystemAiBilling(headers);
    if (hasSystemAiCharge(billing)) await refundUserPoints(task.userId, generationModelId(task.config), billing.pointsCost, "text", 1, undefined, billing.pointsRecordId);
}
