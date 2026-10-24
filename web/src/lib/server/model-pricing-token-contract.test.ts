import { describe, expect, it } from "vitest";
import Fraction from "fraction.js";

import type { OfficialPriceVersion, SalesVersion, TextUsageRule } from "@/lib/model-pricing";
import { prepareFlatTextRequestBound } from "./model-pricing-request-bound";
import { inspectProviderTokenUsage } from "./model-pricing-token-usage";
import { textUsageFacts } from "./model-pricing-usage-facts";
import { quoteTextFacts } from "./model-pricing-text-fact-quote";
import { previewObservedFlatTextQuote, validateFlatTextPriceContract, type FlatTextCallContext, type FlatTextPriceContract } from "./model-pricing-token-contract";

const version: OfficialPriceVersion = {
    id: "official-v1",
    candidateId: "approved-candidate",
    logicalModelId: "text-model",
    manufacturer: "OpenAI",
    series: "GPT",
    officialVersion: "gpt-test",
    sku: "gpt-test",
    tier: "paid",
    conditions: "国际标准文本 API，所有上下文长度",
    sourceKind: "manual",
    sourceUrl: "https://developers.openai.com/api/docs/pricing",
    evidence: "管理员核对官网标准档",
    observedAt: "2026-10-01T00:00:00Z",
    publishedAt: "2026-10-01T00:00:00Z",
    reviewedBy: "admin",
    effectiveFrom: "2026-10-01T00:00:00Z",
    items: [
        { key: "ordinaryInput", unit: "token", per: "1000000", price: "1", currency: "USD" },
        { key: "cachedInput", unit: "token", per: "1000000", price: "0.1", currency: "USD" },
        { key: "output", unit: "token", per: "1000000", price: "4", currency: "USD" },
    ],
};
const policy: SalesVersion = {
    id: "sales-v1",
    publishedAt: "2026-10-01T13:00:00Z",
    publishedBy: "admin",
    priceVersionIds: { "text-model": version.id },
    userPriceRules: [],
    conversion: { cnyPerUsd: "7", pointsPerCny: "100", observedAt: "2026-10-01T00:00:00Z", evidence: "管理员业务汇率" },
    usdPerCurrency: { USD: "1", CNY: "1/7" },
    pointsPerCurrency: { USD: "700", CNY: "100" },
    rateEvidence: { USD: "管理员业务汇率" },
};
const contract: FlatTextPriceContract = {
    officialVersionId: version.id,
    channelId: "official-channel",
    protocol: "openai-responses",
    requestedModel: "gpt-test",
    reportedModel: "gpt-test-2026",
    scope: "global-standard-text-flat",
    region: "global",
    serviceTier: "default",
    itemMeters: { ordinaryInput: ["inputTokens", "cacheWriteTokens"], cachedInput: ["cachedInputTokens"], output: ["outputTokens"] },
    evidence: "该型号标准实时文本 API 各分项均有官网价格和渠道响应样本",
    reviewedAt: "2026-10-01T12:00:00Z",
    reviewedBy: "admin",
};
const call: FlatTextCallContext = {
    channelId: "official-channel",
    salesVersionId: policy.id,
    officialVersionId: version.id,
    requestedModel: "gpt-test",
    region: "global",
    serviceTier: "default",
    billingMode: "standard",
    inputModalities: ["text"],
    outputModalities: ["text"],
    usesExternalTools: false,
    responseComplete: true,
    occurredAt: "2026-10-02T00:00:00Z",
};
const observation = inspectProviderTokenUsage("openai-responses", { model: "gpt-test-2026", service_tier: "default", usage: { input_tokens: 1000, output_tokens: 90, input_tokens_details: { cached_tokens: 300, cache_write_tokens: 200 } } });
const tieredVersion: OfficialPriceVersion = {
    ...version,
    items: (["short", "long"] as const).flatMap((tier) => [
        { key: `${tier}Input`, unit: "token", per: "1000000", price: tier === "short" ? "2" : "4", currency: "USD" },
        { key: `${tier}Cached`, unit: "token", per: "1000000", price: tier === "short" ? "0.1" : "0.2", currency: "USD" },
        { key: `${tier}Write`, unit: "token", per: "1000000", price: tier === "short" ? "2.5" : "5", currency: "USD" },
        { key: `${tier}Output`, unit: "token", per: "1000000", price: tier === "short" ? "10" : "15", currency: "USD" },
    ]),
};
const tieredInput = {
    ...contract,
    scope: "global-standard-text-tiered" as const,
    itemMeters: {
        shortInput: ["inputTokens"],
        shortCached: ["cachedInputTokens"],
        shortWrite: ["cacheWriteTokens"],
        shortOutput: ["outputTokens"],
        longInput: ["inputTokens"],
        longCached: ["cachedInputTokens"],
        longWrite: ["cacheWriteTokens"],
        longOutput: ["outputTokens"],
    } as FlatTextPriceContract["itemMeters"],
    contextTiers: {
        thresholdInputTokens: 272,
        shortItemKeys: ["shortInput", "shortCached", "shortWrite", "shortOutput"],
        longItemKeys: ["longInput", "longCached", "longWrite", "longOutput"],
        sourceUrl: "https://developers.openai.com/api/docs/models/gpt-6.1-sol",
        evidence: "Official full-request context threshold",
    },
};

describe("flat text official-price contract", () => {
    it("validates an independently reviewed estimate while retaining historical observed settlement", () => {
        const reservationEstimate = { method: "request-size-recent-output" as const, sourceUrl: "https://example.com/text-estimate", evidence: "reviewed request and recent output samples" };
        expect(validateFlatTextPriceContract({ ...contract, reservationEstimate }, version, "admin", contract.reviewedAt).reservationEstimate).toEqual(reservationEstimate);
        expect(validateFlatTextPriceContract(contract, version, "admin", contract.reviewedAt).reservationEstimate).toBeUndefined();
        for (const invalid of [
            { ...reservationEstimate, method: "fixed-points" },
            { ...reservationEstimate, sourceUrl: "http://example.com/text-estimate" },
            { ...reservationEstimate, evidence: "" },
        ])
            expect(() => validateFlatTextPriceContract({ ...contract, reservationEstimate: invalid }, version, "admin", contract.reviewedAt)).toThrow("预留估算");
    });
    it("requires reviewed channel identity before pricing a text alias", () => {
        const selectedVersion = { ...version, logicalModelId: "", capability: "text" as const };
        const selection = { logicalModelId: "text-model", scope: "text:generation:standard", bindingId: "price-binding", bindingRevision: "revision", officialVersionId: version.id };
        const selectedPolicy = { ...policy, priceVersionIds: {}, selectedPriceBindings: [selection] };
        const alias = {
            ...contract,
            requestedModel: "proxy-gpt",
            identity: { channelBindingId: "binding-1", officialSku: version.sku, operation: "generation" as const, modelIdentity: "response-required" as const, sourceUrl: "https://example.com/channel-identity", evidence: "逐项核对代理请求名与官网型号" },
        };
        const aliasCall = { ...call, modelId: "text-model", priceSelection: selection, requestedModel: alias.requestedModel };
        expect(() => validateFlatTextPriceContract({ ...alias, identity: undefined }, selectedVersion, "admin", contract.reviewedAt)).toThrow("渠道别名缺少");
        expect(() => validateFlatTextPriceContract({ ...alias, identity: { ...alias.identity, officialSku: "other" } }, selectedVersion, "admin", contract.reviewedAt)).toThrow("官网 SKU");
        expect(() => validateFlatTextPriceContract({ ...alias, identity: { ...alias.identity, sourceUrl: "http://example.com" } }, selectedVersion, "admin", contract.reviewedAt)).toThrow("HTTPS");
        expect(validateFlatTextPriceContract(alias, selectedVersion, "admin", contract.reviewedAt)).toMatchObject({ requestedModel: "proxy-gpt", identity: { officialSku: version.sku, channelBindingId: "binding-1" } });
        expect(previewObservedFlatTextQuote({ version: selectedVersion, policy: selectedPolicy, contract: alias, observation, call: aliasCall })).toMatchObject({ ready: true });
        expect(previewObservedFlatTextQuote({ version: selectedVersion, policy: selectedPolicy, contract: { ...alias, identity: undefined }, observation, call: aliasCall })).toMatchObject({
            ready: false,
            reasons: expect.arrayContaining([expect.stringContaining("渠道别名缺少")]),
        });
        expect(previewObservedFlatTextQuote({ version: selectedVersion, policy: selectedPolicy, contract: alias, observation: { ...observation, reportedModel: "different" }, call: aliasCall })).toMatchObject({
            ready: false,
            reasons: expect.arrayContaining([expect.stringContaining("响应型号与已审核身份不一致")]),
        });
        expect(previewObservedFlatTextQuote({ version: selectedVersion, policy: selectedPolicy, contract: alias, observation: { ...observation, reportedModel: undefined }, call: aliasCall })).toMatchObject({
            ready: false,
            reasons: expect.arrayContaining(["渠道别名缺少要求的响应型号"]),
        });
        expect(
            previewObservedFlatTextQuote({
                version: selectedVersion,
                policy: selectedPolicy,
                contract: { ...alias, identity: { ...alias.identity, modelIdentity: "reviewed-request" } },
                observation: { ...observation, reportedModel: undefined },
                call: aliasCall,
            }),
        ).toMatchObject({ ready: true });
    });
    it("reviews one field mapping across the published Standard price groups without flattening their prices", () => {
        const line = (lineId: string, meter: string, price: string) => ({ lineId, meter, unit: "token" as const, per: "1000000", price, currency: "USD" as const, evidence: "fixture official row" });
        const scheduled = {
            ...version,
            logicalModelId: "",
            capability: "text" as const,
            items: [],
            textPriceSchedule: {
                declaredRange: { minInclusive: 0, maxInclusive: 256000 },
                meters: [
                    { meter: "inputTokens", unit: "token" as const },
                    { meter: "cachedInputTokens", unit: "token" as const },
                    { meter: "outputTokens", unit: "token" as const },
                ],
                groups: [
                    {
                        id: "short",
                        scopeKind: "generation" as const,
                        selector: { processingMode: "standard" as const, inputTotalTokens: { minInclusive: 0, maxInclusive: 128000 } },
                        lines: [line("short-input", "inputTokens", "1"), line("short-cache", "cachedInputTokens", "0.1"), line("short-output", "outputTokens", "4")],
                    },
                    {
                        id: "long",
                        scopeKind: "generation" as const,
                        selector: { processingMode: "standard" as const, inputTotalTokens: { minInclusive: 128001, maxInclusive: 256000 } },
                        lines: [line("long-input", "inputTokens", "2"), line("long-cache", "cachedInputTokens", "0.2"), line("long-output", "outputTokens", "4")],
                    },
                ],
            },
        };
        const reviewed = validateFlatTextPriceContract(
            { ...contract, scope: "global-standard-text-tiered", itemMeters: { inputTokens: ["inputTokens", "cacheWriteTokens"], cachedInputTokens: ["cachedInputTokens"], outputTokens: ["outputTokens"] } },
            scheduled,
            "admin",
            contract.reviewedAt,
        );
        expect(reviewed).toMatchObject({ scope: "global-standard-text-tiered", itemMeters: { inputTokens: ["inputTokens", "cacheWriteTokens"] } });
        expect(reviewed.contextTiers).toBeUndefined();
        expect(() => validateFlatTextPriceContract({ ...reviewed, contextTiers: tieredInput.contextTiers }, scheduled, "admin", contract.reviewedAt)).toThrow("不能另填价档");
        expect(() => validateFlatTextPriceContract({ ...reviewed, itemMeters: { inputTokens: ["inputTokens"], cachedInputTokens: ["cachedInputTokens"], outputTokens: ["outputTokens"] } }, scheduled, "admin", contract.reviewedAt)).toThrow("全部计量字段");
        const priceSelection = { logicalModelId: "text-model", scope: "text:generation:standard", bindingId: "binding", bindingRevision: "revision", officialVersionId: scheduled.id };
        const published = { ...policy, priceVersionIds: {}, selectedPriceBindings: [priceSelection] };
        const pricedCall = { ...call, modelId: "text-model", priceSelection };
        const sample = (total: number) =>
            inspectProviderTokenUsage("openai-responses", { model: contract.reportedModel, service_tier: "default", usage: { input_tokens: total, output_tokens: 100, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } });
        for (const [total, groupId] of [
            [128000, "short"],
            [128001, "long"],
        ] as const) {
            const preview = previewObservedFlatTextQuote({ version: scheduled, policy: published, contract: reviewed, observation: sample(total), call: pricedCall });
            expect(preview).toMatchObject({ ready: true, quote: { selectedGroupId: groupId, modelId: "text-model" } });
            if (!preview.ready) continue;
            const facts = textUsageFacts({ attemptId: "attempt", evidenceId: "response", observation: preview.normalizedObservation, meters: ["inputTotalTokens", "inputTokens", "cacheWriteTokens", "cachedInputTokens", "outputTokens"] });
            const settled = quoteTextFacts({ version: scheduled, policy: published, modelId: "text-model", contract: reviewed, contractId: "contract", occurredAt: call.occurredAt, facts });
            expect(settled.quote).toMatchObject({
                selectedGroupId: groupId,
                exactPoints: preview.quote.exactPoints,
                lines: expect.arrayContaining([expect.objectContaining({ lineId: `${groupId}-input`, conditionFactIds: ["attempt:response:inputTotalTokens"] })]),
            });
        }
        expect(previewObservedFlatTextQuote({ version: scheduled, policy: published, contract: reviewed, observation: { ...sample(128001), quantities: { ...sample(128001).quantities, inputTotalTokens: "" } }, call: pricedCall })).toMatchObject({
            ready: false,
        });
    });
    it("quotes one ownerless official price per published model and frozen binding revision", () => {
        const shared = { ...version, logicalModelId: "", capability: "text" as const };
        const scope = "text:generation:standard";
        const selections = ["model-a", "model-b"].map((modelId) => ({ logicalModelId: modelId, scope, bindingId: `binding-${modelId}`, bindingRevision: `revision-${modelId}`, officialVersionId: shared.id }));
        const published: SalesVersion = { ...policy, priceVersionIds: {}, selectedPriceBindings: selections, userPriceRules: selections.map((item, index) => ({ scope: "model" as const, modelId: item.logicalModelId, coefficient: String(index + 1) })) };
        const sample = (index: number) => previewObservedFlatTextQuote({ version: shared, policy: published, contract, observation, call: { ...call, modelId: selections[index].logicalModelId, priceSelection: selections[index] } });
        const first = sample(0);
        const second = sample(1);
        expect(first.ready).toBe(true);
        expect(second.ready).toBe(true);
        if (!first.ready || !second.ready) return;
        expect(first.quote.modelId).toBe("model-a");
        expect(second.quote.modelId).toBe("model-b");
        expect(new Fraction(second.quote.exactPoints).equals(new Fraction(first.quote.exactPoints).mul(2))).toBe(true);
        expect(previewObservedFlatTextQuote({ version: shared, policy: published, contract, observation, call: { ...call, modelId: "model-a" } })).toMatchObject({ ready: false, reasons: expect.arrayContaining(["官方价版本与已发布售价不一致"]) });
        expect(
            prepareFlatTextRequestBound({
                version: shared,
                policy: published,
                contract: { ...contract, requestLimits: { maxInputTokens: 1000, maxOutputTokens: 100, maxCandidates: 1, sourceUrl: version.sourceUrl, evidence: "fixture", includesReasoning: true } },
                payload: { model: "gpt-test", input: "hello" },
                occurredAt: call.occurredAt,
                modelId: "model-a",
                priceSelection: { ...selections[0], bindingRevision: "old" },
            }),
        ).toMatchObject({ ready: false, reasons: ["上界契约与已发布价目不一致"] });
    });
    it("applies the two reviewed missing-cache switches independently without replacing reported values", () => {
        const rule: TextUsageRule = {
            id: "rule-1",
            modelId: version.logicalModelId,
            officialVersionId: version.id,
            cacheReadMissingAsZero: false,
            cacheWriteMissingAsZero: false,
            evidence: "渠道响应核对",
            reviewedAt: call.occurredAt,
            reviewedBy: "admin",
        };
        const missingBoth = inspectProviderTokenUsage("openai-responses", { usage: { input_tokens: 10, output_tokens: 5 } });
        for (const read of [false, true])
            for (const write of [false, true]) {
                const result = previewObservedFlatTextQuote({ version, policy, contract, call, observation: missingBoth, rules: { ...rule, cacheReadMissingAsZero: read, cacheWriteMissingAsZero: write } });
                expect(result.ready).toBe(read && write);
                if (result.ready) {
                    expect(result.usage).toMatchObject({ ordinaryInput: "10", cachedInput: "0", output: "5" });
                    expect(result.sources).toMatchObject({ cachedInputTokens: "defaulted-zero", cacheWriteTokens: "defaulted-zero" });
                    expect(result.normalizedObservation.meterSources).toMatchObject({
                        cachedInputTokens: { paths: ["rule:textUsageRule:rule-1"], kind: "approved-derivation" },
                        inputTokens: { inputMeters: ["inputTotalTokens", "cachedInputTokens", "cacheWriteTokens"] },
                    });
                    expect(textUsageFacts({ attemptId: "attempt-1", evidenceId: "response-1", observation: result.normalizedObservation, meters: ["cachedInputTokens", "inputTokens"] })).toMatchObject([
                        { value: "0", status: "derived", sourcePath: "rule:textUsageRule:rule-1" },
                        { value: "10", status: "derived", relation: { inputMeters: ["inputTotalTokens", "cachedInputTokens", "cacheWriteTokens"] } },
                    ]);
                    expect(missingBoth.meterSources?.cachedInputTokens).toBeUndefined();
                }
            }
        const reportedZero = inspectProviderTokenUsage("openai-responses", { usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } });
        expect(previewObservedFlatTextQuote({ version, policy, contract, call, observation: reportedZero, rules: rule })).toMatchObject({ ready: true, sources: { cachedInputTokens: "reported-zero", cacheWriteTokens: "reported-zero" } });
        const invalid = inspectProviderTokenUsage("openai-responses", { usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: null, cache_write_tokens: null } } });
        expect(previewObservedFlatTextQuote({ version, policy, contract, call, observation: invalid, rules: { ...rule, cacheReadMissingAsZero: true, cacheWriteMissingAsZero: true } })).toMatchObject({
            ready: false,
            reasons: expect.arrayContaining([expect.stringContaining("上游用量无效")]),
        });
    });

    it("delivers a quote with identity warnings only for complete known text usage", () => {
        const changed = inspectProviderTokenUsage("openai-responses", { model: "another-model", service_tier: "flex", usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } });
        expect(previewObservedFlatTextQuote({ version, policy, contract, call, observation: changed })).toMatchObject({ ready: true, warnings: [expect.stringContaining("响应型号"), expect.stringContaining("非 Standard")] });
        expect(previewObservedFlatTextQuote({ version, policy, contract, call: { ...call, serviceTier: "auto" }, observation: changed })).toMatchObject({ ready: false, reasons: expect.arrayContaining(["请求服务档位不是已审核 Standard"]) });
    });
    it("selects one complete context price tier from verified total input", () => {
        const reviewed = validateFlatTextPriceContract(tieredInput, tieredVersion, "admin", contract.reviewedAt);
        const observed = (total: number) =>
            inspectProviderTokenUsage("openai-responses", { model: contract.reportedModel, service_tier: "default", usage: { input_tokens: total, output_tokens: 10, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 32 } } });
        const short = previewObservedFlatTextQuote({ version: tieredVersion, policy, contract: reviewed, observation: observed(272), call });
        expect(short).toMatchObject({ ready: true, usage: { shortInput: "220", shortCached: "20", shortWrite: "32", shortOutput: "10", longInput: "0", longOutput: "0" }, quote: { exactPoints: "2177/5000" } });
        const long = previewObservedFlatTextQuote({ version: tieredVersion, policy, contract: reviewed, observation: observed(273), call });
        expect(long).toMatchObject({ ready: true, usage: { shortInput: "0", shortOutput: "0", longInput: "221", longCached: "20", longWrite: "32", longOutput: "10" }, quote: { exactPoints: "4193/5000" } });
        expect(previewObservedFlatTextQuote({ version: tieredVersion, policy, contract: reviewed, observation: { ...observed(273), quantities: { ...observed(273).quantities, inputTotalTokens: "" } }, call })).toMatchObject({
            ready: false,
            reasons: expect.arrayContaining(["缺少判定长上下文价档的输入总量"]),
        });
        expect(() => validateFlatTextPriceContract({ ...tieredInput, contextTiers: { ...tieredInput.contextTiers, longItemKeys: ["shortInput", ...tieredInput.contextTiers.longItemKeys.slice(1)] } }, tieredVersion, "admin", contract.reviewedAt)).toThrow(
            "完整且互斥",
        );
        expect(() => validateFlatTextPriceContract({ ...tieredInput, contextTiers: { ...tieredInput.contextTiers, thresholdInputTokens: 0 } }, tieredVersion, "admin", contract.reviewedAt)).toThrow("正整数");
    });
    it("charges GPT-5.4 short and long sessions without an unpublished cache-write rate", () => {
        const gpt54: OfficialPriceVersion = {
            ...version,
            sku: "gpt-5.4-2026-03-05",
            items: [
                { key: "inputTokensUpTo272k", unit: "token", per: "1000000", price: "2.5", currency: "USD" },
                { key: "cachedInputTokensUpTo272k", unit: "token", per: "1000000", price: "0.25", currency: "USD" },
                { key: "outputTokensUpTo272k", unit: "token", per: "1000000", price: "15", currency: "USD" },
                { key: "inputTokensOver272k", unit: "token", per: "1000000", price: "5", currency: "USD" },
                { key: "cachedInputTokensOver272k", unit: "token", per: "1000000", price: "0.5", currency: "USD" },
                { key: "outputTokensOver272k", unit: "token", per: "1000000", price: "22.5", currency: "USD" },
            ],
        };
        const keys = (tier: "UpTo272k" | "Over272k") => [`inputTokens${tier}`, `cachedInputTokens${tier}`, `outputTokens${tier}`];
        const reviewed = validateFlatTextPriceContract(
            {
                ...contract,
                scope: "global-standard-text-tiered",
                requestedModel: gpt54.sku,
                reportedModel: gpt54.sku,
                itemMeters: Object.fromEntries([...keys("UpTo272k"), ...keys("Over272k")].map((key) => [key, [key.startsWith("cached") ? "cachedInputTokens" : key.startsWith("output") ? "outputTokens" : "uncachedInputTokens"]])),
                contextTiers: {
                    thresholdInputTokens: 272000,
                    shortItemKeys: keys("UpTo272k"),
                    longItemKeys: keys("Over272k"),
                    sourceUrl: "https://developers.openai.com/api/docs/models/gpt-5.4",
                    evidence: "The full session switches above 272K input tokens",
                },
                requestLimits: {
                    maxInputTokens: 272001,
                    maxOutputTokens: 100,
                    maxCandidates: 1,
                    sourceUrl: "https://developers.openai.com/api/docs/models/gpt-5.4",
                    evidence: "Synthetic audited limit for the pricing boundary fixture",
                    includesReasoning: true,
                },
            },
            gpt54,
            "admin",
            contract.reviewedAt,
        );
        const quote = (inputTokens: number) =>
            previewObservedFlatTextQuote({
                version: gpt54,
                policy,
                contract: reviewed,
                call: { ...call, requestedModel: gpt54.sku },
                observation: inspectProviderTokenUsage("openai-responses", { model: gpt54.sku, service_tier: "default", usage: { input_tokens: inputTokens, output_tokens: 100, input_tokens_details: { cached_tokens: 20000 } } }),
            });
        expect(quote(272000)).toMatchObject({ ready: true, usage: { inputTokensUpTo272k: "252000", cachedInputTokensUpTo272k: "20000", outputTokensUpTo272k: "100", inputTokensOver272k: "0" }, quote: { exactPoints: "8911/20" } });
        expect(quote(272001)).toMatchObject({ ready: true, usage: { inputTokensUpTo272k: "0", inputTokensOver272k: "252001", cachedInputTokensOver272k: "20000", outputTokensOver272k: "100" }, quote: { exactPoints: "1781157/2000" } });
        const bound = (maxInputTokens: number) =>
            prepareFlatTextRequestBound({
                version: gpt54,
                policy,
                contract: { ...reviewed, requestLimits: { ...reviewed.requestLimits!, maxInputTokens } },
                payload: { model: gpt54.sku, input: "hello", max_output_tokens: 100 },
                occurredAt: call.occurredAt,
            });
        expect(bound(272000)).toMatchObject({ ready: true, maximumQuoteUsage: { inputTokensUpTo272k: "272000", outputTokensUpTo272k: "100", inputTokensOver272k: "0" }, maximumExactPoints: "9541/20" });
        expect(bound(272001)).toMatchObject({ ready: true, maximumQuoteUsage: { inputTokensUpTo272k: "0", inputTokensOver272k: "272001", outputTokensOver272k: "100" }, maximumExactPoints: "1907157/2000" });
    });
    it.each(version.items.map((item) => item.key))("keeps a free %s row out of text metering even when other rates are paid", (key) => {
        const zero = { ...version, items: version.items.map((item) => (item.key === key ? { ...item, price: "0.00" } : item)) };
        expect(() => validateFlatTextPriceContract(contract, zero, "admin", contract.reviewedAt)).toThrow("固定积分");
        expect(previewObservedFlatTextQuote({ version: zero, policy, contract, observation, call })).toMatchObject({ ready: false, reasons: [expect.stringContaining("固定积分")] });
        expect(version.items.every((item) => Number(item.price) > 0)).toBe(true);
    });

    it.each(["openai-chat", "openai-responses"] as const)("prices inclusive cache writes only under an explicit reviewed %s mapping", (protocol) => {
        const itemMeters: FlatTextPriceContract["itemMeters"] = { ordinaryInput: ["uncachedInputTokens"], cachedInput: ["cachedInputTokens"], output: ["outputTokens"] };
        const reviewed = validateFlatTextPriceContract({ ...contract, protocol, itemMeters, evidence: "官方明确缓存写入按普通输入价；按总输入减缓存读取核对" }, version, "admin", contract.reviewedAt);
        for (const writes of [undefined, 0, 200]) {
            const usage =
                protocol === "openai-chat"
                    ? { prompt_tokens: 1000, completion_tokens: 90, prompt_tokens_details: { cached_tokens: 300, cache_write_tokens: writes } }
                    : { input_tokens: 1000, output_tokens: 90, input_tokens_details: { cached_tokens: 300, cache_write_tokens: writes } };
            const observation = inspectProviderTokenUsage(protocol, { model: contract.reportedModel, service_tier: "default", usage });
            expect(previewObservedFlatTextQuote({ version, policy, contract: reviewed, observation, call })).toMatchObject({ ready: true, usage: { ordinaryInput: "700", cachedInput: "300", output: "90" }, quote: { exactPoints: "763/1000" } });
            if (writes === undefined) {
                expect(observation.quantities.cacheWriteTokens).toBeUndefined();
                expect(previewObservedFlatTextQuote({ version, policy, contract: { ...contract, protocol }, observation, call }).ready).toBe(false);
            }
        }
        const missingRead = inspectProviderTokenUsage(protocol, { model: contract.reportedModel, service_tier: "default", usage: protocol === "openai-chat" ? { prompt_tokens: 1000, completion_tokens: 90 } : { input_tokens: 1000, output_tokens: 90 } });
        expect(previewObservedFlatTextQuote({ version, policy, contract: reviewed, observation: missingRead, call })).toMatchObject({
            ready: false,
            reasons: expect.arrayContaining(["缺少 uncachedInputTokens 的真实用量", "缺少 cachedInputTokens 的真实用量"]),
        });
        const duplicate = { ...reviewed, itemMeters: { ...itemMeters, ordinaryInput: ["uncachedInputTokens", "cacheWriteTokens"] as const } };
        expect(() => validateFlatTextPriceContract(duplicate, version, "admin", contract.reviewedAt)).toThrow("无效或重复");
        expect(() => validateFlatTextPriceContract({ ...reviewed, protocol: "anthropic-messages" }, version, "admin", contract.reviewedAt)).toThrow("无效或重复");
    });

    it("quotes Kimi K2.6 cache hits and rejects unexpected cache writes", () => {
        const kimiVersion: OfficialPriceVersion = {
            ...version,
            manufacturer: "Moonshot",
            series: "Kimi K2.6",
            officialVersion: "kimi-k2.6",
            sku: "kimi-k2.6",
            items: [
                { key: "ordinaryInput", unit: "token", per: "1000000", price: "0.95", currency: "USD" },
                { key: "cachedInput", unit: "token", per: "1000000", price: "0.16", currency: "USD" },
                { key: "output", unit: "token", per: "1000000", price: "4", currency: "USD" },
            ],
        };
        const kimiContract = validateFlatTextPriceContract(
            {
                ...contract,
                protocol: "openai-chat",
                requestedModel: "kimi-k2.6",
                reportedModel: "kimi-k2.6",
                itemMeters: {
                    ordinaryInput: ["uncachedInputTokens"],
                    cachedInput: ["cachedInputTokens"],
                    output: ["outputTokens"],
                },
                evidence: "Kimi 官方资料确认 K2.6 缓存命中折价且不支持缓存写入",
            },
            kimiVersion,
            "admin",
            contract.reviewedAt,
        );
        const kimiCall = { ...call, requestedModel: "kimi-k2.6" };
        const inspect = (cacheWriteTokens?: number) =>
            inspectProviderTokenUsage("openai-chat", {
                model: "kimi-k2.6",
                service_tier: "default",
                usage: {
                    prompt_tokens: 1000,
                    completion_tokens: 90,
                    prompt_tokens_details: { cached_tokens: 300, ...(cacheWriteTokens === undefined ? {} : { cache_write_tokens: cacheWriteTokens }) },
                },
            });
        expect(previewObservedFlatTextQuote({ version: kimiVersion, policy, contract: kimiContract, observation: inspect(), call: kimiCall })).toMatchObject({
            ready: true,
            usage: { ordinaryInput: "700", cachedInput: "300", output: "90" },
            quote: { exactPoints: "7511/10000" },
        });
        expect(previewObservedFlatTextQuote({ version: kimiVersion, policy, contract: kimiContract, observation: inspect(0), call: kimiCall }).ready).toBe(true);
        expect(previewObservedFlatTextQuote({ version: kimiVersion, policy, contract: kimiContract, observation: inspect(200), call: kimiCall })).toMatchObject({
            ready: false,
            reasons: expect.arrayContaining(["Kimi K2.6 不支持缓存写入，回执计量需核对"]),
        });
    });

    it.each([
        { sku: "kimi-k2.7-code", input: "0.95", cache: "0.19", output: "4", exact: "3787/5000" },
        { sku: "kimi-k2.7-code-highspeed", input: "1.90", cache: "0.38", output: "8", exact: "3787/2500" },
    ])("holds $sku quotes when the response reports unverified cache writes", ({ sku, input, cache, output, exact }) => {
        const kimiVersion: OfficialPriceVersion = {
            ...version,
            manufacturer: "Moonshot",
            series: sku,
            officialVersion: sku,
            sku,
            items: [
                { key: "ordinaryInput", unit: "token", per: "1000000", price: input, currency: "USD" },
                { key: "cachedInput", unit: "token", per: "1000000", price: cache, currency: "USD" },
                { key: "output", unit: "token", per: "1000000", price: output, currency: "USD" },
            ],
        };
        const kimiContract = validateFlatTextPriceContract(
            {
                ...contract,
                protocol: "openai-chat",
                requestedModel: sku,
                reportedModel: sku,
                itemMeters: {
                    ordinaryInput: ["uncachedInputTokens"],
                    cachedInput: ["cachedInputTokens"],
                    output: ["outputTokens"],
                },
                evidence: "Kimi 官方仅公布 K2.7 Code 三项价格；正数缓存写入须核对",
            },
            kimiVersion,
            "admin",
            contract.reviewedAt,
        );
        const kimiCall = { ...call, requestedModel: sku };
        const quote = (cacheWriteTokens?: number) =>
            previewObservedFlatTextQuote({
                version: kimiVersion,
                policy,
                contract: kimiContract,
                call: kimiCall,
                observation: inspectProviderTokenUsage("openai-chat", {
                    model: sku,
                    service_tier: "default",
                    usage: {
                        prompt_tokens: 1000,
                        completion_tokens: 90,
                        prompt_tokens_details: { cached_tokens: 300, ...(cacheWriteTokens === undefined ? {} : { cache_write_tokens: cacheWriteTokens }) },
                    },
                }),
            });
        expect(quote()).toMatchObject({ ready: true, usage: { ordinaryInput: "700", cachedInput: "300", output: "90" }, quote: { exactPoints: exact } });
        expect(quote(0).ready).toBe(true);
        expect(quote(200)).toMatchObject({ ready: false, reasons: expect.arrayContaining(["Kimi K2.7 Code 缓存写入分项未核实，回执计量需核对"]) });
    });

    it("quotes Kimi K3 Chat writes only after their TTL buckets match the provider total", () => {
        const kimiVersion: OfficialPriceVersion = {
            ...version,
            manufacturer: "Moonshot",
            series: "Kimi K3",
            officialVersion: "kimi-k3",
            sku: "kimi-k3",
            items: [
                { key: "ordinaryInput", unit: "token", per: "1000000", price: "3", currency: "USD" },
                { key: "cachedInput", unit: "token", per: "1000000", price: "0.30", currency: "USD" },
                { key: "cacheWrite5m", unit: "token", per: "1000000", price: "3", currency: "USD" },
                { key: "cacheWrite1h", unit: "token", per: "1000000", price: "6", currency: "USD" },
                { key: "output", unit: "token", per: "1000000", price: "15", currency: "USD" },
            ],
        };
        const kimiContract = validateFlatTextPriceContract(
            {
                ...contract,
                protocol: "openai-chat",
                requestedModel: "kimi-k3",
                reportedModel: "kimi-k3",
                itemMeters: {
                    ordinaryInput: ["inputTokens"],
                    cachedInput: ["cachedInputTokens"],
                    cacheWrite5m: ["cacheWrite5mTokens"],
                    cacheWrite1h: ["cacheWrite1hTokens"],
                    output: ["outputTokens"],
                },
            },
            kimiVersion,
            "admin",
            contract.reviewedAt,
        );
        const payload = { model: "kimi-k3", service_tier: "default", usage: { prompt_tokens: 1000, completion_tokens: 90, prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 100 } } };
        const quote = (headers?: Headers) => previewObservedFlatTextQuote({ version: kimiVersion, policy, contract: kimiContract, observation: inspectProviderTokenUsage("openai-chat", payload, headers), call: { ...call, requestedModel: "kimi-k3" } });
        expect(quote(new Headers({ "Msh-Usage-Cache-Write-Tokens-5m": "60", "Msh-Usage-Cache-Write-Tokens-1h": "40" }))).toMatchObject({
            ready: true,
            usage: { ordinaryInput: "700", cachedInput: "200", cacheWrite5m: "60", cacheWrite1h: "40", output: "90" },
            quote: { exactPoints: "2751/1000" },
        });
        expect(quote()).toMatchObject({ ready: false, reasons: expect.arrayContaining(["缺少 cacheWrite5mTokens 的真实用量", "缺少 cacheWrite1hTokens 的真实用量"]) });
        expect(quote(new Headers({ "Msh-Usage-Cache-Write-Tokens-5m": "60", "Msh-Usage-Cache-Write-Tokens-1h": "41" }))).toMatchObject({ ready: false, reasons: expect.arrayContaining(["上游用量无效：缓存写入分档用量与总量不一致"]) });
        expect(() => validateFlatTextPriceContract({ ...kimiContract, itemMeters: { ...kimiContract.itemMeters, cacheWrite1h: ["cacheWriteTokens"] } }, kimiVersion, "admin", contract.reviewedAt)).toThrow("无效或重复");
    });

    it("uses DeepSeek-style native cache counters only through a reviewed inclusive mapping", () => {
        const reviewed = validateFlatTextPriceContract(
            {
                ...contract,
                protocol: "openai-chat",
                itemMeters: { ordinaryInput: ["uncachedInputTokens"], cachedInput: ["cachedInputTokens"], output: ["outputTokens"] },
                evidence: "Synthetic flat-price fixture; native hit and miss checked against total input",
            },
            version,
            "admin",
            contract.reviewedAt,
        );
        const usage = { prompt_tokens: 1000, completion_tokens: 90, prompt_tokens_details: { cached_tokens: 300 }, prompt_cache_hit_tokens: 300, prompt_cache_miss_tokens: 700 };
        const observed = inspectProviderTokenUsage("openai-chat", { model: contract.reportedModel, service_tier: "default", usage });
        expect(observed.quantities.cacheWriteTokens).toBeUndefined();
        expect(previewObservedFlatTextQuote({ version, policy, contract: reviewed, observation: observed, call })).toMatchObject({ ready: true, usage: { ordinaryInput: "700", cachedInput: "300", output: "90" } });
        const inconsistent = inspectProviderTokenUsage("openai-chat", { model: contract.reportedModel, service_tier: "default", usage: { ...usage, prompt_cache_miss_tokens: 699 } });
        expect(previewObservedFlatTextQuote({ version, policy, contract: reviewed, observation: inconsistent, call })).toMatchObject({ ready: false, reasons: [expect.stringContaining("原生缓存命中与未命中量之和不等于输入总量")] });
    });

    it("accepts only a complete reviewed meter mapping and stamps the reviewer", () => {
        const input = {
            channelId: contract.channelId,
            protocol: contract.protocol,
            requestedModel: contract.requestedModel,
            reportedModel: contract.reportedModel,
            scope: contract.scope,
            region: contract.region,
            serviceTier: contract.serviceTier,
            itemMeters: contract.itemMeters,
            evidence: contract.evidence,
        };
        expect(validateFlatTextPriceContract({ ...input, reviewedBy: "forged" }, version, "actual-admin", "2026-10-02T10:00:00Z")).toMatchObject({ officialVersionId: version.id, reviewedBy: "actual-admin", reviewedAt: "2026-10-02T10:00:00Z" });
        expect(() => validateFlatTextPriceContract({ ...input, itemMeters: { ordinaryInput: ["inputTokens"], cachedInput: ["cachedInputTokens"], output: ["outputTokens"] } }, version, "admin", "2026-10-02T10:00:00Z")).toThrow("全部计量字段");
        expect(() => validateFlatTextPriceContract({ ...input, itemMeters: { ...input.itemMeters, output: ["inputTokens", "outputTokens"] } }, version, "admin", "2026-10-02T10:00:00Z")).toThrow("无效或重复");
        expect(() => validateFlatTextPriceContract(input, { ...version, items: [...version.items, { key: "image", unit: "image", per: "1", price: "1", currency: "USD" }] }, "admin", "2026-10-02T10:00:00Z")).toThrow("分项完全一致");
        expect(() => validateFlatTextPriceContract({ ...input, region: "cn" }, version, "admin", "2026-10-02T10:00:00Z")).toThrow("全球标准");
    });

    it("quotes only a reviewed, published, fully covered text call and charges cache writes once", () => {
        const result = previewObservedFlatTextQuote({ version, policy, contract, observation, call });
        expect(result).toMatchObject({ ready: true, usage: { ordinaryInput: "700", cachedInput: "300", output: "90" }, quote: { points: "0.76" } });
    });

    it("keeps absent cache-write usage unknown and refuses unpriced modalities or external tools", () => {
        const incomplete = inspectProviderTokenUsage("openai-responses", { model: "gpt-test-2026", service_tier: "default", usage: { input_tokens: 1000, output_tokens: 90, input_tokens_details: { cached_tokens: 300 } } });
        expect(previewObservedFlatTextQuote({ version, policy, contract, observation: incomplete, call })).toMatchObject({ ready: false, reasons: expect.arrayContaining(["缺少 inputTokens 的真实用量", "缺少 cacheWriteTokens 的真实用量"]) });
        expect(previewObservedFlatTextQuote({ version, policy, contract, observation, call: { ...call, billingMode: "batch", inputModalities: ["text", "image"], usesExternalTools: true } })).toMatchObject({
            ready: false,
            reasons: expect.arrayContaining(["调用不是标准实时计费模式", "调用包含未计价的模态或工具"]),
        });
        expect(previewObservedFlatTextQuote({ version, policy, contract, observation, call: { ...call, responseComplete: false } })).toMatchObject({ ready: false, reasons: ["上游响应尚未完整结束"] });
    });

    it("rejects model, tier, region, version and effective-time mismatches", () => {
        const result = previewObservedFlatTextQuote({
            version,
            policy: { ...policy, priceVersionIds: {} },
            contract,
            observation,
            call: { ...call, channelId: "fallback-channel", requestedModel: "other", region: "us", serviceTier: "priority", occurredAt: "2026-09-30T00:00:00Z" },
        });
        expect(result).toMatchObject({
            ready: false,
            reasons: expect.arrayContaining(["官方价版本与已发布售价不一致", "承接渠道未经逐渠道核对", "上游请求型号未确认", "国际区域无法确认", "请求服务档位不是已审核 Standard", "调用不在价目有效期内", "调用早于价目、售价或计费契约审核"]),
        });
    });

    it("refuses missing, duplicate and non-token price item mappings", () => {
        expect(
            previewObservedFlatTextQuote({ version, policy, observation, call, contract: { ...contract, itemMeters: { ordinaryInput: ["inputTokens", "cachedInputTokens"], cachedInput: ["cachedInputTokens"], output: ["outputTokens"] } } }),
        ).toMatchObject({ ready: false, reasons: expect.arrayContaining(["计量字段 cachedInputTokens 不适用或重复", "未覆盖 cacheWriteTokens 计量字段"]) });
        expect(previewObservedFlatTextQuote({ version: { ...version, items: [...version.items, { key: "image", unit: "image", per: "1", price: "0.1", currency: "USD" }] }, policy, observation, call, contract })).toMatchObject({
            ready: false,
            reasons: expect.arrayContaining(["分项 image 没有可验证的 token 计量绑定"]),
        });
    });

    it("supports Anthropic TTL buckets and Gemini thinking only with their complete protocol meters", () => {
        const anthropic = previewObservedFlatTextQuote({
            version: {
                ...version,
                items: [
                    { key: "input", unit: "token", per: "1000000", price: "3", currency: "USD" },
                    { key: "read", unit: "token", per: "1000000", price: "0.3", currency: "USD" },
                    { key: "write5m", unit: "token", per: "1000000", price: "3.75", currency: "USD" },
                    { key: "write1h", unit: "token", per: "1000000", price: "6", currency: "USD" },
                    { key: "output", unit: "token", per: "1000000", price: "15", currency: "USD" },
                ],
            },
            policy,
            contract: { ...contract, protocol: "anthropic-messages", itemMeters: { input: ["inputTokens"], read: ["cachedInputTokens"], write5m: ["cacheWrite5mTokens"], write1h: ["cacheWrite1hTokens"], output: ["outputTokens"] } },
            observation: inspectProviderTokenUsage("anthropic-messages", {
                model: "gpt-test-2026",
                usage: { service_tier: "default", input_tokens: 42, output_tokens: 12, cache_read_input_tokens: 300, cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 60, ephemeral_1h_input_tokens: 40 } },
            }),
            call,
        });
        expect(anthropic).toMatchObject({ ready: true, usage: { input: "42", read: "300", write5m: "60", write1h: "40", output: "12" } });
        const gemini = previewObservedFlatTextQuote({
            version: { ...version, items: [version.items[0], version.items[1], version.items[2]] },
            policy,
            contract: { ...contract, protocol: "gemini-generate", itemMeters: { ordinaryInput: ["inputTokens"], cachedInput: ["cachedInputTokens"], output: ["outputTokens"] } },
            observation: inspectProviderTokenUsage("gemini-generate", { modelVersion: "gpt-test-2026", usageMetadata: { serviceTier: "default", promptTokenCount: 500, cachedContentTokenCount: 200, candidatesTokenCount: 30, thoughtsTokenCount: 70 } }),
            call,
        });
        expect(gemini).toMatchObject({ ready: true, usage: { ordinaryInput: "300", cachedInput: "200", output: "100" } });
    });
});
