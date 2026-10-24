import { PricingConflictError, PricingInputError } from "@/lib/model-pricing";
import { beginShadowTextCall, completeTextResponse } from "./model-pricing-shadow-call";
import { inspectProviderTokenUsage, type TokenUsageProtocol, type TokenUsageObservation } from "./model-pricing-token-usage";
import {
    claimModelPriceSubmission,
    getModelPriceReservation,
    recordModelPriceSubmissionOutcome,
    refundModelPricePoints,
    releaseModelPricePoints,
    reserveModelPricePoints,
    reviewModelPriceSubmission,
    settleModelPricePoints,
    stopModelPricePreparation,
} from "./model-pricing-wallet-service";
import { claimTextTaskBillingPreparation, finishTextTaskBillingPreparation, finishTextTaskBilling, getTextTask, markTextTaskBillingReview, savePricedTextTaskResponse, type TextTask, type TextTaskBillingRequest } from "./text-task-store";
import { SYSTEM_AI_PRICING_STATE_HEADER } from "./system-ai-billing";

import { observeShadowTextStream } from "./model-pricing-shadow-stream";

type Input = Parameters<typeof beginShadowTextCall>[0] & { task: TextTask; signal: AbortSignal; send(): Promise<Response> };
const object = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const referenceFor = (task: TextTask) => task.billingRequests?.find((item) => item.attemptNo === task.attemptNo);
const identity = (task: TextTask, reference: TextTaskBillingRequest) => ({ userId: task.userId, requestId: reference.requestId, requestFingerprint: reference.requestFingerprint });
const pendingMessage = "原文本请求的计费结果待核对，已保留预留；请检查原任务状态，避免重复提交";
const pending = () => Response.json({ error: pendingMessage }, { status: 409, headers: { [SYSTEM_AI_PRICING_STATE_HEADER]: "pending" } });
const notSubmitted = (message: string) => Response.json({ error: message }, { status: 422, headers: { [SYSTEM_AI_PRICING_STATE_HEADER]: "not-submitted" } });

/** Store only the public answer, never reasoning blocks or the raw provider body. */
export function publicPricedTextContent(protocol: TokenUsageProtocol, payload: unknown) {
    const body = object(payload);
    if (protocol === "openai-chat") {
        const content = object(object(list(body.choices)[0]).message).content;
        return typeof content === "string"
            ? content.trim()
            : list(content)
                  .filter((item) => object(item).type === "text")
                  .map((item) => object(item).text || "")
                  .join("")
                  .trim();
    }
    if (protocol === "anthropic-messages")
        return list(body.content)
            .filter((item) => object(item).type === "text")
            .map((item) => object(item).text || "")
            .join("")
            .trim();
    if (protocol === "gemini-generate")
        return list(object(object(list(body.candidates)[0]).content).parts)
            .filter((item) => !object(item).thought)
            .map((item) => object(item).text || "")
            .join("")
            .trim();
    return list(body.output)
        .filter((item) => object(item).type === "message")
        .flatMap((item) => list(object(item).content))
        .filter((item) => object(item).type === "output_text")
        .map((item) => object(item).text || "")
        .join("")
        .trim();
}

/** The only send permission comes from a committed wallet claim. Replays never send. */
export async function executePricedTextTask(input: Input): Promise<Response> {
    const reference = referenceFor(input.task);
    if (input.task.billingMode !== "official-usage" || input.task.userId !== input.userId || reference?.requestId !== input.requestId || reference.requestFingerprint !== input.requestFingerprint) throw new PricingInputError("文本任务计费身份不匹配");
    const key = identity(input.task, reference);
    let preparationId: string | undefined;
    try {
        preparationId = await claimTextTaskBillingPreparation({ taskId: input.task.id, ...key });
    } catch (error) {
        if (error instanceof PricingConflictError) return pending();
        throw error;
    }
    if (!preparationId) return pending();
    const finishPreparation = () => finishTextTaskBillingPreparation({ taskId: input.task.id, ...key, claimId: preparationId! });
    let call: Awaited<ReturnType<typeof beginShadowTextCall>>;
    try {
        call = await beginShadowTextCall(input);
        if (!call.protocol || !call.frozen || call.reasons.length || !call.requestBound?.ready) throw new PricingInputError("该文本调用缺少已审核的价目、用量契约或请求上限");
        await reserveModelPricePoints({
            ...key,
            preparation: { taskId: input.task.id, claimId: preparationId },
            modelId: input.modelId,
            usageKind: "text",
            units: 1,
            ...call.frozen,
            textRequest: { contract: call.frozen.contract, rules: call.frozen.rules, channelId: input.channelId, requestedModel: input.requestedModel, protocol: call.protocol, payload: input.payload },
        });
        await finishPreparation();
    } catch (error) {
        // A failed commit acknowledgement does not prove that no reservation exists.
        if (!(error instanceof PricingInputError) || (await getModelPriceReservation(key))) return pending();
        await finishPreparation();
        await finishTextTaskBilling({ taskId: input.task.id, ...key });
        return notSubmitted(error instanceof PricingInputError ? error.message : "计费预检未完成，本次未提交上游");
    }
    const latest = await getTextTask(input.task.id);
    if (input.signal.aborted || latest?.status !== "running") {
        const saved = await getModelPriceReservation(key);
        if (saved?.submission) return pending();
        await releaseModelPricePoints({ ...key, reason: "not-submitted", evidence: "文本任务已取消或结束，尚未取得上游提交许可" });
        await finishTextTaskBilling({ taskId: input.task.id, ...key });
        return notSubmitted("文本任务已取消或结束，本次未提交上游");
    }
    const claim = await claimModelPriceSubmission(key);
    if (!claim.claimed) {
        if (claim.reservation.status === "released") {
            await finishTextTaskBilling({ taskId: input.task.id, ...key });
            return notSubmitted("用户有待补扣积分，本次未提交上游");
        }
        return pending();
    }
    const claimed = { ...key, claimId: claim.reservation.submission!.id };
    const saveAndSettle = async (content: string, observation: TokenUsageObservation) => {
        await savePricedTextTaskResponse({ taskId: input.task.id, ...key, content, observation });
        try {
            await recordModelPriceSubmissionOutcome({ ...claimed, kind: "response", observation, responseComplete: true });
            const settled = await settleModelPricePoints({ ...key, resume: true });
            if (settled.reservation.billingWarnings?.length)
                console.warn("Priced text identity anomaly", {
                    taskId: input.task.id,
                    requestId: key.requestId,
                    modelId: input.modelId,
                    channelId: input.channelId,
                    contractId: settled.reservation.frozen.contractId,
                    ruleId: settled.reservation.frozen.text?.rules?.id,
                    warnings: settled.reservation.billingWarnings,
                });
            const current = await getTextTask(input.task.id);
            const refunded = current?.status === "cancelled" || current?.status === "error";
            if (refunded) await refundPricedTextTask(current);
            return { settled, refunded, billingPending: false as const };
        } catch (error) {
            try {
                await markTextTaskBillingReview({ taskId: input.task.id, ...key, reason: error instanceof PricingInputError ? error.message : "账务暂时无法完成，请核对原请求" });
            } catch (markError) {
                console.error("Priced text billing review state unavailable", { ...key, errorType: markError instanceof Error ? markError.name : "unknown" });
            }
            console.error("Priced text response delivered with pending billing", { ...key, errorType: error instanceof Error ? error.name : "unknown" });
            return { billingPending: true as const };
        }
    };
    try {
        const response = await input.send();
        if (!response.ok) {
            await response.body?.cancel();
            await recordModelPriceSubmissionOutcome({ ...claimed, kind: "unknown", reason: "result_unknown" });
            return pending();
        }
        const mediaType = response.headers.get("content-type") || "";
        const streamFormat = /^\s*text\/event-stream\b/i.test(mediaType) ? "sse" : call.protocol === "gemini-generate" && /^\s*application\/(?:x-)?ndjson\b/i.test(mediaType) ? "ndjson" : undefined;
        if (response.body && streamFormat) {
            const parts = new Map<number, string>();
            const body = observeShadowTextStream(
                response.body,
                call.protocol!,
                async (outcome) => {
                    try {
                        const content = [...parts.entries()]
                            .sort(([left], [right]) => left - right)
                            .map(([, text]) => text)
                            .join("")
                            .trim();
                        if (outcome.failure || outcome.unavailable || !outcome.stream?.complete || !content) {
                            await recordModelPriceSubmissionOutcome({ ...claimed, kind: "unknown", reason: "incomplete_response" });
                            return;
                        }
                        await saveAndSettle(content, outcome.stream.observation);
                    } catch (error) {
                        try {
                            await recordModelPriceSubmissionOutcome({ ...claimed, kind: "unknown", reason: "transport_error" });
                        } catch {
                            /* The durable claim still forbids resubmission. */
                        }
                        console.error("Priced text stream needs recovery", { ...key, errorType: error instanceof Error ? error.name : "unknown" });
                    } finally {
                        parts.clear();
                    }
                },
                streamFormat,
                (index, text, replace) => parts.set(index, replace ? text : (parts.get(index) || "") + text),
                response.headers,
            );
            return new Response(body, { headers: { "content-type": mediaType, "cache-control": "no-store", "x-accel-buffering": "no", [SYSTEM_AI_PRICING_STATE_HEADER]: "streaming" } });
        }
        const payload: unknown = await response.json();
        const content = publicPricedTextContent(call.protocol!, payload);
        if (!completeTextResponse(call.protocol, payload) || !content) {
            await recordModelPriceSubmissionOutcome({ ...claimed, kind: "unknown", reason: "incomplete_response" });
            return pending();
        }
        const observation = inspectProviderTokenUsage(call.protocol!, payload, response.headers);
        // Save the answer first so a later wallet write failure can recover without another model call.
        const result = await saveAndSettle(content, observation);
        if (result.billingPending) return Response.json(payload, { headers: { [SYSTEM_AI_PRICING_STATE_HEADER]: "billing-pending" } });
        const { settled, refunded } = result;
        if (refunded) {
            return Response.json({ error: "文本任务已取消或失败，已按原账单退回积分" }, { status: 409, headers: { [SYSTEM_AI_PRICING_STATE_HEADER]: "refunded" } });
        }
        return Response.json(payload, {
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
            /* The durable claim still forbids resubmission. */
        }
        console.error("Priced text task needs recovery", { ...key, errorType: error instanceof Error ? error.name : "unknown" });
        return pending();
    }
}

export async function recoverPricedTextTask(task: TextTask) {
    if (task.billingMode !== "official-usage") return null;
    const reference = referenceFor(task);
    if (!reference) return null;
    const key = identity(task, reference);
    if (reference.preparationStop) {
        await stopModelPricePreparation({ ...key, taskId: task.id, attemptNo: reference.attemptNo, ...reference.preparationStop });
        return { state: "failed" as const, error: "原计费准备已撤销，本次未提交上游，预留已退回" };
    }
    let saved = await getModelPriceReservation(key);
    if (!saved)
        return reference.preparation?.phase === "preparing"
            ? { state: "needs_review" as const, error: "原文本计费准备结果待核对，未取得可安全重新提交的依据" }
            : reference.preparation?.phase === "finished"
              ? { state: "failed" as const, error: "原计费预检已结束，本次未提交上游" }
              : null;
    if (reference.review) {
        saved = await reviewModelPriceSubmission({ ...key, review: reference.review.decision });
        if (reference.review.decision.outcome.kind === "not_charged") {
            await releaseModelPricePoints({ ...key, reason: "confirmed-no-charge", evidence: reference.review.decision.evidence });
            return { state: "failed" as const, error: "原请求已核实未计费，预留积分已退回" };
        }
    }
    if (saved.status === "reserved" && !saved.submission) return { state: "needs_review" as const, error: "原文本请求已预留，尚无完整提交响应，请检查原任务状态" };
    if (saved.status === "released") return { state: "failed" as const, error: "原文本预留已释放，本次尝试已结束" };
    const reviewed = reference.review?.decision.outcome;
    const response = reviewed?.kind === "response" ? { content: reference.review!.content!, observation: reviewed.observation } : task.pricedResponses?.find((item) => item.requestId === reference.requestId);
    if (!saved.submission || !response) return { state: "needs_review" as const, error: pendingMessage };
    try {
        if (!reference.review) await recordModelPriceSubmissionOutcome({ ...key, claimId: saved.submission.id, kind: "response", observation: response.observation, responseComplete: true });
        const settled = await settleModelPricePoints({ ...key, resume: true });
        return { state: "completed" as const, content: response.content, pointsCost: Number(settled.reservation.settlement!.chargedPoints), pointsRecordId: settled.reservation.chargeRecordId!, pointsRemaining: settled.snapshot.totalPoints };
    } catch (error) {
        console.error("Priced text settlement recovery incomplete", { ...key, errorType: error instanceof Error ? error.name : "unknown" });
        return { state: "completed" as const, content: response.content, billingPending: true as const };
    }
}

/** Business failure refunds use the original usage and original price, including zero-value charges. */
export async function refundPricedTextTask(task: TextTask) {
    if (task.billingMode !== "official-usage" || !["cancelled", "error"].includes(task.status)) return false;
    const reference = referenceFor(task);
    if (!reference) return true;
    const key = identity(task, reference);
    if (reference.preparationStop) await stopModelPricePreparation({ ...key, taskId: task.id, attemptNo: reference.attemptNo, ...reference.preparationStop });
    let saved = await getModelPriceReservation(key);
    if (!saved && reference.preparation?.phase === "preparing" && !reference.preparationStop) return false;
    if (!saved || saved.status === "released") {
        await finishTextTaskBilling({ taskId: task.id, ...key });
        return true;
    }
    if (saved.status === "reserved") {
        if (!saved.submission) {
            await releaseModelPricePoints({ ...key, reason: "not-submitted", evidence: "文本任务失败或取消，尚未取得上游提交许可" });
            await finishTextTaskBilling({ taskId: task.id, ...key });
            return true;
        }
        await recoverPricedTextTask(task);
        saved = await getModelPriceReservation(key);
        if (saved?.status === "released") {
            await finishTextTaskBilling({ taskId: task.id, ...key });
            return true;
        }
    }
    if (!saved?.settledUsage) return false;
    await refundModelPricePoints({ ...key, refundId: `text-task:${task.id}:attempt:${reference.attemptNo}:refund`, usage: saved.settledUsage, units: saved.units, evidence: "文本任务失败或取消，按原调用价目退回" });
    await finishTextTaskBilling({ taskId: task.id, ...key });
    return true;
}
