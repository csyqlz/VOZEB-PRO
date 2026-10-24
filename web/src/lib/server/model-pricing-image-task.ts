import { PricingConflictError, PricingInputError } from "@/lib/model-pricing";
import { beginShadowImageCall } from "./model-pricing-shadow-image-call";
import { inspectOpenAiImageCount, inspectOpenAiImageUsage, recordImageRequestMismatches } from "./model-pricing-image-usage";
import {
    reviewModelPriceSubmission,
    stopModelPricePreparation,
    claimModelPriceSubmission,
    getModelPriceReservation,
    recordModelPriceSubmissionOutcome,
    refundModelPricePoints,
    releaseModelPricePoints,
    reserveModelPricePoints,
    settleModelPricePoints,
} from "./model-pricing-wallet-service";
import { claimImageTaskBillingPreparation, finishImageTaskBillingPreparation, finishImageTaskBilling, getImageTask, savePricedImageTaskResponse, updateImageTask, type ImageTask, type ImageTaskBillingRequest } from "./image-task-store";
import { SYSTEM_AI_PRICING_STATE_HEADER } from "./system-ai-billing";

type Input = Parameters<typeof beginShadowImageCall>[0] & { task: ImageTask; hasMask?: boolean; requestFieldNames?: string[]; signal: AbortSignal; send(): Promise<Response> };
const referenceFor = (task: ImageTask) => task.billingRequests?.find((item) => item.attemptNo === task.attemptNo);
const identity = (task: ImageTask, reference: ImageTaskBillingRequest) => ({ userId: task.userId, requestId: reference.requestId, requestFingerprint: reference.requestFingerprint });
const pendingMessage = "原图片请求的计费结果待核对，已保留预留；请检查原任务状态，避免重复提交";
const pending = () => Response.json({ error: pendingMessage }, { status: 409, headers: { [SYSTEM_AI_PRICING_STATE_HEADER]: "pending" } });
const notSubmitted = (message: string) => Response.json({ error: message }, { status: 422, headers: { [SYSTEM_AI_PRICING_STATE_HEADER]: "not-submitted" } });

/** A committed claim is the only permission to send; result URLs are durable before settlement. */
export async function executePricedImageTask(input: Input): Promise<Response> {
    const reference = referenceFor(input.task);
    if (input.task.billingMode !== "official-usage" || input.task.userId !== input.userId || reference?.requestId !== input.requestId || reference.requestFingerprint !== input.requestFingerprint) throw new PricingInputError("图片任务计费身份不匹配");
    const key = identity(input.task, reference);
    let preparationId: string | undefined;
    try {
        preparationId = await claimImageTaskBillingPreparation({ taskId: input.task.id, ...key });
    } catch (error) {
        if (error instanceof PricingConflictError) return pending();
        throw error;
    }
    if (!preparationId) return pending();
    const finishPreparation = () => finishImageTaskBillingPreparation({ taskId: input.task.id, ...key, claimId: preparationId! });
    let tokenBilling = false;
    try {
        const call = await beginShadowImageCall(input);
        if (!call.frozen || call.reasons.length || !call.operation || (call.frozen.contract.scope === "global-standard-dataeyes-flux-image" && !input.declaredProtocol)) throw new PricingInputError("该图片调用缺少已审核的价目、契约或请求上界");
        tokenBilling = call.frozen.contract.scope === "global-standard-direct-image-tokens";
        await reserveModelPricePoints({
            ...key,
            preparation: { taskId: input.task.id, claimId: preparationId, taskType: "image" },
            modelId: input.modelId,
            usageKind: "image",
            units: 1,
            ...call.frozen,
            imageRequest: {
                contract: call.frozen.contract,
                channelId: input.channelId,
                requestedModel: input.requestedModel,
                declaredProtocol: input.declaredProtocol,
                operation: call.operation,
                payload: input.payload,
                referenceImages: input.referenceImages,
                hasMask: input.hasMask,
                requestFieldNames: input.requestFieldNames,
            },
        });
        await finishPreparation();
    } catch (error) {
        if (!(error instanceof PricingInputError) || (await getModelPriceReservation(key))) return pending();
        await finishPreparation();
        await finishImageTaskBilling({ taskId: input.task.id, ...key });
        return notSubmitted(error.message);
    }
    const latest = await getImageTask(input.task.id);
    if (input.signal.aborted || latest?.status !== "running") {
        const saved = await getModelPriceReservation(key);
        if (saved?.submission) return pending();
        await releaseModelPricePoints({ ...key, reason: "not-submitted", evidence: "图片任务已取消或结束，尚未取得上游提交许可" });
        await finishImageTaskBilling({ taskId: input.task.id, ...key });
        return notSubmitted("图片任务已取消或结束，本次未提交上游");
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
            await finishImageTaskBilling({ taskId: input.task.id, ...key });
            return notSubmitted("用户有待补扣积分，本次未提交上游");
        }
        return pending();
    }
    const claimed = { ...key, claimId: claim.reservation.submission!.id };
    try {
        const response = await input.send();
        if (!response.ok) {
            await response.body?.cancel();
            await recordModelPriceSubmissionOutcome({ ...claimed, kind: "unknown", reason: "result_unknown" });
            return pending();
        }
        const payload: unknown = await response.json();
        const observation = tokenBilling ? recordImageRequestMismatches(inspectOpenAiImageUsage(payload), payload, input.payload) : inspectOpenAiImageCount(payload);
        const results = observation.hasResults ? (payload as { data: Array<{ url?: string; b64_json?: string }> }).data.map(({ url, b64_json }) => (url ? { dataUrl: url, remoteUrl: url } : { dataUrl: `data:image/png;base64,${b64_json}` })) : [];
        await savePricedImageTaskResponse({ taskId: input.task.id, ...key, results, observation });
        if (observation.requestMismatches?.length) console.warn("Priced image response parameters differ from request", { taskId: input.task.id, channelId: input.channelId, mismatches: observation.requestMismatches });
        await recordModelPriceSubmissionOutcome({ ...claimed, kind: "response", observation, responseComplete: true });
        const settled = await settleModelPricePoints({ ...key, resume: true });
        const current = await getImageTask(input.task.id);
        if (current?.status === "cancelled" || current?.status === "error") {
            await refundPricedImageTask(current);
            return pending();
        }
        return Response.json(tokenBilling ? payload : { data: results.map((result) => ({ url: result.remoteUrl })) }, {
            headers: {
                [SYSTEM_AI_PRICING_STATE_HEADER]: "settled",
                "x-vozeb-pro-points-cost": settled.reservation.settlement!.chargedPoints,
                "x-vozeb-pro-points-record-id": settled.reservation.chargeRecordId!,
                "x-vozeb-pro-points-remaining": String(settled.snapshot.totalPoints),
            },
        });
    } catch (error) {
        try {
            await recordModelPriceSubmissionOutcome({ ...claimed, kind: "unknown", reason: "transport_error" });
        } catch {
            /* The durable claim forbids resubmission. */
        }
        console.error("Priced image task needs recovery", { taskId: input.task.id, errorType: error instanceof Error ? error.name : "unknown" });
        return pending();
    }
}

/** Never creates a new upstream attempt; even an interrupted preparation needs explicit resolution. */
export async function recoverPricedImageTask(task: ImageTask) {
    if (task.billingMode !== "official-usage") return null;
    const reference = referenceFor(task);
    if (!reference) {
        const attempt = task.attempts?.find((item) => item.attemptNo === task.attemptNo);
        return attempt && attempt.status !== "running" ? { state: "needs_review" as const, reason: pendingMessage } : null;
    }
    const key = identity(task, reference);
    if (reference.preparationStop) {
        await stopModelPricePreparation({ ...key, taskId: task.id, taskType: "image", attemptNo: reference.attemptNo, ...reference.preparationStop });
        await finishImageTaskBilling({ taskId: task.id, ...key });
        return { state: "failed" as const, error: "原图片计费准备已撤销，本次未提交上游，预留已退回" };
    }
    let saved = await getModelPriceReservation(key);
    if (reference.review) saved = await reviewModelPriceSubmission({ ...key, review: reference.review.decision });
    if (!saved && reference.preparation?.phase === "finished") {
        await finishImageTaskBilling({ taskId: task.id, ...key });
        return { state: "failed" as const, error: "原图片计费预检已结束，本次未提交上游" };
    }
    if (saved?.status === "reserved" && saved.submission?.phase === "not_charged" && saved.submission.noChargeEvidence) {
        await releaseModelPricePoints({ ...key, reason: "confirmed-no-charge", evidence: saved.submission.noChargeEvidence });
        await finishImageTaskBilling({ taskId: task.id, ...key });
        return { state: "failed" as const, error: "原图片请求已核实未计费，预留已退回" };
    }
    if (saved?.status === "released") return { state: "failed" as const, error: "原图片预留已释放，本次尝试已结束" };
    const reviewed = reference.review?.decision.outcome;
    const response = reviewed?.kind === "response" ? { results: reference.review!.results!, observation: reviewed.observation } : task.pricedResponses?.find((item) => item.requestId === reference.requestId);
    if (!saved?.submission || !response) return { state: "needs_review" as const, reason: pendingMessage };
    try {
        if (!reference.review) await recordModelPriceSubmissionOutcome({ ...key, claimId: saved.submission.id, kind: "response", observation: response.observation, responseComplete: true });
        const settled = await settleModelPricePoints({ ...key, resume: true });
        return { state: "completed" as const, results: response.results, pointsCost: Number(settled.reservation.settlement!.chargedPoints), pointsRecordId: settled.reservation.chargeRecordId!, pointsRemaining: settled.snapshot.totalPoints };
    } catch (error) {
        console.error("Priced image settlement recovery incomplete", { taskId: task.id, errorType: error instanceof Error ? error.name : "unknown" });
        return { state: "needs_review" as const, reason: pendingMessage };
    }
}

export async function refundPricedImageTask(task: ImageTask) {
    if (task.billingMode !== "official-usage" || !["cancelled", "error"].includes(task.status)) return false;
    const reference = referenceFor(task);
    if (!reference) return true;
    const key = identity(task, reference);
    if (reference.preparationStop) await stopModelPricePreparation({ ...key, taskId: task.id, taskType: "image", attemptNo: reference.attemptNo, ...reference.preparationStop });
    let saved = await getModelPriceReservation(key);
    if (!saved && reference.preparation?.phase === "preparing" && !reference.preparationStop) return false;
    if (!saved || saved.status === "released") {
        await finishImageTaskBilling({ taskId: task.id, ...key });
        return true;
    }
    if (saved.status === "reserved") {
        if (!saved.submission) {
            await releaseModelPricePoints({ ...key, reason: "not-submitted", evidence: "图片任务失败或取消，尚未取得上游提交许可" });
            await finishImageTaskBilling({ taskId: task.id, ...key });
            return true;
        }
        await recoverPricedImageTask(task);
        saved = await getModelPriceReservation(key);
    }
    if (saved?.status === "released") {
        await finishImageTaskBilling({ taskId: task.id, ...key });
        return true;
    }
    if (saved?.status !== "settled" || !saved.settledUsage) return false;
    await refundModelPricePoints({ ...key, refundId: `image-task:${task.id}:attempt:${reference.attemptNo}:refund`, usage: saved.settledUsage, units: saved.units, evidence: "图片任务已取消或业务处理失败，按原计量退回原费用" });
    await updateImageTask(task.id, { billing: { pointsCost: Number(saved.settlement!.chargedPoints), pointsRecordId: saved.chargeRecordId!, refunded: true } });
    await finishImageTaskBilling({ taskId: task.id, ...key });
    return true;
}
