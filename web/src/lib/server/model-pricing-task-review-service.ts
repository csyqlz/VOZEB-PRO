import { getAudioPricingTaskReview, reviewAudioPricingTask } from "./model-pricing-audio-task-review";
import { getVideoPricingTaskReview, reviewVideoPricingTask } from "./model-pricing-video-task-review";
import { getImagePricingTaskReview, reviewImagePricingTask } from "./model-pricing-image-task-review";
import { randomUUID } from "node:crypto";
import { PricingConflictError, PricingInputError } from "@/lib/model-pricing";
import { getStoredGenerationTaskRecord } from "./generation-task-store";
import { scheduleGenerationTask } from "./generation-task-scheduler";
import { getTextTask, saveTextTaskBillingReview, type TextTask } from "./text-task-store";
import { recoverPricedTextTaskStep } from "./text-task-runtime";
import { getModelPriceReservation, validateReviewedTextUsage, stopModelPricePreparation } from "./model-pricing-wallet-service";
import { inspectProviderTokenUsage, type TokenUsageObservation } from "./model-pricing-token-usage";
import { completeTextResponse } from "./model-pricing-shadow-call";
import { publicPricedTextContent } from "./model-pricing-text-task";

export type PricingTaskReviewInput =
    | { action: "resume_billing"; attemptNo: number }
    | { action: "stop_preparation"; attemptNo: number; evidence: string }
    | { action: "confirm_no_charge"; attemptNo: number; evidence: string }
    | { action: "provide_metered_result" | "correct_metered_result"; attemptNo: number; evidence: string; response: string; cacheWrite5mTokens?: string; cacheWrite1hTokens?: string };

function hasOnlyMissingCacheWriteTtl(observation?: TokenUsageObservation) {
    return Boolean(observation && !observation.invalid && observation.missing.length && observation.missing.every((field) => field.startsWith("Msh-Usage-Cache-Write-Tokens-")));
}

async function context(id: string) {
    const record = await getStoredGenerationTaskRecord("text", id);
    const task = record?.payload as TextTask | undefined;
    if (!task || task.billingMode !== "official-usage") throw new PricingInputError("按量文本任务不存在");
    const reference = task.billingRequests?.find((item) => item.attemptNo === task.attemptNo);
    if (!reference) throw new PricingConflictError("任务尚无可核对的原计费请求");
    const key = { userId: task.userId, requestId: reference.requestId, requestFingerprint: reference.requestFingerprint };
    const reservation = await getModelPriceReservation(key);
    return { record: record!, task, reference, key, reservation };
}

export async function getPricingTaskReview(id: string, type: "text" | "image" | "video" | "audio" = "text") {
    if (type === "audio") return getAudioPricingTaskReview(id);
    if (type === "video") return getVideoPricingTaskReview(id);
    if (type === "image") return getImagePricingTaskReview(id);
    const { task, reference, reservation } = await context(id);
    const original = task.pricedResponses?.find((item) => item.requestId === reference.requestId);
    const usesCacheWriteTtl = reservation?.frozen.version.manufacturer === "Moonshot" && reservation.frozen.version.sku === "kimi-k3" && reservation.frozen.text?.contract.protocol === "openai-chat";
    return {
        attemptNo: reference.attemptNo,
        model: reference.logicalModel,
        channelId: reference.channelId,
        upstreamModel: reference.upstreamModel,
        pending: Boolean(task.billingPending),
        stage: reservation?.status === "reserved" ? reservation.submission?.phase || "reserved" : reservation?.status || "preparing",
        heldPoints: reservation?.allocation.heldPoints,
        hasSavedResponse: Boolean(original),
        invalidUsage: original?.observation.invalid,
        usesCacheWriteTtl,
        canSupplyCacheWriteTtl: Boolean(usesCacheWriteTtl && hasOnlyMissingCacheWriteTtl(original?.observation)),
        knownCacheWrite5mTokens: original?.observation.quantities.cacheWrite5mTokens,
        knownCacheWrite1hTokens: original?.observation.quantities.cacheWrite1hTokens,
        canReviewSubmission: true,
        canResumeBilling: true,
        canCorrectUsage: Boolean(task.billingPending && original?.observation.invalid && reservation?.submission?.response?.observation.invalid && !reference.review),
        reviewed: Boolean(reference.review || reference.preparationStop),
        canStopPreparation: !reservation?.submission && reservation?.status !== "settled" && !reference.review && !reference.preparationStop && Boolean(task.billingPending),
        officialVersionId: reservation?.frozen.version.id,
        salesVersionId: reservation?.frozen.policy.id,
    };
}

/** No new upstream call: only verified original credentials can settle or release this attempt. */
export async function reviewPricingTask(id: string, raw: unknown, reviewedBy: string, type: "text" | "image" | "video" | "audio" = "text", origin?: string) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PricingInputError("账务核对参数无效");
    const input = raw as PricingTaskReviewInput;
    if (!["resume_billing", "stop_preparation", "confirm_no_charge", "provide_metered_result", "correct_metered_result"].includes(input.action) || !Number.isSafeInteger(input.attemptNo) || input.attemptNo < 1 || !reviewedBy)
        throw new PricingInputError("请选择有效操作及原尝试");
    if (type === "audio") return reviewAudioPricingTask(id, input, reviewedBy, origin);
    if (type === "video") return reviewVideoPricingTask(id, input, reviewedBy, origin);
    if (type === "image") return reviewImagePricingTask(id, input, reviewedBy, origin);
    const { record, task, reference, key, reservation } = await context(id);
    if (input.attemptNo !== reference.attemptNo) throw new PricingConflictError("任务尝试已变化，请重新打开核对窗口");
    if (input.action === "stop_preparation") {
        if (!reference.preparationStop && (record.executionPhase !== "needs_review" || !task.billingPending)) throw new PricingConflictError("当前任务不等待账务核对");
        await stopModelPricePreparation({ ...key, taskId: id, attemptNo: input.attemptNo, reviewedBy, evidence: typeof input.evidence === "string" ? input.evidence : "" });
    } else if (input.action !== "resume_billing") {
        if (!reference.review && (record.executionPhase !== "needs_review" || !task.billingPending)) throw new PricingConflictError("当前任务不等待账务核对");
        if (!reservation?.submission || !reservation.frozen.text || reference.preparation?.phase !== "finished") throw new PricingConflictError("尚无完整的原提交身份，不能据此解除预留或补录结算");
        if (!reference.review && (reservation.status !== "reserved" || reservation.submission.phase === "not_charged")) throw new PricingConflictError("原预留已处理，请恢复已有凭据");
        const evidence = typeof input.evidence === "string" ? input.evidence.trim() : "";
        if (!evidence) throw new PricingInputError("请填写供应商凭据或未计费证明，超时和失败描述不属于计费依据");
        let content: string | undefined;
        const originalResponse = task.pricedResponses?.find((item) => item.requestId === reference.requestId);
        let outcome: import("./model-pricing-submission-review").PricingSubmissionReview["outcome"] = { kind: "not_charged" };
        if (input.action === "provide_metered_result" || input.action === "correct_metered_result") {
            const correctedObservation = input.action === "correct_metered_result" ? originalResponse?.observation : undefined;
            if (input.action === "correct_metered_result" && !correctedObservation?.invalid) throw new PricingConflictError("原响应没有已保存的矛盾用量，请使用补录或恢复");
            if (originalResponse && !reference.review && !correctedObservation) {
                let ready = false;
                try {
                    validateReviewedTextUsage(reservation, originalResponse.observation);
                    ready = true;
                } catch (error) {
                    if (!(error instanceof PricingInputError)) throw error;
                }
                if (ready) throw new PricingConflictError("原响应用量完整，请直接恢复已有凭据");
            }
            const protocol = reservation.frozen.text.contract.protocol;
            const usesCacheWriteTtl = reservation.frozen.version.manufacturer === "Moonshot" && reservation.frozen.version.sku === "kimi-k3" && protocol === "openai-chat";
            if (!usesCacheWriteTtl && (input.cacheWrite5mTokens !== undefined || input.cacheWrite1hTokens !== undefined)) throw new PricingInputError("该型号不使用缓存写入分档响应头");
            const headers = usesCacheWriteTtl ? new Headers() : undefined;
            if (headers) {
                for (const [field, value] of [
                    ["Msh-Usage-Cache-Write-Tokens-5m", input.cacheWrite5mTokens],
                    ["Msh-Usage-Cache-Write-Tokens-1h", input.cacheWrite1hTokens],
                ] as const) {
                    if (value !== undefined) {
                        if (typeof value !== "string" || !/^\d+$/.test(value)) throw new PricingInputError("缓存写入分档须填写供应商响应头中的非负整数");
                        headers.set(field, value);
                    }
                }
            }
            let observation: TokenUsageObservation;
            if (usesCacheWriteTtl && input.action === "provide_metered_result" && !input.response?.trim() && originalResponse && hasOnlyMissingCacheWriteTtl(originalResponse.observation)) {
                const five = Number(input.cacheWrite5mTokens);
                const hour = Number(input.cacheWrite1hTokens);
                const total = Number(originalResponse.observation.quantities.cacheWriteTokens);
                if (!input.cacheWrite5mTokens || !input.cacheWrite1hTokens || !Number.isSafeInteger(five) || !Number.isSafeInteger(hour) || !Number.isSafeInteger(total) || five + hour !== total)
                    throw new PricingInputError("缓存写入分档必须与原响应总量一致");
                observation = {
                    ...originalResponse.observation,
                    quantities: { ...originalResponse.observation.quantities, cacheWrite5mTokens: String(five), cacheWrite1hTokens: String(hour) },
                    missing: originalResponse.observation.missing.filter((field) => !field.startsWith("Msh-Usage-Cache-Write-Tokens-")),
                };
                content = originalResponse.content;
            } else {
                let payload: unknown;
                try {
                    payload = JSON.parse(input.response);
                } catch {
                    throw new PricingInputError("请填写供应商完整响应 JSON");
                }
                content = publicPricedTextContent(protocol, payload);
                if (!content || !completeTextResponse(protocol, payload)) throw new PricingInputError("响应必须包含完整公开文本、结束状态及原协议用量");
                observation = inspectProviderTokenUsage(protocol, payload, headers);
            }
            validateReviewedTextUsage(reservation, observation, correctedObservation);
            outcome = { kind: "response", observation, ...(correctedObservation ? { correctedObservation } : {}) };
        } else if (reservation.submission.response) throw new PricingConflictError("已有响应凭据，不能确认未计费");
        await saveTextTaskBillingReview({
            taskId: id,
            ...key,
            attemptNo: input.attemptNo,
            expectedResponse: originalResponse,
            review: {
                decision: { id: randomUUID(), claimId: reservation.submission.id, reviewedBy, reviewedAt: new Date().toISOString(), evidence, outcome },
                ...(content ? { content } : {}),
            },
        });
    }
    const latest = await getTextTask(id);
    if (!latest) throw new PricingConflictError("原任务状态已变化");
    await recoverPricedTextTaskStep(latest);
    const current = await getTextTask(id);
    const pending = !current || Boolean(current.billingPending) || !["success", "error", "cancelled"].includes(current.status);
    const executionPhase = pending ? "needs_review" : "completed";
    await scheduleGenerationTask("text", id, { executionPhase, nextPollAt: undefined, lastUpstreamStatus: pending ? "billing_review_pending" : "billing_review_completed" });
    const reviewed = current?.billingRequests?.find((item) => item.attemptNo === input.attemptNo);
    return { executionPhase, reviewId: reviewed?.review?.decision.id || reviewed?.preparationStop?.id };
}
