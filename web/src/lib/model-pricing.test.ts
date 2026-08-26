import { describe, expect, it } from "vitest";

import { billingUnitLabel, effectiveBillingUnit, mediaCostPrice, mediaSalePrice, resolveLogicalModelPricing } from "./model-pricing";

describe("media pricing", () => {
    it("keeps per-second video rates as CNY rates", () => {
        const pricing = { currency: "CNY" as const, billingUnit: "per_second" as const, costPrice: 0.23, salePrice: 0.46 };

        expect(mediaCostPrice(pricing, 0)).toBe(0.23);
        expect(mediaSalePrice(pricing, 0)).toBe(0.46);
    });

    it("normalizes billing units by capability instead of by the edited field", () => {
        expect(effectiveBillingUnit("text", "per_call")).toBe("per_1m_tokens");
        expect(effectiveBillingUnit("video", "per_second")).toBe("per_second");
        expect(effectiveBillingUnit("image", "per_second")).toBe("per_call");
        expect(effectiveBillingUnit("video", undefined)).toBe("per_call");
        expect(billingUnitLabel("per_1m_tokens")).toBe("按百万 Token");
    });

    it("selects pricing from the actual channel binding", () => {
        const logicalModels = [
            {
                id: "video",
                bindings: [
                    { channelId: "call-channel", upstreamModel: "vendor-video", capabilityProfile: { pricing: { currency: "CNY" as const, billingUnit: "per_call" as const, salePrice: 4 } } },
                    { channelId: "second-channel", upstreamModel: "vendor-video", capabilityProfile: { pricing: { currency: "CNY" as const, billingUnit: "per_second" as const, salePrice: 0.46 } } },
                ],
            },
        ];

        expect(resolveLogicalModelPricing(logicalModels, "video", "call-channel")).toMatchObject({ billingUnit: "per_call", salePrice: 4 });
        expect(resolveLogicalModelPricing(logicalModels, "video", "second-channel")).toMatchObject({ billingUnit: "per_second", salePrice: 0.46 });
    });
});
