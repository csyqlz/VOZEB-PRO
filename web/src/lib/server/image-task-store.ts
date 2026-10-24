import { assertImageObservationSupplement, type PricingSubmissionReview } from "./model-pricing-submission-review";
import { isDeepStrictEqual } from "node:util";
import { PricingConflictError, PricingInputError } from "@/lib/model-pricing";
import { generationModelId } from "./generation-channel";
import type { QueryExecutor } from "./database";
import { randomUUID } from "crypto";

import type { LogicalModelCapabilityProfile, SystemChannelAdvancedConfig } from "@/lib/auth/store";
import { startGenerationAttempt, type GenerationAttempt } from "@/lib/server/generation-attempt";
import type { GenerationLogSource } from "@/lib/server/generation-log-store";
import { countActiveStoredGenerationTasks, createStoredGenerationTask, getStoredGenerationTask, mutateStoredGenerationTask, touchStoredGenerationTask, transitionStoredGenerationTask, type GenerationTaskContext } from "@/lib/server/generation-task-store";
import { GENERATION_TASK_RETENTION_MS } from "@/lib/server/generation-task-retention";

import type { ImageUsageReceipt, ImageUsageObservation } from "./model-pricing-image-usage";

export type ImageTaskPreparationStop = { id: string; reviewedBy: string; reviewedAt: string; evidence: string };
export type ImageTaskBillingRequest = {
    attemptNo: number;
    requestId: string;
    requestFingerprint: string;
    businessRequestId: string;
    channelId: string;
    logicalModel: string;
    upstreamModel: string;
    preparation?: { id: string; phase: "preparing" | "finished" };
    preparationStop?: ImageTaskPreparationStop;
    review?: { decision: PricingSubmissionReview<ImageUsageObservation>; results?: StoredImageTaskMediaResult[] };
};

type ImageTaskKind = "generation" | "edit";
type ImageTaskStatus = "pending" | "running" | "success" | "error" | "cancelled";

export type ImageTaskConfig = {
    apiSource?: "system" | "custom";
    baseUrl: string;
    apiKey: string;
    apiFormat: "openai" | "gemini";
    model: string;
    channelId?: string;
    logicalModel?: string;
    capabilityProfile?: LogicalModelCapabilityProfile;
    quality?: string;
    size?: string;
    outputBackground?: "opaque" | "transparent";
    outputMode?: "layers";
    systemPrompt?: string;
    advancedConfig?: SystemChannelAdvancedConfig;
};

export type ImageTaskReference = {
    id?: string;
    name?: string;
    type?: string;
    dataUrl: string;
    url?: string;
    remoteUrl?: string;
    serverUrl?: string;
};

export type StoredImageTaskMediaResult = {
    dataUrl: string;
    remoteUrl?: string;
    serverUrl?: string;
    width?: number;
    height?: number;
    sourceWidth?: number;
    sourceHeight?: number;
    bytes?: number;
    mimeType?: string;
};

export type ImageTask = GenerationTaskContext & {
    id: string;
    userId: string;
    username: string;
    displayName: string;
    kind: ImageTaskKind;
    source: GenerationLogSource;
    title?: string;
    status: ImageTaskStatus;
    createdAt: number;
    updatedAt: number;
    config: ImageTaskConfig;
    prompt: string;
    references: ImageTaskReference[];
    mask?: ImageTaskReference;
    result?: StoredImageTaskMediaResult & { results?: StoredImageTaskMediaResult[] };
    upstream?: { id: string; mediaBaseUrl: string; pollBaseUrl: string; explicitPollUrl?: string };
    billing?: { pointsCost: number; pointsRecordId?: string; refunded: boolean };
    // Internal only; public creation never accepts a billing mode.
    billingMode?: "official-usage";
    billingApproval?: import("@/lib/model-pricing").ModelPricingApproval;
    billingPending?: boolean;
    billingRequests?: ImageTaskBillingRequest[];
    pricedResponses?: Array<{ requestId: string; results: StoredImageTaskMediaResult[]; observation: ImageUsageObservation }>;
    // Private diagnostic facts; not a bill or a public generation result.
    usageObservations?: ImageUsageReceipt[];
    error?: string;
    retryable?: boolean;
    pointsRemaining?: number;
    candidateConfigs?: ImageTaskConfig[];
    attempts?: GenerationAttempt[];
    attemptNo?: number;
};

const TASK_STALE_MS = 3 * 60 * 1000;
export async function createImageTask(input: Omit<ImageTask, "id" | "status" | "createdAt" | "updatedAt">) {
    const now = Date.now();
    const task: ImageTask = {
        ...input,
        id: randomUUID(),
        status: "pending",
        createdAt: now,
        updatedAt: now,
    };
    return createStoredGenerationTask("image", task, GENERATION_TASK_RETENTION_MS);
}

export async function getImageTask(id: string, executor?: QueryExecutor) {
    return getStoredGenerationTask<ImageTask>("image", id, executor);
}

export function countActiveImageTasksForUser(userId: string) {
    return countActiveStoredGenerationTasks(userId, "image", TASK_STALE_MS);
}

export function transitionImageTask(
    task: ImageTask,
    allowedStatuses: ImageTaskStatus[],
    patch: Partial<Pick<ImageTask, "result" | "error" | "pointsRemaining" | "retryable" | "config" | "billing" | "billingPending">> & { status: ImageTaskStatus },
    executionPatch?: import("@/lib/server/generation-task-scheduler").GenerationTaskSchedulePatch,
) {
    return transitionStoredGenerationTask<ImageTask>("image", task.id, task.userId, allowedStatuses, patch, GENERATION_TASK_RETENTION_MS, executionPatch);
}

export function touchImageTask(id: string) {
    return touchStoredGenerationTask("image", id, Date.now(), GENERATION_TASK_RETENTION_MS);
}

export async function updateImageTask(id: string, patch: Partial<Pick<ImageTask, "config" | "candidateConfigs" | "attempts" | "attemptNo" | "upstream" | "billing" | "result" | "retryable">>, expectedAttemptNo?: number) {
    return mutateStoredGenerationTask<ImageTask>("image", id, GENERATION_TASK_RETENTION_MS, (task) => {
        if (
            expectedAttemptNo !== undefined &&
            (task.billingMode !== "official-usage" || task.status !== "running" || (task.attemptNo || 0) !== expectedAttemptNo || (patch.config && task.billingRequests?.some((item) => item.attemptNo === expectedAttemptNo)))
        )
            throw new PricingConflictError("原图片尝试已变化或已绑定计费，不能覆盖执行状态");
        return { ...task, ...patch };
    });
}

/** Advance only a durably failed, accounted attempt; candidate selection stays under the task lock. */
export async function advancePricedImageTask(id: string, expectedFailedAttempt: number) {
    return mutateStoredGenerationTask<ImageTask>("image", id, GENERATION_TASK_RETENTION_MS, (task) => {
        const reference = task.billingRequests?.find((item) => item.attemptNo === expectedFailedAttempt);
        const config = task.candidateConfigs?.[0];
        if (
            task.billingMode !== "official-usage" ||
            task.status !== "running" ||
            task.attemptNo !== expectedFailedAttempt ||
            task.billingPending ||
            reference?.review ||
            reference?.preparationStop ||
            task.attempts?.find((item) => item.attemptNo === expectedFailedAttempt)?.status !== "failed" ||
            !config
        )
            throw new PricingConflictError("原图片尝试尚未结束或已有处理决定，不能切换备用渠道");
        const started = startGenerationAttempt(task.attempts || [], { channelId: config.channelId, model: generationModelId(config), capability: "image" });
        return { ...task, config, candidateConfigs: task.candidateConfigs!.slice(1), attempts: started.attempts, attemptNo: started.attempt.attemptNo, upstream: undefined, billing: undefined };
    });
}

/** Bind the proxy's accounting identity before any balance mutation or upstream submission. */
export async function bindImageTaskBillingRequest(input: Omit<ImageTaskBillingRequest, "preparation"> & { taskId: string; userId: string }) {
    if (!input.taskId?.trim() || !input.userId?.trim() || !Number.isSafeInteger(input.attemptNo) || input.attemptNo < 1 || !/^system-ai:[a-f0-9]{64}$/.test(input.requestId) || !/^[a-f0-9]{64}$/.test(input.requestFingerprint))
        throw new PricingInputError("图片任务计费关联无效");
    const { taskId, userId, ...reference } = input;
    const task = await mutateStoredGenerationTask<ImageTask>("image", taskId, GENERATION_TASK_RETENTION_MS, (current) => {
        if (current.userId !== userId) throw new PricingInputError("图片任务不存在或无权访问");
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
            throw new PricingConflictError("图片任务的调用状态或模型已变化");
        const existing = current.billingRequests?.find((item) => item.attemptNo === input.attemptNo);
        if (existing) {
            if (Object.entries(reference).some(([key, value]) => existing[key as keyof ImageTaskBillingRequest] !== value)) throw new PricingConflictError("同一图片任务尝试对应不同计费请求");
            return current.billingMode === "official-usage" ? { ...current, billingPending: true } : current;
        }
        return { ...current, ...(current.billingMode === "official-usage" ? { billingPending: true } : {}), billingRequests: [...(current.billingRequests || []), reference] };
    });
    if (!task) throw new PricingInputError("图片任务不存在或已过期");
    return task;
}

/** One durable owner for preflight as well as submission; a duplicate cannot race a no-charge cleanup. */
export async function claimImageTaskBillingPreparation(input: { taskId: string; userId: string; requestId: string; requestFingerprint: string }) {
    let claimId: string | undefined;
    const task = await mutateStoredGenerationTask<ImageTask>("image", input.taskId, GENERATION_TASK_RETENTION_MS, (current) => {
        const reference = current.billingRequests?.find((item) => item.attemptNo === current.attemptNo);
        if (current.userId !== input.userId || current.billingMode !== "official-usage" || current.status !== "running" || reference?.requestId !== input.requestId || reference.requestFingerprint !== input.requestFingerprint)
            throw new PricingConflictError("图片计费准备状态已变化");
        if (reference.preparationStop) throw new PricingConflictError("原图片计费准备已撤销");
        if (reference.preparation) return current;
        claimId = randomUUID();
        return { ...current, billingPending: true, billingRequests: current.billingRequests!.map((item) => (item === reference ? { ...item, preparation: { id: claimId!, phase: "preparing" as const } } : item)) };
    });
    if (!task) throw new PricingInputError("图片计费任务不存在或已过期");
    return claimId;
}

export async function finishImageTaskBillingPreparation(input: { taskId: string; userId: string; requestId: string; claimId: string }) {
    const task = await mutateStoredGenerationTask<ImageTask>("image", input.taskId, GENERATION_TASK_RETENTION_MS, (current) => {
        const reference = current.billingRequests?.find((item) => item.requestId === input.requestId);
        if (current.userId !== input.userId || reference?.preparation?.id !== input.claimId || reference.preparationStop) throw new PricingConflictError("图片计费准备凭据不匹配");
        return { ...current, billingRequests: current.billingRequests!.map((item) => (item === reference ? { ...item, preparation: { id: input.claimId, phase: "finished" as const } } : item)) };
    });
    if (!task) throw new PricingInputError("图片计费任务不存在或已过期");
}

/** Called inside the wallet lock, which also gates late reservation and submission. */
export async function stopImageTaskBillingPreparation(input: { taskId: string; userId: string; attemptNo: number; requestId: string; requestFingerprint: string; stop: ImageTaskPreparationStop }, executor?: QueryExecutor) {
    const task = await mutateStoredGenerationTask<ImageTask>(
        "image",
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
            if (!current.billingPending || current.status === "success" || reference.review || current.pricedResponses?.some((item) => item.requestId === reference.requestId)) throw new PricingConflictError("原计费请求已有结果或处理决定，不能撤销准备");
            return { ...current, billingRequests: current.billingRequests!.map((item) => (item === reference ? { ...item, preparationStop: input.stop } : item)) };
        },
        executor,
    );
    if (!task) throw new PricingInputError("原计费任务不存在或已过期");
    return task.billingRequests!.find((item) => item.attemptNo === input.attemptNo)!.preparationStop!;
}

/** Only the coordinator with a confirmed no-charge/refund outcome can unpin a failed attempt. */
export async function finishImageTaskBilling(input: { taskId: string; userId: string; requestId: string; requestFingerprint: string }) {
    return mutateStoredGenerationTask<ImageTask>("image", input.taskId, GENERATION_TASK_RETENTION_MS, (current) => {
        if (current.userId !== input.userId || current.billingMode !== "official-usage") throw new PricingInputError("图片计费任务不存在或无权访问");
        const reference = current.billingRequests?.find((item) => item.attemptNo === current.attemptNo);
        if (reference?.requestId !== input.requestId || reference.requestFingerprint !== input.requestFingerprint) throw new PricingConflictError("不能解除其他图片尝试的账务保留");
        return { ...current, billingPending: false };
    });
}

export async function savePricedImageTaskResponse(input: { taskId: string; userId: string; requestId: string; requestFingerprint: string; results: StoredImageTaskMediaResult[]; observation: ImageUsageObservation }) {
    const task = await mutateStoredGenerationTask<ImageTask>("image", input.taskId, GENERATION_TASK_RETENTION_MS, (current) => {
        if (current.userId !== input.userId || current.billingMode !== "official-usage") throw new PricingInputError("图片计费任务不存在或无权访问");
        const reference = current.billingRequests?.find((item) => item.attemptNo === current.attemptNo);
        if (reference?.requestId !== input.requestId || reference.requestFingerprint !== input.requestFingerprint) throw new PricingConflictError("图片响应不属于当前计费尝试");
        if (reference.preparationStop || reference.review) throw new PricingConflictError("该尝试已有人工核对凭据，迟到响应不能覆盖");
        const pricedResponse = { requestId: input.requestId, results: input.results, observation: input.observation };
        const existing = current.pricedResponses?.find((item) => item.requestId === input.requestId);
        if (existing && !isDeepStrictEqual(existing, pricedResponse)) throw new PricingConflictError("已保存的图片计费响应不能改写");
        return existing ? current : { ...current, pricedResponses: [...(current.pricedResponses || []), pricedResponse] };
    });
    if (!task) throw new PricingInputError("图片计费任务不存在或已过期");
    return task;
}

/** Serialize review against response persistence and retain the decision before touching the wallet. */
export async function saveImageTaskBillingReview(input: {
    taskId: string;
    userId: string;
    attemptNo: number;
    requestId: string;
    requestFingerprint: string;
    expectedResponse?: NonNullable<ImageTask["pricedResponses"]>[number];
    review: NonNullable<ImageTaskBillingRequest["review"]>;
}) {
    const task = await mutateStoredGenerationTask<ImageTask>("image", input.taskId, GENERATION_TASK_RETENTION_MS, (current) => {
        const reference = current.billingRequests?.find((item) => item.attemptNo === current.attemptNo);
        if (current.userId !== input.userId || current.billingMode !== "official-usage" || current.attemptNo !== input.attemptNo || reference?.requestId !== input.requestId || reference.requestFingerprint !== input.requestFingerprint)
            throw new PricingConflictError("任务计费尝试已变化，请刷新后核对");
        const review = input.review;
        if (reference.review) {
            const comparable = (value: NonNullable<typeof input.review>) => ({ ...value, decision: { ...value.decision, id: undefined, reviewedAt: undefined } });
            if (!isDeepStrictEqual(comparable(reference.review), comparable(review))) throw new PricingConflictError("同一尝试的人工核对依据不能改写");
            return current;
        }
        if (!current.billingPending || current.status === "success" || reference.preparationStop || reference.preparation?.phase !== "finished") throw new PricingConflictError("任务账务状态已变化或计费准备尚未结束");
        const response = current.pricedResponses?.find((item) => item.requestId === reference.requestId);
        if (!isDeepStrictEqual(response, input.expectedResponse)) throw new PricingConflictError("原响应已变化，请刷新后重新核对");
        if (review.decision.outcome.kind === "not_charged" && response) throw new PricingConflictError("已有响应凭据，不能确认未计费");
        if (review.decision.outcome.kind === "response") {
            assertImageObservationSupplement(response?.observation, review.decision.outcome.observation, review.decision.outcome.correctedObservation);
            if (response?.results.length && !isDeepStrictEqual(response.results, review.results)) throw new PricingConflictError("补录响应不能改写原公开结果");
        }
        return { ...current, billingRequests: current.billingRequests!.map((item) => (item === reference ? { ...item, review } : item)) };
    });
    if (!task) throw new PricingInputError("图片计费任务不存在或已过期");
    return task;
}
