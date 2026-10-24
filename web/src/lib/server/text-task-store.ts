import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { LogicalModelCapabilityProfile, SystemChannelAdvancedConfig } from "@/lib/auth/store";
import type { AiTextMessage } from "@/types/ai";
import { createStoredGenerationTask, getStoredGenerationTask, mutateStoredGenerationTask, touchStoredGenerationTask, transitionStoredGenerationTask, type GenerationTaskContext } from "@/lib/server/generation-task-store";
import type { GenerationAttempt } from "@/lib/server/generation-attempt";
import { GENERATION_TASK_RETENTION_MS } from "@/lib/server/generation-task-retention";
import { PricingConflictError, PricingInputError } from "@/lib/model-pricing";
import { generationModelId } from "@/lib/server/generation-channel";
import type { TokenUsageObservation } from "@/lib/server/model-pricing-token-usage";
import { assertPricingObservationSupplement, type PricingSubmissionReview } from "./model-pricing-submission-review";

import type { QueryExecutor } from "./database";

type TextTaskStatus = "pending" | "running" | "success" | "error" | "cancelled";
export type TextTaskPreparationStop = { id: string; reviewedBy: string; reviewedAt: string; evidence: string };
export type TextTaskBillingRequest = {
    attemptNo: number;
    requestId: string;
    requestFingerprint: string;
    businessRequestId: string;
    channelId: string;
    logicalModel: string;
    upstreamModel: string;
    preparation?: { id: string; phase: "preparing" | "finished" };
    preparationStop?: TextTaskPreparationStop;
    review?: { decision: PricingSubmissionReview; content?: string };
};

export type TextTaskConfig = {
    apiSource?: "system" | "custom";
    baseUrl: string;
    apiKey: string;
    apiFormat: "openai" | "gemini";
    model: string;
    channelId?: string;
    logicalModel?: string;
    capabilityProfile?: LogicalModelCapabilityProfile;
    advancedConfig?: SystemChannelAdvancedConfig;
    systemPrompt?: string;
};

export type TextTask = GenerationTaskContext & {
    id: string;
    userId: string;
    status: TextTaskStatus;
    createdAt: number;
    updatedAt: number;
    config: TextTaskConfig;
    messages: AiTextMessage[];
    result?: { content: string };
    upstream?: { id: string; createPath: string };
    billing?: { pointsCost: number; pointsRecordId?: string; refunded: boolean };
    billingRequests?: TextTaskBillingRequest[];
    // Internal execution mode; the public creation API does not accept this field.
    billingMode?: "official-usage";
    billingApproval?: import("@/lib/model-pricing").ModelPricingApproval;
    directedPricingRuleId?: string;
    billingPending?: boolean;
    billingReviewReason?: string;
    pricedResponses?: Array<{ requestId: string; content: string; observation: TokenUsageObservation }>;
    error?: string;
    pointsRemaining?: number;
    candidateConfigs?: TextTaskConfig[];
    attempts?: GenerationAttempt[];
    attemptNo?: number;
};

export async function createTextTask(input: Omit<TextTask, "id" | "status" | "createdAt" | "updatedAt">) {
    const now = Date.now();
    const task: TextTask = {
        ...input,
        id: randomUUID(),
        status: "pending",
        createdAt: now,
        updatedAt: now,
    };
    return createStoredGenerationTask("text", task, GENERATION_TASK_RETENTION_MS);
}

export async function getTextTask(id: string, executor?: QueryExecutor) {
    return getStoredGenerationTask<TextTask>("text", id, executor);
}

export function transitionTextTask(
    task: TextTask,
    allowedStatuses: TextTaskStatus[],
    patch: Partial<Pick<TextTask, "config" | "messages" | "result" | "error" | "pointsRemaining" | "upstream" | "billing" | "billingPending">> & { status: TextTaskStatus },
    executionPatch?: import("@/lib/server/generation-task-scheduler").GenerationTaskSchedulePatch,
) {
    return transitionStoredGenerationTask<TextTask>("text", task.id, task.userId, allowedStatuses, patch, GENERATION_TASK_RETENTION_MS, executionPatch);
}

export function touchTextTask(id: string) {
    return touchStoredGenerationTask("text", id, Date.now(), GENERATION_TASK_RETENTION_MS);
}

export function updateTextTask(id: string, patch: Partial<Pick<TextTask, "config" | "candidateConfigs" | "attempts" | "attemptNo" | "upstream" | "billing">>, expectedFailedAttempt?: number) {
    return mutateStoredGenerationTask<TextTask>("text", id, GENERATION_TASK_RETENTION_MS, (task) => {
        if (expectedFailedAttempt !== undefined) {
            const reference = task.billingRequests?.find((item) => item.attemptNo === expectedFailedAttempt);
            if (
                task.status !== "running" ||
                task.attemptNo !== expectedFailedAttempt ||
                task.billingPending ||
                reference?.review ||
                reference?.preparationStop ||
                task.attempts?.find((item) => item.attemptNo === expectedFailedAttempt)?.status !== "failed"
            )
                throw new PricingConflictError("原计费尝试尚未结束或已有处理决定，不能切换备用渠道");
        }
        return { ...task, ...patch };
    });
}

/** Bind the proxy's accounting identity before any balance mutation or upstream submission. */
export async function bindTextTaskBillingRequest(input: Omit<TextTaskBillingRequest, "preparation"> & { taskId: string; userId: string }) {
    if (!input.taskId?.trim() || !input.userId?.trim() || !Number.isSafeInteger(input.attemptNo) || input.attemptNo < 1 || !/^system-ai:[a-f0-9]{64}$/.test(input.requestId) || !/^[a-f0-9]{64}$/.test(input.requestFingerprint))
        throw new PricingInputError("文本任务计费关联无效");
    const { taskId, userId, ...reference } = input;
    const task = await mutateStoredGenerationTask<TextTask>("text", taskId, GENERATION_TASK_RETENTION_MS, (current) => {
        if (current.userId !== userId) throw new PricingInputError("文本任务不存在或无权访问");
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
            throw new PricingConflictError("文本任务的调用状态或模型已变化");
        const existing = current.billingRequests?.find((item) => item.attemptNo === input.attemptNo);
        if (existing) {
            if (Object.entries(reference).some(([key, value]) => existing[key as keyof TextTaskBillingRequest] !== value)) throw new PricingConflictError("同一文本任务尝试对应不同计费请求");
            return current.billingMode === "official-usage" ? { ...current, billingPending: true } : current;
        }
        return { ...current, ...(current.billingMode === "official-usage" ? { billingPending: true } : {}), billingRequests: [...(current.billingRequests || []), reference] };
    });
    if (!task) throw new PricingInputError("文本任务不存在或已过期");
    return task;
}

/** One durable owner for preflight as well as submission; a duplicate cannot race a no-charge cleanup. */
export async function claimTextTaskBillingPreparation(input: { taskId: string; userId: string; requestId: string; requestFingerprint: string }) {
    let claimId: string | undefined;
    const task = await mutateStoredGenerationTask<TextTask>("text", input.taskId, GENERATION_TASK_RETENTION_MS, (current) => {
        const reference = current.billingRequests?.find((item) => item.attemptNo === current.attemptNo);
        if (current.userId !== input.userId || current.billingMode !== "official-usage" || current.status !== "running" || reference?.requestId !== input.requestId || reference.requestFingerprint !== input.requestFingerprint)
            throw new PricingConflictError("文本计费准备状态已变化");
        if (reference.preparationStop) throw new PricingConflictError("原计费准备已撤销");
        if (reference.preparation) return current;
        claimId = randomUUID();
        return { ...current, billingPending: true, billingRequests: current.billingRequests!.map((item) => (item === reference ? { ...item, preparation: { id: claimId!, phase: "preparing" as const } } : item)) };
    });
    if (!task) throw new PricingInputError("文本计费任务不存在或已过期");
    return claimId;
}

export async function finishTextTaskBillingPreparation(input: { taskId: string; userId: string; requestId: string; claimId: string }) {
    const task = await mutateStoredGenerationTask<TextTask>("text", input.taskId, GENERATION_TASK_RETENTION_MS, (current) => {
        const reference = current.billingRequests?.find((item) => item.requestId === input.requestId);
        if (current.userId !== input.userId || reference?.preparation?.id !== input.claimId || reference.preparationStop) throw new PricingConflictError("文本计费准备凭据不匹配");
        return { ...current, billingRequests: current.billingRequests!.map((item) => (item === reference ? { ...item, preparation: { id: input.claimId, phase: "finished" as const } } : item)) };
    });
    if (!task) throw new PricingInputError("文本计费任务不存在或已过期");
}

/** Called inside the wallet lock, which also gates late reservation and submission. */
export async function stopTextTaskBillingPreparation(input: { taskId: string; userId: string; attemptNo: number; requestId: string; requestFingerprint: string; stop: TextTaskPreparationStop }, executor?: QueryExecutor) {
    const task = await mutateStoredGenerationTask<TextTask>(
        "text",
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
export async function finishTextTaskBilling(input: { taskId: string; userId: string; requestId: string; requestFingerprint: string }) {
    return mutateStoredGenerationTask<TextTask>("text", input.taskId, GENERATION_TASK_RETENTION_MS, (current) => {
        if (current.userId !== input.userId || current.billingMode !== "official-usage") throw new PricingInputError("文本计费任务不存在或无权访问");
        const reference = current.billingRequests?.find((item) => item.attemptNo === current.attemptNo);
        if (reference?.requestId !== input.requestId || reference.requestFingerprint !== input.requestFingerprint) throw new PricingConflictError("不能解除其他文本尝试的账务保留");
        return { ...current, billingPending: false, billingReviewReason: undefined };
    });
}

export async function markTextTaskBillingReview(input: { taskId: string; userId: string; requestId: string; requestFingerprint: string; reason: string }) {
    return mutateStoredGenerationTask<TextTask>("text", input.taskId, GENERATION_TASK_RETENTION_MS, (current) => {
        const reference = current.billingRequests?.find((item) => item.attemptNo === current.attemptNo);
        if (current.userId !== input.userId || current.billingMode !== "official-usage" || reference?.requestId !== input.requestId || reference.requestFingerprint !== input.requestFingerprint)
            throw new PricingConflictError("不能标记其他文本尝试的账务异常");
        return { ...current, billingPending: true, billingReviewReason: input.reason };
    });
}

export async function savePricedTextTaskResponse(input: { taskId: string; userId: string; requestId: string; requestFingerprint: string; content: string; observation: TokenUsageObservation }) {
    const task = await mutateStoredGenerationTask<TextTask>("text", input.taskId, GENERATION_TASK_RETENTION_MS, (current) => {
        if (current.userId !== input.userId || current.billingMode !== "official-usage") throw new PricingInputError("文本计费任务不存在或无权访问");
        const reference = current.billingRequests?.find((item) => item.attemptNo === current.attemptNo);
        if (reference?.requestId !== input.requestId || reference.requestFingerprint !== input.requestFingerprint) throw new PricingConflictError("文本响应不属于当前计费尝试");
        if (reference.review || reference.preparationStop) throw new PricingConflictError("该尝试已有人工核对凭据，迟到响应不能覆盖");
        const pricedResponse = { requestId: input.requestId, content: input.content, observation: input.observation };
        const existing = current.pricedResponses?.find((item) => item.requestId === input.requestId);
        if (existing && !isDeepStrictEqual(existing, pricedResponse)) throw new PricingConflictError("已保存的文本计费响应不能改写");
        return existing ? current : { ...current, pricedResponses: [...(current.pricedResponses || []), pricedResponse] };
    });
    if (!task) throw new PricingInputError("文本计费任务不存在或已过期");
    return task;
}

/** Serialize review against response persistence and retain the decision before touching the wallet. */
export async function saveTextTaskBillingReview(input: {
    taskId: string;
    userId: string;
    attemptNo: number;
    requestId: string;
    requestFingerprint: string;
    expectedResponse?: NonNullable<TextTask["pricedResponses"]>[number];
    review: NonNullable<TextTaskBillingRequest["review"]>;
}) {
    const task = await mutateStoredGenerationTask<TextTask>("text", input.taskId, GENERATION_TASK_RETENTION_MS, (current) => {
        const reference = current.billingRequests?.find((item) => item.attemptNo === current.attemptNo);
        if (current.userId !== input.userId || current.billingMode !== "official-usage" || current.attemptNo !== input.attemptNo || reference?.requestId !== input.requestId || reference.requestFingerprint !== input.requestFingerprint)
            throw new PricingConflictError("任务计费尝试已变化，请刷新后核对");
        const review = input.review;
        if (reference.review) {
            const comparable = (value: NonNullable<typeof input.review>) => ({ ...value, decision: { ...value.decision, id: undefined, reviewedAt: undefined } });
            if (!isDeepStrictEqual(comparable(reference.review), comparable(review))) throw new PricingConflictError("同一尝试的人工核对依据不能改写");
            return current;
        }
        if (!current.billingPending || reference.preparationStop || reference.preparation?.phase !== "finished") throw new PricingConflictError("任务账务状态已变化或计费准备尚未结束");
        const response = current.pricedResponses?.find((item) => item.requestId === reference.requestId);
        if (!isDeepStrictEqual(response, input.expectedResponse)) throw new PricingConflictError("原响应已变化，请刷新后重新核对");
        if (review.decision.outcome.kind === "not_charged" && response) throw new PricingConflictError("已有响应凭据，不能确认未计费");
        if (review.decision.outcome.kind === "response") {
            assertPricingObservationSupplement(response?.observation, review.decision.outcome.observation, review.decision.outcome.correctedObservation);
            if (response && response.content !== review.content) throw new PricingConflictError("补录响应不能改写原公开结果");
        }
        return { ...current, billingRequests: current.billingRequests!.map((item) => (item === reference ? { ...item, review } : item)) };
    });
    if (!task) throw new PricingInputError("文本计费任务不存在或已过期");
    return task;
}
