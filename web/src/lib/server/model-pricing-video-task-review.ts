import { inspectHailuoObservation, type HailuoObservation } from "./model-pricing-hailuo-contract";
import { assertVideoObservationSupplement } from "./model-pricing-submission-review";
import { randomUUID } from "node:crypto";
import { PricingConflictError, PricingInputError } from "@/lib/model-pricing";
import { getStoredGenerationTaskRecord } from "./generation-task-store";
import { scheduleGenerationTask } from "./generation-task-scheduler";
import { getVideoTask, saveVideoTaskBillingReview, videoTaskAttemptNo, type VideoTask } from "./video-task-store";
import { failVideoTaskFromWorker, queryVideoTaskPayload } from "./video-task-runtime";
import { getModelPriceReservation, stopModelPricePreparation, validateReviewedVideoUsage } from "./model-pricing-wallet-service";
import { recoverPricedVideoTask, refundPricedVideoTask } from "./model-pricing-video-task";
import { inspectMinimaxVideoUsage, type VideoUsageObservation } from "./model-pricing-video-usage";
import type { PricingSubmissionReview } from "./model-pricing-submission-review";
import { recoverGenerationTaskFromUpstream } from "./generation-task-user-recovery";
import type { PricingTaskReviewInput } from "./model-pricing-task-review-service";

async function context(id: string) {
    const record = await getStoredGenerationTaskRecord("video", id);
    const task = record?.payload as VideoTask | undefined;
    if (!task || task.billingMode !== "official-usage") throw new PricingInputError("按量视频任务不存在");
    const reference = task.billingRequests?.find((item) => item.attemptNo === videoTaskAttemptNo(task));
    if (!reference) throw new PricingConflictError("视频任务尚无原计费请求");
    const key = { userId: task.userId, requestId: reference.requestId, requestFingerprint: reference.requestFingerprint };
    return { record: record!, task, reference, key, reservation: await getModelPriceReservation(key) };
}

export async function getVideoPricingTaskReview(id: string) {
    const { task, reference, reservation } = await context(id);
    const original = task.pricedResponses?.find((item) => item.requestId === reference.requestId);
    const created = task.pricedSubmissions?.find((item) => item.requestId === reference.requestId);
    const canReviewSubmission = Boolean(reservation?.submission && reservation.frozen.video && reference.preparation?.phase === "finished" && !reference.preparationStop && !original?.recovered);
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
        canProvideResult: Boolean(created && created.upstreamTaskId === reservation?.submission?.upstreamTaskId && !original?.recovered),
        canReviewSubmission,
        canResumeBilling: Boolean(reference.preparationStop || reference.review || created || original),
        canCorrectUsage: Boolean(
            task.billingPending &&
            created &&
            original?.observation.invalid.length &&
            (reservation?.submission?.response?.observation.protocol === "minimax-video-v2" || reservation?.submission?.response?.observation.protocol === "minimax-hailuo-v1") &&
            reservation.submission.response.observation.invalid.length &&
            !reference.review &&
            !original.recovered,
        ),
        reviewed: Boolean(reference.preparationStop || reference.review),
        canStopPreparation: !reservation?.submission && reservation?.status !== "settled" && !reference.preparationStop && !reference.review && Boolean(task.billingPending),
        officialVersionId: reservation?.frozen.version.id,
        salesVersionId: reservation?.frozen.policy.id,
    };
}

/** Save evidence under the original attempt before changing its wallet; never create another video. */
export async function reviewVideoPricingTask(id: string, input: PricingTaskReviewInput, reviewedBy: string, origin?: string) {
    const { record, task, reference, key, reservation } = await context(id);
    if (input.attemptNo !== reference.attemptNo) throw new PricingConflictError("视频任务尝试已变化，请重新核对");
    if (input.action === "stop_preparation") {
        if (!reference.preparationStop && (record.executionPhase !== "needs_review" || !task.billingPending)) throw new PricingConflictError("当前视频任务不等待账务核对");
        await stopModelPricePreparation({ ...key, taskId: id, taskType: "video", attemptNo: input.attemptNo, reviewedBy, evidence: typeof input.evidence === "string" ? input.evidence : "" });
    } else if (input.action !== "resume_billing") {
        if (!reference.review && (record.executionPhase !== "needs_review" || !task.billingPending)) throw new PricingConflictError("当前视频任务不等待账务核对");
        if (!reservation?.submission || !reservation.frozen.video || reference.preparation?.phase !== "finished" || reference.preparationStop) throw new PricingConflictError("视频任务缺少完整原提交身份，不能补录或解除预留");
        if (!reference.review && (reservation.status !== "reserved" || reservation.submission.phase === "not_charged")) throw new PricingConflictError("原视频预留已处理，请恢复已有凭据");
        const evidence = typeof input.evidence === "string" ? input.evidence.trim() : "";
        if (!evidence) throw new PricingInputError("请填写供应商原任务账单或未计费证明，超时、取消或失败不是计费依据");
        const original = task.pricedResponses?.find((item) => item.requestId === reference.requestId);
        if (original?.recovered) throw new PricingConflictError("原视频计量已由上游查询补全，请恢复已有凭据");
        const created = task.pricedSubmissions?.find((item) => item.requestId === reference.requestId);
        let outcome: PricingSubmissionReview<VideoUsageObservation | HailuoObservation>["outcome"] = { kind: "not_charged" };
        let resultUrl: string | undefined;
        if (input.action === "provide_metered_result" || input.action === "correct_metered_result") {
            if (!created || created.upstreamTaskId !== reservation.submission.upstreamTaskId) throw new PricingConflictError("缺少原创建确认，不能使用查询响应补猜任务身份");
            const correctedObservation = input.action === "correct_metered_result" ? original?.observation : undefined;
            if (input.action === "correct_metered_result" && !correctedObservation?.invalid.length) throw new PricingConflictError("原视频没有已保存的矛盾计量，请使用补录或恢复");
            if (original && !reference.review && !correctedObservation) {
                let ready = false;
                try {
                    validateReviewedVideoUsage(reservation, original.observation);
                    ready = true;
                } catch (error) {
                    if (!(error instanceof PricingInputError)) throw error;
                }
                if (ready) throw new PricingConflictError("原视频响应完整，请直接恢复已有凭据");
            }
            let payload: unknown;
            try {
                payload = JSON.parse(input.response);
            } catch {
                throw new PricingInputError("请填写供应商完整响应 JSON");
            }
            const hailuo = reservation.frozen.video.contract.protocol === "minimax-hailuo-v1";
            const observation = hailuo ? inspectHailuoObservation(payload, created.upstreamTaskId) : inspectMinimaxVideoUsage(payload, created.upstreamTaskId, reference.upstreamModel);
            validateReviewedVideoUsage(reservation, observation, correctedObservation);
            if (observation.protocol === "minimax-hailuo-v1") {
                if (created.businessStatus !== 0) throw new PricingConflictError("Hailuo 缺少持久创建成功凭据");
                if (original?.observation.protocol === "minimax-hailuo-v1" && original.observation.fileId === observation.fileId && original.resultUrl) resultUrl = original.resultUrl;
                else {
                    if (!origin) throw new PricingInputError("核对 Hailuo 原文件需要当前应用地址");
                    const verified = await queryVideoTaskPayload(task, origin, "", task.userId);
                    const facts = inspectHailuoObservation(verified, created.upstreamTaskId);
                    assertVideoObservationSupplement(facts, observation);
                    resultUrl = (verified as { download_url?: string }).download_url;
                    if (!resultUrl || facts.status !== "Success" || facts.fileId !== observation.fileId) throw new PricingConflictError("Hailuo 补录缺少原任务文件查询凭据");
                }
                const suppliedUrl = (payload as { download_url?: unknown }).download_url;
                if (suppliedUrl !== undefined && suppliedUrl !== resultUrl) throw new PricingConflictError("补录不能改写原视频结果地址");
            } else resultUrl = (payload as { task: { content: { url: string } } }).task.content.url;
            outcome = { kind: "response", observation, ...(correctedObservation ? { correctedObservation } : {}) };
        } else if (reservation.submission.response || original) throw new PricingConflictError("已有视频响应凭据，不能确认未计费");
        await saveVideoTaskBillingReview({
            taskId: id,
            ...key,
            attemptNo: input.attemptNo,
            expectedResponse: original,
            expectedSubmission: created,
            review: {
                decision: { id: randomUUID(), claimId: reservation.submission.id, reviewedBy, reviewedAt: new Date().toISOString(), evidence, outcome },
                ...(resultUrl ? { resultUrl } : {}),
            },
        });
    }
    const latest = await getVideoTask(id);
    if (!latest) throw new PricingConflictError("原视频状态已变化");
    if (latest.status === "cancelled" || latest.status === "error") await refundPricedVideoTask(latest);
    else {
        const recovered = await recoverPricedVideoTask(latest);
        if (recovered?.state === "failed") await failVideoTaskFromWorker(latest, recovered.error);
        else if (recovered?.state === "result_ready" || recovered?.state === "pending") {
            if (!origin) throw new PricingInputError("恢复视频需要当前应用地址");
            await recoverGenerationTaskFromUpstream({ type: "video", id, upstreamTaskId: latest.upstream.id, submittedAt: record.submittedAt || task.createdAt, origin });
        }
    }
    const current = await getVideoTask(id);
    const pending = !current || Boolean(current.billingPending) || !["success", "error", "cancelled"].includes(current.status);
    const executionPhase = pending ? "needs_review" : "completed";
    await scheduleGenerationTask("video", id, { executionPhase, nextPollAt: undefined, lastUpstreamStatus: pending ? "billing_review_pending" : "billing_review_completed" }, { cancellation: true });
    const reviewed = current?.billingRequests?.find((item) => item.attemptNo === input.attemptNo);
    return { executionPhase, reviewId: reviewed?.review?.decision.id || reviewed?.preparationStop?.id };
}
