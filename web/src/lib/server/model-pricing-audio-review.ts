import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { PricingConflictError, PricingInputError } from "@/lib/model-pricing";
import { getAudioTask } from "./audio-task-store";
import { mutatePricingWallet } from "./points-wallet-service";
import { validateReviewedAudioUsage } from "./model-pricing-wallet-service";
import { assertAudioObservationSupplement, type PricingSubmissionReview } from "./model-pricing-submission-review";
import { assertAudioPriceResponseReceipt, prepareFrozenAudioPriceResponse, type AudioPriceResponseReceipt, type ResponseIdentity } from "./model-pricing-audio-response";
import { insertAudioPriceReview, readAudioPriceReview, readAudioPriceResponseReceipt } from "./model-pricing-audio-response-store";
import type { AudioUsageObservation } from "./model-pricing-audio-usage";

export type AudioPriceReview = Omit<ResponseIdentity, "claimId"> & {
    taskId: string;
    attemptNo: number;
    decision: PricingSubmissionReview<AudioUsageObservation>;
    originalFingerprint?: string;
    // Only a supplier supplement without an original receipt contains media here.
    response?: AudioPriceResponseReceipt;
};

/** Persist provenance before settlement; the same wallet lock fences late original responses. */
export async function saveAudioPriceReview(
    input: Omit<AudioPriceReview, "decision" | "originalFingerprint" | "response"> & {
        action: "confirm_no_charge" | "provide_metered_result" | "correct_metered_result";
        reviewedBy: string;
        evidence: string;
        response?: string;
    },
) {
    const evidence = input.evidence?.trim();
    if (!input.reviewedBy?.trim() || !evidence) throw new PricingInputError("请填写供应商原请求账单或未计费证明，超时、取消或失败不是计费依据");
    return mutatePricingWallet(input.userId, {}, async (tx) => {
        const saved = await tx.getReservation(input.requestId);
        const task = await getAudioTask(input.taskId, tx.executor);
        const reference = task?.billingRequests?.find((item) => item.attemptNo === task.attemptNo);
        if (
            !task ||
            task.userId !== input.userId ||
            task.billingMode !== "official-usage" ||
            task.attemptNo !== input.attemptNo ||
            reference?.requestId !== input.requestId ||
            reference.requestFingerprint !== input.requestFingerprint ||
            !saved?.frozen.audio ||
            saved.requestFingerprint !== input.requestFingerprint ||
            saved.preparation?.taskType !== "audio" ||
            saved.preparation.taskId !== input.taskId ||
            saved.preparation.claimId !== reference.preparation?.id ||
            reference.preparation.phase !== "finished" ||
            reference.preparationStop ||
            !saved.submission
        )
            throw new PricingConflictError("音频审核缺少完整原任务、准备或提交身份");
        const key = { userId: input.userId, requestId: input.requestId, requestFingerprint: input.requestFingerprint, claimId: saved.submission.id };
        const original = await readAudioPriceResponseReceipt(input.userId, input.requestId, tx.executor);
        if (original) assertAudioPriceResponseReceipt(original, key);
        const existing = await readAudioPriceReview(input.userId, input.requestId, tx.executor);
        let outcome: AudioPriceReview["decision"]["outcome"] = { kind: "not_charged" };
        let response: AudioPriceResponseReceipt | undefined;
        if (input.action === "confirm_no_charge") {
            if (original || saved.submission.response) throw new PricingConflictError("已有原音频响应，不能确认未计费");
        } else {
            let payload: unknown;
            try {
                payload = JSON.parse(input.response || "");
            } catch {
                throw new PricingInputError("请填写供应商完整响应 JSON，包含原音频及完整计量");
            }
            const supplied = prepareFrozenAudioPriceResponse(key, payload, tx.now, saved.frozen.audio);
            const correctedObservation = input.action === "correct_metered_result" ? original?.observation : undefined;
            if (input.action === "correct_metered_result" && !correctedObservation?.invalid.length) throw new PricingConflictError("原音频没有已保存的矛盾计量，请使用补录或恢复");
            if (original && !existing && !correctedObservation) {
                let ready = false;
                try {
                    validateReviewedAudioUsage(saved, original.observation);
                    ready = true;
                } catch (error) {
                    if (!(error instanceof PricingInputError)) throw error;
                }
                if (ready) throw new PricingConflictError("原音频响应完整，请直接恢复已有凭据");
            }
            validateReviewedAudioUsage(saved, supplied.observation, correctedObservation);
            assertAudioObservationSupplement(original?.observation, supplied.observation, correctedObservation);
            if (original && !isDeepStrictEqual(original.audio, supplied.audio)) throw new PricingConflictError("音频补录不能替换原字节、MIME 或候选位置");
            outcome = { kind: "response", observation: supplied.observation, ...(correctedObservation ? { correctedObservation } : {}) };
            if (!original) response = supplied;
        }
        const review: AudioPriceReview = {
            userId: input.userId,
            requestId: input.requestId,
            requestFingerprint: input.requestFingerprint,
            taskId: input.taskId,
            attemptNo: input.attemptNo,
            decision: { id: randomUUID(), claimId: key.claimId, reviewedBy: input.reviewedBy, reviewedAt: tx.now, evidence, outcome },
            ...(original ? { originalFingerprint: original.fingerprint } : {}),
            ...(response ? { response } : {}),
        };
        if (existing) {
            const comparable = (value: AudioPriceReview) => [
                value.taskId,
                value.attemptNo,
                value.requestFingerprint,
                value.decision.claimId,
                value.decision.reviewedBy,
                value.decision.evidence,
                value.decision.outcome,
                value.originalFingerprint,
                value.response?.fingerprint,
            ];
            if (!isDeepStrictEqual(comparable(existing), comparable(review))) throw new PricingConflictError("原音频审核决定或媒体不能改写");
            return existing;
        }
        if (!task.billingPending || task.status === "success" || saved.status !== "reserved" || saved.submission.phase === "not_charged" || saved.submission.review) throw new PricingConflictError("原音频预留已处理，请恢复已有凭据");
        await insertAudioPriceReview(review, tx.executor);
        return review;
    });
}
