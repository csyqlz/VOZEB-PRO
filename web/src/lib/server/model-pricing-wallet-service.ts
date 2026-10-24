import { assertAudioPriceResponseReceipt } from "./model-pricing-audio-response";
import { getAudioTask, stopAudioTaskBillingPreparation } from "./audio-task-store";
import { prepareAudioWalletBound, type AudioWalletRequest, type OpenAiWalletAudioFormat } from "./model-pricing-audio-wallet-request";
import { readAudioPriceReview, readAudioPriceResponseReceipt, hasAudioPriceResponseReceipt } from "./model-pricing-audio-response-store";
import { previewObservedAudioQuote, type AudioPriceCallContext } from "./model-pricing-audio-contract";
import { previewOpenAiAudioQuote } from "./model-pricing-openai-audio-contract";
import type { OpenAiAudioRequestBound } from "./model-pricing-openai-audio-request";
import type { AudioRequestBound } from "./model-pricing-audio-request";
import type { AudioUsageObservation } from "./model-pricing-audio-usage";
import { audioUsageFacts, quoteAudioFacts, type AudioUsageFact } from "./model-pricing-audio-facts";
import { getVideoTask, videoTaskAttemptNo, stopVideoTaskBillingPreparation } from "./video-task-store";
import { prepareVideoWalletBound, type VideoWalletRequest } from "./model-pricing-video-wallet-request";
import { previewObservedVideoQuote, type VideoPriceCallContext } from "./model-pricing-video-contract";
import { previewHailuoQuote, type HailuoRequestBound, type HailuoObservation } from "./model-pricing-hailuo-contract";
import type { VideoRequestBound } from "./model-pricing-video-request";
import type { VideoUsageObservation } from "./model-pricing-video-usage";
import { videoUsageFacts, quoteVideoFacts, type VideoUsageFact } from "./model-pricing-video-facts";
import { getImageTask, stopImageTaskBillingPreparation } from "./image-task-store";
import { prepareImageRequestBound, type ImageWalletRequest } from "./model-pricing-image-request";
import { previewObservedImageQuote, type ImagePriceCallContext } from "./model-pricing-image-contract";
import type { ImageUsageObservation } from "./model-pricing-image-usage";
import { imageUsageFacts, quoteImageFacts, type ImageUsageFact } from "./model-pricing-image-facts";
import { createHash, randomUUID } from "node:crypto";
import Fraction from "fraction.js";
import { isDeepStrictEqual } from "node:util";

import { assertRegularPaidPriceItems, officialItemsForTextPriceGroup, PricingConflictError, PricingInputError, quoteSalesPrice, type OfficialPriceVersion, type SalesVersion } from "@/lib/model-pricing";
import type { PointUsageKind, StoredPointRecord } from "@/lib/auth/store-types";
import { pricingDecimal } from "@/lib/model-pricing-precision";
import { preparePointReservation, releasePointReservation, settlePointReservation, refundPointSettlement, pricingWalletNumber, type PointReservation, type SourceExactPoints } from "./model-pricing-reservation";
import { mutatePricingWallet, type PricingWalletTransaction } from "./points-wallet-service";
import { estimateFlatTextRequestQuote, prepareFlatTextRequestBound, validateObservedRequestBound, type FlatTextRequestBound } from "./model-pricing-request-bound";
import { previewObservedFlatTextQuote, type FlatTextPriceContract, type FlatTextCallContext } from "./model-pricing-token-contract";
import type { TextUsageRule } from "@/lib/model-pricing";
import { inspectFlatTextRequestContext } from "./model-pricing-text-request";
import type { TokenUsageObservation, TokenUsageProtocol } from "./model-pricing-token-usage";
import { textUsageFacts, type TextUsageFact } from "./model-pricing-usage-facts";
import { quoteTextFacts } from "./model-pricing-text-fact-quote";
import { readAuthDb } from "@/lib/auth/store-repository";
import { ensurePostgresSchema, isPostgresDatabaseEnabled, postgresQuery } from "./database";
import { ModelPricingWalletRepository } from "./database/model-pricing-wallet-repository";
import { assertAudioObservationSupplement, assertPricingObservationSupplement, assertImageObservationSupplement, assertVideoObservationSupplement, type PricingSubmissionReview } from "./model-pricing-submission-review";
import { publishedPriceMatches, resolvePublishedModelPrice, type PublishedPriceSelection } from "./model-pricing-published-price";
import { getCurrentSalesVersion } from "./model-pricing-store";
import { getFreshAuthSettings } from "@/lib/auth/store";
import { resolveConfiguredModelPointCost } from "@/lib/model-point-cost";
import { getModelPricingAdmission } from "./model-pricing-admission";
import { getModelPricingActivation } from "./model-pricing-activation-store";

import { getTextTask, stopTextTaskBillingPreparation } from "./text-task-store";

type TextWalletRequest = { contract: FlatTextPriceContract & { id: string }; channelId: string; requestedModel: string; protocol: TokenUsageProtocol; payload: unknown; rules?: TextUsageRule };
type FrozenTextWalletContract = { contract: TextWalletRequest["contract"]; rules?: TextUsageRule; bound: Extract<FlatTextRequestBound, { ready: true }>; call: Omit<FlatTextCallContext, "responseComplete">; payloadFingerprint: string };
type PricingUsageObservation = TokenUsageObservation | ImageUsageObservation | VideoUsageObservation | HailuoObservation | AudioUsageObservation;
type FrozenAudioWalletContract = { contract: AudioWalletRequest["contract"]; call: AudioPriceCallContext; bound: AudioRequestBound | OpenAiAudioRequestBound; responseFormat?: OpenAiWalletAudioFormat; payloadFingerprint: string };
type FrozenVideoWalletContract = { contract: VideoWalletRequest["contract"]; call: VideoPriceCallContext; bound: VideoRequestBound | HailuoRequestBound; payloadFingerprint: string };
type FrozenImageWalletContract = { contract: ImageWalletRequest["contract"]; call: Omit<ImagePriceCallContext, "responseComplete">; payloadFingerprint: string };
type PricingSubmissionFailure = "transport_error" | "incomplete_response" | "result_unknown";
type PricingSubmission = {
    id: string;
    phase: "submitting" | "submitted" | "outcome_unknown" | "response_received" | "not_charged";
    startedAt: string;
    updatedAt: string;
    reason?: PricingSubmissionFailure;
    upstreamTaskId?: string;
    noChargeEvidence?: string;
    response?: { observation: PricingUsageObservation; fingerprint: string };
    review?: PricingSubmissionReview<PricingUsageObservation>;
};

export type PricingWalletReservation = {
    userId: string;
    requestId: string;
    requestFingerprint: string;
    modelId: string;
    usageKind: PointUsageKind;
    units: number;
    status: "reserved" | "settled" | "released";
    allocation: PointReservation;
    estimatedHold?: PointReservation;
    unpaidAtSettlement?: string;
    frozen: {
        version: OfficialPriceVersion;
        policy: SalesVersion;
        priceSelection?: PublishedPriceSelection;
        maximumUsage: Record<string, string>;
        maximumQuoteUsage: Record<string, string>;
        contractId: string;
        upperBoundEvidence: string;
        estimatedTokenBilling?: boolean;
        estimatedHoldPoints?: string;
        text?: FrozenTextWalletContract;
        image?: FrozenImageWalletContract;
        video?: FrozenVideoWalletContract;
        audio?: FrozenAudioWalletContract;
    };
    createdAt: string;
    quotaDate: string;
    quotaTracked: boolean;
    submission?: PricingSubmission;
    preparation?: { taskId: string; claimId: string; taskType?: "image" | "video" | "audio" };
    audioMediaPurgedAt?: string;
    completionFingerprint?: string;
    completedAt?: string;
    settlement?: ReturnType<typeof settlePointReservation>;
    release?: ReturnType<typeof releasePointReservation>;
    releaseEvidence?: string;
    chargeRecordId?: string;
    settledUsage?: Record<string, string>;
    settledObservation?: PricingUsageObservation;
    settledSources?: Record<string, "reported" | "reported-zero" | "defaulted-zero">;
    settledUsageFacts?: TextUsageFact[];
    settledQuote?: ReturnType<typeof quoteTextFacts>["quote"];
    settledImageUsageFacts?: ImageUsageFact[];
    settledImageQuote?: ReturnType<typeof quoteImageFacts>["quote"];
    settledAudioUsageFacts?: AudioUsageFact[];
    settledAudioQuote?: ReturnType<typeof quoteAudioFacts>["quote"];
    settledVideoUsageFacts?: VideoUsageFact[];
    settledVideoQuote?: ReturnType<typeof quoteVideoFacts>["quote"];
    billingWarnings?: string[];
    refundedUsage?: Record<string, string>;
    refundedUnits?: number;
    refundedExactPoints?: string;
    quotaRefundedPoints?: string;
};

export type PricingWalletRefund = {
    userId: string;
    requestId: string;
    refundId: string;
    fingerprint: string;
    usage: Record<string, string>;
    units: number;
    evidence: string;
    createdAt: string;
    recordId: string;
    chargeRecordId: string;
    calculation: ReturnType<typeof refundPointSettlement>;
};

type Identity = Pick<PricingWalletReservation, "userId" | "requestId" | "requestFingerprint">;
type ClockInput = { now?: Date; timeZone?: string };
type ReserveInput = Identity &
    ClockInput & { preparation?: { taskId: string; claimId: string; taskType?: "image" | "video" | "audio" }; priceSelection?: PublishedPriceSelection } & Pick<PricingWalletReservation, "modelId" | "usageKind" | "units"> & {
        version: OfficialPriceVersion;
        policy: SalesVersion;
    } & (
        | { textRequest: TextWalletRequest; imageRequest?: never; videoRequest?: never; audioRequest?: never; maximumUsage?: never; contractId?: never; upperBoundEvidence?: never }
        | { textRequest?: never; imageRequest: ImageWalletRequest; videoRequest?: never; audioRequest?: never; maximumUsage?: never; contractId?: never; upperBoundEvidence?: never }
        | { textRequest?: never; imageRequest?: never; videoRequest: VideoWalletRequest; audioRequest?: never; maximumUsage?: never; contractId?: never; upperBoundEvidence?: never }
        | { textRequest?: never; imageRequest?: never; videoRequest?: never; audioRequest: AudioWalletRequest; maximumUsage?: never; contractId?: never; upperBoundEvidence?: never }
        | { textRequest?: never; imageRequest?: never; videoRequest?: never; audioRequest?: never; maximumUsage: Record<string, string>; contractId: string; upperBoundEvidence: string }
    );
type SettleInput = Identity &
    ClockInput &
    (
        | { observation: PricingUsageObservation; responseComplete: boolean; usage?: never; resume?: never }
        | { observation?: never; responseComplete?: never; usage: Record<string, string | number>; resume?: never }
        | { observation?: never; responseComplete?: never; usage?: never; resume: true }
    );

/** Scoped recovery lookup; no balance mutation or new submission permission. */
export async function getModelPriceReservation(input: Identity) {
    identity(input);
    if (isPostgresDatabaseEnabled()) await ensurePostgresSchema();
    const saved = isPostgresDatabaseEnabled()
        ? await new ModelPricingWalletRepository({ query: postgresQuery }).get(input.userId, input.requestId)
        : (await readAuthDb()).pricingReservations.find((item) => item.userId === input.userId && item.requestId === input.requestId);
    if (saved) matching(saved, input);
    return saved;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const quantities = (usage: Record<string, string | number>) =>
    Object.fromEntries(
        Object.entries(usage)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => [key, String(value)]),
    );

function identity(input: Identity) {
    if (!input.userId?.trim() || !input.requestId?.trim() || !/^[a-f0-9]{64}$/.test(input.requestFingerprint)) throw new PricingInputError("预留缺少服务端请求身份或有效指纹");
}

function matching(saved: PricingWalletReservation, input: Identity) {
    if (saved.userId !== input.userId || saved.requestId !== input.requestId || saved.requestFingerprint !== input.requestFingerprint) throw new PricingConflictError("预留身份对应不同请求");
}

function dailyTarget(tx: PricingWalletTransaction) {
    const wallet = tx.dailyWallet();
    return wallet ? { date: wallet.date, planId: wallet.planId, assignmentId: wallet.assignmentId || "", grantedPoints: String(wallet.grantedPoints), remainingPoints: String(wallet.remainingPoints) } : undefined;
}

export function pricingDailySourceKey(allocation: PointReservation) {
    const source = allocation.dailySource;
    return source ? `daily:${digest([source.date, source.planId, source.assignmentId])}` : undefined;
}

async function sourceTotals(tx: PricingWalletTransaction, allocation: PointReservation): Promise<SourceExactPoints> {
    const dailyKey = pricingDailySourceKey(allocation);
    return { daily: dailyKey ? await tx.getExactPoints(dailyKey) : "0", permanent: await tx.getExactPoints("permanent") };
}

async function saveSourceTotals(tx: PricingWalletTransaction, allocation: PointReservation, accruals: ReturnType<typeof settlePointReservation>["sourceAccruals"]) {
    const dailyKey = pricingDailySourceKey(allocation);
    if (dailyKey) await tx.setExactPoints(dailyKey, accruals.daily.exactPoints);
    await tx.setExactPoints("permanent", accruals.permanent.exactPoints);
}

function freezePricing(input: ReserveInput, occurredAt: string, recentOutputTokens?: string, legacyFixedPoints?: number): PricingWalletReservation["frozen"] {
    const { version, policy } = input;
    if (input.audioRequest) {
        if (input.usageKind !== "audio" || input.units !== 1 || input.textRequest || input.imageRequest || input.videoRequest || (input.preparation && input.preparation.taskType !== "audio"))
            throw new PricingInputError("音频计费请求类型或准备身份不匹配");
        const prepared = prepareAudioWalletBound({ version, policy, modelId: input.modelId, priceSelection: input.priceSelection, request: input.audioRequest, occurredAt });
        const { call, bound, maximumUsage, upperBoundEvidence } = prepared;
        return structuredClone({
            version,
            policy,
            ...(input.priceSelection ? { priceSelection: input.priceSelection } : {}),
            maximumUsage,
            maximumQuoteUsage: maximumUsage,
            contractId: input.audioRequest.contract.id,
            upperBoundEvidence,
            audio: { contract: input.audioRequest.contract, call, bound, ...("responseFormat" in prepared ? { responseFormat: prepared.responseFormat } : {}), payloadFingerprint: digest(input.audioRequest.payload) },
        });
    }
    if (input.videoRequest) {
        if (input.usageKind !== "video" || input.units !== 1 || input.textRequest || input.imageRequest || (input.preparation && input.preparation.taskType !== "video")) throw new PricingInputError("视频计费请求类型或准备身份不匹配");
        const { call, bound, maximumUsage, upperBoundEvidence } = prepareVideoWalletBound({ version, policy, modelId: input.modelId, priceSelection: input.priceSelection, request: input.videoRequest, occurredAt });
        return structuredClone({
            version,
            policy,
            ...(input.priceSelection ? { priceSelection: input.priceSelection } : {}),
            maximumUsage,
            maximumQuoteUsage: maximumUsage,
            contractId: input.videoRequest.contract.id,
            upperBoundEvidence,
            video: { contract: input.videoRequest.contract, call, bound, payloadFingerprint: digest(input.videoRequest.payload) },
        });
    }
    if (input.imageRequest) {
        if (input.usageKind !== "image" || input.units !== 1 || input.textRequest || (input.preparation && input.preparation.taskType !== "image")) throw new PricingInputError("图片计费请求类型或准备身份不匹配");
        const { call, maximumUsage, upperBoundEvidence, estimatedTokenBilling, estimatedHoldPoints } = prepareImageRequestBound({
            version,
            policy,
            modelId: input.modelId,
            priceSelection: input.priceSelection,
            request: input.imageRequest,
            occurredAt,
            preserveLegacyReservation: legacyFixedPoints !== undefined,
        });
        return structuredClone({
            version,
            policy,
            ...(input.priceSelection ? { priceSelection: input.priceSelection } : {}),
            maximumUsage,
            maximumQuoteUsage: maximumUsage,
            contractId: input.imageRequest.contract.id,
            upperBoundEvidence,
            ...(estimatedTokenBilling ? { estimatedTokenBilling } : {}),
            ...(estimatedHoldPoints ? { estimatedHoldPoints } : {}),
            image: { contract: input.imageRequest.contract, call, payloadFingerprint: digest(input.imageRequest.payload) },
        });
    }
    if (!input.textRequest) {
        assertRegularPaidPriceItems(version.items);
        return structuredClone({ version, policy, maximumUsage: quantities(input.maximumUsage), maximumQuoteUsage: quantities(input.maximumUsage), contractId: input.contractId, upperBoundEvidence: input.upperBoundEvidence });
    }
    const { contract, channelId, requestedModel, protocol, payload, rules } = input.textRequest;
    if (input.usageKind !== "text" || input.units !== 1 || contract.channelId !== channelId || contract.requestedModel !== requestedModel || contract.protocol !== protocol) throw new PricingInputError("文本请求与已审核渠道契约不一致");
    const bound = prepareFlatTextRequestBound({ version, policy, contract, payload, occurredAt, modelId: input.modelId, priceSelection: input.priceSelection });
    if (!bound.ready) throw new PricingInputError(bound.reasons.join("；"));
    if (!contract.reservationEstimate && legacyFixedPoints === undefined) throw new PricingInputError("文本契约缺少已审核的独立预留估算");
    const context = inspectFlatTextRequestContext(protocol, payload);
    const estimatedQuote = new Fraction(estimateFlatTextRequestQuote({ version, policy, contract, payload, bound, recentOutputTokens, modelId: input.modelId }).exactPoints);
    const estimatedHoldPoints = legacyFixedPoints !== undefined && !contract.reservationEstimate && estimatedQuote.lt(legacyFixedPoints) ? String(legacyFixedPoints) : estimatedQuote.toFraction();
    return structuredClone({
        version,
        policy,
        ...(input.priceSelection ? { priceSelection: input.priceSelection } : {}),
        maximumUsage: bound.maximumUsage,
        maximumQuoteUsage: bound.maximumQuoteUsage,
        estimatedTokenBilling: true,
        estimatedHoldPoints,
        contractId: contract.id,
        upperBoundEvidence: `${bound.sourceUrl}\n${bound.evidence}`,
        text: {
            contract,
            ...(rules ? { rules } : {}),
            bound,
            payloadFingerprint: digest(payload),
            call: {
                ...context,
                modelId: input.modelId,
                ...(input.priceSelection ? { priceSelection: input.priceSelection } : {}),
                channelId,
                requestedModel,
                officialVersionId: version.id,
                salesVersionId: policy.id,
                region: context.region || contract.region,
                serviceTier: context.serviceTier || contract.serviceTier,
                occurredAt,
            },
        },
    });
}

async function latestSettledTextOutputTokens(modelId: string, channelId: string, officialVersionId: string) {
    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ output_tokens: string | null }>(
            `SELECT data #>> '{settledObservation,quantities,outputTokens}' AS output_tokens
             FROM model_pricing_wallet_reservations
             WHERE status = 'settled' AND data->>'usageKind' = 'text' AND data->>'modelId' = $1
               AND data #>> '{frozen,text,call,channelId}' = $2 AND data #>> '{frozen,version,id}' = $3
             ORDER BY data->>'createdAt' DESC, request_id DESC LIMIT 1`,
            [modelId, channelId, officialVersionId],
        );
        return result.rows[0]?.output_tokens || undefined;
    }
    const previous = (await readAuthDb()).pricingReservations
        .filter((item) => item.status === "settled" && item.usageKind === "text" && item.modelId === modelId && item.frozen.version.id === officialVersionId && item.frozen.text?.call.channelId === channelId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return previous?.settledObservation && "quantities" in previous.settledObservation ? previous.settledObservation.quantities.outputTokens : undefined;
}

async function assertTextPreparation(input: Identity, preparation: NonNullable<PricingWalletReservation["preparation"]>, phase: "preparing" | "finished", tx: PricingWalletTransaction) {
    if (preparation.taskType === "audio") {
        const task = await getAudioTask(preparation.taskId, tx.executor);
        const reference = task?.billingRequests?.find((item) => item.attemptNo === task.attemptNo);
        if (
            task?.userId !== input.userId ||
            task.billingMode !== "official-usage" ||
            !task.billingPending ||
            task.status !== "running" ||
            reference?.requestId !== input.requestId ||
            reference.requestFingerprint !== input.requestFingerprint ||
            reference.preparation?.id !== preparation.claimId ||
            reference.preparation.phase !== phase ||
            reference.preparationStop
        )
            throw new PricingConflictError("原音频计费准备已撤销或身份状态已变化");
        return;
    }
    if (preparation.taskType === "video") {
        const task = await getVideoTask(preparation.taskId, tx.executor);
        const reference = task?.billingRequests?.find((item) => item.attemptNo === videoTaskAttemptNo(task));
        if (
            task?.userId !== input.userId ||
            task.billingMode !== "official-usage" ||
            !task.billingPending ||
            task.status !== "running" ||
            reference?.requestId !== input.requestId ||
            reference.requestFingerprint !== input.requestFingerprint ||
            reference.preparation?.id !== preparation.claimId ||
            reference.preparation.phase !== phase ||
            reference.preparationStop
        )
            throw new PricingConflictError("原视频计费准备已撤销或身份状态已变化");
        return;
    }
    if (preparation.taskType === "image") {
        const task = await getImageTask(preparation.taskId, tx.executor);
        const reference = task?.billingRequests?.find((item) => item.attemptNo === task.attemptNo);
        if (
            task?.userId !== input.userId ||
            task.billingMode !== "official-usage" ||
            !task.billingPending ||
            task.status !== "running" ||
            reference?.requestId !== input.requestId ||
            reference.requestFingerprint !== input.requestFingerprint ||
            reference.preparation?.id !== preparation.claimId ||
            reference.preparation.phase !== phase ||
            reference.preparationStop
        )
            throw new PricingConflictError("原图片计费准备已撤销或身份状态已变化");
        return;
    }
    const task = await getTextTask(preparation.taskId, tx.executor);
    const reference = task?.billingRequests?.find((item) => item.attemptNo === task.attemptNo);
    if (
        task?.userId !== input.userId ||
        task.billingMode !== "official-usage" ||
        reference?.requestId !== input.requestId ||
        reference.requestFingerprint !== input.requestFingerprint ||
        reference.preparation?.id !== preparation.claimId ||
        reference.preparation.phase !== phase ||
        reference.preparationStop
    )
        throw new PricingConflictError("原计费准备已撤销或身份已变化");
}

/** Capability-specific requests derive bounds from audited contracts; generic internal fixtures still require caller proof. */
export async function reserveModelPricePoints(input: ReserveInput) {
    identity(input);
    if (!input.modelId?.trim() || !["text", "image", "video", "audio"].includes(input.usageKind) || !Number.isSafeInteger(input.units) || input.units < 1) throw new PricingInputError("预留业务类型或调用数量无效");
    const recentOutputTokens = input.textRequest ? await latestSettledTextOutputTokens(input.modelId, input.textRequest.channelId, input.version.id) : undefined;
    const missingLegacyEstimate =
        !input.priceSelection &&
        (Boolean(input.textRequest && !input.textRequest.contract.reservationEstimate) ||
            Boolean(input.imageRequest?.contract.scope === "global-standard-direct-image-tokens" && !input.imageRequest.contract.holdEstimates?.length && !input.imageRequest.contract.holdEstimate));
    let legacyFixedPoints: number | undefined;
    if (missingLegacyEstimate && input.policy.priceVersionIds[input.modelId] === input.version.id && input.version.logicalModelId === input.modelId) {
        const activation = await getModelPricingActivation(input.modelId);
        if (activation?.enabled && activation.bindings) {
            const admission = await getModelPricingAdmission(input.modelId, activation.textUsageRuleId || null, undefined, undefined, undefined, true);
            const request = input.textRequest || input.imageRequest;
            const key = `${request?.channelId}/${request?.requestedModel}`;
            const binding = admission.bindings.find((item) => item.key === key);
            const approved = activation.bindings[key];
            if (
                activation.fingerprint === admission.fingerprint &&
                activation.officialVersionId === admission.officialVersionId &&
                input.policy.id === admission.salesVersionId &&
                binding?.fingerprint &&
                approved?.fingerprint === binding.fingerprint &&
                approved.contractIds.includes(request!.contract.id) &&
                approved.shadowReceiptIds[request!.contract.id]
            ) {
                const settings = await getFreshAuthSettings();
                legacyFixedPoints = resolveConfiguredModelPointCost(settings.modelPointCosts, input.modelId, settings.logicalModels);
            }
        }
    }
    return mutatePricingWallet(input.userId, input, async (tx) => {
        if (input.preparation) await assertTextPreparation(input, input.preparation, "preparing", tx);
        const saved = await tx.getReservation(input.requestId);
        if (saved) {
            matching(saved, input);
            if (!isDeepStrictEqual(saved.preparation, input.preparation)) throw new PricingConflictError("原计费准备身份已变化");
            if (saved.modelId !== input.modelId || saved.usageKind !== input.usageKind || saved.units !== input.units) throw new PricingConflictError("预留业务参数已变化");
            const text = saved.frozen.text;
            if (
                Boolean(text) !== Boolean(input.textRequest) ||
                (text &&
                    input.textRequest &&
                    (text.payloadFingerprint !== digest(input.textRequest.payload) ||
                        text.call.channelId !== input.textRequest.channelId ||
                        text.call.requestedModel !== input.textRequest.requestedModel ||
                        text.contract.protocol !== input.textRequest.protocol))
            )
                throw new PricingConflictError("预留文本请求已变化");
            const image = saved.frozen.image;
            if (
                Boolean(image) !== Boolean(input.imageRequest) ||
                (image &&
                    input.imageRequest &&
                    (image.payloadFingerprint !== digest(input.imageRequest.payload) ||
                        image.call.channelId !== input.imageRequest.channelId ||
                        image.call.requestedModel !== input.imageRequest.requestedModel ||
                        image.call.declaredProtocol !== input.imageRequest.declaredProtocol ||
                        image.call.operation !== input.imageRequest.operation))
            )
                throw new PricingConflictError("预留图片请求已变化");
            const audio = saved.frozen.audio;
            if (
                Boolean(audio) !== Boolean(input.audioRequest) ||
                (audio &&
                    input.audioRequest &&
                    (audio.payloadFingerprint !== digest(input.audioRequest.payload) ||
                        audio.call.channelId !== input.audioRequest.channelId ||
                        audio.call.requestedModel !== input.audioRequest.requestedModel ||
                        audio.call.declaredProtocol !== input.audioRequest.declaredProtocol))
            )
                throw new PricingConflictError("预留音频请求已变化");
            const video = saved.frozen.video;
            if (
                Boolean(video) !== Boolean(input.videoRequest) ||
                (video &&
                    input.videoRequest &&
                    (video.payloadFingerprint !== digest(input.videoRequest.payload) ||
                        video.call.channelId !== input.videoRequest.channelId ||
                        video.call.requestedModel !== input.videoRequest.requestedModel ||
                        video.call.declaredProtocol !== input.videoRequest.declaredProtocol))
            )
                throw new PricingConflictError("预留视频请求已变化");
            return { reservation: saved, snapshot: tx.snapshot(), applied: false };
        }
        if (!tx.active) throw new PricingInputError("用户不可用");
        if (input.policy.priceVersionIds[input.modelId] && input.policy.selectedPriceBindings?.some((item) => item.logicalModelId === input.modelId)) throw new PricingInputError("同一模型的销售版本同时含旧式映射和独立选价，请重新发布");
        if (tx.snapshot().permanentPoints < 0) throw new PricingInputError("存在待补扣积分，请补足后再发起付费调用");
        if (input.priceSelection) {
            if ((!input.textRequest || input.usageKind !== "text") && (!input.imageRequest || input.usageKind !== "image") && (!input.videoRequest || input.usageKind !== "video") && (!input.audioRequest || input.usageKind !== "audio"))
                throw new PricingInputError("独立选价尚未支持该计费能力");
            const currentPolicy = await getCurrentSalesVersion();
            const current = input.imageRequest
                ? await resolvePublishedModelPrice(input.modelId, "image", input.imageRequest.operation, currentPolicy)
                : input.videoRequest
                  ? await resolvePublishedModelPrice(input.modelId, "video", "generation", currentPolicy)
                  : input.audioRequest
                    ? await resolvePublishedModelPrice(input.modelId, "audio", input.audioRequest.contract.protocol === "openai-chat-audio" ? "chat/completions" : "generateContent", currentPolicy)
                    : await resolvePublishedModelPrice(input.modelId, "text", "generation", currentPolicy);
            if (currentPolicy?.id !== input.policy.id || current?.version.id !== input.version.id || !isDeepStrictEqual(current.selection, input.priceSelection)) throw new PricingInputError("预留时独立选价绑定或售价已变化");
        }
        const frozen = freezePricing(input, tx.now, recentOutputTokens, legacyFixedPoints);
        const { version, policy } = frozen;
        if (!version.reviewedBy || !version.publishedAt || !policy.publishedBy || !policy.publishedAt || !publishedPriceMatches(input.modelId, version, policy, frozen.priceSelection) || !frozen.contractId?.trim() || !frozen.upperBoundEvidence?.trim())
            throw new PricingInputError("预留缺少已发布的价格映射或核实上界依据");
        const quote = frozen.estimatedTokenBilling ? undefined : quoteSalesPrice({ version, policy, usage: frozen.maximumQuoteUsage, modelId: input.modelId });
        if (frozen.estimatedTokenBilling && !frozen.text && !frozen.estimatedHoldPoints && (!Number.isFinite(legacyFixedPoints) || !legacyFixedPoints || legacyFixedPoints < 0)) throw new PricingInputError("图片 Token 契约缺少已审核的独立预留估算");
        const snapshot = tx.snapshot();
        const allocation = preparePointReservation({
            maximumExactPoints: frozen.estimatedTokenBilling ? frozen.estimatedHoldPoints || String(legacyFixedPoints) : quote!.exactPoints,
            availableDailyPoints: String(snapshot.dailyPoints),
            availablePermanentPoints: String(snapshot.permanentPoints),
            dailySource: dailyTarget(tx),
        });
        const held = pricingWalletNumber(allocation.heldPoints);
        await tx.assertQuota(input.usageKind, input.units, held);
        await tx.adjustBalances(new Fraction(allocation.dailyHeld).neg().toString(2), new Fraction(allocation.permanentHeld).neg().toString(2));
        if (tx.quotaTracked) await tx.adjustQuota(snapshot.dailyDate, input.usageKind, input.units, held);
        const reservation: PricingWalletReservation = {
            userId: input.userId,
            requestId: input.requestId,
            requestFingerprint: input.requestFingerprint,
            modelId: input.modelId,
            usageKind: input.usageKind,
            units: input.units,
            status: "reserved",
            allocation,
            frozen,
            ...(input.preparation ? { preparation: input.preparation } : {}),
            createdAt: tx.now,
            quotaDate: snapshot.dailyDate,
            quotaTracked: tx.quotaTracked,
        };
        await tx.saveReservation(reservation);
        return { reservation, snapshot: tx.snapshot(), applied: true };
    });
}

/** A durable, non-expiring claim: a second worker cannot infer permission to submit again. */
export async function claimModelPriceSubmission(input: Identity & ClockInput) {
    identity(input);
    return mutatePricingWallet(input.userId, input, async (tx) => {
        const saved = await tx.getReservation(input.requestId);
        if (!saved) throw new PricingInputError("原积分预留不存在");
        matching(saved, input);
        if (!saved.frozen.text && !saved.frozen.image && !saved.frozen.video && !saved.frozen.audio) throw new PricingInputError("该能力尚未接入受控提交");
        if (saved.submission || saved.status !== "reserved") return { reservation: saved, claimed: false };
        if (saved.preparation) await assertTextPreparation(input, saved.preparation, "finished", tx);
        if (!tx.active) throw new PricingInputError("用户不可用");
        if (tx.snapshot().permanentPoints < 0) {
            const release = releasePointReservation(saved.allocation, dailyTarget(tx));
            await tx.adjustBalances(release.dailyRestored, release.permanentRestored);
            if (saved.quotaTracked) await tx.adjustQuota(saved.quotaDate, saved.usageKind, -saved.units, -pricingWalletNumber(saved.allocation.heldPoints));
            const reservation: PricingWalletReservation = { ...saved, status: "released", release, releaseEvidence: "用户有待补扣积分，未向上游提交", completedAt: tx.now };
            await tx.saveReservation(reservation);
            return { reservation, claimed: false };
        }
        const reservation: PricingWalletReservation = { ...saved, submission: { id: randomUUID(), phase: "submitting", startedAt: tx.now, updatedAt: tx.now } };
        await tx.saveReservation(reservation);
        return { reservation, claimed: true };
    });
}

/** Bind the original create acknowledgement under the wallet lock; a query cannot invent this identity. */
export async function acknowledgeModelPriceVideoSubmission(input: Identity & ClockInput & { claimId: string; payload: unknown }) {
    identity(input);
    const body = input.payload && typeof input.payload === "object" && !Array.isArray(input.payload) ? (input.payload as Record<string, unknown>) : {};
    if (body.error || typeof body.task_id !== "string" || !body.task_id.trim()) throw new PricingInputError("视频创建响应缺少已确认的原上游任务 ID");
    const upstreamTaskId = body.task_id;
    return mutatePricingWallet(input.userId, input, async (tx) => {
        const saved = await tx.getReservation(input.requestId);
        if (!saved) throw new PricingInputError("原积分预留不存在");
        matching(saved, input);
        const submission = saved.submission;
        if (!saved.frozen.video || !submission || submission.id !== input.claimId) throw new PricingConflictError("视频创建凭据不属于原提交");
        if (saved.frozen.video.contract.protocol === "minimax-hailuo-v1") {
            const status = body.base_resp && typeof body.base_resp === "object" ? (body.base_resp as Record<string, unknown>).status_code : undefined;
            if (status !== 0) throw new PricingInputError("Hailuo 创建响应缺少业务成功凭据");
        }
        if (submission.upstreamTaskId) {
            if (submission.upstreamTaskId !== upstreamTaskId) throw new PricingConflictError("原上游任务 ID 不能改写");
            return { reservation: saved, applied: false };
        }
        if (saved.status !== "reserved" || submission.response || submission.review || submission.phase === "not_charged") throw new PricingConflictError("原视频预留已处理，不能追加创建凭据");
        const reservation: PricingWalletReservation = { ...saved, submission: { ...submission, upstreamTaskId, phase: "submitted", reason: undefined, updatedAt: tx.now } };
        await tx.saveReservation(reservation);
        return { reservation, applied: true };
    });
}

/** Persist final metering before settlement, so a wallet write failure never requires another upstream call. */
export async function recordModelPriceSubmissionOutcome(
    input: Identity & ClockInput & { claimId: string } & ({ kind: "response"; observation: PricingUsageObservation; responseComplete: true } | { kind: "unknown"; reason: PricingSubmissionFailure } | { kind: "not_charged"; evidence: string }),
) {
    identity(input);
    if (input.kind === "unknown" && !["transport_error", "incomplete_response", "result_unknown"].includes(input.reason)) throw new PricingInputError("提交结果未知的原因无效");
    return mutatePricingWallet(input.userId, input, async (tx) => {
        const saved = await tx.getReservation(input.requestId);
        if (!saved) throw new PricingInputError("原积分预留不存在");
        matching(saved, input);
        const submission = saved.submission;
        if (!submission || submission.id !== input.claimId) throw new PricingConflictError("提交凭据不属于该预留");
        if (saved.frozen.audio && input.kind !== "unknown" && (await readAudioPriceReview(input.userId, input.requestId, tx.executor))) throw new PricingConflictError("已有音频人工决定，请恢复原审核凭据");
        if (input.kind === "not_charged") {
            const evidence = input.evidence?.trim();
            if (!evidence) throw new PricingInputError("确认未计费需要明确依据");
            if (submission.noChargeEvidence) {
                if (submission.noChargeEvidence !== evidence) throw new PricingConflictError("未计费依据不能改写");
                return { reservation: saved, applied: false };
            }
            if (saved.status !== "reserved" || submission.response || submission.review) throw new PricingConflictError("已有完整响应或预留已结束，不能改为未计费");
            if (saved.frozen.audio && (await hasAudioPriceResponseReceipt(input.userId, input.requestId, tx.executor))) throw new PricingConflictError("已有原音频响应，不能改为未计费");
            const reservation: PricingWalletReservation = { ...saved, submission: { ...submission, phase: "not_charged", noChargeEvidence: evidence, reason: undefined, updatedAt: tx.now } };
            await tx.saveReservation(reservation);
            return { reservation, applied: true };
        }
        if (input.kind === "unknown") {
            if (saved.status !== "reserved" || submission.response || submission.review || submission.phase === "outcome_unknown" || submission.phase === "not_charged") return { reservation: saved, applied: false };
            const reservation: PricingWalletReservation = { ...saved, submission: { ...submission, phase: "outcome_unknown", reason: input.reason, updatedAt: tx.now } };
            await tx.saveReservation(reservation);
            return { reservation, applied: true };
        }
        if (input.kind !== "response" || input.responseComplete !== true) throw new PricingInputError("只能保存明确完整结束的响应计量");
        const observation = input.observation;
        if (
            Boolean(saved.frozen.image) !== (observation.protocol === "openai-images") ||
            Boolean(saved.frozen.video) !== (observation.protocol === "minimax-video-v2" || observation.protocol === "minimax-hailuo-v1") ||
            (saved.frozen.video && observation.protocol !== saved.frozen.video.contract.protocol) ||
            Boolean(saved.frozen.audio) !== (observation.protocol === "gemini-tts" || observation.protocol === "openai-chat-audio") ||
            (saved.frozen.audio && observation.protocol !== saved.frozen.audio.contract.protocol)
        )
            throw new PricingInputError("响应计量与原预留能力不匹配");
        if (
            observation.protocol === "minimax-video-v2" &&
            (!submission.upstreamTaskId || observation.upstreamTaskId !== submission.upstreamTaskId || observation.reportedModel !== saved.frozen.video!.call.requestedModel || !["succeeded", "failed", "cancelled"].includes(observation.status || ""))
        )
            throw new PricingInputError("视频终态计量不属于已确认的原任务或尚未结束");
        if (observation.protocol === "minimax-hailuo-v1" && (!submission.upstreamTaskId || observation.upstreamTaskId !== submission.upstreamTaskId || !["Success", "Fail"].includes(observation.status || "")))
            throw new PricingInputError("Hailuo 终态凭据不属于已确认的原任务或尚未结束");
        // JSONB changes object key order; identity depends on these fields, not serialization order.
        const fingerprint = digest(
            observation.protocol === "gemini-tts" || observation.protocol === "openai-chat-audio"
                ? [observation.protocol, observation.reportedModel, observation.serviceTier, observation.hasAudio, quantities(observation.quantities), [...observation.missing].sort(), [...observation.invalid].sort()]
                : observation.protocol === "minimax-video-v2"
                  ? [
                        observation.protocol,
                        observation.upstreamTaskId,
                        observation.reportedModel,
                        observation.status,
                        observation.resolution,
                        observation.taskType,
                        observation.modality,
                        observation.hasResult,
                        quantities(observation.quantities),
                        [...observation.missing].sort(),
                        [...observation.invalid].sort(),
                    ]
                  : observation.protocol === "minimax-hailuo-v1"
                    ? [observation.protocol, observation.upstreamTaskId, observation.status, observation.fileId, observation.width, observation.height, [...observation.missing].sort(), [...observation.invalid].sort()]
                    : observation.protocol === "openai-images"
                      ? [observation.protocol, observation.reportedModel, observation.hasResults, observation.quality, observation.size, quantities(observation.quantities), [...observation.missing].sort(), observation.invalid]
                      : [observation.protocol, observation.reportedModel, observation.serviceTier, observation.inferenceGeo, quantities(observation.quantities), [...observation.missing].sort(), observation.invalid],
        );
        if (submission.response) {
            if (submission.response.fingerprint !== fingerprint) throw new PricingConflictError("已保存的响应计量不能改写");
            return { reservation: saved, applied: false };
        }
        if (saved.status !== "reserved" || submission.phase === "not_charged" || submission.review) throw new PricingConflictError("该预留已结束、已确认未计费或已有人工决定，不能追加计费响应");
        const reservation: PricingWalletReservation = { ...saved, submission: { ...submission, phase: "response_received", reason: undefined, updatedAt: tx.now, response: { observation: structuredClone(input.observation), fingerprint } } };
        await tx.saveReservation(reservation);
        return { reservation, applied: true };
    });
}

export function validateReviewedTextUsage(saved: PricingWalletReservation, observation: TokenUsageObservation, correctedObservation?: TokenUsageObservation) {
    if (!saved.frozen.text) throw new PricingInputError("该预留不是已审核文本契约");
    const { contract, rules, bound, call } = saved.frozen.text;
    const prepared = previewObservedFlatTextQuote({ ...saved.frozen, contract, rules, observation, call: { ...call, responseComplete: true } });
    if (!prepared.ready) throw new PricingInputError(prepared.reasons.join("；"));
    const reasons = validateObservedRequestBound(bound, contract, prepared.normalizedObservation);
    if (reasons.length) throw new PricingInputError(reasons.join("；"));
    const original = saved.submission?.response?.observation;
    if (original?.protocol === "openai-images" || original?.protocol === "minimax-video-v2" || original?.protocol === "minimax-hailuo-v1" || original?.protocol === "gemini-tts" || original?.protocol === "openai-chat-audio")
        throw new PricingInputError("原响应不是文本计量");
    assertPricingObservationSupplement(original, observation, correctedObservation);
}

export function validateReviewedImageUsage(saved: PricingWalletReservation, observation: ImageUsageObservation, correctedObservation?: ImageUsageObservation) {
    if (!saved.frozen.image) throw new PricingInputError("该预留不是已审核图片契约");
    const { contract, call } = saved.frozen.image;
    const prepared = previewObservedImageQuote({ ...saved.frozen, contract, observation, call: { ...call, responseComplete: true } });
    if (!prepared.ready) throw new PricingInputError(prepared.reasons.join("；"));
    const original = saved.submission?.response?.observation;
    if (original && original.protocol !== "openai-images") throw new PricingInputError("原响应不是图片计量");
    assertImageObservationSupplement(original, observation, correctedObservation);
}

export function validateReviewedVideoUsage(saved: PricingWalletReservation, observation: VideoUsageObservation | HailuoObservation, correctedObservation?: VideoUsageObservation | HailuoObservation) {
    if (!saved.frozen.video || !saved.submission?.upstreamTaskId) throw new PricingInputError("视频补录缺少原创建确认");
    const prepared = previewWalletVideoQuote(saved, observation, true);
    if (!prepared.ready) throw new PricingInputError(prepared.reasons.join("；"));
    const original = saved.submission.response?.observation;
    if (original && original.protocol !== "minimax-video-v2" && original.protocol !== "minimax-hailuo-v1") throw new PricingInputError("原响应不是视频计量");
    assertVideoObservationSupplement(original, observation, correctedObservation);
}

function previewWalletVideoQuote(saved: PricingWalletReservation, observation: VideoUsageObservation | HailuoObservation, responseComplete: boolean) {
    if (!saved.frozen.video || !saved.submission?.upstreamTaskId) throw new PricingInputError("视频预留缺少原冻结契约或创建确认");
    const { contract, call, bound } = saved.frozen.video;
    const upstreamTaskId = saved.submission.upstreamTaskId;
    return contract.protocol === "minimax-hailuo-v1" && bound.protocol === contract.protocol && observation.protocol === contract.protocol
        ? previewHailuoQuote({ ...saved.frozen, contract, call, bound, observation, upstreamTaskId, responseComplete })
        : contract.protocol === "minimax-video-v2" && bound.protocol === contract.protocol && observation.protocol === contract.protocol
          ? previewObservedVideoQuote({ ...saved.frozen, contract, call, bound, observation, upstreamTaskId, responseComplete })
          : { ready: false as const, reasons: ["视频契约、冻结上界与原终态协议不一致"] };
}

async function recoveredVideoObservation(saved: PricingWalletReservation, tx: PricingWalletTransaction) {
    const preparation = saved.preparation;
    const first = saved.submission?.response?.observation;
    if (preparation?.taskType !== "video" || !first || (first.protocol !== "minimax-video-v2" && first.protocol !== "minimax-hailuo-v1")) return undefined;
    const task = await getVideoTask(preparation.taskId, tx.executor);
    const reference = task?.billingRequests?.find((item) => item.attemptNo === videoTaskAttemptNo(task));
    const submission = task?.pricedSubmissions?.find((item) => item.requestId === saved.requestId);
    const response = task?.pricedResponses?.find((item) => item.requestId === saved.requestId);
    if (!response?.recovered) return undefined;
    if (
        task?.userId !== saved.userId ||
        task.billingMode !== "official-usage" ||
        reference?.requestId !== saved.requestId ||
        reference.requestFingerprint !== saved.requestFingerprint ||
        reference.review ||
        reference.preparationStop ||
        !submission ||
        submission.upstreamTaskId !== saved.submission?.upstreamTaskId ||
        task.upstream.id !== submission.upstreamTaskId ||
        !isDeepStrictEqual(response.observation, first) ||
        !first.missing.length ||
        first.invalid.length ||
        (response.resultUrl && response.resultUrl !== response.recovered.resultUrl) ||
        !response.recovered.resultUrl
    )
        throw new PricingConflictError("视频补全缺少可核实的原任务凭据");
    validateReviewedVideoUsage(saved, response.recovered.observation);
    return response.recovered.observation;
}

function previewWalletAudioQuote(saved: PricingWalletReservation, observation: AudioUsageObservation, responseComplete: boolean) {
    if (!saved.frozen.audio) throw new PricingInputError("音频预留缺少原冻结契约");
    const { contract, call, bound } = saved.frozen.audio;
    return contract.protocol === "openai-chat-audio" && bound.protocol === "openai-chat-audio"
        ? previewOpenAiAudioQuote({ ...saved.frozen, contract, call, bound, observation, responseComplete })
        : contract.protocol === "gemini-tts" && bound.protocol === "gemini-tts"
          ? previewObservedAudioQuote({ ...saved.frozen, contract, call, bound, observation, responseComplete })
          : { ready: false as const, reasons: ["音频契约与冻结请求协议不匹配"] };
}

export function validateReviewedAudioUsage(saved: PricingWalletReservation, observation: AudioUsageObservation, correctedObservation?: AudioUsageObservation) {
    if (!saved.frozen.audio || observation.protocol !== saved.frozen.audio.contract.protocol || (correctedObservation && correctedObservation.protocol !== observation.protocol)) throw new PricingInputError("音频审核与原能力不匹配");
    const prepared = previewWalletAudioQuote(saved, observation, true);
    if (!prepared.ready) throw new PricingInputError(prepared.reasons.join("；"));
    const original = saved.submission?.response?.observation;
    if (original && original.protocol !== "gemini-tts" && original.protocol !== "openai-chat-audio") throw new PricingInputError("原响应不是音频计量");
    if (original) assertAudioObservationSupplement(original, observation, correctedObservation);
}

/** The original response stays immutable; the reviewed supplement has its own durable provenance. */
export async function reviewModelPriceSubmission(input: Identity & ClockInput & { review: PricingSubmissionReview<PricingUsageObservation> }) {
    identity(input);
    const review = input.review;
    if (!review.id || !review.reviewedBy?.trim() || !review.evidence?.trim() || !Number.isFinite(Date.parse(review.reviewedAt))) throw new PricingInputError("人工核对缺少审核人或明确依据");
    return mutatePricingWallet(input.userId, input, async (tx) => {
        const saved = await tx.getReservation(input.requestId);
        if (!saved) throw new PricingInputError("原积分预留不存在");
        matching(saved, input);
        if (saved.frozen.audio) {
            const privateReview = await readAudioPriceReview(input.userId, input.requestId, tx.executor);
            const task = saved.preparation?.taskType === "audio" ? await getAudioTask(saved.preparation.taskId, tx.executor) : null;
            const reference = task?.billingRequests?.find((item) => item.attemptNo === task.attemptNo);
            if (
                !privateReview ||
                !task ||
                task.userId !== input.userId ||
                task.billingMode !== "official-usage" ||
                privateReview.taskId !== task.id ||
                privateReview.attemptNo !== task.attemptNo ||
                privateReview.requestFingerprint !== input.requestFingerprint ||
                reference?.requestId !== input.requestId ||
                reference.requestFingerprint !== input.requestFingerprint ||
                reference.preparationStop ||
                !isDeepStrictEqual(privateReview.decision, review)
            )
                throw new PricingInputError("音频人工核对缺少专用任务凭据");
            const original = await readAudioPriceResponseReceipt(input.userId, input.requestId, tx.executor);
            if (original?.fingerprint !== privateReview.originalFingerprint) throw new PricingConflictError("音频审核对应的原响应已变化");
            if (review.outcome.kind === "not_charged" && (original || privateReview.response)) throw new PricingConflictError("已有原音频响应，不能确认未计费");
            if (review.outcome.kind === "response") {
                const receipt = original || privateReview.response;
                if (
                    !receipt ||
                    (review.outcome.observation.protocol !== "gemini-tts" && review.outcome.observation.protocol !== "openai-chat-audio") ||
                    (review.outcome.correctedObservation && review.outcome.correctedObservation.protocol !== review.outcome.observation.protocol)
                )
                    throw new PricingInputError("音频审核缺少原媒体凭据");
                assertAudioPriceResponseReceipt(receipt, { ...input, claimId: review.claimId });
                assertAudioObservationSupplement(original?.observation, review.outcome.observation, review.outcome.correctedObservation);
                if (!original && !isDeepStrictEqual(receipt.observation, review.outcome.observation)) throw new PricingConflictError("音频补录媒体与计量不一致");
            }
        }
        if (saved.frozen.image) {
            const task = saved.preparation?.taskType === "image" ? await getImageTask(saved.preparation.taskId, tx.executor) : null;
            const reference = task?.billingRequests?.find((item) => item.attemptNo === task.attemptNo);
            if (
                !task ||
                task.userId !== input.userId ||
                task.billingMode !== "official-usage" ||
                reference?.requestId !== input.requestId ||
                reference.requestFingerprint !== input.requestFingerprint ||
                !isDeepStrictEqual(reference.review?.decision, review)
            )
                throw new PricingInputError("图片人工核对缺少专用任务凭据");
            const original = task.pricedResponses?.find((item) => item.requestId === reference.requestId);
            if (review.outcome.kind === "not_charged" && original) throw new PricingConflictError("已有图片响应，不能确认未计费");
            if (review.outcome.kind === "response") {
                if (review.outcome.observation.protocol !== "openai-images" || (review.outcome.correctedObservation && review.outcome.correctedObservation.protocol !== "openai-images")) throw new PricingInputError("图片审核能力不匹配");
                assertImageObservationSupplement(original?.observation, review.outcome.observation, review.outcome.correctedObservation);
                if (original?.results.length && !isDeepStrictEqual(original.results, reference.review?.results)) throw new PricingConflictError("图片审核不能改写原公开结果");
            }
        }
        if (saved.frozen.video) {
            const task = saved.preparation?.taskType === "video" ? await getVideoTask(saved.preparation.taskId, tx.executor) : null;
            const reference = task?.billingRequests?.find((item) => item.attemptNo === videoTaskAttemptNo(task));
            if (
                !task ||
                task.userId !== input.userId ||
                task.billingMode !== "official-usage" ||
                reference?.requestId !== input.requestId ||
                reference.requestFingerprint !== input.requestFingerprint ||
                !isDeepStrictEqual(reference.review?.decision, review)
            )
                throw new PricingInputError("视频人工核对缺少专用任务凭据");
            const original = task.pricedResponses?.find((item) => item.requestId === reference.requestId);
            if (review.outcome.kind === "not_charged" && original) throw new PricingConflictError("已有视频响应，不能确认未计费");
            if (review.outcome.kind === "response") {
                if (
                    (review.outcome.observation.protocol !== "minimax-video-v2" && review.outcome.observation.protocol !== "minimax-hailuo-v1") ||
                    review.outcome.observation.protocol !== saved.frozen.video.contract.protocol ||
                    (review.outcome.correctedObservation && review.outcome.correctedObservation.protocol !== review.outcome.observation.protocol)
                )
                    throw new PricingInputError("视频审核能力不匹配");
                const created = task.pricedSubmissions?.find((item) => item.requestId === reference.requestId);
                if (!created || created.upstreamTaskId !== saved.submission?.upstreamTaskId || (saved.frozen.video.contract.protocol === "minimax-hailuo-v1" && created.businessStatus !== 0)) throw new PricingConflictError("视频审核缺少原创建身份");
                assertVideoObservationSupplement(original?.observation, review.outcome.observation, review.outcome.correctedObservation);
            }
        }
        const submission = saved.submission;
        if (!submission || submission.id !== review.claimId) throw new PricingConflictError("人工核对不属于原提交凭据");
        if (submission.review) {
            if (!isDeepStrictEqual(submission.review, review)) throw new PricingConflictError("已保存的人工核对依据不能改写");
            return saved;
        }
        if (saved.status !== "reserved" || submission.phase === "not_charged") throw new PricingConflictError("原预留已处理，请刷新账务状态");
        if (review.outcome.kind === "response") {
            const { observation, correctedObservation } = review.outcome;
            if (observation.protocol === "gemini-tts" || observation.protocol === "openai-chat-audio") {
                if (correctedObservation && correctedObservation.protocol !== observation.protocol) throw new PricingInputError("音频更正与原能力不匹配");
                validateReviewedAudioUsage(saved, observation, correctedObservation);
            } else if (observation.protocol === "minimax-video-v2" || observation.protocol === "minimax-hailuo-v1") {
                if (correctedObservation && correctedObservation.protocol !== observation.protocol) throw new PricingInputError("视频更正与原能力不匹配");
                validateReviewedVideoUsage(saved, observation, correctedObservation);
            } else if (observation.protocol === "openai-images") {
                if (correctedObservation && correctedObservation.protocol !== "openai-images") throw new PricingInputError("图片更正与原能力不匹配");
                validateReviewedImageUsage(saved, observation, correctedObservation);
            } else {
                if (
                    correctedObservation?.protocol === "openai-images" ||
                    correctedObservation?.protocol === "minimax-video-v2" ||
                    correctedObservation?.protocol === "minimax-hailuo-v1" ||
                    correctedObservation?.protocol === "gemini-tts" ||
                    correctedObservation?.protocol === "openai-chat-audio"
                )
                    throw new PricingInputError("文本更正不能引用图片计量");
                validateReviewedTextUsage(saved, observation, correctedObservation);
            }
        } else if (review.outcome.kind !== "not_charged" || submission.response) throw new PricingConflictError("已有响应凭据，不能确认未计费");
        const reservation: PricingWalletReservation = {
            ...saved,
            submission: {
                ...submission,
                review: structuredClone(review),
                phase: review.outcome.kind === "response" ? "response_received" : "not_charged",
                reason: undefined,
                ...(review.outcome.kind === "not_charged" ? { noChargeEvidence: review.evidence } : {}),
                updatedAt: tx.now,
            },
        };
        await tx.saveReservation(reservation);
        return reservation;
    });
}

/** Actual usage, not a caller-supplied point amount, is priced against the frozen version. */
export async function settleModelPricePoints(input: SettleInput) {
    identity(input);
    return mutatePricingWallet(input.userId, input, async (tx) => {
        const saved = await tx.getReservation(input.requestId);
        if (!saved) throw new PricingInputError("原积分预留不存在");
        matching(saved, input);
        if (saved.submission && !input.resume) throw new PricingInputError("受控提交须使用已保存的完整响应结算");
        const reviewed = saved.submission?.review?.outcome;
        const recovered = input.resume && saved.frozen.video && !reviewed ? await recoveredVideoObservation(saved, tx) : undefined;
        const observation = input.resume ? (reviewed?.kind === "response" ? reviewed.observation : recovered || saved.submission?.response?.observation) : input.observation;
        const responseComplete = input.resume ? Boolean(observation) : input.responseComplete;
        if (input.resume && ((!saved.frozen.text && !saved.frozen.image && !saved.frozen.video && !saved.frozen.audio) || !observation)) throw new PricingInputError("尚无可恢复结算的完整响应");
        let usage: Record<string, string | number>;
        let settledUsageFacts: TextUsageFact[] | undefined;
        let settledQuote: PricingWalletReservation["settledQuote"];
        let settledImageUsageFacts: ImageUsageFact[] | undefined;
        let settledImageQuote: PricingWalletReservation["settledImageQuote"];
        let settledAudioUsageFacts: AudioUsageFact[] | undefined;
        let settledAudioQuote: PricingWalletReservation["settledAudioQuote"];
        let settledVideoUsageFacts: VideoUsageFact[] | undefined;
        let settledVideoQuote: PricingWalletReservation["settledVideoQuote"];
        if (saved.frozen.text) {
            if (
                !observation ||
                observation.protocol === "openai-images" ||
                observation.protocol === "minimax-video-v2" ||
                observation.protocol === "minimax-hailuo-v1" ||
                observation.protocol === "gemini-tts" ||
                observation.protocol === "openai-chat-audio" ||
                input.usage !== undefined
            )
                throw new PricingInputError("文本结算必须使用真实响应的规范化用量");
            const { contract, rules, bound, call } = saved.frozen.text;
            const prepared = previewObservedFlatTextQuote({ ...saved.frozen, contract, rules, observation, call: { ...call, responseComplete: responseComplete === true } });
            if (!prepared.ready) throw new PricingInputError(prepared.reasons.join("；"));
            const reasons = validateObservedRequestBound(bound, contract, prepared.normalizedObservation);
            if (reasons.length) throw new PricingInputError(reasons.join("；"));
            usage = prepared.usage;
            const evidenceId = reviewed?.kind === "response" ? saved.submission?.review?.id : saved.submission?.response?.fingerprint;
            if (saved.submission) {
                if (!evidenceId) throw new PricingInputError("文本结算缺少原响应或人工审核证据身份");
                settledUsageFacts = textUsageFacts({
                    attemptId: saved.submission.id,
                    evidenceId,
                    observation: prepared.normalizedObservation,
                    meters: ["inputTotalTokens", ...Object.values(contract.itemMeters).flat(), ...Object.keys(prepared.normalizedObservation.quantities)],
                    ...(reviewed?.kind === "response"
                        ? {
                              manualReviewId: saved.submission.review!.id,
                              ...(saved.submission.response?.observation &&
                              saved.submission.response.observation.protocol !== "openai-images" &&
                              saved.submission.response.observation.protocol !== "minimax-video-v2" &&
                              saved.submission.response.observation.protocol !== "minimax-hailuo-v1" &&
                              saved.submission.response.observation.protocol !== "gemini-tts" &&
                              saved.submission.response.observation.protocol !== "openai-chat-audio"
                                  ? { originalObservation: saved.submission.response.observation, originalEvidenceId: saved.submission.response.fingerprint }
                                  : {}),
                          }
                        : {}),
                });
                const factPriced = quoteTextFacts({ version: saved.frozen.version, policy: saved.frozen.policy, modelId: saved.modelId, contract, contractId: contract.id, occurredAt: call.occurredAt, facts: settledUsageFacts });
                if (!isDeepStrictEqual(quantities(factPriced.usage), quantities(prepared.usage)) || factPriced.quote.exactPoints !== prepared.quote.exactPoints || factPriced.quote.selectedGroupId !== prepared.quote.selectedGroupId)
                    throw new PricingConflictError("计量事实与原审核报价不一致");
                usage = factPriced.usage;
                settledQuote = factPriced.quote;
            }
            saved.settledSources = prepared.sources;
            if (prepared.warnings.length) saved.billingWarnings = prepared.warnings;
        } else if (saved.frozen.image) {
            if (!saved.submission || !input.resume || !observation || observation.protocol !== "openai-images" || input.usage !== undefined) throw new PricingInputError("图片结算必须使用真实响应的规范化用量");
            const { contract, call } = saved.frozen.image;
            const prepared = previewObservedImageQuote({ ...saved.frozen, contract, observation, call: { ...call, responseComplete: responseComplete === true } });
            if (!prepared.ready) throw new PricingInputError(prepared.reasons.join("；"));
            const evidenceId = reviewed?.kind === "response" ? saved.submission.review?.id : saved.submission.response?.fingerprint;
            if (!evidenceId) throw new PricingInputError("图片结算缺少原响应或人工审核证据身份");
            const original = saved.submission.response?.observation;
            settledImageUsageFacts = imageUsageFacts({
                attemptId: saved.submission.id,
                evidenceId,
                observation,
                meters: contract.scope === "global-standard-dataeyes-flux-image" ? ["images"] : ["inputTextTokens", "inputImageTokens", "outputTextTokens", "outputImageTokens", "inputTotalTokens", "outputTotalTokens", "totalTokens"],
                ...(reviewed?.kind === "response" ? { manualReviewId: saved.submission.review!.id, ...(original?.protocol === "openai-images" ? { originalObservation: original, originalEvidenceId: saved.submission.response!.fingerprint } : {}) } : {}),
            });
            const factPriced = quoteImageFacts({ version: saved.frozen.version, policy: saved.frozen.policy, modelId: saved.modelId, contract, facts: settledImageUsageFacts });
            if (!isDeepStrictEqual(quantities(factPriced.usage), quantities(prepared.usage)) || factPriced.quote.exactPoints !== prepared.quote.exactPoints) throw new PricingConflictError("图片计量事实与原审核报价不一致");
            usage = factPriced.usage;
            settledImageQuote = factPriced.quote;
        } else if (saved.frozen.video) {
            if (!saved.submission?.upstreamTaskId || !input.resume || !observation || (observation.protocol !== "minimax-video-v2" && observation.protocol !== "minimax-hailuo-v1") || input.usage !== undefined)
                throw new PricingInputError("视频结算必须使用原任务已保存的完整终态计量");
            const prepared = previewWalletVideoQuote(saved, observation, responseComplete === true);
            if (!prepared.ready) throw new PricingInputError(prepared.reasons.join("；"));
            const evidenceId = reviewed?.kind === "response" ? saved.submission.review?.id : recovered ? digest({ kind: "recovered-video-observation", requestId: saved.requestId, observation: recovered }) : saved.submission.response?.fingerprint;
            if (!evidenceId) throw new PricingInputError("视频结算缺少原终态、补全或人工审核证据身份");
            const original = saved.submission.response?.observation;
            settledVideoUsageFacts = videoUsageFacts({
                attemptId: saved.submission.id,
                evidenceId,
                observation,
                contract: saved.frozen.video.contract,
                bound: saved.frozen.video.bound,
                version: saved.frozen.version,
                ...((reviewed?.kind === "response" || recovered) && original && (original.protocol === "minimax-video-v2" || original.protocol === "minimax-hailuo-v1")
                    ? { originalObservation: original, originalEvidenceId: saved.submission.response!.fingerprint }
                    : {}),
                ...(reviewed?.kind === "response" ? { manualReviewId: saved.submission.review!.id } : {}),
            });
            const factPriced = quoteVideoFacts({ version: saved.frozen.version, policy: saved.frozen.policy, modelId: saved.modelId, contract: saved.frozen.video.contract, bound: saved.frozen.video.bound, facts: settledVideoUsageFacts });
            if (!isDeepStrictEqual(quantities(factPriced.usage), quantities(prepared.usage)) || factPriced.quote.exactPoints !== prepared.quote.exactPoints) throw new PricingConflictError("视频计量事实与原审核报价不一致");
            usage = factPriced.usage;
            settledVideoQuote = factPriced.quote;
        } else if (saved.frozen.audio) {
            if (!saved.submission || !input.resume || !observation || (observation.protocol !== "gemini-tts" && observation.protocol !== "openai-chat-audio") || input.usage !== undefined)
                throw new PricingInputError("音频结算必须使用原提交已保存的完整响应计量");
            const prepared = previewWalletAudioQuote(saved, observation, responseComplete === true);
            if (!prepared.ready) throw new PricingInputError(prepared.reasons.join("；"));
            const evidenceId = reviewed?.kind === "response" ? saved.submission.review?.id : saved.submission.response?.fingerprint;
            if (!evidenceId) throw new PricingInputError("音频结算缺少原响应或人工审核证据身份");
            const original = saved.submission.response?.observation;
            settledAudioUsageFacts = audioUsageFacts({
                attemptId: saved.submission.id,
                evidenceId,
                observation,
                meters: [
                    ...(observation.protocol === "gemini-tts"
                        ? ["inputTextTokens", "outputAudioTokens", "inputTotalTokens", "outputTotalTokens", "totalTokens"]
                        : ["inputTextTokens", "inputAudioTokens", "outputTextTokens", "outputAudioTokens", "inputTotalTokens", "outputTotalTokens", "totalTokens", "inputCachedTokens", "inputCacheWriteTokens"]),
                    ...Object.keys(observation.quantities),
                ],
                ...(reviewed?.kind === "response"
                    ? {
                          manualReviewId: saved.submission.review!.id,
                          ...(original && (original.protocol === "gemini-tts" || original.protocol === "openai-chat-audio") ? { originalObservation: original, originalEvidenceId: saved.submission.response!.fingerprint } : {}),
                      }
                    : {}),
            });
            const factPriced = quoteAudioFacts({ version: saved.frozen.version, policy: saved.frozen.policy, modelId: saved.modelId, contract: saved.frozen.audio.contract, facts: settledAudioUsageFacts });
            if (!isDeepStrictEqual(quantities(factPriced.usage), quantities(prepared.usage)) || factPriced.quote.exactPoints !== prepared.quote.exactPoints) throw new PricingConflictError("音频计量事实与原审核报价不一致");
            usage = factPriced.usage;
            settledAudioQuote = factPriced.quote;
        } else {
            if (!input.usage || input.observation) throw new PricingInputError("结算缺少原能力对应的实际用量");
            usage = input.usage;
        }
        if (saved.frozen.version.textPriceSchedule && !settledQuote) throw new PricingInputError("结构化文本分档结算缺少原尝试的可信计量事实");
        const quote = settledQuote || settledImageQuote || settledAudioQuote || settledVideoQuote || quoteSalesPrice({ version: saved.frozen.version, policy: saved.frozen.policy, usage, modelId: saved.modelId });
        const fingerprint = digest(quantities(Object.fromEntries(quote.lines.map((line) => [line.key, new Fraction(line.quantity).toFraction()]))));
        if (saved.status === "settled") {
            if (saved.completionFingerprint !== fingerprint) throw new PricingConflictError("重复结算的用量已变化");
            return { reservation: saved, snapshot: tx.snapshot(), applied: false };
        }
        if (saved.status !== "reserved") throw new PricingConflictError("已释放的预留不能结算");
        if (!saved.frozen.estimatedTokenBilling && quote.lines.some((line) => new Fraction(line.quantity).gt(saved.frozen.maximumUsage[line.key]))) throw new PricingInputError("实际用量超过已核实的分项预留上界");
        const currentDaily = dailyTarget(tx);
        const original = saved.allocation;
        const sameDaily = Boolean(original.dailySource && currentDaily && original.dailySource.date === currentDaily.date && original.dailySource.planId === currentDaily.planId && original.dailySource.assignmentId === currentDaily.assignmentId);
        const allocation = saved.frozen.estimatedTokenBilling
            ? (() => {
                  const total = new Fraction(quote.exactPoints).ceil(2);
                  const dailyBudget = original.dailySource ? new Fraction(original.dailyHeld).add(sameDaily ? tx.snapshot().dailyPoints : 0) : new Fraction(tx.snapshot().dailyPoints);
                  const daily = total.lt(dailyBudget) ? total : dailyBudget;
                  const source = original.dailySource || (daily.gt(0) ? currentDaily : undefined);
                  return {
                      maximumExactPoints: quote.exactPoints,
                      heldPoints: total.toString(2),
                      dailyHeld: daily.toString(2),
                      permanentHeld: total.sub(daily).toString(2),
                      ...(source ? { dailySource: { date: source.date, planId: source.planId, assignmentId: source.assignmentId } } : {}),
                  } satisfies PointReservation;
              })()
            : original;
        const settlement = settlePointReservation({ reservation: allocation, previousExactPoints: await sourceTotals(tx, allocation), actualExactPoints: quote.exactPoints, dailyReleaseTarget: currentDaily });
        const debtBefore = Math.max(0, -tx.snapshot().permanentPoints);
        let estimatedRelease: PricingWalletReservation["release"];
        if (saved.frozen.estimatedTokenBilling) {
            const originalDaily = new Fraction(original.dailyHeld);
            const dailyCharged = new Fraction(settlement.dailyCharged);
            const dailyDelta = original.dailySource && !sameDaily ? new Fraction(0) : originalDaily.sub(dailyCharged);
            const dailyRoom = currentDaily ? new Fraction(currentDaily.grantedPoints).sub(currentDaily.remainingPoints) : new Fraction(0);
            const dailyRestored = dailyDelta.gt(0) && dailyDelta.gt(dailyRoom) ? dailyRoom : dailyDelta;
            const permanentDelta = new Fraction(original.permanentHeld).sub(settlement.permanentCharged);
            const unusedDaily = originalDaily.gt(dailyCharged) ? originalDaily.sub(dailyCharged) : new Fraction(0);
            const unusedPermanent = permanentDelta.gt(0) ? permanentDelta : new Fraction(0);
            estimatedRelease = {
                releasedPoints: unusedDaily.add(unusedPermanent).toString(2),
                dailyRestored: (dailyRestored.gt(0) ? dailyRestored : new Fraction(0)).toString(2),
                dailyExpired: unusedDaily.sub(dailyRestored.gt(0) ? dailyRestored : 0).toString(2),
                permanentRestored: unusedPermanent.toString(2),
            };
            await tx.adjustBalances(dailyRestored.toString(2), permanentDelta.toString(2), { allowDebt: true });
            if (saved.quotaTracked) await tx.adjustQuota(saved.quotaDate, saved.usageKind, 0, pricingWalletNumber(new Fraction(settlement.chargedPoints).sub(original.heldPoints).toString(2)));
        } else {
            await tx.adjustBalances(settlement.release.dailyRestored, settlement.release.permanentRestored);
            if (saved.quotaTracked) await tx.adjustQuota(saved.quotaDate, saved.usageKind, 0, -pricingWalletNumber(settlement.release.releasedPoints));
        }
        const snapshot = tx.snapshot();
        const newDebt = new Fraction(Math.max(0, -snapshot.permanentPoints)).sub(debtBefore);
        const unpaidAtSettlement = (newDebt.gt(0) ? newDebt : new Fraction(0)).toString(2);
        const record: StoredPointRecord = {
            id: randomUUID(),
            userId: input.userId,
            type: "consume",
            amount: -pricingWalletNumber(settlement.chargedPoints),
            permanentAmount: -pricingWalletNumber(settlement.permanentCharged),
            dailyAmount: -pricingWalletNumber(settlement.dailyCharged),
            balanceAfter: snapshot.totalPoints,
            permanentBalanceAfter: snapshot.permanentPoints,
            dailyBalanceAfter: snapshot.dailyPoints,
            model: saved.modelId,
            description: "按官方价及实际用量结算",
            idempotencyKey: `model-price:${digest([input.userId, input.requestId])}`,
            requestFingerprint: input.requestFingerprint,
            sourceDate: saved.quotaDate,
            createdAt: tx.now,
        };
        await tx.addRecord(record);
        await saveSourceTotals(tx, allocation, settlement.sourceAccruals);
        const reservation: PricingWalletReservation = {
            ...saved,
            allocation,
            ...(saved.frozen.estimatedTokenBilling ? { estimatedHold: original } : {}),
            ...(estimatedRelease ? { release: estimatedRelease, unpaidAtSettlement } : {}),
            status: "settled",
            settlement,
            settledUsage: quantities(usage),
            ...(settledUsageFacts ? { settledUsageFacts } : {}),
            ...(settledQuote ? { settledQuote } : {}),
            ...(settledImageUsageFacts ? { settledImageUsageFacts } : {}),
            ...(settledImageQuote ? { settledImageQuote } : {}),
            ...(settledAudioUsageFacts ? { settledAudioUsageFacts } : {}),
            ...(settledAudioQuote ? { settledAudioQuote } : {}),
            ...(settledVideoUsageFacts ? { settledVideoUsageFacts } : {}),
            ...(settledVideoQuote ? { settledVideoQuote } : {}),
            ...(observation ? { settledObservation: structuredClone(observation) } : {}),
            chargeRecordId: record.id,
            completionFingerprint: fingerprint,
            completedAt: tx.now,
        };
        await tx.saveReservation(reservation);
        return { reservation, snapshot, applied: true };
    });
}

/** Internal only: refund identity and refundable usage must come from the business outcome. */
export async function refundModelPricePoints(input: Identity & ClockInput & { refundId: string; usage: Record<string, string | number>; units: number; evidence: string }) {
    identity(input);
    if (!input.refundId?.trim() || !input.evidence?.trim() || !Number.isSafeInteger(input.units) || input.units < 0) throw new PricingInputError("退款缺少稳定身份、有效次数或依据");
    return mutatePricingWallet(input.userId, input, async (tx) => {
        const saved = await tx.getReservation(input.requestId);
        if (!saved) throw new PricingInputError("原积分预留不存在");
        matching(saved, input);
        if (saved.status !== "settled" || !saved.settlement || !saved.settledUsage || !saved.chargeRecordId) throw new PricingConflictError("只能退回已结算的用量费用");
        const schedule = saved.frozen.version.textPriceSchedule;
        const group = schedule?.groups.find((item) => item.id === saved.settledQuote?.selectedGroupId && item.selector.processingMode === "standard");
        if (schedule && !group) throw new PricingInputError("退款缺少原结算的冻结文本价格组");
        const version = group ? { ...saved.frozen.version, textPriceSchedule: undefined, items: officialItemsForTextPriceGroup(group) } : saved.frozen.version;
        const quote = quoteSalesPrice({ version, policy: saved.frozen.policy, usage: input.usage, modelId: saved.modelId });
        const usage = Object.fromEntries(quote.lines.map((line) => [line.key, pricingDecimal(new Fraction(line.quantity))]));
        if (saved.frozen.video?.contract.protocol === "minimax-hailuo-v1" && (input.units !== 1 || !isDeepStrictEqual(quantities(usage), quantities(saved.settledUsage)))) throw new PricingInputError("Hailuo 退款必须对应原结算的一份完整视频");
        const fingerprint = digest([quantities(usage), input.units, input.evidence]);
        const existing = await tx.getRefund(input.requestId, input.refundId);
        if (existing) {
            if (existing.fingerprint !== fingerprint) throw new PricingConflictError("重复退款的用量或依据已变化");
            return { reservation: saved, refund: existing, snapshot: tx.snapshot(), applied: false };
        }
        if (input.units === 0 && !Object.values(usage).some((value) => new Fraction(value).gt(0))) throw new PricingInputError("退款必须包含用量或调用次数");
        const refundedUnits = (saved.refundedUnits || 0) + input.units;
        if (refundedUnits > saved.units) throw new PricingInputError("退款调用次数超过原调用");
        const refundedUsage = Object.fromEntries(
            Object.entries(usage).map(([key, value]) => {
                const total = new Fraction(saved.refundedUsage?.[key] || "0").add(value);
                if (total.gt(saved.settledUsage![key])) throw new PricingInputError("退款用量超过原结算分项");
                return [key, pricingDecimal(total)];
            }),
        );
        const calculation = refundPointSettlement({
            reservation: saved.allocation,
            settlement: saved.settlement,
            previousExactPoints: await sourceTotals(tx, saved.allocation),
            alreadyRefundedExactPoints: saved.refundedExactPoints || "0",
            refundExactPoints: quote.exactPoints,
            dailyReleaseTarget: dailyTarget(tx),
        });
        const { release } = calculation;
        await tx.adjustBalances(release.dailyRestored, release.permanentRestored);
        if (saved.quotaTracked) await tx.adjustQuota(saved.quotaDate, saved.usageKind, -input.units, -pricingWalletNumber(new Fraction(calculation.quotaRefundedPoints).sub(saved.quotaRefundedPoints || "0").toString(2)));
        const snapshot = tx.snapshot();
        const recordId = randomUUID();
        // Partial refunds use the dedicated receipt's chargeRecordId relationship;
        // sourceRecordId remains the legacy one-refund-per-consumption contract.
        await tx.addRecord({
            id: recordId,
            userId: input.userId,
            type: "refund",
            amount: pricingWalletNumber(new Fraction(release.dailyRestored).add(release.permanentRestored).toString(2)),
            permanentAmount: pricingWalletNumber(release.permanentRestored),
            dailyAmount: pricingWalletNumber(release.dailyRestored),
            balanceAfter: snapshot.totalPoints,
            permanentBalanceAfter: snapshot.permanentPoints,
            dailyBalanceAfter: snapshot.dailyPoints,
            description: new Fraction(release.dailyExpired).gt(0) ? `按原价目退回用量费用（${release.dailyExpired} 日赠积分已失效）` : "按原价目退回用量费用",
            model: saved.modelId,
            idempotencyKey: `model-price-refund:${digest([input.userId, input.requestId, input.refundId])}`,
            requestFingerprint: fingerprint,
            sourceDate: saved.quotaDate,
            createdAt: tx.now,
        });
        await saveSourceTotals(tx, saved.allocation, calculation.sourceAccruals);
        const refund: PricingWalletRefund = {
            userId: input.userId,
            requestId: input.requestId,
            refundId: input.refundId,
            fingerprint,
            usage,
            units: input.units,
            evidence: input.evidence,
            createdAt: tx.now,
            recordId,
            chargeRecordId: saved.chargeRecordId,
            calculation,
        };
        await tx.saveRefund(refund);
        const reservation: PricingWalletReservation = { ...saved, refundedUsage, refundedUnits, refundedExactPoints: calculation.refundedExactPoints, quotaRefundedPoints: calculation.quotaRefundedPoints };
        await tx.saveReservation(reservation);
        return { reservation, refund, snapshot, applied: true };
    });
}

/** Unknown submission/usage outcomes must remain reserved, never auto-release. */
export async function releaseModelPricePoints(input: Identity & ClockInput & { reason: "not-submitted" | "confirmed-no-charge"; evidence: string }) {
    identity(input);
    if (!["not-submitted", "confirmed-no-charge"].includes(input.reason) || !input.evidence?.trim()) throw new PricingInputError("释放预留需要明确未计费的证据");
    return mutatePricingWallet(input.userId, input, async (tx) => {
        const saved = await tx.getReservation(input.requestId);
        if (!saved) throw new PricingInputError("原积分预留不存在");
        matching(saved, input);
        return releaseReservation(tx, saved, input);
    });
}

async function releaseReservation(tx: PricingWalletTransaction, saved: PricingWalletReservation, input: { reason: "not-submitted" | "confirmed-no-charge"; evidence: string }) {
    const fingerprint = digest([input.reason, input.evidence]);
    if (saved.status === "released") {
        if (saved.completionFingerprint !== fingerprint) throw new PricingConflictError("重复释放的依据已变化");
        return { reservation: saved, snapshot: tx.snapshot(), applied: false };
    }
    if (saved.status !== "reserved") throw new PricingConflictError("已结算的费用必须使用退款流程");
    if (saved.submission && (input.reason === "not-submitted" || saved.submission.phase !== "not_charged" || saved.submission.noChargeEvidence !== input.evidence.trim()))
        throw new PricingConflictError("已认领提交不能按未提交释放；须先保存明确未计费依据或按完整响应结算");
    const release = releasePointReservation(saved.allocation, dailyTarget(tx));
    await tx.adjustBalances(release.dailyRestored, release.permanentRestored);
    if (saved.quotaTracked) await tx.adjustQuota(saved.quotaDate, saved.usageKind, -saved.units, -pricingWalletNumber(release.releasedPoints));
    const reservation: PricingWalletReservation = { ...saved, status: "released", release, releaseEvidence: `${input.reason}: ${input.evidence}`, completionFingerprint: fingerprint, completedAt: tx.now };
    await tx.saveReservation(reservation);
    return { reservation, snapshot: tx.snapshot(), applied: true };
}

/** Fence the preparation under the same wallet lock used by reserve and submit. No absent-row inference. */
export async function stopModelPricePreparation(input: Identity & { taskId: string; taskType?: "image" | "video" | "audio"; attemptNo: number; reviewedBy: string; evidence: string }) {
    identity(input);
    if (!input.reviewedBy || !input.evidence?.trim()) throw new PricingInputError("撤销计费准备需要审核人与处理依据");
    const stop = await mutatePricingWallet(input.userId, {}, async (tx) => {
        const saved = await tx.getReservation(input.requestId);
        if (saved) {
            matching(saved, input);
            if (saved.submission || saved.status === "settled") throw new PricingConflictError("原请求已认领上游提交，必须核对原响应或未计费证明");
        }
        const stopPreparation = input.taskType === "audio" ? stopAudioTaskBillingPreparation : input.taskType === "video" ? stopVideoTaskBillingPreparation : input.taskType === "image" ? stopImageTaskBillingPreparation : stopTextTaskBillingPreparation;
        return stopPreparation({ ...input, stop: { id: randomUUID(), reviewedBy: input.reviewedBy, reviewedAt: tx.now, evidence: input.evidence.trim() } }, tx.executor);
    });
    // Commit the fence first; a failed release must not restore submission permission.
    await mutatePricingWallet(input.userId, {}, async (tx) => {
        const saved = await tx.getReservation(input.requestId);
        if (saved) matching(saved, input);
        if (saved?.status === "reserved") await releaseReservation(tx, saved, { reason: "not-submitted", evidence: `原计费准备已撤销，未取得上游提交许可；审核记录 ${stop.id}` });
    });
    return stop;
}
