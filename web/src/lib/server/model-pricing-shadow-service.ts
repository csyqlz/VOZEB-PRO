import { createHash, randomUUID } from "node:crypto";
import Fraction from "fraction.js";

import { PricingConflictError, PricingInputError, type quoteSalesPrice, type SalesVersion, type TextUsageRule } from "@/lib/model-pricing";
import { accumulateExactPoints } from "@/lib/model-pricing-precision";
import { mutateShadowPriceReceipt, type ShadowPriceMutationState } from "./model-pricing-shadow-store";
import { previewObservedFlatTextQuote } from "./model-pricing-token-contract";
import { previewHailuoQuote } from "./model-pricing-hailuo-contract";
import { previewObservedVideoQuote } from "./model-pricing-video-contract";
import { previewObservedImageQuote } from "./model-pricing-image-contract";
import { previewOpenAiAudioQuote } from "./model-pricing-openai-audio-contract";
import { previewObservedAudioQuote } from "./model-pricing-audio-contract";

export type ShadowPriceSnapshot = {
    channelId: string;
    contractId: string;
    salesVersionId: string;
    textUsageRuleId?: string;
    conversion: SalesVersion["conversion"];
    usdPerCurrency: Record<string, string>;
    quote: ReturnType<typeof quoteSalesPrice>;
};
export type ShadowPriceReceipt = {
    id: string;
    userId: string;
    requestId: string;
    kind: "charge" | "reversal";
    fingerprint: string;
    originalReceiptId?: string;
    snapshot: ShadowPriceSnapshot;
    changeExactPoints: string;
    accrual: ReturnType<typeof accumulateExactPoints>;
    createdAt: string;
};

function requireIdentity(...values: string[]) {
    if (values.some((value) => typeof value !== "string" || !value.trim())) throw new PricingInputError("影子账单缺少稳定请求或版本身份");
}

type ShadowIdentity = { userId: string; requestId: string; requestFingerprint: string; contractId: string };

export function prepareFlatTextShadowPrice(input: Parameters<typeof previewObservedFlatTextQuote>[0] & ShadowIdentity) {
    requireIdentity(input.userId, input.requestId, input.requestFingerprint, input.contractId);
    const preview = previewObservedFlatTextQuote(input);
    if (!preview.ready) return preview;
    const prepared = prepareShadowPrice(input, preview);
    return prepared.ready ? { ...prepared, warnings: preview.warnings, normalizedObservation: preview.normalizedObservation } : prepared;
}

export function prepareImageShadowPrice(input: Parameters<typeof previewObservedImageQuote>[0] & ShadowIdentity) {
    return prepareShadowPrice(input, previewObservedImageQuote(input));
}

export function prepareVideoShadowPrice(input: Parameters<typeof previewObservedVideoQuote>[0] & ShadowIdentity) {
    return prepareShadowPrice(input, previewObservedVideoQuote(input));
}

export function prepareHailuoShadowPrice(input: Parameters<typeof previewHailuoQuote>[0] & ShadowIdentity) {
    return prepareShadowPrice(input, previewHailuoQuote(input));
}

export function prepareAudioShadowPrice(input: Parameters<typeof previewObservedAudioQuote>[0] & ShadowIdentity) {
    return prepareShadowPrice(input, previewObservedAudioQuote(input));
}

export function prepareOpenAiAudioShadowPrice(input: Parameters<typeof previewOpenAiAudioQuote>[0] & ShadowIdentity) {
    return prepareShadowPrice(input, previewOpenAiAudioQuote(input));
}

/** Internal comparison ledger only; never changes a wallet or user point records. */
function prepareShadowPrice(input: ShadowIdentity & { call: { channelId: string }; policy: SalesVersion; rules?: TextUsageRule }, preview: { ready: false; reasons: string[] } | { ready: true; quote: ReturnType<typeof quoteSalesPrice> }) {
    requireIdentity(input.userId, input.requestId, input.requestFingerprint, input.contractId);
    if (!preview.ready) return preview;
    const snapshot: ShadowPriceSnapshot = {
        channelId: input.call.channelId,
        contractId: input.contractId,
        salesVersionId: input.policy.id,
        ...(input.rules ? { textUsageRuleId: input.rules.id } : {}),
        conversion: input.policy.conversion,
        usdPerCurrency: input.policy.usdPerCurrency,
        quote: preview.quote,
    };
    const fingerprint = createHash("sha256")
        .update(
            JSON.stringify([
                input.requestFingerprint,
                snapshot.channelId,
                snapshot.contractId,
                snapshot.salesVersionId,
                preview.quote.officialVersionId,
                preview.quote.modelId,
                preview.quote.exactPoints,
                preview.quote.userCoefficient,
                snapshot.conversion?.cnyPerUsd,
                [...preview.quote.lines].sort((a, b) => a.key.localeCompare(b.key)).map((item) => [item.key, item.quantity, item.unit, item.per, item.price, item.currency]),
                ...(snapshot.textUsageRuleId ? [snapshot.textUsageRuleId] : []),
            ]),
        )
        .digest("hex");
    const build = (state: ShadowPriceMutationState): ShadowPriceReceipt => {
        if (state.charge) {
            if (state.charge.fingerprint !== fingerprint) throw new PricingConflictError("同一请求的影子计费依据已变化");
            return state.charge;
        }
        return {
            id: randomUUID(),
            userId: input.userId,
            requestId: input.requestId,
            kind: "charge",
            fingerprint,
            snapshot,
            changeExactPoints: preview.quote.exactPoints,
            accrual: accumulateExactPoints(state.exactPoints, preview.quote.exactPoints),
            createdAt: new Date().toISOString(),
        };
    };
    return { ready: true as const, build };
}

export async function recordFlatTextShadowPrice(input: Parameters<typeof prepareFlatTextShadowPrice>[0]) {
    const prepared = prepareFlatTextShadowPrice(input);
    if (!prepared.ready) return prepared;
    const receipt = await mutateShadowPriceReceipt(input.userId, input.requestId, "charge", prepared.build);
    return { ready: true as const, receipt };
}

export async function reverseShadowPrice(userId: string, requestId: string) {
    requireIdentity(userId, requestId);
    return mutateShadowPriceReceipt(userId, requestId, "reversal", (state) => {
        if (state.reversal) return state.reversal;
        if (!state.charge) throw new PricingInputError("没有可撤销的原影子账单");
        const changeExactPoints = new Fraction(state.charge.changeExactPoints).neg().toFraction();
        return {
            ...state.charge,
            id: randomUUID(),
            kind: "reversal",
            originalReceiptId: state.charge.id,
            changeExactPoints,
            accrual: accumulateExactPoints(state.exactPoints, changeExactPoints),
            createdAt: new Date().toISOString(),
        };
    });
}
