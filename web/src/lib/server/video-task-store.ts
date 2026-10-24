import { assertVideoObservationSupplement, type PricingSubmissionReview } from "./model-pricing-submission-review";
import { PricingConflictError, PricingInputError } from "@/lib/model-pricing";
import { generationModelId } from "./generation-channel";
import type { QueryExecutor } from "./database";
import { isDeepStrictEqual } from "node:util";
import { HAILUO_PRICE_MODELS, type HailuoObservation } from "./model-pricing-hailuo-contract";
import type { VideoUsageObservation } from "./model-pricing-video-usage";
import type { VideoUsageReceipt } from "./model-pricing-video-usage";
import { randomUUID } from "node:crypto";

import { createStoredGenerationTask, getStoredGenerationTask, mutateStoredGenerationTask, touchStoredGenerationTask, transitionStoredGenerationTask, type GenerationTaskContext } from "@/lib/server/generation-task-store";
import type { SystemGenerationChannelConfig } from "@/lib/server/generation-channel";
import { startGenerationAttempt, type GenerationAttempt } from "@/lib/server/generation-attempt";
import { GENERATION_TASK_RETENTION_MS } from "@/lib/server/generation-task-retention";

export type VideoTaskPreparationStop = { id: string; reviewedBy: string; reviewedAt: string; evidence: string };
export type VideoTaskBillingRequest = {
    attemptNo: number;
    requestId: string;
    requestFingerprint: string;
    businessRequestId: string;
    channelId: string;
    logicalModel: string;
    upstreamModel: string;
    preparation?: { id: string; phase: "preparing" | "finished" };
    preparationStop?: VideoTaskPreparationStop;
    review?: { decision: PricingSubmissionReview<VideoUsageObservation | HailuoObservation>; resultUrl?: string };
};
export const videoTaskAttemptNo = (task: Pick<VideoTask, "attempts">) => task.attempts?.at(-1)?.attemptNo;

export type VideoTaskStatus = "running" | "success" | "error" | "cancelled";

export type VideoTask = GenerationTaskContext & {
    id: string;
    userId: string;
    username?: string;
    displayName?: string;
    title?: string;
    status: VideoTaskStatus;
    createdAt: number;
    updatedAt: number;
    config: SystemGenerationChannelConfig;
    upstream: { id: string; provider: "openai" | "seedance" | "generation"; model: string; pollPath?: string; queryPath?: string; resultUrl?: string; pointsCost?: number; pointsUnits?: number; pointsRecordId?: string; refunded?: boolean };
    candidateConfigs?: SystemGenerationChannelConfig[];
    creation?: { prompt: string; parameters: Record<string, unknown>; references: import("@/lib/video-reference-contract").VideoGenerationReference[]; businessRequestId: string };
    billingMode?: "official-usage";
    billingApproval?: import("@/lib/model-pricing").ModelPricingApproval;
    billingPending?: boolean;
    billingRequests?: VideoTaskBillingRequest[];
    pricedSubmissions?: Array<{ requestId: string; upstreamTaskId: string; businessStatus?: 0 }>;
    pricedResponses?: Array<{ requestId: string; observation: VideoUsageObservation | HailuoObservation; resultUrl?: string; recovered?: { observation: VideoUsageObservation | HailuoObservation; resultUrl: string } }>;
    // Private provider facts, not a price or a public task field.
    usageObservations?: VideoUsageReceipt[];
    requestedDurationSeconds?: number;
    source?: string;
    prompt?: string;
    attempts?: GenerationAttempt[];
    polling?: { lastAttemptAt?: number; nextAttemptAt?: number };
    result?: { url?: string; remoteUrl?: string; mimeType?: string; durationMs?: number };
    error?: string;
    retryable?: boolean;
};

export async function createVideoTask(input: Omit<VideoTask, "id" | "status" | "createdAt" | "updatedAt">) {
    const now = Date.now();
    return createStoredGenerationTask("video", { ...input, id: randomUUID(), status: "running" as const, createdAt: now, updatedAt: now }, GENERATION_TASK_RETENTION_MS);
}

export async function getVideoTask(id: string, executor?: QueryExecutor) {
    return getStoredGenerationTask<VideoTask>("video", id, executor);
}

export function claimVideoTaskPoll(id: string, intervalMs: number) {
    const now = Date.now();
    return mutateStoredGenerationTask<VideoTask>("video", id, GENERATION_TASK_RETENTION_MS, (task) => {
        if (!canReconcileVideoTask(task) || Number(task.polling?.nextAttemptAt || 0) > now) return null;
        return { ...task, polling: { lastAttemptAt: now, nextAttemptAt: now + Math.max(1_000, intervalMs) } };
    });
}

export function completeReconciledVideoTask(id: string, result: NonNullable<VideoTask["result"]>) {
    return mutateStoredGenerationTask<VideoTask>("video", id, GENERATION_TASK_RETENTION_MS, (task) =>
        canReconcileVideoTask(task) ? { ...task, status: "success", result, error: undefined, retryable: false, ...(task.billingMode === "official-usage" ? { billingPending: false } : {}) } : null,
    );
}

export function failReconciledVideoTask(id: string, error: string, retryable = false) {
    return mutateStoredGenerationTask<VideoTask>("video", id, GENERATION_TASK_RETENTION_MS, (task) => (canReconcileVideoTask(task) ? { ...task, status: "error", result: undefined, error, retryable } : null));
}

export function transitionVideoTask(
    task: VideoTask,
    patch: Partial<Pick<VideoTask, "result" | "error" | "retryable" | "upstream">> & { status: "success" | "error" | "cancelled" },
    executionPatch?: import("@/lib/server/generation-task-scheduler").GenerationTaskSchedulePatch,
) {
    return transitionStoredGenerationTask<VideoTask>("video", task.id, task.userId, ["running"], patch, GENERATION_TASK_RETENTION_MS, executionPatch);
}

export function updateVideoTask(id: string, patch: Partial<Pick<VideoTask, "config" | "candidateConfigs" | "upstream" | "requestedDurationSeconds" | "attempts" | "result" | "billingPending">>, expectedAttemptNo?: number) {
    return mutateStoredGenerationTask<VideoTask>("video", id, GENERATION_TASK_RETENTION_MS, (task) => {
        if (expectedAttemptNo !== undefined && (task.billingMode !== "official-usage" || task.status !== "running" || videoTaskAttemptNo(task) !== expectedAttemptNo)) throw new PricingConflictError("原视频尝试已变化，不能覆盖执行状态");
        return { ...task, ...patch };
    });
}

export function touchVideoTask(id: string) {
    return touchStoredGenerationTask("video", id, Date.now(), GENERATION_TASK_RETENTION_MS);
}

export function canReconcileVideoTask(task: Pick<VideoTask, "status" | "error">) {
    return task.status === "running" || (task.status === "error" && /视频生成超时|视频任务长时间未更新/.test(task.error || ""));
}

export async function bindVideoTaskBillingRequest(input: Omit<VideoTaskBillingRequest, "preparation"> & { taskId: string; userId: string }) {
    if (!input.taskId?.trim() || !input.userId?.trim() || !Number.isSafeInteger(input.attemptNo) || input.attemptNo < 1 || !/^system-ai:[a-f0-9]{64}$/.test(input.requestId) || !/^[a-f0-9]{64}$/.test(input.requestFingerprint))
        throw new PricingInputError("视频任务计费关联无效");
    const { taskId, userId, ...reference } = input;
    const task = await mutateStoredGenerationTask<VideoTask>("video", taskId, GENERATION_TASK_RETENTION_MS, (current) => {
        if (current.userId !== userId) throw new PricingInputError("视频任务不存在或无权访问");
        const attempt = current.attempts?.find((item) => item.attemptNo === input.attemptNo);
        if (
            current.status !== "running" ||
            videoTaskAttemptNo(current) !== input.attemptNo ||
            attempt?.status !== "running" ||
            current.config.channelId !== input.channelId ||
            current.config.model !== input.upstreamModel ||
            generationModelId(current.config) !== input.logicalModel ||
            attempt.channelId !== input.channelId ||
            attempt.model !== input.logicalModel
        )
            throw new PricingConflictError("视频任务的调用状态或模型已变化");
        const existing = current.billingRequests?.find((item) => item.attemptNo === input.attemptNo);
        if (existing) {
            if (Object.entries(reference).some(([key, value]) => existing[key as keyof VideoTaskBillingRequest] !== value)) throw new PricingConflictError("同一视频任务尝试对应不同计费请求");
            return current.billingMode === "official-usage" ? { ...current, billingPending: true } : current;
        }
        return { ...current, ...(current.billingMode === "official-usage" ? { billingPending: true } : {}), billingRequests: [...(current.billingRequests || []), reference] };
    });
    if (!task) throw new PricingInputError("视频任务不存在或已过期");
    return task;
}

/** One durable owner for preflight as well as submission; a duplicate cannot race a no-charge cleanup. */
export async function claimVideoTaskBillingPreparation(input: { taskId: string; userId: string; requestId: string; requestFingerprint: string }) {
    let claimId: string | undefined;
    const task = await mutateStoredGenerationTask<VideoTask>("video", input.taskId, GENERATION_TASK_RETENTION_MS, (current) => {
        const reference = current.billingRequests?.find((item) => item.attemptNo === videoTaskAttemptNo(current));
        if (current.userId !== input.userId || current.billingMode !== "official-usage" || current.status !== "running" || reference?.requestId !== input.requestId || reference.requestFingerprint !== input.requestFingerprint)
            throw new PricingConflictError("视频计费准备状态已变化");
        if (reference.preparationStop || reference.review) throw new PricingConflictError("原视频计费准备已撤销或已有人工决定");
        if (reference.preparation) return current;
        claimId = randomUUID();
        return { ...current, billingPending: true, billingRequests: current.billingRequests!.map((item) => (item === reference ? { ...item, preparation: { id: claimId!, phase: "preparing" as const } } : item)) };
    });
    if (!task) throw new PricingInputError("视频计费任务不存在或已过期");
    return claimId;
}

export async function finishVideoTaskBillingPreparation(input: { taskId: string; userId: string; requestId: string; claimId: string }) {
    const task = await mutateStoredGenerationTask<VideoTask>("video", input.taskId, GENERATION_TASK_RETENTION_MS, (current) => {
        const reference = current.billingRequests?.find((item) => item.requestId === input.requestId);
        if (current.userId !== input.userId || reference?.preparation?.id !== input.claimId || reference.preparationStop) throw new PricingConflictError("视频计费准备凭据不匹配");
        return { ...current, billingRequests: current.billingRequests!.map((item) => (item === reference ? { ...item, preparation: { id: input.claimId, phase: "finished" as const } } : item)) };
    });
    if (!task) throw new PricingInputError("视频计费任务不存在或已过期");
}

/** Called inside the wallet lock, which also gates late reservation and submission. */
export async function stopVideoTaskBillingPreparation(input: { taskId: string; userId: string; attemptNo: number; requestId: string; requestFingerprint: string; stop: VideoTaskPreparationStop }, executor?: QueryExecutor) {
    const task = await mutateStoredGenerationTask<VideoTask>(
        "video",
        input.taskId,
        GENERATION_TASK_RETENTION_MS,
        (current) => {
            const reference = current.billingRequests?.find((item) => item.attemptNo === videoTaskAttemptNo(current));
            if (current.userId !== input.userId || current.billingMode !== "official-usage" || videoTaskAttemptNo(current) !== input.attemptNo || reference?.requestId !== input.requestId || reference.requestFingerprint !== input.requestFingerprint)
                throw new PricingConflictError("原计费准备身份已变化");
            if (reference.preparationStop) {
                if (reference.preparationStop.reviewedBy !== input.stop.reviewedBy || reference.preparationStop.evidence !== input.stop.evidence) throw new PricingConflictError("原准备撤销依据不能改写");
                return current;
            }
            if (!current.billingPending || current.status === "success" || reference.review || current.pricedSubmissions?.some((item) => item.requestId === reference.requestId)) throw new PricingConflictError("原计费请求已有结果或处理决定，不能撤销准备");
            return { ...current, billingRequests: current.billingRequests!.map((item) => (item === reference ? { ...item, preparationStop: input.stop } : item)) };
        },
        executor,
    );
    if (!task) throw new PricingInputError("原计费任务不存在或已过期");
    return task.billingRequests!.find((item) => item.attemptNo === input.attemptNo)!.preparationStop!;
}

/** Only the coordinator with a confirmed no-charge/refund outcome can unpin a failed attempt. */
export async function finishVideoTaskBilling(input: { taskId: string; userId: string; requestId: string; requestFingerprint: string }) {
    return mutateStoredGenerationTask<VideoTask>("video", input.taskId, GENERATION_TASK_RETENTION_MS, (current) => {
        if (current.userId !== input.userId || current.billingMode !== "official-usage") throw new PricingInputError("视频计费任务不存在或无权访问");
        const reference = current.billingRequests?.find((item) => item.attemptNo === videoTaskAttemptNo(current));
        if (reference?.requestId !== input.requestId || reference.requestFingerprint !== input.requestFingerprint) throw new PricingConflictError("不能解除其他视频尝试的账务保留");
        return { ...current, billingPending: false };
    });
}

export async function savePricedVideoTaskSubmission(input: { taskId: string; userId: string; requestId: string; requestFingerprint: string; upstreamTaskId: string; businessStatus?: number }) {
    if (!input.upstreamTaskId.trim()) throw new PricingInputError("缺少原视频上游任务 ID");
    return mutatePricedVideoTask(input, (task) => {
        const existing = task.pricedSubmissions?.find((item) => item.requestId === input.requestId);
        if ((existing && existing.upstreamTaskId !== input.upstreamTaskId) || (task.upstream.id && task.upstream.id !== input.upstreamTaskId)) throw new PricingConflictError("原视频创建身份不能改写");
        const hailuo = (HAILUO_PRICE_MODELS as readonly string[]).includes(task.config.model);
        if (hailuo && input.businessStatus !== 0) throw new PricingInputError("Hailuo 原创建凭据缺少业务成功确认");
        const receipt = { requestId: input.requestId, upstreamTaskId: input.upstreamTaskId, ...(hailuo ? { businessStatus: 0 as const } : {}) };
        if (existing && !isDeepStrictEqual(existing, receipt)) throw new PricingConflictError("原视频创建凭据不能改写");
        return { ...task, upstream: { ...task.upstream, id: input.upstreamTaskId }, pricedSubmissions: existing ? task.pricedSubmissions : [...(task.pricedSubmissions || []), receipt] };
    });
}

export async function savePricedVideoTaskResponse(input: { taskId: string; userId: string; requestId: string; requestFingerprint: string; observation: VideoUsageObservation | HailuoObservation; resultUrl?: string }) {
    return mutatePricedVideoTask(input, (task) => {
        const submission = task.pricedSubmissions?.find((item) => item.requestId === input.requestId);
        if (!submission || submission.upstreamTaskId !== input.observation.upstreamTaskId || submission.upstreamTaskId !== task.upstream.id) throw new PricingConflictError("视频计量不属于原创建任务");
        if (input.observation.protocol === "minimax-hailuo-v1" && submission.businessStatus !== 0) throw new PricingConflictError("Hailuo 终态缺少原创建成功凭据");
        const response = { requestId: input.requestId, observation: input.observation, ...(input.resultUrl ? { resultUrl: input.resultUrl } : {}) };
        const existing = task.pricedResponses?.find((item) => item.requestId === input.requestId);
        if (existing && !isDeepStrictEqual(existing, response)) throw new PricingConflictError("原视频计量与媒体地址不能改写");
        return existing ? task : { ...task, pricedResponses: [...(task.pricedResponses || []), response] };
    });
}

/** Keep the first provider response unchanged while recording a verified later query of the same task. */
export async function savePricedVideoTaskRecoveredResponse(input: { taskId: string; userId: string; requestId: string; requestFingerprint: string; observation: VideoUsageObservation | HailuoObservation; resultUrl: string }) {
    if (!input.resultUrl.trim()) throw new PricingInputError("原视频补全缺少媒体地址");
    return mutatePricedVideoTask(input, (task) => {
        const submission = task.pricedSubmissions?.find((item) => item.requestId === input.requestId);
        const original = task.pricedResponses?.find((item) => item.requestId === input.requestId);
        if (
            !submission ||
            !original ||
            submission.upstreamTaskId !== task.upstream.id ||
            input.observation.upstreamTaskId !== submission.upstreamTaskId ||
            !original.observation.missing.length ||
            original.observation.invalid.length ||
            input.observation.invalid.length ||
            input.observation.missing.length ||
            (original.resultUrl && original.resultUrl !== input.resultUrl)
        )
            throw new PricingConflictError("原视频补全与首次凭据不一致");
        assertVideoObservationSupplement(original.observation, input.observation);
        const recovered = { observation: input.observation, resultUrl: input.resultUrl };
        if (original.recovered && !isDeepStrictEqual(original.recovered, recovered)) throw new PricingConflictError("已核实的原视频补全不能改写");
        if (original.recovered) return task;
        return { ...task, pricedResponses: task.pricedResponses!.map((item) => (item === original ? { ...item, recovered } : item)) };
    });
}

async function mutatePricedVideoTask(input: { taskId: string; userId: string; requestId: string; requestFingerprint: string }, build: (task: VideoTask) => VideoTask) {
    const task = await mutateStoredGenerationTask<VideoTask>("video", input.taskId, GENERATION_TASK_RETENTION_MS, (current) => {
        const reference = current.billingRequests?.find((item) => item.attemptNo === videoTaskAttemptNo(current));
        if (current.userId !== input.userId || current.billingMode !== "official-usage" || reference?.requestId !== input.requestId || reference.requestFingerprint !== input.requestFingerprint || reference.preparationStop || reference.review)
            throw new PricingConflictError("原视频计费身份已变化");
        return build(current);
    });
    if (!task) throw new PricingInputError("视频计费任务不存在或已过期");
    return task;
}

export async function saveVideoTaskBillingReview(input: {
    taskId: string;
    userId: string;
    attemptNo: number;
    requestId: string;
    requestFingerprint: string;
    expectedResponse?: NonNullable<VideoTask["pricedResponses"]>[number];
    expectedSubmission?: NonNullable<VideoTask["pricedSubmissions"]>[number];
    review: NonNullable<VideoTaskBillingRequest["review"]>;
}) {
    const task = await mutateStoredGenerationTask<VideoTask>("video", input.taskId, GENERATION_TASK_RETENTION_MS, (current) => {
        const reference = current.billingRequests?.find((item) => item.attemptNo === videoTaskAttemptNo(current));
        if (current.userId !== input.userId || current.billingMode !== "official-usage" || videoTaskAttemptNo(current) !== input.attemptNo || reference?.requestId !== input.requestId || reference.requestFingerprint !== input.requestFingerprint)
            throw new PricingConflictError("视频计费尝试已变化，请刷新后核对");
        const review = input.review;
        if (reference.review) {
            const comparable = (value: typeof review) => ({ ...value, decision: { ...value.decision, id: undefined, reviewedAt: undefined } });
            if (!isDeepStrictEqual(comparable(reference.review), comparable(review))) throw new PricingConflictError("同一视频尝试的人工核对依据不能改写");
            return current;
        }
        if (!current.billingPending || current.status === "success" || reference.preparationStop || reference.preparation?.phase !== "finished") throw new PricingConflictError("视频账务状态已变化或准备尚未结束");
        const response = current.pricedResponses?.find((item) => item.requestId === reference.requestId);
        if (response?.recovered) throw new PricingConflictError("原视频计量已由上游查询补全，不能再提交人工决定");
        const submission = current.pricedSubmissions?.find((item) => item.requestId === reference.requestId);
        if (!isDeepStrictEqual(response, input.expectedResponse) || !isDeepStrictEqual(submission, input.expectedSubmission)) throw new PricingConflictError("原视频凭据已变化，请刷新后核对");
        if (review.decision.outcome.kind === "not_charged" && response) throw new PricingConflictError("已有视频响应，不能确认未计费");
        if (review.decision.outcome.kind === "response") {
            const { observation, correctedObservation } = review.decision.outcome;
            if (!submission || observation.upstreamTaskId !== submission.upstreamTaskId) throw new PricingConflictError("补录必须属于原创建任务");
            assertVideoObservationSupplement(response?.observation, observation, correctedObservation);
            if (response?.resultUrl && response.resultUrl !== review.resultUrl) throw new PricingConflictError("补录不能改写原视频结果地址");
        }
        return { ...current, billingRequests: current.billingRequests!.map((item) => (item === reference ? { ...item, review } : item)) };
    });
    if (!task) throw new PricingInputError("视频计费任务不存在或已过期");
    return task;
}

/** Freeze the private request before preparation so a worker can continue the same business request. */
export async function saveVideoTaskCreation(id: string, userId: string, creation: NonNullable<VideoTask["creation"]>) {
    const task = await mutateStoredGenerationTask<VideoTask>("video", id, GENERATION_TASK_RETENTION_MS, (current) => {
        if (current.userId !== userId || current.billingMode !== "official-usage") throw new PricingInputError("视频计费任务不存在或无权访问");
        if (current.creation) {
            if (!isDeepStrictEqual(current.creation, creation)) throw new PricingConflictError("原视频请求已变化，计费待核对，不能替换创建参数");
            return current;
        }
        if (current.status !== "running" || current.billingRequests?.length || current.upstream.id) throw new PricingConflictError("原视频已开始计费，缺少创建凭据时须待核对");
        return { ...current, creation };
    });
    if (!task) throw new PricingInputError("视频计费任务不存在或已过期");
    return task;
}

/** Only a durably failed, unsubmitted and accounted attempt may consume its next saved candidate. */
export async function advancePricedVideoTask(id: string, expectedAttemptNo: number) {
    return mutateStoredGenerationTask<VideoTask>("video", id, GENERATION_TASK_RETENTION_MS, (task) => {
        const reference = task.billingRequests?.find((item) => item.attemptNo === expectedAttemptNo);
        const config = task.candidateConfigs?.[0];
        if (
            task.billingMode !== "official-usage" ||
            task.status !== "running" ||
            videoTaskAttemptNo(task) !== expectedAttemptNo ||
            task.billingPending ||
            !task.creation ||
            !config ||
            reference?.review ||
            reference?.preparationStop ||
            reference?.preparation?.phase === "preparing" ||
            task.upstream.id ||
            task.attempts?.at(-1)?.status !== "failed"
        )
            throw new PricingConflictError("原视频尝试尚未结束或已有处理决定，不能切换备用渠道");
        const started = startGenerationAttempt(task.attempts || [], { channelId: config.channelId, model: generationModelId(config), capability: "video" });
        return { ...task, config, candidateConfigs: task.candidateConfigs!.slice(1), attempts: started.attempts, upstream: { id: "", provider: "generation" as const, model: config.model, pollPath: config.advancedConfig?.createPath }, polling: undefined };
    });
}
