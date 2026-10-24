import Fraction from "fraction.js";

import { PricingInputError, quoteSalesPrice, type OfficialPriceVersion, type SalesVersion } from "@/lib/model-pricing";
import type { AudioPriceContract } from "./model-pricing-audio-contract";
import type { AudioUsageObservation } from "./model-pricing-audio-usage";
import { OPENAI_AUDIO_PRICE_METERS, type OpenAiAudioPriceContract } from "./model-pricing-openai-audio-contract";

export type AudioUsageFact = {
    schemaVersion: 1;
    factId: string;
    meter: string;
    value?: string;
    unit: "token";
    scope: { kind: "attempt"; scopeId: string };
    sourcePaths: string[];
    sourceKind?: "upstream-response" | "manual-review";
    status: "reported" | "reviewed" | "missing" | "invalid";
    evidenceId: string;
    sourceEvidenceId?: string;
};

export function audioUsageFacts(input: {
    attemptId: string;
    evidenceId: string;
    observation: AudioUsageObservation;
    meters: readonly string[];
    manualReviewId?: string;
    originalObservation?: AudioUsageObservation;
    originalEvidenceId?: string;
}): AudioUsageFact[] {
    if (!input.attemptId || !input.evidenceId || (input.manualReviewId !== undefined && !input.manualReviewId) || (input.originalObservation && (!input.manualReviewId || !input.originalEvidenceId)))
        throw new PricingInputError("音频计量事实缺少尝试或观察证据身份");
    return [...new Set(input.meters)].map((meter) => {
        const value = input.observation.quantities[meter];
        const original = input.originalObservation;
        const unchanged = Boolean(original && original.protocol === input.observation.protocol && original.quantities[meter] === value && original.meterSources?.[meter]?.paths.length);
        const source = unchanged ? original!.meterSources?.[meter] : input.observation.meterSources?.[meter];
        const reviewed = Boolean(input.manualReviewId && !unchanged);
        const valid = !input.observation.invalid.length && /^(0|[1-9]\d*)$/.test(value || "") && (reviewed || Boolean(source?.paths.length));
        return {
            schemaVersion: 1,
            factId: [input.attemptId, input.evidenceId, meter].map(encodeURIComponent).join(":"),
            meter,
            ...(valid ? { value } : {}),
            unit: "token",
            scope: { kind: "attempt", scopeId: input.attemptId },
            sourcePaths: reviewed ? [`review:${input.manualReviewId}`] : [...(source?.paths || [])],
            ...(reviewed ? { sourceKind: "manual-review" as const } : source?.kind ? { sourceKind: source.kind } : {}),
            status: value === undefined ? "missing" : valid ? (reviewed ? "reviewed" : "reported") : "invalid",
            evidenceId: input.evidenceId,
            ...(unchanged ? { sourceEvidenceId: input.originalEvidenceId } : {}),
        };
    });
}

/** Price only same-attempt response or reviewed Token facts; totals and unpriced overlap remain checks. */
export function quoteAudioFacts(input: { version: OfficialPriceVersion; policy: SalesVersion; modelId: string; contract: (AudioPriceContract | OpenAiAudioPriceContract) & { id: string }; facts: AudioUsageFact[] }) {
    const first = input.facts[0];
    if (!first?.scope.scopeId || !first.evidenceId || !input.contract.id) throw new PricingInputError("音频结算缺少原尝试、观察或契约身份");
    const byMeter = new Map<string, AudioUsageFact>();
    for (const fact of input.facts) {
        if (
            fact.schemaVersion !== 1 ||
            byMeter.has(fact.meter) ||
            fact.scope.kind !== "attempt" ||
            fact.scope.scopeId !== first.scope.scopeId ||
            fact.evidenceId !== first.evidenceId ||
            fact.factId !== [first.scope.scopeId, first.evidenceId, fact.meter].map(encodeURIComponent).join(":")
        )
            throw new PricingInputError("音频计量事实跨尝试、证据或字段重复");
        byMeter.set(fact.meter, fact);
    }
    const requireFact = (meter: string) => {
        const fact = byMeter.get(meter);
        if (
            !fact ||
            fact.unit !== "token" ||
            !fact.sourcePaths.length ||
            !((fact.status === "reported" && fact.sourceKind === "upstream-response") || (fact.status === "reviewed" && fact.sourceKind === "manual-review")) ||
            !/^(0|[1-9]\d*)$/.test(fact.value || "")
        )
            throw new PricingInputError(`缺少 ${meter} 的可结算音频计量事实`);
        return fact;
    };
    const q = (meter: string) => BigInt(requireFact(meter).value!);
    const inputTotal = q("inputTotalTokens"),
        outputTotal = q("outputTotalTokens"),
        total = q("totalTokens");
    if (inputTotal + outputTotal !== total) throw new PricingInputError("音频总量与分项不一致");
    const meterByItem = new Map<string, string>();
    if (input.contract.protocol === "gemini-tts") {
        if (q("inputTextTokens") !== inputTotal || q("outputAudioTokens") !== outputTotal) throw new PricingInputError("音频模态分项与总量不一致");
        meterByItem.set(input.contract.inputTextItem, "inputTextTokens");
        meterByItem.set(input.contract.outputAudioItem, "outputAudioTokens");
    } else {
        if (q("inputTextTokens") + q("inputAudioTokens") !== inputTotal || q("outputTextTokens") + q("outputAudioTokens") !== outputTotal || q("inputCachedTokens") !== BigInt(0) || q("inputCacheWriteTokens") !== BigInt(0))
            throw new PricingInputError("音频模态或无缓存计量与原契约不一致");
        for (const meter of OPENAI_AUDIO_PRICE_METERS) meterByItem.set(input.contract.itemKeys[meter], meter);
    }
    if (meterByItem.size !== input.version.items.length) throw new PricingInputError("音频分项计量映射不完整");
    const usage: Record<string, string> = {};
    for (const item of input.version.items) {
        const meter = meterByItem.get(item.key);
        if (!meter || item.unit.toLowerCase() !== "token") throw new PricingInputError(`音频分项 ${item.key} 缺少已审核的计量映射`);
        usage[item.key] = requireFact(meter).value!;
    }
    const quoted = quoteSalesPrice({ version: input.version, policy: input.policy, usage, modelId: input.modelId });
    return {
        usage,
        quote: {
            ...quoted,
            purpose: "settlement" as const,
            schemaVersion: 1 as const,
            algorithmRevision: "audio-fact-quote-v1" as const,
            salesVersionId: input.policy.id,
            contractId: input.contract.id,
            attemptId: first.scope.scopeId,
            evidenceId: first.evidenceId,
            lines: quoted.lines.map((line) => ({ ...line, consumedFactIds: [requireFact(meterByItem.get(line.key)!).factId], exactOfficialAmount: new Fraction(line.quantity).div(line.per).mul(line.price).toFraction() })),
        },
    };
}
