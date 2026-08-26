export type ConsumerModelPricing = {
    billingUnit: "per_call" | "per_second" | "per_1m_tokens";
    currency: "CNY";
    salePrice?: number;
    inputSalePrice?: number;
    outputSalePrice?: number;
    cacheReadSalePrice?: number;
    cacheWriteSalePrice?: number;
};

export function consumerModelPriceLabel(pricing?: ConsumerModelPricing) {
    if (!pricing) return "";
    if (pricing.billingUnit === "per_call") return `基础价 ¥${formatPrice(pricing.salePrice)} / 次，具体按参数计算`;
    if (pricing.billingUnit === "per_second") return `¥${formatPrice(pricing.salePrice)} / 秒，按实际视频时长计费`;
    return `输入 ¥${formatPrice(pricing.inputSalePrice)} · 输出 ¥${formatPrice(pricing.outputSalePrice)} / 1M token`;
}

function formatPrice(value: number | undefined) {
    if (value === undefined || !Number.isFinite(value)) return "按实际用量";
    return value.toLocaleString("zh-CN", { minimumFractionDigits: 0, maximumFractionDigits: 4 });
}
