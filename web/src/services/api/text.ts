import { resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import type { AiTextMessage } from "@/types/ai";
import { GenerationTaskNeedsReviewError, GenerationTaskTerminalError, type GenerationTaskExecutionState } from "@/services/api/generation-task-state";
import { refreshUserPointsIfSystem, syncUserPointsFromHeaders } from "@/services/api/points";
import { throwIfClientSessionExpired } from "@/services/api/session-expiration";

type RequestOptions = { signal?: AbortSignal; timeoutMs?: number };

export type TextGenerationTaskLifecycle = GenerationTaskExecutionState & Pick<TextGenerationTask, "status">;
type WaitTextTaskOptions = RequestOptions & { onState?: (task: TextGenerationTaskLifecycle) => void };

export type TextGenerationTask = {
    id: string;
    status?: "pending" | "running" | "success" | "error";
    model: string;
};

type TextTaskPayload = {
    task?: TextGenerationTask &
        GenerationTaskExecutionState & {
            result?: { content?: string };
            error?: string;
        };
    error?: string;
};

const TEXT_TASK_POLL_INTERVAL_MS = 1500;
const TEXT_TASK_TIMEOUT_MS = 3 * 60 * 1000;

export async function createTextGenerationTask(config: AiConfig, messages: AiTextMessage[], options?: RequestOptions): Promise<TextGenerationTask> {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.textModel);
    const response = await fetch("/api/text-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: { model: requestConfig.model }, messages }),
        signal: options?.signal,
    });
    throwIfClientSessionExpired(response);
    syncUserPointsFromHeaders(response.headers, "system");
    const payload = (await response.json().catch(() => ({}))) as TextTaskPayload;
    if (!response.ok || !payload.task) throw new Error(payload.error || "创建文本任务失败");
    return payload.task;
}

export async function recoverTextGenerationTask(taskId: string, options?: RequestOptions): Promise<TextGenerationTask> {
    const response = await fetch(`/api/text-tasks/${encodeURIComponent(taskId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "recover" }),
        signal: options?.signal,
    });
    throwIfClientSessionExpired(response);
    syncUserPointsFromHeaders(response.headers, "system");
    const payload = (await response.json().catch(() => ({}))) as TextTaskPayload;
    if (!response.ok || !payload.task) throw new Error(payload.error || "重新检查文本任务失败");
    if (payload.task.needsReview) throw new GenerationTaskNeedsReviewError(payload.task.reviewReason);
    if (payload.task.status === "error") throw new GenerationTaskTerminalError(payload.task.error || "文本生成失败");
    return payload.task;
}

export async function waitForTextGenerationTask(config: AiConfig, task: TextGenerationTask, options?: WaitTextTaskOptions) {
    const startedAt = Date.now();
    const timeoutMs = options?.timeoutMs ?? TEXT_TASK_TIMEOUT_MS;
    for (;;) {
        if (timeoutMs > 0 && Date.now() - startedAt > timeoutMs) throw new Error("文本生成超时，请稍后重试");
        const response = await fetch(`/api/text-tasks/${encodeURIComponent(task.id)}`, { signal: options?.signal, cache: "no-store" });
        throwIfClientSessionExpired(response);
        const payload = (await response.json().catch(() => ({}))) as TextTaskPayload;
        const taskModel = payload.task?.model || task.model;
        syncUserPointsFromHeaders(response.headers, resolveModelRequestConfig(config, taskModel).apiSource);
        if (!response.ok || !payload.task) throw new Error(payload.error || "查询文本任务失败");
        options?.onState?.(payload.task);
        if (payload.task.needsReview) throw new GenerationTaskNeedsReviewError(payload.task.reviewReason);
        if (payload.task.status === "success") {
            await refreshUserPointsIfSystem(resolveModelRequestConfig(config, taskModel).apiSource);
            return payload.task.result?.content || "";
        }
        if (payload.task.status === "error") {
            await refreshUserPointsIfSystem(resolveModelRequestConfig(config, taskModel).apiSource);
            throw new GenerationTaskTerminalError(payload.task.error || "文本生成失败");
        }
        await delay(TEXT_TASK_POLL_INTERVAL_MS, options?.signal);
    }
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
