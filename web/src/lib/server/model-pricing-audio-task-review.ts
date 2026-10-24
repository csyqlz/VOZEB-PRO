import { saveAudioPriceReview } from "./model-pricing-audio-review";
import { PricingConflictError, PricingInputError } from "@/lib/model-pricing";
import { getAudioTask, type AudioTask } from "./audio-task-store";
import { getStoredGenerationTaskRecord } from "./generation-task-store";
import { scheduleGenerationTask } from "./generation-task-scheduler";
import { getModelPriceReservation, stopModelPricePreparation, validateReviewedAudioUsage } from "./model-pricing-wallet-service";
import { readAudioPriceReview, readAudioPriceResponseReceipt } from "./model-pricing-audio-response-store";
import { refundPricedAudioTask } from "./model-pricing-audio-task";
import { recoverGenerationTaskFromUpstream } from "./generation-task-user-recovery";
import type { PricingTaskReviewInput } from "./model-pricing-task-review-service";

async function context(id: string) {
    const record = await getStoredGenerationTaskRecord("audio", id);
    const task = record?.payload as AudioTask | undefined;
    if (!task || task.billingMode !== "official-usage") throw new PricingInputError("按量音频任务不存在");
    const reference = task.billingRequests?.find((item) => item.attemptNo === task.attemptNo);
    if (!reference) throw new PricingConflictError("音频任务尚无原计费请求");
    const key = { userId: task.userId, requestId: reference.requestId, requestFingerprint: reference.requestFingerprint };
    return { record: record!, task, reference, key, reservation: await getModelPriceReservation(key) };
}

export async function getAudioPricingTaskReview(id: string) {
    const { task, reference, key, reservation } = await context(id);
    const original = await readAudioPriceResponseReceipt(key.userId, key.requestId);
    const review = await readAudioPriceReview(key.userId, key.requestId);
    let complete = false;
    if (original && reservation) {
        try {
            validateReviewedAudioUsage(reservation, original.observation);
            complete = true;
        } catch (error) {
            if (!(error instanceof PricingInputError) && !(error instanceof PricingConflictError)) throw error;
        }
    }
    const hasSavedResponse = Boolean(original || review?.response);
    const canReviewSubmission = Boolean(reservation?.submission && reservation.frozen.audio && reference.preparation?.phase === "finished" && !reference.preparationStop);
    return {
        attemptNo: reference.attemptNo,
        model: reference.logicalModel,
        channelId: reference.channelId,
        upstreamModel: reference.upstreamModel,
        pending: Boolean(task.billingPending),
        stage: reservation?.status === "reserved" ? reservation.submission?.phase || "reserved" : reservation?.status || "preparing",
        heldPoints: reservation?.allocation.heldPoints,
        hasSavedResponse,
        invalidUsage: original?.observation.invalid.join("；") || undefined,
        canProvideResult: canReviewSubmission && !complete && !original?.observation.invalid.length,
        canReviewSubmission,
        canConfirmNoCharge: !hasSavedResponse && !reservation?.submission?.response,
        canCorrectUsage: Boolean(task.billingPending && original?.observation.invalid.length && !review),
        canResumeBilling: Boolean(reference.preparationStop || review || hasSavedResponse || reservation?.status === "released"),
        reviewed: Boolean(reference.preparationStop || review),
        canStopPreparation: Boolean(task.billingPending && !reference.preparationStop && !review && !reservation?.submission && reservation?.status !== "settled" && !hasSavedResponse),
        officialVersionId: reservation?.frozen.version.id,
        salesVersionId: reservation?.frozen.policy.id,
    };
}

/** Save a dedicated original-attempt decision, then recover without another upstream call. */
export async function reviewAudioPricingTask(id: string, input: PricingTaskReviewInput, reviewedBy: string, origin?: string) {
    const { record, task, reference, key } = await context(id);
    if (input.attemptNo !== reference.attemptNo) throw new PricingConflictError("音频任务尝试已变化，请重新核对");
    if (!origin && !["cancelled", "error"].includes(task.status)) throw new PricingInputError("恢复音频需要当前应用地址");
    if (input.action === "stop_preparation") {
        if (!reference.preparationStop && (record.executionPhase !== "needs_review" || !task.billingPending)) throw new PricingConflictError("当前音频任务不等待账务核对");
        await stopModelPricePreparation({ ...key, taskId: id, taskType: "audio", attemptNo: input.attemptNo, reviewedBy, evidence: typeof input.evidence === "string" ? input.evidence : "" });
    } else if (input.action !== "resume_billing") {
        const existing = await readAudioPriceReview(key.userId, key.requestId);
        if (!existing && (record.executionPhase !== "needs_review" || !task.billingPending)) throw new PricingConflictError("当前音频任务不等待账务核对");
        await saveAudioPriceReview({ ...key, taskId: id, attemptNo: input.attemptNo, action: input.action, reviewedBy, evidence: typeof input.evidence === "string" ? input.evidence : "", response: "response" in input ? input.response : undefined });
    }
    const latest = await getAudioTask(id);
    if (!latest) throw new PricingConflictError("原音频任务状态已变化");
    if (latest.status === "cancelled" || latest.status === "error") await refundPricedAudioTask(latest);
    else await recoverGenerationTaskFromUpstream({ type: "audio", id, upstreamTaskId: latest.upstream?.id || "", submittedAt: record.submittedAt || task.createdAt, origin: origin! });
    const current = await getAudioTask(id);
    const pending = !current || Boolean(current.billingPending) || !["success", "error", "cancelled"].includes(current.status);
    const executionPhase = pending ? "needs_review" : "completed";
    await scheduleGenerationTask("audio", id, { executionPhase, nextPollAt: undefined, lastUpstreamStatus: pending ? "billing_review_pending" : "billing_review_completed" }, { cancellation: true });
    const reviewed = await readAudioPriceReview(key.userId, key.requestId);
    return { executionPhase, reviewId: reviewed?.decision.id || current?.billingRequests?.find((item) => item.attemptNo === input.attemptNo)?.preparationStop?.id };
}
