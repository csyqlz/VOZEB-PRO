import { audioMimeType, normalizeAudioFormatValue, normalizeAudioSpeedValue, normalizeAudioVoiceValue } from "@/lib/audio-generation";
import { GenerationTaskNeedsReviewError, type GenerationTaskExecutionState } from "@/services/api/generation-task-state";
import { readStoredMediaFile, uploadGeneratedMediaFile, type UploadedFile } from "@/services/file-storage";
import { refreshUserPointsIfSystem, syncUserPointsFromHeaders } from "@/services/api/points";
import { throwIfClientSessionExpired } from "@/services/api/session-expiration";
import { resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";

type RequestOptions = {
    signal?: AbortSignal;
    source?: string;
    conversationId?: string;
    runId?: string;
    surface?: "chat" | "canvas" | "drama";
    projectId?: string;
    parentTaskId?: string;
    attemptNo?: number;
    clientRequestId?: string;
};

export type AudioGenerationTask = { id: string; status?: "pending" | "running" | "success" | "error" | "cancelled"; model: string };

type AudioTaskPayload = { task?: AudioGenerationTask & GenerationTaskExecutionState & { result?: { url: string; mimeType: string }; error?: string }; error?: string };

const AUDIO_TASK_POLL_INTERVAL_MS = 1800;
const AUDIO_TASK_TIMEOUT_MS = 30 * 60 * 1000;

export type GeneratedAudioResult = { blob: Blob; url: string; mimeType: string };

export async function requestAudioGeneration(config: AiConfig, prompt: string, options?: RequestOptions): Promise<GeneratedAudioResult> {
    const task = await createAudioGenerationTask(config, prompt, options);
    return waitForAudioGenerationTask(config, task, options);
}

export async function createAudioGenerationTask(config: AiConfig, prompt: string, options?: RequestOptions): Promise<AudioGenerationTask> {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.audioModel);
    const model = requestConfig.model.trim();
    if (!model) throw new Error("请先配置音频模型");
    const format = normalizeAudioFormatValue(config.audioFormat);
    const instructions = config.audioInstructions.trim();
    const response = await fetch("/api/audio-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            config: {
                model,
                voice: normalizeAudioVoiceValue(config.audioVoice),
                format,
                speed: normalizeAudioSpeedValue(config.audioSpeed),
                ...(instructions ? { instructions } : {}),
            },
            prompt,
            source: options?.source,
            context: taskContext(options),
        }),
        signal: options?.signal,
    });
    throwIfClientSessionExpired(response);
    syncUserPointsFromHeaders(response.headers, requestConfig.apiSource);
    if (!response.ok) throw new Error(await readFetchError(response, "创建音频任务失败"));
    const payload = (await response.json()) as AudioTaskPayload;
    if (!payload.task?.id) throw new Error(payload.error || "创建音频任务失败");
    return payload.task;
}

export async function waitForAudioGenerationTask(config: AiConfig, task: AudioGenerationTask, options?: RequestOptions): Promise<GeneratedAudioResult> {
    const requestConfig = resolveModelRequestConfig(config, task.model);
    const format = normalizeAudioFormatValue(config.audioFormat);
    try {
        const startedAt = Date.now();
        for (;;) {
            if (options?.signal?.aborted) throw new DOMException("请求已取消", "AbortError");
            if (Date.now() - startedAt > AUDIO_TASK_TIMEOUT_MS) throw new Error("音频生成超时，请稍后重试");
            const taskResponse = await fetch(`/api/audio-tasks/${encodeURIComponent(task.id)}`, { cache: "no-store", signal: options?.signal });
            throwIfClientSessionExpired(taskResponse);
            syncUserPointsFromHeaders(taskResponse.headers, requestConfig.apiSource);
            if (!taskResponse.ok) throw new Error(await readFetchError(taskResponse, "读取音频任务失败"));
            const taskPayload = (await taskResponse.json()) as AudioTaskPayload;
            const current = taskPayload.task;
            if (!current) throw new Error(taskPayload.error || "音频任务不存在");
            if (current.needsReview) throw new GenerationTaskNeedsReviewError(current.reviewReason);
            if (current.status === "success") {
                if (!current.result?.url) throw new Error("音频任务没有返回结果");
                const audioResponse = await fetch(current.result.url, { signal: options?.signal });
                if (!audioResponse.ok) throw new Error(await readFetchError(audioResponse, "读取音频结果失败"));
                const blob = await audioResponse.blob();
                await assertAudioBlob(blob);
                await refreshUserPointsIfSystem(requestConfig.apiSource);
                const audio = blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: audioMimeType(format) });
                return { blob: audio, url: current.result.url, mimeType: current.result.mimeType || audio.type };
            }
            if (current.status === "error" || current.status === "cancelled") throw new Error(current.error || (current.status === "cancelled" ? "请求已取消" : "音频生成失败"));
            await delay(AUDIO_TASK_POLL_INTERVAL_MS, options?.signal);
        }
    } catch (error) {
        if (options?.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
            await fetch(`/api/audio-tasks/${encodeURIComponent(task.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "cancelled" }) }).catch(() => undefined);
        }
        await refreshUserPointsIfSystem(requestConfig.apiSource);
        throw error instanceof Error ? error : new Error("音频生成失败");
    }
}

function taskContext(options?: RequestOptions) {
    if (!options) return undefined;
    return {
        conversationId: options.conversationId,
        runId: options.runId,
        surface: options.surface,
        projectId: options.projectId,
        parentTaskId: options.parentTaskId,
        attemptNo: options.attemptNo,
        clientRequestId: options.clientRequestId,
    };
}

export async function storeGeneratedAudio(result: GeneratedAudioResult | Blob, format = "mp3"): Promise<UploadedFile> {
    if (!(result instanceof Blob)) {
        const stored = await readStoredMediaFile(result.url, "audio", result.mimeType);
        if (stored) return stored;
    }
    const blob = result instanceof Blob ? result : result.blob;
    const audio = blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: audioMimeType(format) });
    return uploadGeneratedMediaFile(audio, "audio");
}

async function assertAudioBlob(blob: Blob) {
    if (!blob.type.includes("json")) return;
    let payload: { code?: number; msg?: string; error?: { message?: string } };
    try {
        payload = JSON.parse(await blob.text()) as { code?: number; msg?: string; error?: { message?: string } };
    } catch {
        return;
    }
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(payload.msg || "音频生成失败");
    if (payload.error?.message) throw new Error(payload.error.message);
}

async function readFetchError(response: Response, fallback: string) {
    const text = await response.text();
    if (text) {
        try {
            const payload = JSON.parse(text) as { error?: string | { message?: string }; msg?: string; message?: string };
            const message = typeof payload.error === "string" ? payload.error : payload.error?.message || payload.msg || payload.message;
            if (message) return message;
        } catch {
            if (text.trim()) return text.trim().slice(0, 300);
        }
    }
    return statusMessage(response.status, fallback);
}

function statusMessage(status: number, fallback: string) {
    if (status === 401 || status === 403) return "当前服务暂时无法使用，请稍后重试或联系客服";
    if (status === 429) return "请求被限流或额度不足，请稍后重试";
    return status ? `${fallback}（${status}）` : fallback;
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("请求已取消", "AbortError"));
            return;
        }
        const timer = window.setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve();
        }, ms);
        const abort = () => {
            window.clearTimeout(timer);
            reject(new DOMException("请求已取消", "AbortError"));
        };
        signal?.addEventListener("abort", abort, { once: true });
    });
}
