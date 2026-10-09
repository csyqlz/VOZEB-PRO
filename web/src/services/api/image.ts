import { nanoid } from "nanoid";

import { GenerationTaskNeedsReviewError, type GenerationTaskExecutionState } from "@/services/api/generation-task-state";
import { dedupeImageResults } from "@/lib/image-result-dedupe";
import { GenerationTaskRequestError, readGenerationRetryAfterMs } from "@/services/api/generation-task-request-error";
import { refreshUserPointsIfSystem, syncUserPointsFromHeaders } from "@/services/api/points";
import { throwIfClientSessionExpired } from "@/services/api/session-expiration";
import { imageToDataUrl } from "@/services/image-storage";
import { serverMediaUrl } from "@/services/server-media-storage";
import { resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";

type GenerationLogSource = "agent" | "image-workbench" | "video-workbench" | "canvas" | "drama" | "unknown";
type RequestOptions = {
    signal?: AbortSignal;
    logSource?: GenerationLogSource;
    logTitle?: string;
    conversationId?: string;
    runId?: string;
    surface?: "chat" | "canvas" | "drama";
    projectId?: string;
    episodeId?: string;
    shotId?: string;
    estimatedPoints?: number;
    parentTaskId?: string;
    attemptNo?: number;
    clientRequestId?: string;
    generationLogId?: string;
    generationSlotId?: string;
    outputBackground?: "opaque" | "transparent";
    outputMode?: "layers";
    layerBatch?: { grant: string; slotId: string };
};

export type ImageGenerationTask = {
    id: string;
    kind: "generation" | "edit";
    model: string;
    status?: "pending" | "running" | "success" | "error" | "cancelled";
};

type ImageTaskPayload = {
    task?: ImageGenerationTask &
        GenerationTaskExecutionState & {
            result?: ImageGenerationResult & { results?: ImageGenerationResult[] };
            error?: string;
            canRetry?: boolean;
        };
    error?: string;
};

export type ImageGenerationResult = {
    dataUrl?: string;
    remoteUrl?: string;
    serverUrl?: string;
    width?: number;
    height?: number;
    bytes?: number;
    mimeType?: string;
};

const IMAGE_TASK_POLL_INTERVAL_MS = 1800;
const IMAGE_TASK_TIMEOUT_MS = 30 * 60 * 1000;

export class ImageGenerationTaskTerminalError extends Error {
    constructor(
        message: string,
        readonly canRetry: boolean,
    ) {
        super(message);
        this.name = "ImageGenerationTaskTerminalError";
    }
}

export class ImageGenerationTaskDeferredError extends Error {
    constructor(message = "图片仍在后台生成，系统会继续查询原任务") {
        super(message);
        this.name = "ImageGenerationTaskDeferredError";
    }
}

export function isImageGenerationTaskDeferredError(error: unknown) {
    return error instanceof ImageGenerationTaskDeferredError;
}

export async function createImageGenerationTask(config: AiConfig, prompt: string, references: ReferenceImage[] = [], mask?: ReferenceImage, options?: RequestOptions): Promise<ImageGenerationTask> {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.imageModel);
    const taskReferences = await Promise.all(references.map(referenceToTaskInput));
    const taskMask = mask ? await referenceToTaskInput(mask) : undefined;
    const response = await fetch("/api/image-tasks", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(options?.clientRequestId ? { "X-VOZEB-PRO-Client-Request-Id": options.clientRequestId } : {}),
            ...(options?.attemptNo ? { "X-VOZEB-PRO-Attempt-No": String(options.attemptNo) } : {}),
        },
        body: JSON.stringify({
            kind: references.length || mask ? "edit" : "generation",
            config: {
                model: requestConfig.model,
                quality: requestConfig.quality,
                size: requestConfig.size,
                ...(options?.outputBackground ? { outputBackground: options.outputBackground } : {}),
                ...(options?.outputMode ? { outputMode: options.outputMode } : {}),
            },
            prompt,
            references: taskReferences,
            mask: taskMask,
            layerBatch: options?.layerBatch,
            source: options?.logSource || "image-workbench",
            title: options?.logTitle || "",
            context: taskContext(options),
        }),
        signal: options?.signal,
    });
    throwIfClientSessionExpired(response);
    syncUserPointsFromHeaders(response.headers, requestConfig.apiSource);
    if (!response.ok) throw new GenerationTaskRequestError(await readFetchError(response, "创建图片任务失败"), response.status, false, readGenerationRetryAfterMs(response.headers));
    const payload = (await response.json()) as ImageTaskPayload;
    if (!payload.task?.id) throw new Error(payload.error || "创建图片任务失败");
    return payload.task;
}

export async function recoverImageGenerationTask(taskId: string, options?: Pick<RequestOptions, "signal">) {
    const response = await fetch(`/api/image-tasks/${encodeURIComponent(taskId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "recover" }),
        signal: options?.signal,
    });
    throwIfClientSessionExpired(response);
    syncUserPointsFromHeaders(response.headers, "system");
    if (!response.ok) throw new GenerationTaskRequestError(await readFetchError(response, "重新检查图片任务失败"), response.status, false, readGenerationRetryAfterMs(response.headers));
    const payload = (await response.json()) as ImageTaskPayload;
    if (!payload.task) throw new Error(payload.error || "重新检查图片任务失败");
    if (payload.task.needsReview) throw new GenerationTaskNeedsReviewError(payload.task.reviewReason);
    if (payload.task.status === "error" || payload.task.status === "cancelled") {
        throw new ImageGenerationTaskTerminalError(payload.task.error || (payload.task.status === "cancelled" ? "图片任务已取消" : "图片生成失败"), payload.task.canRetry === true);
    }
    return payload.task;
}

function taskContext(options?: RequestOptions) {
    if (!options) return undefined;
    return {
        conversationId: options.conversationId,
        runId: options.runId,
        surface: options.surface,
        projectId: options.projectId,
        episodeId: options.episodeId,
        shotId: options.shotId,
        estimatedPoints: options.estimatedPoints,
        parentTaskId: options.parentTaskId,
        attemptNo: options.attemptNo,
        clientRequestId: options.clientRequestId,
        generationLogId: options.generationLogId,
        generationSlotId: options.generationSlotId,
    };
}

export async function waitForImageGenerationTask(config: AiConfig, task: ImageGenerationTask, options?: RequestOptions) {
    const startedAt = Date.now();
    for (;;) {
        if (options?.signal?.aborted) throw new DOMException("请求已取消", "AbortError");
        if (Date.now() - startedAt > IMAGE_TASK_TIMEOUT_MS) {
            await refreshUserPointsIfSystem(config.apiSource);
            throw new ImageGenerationTaskDeferredError();
        }
        let response: Response;
        try {
            response = await fetch(`/api/image-tasks/${encodeURIComponent(task.id)}`, { cache: "no-store", signal: options?.signal });
        } catch (error) {
            if (options?.signal?.aborted) throw error;
            await delay(IMAGE_TASK_POLL_INTERVAL_MS, options?.signal);
            continue;
        }
        throwIfClientSessionExpired(response);
        syncUserPointsFromHeaders(response.headers, config.apiSource);
        if (!response.ok) {
            const message = await readFetchError(response, "读取图片任务失败");
            if (isDeferredPollStatus(response.status)) {
                await delay(IMAGE_TASK_POLL_INTERVAL_MS, options?.signal);
                continue;
            }
            throw new ImageGenerationTaskTerminalError(message, false);
        }
        const payload = (await response.json()) as ImageTaskPayload;
        const current = payload.task;
        if (!current) throw new ImageGenerationTaskTerminalError(payload.error || "图片任务不存在", false);
        if (current.needsReview) throw new GenerationTaskNeedsReviewError(current.reviewReason);
        if (current.status === "success") {
            if (!current.result?.dataUrl) throw new ImageGenerationTaskTerminalError("图片任务没有返回结果", true);
            await refreshUserPointsIfSystem(config.apiSource);
            const media = dedupeImageResults(current.result.results?.length ? current.result.results : [current.result]);
            const results = media.flatMap((item) =>
                item.dataUrl
                    ? [
                          {
                              id: nanoid(),
                              dataUrl: item.dataUrl,
                              remoteUrl: item.remoteUrl,
                              serverUrl: item.serverUrl,
                              width: item.width,
                              height: item.height,
                              bytes: item.bytes,
                              mimeType: item.mimeType,
                          },
                      ]
                    : [],
            );
            const first = results[0];
            if (!first) throw new ImageGenerationTaskTerminalError("图片任务没有返回结果", true);
            return {
                ...first,
                results,
            };
        }
        if (current.status === "error") {
            await refreshUserPointsIfSystem(config.apiSource);
            throw new ImageGenerationTaskTerminalError(current.error || "图片生成失败", current.canRetry === true);
        }
        if (current.status === "cancelled") {
            await refreshUserPointsIfSystem(config.apiSource);
            throw new ImageGenerationTaskTerminalError(current.error || "图片任务已取消", false);
        }
        await delay(IMAGE_TASK_POLL_INTERVAL_MS, options?.signal);
    }
}

function isDeferredPollStatus(status: number) {
    return status === 403 || [408, 425, 429].includes(status) || status >= 500;
}

async function referenceToTaskInput(reference: ReferenceImage) {
    const stableUrl = firstStableReferenceUrl(reference.serverUrl, reference.remoteUrl, reference.url, reference.dataUrl, serverMediaUrl(reference.storageKey, reference.serverUrl || reference.url || reference.dataUrl));
    const dataUrl = stableUrl || (await imageToDataUrl(reference)).trim();
    if (!dataUrl) throw new Error("参考图读取失败，请重新上传参考图");
    if (dataUrl.startsWith("blob:")) throw new Error("参考图已失效，请重新上传");
    const remoteUrl = firstRemoteReferenceUrl(reference.remoteUrl, reference.url, reference.serverUrl, reference.dataUrl, dataUrl);
    return {
        id: reference.id,
        name: reference.name,
        type: reference.type,
        dataUrl,
        url: remoteUrl,
        remoteUrl: isRemoteReferenceUrl(reference.remoteUrl) ? reference.remoteUrl : remoteUrl,
        serverUrl: reference.serverUrl,
        editRegion: reference.editRegion,
    };
}

function firstStableReferenceUrl(...values: Array<string | undefined>) {
    return values.map((value) => (value || "").trim()).find((value) => /^https?:\/\//i.test(value) || /^\/api\/(?:reference-assets|generation-log-assets|media-proxy)\//i.test(value));
}

function firstRemoteReferenceUrl(...values: Array<string | undefined>) {
    return values.find((value) => isRemoteReferenceUrl(value));
}

function isRemoteReferenceUrl(value?: string) {
    return /^https?:\/\//i.test(value || "");
}

async function readFetchError(response: Response, fallback: string) {
    const text = await response.text();
    if (!text) return statusError(response.status, fallback);
    try {
        const payload = JSON.parse(text) as { msg?: unknown; error?: unknown };
        const nestedError = payload.error && typeof payload.error === "object" ? (payload.error as { message?: unknown }).message : undefined;
        const message = typeof payload.msg === "string" ? payload.msg : typeof payload.error === "string" ? payload.error : typeof nestedError === "string" ? nestedError : "";
        return message || statusError(response.status, fallback);
    } catch {
        return text.slice(0, 300) || statusError(response.status, fallback);
    }
}

function statusError(status: number, fallback: string) {
    if (status === 401 || status === 403) return "鉴权失败，请检查 API Key、套餐权限或模型权限";
    if (status === 429) return "请求被限流或额度不足，请稍后重试";
    return status ? `${fallback}：${status}` : fallback;
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("请求已取消", "AbortError"));
            return;
        }
        const timer = globalThis.setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve();
        }, ms);
        const abort = () => {
            globalThis.clearTimeout(timer);
            reject(new DOMException("请求已取消", "AbortError"));
        };
        signal?.addEventListener("abort", abort, { once: true });
    });
}
