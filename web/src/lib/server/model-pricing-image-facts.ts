import Fraction from "fraction.js";

import { PricingInputError, quoteSalesPrice, type OfficialPriceVersion, type SalesVersion } from "@/lib/model-pricing";
import { IMAGE_TOKEN_METERS, type ImagePriceContract } from "./model-pricing-image-contract";
import type { ImageUsageObservation } from "./model-pricing-image-usage";

export type ImageUsageFact = {
    schemaVersion: 1;
    factId: string;
    meter: string;
    value?: string;
    unit: "token" | "image";
    scope: { kind: "attempt"; scopeId: string };
    sourcePaths: string[];
    sourceKind?: "upstream-response" | "approved-derivation" | "manual-review";
    formula?: string;
    status: "reported" | "derived" | "reviewed" | "missing" | "invalid";
    evidenceId: string;
    sourceEvidenceId?: string;
};

/** Retain the parser's actual field path, or the specific decision that supplied a missing value. */
export function imageUsageFacts(input: {
    attemptId: string;
    evidenceId: string;
    observation: ImageUsageObservation;
    meters: readonly string[];
    manualReviewId?: string;
    originalObservation?: ImageUsageObservation;
    originalEvidenceId?: string;
}): ImageUsageFact[] {
    if (!input.attemptId || !input.evidenceId || (input.manualReviewId !== undefined && !input.manualReviewId) || (input.originalObservation && (!input.manualReviewId || !input.originalEvidenceId)))
        throw new PricingInputError("图片计量事实缺少尝试或观察证据身份");
    return [...new Set(input.meters)].map((meter) => {
        const value = input.observation.quantities[meter];
        const original = input.originalObservation;
        const unchanged = Boolean(original && original.quantities[meter] === value && original.meterSources?.[meter]?.paths.length);
        const source = unchanged ? original!.meterSources?.[meter] : input.observation.meterSources?.[meter];
        const reviewed = Boolean(input.manualReviewId && !unchanged);
        const valid = !input.observation.invalid.length && /^(0|[1-9]\d*)$/.test(value || "") && (reviewed || Boolean(source?.paths.length));
        return {
            schemaVersion: 1,
            factId: [input.attemptId, input.evidenceId, meter].map(encodeURIComponent).join(":"),
            meter,
            ...(valid ? { value } : {}),
            unit: meter === "images" ? "image" : "token",
            scope: { kind: "attempt", scopeId: input.attemptId },
            sourcePaths: reviewed ? [`review:${input.manualReviewId}`] : [...(source?.paths || [])],
            ...(reviewed ? { sourceKind: "manual-review" as const } : source?.kind ? { sourceKind: source.kind } : {}),
            ...(!reviewed && source?.formula ? { formula: source.formula } : {}),
            status: value === undefined ? "missing" : valid ? (reviewed ? "reviewed" : source?.kind === "approved-derivation" ? "derived" : "reported") : "invalid",
            evidenceId: input.evidenceId,
            ...(unchanged ? { sourceEvidenceId: input.originalEvidenceId } : {}),
        };
    });
}

/** Recompute the original image tariff from same-attempt facts, not from caller-supplied points. */
export function quoteImageFacts(input: { version: OfficialPriceVersion; policy: SalesVersion; modelId: string; contract: ImagePriceContract & { id: string }; facts: ImageUsageFact[] }) {
    const first = input.facts[0];
    if (!first?.scope.scopeId || !first.evidenceId || !input.contract.id) throw new PricingInputError("图片结算缺少原尝试、观察或契约身份");
    const byMeter = new Map<string, ImageUsageFact>();
    for (const fact of input.facts) {
        if (
            fact.schemaVersion !== 1 ||
            byMeter.has(fact.meter) ||
            fact.scope.kind !== "attempt" ||
            fact.scope.scopeId !== first.scope.scopeId ||
            fact.evidenceId !== first.evidenceId ||
            fact.factId !== [first.scope.scopeId, first.evidenceId, fact.meter].map(encodeURIComponent).join(":")
        )
            throw new PricingInputError("图片计量事实跨尝试、证据或字段重复");
        byMeter.set(fact.meter, fact);
    }
    const requireFact = (meter: string, unit: ImageUsageFact["unit"]) => {
        const fact = byMeter.get(meter);
        if (
            !fact ||
            fact.unit !== unit ||
            !fact.sourcePaths.length ||
            !((fact.status === "reported" && fact.sourceKind === "upstream-response") || (fact.status === "derived" && fact.sourceKind === "approved-derivation") || (fact.status === "reviewed" && fact.sourceKind === "manual-review")) ||
            !/^(0|[1-9]\d*)$/.test(fact.value || "")
        )
            throw new PricingInputError(`缺少 ${meter} 的可结算图片计量事实`);
        return fact;
    };
    const count = input.contract.scope === "global-standard-dataeyes-flux-image";
    if (count) {
        if (requireFact("images", "image").value !== "1") throw new PricingInputError("实际图片数量与已审核上界不一致");
    } else {
        const q = Object.fromEntries([...IMAGE_TOKEN_METERS, "inputTotalTokens", "outputTotalTokens", "totalTokens"].map((meter) => [meter, BigInt(requireFact(meter, "token").value!)]));
        if (q.inputTextTokens + q.inputImageTokens !== q.inputTotalTokens || q.outputTextTokens + q.outputImageTokens !== q.outputTotalTokens || q.inputTotalTokens + q.outputTotalTokens !== q.totalTokens)
            throw new PricingInputError("图片计量事实总量与分项不一致");
        for (const meter of input.contract.zeroMeters) if (q[meter] !== BigInt(0)) throw new PricingInputError(`${meter} 必须由上游明确报告为零`);
    }
    const usage: Record<string, string> = {};
    const consumed: Record<string, string[]> = {};
    const seen = new Set<string>();
    for (const item of input.version.items) {
        const meters = count ? ["images"] : input.contract.itemMeters[item.key];
        if (!Array.isArray(meters) || !meters.length || item.unit.toLowerCase() !== (count ? "image" : "token")) throw new PricingInputError(`图片分项 ${item.key} 缺少已审核的计量映射`);
        let quantity = BigInt(0);
        consumed[item.key] = [];
        for (const meter of meters) {
            if (seen.has(meter)) throw new PricingInputError(`图片计量事实 ${meter} 被重复收费`);
            seen.add(meter);
            const fact = requireFact(meter, count ? "image" : "token");
            quantity += BigInt(fact.value!);
            consumed[item.key].push(fact.factId);
        }
        usage[item.key] = quantity.toString();
    }
    const quoted = quoteSalesPrice({ version: input.version, policy: input.policy, usage, modelId: input.modelId });
    return {
        usage,
        quote: {
            ...quoted,
            purpose: "settlement" as const,
            schemaVersion: 1 as const,
            algorithmRevision: "image-fact-quote-v1" as const,
            salesVersionId: input.policy.id,
            contractId: input.contract.id,
            attemptId: first.scope.scopeId,
            evidenceId: first.evidenceId,
            lines: quoted.lines.map((line) => ({ ...line, consumedFactIds: consumed[line.key], exactOfficialAmount: new Fraction(line.quantity).div(line.per).mul(line.price).toFraction() })),
        },
    };
}
