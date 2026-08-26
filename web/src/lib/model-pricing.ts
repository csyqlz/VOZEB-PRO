import type { LogicalModelCapability, LogicalModelPricing } from "@/lib/auth/store";

export type BillingUnit = LogicalModelPricing["billingUnit"];

export type BillingModel = { id: string; bindings: Array<{ channelId?: string; upstreamModel: string; enabled?: boolean; priority?: number; capabilityProfile?: { pricing?: LogicalModelPricing } }> };

export function resolveLogicalModelPricing(logicalModels: BillingModel[] | undefined, model: string, channelId = ""): LogicalModelPricing | undefined {
    const target = rawModel(model).toLowerCase();
    const logical = (logicalModels || []).find((item) => rawModel(item.id).toLowerCase() === target || item.bindings.some((binding) => rawModel(binding.upstreamModel).toLowerCase() === target));
    if (!logical) return undefined;
    const bindings = logical.bindings.filter((binding) => binding.enabled !== false).sort((left, right) => (left.priority || 0) - (right.priority || 0));
    const channelBindings = channelId ? bindings.filter((binding) => binding.channelId === channelId) : bindings;
    const direct = channelBindings.find((binding) => rawModel(binding.upstreamModel).toLowerCase() === target)?.capabilityProfile?.pricing;
    return direct || channelBindings.find((binding) => binding.capabilityProfile?.pricing)?.capabilityProfile?.pricing;
}

export function resolveModelPricing(logicalModels: BillingModel[] | undefined, model: string, capability?: LogicalModelCapability) {
    const pricing = resolveLogicalModelPricing(logicalModels, model);
    if (pricing) return pricing;
    if (capability === "text") return undefined;
    return undefined;
}

/** Returns the only billing units valid for a capability. */
export function effectiveBillingUnit(capability: LogicalModelCapability, configured: BillingUnit | undefined): BillingUnit {
    if (capability === "text") return "per_1m_tokens";
    if (capability === "video" && configured === "per_second") return "per_second";
    return "per_call";
}

export function billingUnitLabel(unit: BillingUnit) {
    if (unit === "per_1m_tokens") return "按百万 Token";
    if (unit === "per_second") return "按秒";
    return "按次";
}

export function mediaSalePrice(pricing: LogicalModelPricing | undefined, fallback: number) {
    if (!pricing || (pricing.billingUnit !== "per_call" && pricing.billingUnit !== "per_second")) return Math.max(0, Number(fallback) || 0);
    return Math.max(0, finite(pricing.salePrice, pricing.costPrice, fallback));
}

export function mediaCostPrice(pricing: LogicalModelPricing | undefined, fallback: number) {
    if (!pricing || (pricing.billingUnit !== "per_call" && pricing.billingUnit !== "per_second")) return Math.max(0, Number(fallback) || 0);
    return Math.max(0, finite(pricing.costPrice, pricing.salePrice, fallback));
}

export function textTokenSalePrice(pricing: LogicalModelPricing | undefined) {
    if (!pricing || pricing.billingUnit !== "per_1m_tokens") return undefined;
    return {
        input: finite(pricing.inputSalePrice, pricing.inputCostPrice, 0),
        output: finite(pricing.outputSalePrice, pricing.outputCostPrice, 0),
        cacheRead: finite(pricing.cacheReadSalePrice, pricing.cacheReadCostPrice, 0),
        cacheWrite: finite(pricing.cacheWriteSalePrice, pricing.cacheWriteCostPrice, 0),
    };
}

export function textTokenCostPrice(pricing: LogicalModelPricing | undefined) {
    if (!pricing || pricing.billingUnit !== "per_1m_tokens") return undefined;
    return {
        input: finite(pricing.inputCostPrice, pricing.inputSalePrice, 0),
        output: finite(pricing.outputCostPrice, pricing.outputSalePrice, 0),
        cacheRead: finite(pricing.cacheReadCostPrice, pricing.cacheReadSalePrice, 0),
        cacheWrite: finite(pricing.cacheWriteCostPrice, pricing.cacheWriteSalePrice, 0),
    };
}

function finite(...values: unknown[]) {
    for (const value of values) {
        const number = Number(value);
        if (Number.isFinite(number) && number >= 0) return number;
    }
    return 0;
}

function rawModel(value: string) {
    const normalized = String(value || "").trim();
    const separator = normalized.indexOf("::");
    return (separator >= 0 ? normalized.slice(separator + 2) : normalized).replace(/^models\//i, "");
}
