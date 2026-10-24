import { expect, it } from "vitest";

import { quoteSalesPrice, type OfficialPriceVersion, type SalesPolicy } from "../model-pricing";

const policy: SalesPolicy = {
    priceVersionIds: {},
    userPriceRules: [],
    conversion: { cnyPerUsd: "7", pointsPerCny: "100", observedAt: "2026-01-01T00:00:00Z", evidence: "fixture" },
    usdPerCurrency: { USD: "1", CNY: "0.142857142857142857" },
    pointsPerCurrency: { USD: "700", CNY: "100" },
    rateEvidence: { USD: "fixture" },
};

function price(capability: NonNullable<OfficialPriceVersion["capability"]>, items: OfficialPriceVersion["items"]): OfficialPriceVersion {
    return {
        id: `${capability}-price`,
        candidateId: `${capability}-candidate`,
        logicalModelId: `${capability}-model`,
        capability,
        manufacturer: "Fixture",
        series: "Fixture",
        officialVersion: `${capability}-fixture`,
        sku: `${capability}-fixture`,
        tier: "paid",
        conditions: "fixture",
        sourceKind: "manual",
        sourceUrl: "https://example.com/fixture",
        evidence: "fixture",
        observedAt: "2026-01-01T00:00:00Z",
        publishedAt: "2026-01-01T00:00:00Z",
        reviewedBy: "fixture",
        items,
    };
}

it.each([
    [
        "text",
        [
            { key: "input", unit: "token", per: "1000000", price: "1", currency: "USD" },
            { key: "output", unit: "token", per: "1000000", price: "4", currency: "USD" },
        ],
        { input: "1000000", output: "500000" },
        "3",
        "2100.00",
    ],
    ["image", [{ key: "output", unit: "image", per: "1", price: "0.04", currency: "USD" }], { output: "2" }, "0.08", "56.00"],
    ["video", [{ key: "output", unit: "second", per: "1", price: "0.1", currency: "USD" }], { output: "5" }, "0.5", "350.00"],
    ["audio", [{ key: "output", unit: "second", per: "1", price: "0.02", currency: "USD" }], { output: "3" }, "0.06", "42.00"],
] as const)("keeps the %s baseline USD amount and user points", (capability, items, usage, amount, points) => {
    const quote = quoteSalesPrice({ version: price(capability, [...items]), policy, usage });
    expect(quote.officialAmountUsd).toBe(amount);
    expect(quote.points).toBe(points);
    expect(quote.userCoefficient).toEqual({ value: "1", scope: "default" });
});
