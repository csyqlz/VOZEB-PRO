import { isDeepStrictEqual } from "node:util";
import { mutatePricingWallet } from "./points-wallet-service";
import { mutateStoredGenerationTask } from "./generation-task-store";
import { GENERATION_TASK_RETENTION_MS } from "./generation-task-retention";
import { startGenerationAttempt } from "./generation-attempt";
import { generationModelId } from "./generation-channel";
import { hasAudioPriceResponseReceipt, readAudioPriceReview } from "./model-pricing-audio-response-store";
import { PricingConflictError, PricingInputError } from "@/lib/model-pricing";
import { isAuthInputError, isQuotaExceededError } from "@/lib/auth/store";
import { beginShadowAudioCall } from "./model-pricing-shadow-audio-call";
import {
    reviewModelPriceSubmission,
    stopModelPricePreparation,
    claimModelPriceSubmission,
    getModelPriceReservation,
    recordModelPriceSubmissionOutcome,
    refundModelPricePoints,
    releaseModelPricePoints,
    reserveModelPricePoints,
} from "./model-pricing-wallet-service";
import { claimAudioTaskBillingPreparation, finishAudioTaskBillingPreparation, finishAudioTaskBilling, getAudioTask, updateAudioTask, type AudioTask, type AudioTaskBillingRequest } from "./audio-task-store";
import { savePricedAudioResponse, recoverPricedAudioResponse } from "./model-pricing-audio-response";
import { SYSTEM_AI_PRICING_STATE_HEADER } from "./system-ai-billing";

type Input = Parameters<typeof beginShadowAudioCall>[0] & { task: AudioTask; signal: AbortSignal; send(): Promise<Response> };
const referenceFor = (task: AudioTask) => task.billingRequests?.find((item) => item.attemptNo === task.attemptNo);
const identity = (task: AudioTask, reference: AudioTaskBillingRequest) => ({ userId: task.userId, requestId: reference.requestId, requestFingerprint: reference.requestFingerprint });
export const audioPricingPendingMessage = "原音频请求的计费或保存结果待核对，已保留原尝试；请检查原任务状态，避免重复提交";
const pending = () => Response.json({ error: audioPricingPendingMessage }, { status: 409, headers: { [SYSTEM_AI_PRICING_STATE_HEADER]: "pending" } });
const notSubmitted = (message: string) => Response.json({ error: message }, { status: 422, headers: { [SYSTEM_AI_PRICING_STATE_HEADER]: "not-submitted" } });

/** The original response is private and durable before settlement or local media conversion. */
export async function executePricedAudioTask(input: Input): Promise<Response> {
    const reference = referenceFor(input.task);
    if (input.task.billingMode !== "official-usage" || input.task.userId !== input.userId || reference?.requestId !== input.requestId || reference.requestFingerprint !== input.requestFingerprint) throw new PricingInputError("音频任务计费身份不匹配");
    const key = identity(input.task, reference);
    let preparationId: string | undefined;
    try {
        preparationId = await claimAudioTaskBillingPreparation({ taskId: input.task.id, ...key });
    } catch (error) {
        if (error instanceof PricingConflictError) return pending();
        throw error;
    }
    if (!preparationId) return pending();
    const finishPreparation = () => finishAudioTaskBillingPreparation({ taskId: input.task.id, ...key, claimId: preparationId! });
    try {
        const call = await beginShadowAudioCall(input);
        if (!call.frozen || call.reasons.length || !call.protocol || call.frozen.contract.protocol !== call.protocol || !input.declaredProtocol) throw new PricingInputError("该音频调用缺少已审核的常规价目、契约或请求上界");
        await reserveModelPricePoints({
            ...key,
            preparation: { taskId: input.task.id, claimId: preparationId, taskType: "audio" },
            modelId: input.modelId,
            usageKind: "audio",
            units: 1,
            ...call.frozen,
            audioRequest: { contract: call.frozen.contract, channelId: input.channelId, requestedModel: input.requestedModel, declaredProtocol: input.declaredProtocol, payload: input.payload },
        });
        await finishPreparation();
    } catch (error) {
        if ((!(error instanceof PricingInputError) && !isAuthInputError(error) && !isQuotaExceededError(error)) || (await getModelPriceReservation(key))) return pending();
        await finishPreparation();
        await finishAudioTaskBilling({ taskId: input.task.id, ...key });
        return notSubmitted(error.message);
    }
    const latest = await getAudioTask(input.task.id);
    if (input.signal.aborted || latest?.status !== "running") {
        const saved = await getModelPriceReservation(key);
        if (saved?.submission) return pending();
        await releaseModelPricePoints({ ...key, reason: "not-submitted", evidence: "音频任务已取消或结束，尚未取得上游提交许可" });
        await finishAudioTaskBilling({ taskId: input.task.id, ...key });
        return notSubmitted("音频任务已取消或结束，本次未提交上游");
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
            await finishAudioTaskBilling({ taskId: input.task.id, ...key });
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
        await savePricedAudioResponse({ ...claimed, payload: await response.json(), responseComplete: true });
        const settled = await recoverPricedAudioResponse(claimed);
        if (!settled) return pending();
        const current = await getAudioTask(input.task.id);
        if (current?.status === "cancelled" || current?.status === "error") {
            await refundPricedAudioTask(current);
            return pending();
        }
        // The signed task runtime reads its private receipt; raw audio never enters the public proxy response.
        return Response.json(
            { received: true },
            {
                headers: {
                    [SYSTEM_AI_PRICING_STATE_HEADER]: "settled",
                    "x-vozeb-pro-points-cost": settled.reservation.settlement!.chargedPoints,
                    "x-vozeb-pro-points-record-id": settled.reservation.chargeRecordId!,
                    "x-vozeb-pro-points-remaining": String(settled.snapshot.totalPoints),
                },
            },
        );
    } catch (error) {
        try {
            await recordModelPriceSubmissionOutcome({ ...claimed, kind: "unknown", reason: "transport_error" });
        } catch {
            /* The durable claim forbids resubmission. */
        }
        console.error("Priced audio task needs recovery", { taskId: input.task.id, errorType: error instanceof Error ? error.name : "unknown" });
        return pending();
    }
}

/** Recovery cannot create a new upstream attempt, including interrupted preparation. */
export async function recoverPricedAudioTask(task: AudioTask) {
    if (task.billingMode !== "official-usage") return null;
    const reference = referenceFor(task);
    if (!reference) {
        const attempt = task.attempts?.find((item) => item.attemptNo === task.attemptNo);
        return attempt && attempt.status !== "running" ? { state: "needs_review" as const, reason: audioPricingPendingMessage } : null;
    }
    const key = identity(task, reference);
    if (reference.preparationStop) {
        await stopModelPricePreparation({ ...key, taskId: task.id, taskType: "audio", attemptNo: reference.attemptNo, ...reference.preparationStop });
        await finishAudioTaskBilling({ taskId: task.id, ...key });
        return { state: "failed" as const, error: "原音频计费准备已撤销，本次未提交上游" };
    }
    let saved = await getModelPriceReservation(key);
    const review = await readAudioPriceReview(task.userId, reference.requestId);
    if (review) saved = await reviewModelPriceSubmission({ ...key, review: review.decision });
    if (!saved && reference.preparation?.phase === "finished") {
        await finishAudioTaskBilling({ taskId: task.id, ...key });
        return { state: "failed" as const, error: "原音频计费预检已结束，本次未提交上游" };
    }
    if (saved?.status === "reserved" && saved.submission?.phase === "not_charged" && saved.submission.noChargeEvidence) {
        await releaseModelPricePoints({ ...key, reason: "confirmed-no-charge", evidence: saved.submission.noChargeEvidence });
        await finishAudioTaskBilling({ taskId: task.id, ...key });
        return { state: "failed" as const, error: "原音频请求已核实未计费，预留已退回" };
    }
    if (saved?.status === "released") {
        await finishAudioTaskBilling({ taskId: task.id, ...key });
        return { state: "failed" as const, error: "原音频预留已释放，本次尝试已结束" };
    }
    if (!saved?.submission) return { state: "needs_review" as const, reason: audioPricingPendingMessage };
    try {
        const settled = await recoverPricedAudioResponse({ ...key, claimId: saved.submission.id });
        if (settled)
            return {
                state: "completed" as const,
                protocol: settled.receipt.observation.protocol,
                responseFormat: settled.reservation.frozen.audio?.responseFormat,
                audio: settled.receipt.audio,
                pointsCost: Number(settled.reservation.settlement!.chargedPoints),
                pointsRecordId: settled.reservation.chargeRecordId!,
                pointsRemaining: settled.snapshot.totalPoints,
            };
    } catch (error) {
        console.error("Priced audio settlement recovery incomplete", { taskId: task.id, errorType: error instanceof Error ? error.name : "unknown" });
    }
    return { state: "needs_review" as const, reason: audioPricingPendingMessage };
}

export async function refundPricedAudioTask(task: AudioTask) {
    if (task.billingMode !== "official-usage" || !["cancelled", "error"].includes(task.status)) return false;
    const reference = referenceFor(task);
    if (!reference) return true;
    const key = identity(task, reference);
    if (reference.preparationStop) await stopModelPricePreparation({ ...key, taskId: task.id, taskType: "audio", attemptNo: reference.attemptNo, ...reference.preparationStop });
    let saved = await getModelPriceReservation(key);
    if (!saved && reference.preparation?.phase === "preparing" && !reference.preparationStop) return false;
    if (!saved || saved.status === "released") {
        await finishAudioTaskBilling({ taskId: task.id, ...key });
        return true;
    }
    if (saved.status === "reserved") {
        if (!saved.submission) {
            await releaseModelPricePoints({ ...key, reason: "not-submitted", evidence: "音频任务失败或取消，尚未取得上游提交许可" });
            await finishAudioTaskBilling({ taskId: task.id, ...key });
            return true;
        }
        await recoverPricedAudioTask(task);
        saved = await getModelPriceReservation(key);
    }
    if (saved?.status === "released") {
        await finishAudioTaskBilling({ taskId: task.id, ...key });
        return true;
    }
    if (saved?.status !== "settled" || !saved.settledUsage) return false;
    await refundModelPricePoints({ ...key, refundId: `audio-task:${task.id}:attempt:${reference.attemptNo}:refund`, usage: saved.settledUsage, units: saved.units, evidence: "音频任务已取消或业务处理失败，按原计量退回原费用" });
    await updateAudioTask(task.id, { billing: { pointsCost: Number(saved.settlement!.chargedPoints), pointsRecordId: saved.chargeRecordId!, refunded: true } });
    await finishAudioTaskBilling({ taskId: task.id, ...key });
    return true;
}

/** Serialize candidate consumption with the original wallet proof and private review. */
export async function advancePricedAudioTask(id: string, expectedAttemptNo: number) {
    const owner = await getAudioTask(id);
    if (!owner) throw new PricingConflictError("原音频任务不存在");
    return mutatePricingWallet(owner.userId, {}, async (tx) => {
        const task = await getAudioTask(id, tx.executor);
        const reference = task && referenceFor(task);
        if (!task || task.attemptNo !== expectedAttemptNo) throw new PricingConflictError("原音频尝试已变化");
        if (reference) {
            const saved = await tx.getReservation(reference.requestId);
            if (
                reference.preparation?.phase !== "finished" ||
                reference.preparationStop ||
                (await readAudioPriceReview(task.userId, reference.requestId, tx.executor)) ||
                (await hasAudioPriceResponseReceipt(task.userId, reference.requestId, tx.executor)) ||
                (saved &&
                    (saved.requestFingerprint !== reference.requestFingerprint ||
                        saved.preparation?.taskType !== "audio" ||
                        saved.preparation.taskId !== id ||
                        saved.preparation.claimId !== reference.preparation.id ||
                        saved.status !== "released" ||
                        (saved.submission && (saved.submission.phase !== "not_charged" || !saved.submission.noChargeEvidence || saved.submission.response || saved.submission.review))))
            )
                throw new PricingConflictError("原音频请求尚无安全结束凭据或已有人工决定，不能切换备用渠道");
        }
        return mutateStoredGenerationTask<AudioTask>(
            "audio",
            id,
            GENERATION_TASK_RETENTION_MS,
            (current) => {
                const config = current.candidateConfigs?.[0];
                if (
                    current.userId !== owner.userId ||
                    current.billingMode !== "official-usage" ||
                    current.status !== "running" ||
                    current.attemptNo !== expectedAttemptNo ||
                    current.billingPending ||
                    current.upstream ||
                    current.result ||
                    !config ||
                    !isDeepStrictEqual(referenceFor(current), reference) ||
                    current.attempts?.find((item) => item.attemptNo === expectedAttemptNo)?.status !== "failed"
                )
                    throw new PricingConflictError("原音频尝试尚未结束或已变化，不能切换备用渠道");
                const started = startGenerationAttempt(current.attempts || [], { channelId: config.channelId, model: generationModelId(config), capability: "audio" });
                return { ...current, config, candidateConfigs: current.candidateConfigs!.slice(1), attempts: started.attempts, attemptNo: started.attempt.attemptNo, upstream: undefined, billing: undefined };
            },
            tx.executor,
        );
    });
}
