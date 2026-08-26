import { describe, expect, it } from "vitest";

import { consumerModelPriceLabel } from "./consumer-model-price";

describe("consumerModelPriceLabel", () => {
    it("formats media and text sale prices without cost fields", () => {
        expect(consumerModelPriceLabel({ billingUnit: "per_call", currency: "CNY", salePrice: 0.4 })).toBe("基础价 ¥0.4 / 次，具体按参数计算");
        expect(consumerModelPriceLabel({ billingUnit: "per_second", currency: "CNY", salePrice: 0.23 })).toBe("¥0.23 / 秒，按实际视频时长计费");
        expect(consumerModelPriceLabel({ billingUnit: "per_1m_tokens", currency: "CNY", inputSalePrice: 1.5, outputSalePrice: 9 })).toBe("输入 ¥1.5 · 输出 ¥9 / 1M token");
    });
});
