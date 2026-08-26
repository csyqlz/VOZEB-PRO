import { getAuthSettings, refundUserPoints } from "@/lib/auth/store";
import { fileTypeFromBuffer } from "file-type";
import { mediaTaskSource } from "@/lib/media-management-contract";
import { audioTaskRefundIdempotencyKey, refundAudioTask } from "@/lib/server/audio-task-refund";
import { getAudioTask, transitionAudioTask, updateAudioTask, type AudioTask } from "@/lib/server/audio-task-store";
import { generationModelId, systemGenerationChannelId } from "@/lib/server/generation-channel";
import { generationMediaProxyHeaders } from "@/lib/server/generation-media-authorization";
import { finishGenerationAttempt, startGenerationAttempt } from "@/lib/server/generation-attempt";
import { fetchInternalApi, isInternalApiBaseUrl } from "@/lib/server/internal-origin";
import { maintenanceWorkerHeaders } from "@/lib/server/maintenance-auth";
import { resolveModelRequestTimeoutMs } from "@/lib/server/model-request-policy";
import { buildProviderRequest, isProviderBusinessError, providerQueryPaths, readProviderError, readProviderString, resolvedProviderCreatePaths } from "@/lib/server/provider-task-config";
import { writePersistentMediaDataUrl } from "@/lib/server/reference-asset-store";
import { registerGenerationTaskAssetsForUser } from "@/lib/server/creative-runtime-service";
import { scheduleGenerationTask } from "@/lib/server/generation-task-scheduler";
import { GenerationSubmissionSafeFailure, GenerationSubmissionUncertainError, generationSubmissionResponseError, generationSubmissionUncertainError } from "@/lib/server/generation-submission-error";
import { systemAiBillingHeaders } from "@/lib/server/system-ai-billing";
import { fetchSafeOutbound } from "@/lib/server/safe-outbound-fetch";

export type AudioUpstreamStep =
    | { state: "pending"; status: string; upstreamTaskId: string; createPath: string; pointsCost?: number; pointsRecordId?: string }
    | { state: "result_ready"; status: string; resultUrl: string; pointsCost?: number; pointsRecordId?: string }
    | { state: "completed" }
    | { state: "failed"; status: string; error: string };

export async function createAudioTaskUpstreamStep(task: AudioTask, origin: string, cookie = "", workerUserId = ""): Promise<AudioUpstreamStep> {
    const current = await getAudioTask(task.id);
    if (!current || current.status === "cancelled") return { state: "failed", status: "cancelled", error: "任务已取消" };
    const running = current.status === "pending" ? await transitionAudioTask(current, ["pending"], { status: "running" }) : current;
    if (!running) return { state: "failed", status: "conflict", error: "音频任务状态已变化" };
    if (running.upstream?.id) return queryAudioTaskUpstreamStep(running, origin, cookie, workerUserId);

    const candidates = [running.config, ...(running.candidateConfigs || [])];
    let attempts = running.attempts || [];
    let latestError = "没有可用的音频渠道";
    for (const [index, config] of candidates.entries()) {
        const started = startGenerationAttempt(attempts, { channelId: config.channelId, model: generationModelId(config), capability: "audio" });
        attempts = started.attempts;
        const candidate = { ...running, config, candidateConfigs: candidates.slice(index + 1), attempts, attemptNo: started.attempt.attemptNo, upstream: undefined, billing: undefined };
        await updateAudioTask(task.id, { config, candidateConfigs: candidate.candidateConfigs, attempts, attemptNo: candidate.attemptNo, upstream: undefined, billing: undefined });
        await scheduleGenerationTask("audio", task.id, { executionPhase: "submitting", nextPollAt: Date.now(), channelId: config.channelId, provider: config.advancedConfig?.protocol || config.apiFormat, lastUpstreamStatus: "submitting" });

        try {
            const defaults = {
                model: config.model,
                input: candidate.prompt,
                prompt: candidate.prompt,
                text: candidate.prompt,
                voice: config.voice,
                response_format: config.format,
                format: config.format,
                speed: Number(config.speed) || 1,
                ...(config.instructions ? { instructions: config.instructions } : {}),
            };
            let payload: Record<string, unknown>;
            try {
                payload = buildProviderRequest(config.advancedConfig?.requestTemplate, defaults, defaults);
            } catch (error) {
                throw new GenerationSubmissionSafeFailure(error instanceof Error ? error.message : "音频请求模板无效");
            }
            const { response, path } = await createAudioUpstream(candidate, origin, cookie, workerUserId, payload);
            const billing = readBilling(response.headers);
            if (billing.pointsRecordId) await updateAudioTask(task.id, { billing: { pointsCost: billing.pointsCost ?? 0, pointsRecordId: billing.pointsRecordId, refunded: false } });
            const contentType = response.headers.get("content-type")?.split(";")[0].toLowerCase() || "";
            if (!contentType.includes("json")) {
                const completed = await persistAudioBytes(candidate, origin, Buffer.from(await response.arrayBuffer()), contentType);
                if (completed?.status === "success") {
                    await markAudioAttemptSucceeded(candidate, billing);
                    return { state: "completed" };
                }
                return { state: "failed", status: completed?.status || "cancelled", error: completed?.error || "任务已取消" };
            }

            let data: unknown;
            try {
                data = await response.json();
            } catch {
                throw new GenerationSubmissionUncertainError("音频接口返回了无效 JSON，创建结果待确认");
            }
            if (isProviderBusinessError(data)) throw new GenerationSubmissionSafeFailure(readProviderError(data) || "音频接口返回失败");
            const directUrl = readProviderString(data, config.advancedConfig?.resultField, AUDIO_KEYS);
            if (directUrl) {
                const submittedAt = Date.now();
                await scheduleGenerationTask("audio", task.id, {
                    executionPhase: "result_ready",
                    channelId: config.channelId,
                    provider: config.advancedConfig?.protocol || config.apiFormat,
                    submittedAt,
                    nextPollAt: submittedAt,
                    lastUpstreamStatus: "completed",
                    resultPayload: { url: directUrl },
                });
                return { state: "result_ready", status: "completed", resultUrl: directUrl, ...billing };
            }
            const id = readProviderString(data, undefined, ID_KEYS);
            if (!id) throw new GenerationSubmissionUncertainError("音频接口没有返回音频或任务 ID，创建结果待确认");
            await updateAudioTask(task.id, { upstream: { id, createPath: path } });
            const submittedAt = Date.now();
            await scheduleGenerationTask("audio", task.id, {
                executionPhase: "submitted",
                upstreamTaskId: id,
                channelId: config.channelId,
                provider: config.advancedConfig?.protocol || config.apiFormat,
                queryPath: config.advancedConfig?.queryPath,
                submittedAt,
                nextPollAt: submittedAt,
                lastUpstreamStatus: "submitted",
            });
            return { state: "pending", status: "submitted", upstreamTaskId: id, createPath: path, ...billing };
        } catch (error) {
            if (!(error instanceof GenerationSubmissionSafeFailure)) throw generationSubmissionUncertainError(error, "音频任务创建结果未知");
            latestError = error.message;
            attempts = finishGenerationAttempt(attempts, candidate.attemptNo, { status: "failed", error: latestError });
            await refundAudioCandidate(candidate);
            await updateAudioTask(task.id, { attempts, attemptNo: candidate.attemptNo, upstream: undefined, billing: undefined });
        }
    }
    return { state: "failed", status: "failed", error: latestError };
}

export async function queryAudioTaskUpstreamStep(task: AudioTask, origin: string, cookie = "", workerUserId = ""): Promise<AudioUpstreamStep> {
    if (!task.upstream?.id) return { state: "failed", status: "missing_upstream_id", error: "音频任务缺少上游任务 ID" };
    let lastError = "";
    for (const path of providerQueryPaths(task.config.advancedConfig, task.upstream.id, [`${task.upstream.createPath.replace(/\/+$/, "")}/${encodeURIComponent(task.upstream.id)}`])) {
        const response = await providerFetch(task, origin, cookie, workerUserId, path, { cache: "no-store", signal: AbortSignal.timeout(Math.min(resolveModelRequestTimeoutMs(task.config, "audio"), 60_000)) });
        const text = await response.text();
        if (!response.ok) {
            lastError = readAudioError(text, response.status);
            continue;
        }
        let data: unknown;
        try {
            data = JSON.parse(text);
        } catch {
            lastError = "音频任务查询返回了无效 JSON";
            continue;
        }
        const result = readProviderString(data, task.config.advancedConfig?.resultField, AUDIO_KEYS);
        const status = readProviderString(data, task.config.advancedConfig?.statusField, STATUS_KEYS).toLowerCase();
        if (result) return { state: "result_ready", status: status || "completed", resultUrl: result };
        if (FAILED.has(status)) return { state: "failed", status, error: readProviderString(data, undefined, ERROR_KEYS) || "音频生成失败" };
        return { state: "pending", status: status || "processing", upstreamTaskId: task.upstream.id, createPath: task.upstream.createPath };
    }
    throw new Error(lastError || "音频任务查询失败");
}

export async function persistAudioTaskResult(task: AudioTask, origin: string, resultUrl: string, cookie = "", workerUserId = "") {
    if (/^data:audio\//i.test(resultUrl)) {
        const asset = await writePersistentMediaDataUrl(resultUrl, "audio", mediaContext(task));
        return completeAudioTask(task, asset.url || `${origin}/api/reference-assets/${asset.token}`, resultUrl.slice(5, resultUrl.indexOf(";")) || mimeFromFormat(task.config.format || "mp3"));
    }
    const path = /^https?:\/\//i.test(resultUrl) ? `/_media?url=${encodeURIComponent(resultUrl)}` : `/${resultUrl.replace(/^\/+/, "")}`;
    const response = await providerFetch(task, origin, cookie, workerUserId, path, { signal: AbortSignal.timeout(resolveModelRequestTimeoutMs(task.config, "audio")) });
    if (!response.ok) throw new Error(readAudioError(await response.text(), response.status));
    return persistAudioBytes(task, origin, Buffer.from(await response.arrayBuffer()), response.headers.get("content-type")?.split(";")[0] || "");
}

export async function markAudioTaskFailed(task: AudioTask, error: string) {
    const current = (await getAudioTask(task.id)) || task;
    if (current.status === "cancelled" || current.status === "success") return current;
    const billing = current.billing;
    const attempts = finishGenerationAttempt(current.attempts || [], current.attemptNo || current.attempts?.at(-1)?.attemptNo || 1, { status: "failed", error, pointsCost: billing?.pointsCost, pointsRecordId: billing?.pointsRecordId });
    const failed = await transitionAudioTask(current, ["pending", "running"], { status: "error", error: error.slice(0, 500), config: { ...current.config, apiKey: "" }, billing });
    if (!failed) {
        const latest = await getAudioTask(current.id);
        if (latest?.status === "error" || latest?.status === "cancelled") return refundAudioTask(latest);
        return latest;
    }
    await updateAudioTask(current.id, { attempts, candidateConfigs: [], attemptNo: attempts.at(-1)?.attemptNo });
    return refundAudioTask(failed);
}

async function createAudioUpstream(task: AudioTask, origin: string, cookie: string, workerUserId: string, payload: Record<string, unknown>) {
    let lastError = "";
    const idempotencyKey = `audio-task:${task.id}:attempt:${task.attemptNo || 1}`;
    for (const path of resolvedProviderCreatePaths(task.config.advancedConfig, "audio", ["/audio/speech"])) {
        let response: Response;
        try {
            response = await providerFetch(task, origin, cookie, workerUserId, path, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Idempotency-Key": idempotencyKey,
                    "X-Client-Request-Id": idempotencyKey,
                    ...(task.config.baseUrl.startsWith("/") ? systemAiBillingHeaders(generationModelId(task.config), idempotencyKey, task.config.model) : {}),
                },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(resolveModelRequestTimeoutMs(task.config, "audio")),
            });
        } catch (error) {
            throw generationSubmissionUncertainError(error, "音频任务创建结果未知");
        }
        if (response.ok) return { response, path };
        lastError = readAudioError(await response.text(), response.status);
        const responseError = generationSubmissionResponseError(response.status, lastError);
        if (responseError instanceof GenerationSubmissionUncertainError) throw responseError;
    }
    throw new GenerationSubmissionSafeFailure(lastError || "没有可用的音频创建接口");
}

async function refundAudioCandidate(task: AudioTask) {
    const current = await getAudioTask(task.id);
    const billing = current?.billing;
    if (!billing?.pointsRecordId || billing.refunded) return;
    await refundUserPoints(task.userId, generationModelId(task.config), billing.pointsCost, "audio", 1, audioTaskRefundIdempotencyKey({ id: task.id, attemptNo: task.attemptNo }), billing.pointsRecordId);
}

async function persistAudioBytes(task: AudioTask, origin: string, bytes: Buffer, responseMime: string) {
    if (!bytes.length || bytes.length > 30 * 1024 * 1024) throw new Error("音频结果为空或超过 30MB 限制");
    const detected = await fileTypeFromBuffer(bytes);
    const detectedMime = detected?.mime.startsWith("audio/") ? detected.mime : "";
    const declaredMime = responseMime.toLowerCase().startsWith("audio/") ? responseMime.toLowerCase() : "";
    if (!detectedMime && (!declaredMime || looksLikeTextResponse(bytes))) throw new GenerationSubmissionSafeFailure("音频接口返回的不是有效音频文件");
    const mimeType = detectedMime || declaredMime || mimeFromFormat(task.config.format || "mp3");
    const asset = await writePersistentMediaDataUrl(`data:${mimeType};base64,${bytes.toString("base64")}`, "audio", mediaContext(task));
    return completeAudioTask(task, asset.url || `${origin}/api/reference-assets/${asset.token}`, mimeType);
}

function looksLikeTextResponse(bytes: Buffer) {
    const prefix = bytes.subarray(0, 256).toString("utf8").trimStart().toLowerCase();
    return prefix.startsWith("<!doctype") || prefix.startsWith("<html") || prefix.startsWith("{") || prefix.startsWith("[");
}

async function completeAudioTask(task: AudioTask, url: string, mimeType: string) {
    const current = await getAudioTask(task.id);
    if (!current || current.status === "cancelled") {
        if (current?.status === "cancelled") await refundAudioTask(current);
        return current;
    }
    const completed = await transitionAudioTask(current, ["pending", "running"], { status: "success", result: { url, mimeType }, config: { ...current.config, apiKey: "" }, billing: current.billing });
    if (!completed) {
        const latest = await getAudioTask(task.id);
        if (latest?.status === "cancelled") await refundAudioTask(latest);
        return latest;
    }
    await registerGenerationTaskAssetsForUser(completed.userId, {
        ...completed,
        taskId: completed.id,
        title: completed.prompt.slice(0, 80) || "生成音频",
        assets: [{ type: "audio", url, mimeType }],
    }).catch((error) => console.error("Creative audio asset registration failed", error));
    return completed;
}

async function markAudioAttemptSucceeded(task: AudioTask, billing: { pointsCost?: number; pointsRecordId?: string }) {
    const current = await getAudioTask(task.id);
    if (!current) return;
    const attempts = finishGenerationAttempt(current.attempts || [], current.attemptNo || 1, { status: "succeeded", pointsCost: billing.pointsCost, pointsRecordId: billing.pointsRecordId });
    await updateAudioTask(task.id, { attempts, attemptNo: attempts.at(-1)?.attemptNo, candidateConfigs: [], billing: billing.pointsRecordId ? { pointsCost: billing.pointsCost ?? 0, pointsRecordId: billing.pointsRecordId, refunded: false } : undefined });
}

function providerFetch(task: AudioTask, origin: string, cookie: string, workerUserId: string, path: string, init: RequestInit) {
    const url = task.config.baseUrl.startsWith("/") ? `${origin}${task.config.baseUrl.replace(/\/+$/, "")}${path}` : `${task.config.baseUrl.replace(/\/+$/, "")}${path}`;
    const headers = new Headers(init.headers);
    if (task.config.baseUrl.startsWith("/") && workerUserId) Object.entries(maintenanceWorkerHeaders(workerUserId)).forEach(([key, value]) => headers.set(key, value));
    else if (cookie) headers.set("cookie", cookie);
    if (task.config.baseUrl.startsWith("/")) Object.entries(systemAiBillingHeaders(generationModelId(task.config), undefined, task.config.model)).forEach(([key, value]) => headers.set(key, value));
    const mediaUrl = task.config.baseUrl.startsWith("/") ? mediaUrlFromProxyPath(path) : "";
    const channelId = task.config.channelId || systemGenerationChannelId(task.config.baseUrl);
    if (mediaUrl && channelId) Object.entries(generationMediaProxyHeaders({ userId: task.userId, taskType: "audio", taskId: task.id, channelId, upstreamModel: task.config.model, url: mediaUrl })).forEach(([key, value]) => headers.set(key, value));
    if (!task.config.baseUrl.startsWith("/")) headers.set(task.config.apiFormat === "gemini" ? "x-goog-api-key" : "authorization", task.config.apiFormat === "gemini" ? task.config.apiKey : `Bearer ${task.config.apiKey}`);
    return isInternalApiBaseUrl(task.config.baseUrl) ? fetchInternalApi(url, { ...init, headers }) : fetchSafeOutbound(url, { ...init, headers });
}

function mediaUrlFromProxyPath(path: string) {
    try {
        const parsed = new URL(path, "http://internal");
        return parsed.pathname === "/_media" ? parsed.searchParams.get("url")?.trim() || "" : "";
    } catch {
        return "";
    }
}

function readBilling(headers: Headers) {
    const raw = headers.get("x-vozeb-pro-points-cost");
    const value = raw === null ? undefined : Number(raw);
    return { pointsCost: value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined, pointsRecordId: headers.get("x-vozeb-pro-points-record-id") || undefined };
}

function mediaContext(task: AudioTask) {
    return { ownerUserId: task.userId, source: mediaTaskSource(task.source, task, "audio-task"), conversationId: task.conversationId, runId: task.runId, taskId: task.id, projectId: task.projectId };
}

function mimeFromFormat(format: string) {
    return format === "wav" ? "audio/wav" : format === "opus" ? "audio/ogg" : format === "aac" ? "audio/aac" : format === "flac" ? "audio/flac" : "audio/mpeg";
}

function readAudioError(value: string, status: number) {
    try {
        const payload = JSON.parse(value) as { msg?: string; message?: string; error?: string | { message?: string } };
        const message = typeof payload.error === "string" ? payload.error : payload.error?.message || payload.msg || payload.message;
        return message?.trim().slice(0, 500) || `音频生成失败（${status}）`;
    } catch {
        return value.trim().slice(0, 500) || `音频生成失败（${status}）`;
    }
}

const ID_KEYS = ["task_id", "taskId", "id", "job_id", "jobId", "generation_id", "generationId"];
const STATUS_KEYS = ["status", "state", "task_status", "taskStatus"];
const AUDIO_KEYS = ["audio_url", "audioUrl", "media_url", "mediaUrl", "output_url", "outputUrl", "result_url", "resultUrl", "url", "uri"];
const ERROR_KEYS = ["error_message", "errorMessage", "message", "msg", "error"];
const FAILED = new Set(["failed", "failure", "error", "cancelled", "canceled", "expired"]);
