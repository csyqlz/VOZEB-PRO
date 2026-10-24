import { nonnegativeDecimal, PricingInputError, requiredText } from "./primitives";
import type { OfficialPriceItem } from "./types";

export function validateOfficialPriceItems(value: unknown): OfficialPriceItem[] {
    if (!Array.isArray(value) || !value.length) throw new PricingInputError("至少填写一个计费项目");
    const items = value.map((raw, index): OfficialPriceItem => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PricingInputError(`第 ${index + 1} 个计费项目无效`);
        const item = raw as Record<string, unknown>;
        const currency = requiredText(item.currency, "币种").toUpperCase();
        if (!/^[A-Z]{3}$/.test(currency)) throw new PricingInputError("币种须为三位 ISO 代码");
        const condition = typeof item.condition === "string" ? item.condition.trim() : "";
        return {
            key: requiredText(item.key, "计费项目标识"),
            unit: requiredText(item.unit, "报价单位"),
            per: nonnegativeDecimal(item.per, "报价数量", true),
            price: nonnegativeDecimal(item.price, "官方单价"),
            currency,
            ...(condition ? { condition } : {}),
        };
    });
    if (new Set(items.map((item) => item.key)).size !== items.length) throw new PricingInputError("同一价目版本的计费项目标识不能重复");
    return items;
}
