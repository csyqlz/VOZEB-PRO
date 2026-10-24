import { markAudioTaskFailed } from "@/lib/server/audio-task-runtime";
import { getAudioTask, updateAudioTask } from "@/lib/server/audio-task-store";
import { markImageTaskFailed } from "@/lib/server/image-task-runtime";
import { getImageTask, updateImageTask } from "@/lib/server/image-task-store";
import { getStoredGenerationTaskRecord, type GenerationTaskType } from "@/lib/server/generation-task-store";
import { scheduleGenerationTask } from "@/lib/server/generation-task-scheduler";
import { markTextTaskFailed } from "@/lib/server/text-task-runtime";
import { getTextTask, transitionTextTask, updateTextTask } from "@/lib/server/text-task-store";
import { failVideoTaskFromWorker } from "@/lib/server/video-task-runtime";
import { getVideoTask, updateVideoTask } from "@/lib/server/video-task-store";

export type ReviewableGenerationTaskType = Extract<GenerationTaskType, "text" | "image" | "video" | "audio">;
export type GenerationTaskReviewInput = { action: "resume_upstream"; upstreamTaskId: string; origin: string } | { action: "provide_result"; result: string } | { action: "confirm_failed"; reason?: string };

export async function reviewGenerationTask(type: ReviewableGenerationTaskType, id: string, input: GenerationTaskReviewInput) {
    const record = await getStoredGenerationTaskRecord(type, id);
    if (!record) throw new GenerationTaskReviewError(404, "生成任务不存在或已过期");
    if (type === "text" && record.payload?.billingMode === "official-usage") throw new GenerationTaskReviewError(409, "按量文本任务请使用账务核对，不能直接补结果或确认失败");
    if (type === "image" && record.payload?.billingMode === "official-usage") throw new GenerationTaskReviewError(409, "按量图片任务必须核对原计费凭据，不能直接补结果或确认失败");
    if (type === "video" && record.payload?.billingMode === "official-usage") throw new GenerationTaskReviewError(409, "按量视频任务必须核对原计费凭据，不能直接补结果或确认失败");
    if (type === "audio" && record.payload?.billingMode === "official-usage") throw new GenerationTaskReviewError(409, "按量音频任务必须核对原计费凭据，不能直接补结果或确认失败");
    if (record.executionPhase !== "needs_review") throw new GenerationTaskReviewError(409, "当前任务不需要人工确认");

    if (input.action === "resume_upstream") {
        const upstreamTaskId = clean(input.upstreamTaskId, 500);
        if (!upstreamTaskId) throw new GenerationTaskReviewError(400, "请输入上游任务 ID");
        await attachUpstreamTask(type, id, upstreamTaskId, input.origin);
        const now = Date.now();
        await scheduleGenerationTask(type, id, { executionPhase: "submitted", upstreamTaskId, submittedAt: record.submittedAt || now, nextPollAt: now, lastUpstreamStatus: "manually_confirmed" });
        return { action: input.action, executionPhase: "submitted" as const };
    }

    if (input.action === "provide_result") {
        const result = clean(input.result, 20_000);
        if (!result) throw new GenerationTaskReviewError(400, type === "text" ? "请输入文本结果" : "请输入结果地址");
        if (type === "text") {
            const task = await requireTextTask(id);
            const completed = await transitionTextTask(task, ["pending", "running"], { status: "success", result: { content: result }, messages: [], config: { ...task.config, apiKey: "" } });
            if (!completed) throw new GenerationTaskReviewError(409, "文本任务状态已变化");
            await updateTextTask(id, { config: { ...task.config, apiKey: "" }, candidateConfigs: [] });
            await scheduleGenerationTask(type, id, { executionPhase: "completed", nextPollAt: undefined, lastUpstreamStatus: "manual_result" });
            return { action: input.action, executionPhase: "completed" as const };
        }
        if (!isResultUrl(result)) throw new GenerationTaskReviewError(400, "结果地址必须是 http(s)、data: 或站内媒体路径");
        await scheduleGenerationTask(type, id, { executionPhase: "result_ready", resultPayload: { url: result }, nextPollAt: Date.now(), lastUpstreamStatus: "manual_result" });
        return { action: input.action, executionPhase: "result_ready" as const };
    }

    const reason = clean(input.reason, 500) || "管理员已确认上游未创建任务";
    await failTask(type, id, reason);
    await scheduleGenerationTask(type, id, { executionPhase: "completed", nextPollAt: undefined, lastUpstreamStatus: "manually_failed" });
    return { action: input.action, executionPhase: "completed" as const };
}

async function attachUpstreamTask(type: ReviewableGenerationTaskType, id: string, upstreamTaskId: string, origin: string) {
    if (type === "text") {
        const task = await requireTextTask(id);
        await updateTextTask(id, { upstream: { id: upstreamTaskId, createPath: task.config.advancedConfig?.createPath || "" } });
        return;
    }
    if (type === "image") {
        const task = await getImageTask(id);
        if (!task) throw new GenerationTaskReviewError(404, "图片任务不存在或已过期");
        const baseUrl = absoluteProviderBase(task.config.baseUrl, origin);
        await updateImageTask(id, { upstream: { id: upstreamTaskId, mediaBaseUrl: baseUrl, pollBaseUrl: baseUrl } });
        return;
    }
    if (type === "audio") {
        const task = await getAudioTask(id);
        if (!task) throw new GenerationTaskReviewError(404, "音频任务不存在或已过期");
        await updateAudioTask(id, { upstream: { id: upstreamTaskId, createPath: task.config.advancedConfig?.createPath || "/audio/speech" } });
        return;
    }
    const task = await getVideoTask(id);
    if (!task) throw new GenerationTaskReviewError(404, "视频任务不存在或已过期");
    await updateVideoTask(id, { upstream: { ...task.upstream, id: upstreamTaskId } });
}

async function failTask(type: ReviewableGenerationTaskType, id: string, reason: string) {
    if (type === "text") return markTextTaskFailed(await requireTextTask(id), reason);
    if (type === "image") {
        const task = await getImageTask(id);
        if (!task) throw new GenerationTaskReviewError(404, "图片任务不存在或已过期");
        return markImageTaskFailed(task, reason);
    }
    if (type === "audio") {
        const task = await getAudioTask(id);
        if (!task) throw new GenerationTaskReviewError(404, "音频任务不存在或已过期");
        return markAudioTaskFailed(task, reason);
    }
    const task = await getVideoTask(id);
    if (!task) throw new GenerationTaskReviewError(404, "视频任务不存在或已过期");
    return failVideoTaskFromWorker(task, reason);
}

async function requireTextTask(id: string) {
    const task = await getTextTask(id);
    if (!task) throw new GenerationTaskReviewError(404, "文本任务不存在或已过期");
    return task;
}

function absoluteProviderBase(baseUrl: string, origin: string) {
    return baseUrl.startsWith("/") ? `${origin}${baseUrl}` : baseUrl;
}

function isResultUrl(value: string) {
    return /^(?:https?:\/\/|data:(?:image|video|audio)\/|\/api\/(?:reference-assets|generation-log-assets)\/)/i.test(value);
}

function clean(value: unknown, max: number) {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export class GenerationTaskReviewError extends Error {
    constructor(
        public readonly status: number,
        message: string,
    ) {
        super(message);
    }
}
