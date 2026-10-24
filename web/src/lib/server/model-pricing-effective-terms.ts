import { createHash } from "node:crypto";
import { resolveUserPriceCoefficient, supportsDeepSeekTimePricing, type OfficialPriceVersion, type SalesPolicy } from "@/lib/model-pricing";

/** Only values that can change this model's quote belong in the activation identity. */
export function modelPricingEffectiveTerms(version: OfficialPriceVersion, policy: SalesPolicy, modelId = version.logicalModelId) {
    const currencies = [...new Set(version.items.map((item) => item.currency))].sort();
    return createHash("sha256")
        .update(
            JSON.stringify({
                officialVersionId: version.id,
                coefficient: resolveUserPriceCoefficient(version, policy, modelId).value,
                cnyPerUsd: policy.conversion?.cnyPerUsd,
                usdPerCurrency: Object.fromEntries(currencies.filter((currency) => currency !== "USD" && currency !== "CNY").map((currency) => [currency, policy.usdPerCurrency[currency]])),
                ...(supportsDeepSeekTimePricing(version) && policy.deepSeekUtcWindowModels?.includes(modelId) ? { deepSeekUtcWindow: true } : {}),
            }),
        )
        .digest("hex");
}
