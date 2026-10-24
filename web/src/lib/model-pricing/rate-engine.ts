import Decimal from "decimal.js";
import Fraction from "fraction.js";

import type { OfficialPriceItem, OfficialPriceVersion, SalesPolicy } from "./types";
import { accumulateExactPoints, pricingDecimal } from "../model-pricing-precision";
import { nonnegativeDecimal, POINTS_PER_CNY, PricingInputError } from "./primitives";

export function resolveUserPriceCoefficient(version: OfficialPriceVersion, policy: SalesPolicy, modelId = version.logicalModelId) {
    const targetModelId = modelId?.trim();
    if (!targetModelId) throw new PricingInputError("独立官方价计算用户售价时必须指定逻辑模型");
    const matches = policy.userPriceRules;
    const rule =
        matches.find((item) => item.scope === "model" && item.modelId === targetModelId) ||
        matches.find((item) => item.scope === "series" && item.manufacturer === version.manufacturer && item.series === version.series) ||
        matches.find((item) => item.scope === "manufacturer" && item.manufacturer === version.manufacturer) ||
        matches.find((item) => item.scope === "default");
    return { value: rule?.coefficient || "1", scope: rule?.scope || "default" };
}

/** Official zero-price evidence is retained; an actual user charge requires a regular paid rate. */
export function assertRegularPaidPriceItems(items: OfficialPriceItem[]) {
    for (const item of items) {
        const price = nonnegativeDecimal(item.price, `${item.key} 常规付费单价`);
        if (new Decimal(price).isZero()) throw new PricingInputError(`${item.key} 缺少常规付费单价，需在提交前沿用该模型固定积分；官方免费不表示用户免单`);
    }
}

export function quoteSalesPrice(input: { version: OfficialPriceVersion; policy: SalesPolicy; usage: Record<string, string | number>; modelId?: string }) {
    const { version, policy, usage } = input;
    const modelId = (input.modelId ?? version.logicalModelId)?.trim();
    if (!modelId) throw new PricingInputError("独立官方价计算用户售价时必须指定逻辑模型");
    const userCoefficient = resolveUserPriceCoefficient(version, policy, modelId);
    const totals = new Map<string, Fraction>();
    const lines = version.items.map((item) => {
        if (!Object.hasOwn(usage, item.key)) throw new PricingInputError(`缺少 ${item.key} 的实际用量`);
        const quantity = nonnegativeDecimal(usage[item.key], `${item.key} 用量`);
        if (!new Decimal(quantity).isZero()) assertRegularPaidPriceItems([item]);
        const officialAmount = new Fraction(quantity).div(item.per).mul(item.price);
        totals.set(item.currency, (totals.get(item.currency) || new Fraction(0)).add(officialAmount));
        return { ...item, quantity, officialAmount: pricingDecimal(officialAmount) };
    });
    const unknownUsage = Object.keys(usage).filter((key) => !version.items.some((item) => item.key === key));
    if (unknownUsage.length) throw new PricingInputError(`价目没有计费项目：${unknownUsage.join("、")}`);
    const pointsPerUsd = policy.pointsPerCurrency.USD;
    if (!pointsPerUsd || !policy.conversion) throw new PricingInputError("请先设置美元兑人民币汇率和人民币积分基准");
    let exactPoints = new Fraction(0);
    let exactOfficialAmountUsd = new Fraction(0);
    const currencies = Array.from(totals, ([currency, amount]) => {
        const usdAmount = currency === "USD" ? amount : currency === "CNY" ? amount.div(policy.conversion!.cnyPerUsd) : amount.mul(policy.usdPerCurrency[currency] || "0");
        if (currency !== "USD" && currency !== "CNY" && !policy.usdPerCurrency[currency]) throw new PricingInputError(`缺少 ${currency} 兑美元汇率`);
        const cnyAmount = currency === "CNY" ? amount : usdAmount.mul(policy.conversion!.cnyPerUsd);
        const pointsBeforeRounding = cnyAmount.mul(userCoefficient.value).mul(POINTS_PER_CNY);
        exactPoints = exactPoints.add(pointsBeforeRounding);
        exactOfficialAmountUsd = exactOfficialAmountUsd.add(usdAmount);
        return {
            currency,
            officialAmount: pricingDecimal(amount),
            usdAmount: pricingDecimal(usdAmount),
            usdPerCurrency: currency === "CNY" ? `1/${policy.conversion!.cnyPerUsd}` : policy.usdPerCurrency[currency],
            pointsBeforeRounding: pricingDecimal(pointsBeforeRounding),
        };
    });
    const officialAmountUsd = pricingDecimal(exactOfficialAmountUsd);
    const points = accumulateExactPoints("0", exactPoints.toFraction()).roundedPoints;
    return {
        officialVersionId: version.id,
        modelId,
        lines,
        currencies,
        officialAmountUsd,
        pointsPerUsd,
        userCoefficient,
        exactPoints: exactPoints.toFraction(),
        points,
        rounding: "最终积分四舍五入到两位小数",
    };
}
