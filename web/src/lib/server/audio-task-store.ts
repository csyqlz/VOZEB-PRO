import { PricingConflictError, PricingInputError } from "@/lib/model-pricing";
import { generationModelId } from "./generation-channel";
import type { QueryExecutor } from "./database";
import { randomUUID } from "node:crypto";
import { createStoredGenerationTask, getStoredGenerationTask, mutateStoredGenerationTask, touchStoredGenerationTask, transitionStoredGenerationTask, type GenerationTaskContext } from "@/lib/server/generation-task-store";
import type { LogicalModelCapabilityProfile, SystemChannelAdvancedConfig } from "@/lib/auth/store";
import type { GenerationAttempt } from "@/lib/server/generation-attempt";
import { GENERATION_TASK_RETENTION_MS } from "@/lib/server/generation-task-retention";
import type { AudioUsageReceipt } from "./model-pricing-audio-usage";

export type AudioTaskPreparationStop = { id: string; reviewedBy: string; reviewedAt: string; evidence: string };
export type AudioTaskBillingRequest = {
    attemptNo: number;
    requestId: string;
    requestFingerprint: string;
    businessRequestId: string;
    channelId: string;
    logicalModel: string;
    upstreamModel: string;
    preparation?: { id: string; phase: "preparing" | "finished" };
    preparationStop?: AudioTaskPreparationStop;
};

export type AudioTaskConfig = {
    apiSource?: "system" | "custom";
    baseUrl: string;
    apiKey: string;
    apiFormat: "openai" | "gemini";
    model: string;
    channelId?: string;
    logicalModel?: string;
    capabilityProfile?: LogicalModelCapabilityProfile;
    advancedConfig?: SystemChannelAdvancedConfig;
    voice?: string;
    format?: string;
    speed?: string;
    instructions?: string;
};
export type AudioTask = GenerationTaskContext & {
    id: string;
    userId: string;
    status: "pending" | "running" | "success" | "error" | "cancelled";
    createdAt: number;
    updatedAt: number;
    config: AudioTaskConfig;
    prompt: string;
    source?: string;
    upstream?: { id: string; createPath: string };
    result?: { url: string; mimeType: string };
    billing?: { pointsCost: number; pointsRecordId?: string; refunded: boolean };
    error?: string;
    candidateConfigs?: AudioTaskConfig[];
    attempts?: GenerationAttempt[];
    attemptNo?: number;
    usageObservations?: AudioUsageReceipt[];
    // Internal only; public creation does not accept these accounting fields.
    billingMode?: "official-usage";
    billingApproval?: import("@/lib/model-pricing").ModelPricingApproval;
    billingPending?: boolean;
    billingRequests?: AudioTaskBillingRequest[];
};

export function createAudioTask(input: Omit<AudioTask, "id" | "status" | "createdAt" | "updatedAt">) {
    const now = Date.now();
    return createStoredGenerationTask("audio", { ...input, id: randomUUID(), status: "pending", createdAt: now, updatedAt: now } satisfies AudioTask, GENERATION_TASK_RETENTION_MS);
}

export async function getAudioTask(id: string, executor?: QueryExecutor) {
    return getStoredGenerationTask<AudioTask>("audio", id, executor);
}

export async function updateAudioTask(id: string, patch: Partial<Pick<AudioTask, "status" | "config" | "upstream" | "result" | "billing" | "error" | "candidateConfigs" | "attempts" | "attemptNo">>, expectedAttemptNo?: number) {
    return mutateStoredGenerationTask<AudioTask>("audio", id, GENERATION_TASK_RETENTION_MS, (task) => {
        if (
            expectedAttemptNo !== undefined &&
            (task.billingMode !== "official-usage" || task.status !== "running" || (task.attemptNo || 0) !== expectedAttemptNo || (patch.config && task.billingRequests?.some((item) => item.attemptNo === expectedAttemptNo)))
        )
            throw new PricingConflictError("原音频尝试已变化或已绑定计费，不能覆盖执行状态");
        return { ...task, ...patch };
    });
}

export function transitionAudioTask(
    task: AudioTask,
    allowedStatuses: Array<AudioTask["status"]>,
    patch: Partial<Pick<AudioTask, "config" | "upstream" | "result" | "billing" | "error" | "billingPending">> & { status: AudioTask["status"] },
    executionPatch?: import("@/lib/server/generation-task-scheduler").GenerationTaskSchedulePatch,
) {
    return transitionStoredGenerationTask<AudioTask>("audio", task.id, task.userId, allowedStatuses, patch, GENERATION_TASK_RETENTION_MS, executionPatch);
}

export function touchAudioTask(id: string) {
    return touchStoredGenerationTask("audio", id, Date.now(), GENERATION_TASK_RETENTION_MS);
}

/** Bind the proxy's accounting identity before any balance mutation or upstream submission. */
export async function bindAudioTaskBillingRequest(input: Omit<AudioTaskBillingRequest, "preparation" | "preparationStop"> & { taskId: string; userId: string }) {
    if (!input.taskId?.trim() || !input.userId?.trim() || !Number.isSafeInteger(input.attemptNo) || input.attemptNo < 1 || !/^system-ai:[a-f0-9]{64}$/.test(input.requestId) || !/^[a-f0-9]{64}$/.test(input.requestFingerprint))
        throw new PricingInputError("音频任务计费关联无效");
    const { taskId, userId, ...reference } = input;
    const task = await mutateStoredGenerationTask<AudioTask>("audio", taskId, GENERATION_TASK_RETENTION_MS, (current) => {
        if (current.userId !== userId) throw new PricingInputError("音频任务不存在或无权访问");
        const attempt = current.attempts?.find((item) => item.attemptNo === input.attemptNo);
        if (
            current.status !== "running" ||
            current.attemptNo !== input.attemptNo ||
            attempt?.status !== "running" ||
            current.config.channelId !== input.channelId ||
            current.config.model !== input.upstreamModel ||
            generationModelId(current.config) !== input.logicalModel ||
            attempt.channelId !== input.channelId ||
            attempt.model !== input.logicalModel
        )
            throw new PricingConflictError("音频任务的调用状态或模型已变化");
        const existing = current.billingRequests?.find((item) => item.attemptNo === input.attemptNo);
        if (existing) {
            if (Object.entries(reference).some(([key, value]) => existing[key as keyof AudioTaskBillingRequest] !== value)) throw new PricingConflictError("同一音频任务尝试对应不同计费请求");
            return current.billingMode === "official-usage" ? { ...current, billingPending: true } : current;
        }
        return { ...current, ...(current.billingMode === "official-usage" ? { billingPending: true } : {}), billingRequests: [...(current.billingRequests || []), reference] };
    });
    if (!task) throw new PricingInputError("音频任务不存在或已过期");
    return task;
}

/** One durable owner for preflight as well as submission; a duplicate cannot race a no-charge cleanup. */
export async function claimAudioTaskBillingPreparation(input: { taskId: string; userId: string; requestId: string; requestFingerprint: string }) {
    let claimId: string | undefined;
    const task = await mutateStoredGenerationTask<AudioTask>("audio", input.taskId, GENERATION_TASK_RETENTION_MS, (current) => {
        const reference = current.billingRequests?.find((item) => item.attemptNo === current.attemptNo);
        if (current.userId !== input.userId || current.billingMode !== "official-usage" || current.status !== "running" || reference?.requestId !== input.requestId || reference.requestFingerprint !== input.requestFingerprint)
            throw new PricingConflictError("音频计费准备状态已变化");
        if (reference.preparationStop) throw new PricingConflictError("原音频准备已撤销");
        if (reference.preparation) return current;
        claimId = randomUUID();
        return { ...current, billingPending: true, billingRequests: current.billingRequests!.map((item) => (item === reference ? { ...item, preparation: { id: claimId!, phase: "preparing" as const } } : item)) };
    });
    if (!task) throw new PricingInputError("音频计费任务不存在或已过期");
    return claimId;
}

export async function finishAudioTaskBillingPreparation(input: { taskId: string; userId: string; requestId: string; claimId: string }) {
    const task = await mutateStoredGenerationTask<AudioTask>("audio", input.taskId, GENERATION_TASK_RETENTION_MS, (current) => {
        const reference = current.billingRequests?.find((item) => item.requestId === input.requestId);
        if (current.userId !== input.userId || reference?.preparation?.id !== input.claimId) throw new PricingConflictError("音频计费准备凭据不匹配");
        return { ...current, billingRequests: current.billingRequests!.map((item) => (item === reference ? { ...item, preparation: { id: input.claimId, phase: "finished" as const } } : item)) };
    });
    if (!task) throw new PricingInputError("音频计费任务不存在或已过期");
}

/** Only the coordinator with a confirmed no-charge/refund outcome can unpin a failed attempt. */
export async function finishAudioTaskBilling(input: { taskId: string; userId: string; requestId: string; requestFingerprint: string }) {
    return mutateStoredGenerationTask<AudioTask>("audio", input.taskId, GENERATION_TASK_RETENTION_MS, (current) => {
        if (current.userId !== input.userId || current.billingMode !== "official-usage") throw new PricingInputError("音频计费任务不存在或无权访问");
        const reference = current.billingRequests?.find((item) => item.attemptNo === current.attemptNo);
        if (reference?.requestId !== input.requestId || reference.requestFingerprint !== input.requestFingerprint) throw new PricingConflictError("不能解除其他音频尝试的账务保留");
        return { ...current, billingPending: false };
    });
}

/** Called inside the wallet lock, which also gates late reservation and submission. */
export async function stopAudioTaskBillingPreparation(input: { taskId: string; userId: string; attemptNo: number; requestId: string; requestFingerprint: string; stop: AudioTaskPreparationStop }, executor?: QueryExecutor) {
    const task = await mutateStoredGenerationTask<AudioTask>(
        "audio",
        input.taskId,
        GENERATION_TASK_RETENTION_MS,
        (current) => {
            const reference = current.billingRequests?.find((item) => item.attemptNo === current.attemptNo);
            if (current.userId !== input.userId || current.billingMode !== "official-usage" || current.attemptNo !== input.attemptNo || reference?.requestId !== input.requestId || reference.requestFingerprint !== input.requestFingerprint)
                throw new PricingConflictError("原计费准备身份已变化");
            if (reference.preparationStop) {
                if (reference.preparationStop.reviewedBy !== input.stop.reviewedBy || reference.preparationStop.evidence !== input.stop.evidence) throw new PricingConflictError("原准备撤销依据不能改写");
                return current;
            }
            if (!current.billingPending || current.status === "success") throw new PricingConflictError("原计费请求已有结果或处理决定，不能撤销准备");
            return { ...current, billingRequests: current.billingRequests!.map((item) => (item === reference ? { ...item, preparationStop: input.stop } : item)) };
        },
        executor,
    );
    if (!task) throw new PricingInputError("原计费任务不存在或已过期");
    return task.billingRequests!.find((item) => item.attemptNo === input.attemptNo)!.preparationStop!;
}
