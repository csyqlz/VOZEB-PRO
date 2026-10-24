import Decimal from "decimal.js";

export const POINTS_PER_CNY = "100";
export class PricingInputError extends Error {}
export class PricingConflictError extends Error {}

export function requiredText(value: unknown, label: string) {
    if (typeof value !== "string" || !value.trim()) throw new PricingInputError(`${label}不能为空`);
    return value.trim();
}

export function nonnegativeDecimal(value: unknown, label: string, positive = false) {
    if (typeof value !== "string" && typeof value !== "number") throw new PricingInputError(`${label}必须是十进制数`);
    const raw = String(value).trim();
    if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) throw new PricingInputError(`${label}必须是非负十进制数`);
    const parsed = new Decimal(raw);
    if (!parsed.isFinite() || parsed.isNegative() || (positive && parsed.isZero())) throw new PricingInputError(`${label}无效`);
    return parsed.toFixed();
}
