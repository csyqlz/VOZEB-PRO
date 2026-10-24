import { randomUUID } from "node:crypto";
import { PricingConflictError, PricingInputError } from "@/lib/model-pricing";
import { getStoredGenerationTaskRecord } from "./generation-task-store";
import { scheduleGenerationTask } from "./generation-task-scheduler";
import { getImageTask, saveImageTaskBillingReview, type ImageTask, type StoredImageTaskMediaResult } from "./image-task-store";
import { markImageTaskFailed } from "./image-task-runtime";
import { getModelPriceReservation, stopModelPricePreparation, validateReviewedImageUsage } from "./model-pricing-wallet-service";
import { recoverPricedImageTask, refundPricedImageTask } from "./model-pricing-image-task";
import { inspectOpenAiImageCount } from "./model-pricing-image-usage";
import type { PricingSubmissionReview } from "./model-pricing-submission-review";
import type { ImageUsageObservation } from "./model-pricing-image-usage";
import { recoverGenerationTaskFromUpstream } from "./generation-task-user-recovery";
import type { PricingTaskReviewInput } from "./model-pricing-task-review-service";

async function context(id: string) {
    const record = await getStoredGenerationTaskRecord("image", id);
    const task = record?.payload as ImageTask | undefined;
    if (!task || task.billingMode !== "official-usage") throw new PricingInputError("按量图片任务不存在");
    const reference = task.billingRequests?.find((item) => item.attemptNo === task.attemptNo);
    if (!reference) throw new PricingConflictError("任务尚无可核对的原计费请求");
    const key = { userId: task.userId, requestId: reference.requestId, requestFingerprint: reference.requestFingerprint };
    return { record: record!, task, reference, key, reservation: await getModelPriceReservation(key) };
}

export async function getImagePricingTaskReview(id: string) {
    const { task, reference, reservation } = await context(id);
    const original = task.pricedResponses?.find((item) => item.requestId === reference.requestId);
    const canReviewSubmission = Boolean(reservation?.submission && reservation.frozen.image && reference.preparation?.phase === "finished" && !reference.preparationStop);
    return {
        attemptNo: reference.attemptNo,
        model: reference.logicalModel,
        channelId: reference.channelId,
        upstreamModel: reference.upstreamModel,
        pending: Boolean(task.billingPending),
        stage: reservation?.status === "reserved" ? reservation.submission?.phase || "reserved" : reservation?.status || "preparing",
        heldPoints: reservation?.allocation.heldPoints,
        hasSavedResponse: Boolean(original),
        invalidUsage: original?.observation.invalid.join("；") || undefined,
        canCorrectUsage: Boolean(
            task.billingPending &&
            canReviewSubmission &&
            original?.observation.invalid.length &&
            reservation?.submission?.response?.observation.protocol === "openai-images" &&
            reservation.submission.response.observation.invalid.length &&
            !reference.review,
        ),
        canReviewSubmission,
        canResumeBilling: Boolean(reference.preparationStop || reference.review || original),
        reviewed: Boolean(reference.preparationStop || reference.review),
        canStopPreparation: !reservation?.submission && reservation?.status !== "settled" && !reference.preparationStop && !reference.review && Boolean(task.billingPending),
        officialVersionId: reservation?.frozen.version.id,
        salesVersionId: reservation?.frozen.policy.id,
    };
}

/** Persist reviewed metering first; resume only the original task and its frozen accounting. */
export async function reviewImagePricingTask(id: string, input: PricingTaskReviewInput, reviewedBy: string, origin?: string) {
    const { record, task, reference, key, reservation } = await context(id);
    if (input.attemptNo !== reference.attemptNo) throw new PricingConflictError("任务尝试已变化，请重新打开核对窗口");
    if (input.action === "stop_preparation") {
        if (!reference.preparationStop && (record.executionPhase !== "needs_review" || !task.billingPending)) throw new PricingConflictError("当前任务不等待账务核对");
        await stopModelPricePreparation({ ...key, taskId: id, taskType: "image", attemptNo: input.attemptNo, reviewedBy, evidence: typeof input.evidence === "string" ? input.evidence : "" });
    } else if (input.action !== "resume_billing") {
        if (!reference.review && (record.executionPhase !== "needs_review" || !task.billingPending)) throw new PricingConflictError("当前任务不等待账务核对");
        if (!reservation?.submission || !reservation.frozen.image || reference.preparation?.phase !== "finished" || reference.preparationStop) throw new PricingConflictError("尚无完整的原图片提交身份，不能补录或解除预留");
        if (!reference.review && (reservation.status !== "reserved" || reservation.submission.phase === "not_charged")) throw new PricingConflictError("原预留已处理，请恢复已有凭据");
        const evidence = typeof input.evidence === "string" ? input.evidence.trim() : "";
        if (!evidence) throw new PricingInputError("请填写供应商凭据或未计费证明，超时和失败描述不属于计费依据");
        const original = task.pricedResponses?.find((item) => item.requestId === reference.requestId);
        let outcome: PricingSubmissionReview<ImageUsageObservation>["outcome"] = { kind: "not_charged" };
        let results: StoredImageTaskMediaResult[] | undefined;
        if (input.action === "provide_metered_result" || input.action === "correct_metered_result") {
            const correctedObservation = input.action === "correct_metered_result" ? original?.observation : undefined;
            if (input.action === "correct_metered_result" && !correctedObservation?.invalid.length) throw new PricingConflictError("原图片没有已保存的矛盾计量，请使用补录或恢复");
            if (original && !reference.review && !correctedObservation) {
                let ready = false;
                try {
                    validateReviewedImageUsage(reservation, original.observation);
                    ready = true;
                } catch (error) {
                    if (!(error instanceof PricingInputError)) throw error;
                }
                if (ready) throw new PricingConflictError("原图片响应完整，请直接恢复已有凭据");
            }
            let payload: unknown;
            try {
                payload = JSON.parse(input.response);
            } catch {
                throw new PricingInputError("请填写供应商完整响应 JSON");
            }
            const observation = inspectOpenAiImageCount(payload);
            validateReviewedImageUsage(reservation, observation, correctedObservation);
            results = (payload as { data: { url: string }[] }).data.map(({ url }) => ({ dataUrl: url, remoteUrl: url }));
            outcome = { kind: "response", observation, ...(correctedObservation ? { correctedObservation } : {}) };
        } else if (reservation.submission.response || original) throw new PricingConflictError("已有响应凭据，不能确认未计费");
        await saveImageTaskBillingReview({
            taskId: id,
            ...key,
            attemptNo: input.attemptNo,
            expectedResponse: original,
            review: {
                decision: { id: randomUUID(), claimId: reservation.submission.id, reviewedBy, reviewedAt: new Date().toISOString(), evidence, outcome },
                ...(results ? { results } : {}),
            },
        });
    }
    const latest = await getImageTask(id);
    if (!latest) throw new PricingConflictError("原任务状态已变化");
    if (latest.status === "cancelled" || latest.status === "error") await refundPricedImageTask(latest);
    else {
        const recovered = await recoverPricedImageTask(latest);
        if (recovered?.state === "failed") await markImageTaskFailed(latest, recovered.error);
        else if (recovered?.state === "completed") {
            if (!origin) throw new PricingInputError("恢复图片交付需要当前应用地址");
            await recoverGenerationTaskFromUpstream({ type: "image", id, upstreamTaskId: "", submittedAt: record.submittedAt || task.createdAt, origin });
        }
    }
    const current = await getImageTask(id);
    const pending = !current || Boolean(current.billingPending) || !["success", "error", "cancelled"].includes(current.status);
    const executionPhase = pending ? "needs_review" : "completed";
    await scheduleGenerationTask("image", id, { executionPhase, nextPollAt: undefined, lastUpstreamStatus: pending ? "billing_review_pending" : "billing_review_completed" });
    return { executionPhase, reviewId: current?.billingRequests?.find((item) => item.attemptNo === input.attemptNo)?.review?.decision.id || current?.billingRequests?.find((item) => item.attemptNo === input.attemptNo)?.preparationStop?.id };
}
