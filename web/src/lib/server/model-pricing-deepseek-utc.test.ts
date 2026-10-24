import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { DEEPSEEK_TIME_PRICE_KEYS, deepSeekSalesTimeTier, supportsDeepSeekTimePricing, validateSalesPolicy, type OfficialPriceVersion, type SalesVersion } from "@/lib/model-pricing";
import { modelPricingEffectiveTerms } from "./model-pricing-effective-terms";
import { prepareFlatTextRequestBound } from "./model-pricing-request-bound";
import { quoteTextFacts } from "./model-pricing-text-fact-quote";
import { previewObservedFlatTextQuote, validateFlatTextPriceContract } from "./model-pricing-token-contract";
import { inspectProviderTokenUsage } from "./model-pricing-token-usage";
import { textUsageFacts } from "./model-pricing-usage-facts";

const modelId = "deepseek-future-model";
const version: OfficialPriceVersion = {
    id: "deepseek-price",
    candidateId: "candidate",
    logicalModelId: modelId,
    manufacturer: "DeepSeek",
    series: "DeepSeek",
    officialVersion: "Future",
    sku: modelId,
    tier: "paid",
    conditions: "global standard",
    sourceKind: "manual",
    sourceUrl: "https://api-docs.deepseek.com/quick_start/pricing/",
    evidence: "Reviewed fixture",
    observedAt: "2026-10-01T00:00:00Z",
    publishedAt: "2026-10-01T00:00:00Z",
    reviewedBy: "admin",
    items: [...DEEPSEEK_TIME_PRICE_KEYS.peak, ...DEEPSEEK_TIME_PRICE_KEYS.offPeak].map((key) => ({
        key,
        unit: "token",
        per: "1000000",
        currency: "USD",
        price: key.endsWith("OffPeak") ? "1" : "2",
    })),
};
const basePolicy: SalesVersion = {
    id: "sales",
    publishedAt: "2026-10-01T00:00:00Z",
    publishedBy: "admin",
    priceVersionIds: { [modelId]: version.id },
    userPriceRules: [],
    conversion: { cnyPerUsd: "7", pointsPerCny: "100", observedAt: "2026-10-01T00:00:00Z", evidence: "Reviewed fixture" },
    usdPerCurrency: { USD: "1", CNY: "1/7" },
    pointsPerCurrency: { USD: "700", CNY: "100" },
    rateEvidence: { USD: "reviewed" },
};
const mapping = Object.fromEntries(version.items.map(({ key }) => [key, [key.startsWith("cacheHit") ? "cachedInputTokens" : key.startsWith("cacheMiss") ? "uncachedInputTokens" : "outputTokens"]]));
const contract = validateFlatTextPriceContract(
    {
        channelId: "deepseek-channel",
        protocol: "openai-chat",
        requestedModel: modelId,
        reportedModel: modelId,
        scope: "global-standard-deepseek-utc",
        region: "global",
        serviceTier: "default",
        itemMeters: mapping,
        evidence: "Reviewed native cache hit/miss and output counters",
        requestLimits: {
            maxInputTokens: 1000,
            maxOutputTokens: 100,
            maxCandidates: 1,
            sourceUrl: version.sourceUrl,
            evidence: "Reviewed request limits",
            includesReasoning: true,
        },
    },
    version,
    "admin",
    "2026-10-01T00:00:00Z",
);
const observed = inspectProviderTokenUsage("openai-chat", {
    model: modelId,
    usage: { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 30, prompt_cache_miss_tokens: 70 },
});
const call = (occurredAt: string) => ({
    channelId: contract.channelId,
    salesVersionId: basePolicy.id,
    officialVersionId: version.id,
    requestedModel: modelId,
    region: "global",
    serviceTier: "default",
    billingMode: "standard",
    inputModalities: ["text"],
    outputModalities: ["text"],
    usesExternalTools: false,
    responseComplete: true,
    occurredAt,
});

describe("DeepSeek UTC sales tiers", () => {
    it("recognizes future models by audited manufacturer and six price items, without a model allowlist", () => {
        expect(supportsDeepSeekTimePricing(version)).toBe(true);
        expect(supportsDeepSeekTimePricing({ ...version, manufacturer: "OpenAI" })).toBe(false);
        expect(supportsDeepSeekTimePricing({ ...version, items: version.items.slice(1) })).toBe(false);
        expect(supportsDeepSeekTimePricing({ ...version, sku: "unrelated-alias" })).toBe(false);
        expect(validateSalesPolicy({ ...basePolicy, deepSeekUtcWindowModels: [modelId] }, [version], [modelId]).deepSeekUtcWindowModels).toEqual([modelId]);
        expect(() => validateSalesPolicy({ ...basePolicy, deepSeekUtcWindowModels: [modelId] }, [{ ...version, manufacturer: "OpenAI" }], [modelId])).toThrow("不能启用 DeepSeek");
    });

    it("uses UTC weekday boundaries and defaults to peak while the switch is off", () => {
        const enabled = { ...basePolicy, deepSeekUtcWindowModels: [modelId] };
        for (const [time, tier] of [
            ["2026-10-12T00:59:59Z", "offPeak"],
            ["2026-10-12T01:00:00Z", "peak"],
            ["2026-10-12T04:00:00Z", "offPeak"],
            ["2026-10-12T06:00:00Z", "peak"],
            ["2026-10-12T10:00:00Z", "offPeak"],
            ["2026-10-11T02:00:00Z", "offPeak"],
        ])
            expect(deepSeekSalesTimeTier(version, enabled, time)).toBe(tier);
        expect(deepSeekSalesTimeTier(version, basePolicy, "2026-10-11T02:00:00Z")).toBe("peak");
    });

    it("uses a reviewed shared official price for a differently named logical model", () => {
        const logicalModelId = "deepseek-studio";
        const shared = { ...version, logicalModelId: "", capability: "text" as const };
        const binding = {
            id: "shared-binding",
            logicalModelId,
            capability: "text" as const,
            operation: "generation" as const,
            processingMode: "standard" as const,
            scope: "text:generation:standard",
            officialVersionId: shared.id,
            status: "active" as const,
            revision: "shared-revision",
            current: true,
            evidence: "Reviewed exact DeepSeek SKU",
            reviewedAt: shared.publishedAt,
            reviewedBy: "admin",
        };
        const selection = { logicalModelId, scope: binding.scope, bindingId: binding.id, bindingRevision: binding.revision, officialVersionId: shared.id };
        const published = validateSalesPolicy(
            {
                ...basePolicy,
                priceVersionIds: {},
                selectedPriceBindings: [selection],
                deepSeekUtcWindowModels: [logicalModelId],
            },
            [shared],
            [logicalModelId],
            [binding],
        );
        const policy = { ...basePolicy, ...published, selectedPriceBindings: [selection] };
        const reviewed = validateFlatTextPriceContract(contract, shared, "admin", contract.reviewedAt);
        const selectedCall = { ...call("2026-10-12T04:00:00Z"), modelId: logicalModelId, priceSelection: selection };

        expect(supportsDeepSeekTimePricing(shared)).toBe(true);
        expect(deepSeekSalesTimeTier(shared, policy, selectedCall.occurredAt, logicalModelId)).toBe("offPeak");
        expect(deepSeekSalesTimeTier(shared, policy, selectedCall.occurredAt)).toBe("peak");
        const quote = previewObservedFlatTextQuote({ version: shared, policy, contract: reviewed, observation: observed, call: selectedCall });
        expect(quote).toMatchObject({ ready: true, usage: { cacheHitInputTokensPeak: "0", cacheHitInputTokensOffPeak: "30", outputTokensOffPeak: "10" } });
        expect(
            prepareFlatTextRequestBound({
                version: shared,
                policy,
                contract: reviewed,
                payload: { model: modelId, messages: [{ role: "user", content: "Hello" }], max_tokens: 100 },
                occurredAt: selectedCall.occurredAt,
                modelId: logicalModelId,
                priceSelection: selection,
            }),
        ).toMatchObject({ ready: true, activeItemKeys: DEEPSEEK_TIME_PRICE_KEYS.offPeak });
        const settled = quoteTextFacts({
            version: shared,
            policy,
            modelId: logicalModelId,
            contract: reviewed,
            contractId: "deepseek-contract",
            occurredAt: selectedCall.occurredAt,
            facts: textUsageFacts({ attemptId: "deepseek-attempt", evidenceId: "deepseek-response", observation: observed, meters: ["uncachedInputTokens", "cachedInputTokens", "outputTokens"] }),
        });
        expect(settled.usage).toMatchObject({ cacheHitInputTokensPeak: "0", cacheHitInputTokensOffPeak: "30", outputTokensOffPeak: "10" });
        expect(settled.quote.lines.filter((line) => line.selected).map((line) => line.key)).toEqual(DEEPSEEK_TIME_PRICE_KEYS.offPeak);
        expect(modelPricingEffectiveTerms(shared, policy, logicalModelId)).not.toBe(modelPricingEffectiveTerms(shared, { ...policy, deepSeekUtcWindowModels: [] }, logicalModelId));
        expect(() => validateSalesPolicy({ ...basePolicy, priceVersionIds: {}, selectedPriceBindings: [selection], deepSeekUtcWindowModels: ["unbound"] }, [shared], [logicalModelId, "unbound"], [binding])).toThrow("不能启用 DeepSeek");
    });

    it("prices only one tier per call and freezes the same tier for reservation and settlement", () => {
        const enabled = { ...basePolicy, deepSeekUtcWindowModels: [modelId] };
        const peakTime = "2026-10-12T02:00:00Z";
        const offPeakTime = "2026-10-12T04:00:00Z";
        const peak = previewObservedFlatTextQuote({ version, policy: enabled, contract, observation: observed, call: call(peakTime) });
        const offPeak = previewObservedFlatTextQuote({ version, policy: enabled, contract, observation: observed, call: call(offPeakTime) });
        if (!peak.ready || !offPeak.ready) throw new Error(JSON.stringify({ peak, offPeak }));
        expect(peak).toMatchObject({ ready: true, usage: { cacheHitInputTokensPeak: "30", cacheMissInputTokensPeak: "70", outputTokensPeak: "10", cacheHitInputTokensOffPeak: "0" } });
        expect(offPeak).toMatchObject({ ready: true, usage: { cacheHitInputTokensPeak: "0", cacheHitInputTokensOffPeak: "30", cacheMissInputTokensOffPeak: "70", outputTokensOffPeak: "10" } });
        expect(Number(peak.quote.points)).toBeGreaterThan(Number(offPeak.quote.points));
        const bound = (occurredAt: string) => prepareFlatTextRequestBound({ version, policy: enabled, contract, payload: { model: modelId, messages: [{ role: "user", content: "Hello" }], max_tokens: 100 }, occurredAt });
        expect(bound(peakTime)).toMatchObject({ ready: true, activeItemKeys: DEEPSEEK_TIME_PRICE_KEYS.peak, maximumQuoteUsage: { cacheHitInputTokensOffPeak: "0" } });
        expect(bound(offPeakTime)).toMatchObject({ ready: true, activeItemKeys: DEEPSEEK_TIME_PRICE_KEYS.offPeak, maximumQuoteUsage: { cacheHitInputTokensPeak: "0" } });
        expect(prepareFlatTextRequestBound({ version, policy: enabled, contract, payload: { model: modelId, messages: [{ role: "user", content: "Hello" }], max_completion_tokens: 100 }, occurredAt: peakTime })).toMatchObject({
            ready: false,
            reasons: ["DeepSeek Chat 按量请求须使用已核实的 max_tokens 上界"],
        });
        expect(prepareFlatTextRequestBound({ version, policy: enabled, contract, payload: { model: modelId, messages: [{ role: "user", content: "Hello" }], max_tokens: 101 }, occurredAt: peakTime })).toMatchObject({
            ready: false,
            reasons: ["请求输出 Token 上限超出已审核上界"],
        });
        const catalogLimits = { ...contract, requestLimits: { ...contract.requestLimits!, maxInputTokens: 1048576, maxOutputTokens: 393216 } };
        expect(prepareFlatTextRequestBound({ version, policy: enabled, contract: catalogLimits, payload: { model: modelId, messages: [{ role: "user", content: "Hello" }], max_tokens: 393216 }, occurredAt: peakTime })).toMatchObject({
            ready: true,
            outputTokens: "393216",
        });
        expect(prepareFlatTextRequestBound({ version, policy: enabled, contract: catalogLimits, payload: { model: modelId, messages: [{ role: "user", content: "Hello" }], max_tokens: 393217 }, occurredAt: peakTime })).toMatchObject({
            ready: false,
            reasons: ["请求输出 Token 上限超出已审核上界"],
        });
    });

    it("rejects duplicate or incomplete mappings and isolates other manufacturers' activation terms", () => {
        expect(() => validateFlatTextPriceContract({ ...contract, itemMeters: { ...mapping, cacheHitInputTokensPeak: ["uncachedInputTokens"] } }, version, "admin", contract.reviewedAt)).toThrow("必须绑定");
        const other = { ...version, manufacturer: "OpenAI" };
        expect(modelPricingEffectiveTerms(other, basePolicy)).toBe(modelPricingEffectiveTerms(other, { ...basePolicy, deepSeekUtcWindowModels: [modelId] }));
        const legacyOffTerms = createHash("sha256")
            .update(JSON.stringify({ officialVersionId: version.id, coefficient: "1", cnyPerUsd: "7", usdPerCurrency: {} }))
            .digest("hex");
        expect(modelPricingEffectiveTerms(version, basePolicy)).toBe(legacyOffTerms);
        expect(modelPricingEffectiveTerms(version, basePolicy)).not.toBe(modelPricingEffectiveTerms(version, { ...basePolicy, deepSeekUtcWindowModels: [modelId] }));
    });
});
