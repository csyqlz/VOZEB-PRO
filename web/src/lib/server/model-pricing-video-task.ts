import { getStoredGenerationTaskRecord } from "./generation-task-store";
import { scheduleGenerationTask } from "./generation-task-scheduler";
import { PricingConflictError, PricingInputError } from "@/lib/model-pricing";
import { beginShadowVideoCall } from "./model-pricing-shadow-video-call";
import { inspectHailuoObservation } from "./model-pricing-hailuo-contract";
import { inspectMinimaxVideoUsage } from "./model-pricing-video-usage";
import {
    acknowledgeModelPriceVideoSubmission,
    reviewModelPriceSubmission,
    claimModelPriceSubmission,
    getModelPriceReservation,
    recordModelPriceSubmissionOutcome,
    refundModelPricePoints,
    releaseModelPricePoints,
    reserveModelPricePoints,
    settleModelPricePoints,
    stopModelPricePreparation,
    validateReviewedVideoUsage,
} from "./model-pricing-wallet-service";
import {
    claimVideoTaskBillingPreparation,
    finishVideoTaskBillingPreparation,
    finishVideoTaskBilling,
    getVideoTask,
    savePricedVideoTaskSubmission,
    savePricedVideoTaskResponse,
    savePricedVideoTaskRecoveredResponse,
    updateVideoTask,
    videoTaskAttemptNo,
    type VideoTask,
    type VideoTaskBillingRequest,
} from "./video-task-store";
import { SYSTEM_AI_PRICING_STATE_HEADER } from "./system-ai-billing";

type Input = Parameters<typeof beginShadowVideoCall>[0] & { task: VideoTask; signal: AbortSignal; send(): Promise<Response> };
const referenceFor = (task: VideoTask) => task.billingRequests?.find((item) => item.attemptNo === videoTaskAttemptNo(task));
const identity = (task: VideoTask, reference: VideoTaskBillingRequest) => ({ userId: task.userId, requestId: reference.requestId, requestFingerprint: reference.requestFingerprint });
export function canRequeryIncompletePricedVideoTask(task: VideoTask) {
    const reference = referenceFor(task);
    const first = task.pricedResponses?.find((item) => item.requestId === reference?.requestId);
    return Boolean(
        task.billingMode === "official-usage" &&
        reference &&
        !reference.review &&
        !reference.preparationStop &&
        task.pricedSubmissions?.some((item) => item.requestId === reference.requestId && item.upstreamTaskId === task.upstream.id) &&
        first &&
        !first.recovered &&
        ["succeeded", "Success"].includes(first.observation.status || "") &&
        first.observation.missing.length &&
        !first.observation.invalid.length,
    );
}
export const videoPricingPendingMessage = "原视频任务的计费结果待核对，已保留预留；请检查原任务状态，避免重复提交";
const pending = () => Response.json({ error: videoPricingPendingMessage }, { status: 409, headers: { [SYSTEM_AI_PRICING_STATE_HEADER]: "pending" } });
const notSubmitted = (message: string) => Response.json({ error: message }, { status: 422, headers: { [SYSTEM_AI_PRICING_STATE_HEADER]: "not-submitted" } });

/** Commit preparation, reservation and a unique submission claim before any paid upstream request. */
export async function executePricedVideoTask(input: Input): Promise<Response> {
    const reference = referenceFor(input.task);
    if (input.task.billingMode !== "official-usage" || input.task.userId !== input.userId || reference?.requestId !== input.requestId || reference.requestFingerprint !== input.requestFingerprint) throw new PricingInputError("视频任务计费身份不匹配");
    const key = identity(input.task, reference);
    let preparationId: string | undefined;
    try {
        preparationId = await claimVideoTaskBillingPreparation({ taskId: input.task.id, ...key });
    } catch (error) {
        if (error instanceof PricingConflictError) return pending();
        throw error;
    }
    if (!preparationId) return pending();
    const finishPreparation = () => finishVideoTaskBillingPreparation({ taskId: input.task.id, ...key, claimId: preparationId! });
    try {
        const call = await beginShadowVideoCall(input);
        if (!call.frozen?.bound || call.reasons.length || call.protocol !== call.frozen.protocol || !input.declaredProtocol) throw new PricingInputError(call.reasons.join("；") || "该视频调用缺少已审核的价目、契约或请求上界");
        await reserveModelPricePoints({
            ...key,
            preparation: { taskId: input.task.id, claimId: preparationId, taskType: "video" },
            modelId: input.modelId,
            usageKind: "video",
            units: 1,
            ...call.frozen,
            videoRequest: { contract: call.frozen.contract, channelId: input.channelId, requestedModel: input.requestedModel, declaredProtocol: input.declaredProtocol, payload: input.payload },
        });
        await finishPreparation();
    } catch (error) {
        if (!(error instanceof PricingInputError) || (await getModelPriceReservation(key))) return pending();
        await finishPreparation();
        await finishVideoTaskBilling({ taskId: input.task.id, ...key });
        return notSubmitted(error.message);
    }
    const latest = await getVideoTask(input.task.id);
    if (input.signal.aborted || latest?.status !== "running") {
        const saved = await getModelPriceReservation(key);
        if (saved?.submission) return pending();
        await releaseModelPricePoints({ ...key, reason: "not-submitted", evidence: "视频任务已取消或结束，尚未取得上游提交许可" });
        await finishVideoTaskBilling({ taskId: input.task.id, ...key });
        return notSubmitted("视频任务已取消或结束，本次未提交上游");
    }
    let claim: Awaited<ReturnType<typeof claimModelPriceSubmission>>;
    try {
        claim = await claimModelPriceSubmission(key);
    } catch (error) {
        if (error instanceof PricingConflictError) return pending();
        throw error;
    }
    if (!claim.claimed) {
        if (claim.reservation.status === "released") {
            await finishVideoTaskBilling({ taskId: input.task.id, ...key });
            return notSubmitted("用户有待补扣积分，本次未提交上游");
        }
        return pending();
    }
    const claimed = { ...key, claimId: claim.reservation.submission!.id };
    try {
        const response = await input.send();
        if (!response.ok) {
            await response.body?.cancel();
            throw new PricingInputError("视频创建响应未确认");
        }
        const payload: unknown = await response.json();
        const body = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
        if (body.error || typeof body.task_id !== "string" || !body.task_id.trim()) throw new PricingInputError("视频创建响应缺少原任务 ID");
        const businessStatus = body.base_resp && typeof body.base_resp === "object" ? (body.base_resp as Record<string, unknown>).status_code : undefined;
        await savePricedVideoTaskSubmission({ taskId: input.task.id, ...key, upstreamTaskId: body.task_id, ...(typeof businessStatus === "number" ? { businessStatus } : {}) });
        await acknowledgeModelPriceVideoSubmission({ ...claimed, payload: body });
        return Response.json({ task_id: body.task_id }, { headers: { [SYSTEM_AI_PRICING_STATE_HEADER]: "submitted" } });
    } catch (error) {
        try {
            await recordModelPriceSubmissionOutcome({ ...claimed, kind: "unknown", reason: "transport_error" });
        } catch {
            /* The durable claim forbids resubmission. */
        }
        console.error("Priced video submission needs recovery", { taskId: input.task.id, errorType: error instanceof Error ? error.name : "unknown" });
        return pending();
    }
}

/** Recover only durable original creation/response evidence; never sends another generation request. */
export async function recoverPricedVideoTask(task: VideoTask) {
    if (task.billingMode !== "official-usage") return null;
    const reference = referenceFor(task);
    const review = () => ({ state: "needs_review" as const, status: "pricing_pending", reason: videoPricingPendingMessage });
    if (!reference) return review();
    const key = identity(task, reference);
    if (reference.preparationStop) {
        await stopModelPricePreparation({ ...key, taskId: task.id, taskType: "video", attemptNo: reference.attemptNo, ...reference.preparationStop });
        await finishVideoTaskBilling({ taskId: task.id, ...key });
        return { state: "failed" as const, status: "not_submitted", error: "原视频计费准备已撤销，本次未提交上游" };
    }
    let saved = await getModelPriceReservation(key);
    if (reference.review) saved = await reviewModelPriceSubmission({ ...key, review: reference.review.decision });
    if (!saved && reference.preparation?.phase === "finished") {
        await finishVideoTaskBilling({ taskId: task.id, ...key });
        return { state: "failed" as const, status: "not_submitted", error: "原视频计费预检已结束，本次未提交上游" };
    }
    if (saved?.status === "reserved" && saved.submission?.phase === "not_charged" && saved.submission.noChargeEvidence) {
        await releaseModelPricePoints({ ...key, reason: "confirmed-no-charge", evidence: saved.submission.noChargeEvidence });
        await finishVideoTaskBilling({ taskId: task.id, ...key });
        saved = await getModelPriceReservation(key);
    }
    if (saved?.status === "released") return { state: "failed" as const, status: "released", error: "原视频预留已释放，本次尝试已结束" };
    if (!saved?.submission) return review();
    const submission = task.pricedSubmissions?.find((item) => item.requestId === reference.requestId);
    if (!submission) return review();
    try {
        if (task.upstream.id !== submission.upstreamTaskId) task = await savePricedVideoTaskSubmission({ taskId: task.id, ...key, upstreamTaskId: submission.upstreamTaskId, businessStatus: submission.businessStatus });
        await acknowledgeModelPriceVideoSubmission({ ...key, claimId: saved.submission.id, payload: { task_id: submission.upstreamTaskId, ...(submission.businessStatus === 0 ? { base_resp: { status_code: 0 } } : {}) } });
    } catch {
        return review();
    }
    const schedule = await getStoredGenerationTaskRecord("video", task.id);
    if (schedule?.upstreamTaskId !== submission.upstreamTaskId || schedule.channelId !== task.config.channelId)
        await scheduleGenerationTask("video", task.id, { upstreamTaskId: submission.upstreamTaskId, channelId: task.config.channelId, nextPollAt: schedule?.nextPollAt }, { cancellation: true });
    const reviewed = reference.review?.decision.outcome;
    const first = task.pricedResponses?.find((item) => item.requestId === reference.requestId);
    const response = reviewed?.kind === "response" ? { observation: reviewed.observation, resultUrl: reference.review!.resultUrl } : first?.recovered || first;
    if (!response) return { state: "pending" as const, status: "submitted" };
    try {
        if (!reference.review) await recordModelPriceSubmissionOutcome({ ...key, claimId: saved.submission.id, kind: "response", observation: first!.observation, responseComplete: true });
        if (!response.resultUrl) return review();
        const settled = await settleModelPricePoints({ ...key, resume: true });
        await updateVideoTask(task.id, {
            upstream: { ...task.upstream, id: submission.upstreamTaskId, resultUrl: response.resultUrl, pointsCost: Number(settled.reservation.settlement!.chargedPoints), pointsRecordId: settled.reservation.chargeRecordId!, pointsUnits: 1 },
        });
        return { state: "result_ready" as const, status: "succeeded", resultUrl: response.resultUrl };
    } catch (error) {
        console.error("Priced video settlement needs recovery", { taskId: task.id, errorType: error instanceof Error ? error.name : "unknown" });
        return review();
    }
}

export async function observePricedVideoTaskResult(task: VideoTask, payload: unknown) {
    const reference = referenceFor(task);
    if (task.billingMode !== "official-usage" || !reference) throw new PricingInputError("缺少原视频计费身份");
    const reservation = await getModelPriceReservation(identity(task, reference));
    const hailuo = reservation?.frozen.video?.contract.protocol === "minimax-hailuo-v1";
    const observation = hailuo ? inspectHailuoObservation(payload, task.upstream.id) : inspectMinimaxVideoUsage(payload, task.upstream.id, task.config.model);
    if (!(hailuo ? ["Success", "Fail"] : ["succeeded", "failed", "cancelled"]).includes(observation.status || "")) return { state: "pending" as const, status: observation.status || "processing" };
    const body = payload as { task?: { content?: { url?: string } }; download_url?: string };
    const resultUrl = observation.protocol === "minimax-hailuo-v1" ? (observation.status === "Success" && observation.fileId ? body.download_url : undefined) : observation.hasResult ? body.task?.content?.url : undefined;
    const first = task.pricedResponses?.find((item) => item.requestId === reference.requestId);
    if (first) {
        if (!first.recovered) {
            try {
                if (!resultUrl || !reservation) throw new PricingInputError("原视频补全缺少已冻结价格或媒体地址");
                validateReviewedVideoUsage(reservation, observation);
                await savePricedVideoTaskRecoveredResponse({ taskId: task.id, ...identity(task, reference), observation, resultUrl });
            } catch (error) {
                console.error("Priced video requery needs review", { taskId: task.id, errorType: error instanceof Error ? error.name : "unknown" });
            }
        }
    } else await savePricedVideoTaskResponse({ taskId: task.id, ...identity(task, reference), observation, resultUrl });
    return recoverPricedVideoTask((await getVideoTask(task.id)) || task);
}

export async function refundPricedVideoTask(task: VideoTask) {
    if (task.billingMode !== "official-usage" || !["cancelled", "error"].includes(task.status)) return false;
    const reference = referenceFor(task);
    if (!reference) return true;
    const key = identity(task, reference);
    if (reference.preparationStop) await stopModelPricePreparation({ ...key, taskId: task.id, taskType: "video", attemptNo: reference.attemptNo, ...reference.preparationStop });
    let saved = await getModelPriceReservation(key);
    if (!saved && reference.preparation?.phase === "preparing" && !reference.preparationStop) return false;
    if (!saved || saved.status === "released") {
        await finishVideoTaskBilling({ taskId: task.id, ...key });
        return true;
    }
    if (saved.status === "reserved") {
        if (!saved.submission) {
            await releaseModelPricePoints({ ...key, reason: "not-submitted", evidence: "视频任务失败或取消，尚未取得上游提交许可" });
            await finishVideoTaskBilling({ taskId: task.id, ...key });
            return true;
        }
        await recoverPricedVideoTask(task);
        saved = await getModelPriceReservation(key);
    }
    if (saved?.status === "released") {
        await finishVideoTaskBilling({ taskId: task.id, ...key });
        return true;
    }
    if (saved?.status !== "settled" || !saved.settledUsage) return false;
    await refundModelPricePoints({ ...key, refundId: `video-task:${task.id}:attempt:${reference.attemptNo}:refund`, usage: saved.settledUsage, units: saved.units, evidence: "视频任务已取消或业务处理失败，按原计量退回原费用" });
    const current = (await getVideoTask(task.id)) || task;
    await updateVideoTask(task.id, { upstream: { ...current.upstream, pointsCost: Number(saved.settlement!.chargedPoints), pointsRecordId: saved.chargeRecordId!, pointsUnits: 1, refunded: true } });
    await finishVideoTaskBilling({ taskId: task.id, ...key });
    return true;
}
