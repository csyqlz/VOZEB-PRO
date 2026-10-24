import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { mutateStoredGenerationTask } from "./generation-task-store";
import { GENERATION_TASK_RETENTION_MS } from "./generation-task-retention";
import { generationModelId } from "./generation-channel";
import { HAILUO_PRICE_MODELS, inspectHailuoObservation, type HailuoObservation } from "./model-pricing-hailuo-contract";
import type { VideoTask } from "./video-task-store";
import { inspectUsageFields } from "./model-pricing-usage-fields";

export type VideoUsageObservation = {
    protocol: "minimax-video-v2";
    quantities: Record<string, string>;
    missing: string[];
    invalid: string[];
    hasResult: boolean;
    upstreamTaskId?: string;
    reportedModel?: string;
    status?: string;
    resolution?: string;
    taskType?: string;
    modality?: string;
    usageFields?: Record<string, string>;
    unmappedUsageFields?: string[];
    meterSources?: Record<string, { paths: string[]; kind: "upstream-response" }>;
};
export type VideoUsageReceipt = {
    id: string;
    attemptNo: number;
    channelId?: string;
    upstreamTaskId: string;
    requestedModel: string;
    logicalModel: string;
    observedAt: string;
    pointsRecordId?: string;
    observation: VideoUsageObservation | HailuoObservation;
};
const object = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** Preserve the provider's seconds and image counts; neither tokens nor requested duration replace missing usage. */
export function inspectMinimaxVideoUsage(payload: unknown, expectedTaskId: string, requestedModel: string): VideoUsageObservation {
    const body = object(payload);
    const task = object(body.task);
    const usage = object(task.usage);
    const inventory = inspectUsageFields(usage, ["total_seconds", "input_seconds", "output_seconds", "input_image_count", "input_audio_seconds", "total_tokens"]);
    const observation: VideoUsageObservation = {
        protocol: "minimax-video-v2",
        quantities: {},
        missing: [],
        invalid: inventory.unmapped.length ? [`未解释的视频用量字段：${inventory.unmapped.join("、")}`] : [],
        hasResult: false,
        usageFields: inventory.fields,
        unmappedUsageFields: inventory.unmapped,
        meterSources: {},
    };
    for (const [field, target] of [
        ["id", "upstreamTaskId"],
        ["model", "reportedModel"],
        ["status", "status"],
        ["resolution", "resolution"],
        ["task_type", "taskType"],
        ["modality", "modality"],
    ] as const) {
        if (typeof task[field] === "string" && task[field].trim()) observation[target] = task[field];
        else observation.missing.push(`task.${field}`);
    }
    if (observation.upstreamTaskId && observation.upstreamTaskId !== expectedTaskId) observation.invalid.push("响应不属于原上游任务");
    if (observation.reportedModel && observation.reportedModel !== requestedModel) observation.invalid.push("响应型号与原请求不一致");
    if (body.error || task.error) observation.invalid.push("上游响应包含错误");
    for (const [field, target] of [
        ["total_seconds", "totalSeconds"],
        ["input_seconds", "inputSeconds"],
        ["output_seconds", "outputSeconds"],
        ["input_image_count", "inputImageCount"],
        ["input_audio_seconds", "inputAudioSeconds"],
    ] as const) {
        const value = usage[field];
        if (typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isSafeInteger(Math.ceil(value)) && (field !== "input_image_count" || Number.isSafeInteger(value))) {
            observation.quantities[target] = String(value);
            observation.meterSources![target] = { paths: [`task.usage.${field}`], kind: "upstream-response" };
        } else {
            observation.missing.push(`task.usage.${field}`);
            if (value !== undefined && value !== null) observation.invalid.push(`task.usage.${field} 不是有效的非负${field === "input_image_count" ? "整数" : "数值"}`);
        }
    }
    try {
        const url = new URL(String(object(task.content).url));
        observation.hasResult = ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
    } catch {
        /* Absence of a result is a fact, not a zero charge. */
    }
    return observation;
}

/** Match only the provider's verified query route and the original exact model. */
export function videoObservationProtocol(task: VideoTask, queryPath: string) {
    if (task.config.advancedConfig?.protocol !== "minimax") return null;
    if (["MiniMax-H3", "MiniMax-H3-Max"].includes(task.config.model) && queryPath === `/v2/query/video_generation/${encodeURIComponent(task.upstream.id)}`) return "minimax-video-v2" as const;
    if ((HAILUO_PRICE_MODELS as readonly string[]).includes(task.config.model) && queryPath === `/v1/query/video_generation?task_id=${encodeURIComponent(task.upstream.id)}`) return "minimax-hailuo-v1" as const;
    return null;
}

export function isTerminalVideoObservation(observation: VideoUsageObservation | HailuoObservation) {
    return (observation.protocol === "minimax-hailuo-v1" ? ["Success", "Fail"] : ["succeeded", "failed", "cancelled"]).includes(observation.status || "");
}

/** A failed diagnostic write must never cause another paid generation or change polling results. */
export async function observeVideoTaskUsage(task: VideoTask, payload: unknown, queryPath: string) {
    const protocol = videoObservationProtocol(task, queryPath);
    if (!task.id || !protocol) return;
    try {
        const observation = protocol === "minimax-hailuo-v1" ? inspectHailuoObservation(payload, task.upstream.id) : inspectMinimaxVideoUsage(payload, task.upstream.id, task.config.model);
        if (!isTerminalVideoObservation(observation)) return;
        const receipt: VideoUsageReceipt = {
            id: randomUUID(),
            attemptNo: task.attempts?.at(-1)?.attemptNo || 1,
            channelId: task.config.channelId,
            upstreamTaskId: task.upstream.id,
            requestedModel: task.config.model,
            logicalModel: generationModelId(task.config),
            observedAt: new Date().toISOString(),
            ...(task.upstream.pointsRecordId ? { pointsRecordId: task.upstream.pointsRecordId } : {}),
            observation,
        };
        await mutateStoredGenerationTask<VideoTask>("video", task.id, GENERATION_TASK_RETENTION_MS, (current) => {
            if (current.userId !== task.userId) throw new Error("视频用量身份不匹配");
            const existing = current.usageObservations || [];
            if (
                existing.some(
                    (item) =>
                        item.attemptNo === receipt.attemptNo && item.channelId === receipt.channelId && item.upstreamTaskId === receipt.upstreamTaskId && item.requestedModel === receipt.requestedModel && isDeepStrictEqual(item.observation, observation),
                )
            )
                return null;
            return { ...current, usageObservations: [...existing, receipt] };
        });
    } catch (error) {
        console.error("Video usage observation unavailable", { taskId: task.id, errorType: error instanceof Error ? error.name : "unknown" });
    }
}
