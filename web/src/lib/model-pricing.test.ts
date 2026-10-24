import { describe, expect, it } from "vitest";

import {
    assertUsdOfficialPriceInput,
    hasMatchingByteDanceSku,
    hasMatchingOfficialVariant,
    isMainlandByteDancePrice,
    officialPriceConditionChoices,
    officialPriceDraftIssues,
    officialPriceItemConditionChoices,
    officialPriceReferenceItems,
    officialPriceStructureItems,
    POINTS_PER_CNY,
    quoteSalesPrice,
    validateBusinessExchangeRate,
    validateOfficialPriceInput,
    validateSalesPolicy,
    type OfficialPriceVersion,
} from "./model-pricing";

const price: OfficialPriceVersion = {
    id: "price-v1",
    candidateId: "draft",
    logicalModelId: "flash",
    manufacturer: "Google",
    series: "Gemini 2.5",
    officialVersion: "gemini-2.5-flash-001",
    sku: "SKU-001",
    tier: "paid",
    conditions: "标准付费档",
    sourceKind: "manual",
    sourceUrl: "https://example.com/pricing",
    evidence: "官方价目截图编号 1",
    observedAt: "2026-09-27T00:00:00Z",
    publishedAt: "2026-09-27T00:00:00Z",
    reviewedBy: "reviewer",
    items: [
        { key: "inputTokens", unit: "token", per: "1000000", price: "1", currency: "USD" },
        { key: "outputTokens", unit: "token", per: "1000000", price: "4", currency: "USD" },
        { key: "imageCount", unit: "image", per: "1", price: "0.2", currency: "CNY" },
        { key: "cacheReadTokens", unit: "token", per: "1000000", price: "0", currency: "USD" },
    ],
};

it("copies reviewed item structure without copying money or applicability", () => {
    const structure = officialPriceStructureItems([{ ...price.items[0], condition: "旧型号长上下文" }, price.items[3]]);
    expect(structure).toEqual([
        { key: "inputTokens", unit: "token", per: "1000000", price: "", currency: "" },
        { key: "cacheReadTokens", unit: "token", per: "1000000", price: "", currency: "" },
    ]);
    expect(officialPriceDraftIssues({ ...price, items: structure })).toContain("价格分项字段");
    expect(price.items[0].price).toBe("1");
});

it("optionally copies editable reference money without copying applicability or altering the original", () => {
    const reference = { ...price.items[0], condition: "旧型号长上下文" };
    const items = officialPriceReferenceItems([reference]);
    expect(items).toEqual([{ key: "inputTokens", unit: "token", per: "1000000", price: "1", currency: "USD" }]);
    items[0].price = "2";
    expect(reference.price).toBe("1");
    expect(officialPriceStructureItems([reference])[0]).toMatchObject({ price: "", currency: "" });
});

it("keeps unknown AI-discovered price fields open until an administrator completes the common candidate contract", () => {
    const draft = { ...price, series: "", officialVersion: "", tier: "" as const, items: price.items.map((item) => ({ ...item, currency: "USD" })) };
    expect(officialPriceDraftIssues(draft)).toEqual(["官方模型版本", "免费/付费档"]);
    expect(() => validateOfficialPriceInput(draft)).toThrow("免费或付费档");
    expect(officialPriceDraftIssues({ ...draft, series: price.series, officialVersion: price.officialVersion, tier: "paid" })).toEqual([]);
    expect(validateOfficialPriceInput({ ...price, series: "" }).series).toBe("");
});

it("reviews an official SKU without a logical model but prevents direct sales binding", () => {
    const unbound = validateOfficialPriceInput({ ...price, logicalModelId: "", capability: "image", items: price.items.map((item) => ({ ...item, currency: "USD" })) });
    expect(unbound.logicalModelId).toBe("");
    expect(unbound.capability).toBe("image");
    expect(officialPriceDraftIssues({ ...unbound, tier: "paid" })).toEqual([]);
    expect(() => validateOfficialPriceInput({ ...unbound, capability: undefined })).toThrow("模型能力");
    expect(() => validateSalesPolicy({ priceVersionIds: { flash: price.id } }, [{ ...price, ...unbound }], ["flash"])).toThrow("没有对应的已审核价目版本");
});

it("limits new candidate currency to international USD while retaining legacy price parsing", () => {
    expect(validateOfficialPriceInput(price).items[2].currency).toBe("CNY");
    expect(officialPriceDraftIssues(price)).toContain("仅支持国际站 USD 官方价");
    expect(() => assertUsdOfficialPriceInput(validateOfficialPriceInput(price))).toThrow("仅支持国际站 USD 官方价");
    expect(() => assertUsdOfficialPriceInput(validateOfficialPriceInput({ ...price, items: price.items.map((item) => ({ ...item, currency: "USD" })) }))).not.toThrow();
});
const completeUsage = (usage: Record<string, string>) => ({ inputTokens: "0", outputTokens: "0", imageCount: "0", cacheReadTokens: "0", ...usage });

it("distinguishes historical mainland Seedance evidence from BytePlus overseas pricing", () => {
    expect(isMainlandByteDancePrice({ manufacturer: "ByteDance / Volcengine", sourceUrl: "https://docs.volcengine.com/docs/aidap/Billing_items_and_prices_of_large_model_access?lang=en" })).toBe(true);
    expect(isMainlandByteDancePrice({ manufacturer: "ByteDance / Volcengine", sourceUrl: "https://docs.byteplus.com/en/docs/ModelArk/1544106" })).toBe(false);
});

it("keeps official Fast and Mini prices on matching logical model variants", () => {
    expect(hasMatchingOfficialVariant("dreamina-seedance-2-0-260128", "ByteDance-Seedance-2.0-Fast")).toBe(false);
    expect(hasMatchingOfficialVariant("dreamina-seedance-2-0-fast-260128", "ByteDance-Seedance-2.0-Fast")).toBe(true);
    expect(hasMatchingOfficialVariant("dreamina-seedance-2-0-mini-260615", "ByteDance-Seedance-2.0-Fast")).toBe(false);
});

it("does not associate Seedance 2.5 prices with a Seedance 2.0 logical model", () => {
    expect(hasMatchingOfficialVariant("dreamina-seedance-2-5-260628", "doubao-seedance-2-0-260128")).toBe(false);
    expect(hasMatchingOfficialVariant("dreamina-seedance-2-5-260628", "ByteDance-Seedance-2.5")).toBe(true);
    expect(hasMatchingOfficialVariant("dreamina-seedance-2-0-fast-260128", "ByteDance-Seedance-2.0-Fast")).toBe(true);
    expect(hasMatchingOfficialVariant("gemini-2.5-flash", "Gemini-2.5-Flash")).toBe(true);
});

it("only links ByteDance SKUs to the same family, version and edition", () => {
    expect(hasMatchingByteDanceSku("seedream-4-5-251128", "doubao-seedream-4-5-251128")).toBe(true);
    expect(hasMatchingByteDanceSku("seedream-4-5-251128", "doubao-seedream-4-0-250828")).toBe(false);
    expect(hasMatchingByteDanceSku("seed-2-0-pro-260328", "doubao-seed-2-0-mini-260215")).toBe(false);
    expect(hasMatchingByteDanceSku("dreamina-seedance-2-5-260628", "ByteDance-Seedance-2.5")).toBe(true);
});

it("keeps an explicitly reviewed OpenAI processing tier with its price version", () => {
    const input = { ...price, manufacturer: "OpenAI", processingTier: "batch" };
    expect(validateOfficialPriceInput(input).processingTier).toBe("batch");
    expect(() => validateOfficialPriceInput({ ...input, processingTier: "priority" })).toThrow("处理档位");
    expect(() => validateOfficialPriceInput({ ...input, processingTier: ["batch"] })).toThrow("处理档位");
    expect(() => validateOfficialPriceInput({ ...input, manufacturer: "Google" })).toThrow("处理档位");
});

it("offers only verified BytePlus media conditions and preserves custom vendor entries", () => {
    expect(officialPriceConditionChoices("ByteDance / Volcengine", "video", "dreamina-seedance-2-5-260628")).toEqual(["在线推理 · 视频生成"]);
    expect(officialPriceItemConditionChoices("ByteDance / Volcengine", "video", "dreamina-seedance-2-5-260628")).toHaveLength(4);
    expect(officialPriceItemConditionChoices("ByteDance / Volcengine", "image", "dola-seedream-5-0-pro-260628")).toContain("参考图 · 第 2 张起");
    expect(officialPriceItemConditionChoices("ByteDance / Volcengine", "text", "seed-2-0-pro-260328")).toEqual(["输入总量 ≤ 128000 token", "输入总量 > 128000 且 ≤ 256000 token"]);
    expect(officialPriceConditionChoices("ByteDance / Volcengine", "video", "unreviewed-video")).toEqual([]);
    expect(officialPriceItemConditionChoices("Other vendor", "image", "dola-seedream-5-0-pro-260628")).toEqual([]);
    expect(validateOfficialPriceInput({ ...price, conditions: "地区：国际", items: [{ ...price.items[0], condition: "自定义的官网条件" }] }).items[0].condition).toBe("自定义的官网条件");
});

it("preserves an optional catalog identity without changing manual official prices", () => {
    expect(validateOfficialPriceInput({ ...price, catalogVersionId: "catalog-version" }).catalogVersionId).toBe("catalog-version");
    expect(validateOfficialPriceInput({ ...price, catalogVersionId: undefined }).catalogVersionId).toBeUndefined();
    expect(() => validateOfficialPriceInput({ ...price, catalogVersionId: 42 })).toThrow("官方目录型号");
});

describe("published model sales quotation", () => {
    const policy = validateSalesPolicy(
        {
            priceVersionIds: { flash: price.id },
            conversion: { cnyPerUsd: "7", pointsPerCny: POINTS_PER_CNY, observedAt: "2026-09-27T00:00:00Z", evidence: "测试用业务汇率" },
            pointsPerCurrency: { USD: "700", CNY: POINTS_PER_CNY },
            rateEvidence: { USD: "测试用业务汇率", CNY: "测试用业务汇率" },
            userPriceRules: [
                { scope: "default", coefficient: "0.95" },
                { scope: "manufacturer", manufacturer: "Google", coefficient: "0.9" },
                { scope: "series", manufacturer: "Google", series: "Gemini 2.5", coefficient: "0.8" },
                { scope: "model", modelId: "flash", coefficient: "0.7" },
            ],
        },
        [price],
        ["flash", "pro"],
    );

    it("retains official free evidence but refuses to quote positive usage as a user giveaway", () => {
        const official = validateOfficialPriceInput({ ...price, tier: "free", conditions: "Official free tier remains evidence" });
        expect(official.tier).toBe("free");
        expect(official.items.at(-1)?.price).toBe("0");
        expect(() => quoteSalesPrice({ version: price, policy, usage: completeUsage({ cacheReadTokens: "1" }) })).toThrow("固定积分");
        expect(quoteSalesPrice({ version: price, policy, usage: completeUsage({}) }).exactPoints).toBe("0");
    });

    it("charges all usage at the normal rate despite documented supplier allowances", () => {
        const normal = { ...price, conditions: "Supplier offers the first 1000000 tokens free", items: [{ key: "tokens", unit: "token", per: "1000000", price: "1", currency: "USD" }] };
        expect(quoteSalesPrice({ version: normal, policy: { ...policy, userPriceRules: [] }, usage: { tokens: "1000000" } }).points).toBe("700.00");
        const tiny = { ...normal, items: [{ ...normal.items[0], price: `0.${"0".repeat(330)}1` }] };
        const quote = quoteSalesPrice({ version: tiny, policy, usage: { tokens: "1" } });
        expect(quote.exactPoints).not.toBe("0");
        expect(quote.points).toBe("0.00");
    });

    it("converts original-currency prices to USD and applies only the most specific user coefficient", () => {
        const result = quoteSalesPrice({ version: price, policy, usage: { inputTokens: "100000", outputTokens: "20000", imageCount: "1", cacheReadTokens: "0" } });
        expect(result.userCoefficient).toEqual({ value: "0.7", scope: "model" });
        expect(result.currencies[0]).toMatchObject({ currency: "USD", officialAmount: "0.18", usdAmount: "0.18" });
        expect(result.currencies[1]).toMatchObject({ currency: "CNY", officialAmount: "0.2", usdPerCurrency: "1/7" });
        expect(Number(result.currencies[1].usdAmount)).toBeCloseTo(0.2 / 7);
        expect(Number(result.officialAmountUsd)).toBeCloseTo(0.18 + 0.2 / 7);
        expect(result.pointsPerUsd).toBe("700");
        expect(result.points).toBe("102.20");
        for (const [count, coefficient, scope] of [
            [3, "0.8", "series"],
            [2, "0.9", "manufacturer"],
            [1, "0.95", "default"],
        ] as const) {
            expect(quoteSalesPrice({ version: price, policy: { ...policy, userPriceRules: policy.userPriceRules.slice(0, count) }, usage: completeUsage({ inputTokens: "100000" }) }).userCoefficient).toEqual({ value: coefficient, scope });
        }
    });

    it("quotes one unowned official version for two logical models without cloning the price", () => {
        const shared = { ...price, logicalModelId: "", items: [{ key: "tokens", unit: "token", per: "1000000", price: "1", currency: "USD" }] };
        const sales = {
            ...policy,
            userPriceRules: [
                { scope: "model" as const, modelId: "model-a", coefficient: "1" },
                { scope: "model" as const, modelId: "model-b", coefficient: "2" },
            ],
        };
        const first = quoteSalesPrice({ version: shared, modelId: "model-a", policy: sales, usage: { tokens: "1000000" } });
        const second = quoteSalesPrice({ version: shared, modelId: "model-b", policy: sales, usage: { tokens: "1000000" } });
        expect([first.officialVersionId, second.officialVersionId]).toEqual([shared.id, shared.id]);
        expect([first.modelId, first.points, second.modelId, second.points]).toEqual(["model-a", "700.00", "model-b", "1400.00"]);
        expect(shared.logicalModelId).toBe("");
        expect(() => quoteSalesPrice({ version: shared, policy: sales, usage: { tokens: "1000000" } })).toThrow("必须指定逻辑模型");
        expect(() => quoteSalesPrice({ version: shared, modelId: " ", policy: sales, usage: { tokens: "1000000" } })).toThrow("必须指定逻辑模型");
    });

    it("defaults to 100 percent, allows markup and rounds only the final points", () => {
        const result = quoteSalesPrice({ version: price, policy: { ...policy, userPriceRules: [] }, usage: completeUsage({ inputTokens: "33333.333", outputTokens: "1" }) });
        expect(result.userCoefficient).toEqual({ value: "1", scope: "default" });
        expect(result.points).toBe("23.34");
        expect(result.lines.find((item) => item.key === "cacheReadTokens")?.officialAmount).toBe("0");
        expect(quoteSalesPrice({ version: price, policy: { ...policy, userPriceRules: [{ scope: "model", modelId: "flash", coefficient: "1.2" }] }, usage: completeUsage({ inputTokens: "1000000" }) }).points).toBe("840.00");
        expect(() => quoteSalesPrice({ version: price, policy, usage: { inputTokens: "1" } })).toThrow("缺少 outputTokens 的实际用量");
    });

    it("sums small CNY charges before rounding, including a half-cent boundary", () => {
        const smallPrice = {
            ...price,
            items: [
                { key: "first", unit: "request", per: "1", price: "0.000025", currency: "CNY" },
                { key: "second", unit: "request", per: "1", price: "0.000025", currency: "CNY" },
            ],
        };
        expect(quoteSalesPrice({ version: smallPrice, policy: { ...policy, userPriceRules: [] }, usage: { first: "1", second: "1" } }).points).toBe("0.01");
    });

    it("preserves the exact converted amount for accumulation rather than reusing the preview rounding", () => {
        const result = quoteSalesPrice({ version: price, policy: { ...policy, userPriceRules: [] }, usage: completeUsage({ inputTokens: "1" }) });
        expect(result.points).toBe("0.00");
        expect(result.exactPoints).toBe("7/10000");
        expect(JSON.parse(JSON.stringify(result)).exactPoints).toBe("7/10000");
    });

    it("does not move a charge just below half a point-cent onto the rounding boundary", () => {
        const boundaryPrice = { ...price, items: [{ key: "request", unit: "request", per: "1", price: "0.00004999999999999999999999999999", currency: "CNY" }] };
        expect(quoteSalesPrice({ version: boundaryPrice, policy: { ...policy, userPriceRules: [] }, usage: { request: "1" } }).points).toBe("0.00");
    });

    it("keeps non-terminating unit division exact through currency conversion", () => {
        const groupedPrice = { ...price, items: [{ key: "request", unit: "request", per: "3", price: "1", currency: "USD" }] };
        const quote = quoteSalesPrice({ version: groupedPrice, policy: { ...policy, userPriceRules: [] }, usage: { request: "1" } });
        expect(quote.exactPoints).toBe("700/3");
        expect(quote.points).toBe("233.33");
    });

    it("rejects missing conversion, wrong price binding, duplicate items and duplicate coefficients", () => {
        expect(() => validateSalesPolicy({ priceVersionIds: { flash: price.id }, userPriceRules: [] }, [price], ["flash"])).toThrow("汇率");
        expect(() => validateSalesPolicy({ priceVersionIds: { pro: price.id }, userPriceRules: [] }, [price], ["pro"])).toThrow("已审核");
        expect(() => validateOfficialPriceInput({ ...price, items: [price.items[0], price.items[0]] })).toThrow("不能重复");
        expect(() =>
            validateSalesPolicy(
                {
                    ...policy,
                    userPriceRules: [
                        { scope: "default", coefficient: "1" },
                        { scope: "default", coefficient: "0.9" },
                    ],
                },
                [price],
                ["flash"],
            ),
        ).toThrow("不能重复");
    });

    it("fixes the CNY point baseline at 100 while preserving a versioned business FX rate", () => {
        const converted = validateSalesPolicy(
            {
                priceVersionIds: { flash: price.id },
                userPriceRules: [],
                conversion: { cnyPerUsd: "7", observedAt: "2026-09-27T00:00:00Z", evidence: "管理员确认" },
                pointsPerCurrency: {},
                rateEvidence: {},
            },
            [price],
            ["flash"],
        );
        expect(converted.pointsPerCurrency).toMatchObject({ CNY: "100", USD: "700" });
        expect(() => validateSalesPolicy({ ...converted, conversion: { ...converted.conversion, pointsPerCny: "50" } }, [price], ["flash"])).toThrow("固定换算");
        expect(() => validateSalesPolicy({ ...converted, pointsPerCurrency: { USD: "701" } }, [price], ["flash"])).toThrow("不一致");
        expect(() => validateSalesPolicy({ ...converted, userPriceRules: {} }, [price], ["flash"])).toThrow("规则格式");
        expect(() => validateSalesPolicy({ ...converted, planRules: [{ planId: "monthly", coefficient: "0.8" }] }, [price], ["flash"])).toThrow("已停用");
    });

    it("requires an evidenced USD exchange rate for another official currency", () => {
        const euroPrice = { ...price, items: [{ key: "generation", unit: "video", per: "1", price: "2", currency: "EUR" }] };
        const base = { priceVersionIds: { flash: price.id }, userPriceRules: [], conversion: policy.conversion, pointsPerCurrency: {}, rateEvidence: {} };
        expect(() => validateSalesPolicy(base, [euroPrice], ["flash"])).toThrow("EUR 兑美元汇率");
        expect(() => validateSalesPolicy({ ...base, usdPerCurrency: { EUR: "1.1" } }, [euroPrice], ["flash"])).toThrow("EUR 换算依据");
        const euroPolicy = validateSalesPolicy({ ...base, usdPerCurrency: { EUR: "1.1" }, rateEvidence: { EUR: "2026-09-27 财务核对" } }, [euroPrice], ["flash"]);
        const quote = quoteSalesPrice({ version: euroPrice, policy: euroPolicy, usage: { generation: "1" } });
        expect(quote.officialAmountUsd).toBe("2.2");
        expect(quote.points).toBe("1540.00");
    });

    it("validates the independently saved business FX rate", () => {
        expect(validateBusinessExchangeRate({ cnyPerUsd: "7", observedAt: "2026-09-27T00:00:00Z", evidence: "管理员业务假设" })).toEqual({ cnyPerUsd: "7", observedAt: "2026-09-27T00:00:00Z", evidence: "管理员业务假设" });
        expect(() => validateBusinessExchangeRate({ cnyPerUsd: "0", observedAt: "2026-09-27T00:00:00Z", evidence: "管理员业务假设" })).toThrow("汇率");
    });
});
