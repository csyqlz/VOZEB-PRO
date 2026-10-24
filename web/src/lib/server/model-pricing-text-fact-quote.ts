import Fraction from "fraction.js";

import { DEEPSEEK_TIME_PRICE_KEYS, deepSeekSalesTimeTier, PricingInputError, quoteSalesPrice, selectStandardTextPriceVersion, type OfficialPriceVersion, type SalesVersion } from "@/lib/model-pricing";
import type { FlatTextPriceContract } from "./model-pricing-token-contract";
import type { TextUsageFact } from "./model-pricing-usage-facts";

/** Quote an acknowledged text attempt from traceable token facts, never from diagnostic totals. */
export function quoteTextFacts(input: { version: OfficialPriceVersion; policy: SalesVersion; modelId: string; contract: FlatTextPriceContract; contractId: string; occurredAt: string; facts: TextUsageFact[] }) {
    const { facts, contract, version, policy } = input;
    if (!input.contractId) throw new PricingInputError("结算报价缺少冻结计量契约身份");
    const first = facts[0];
    if (!first || first.scope.kind !== "attempt" || !first.scope.scopeId || !first.evidenceId) throw new PricingInputError("结算缺少原尝试的计量事实");
    const byMeter = new Map<string, TextUsageFact>();
    for (const fact of facts) {
        if (
            fact.schemaVersion !== 1 ||
            byMeter.has(fact.meter) ||
            fact.scope.kind !== "attempt" ||
            fact.scope.scopeId !== first.scope.scopeId ||
            fact.evidenceId !== first.evidenceId ||
            fact.factId !== [first.scope.scopeId, first.evidenceId, fact.meter].map(encodeURIComponent).join(":")
        )
            throw new PricingInputError("计量事实跨尝试、证据或字段重复");
        byMeter.set(fact.meter, fact);
    }
    const requireFact = (meter: string) => {
        const fact = byMeter.get(meter);
        if (
            !fact ||
            !((fact.status === "reported" && fact.sourceKind === "upstream-response") || (fact.status === "derived" && fact.sourceKind === "approved-derivation") || (fact.status === "reviewed" && fact.sourceKind === "manual-review")) ||
            fact.unit !== "token" ||
            !fact.sourcePath ||
            !/^(0|[1-9]\d*)$/.test(fact.value || "")
        )
            throw new PricingInputError(`缺少 ${meter} 的可结算计量事实`);
        return fact;
    };
    const totalInput = contract.contextTiers || version.textPriceSchedule ? requireFact("inputTotalTokens") : undefined;
    const selected = version.textPriceSchedule ? selectStandardTextPriceVersion(version, Number(totalInput!.value)) : undefined;
    const pricedVersion = selected?.version || version;
    const activeKeys = selected
        ? new Set(pricedVersion.items.map((item) => item.key))
        : contract.contextTiers
          ? new Set(BigInt(totalInput!.value!) > BigInt(contract.contextTiers.thresholdInputTokens) ? contract.contextTiers.longItemKeys : contract.contextTiers.shortItemKeys)
          : contract.scope === "global-standard-deepseek-utc"
            ? new Set(DEEPSEEK_TIME_PRICE_KEYS[deepSeekSalesTimeTier(version, policy, input.occurredAt, input.modelId)])
            : new Set(version.items.map((item) => item.key));
    if (!activeKeys.size || [...activeKeys].some((key) => !pricedVersion.items.some((item) => item.key === key))) throw new PricingInputError("文本价档未匹配到唯一已审分项组");
    const usage: Record<string, string> = {};
    const consumed: Record<string, string[]> = {};
    const seen = new Set<string>();
    for (const item of pricedVersion.items) {
        const meters = contract.itemMeters[item.key];
        if (!Array.isArray(meters) || !meters.length || item.unit.toLowerCase() !== "token") throw new PricingInputError(`分项 ${item.key} 缺少已审核的 Token 映射`);
        if (!activeKeys.has(item.key)) {
            usage[item.key] = "0";
            consumed[item.key] = [];
            continue;
        }
        let quantity = BigInt(0);
        consumed[item.key] = [];
        for (const meter of meters) {
            if (seen.has(meter)) throw new PricingInputError(`计量事实 ${meter} 被重复收费`);
            seen.add(meter);
            const fact = requireFact(meter);
            quantity += BigInt(fact.value!);
            consumed[item.key].push(fact.factId);
        }
        usage[item.key] = quantity.toString();
    }
    const quoted = quoteSalesPrice({ version: pricedVersion, policy, usage, modelId: input.modelId });
    return {
        usage,
        quote: {
            ...quoted,
            purpose: "settlement" as const,
            schemaVersion: 1 as const,
            algorithmRevision: "text-fact-quote-v1" as const,
            salesVersionId: policy.id,
            contractId: input.contractId,
            ...(selected ? { selectedGroupId: selected.groupId } : {}),
            attemptId: first.scope.scopeId,
            evidenceId: first.evidenceId,
            lines: quoted.lines.map((line) => ({
                ...line,
                selected: activeKeys.has(line.key),
                consumedFactIds: consumed[line.key],
                ...(totalInput && activeKeys.has(line.key) ? { conditionFactIds: [totalInput.factId] } : {}),
                exactOfficialAmount: new Fraction(line.quantity).div(line.per).mul(line.price).toFraction(),
            })),
        },
    };
}
