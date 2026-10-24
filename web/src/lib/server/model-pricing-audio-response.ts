import { OPENAI_WALLET_AUDIO_MIME, type OpenAiWalletAudioFormat } from "./model-pricing-audio-wallet-request";
import type { OpenAiAudioRequestBound } from "./model-pricing-openai-audio-request";
import { createHash } from "node:crypto";
import { PricingConflictError, PricingInputError } from "@/lib/model-pricing";
import { inspectAudioUsage, type AudioUsageObservation } from "./model-pricing-audio-usage";
import { reviewModelPriceSubmission, getModelPriceReservation, recordModelPriceSubmissionOutcome, settleModelPricePoints, type PricingWalletReservation } from "./model-pricing-wallet-service";
import { mutatePricingWallet } from "./points-wallet-service";
import { readAudioPriceReview, insertAudioPriceResponseReceipt, readAudioPriceResponseReceipt } from "./model-pricing-audio-response-store";

export type ResponseIdentity = Pick<PricingWalletReservation, "userId" | "requestId" | "requestFingerprint"> & { claimId: string };
type ResponseClock = { now?: Date; timeZone?: string };
export type AudioPriceResponseReceipt = ResponseIdentity & {
    observedAt: string;
    // Cleared bytes retain their original fingerprint, meters and part metadata for audit.
    mediaPurgedAt?: string;
    fingerprint: string;
    observation: AudioUsageObservation;
    audio: Array<{ candidateIndex: number; partIndex: number; mimeType: string; data: string }>;
};
const object = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const observationKey = (value: AudioUsageObservation) => [
    value.protocol,
    value.reportedModel,
    value.serviceTier,
    value.hasAudio,
    Object.entries(value.quantities).sort(([a], [b]) => a.localeCompare(b)),
    [...value.missing].sort(),
    [...value.invalid].sort(),
];
const fingerprint = (value: Omit<AudioPriceResponseReceipt, "observedAt" | "fingerprint">) =>
    createHash("sha256")
        .update(JSON.stringify([value.userId, value.requestId, value.requestFingerprint, value.claimId, observationKey(value.observation), value.audio.map((item) => [item.candidateIndex, item.partIndex, item.mimeType, item.data])]))
        .digest("hex");

function assertReservation(saved: PricingWalletReservation | undefined, input: ResponseIdentity) {
    if (!saved?.frozen.audio || saved.userId !== input.userId || saved.requestId !== input.requestId || saved.requestFingerprint !== input.requestFingerprint || !input.claimId || saved.submission?.id !== input.claimId)
        throw new PricingConflictError("音频响应不属于原预留与提交认领");
    if (saved.status === "released" || saved.submission.phase === "not_charged" || saved.submission.review) throw new PricingConflictError("音频预留已释放、确认未计费或存在人工决定");
    return saved;
}

export function assertAudioPriceResponseReceipt(receipt: AudioPriceResponseReceipt, input: ResponseIdentity) {
    if (receipt.mediaPurgedAt) throw new PricingConflictError("原任务已删除，私有音频媒体已按生命周期清理");
    if (receipt.userId !== input.userId || receipt.requestId !== input.requestId || receipt.requestFingerprint !== input.requestFingerprint || receipt.claimId !== input.claimId || receipt.fingerprint !== fingerprint(receipt))
        throw new PricingConflictError("原音频响应身份或内容校验失败");
}

export function prepareAudioPriceResponse(input: ResponseIdentity, payload: unknown, observedAt: string): AudioPriceResponseReceipt {
    const audio: AudioPriceResponseReceipt["audio"] = [];
    const candidates = object(payload).candidates;
    if (Array.isArray(candidates))
        for (const [candidateIndex, candidate] of candidates.entries()) {
            const parts = object(object(candidate).content).parts;
            if (!Array.isArray(parts)) continue;
            for (const [partIndex, part] of parts.entries()) {
                const inline = object(object(part).inlineData);
                if (typeof inline.mimeType !== "string" || !inline.mimeType.startsWith("audio/")) continue;
                if (typeof inline.data !== "string" || !inline.data) throw new PricingInputError("原音频数据为空");
                const bytes = Buffer.from(inline.data, "base64");
                if (!bytes.length || bytes.toString("base64") !== inline.data) throw new PricingInputError("原音频 Base64 无效");
                // Existing Gemini decoding resource contract, not a new model capability limit.
                if (bytes.length > 30 * 1024 * 1024) throw new PricingInputError("Gemini 音频结果超过 30MB 限制");
                audio.push({ candidateIndex, partIndex, mimeType: inline.mimeType, data: inline.data });
            }
        }
    if (!audio.length) throw new PricingInputError("没有可持久化的原音频响应");
    const receipt = { userId: input.userId, requestId: input.requestId, requestFingerprint: input.requestFingerprint, claimId: input.claimId, observedAt, observation: inspectAudioUsage("gemini-tts", payload), audio };
    return { ...receipt, fingerprint: fingerprint(receipt) };
}

/** Chat Completions audio bytes use the format of the original request, not response text or current settings. */
function prepareOpenAiAudioPriceResponse(input: ResponseIdentity, payload: unknown, observedAt: string, bound: OpenAiAudioRequestBound, format: OpenAiWalletAudioFormat | undefined): AudioPriceResponseReceipt {
    if (!format || !Object.hasOwn(OPENAI_WALLET_AUDIO_MIME, format)) throw new PricingInputError("原音频请求缺少可恢复的冻结格式");
    const choices = object(payload).choices;
    if (!Array.isArray(choices) || !choices.length || choices.length > bound.candidateCount) throw new PricingInputError("原音频候选数量与冻结请求不匹配");
    const indexes = new Set<number>();
    const audio = choices
        .map((choice) => {
            const item = object(choice);
            const candidateIndex = item.index;
            if (typeof candidateIndex !== "number" || !Number.isSafeInteger(candidateIndex) || candidateIndex < 0 || candidateIndex >= bound.candidateCount || indexes.has(candidateIndex)) throw new PricingInputError("原音频候选位置无效或重复");
            indexes.add(candidateIndex);
            const data = object(object(item.message).audio).data;
            if (typeof data !== "string" || !data || Buffer.from(data, "base64").toString("base64") !== data) throw new PricingInputError("原音频 Base64 无效");
            return { candidateIndex, partIndex: 0, mimeType: OPENAI_WALLET_AUDIO_MIME[format], data };
        })
        .sort((a, b) => a.candidateIndex - b.candidateIndex);
    const receipt = { ...input, observedAt, observation: inspectAudioUsage("openai-chat-audio", payload), audio };
    return { ...receipt, fingerprint: fingerprint(receipt) };
}

export function prepareFrozenAudioPriceResponse(input: ResponseIdentity, payload: unknown, observedAt: string, frozen: NonNullable<PricingWalletReservation["frozen"]["audio"]>) {
    if (frozen.contract.protocol !== frozen.bound.protocol) throw new PricingInputError("原音频契约与请求协议不匹配");
    return frozen.bound.protocol === "openai-chat-audio" ? prepareOpenAiAudioPriceResponse(input, payload, observedAt, frozen.bound, frozen.responseFormat) : prepareAudioPriceResponse(input, payload, observedAt);
}

/** Save original bytes before metering settlement or conversion. No prompt, key or full response is retained. */
export async function savePricedAudioResponse(input: ResponseIdentity & ResponseClock & { payload: unknown; responseComplete: true }) {
    if (input.responseComplete !== true) throw new PricingInputError("原音频响应必须完整结束");
    return mutatePricingWallet(input.userId, input, async (tx) => {
        const reservation = assertReservation(await tx.getReservation(input.requestId), input);
        if (await readAudioPriceReview(input.userId, input.requestId, tx.executor)) throw new PricingConflictError("已有音频人工决定，不能追加或改写原响应");
        const receipt = prepareFrozenAudioPriceResponse({ userId: input.userId, requestId: input.requestId, requestFingerprint: input.requestFingerprint, claimId: input.claimId }, input.payload, tx.now, reservation.frozen.audio!);
        const existing = await readAudioPriceResponseReceipt(input.userId, input.requestId, tx.executor);
        if (existing) {
            assertAudioPriceResponseReceipt(existing, input);
            if (existing.fingerprint !== receipt.fingerprint) throw new PricingConflictError("已保存的原音频响应不能改写");
            return { receipt: existing, applied: false };
        }
        if (reservation.status !== "reserved") throw new PricingConflictError("已结算请求不能补造原音频响应");
        const original = reservation.submission?.response?.observation;
        if (
            original &&
            ((original.protocol !== "gemini-tts" && original.protocol !== "openai-chat-audio") || original.protocol !== receipt.observation.protocol || JSON.stringify(observationKey(original)) !== JSON.stringify(observationKey(receipt.observation)))
        )
            throw new PricingConflictError("原音频响应与已保存计量不一致");
        await insertAudioPriceResponseReceipt(receipt, tx.executor);
        return { receipt, applied: true };
    });
}

/** Recovery reads exactly this response and frozen price; it never sends or authorizes another upstream request. */
export async function recoverPricedAudioResponse(input: ResponseIdentity & ResponseClock) {
    const review = await readAudioPriceReview(input.userId, input.requestId);
    if (review) {
        await reviewModelPriceSubmission({ ...input, review: review.decision });
        if (review.decision.outcome.kind !== "response") return;
        const original = await readAudioPriceResponseReceipt(input.userId, input.requestId);
        const receipt = original || review.response;
        if (!receipt || original?.fingerprint !== review.originalFingerprint) throw new PricingConflictError("音频审核的原媒体凭据已变化");
        assertAudioPriceResponseReceipt(receipt, input);
        const settled = await settleModelPricePoints({ ...input, resume: true });
        return { ...settled, receipt };
    }
    assertReservation(await getModelPriceReservation(input), input);
    const receipt = await readAudioPriceResponseReceipt(input.userId, input.requestId);
    if (!receipt) return;
    assertAudioPriceResponseReceipt(receipt, input);
    await recordModelPriceSubmissionOutcome({ ...input, kind: "response", observation: receipt.observation, responseComplete: true });
    const settled = await settleModelPricePoints({ ...input, resume: true });
    return { ...settled, receipt };
}
