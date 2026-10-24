import { describe, expect, it } from "vitest";
import type { OfficialPriceVersion, SalesVersion } from "@/lib/model-pricing";
import { inspectProviderTokenUsage } from "./model-pricing-token-usage";
import { textUsageFacts } from "./model-pricing-usage-facts";
import { quoteTextFacts } from "./model-pricing-text-fact-quote";
import type { FlatTextPriceContract } from "./model-pricing-token-contract";

const version: OfficialPriceVersion = {
    id: "official-1",
    candidateId: "candidate-1",
    logicalModelId: "text-1",
    manufacturer: "OpenAI",
    series: "GPT",
    officialVersion: "test",
    sku: "test",
    tier: "paid",
    conditions: "Standard text",
    sourceKind: "manual",
    sourceUrl: "https://example.com/price",
    evidence: "fixture",
    observedAt: "2026-10-01T00:00:00Z",
    publishedAt: "2026-10-01T00:00:00Z",
    reviewedBy: "admin",
    items: [
        { key: "ordinaryInput", unit: "token", per: "1000000", price: "1", currency: "USD" },
        { key: "cachedInput", unit: "token", per: "1000000", price: "0.1", currency: "USD" },
        { key: "output", unit: "token", per: "1000000", price: "4", currency: "USD" },
    ],
};
const policy: SalesVersion = {
    id: "sales-1",
    publishedAt: "2026-10-01T00:00:00Z",
    publishedBy: "admin",
    priceVersionIds: { "text-1": version.id },
    userPriceRules: [],
    conversion: { cnyPerUsd: "7", pointsPerCny: "100", observedAt: "2026-10-01T00:00:00Z", evidence: "fixture" },
    usdPerCurrency: { USD: "1", CNY: "1/7" },
    pointsPerCurrency: { USD: "700", CNY: "100" },
    rateEvidence: { USD: "fixture" },
};
const contract: FlatTextPriceContract = {
    officialVersionId: version.id,
    channelId: "channel-1",
    protocol: "openai-responses",
    requestedModel: "test",
    reportedModel: "test",
    scope: "global-standard-text-flat",
    region: "global",
    serviceTier: "default",
    itemMeters: { ordinaryInput: ["inputTokens", "cacheWriteTokens"], cachedInput: ["cachedInputTokens"], output: ["outputTokens"] },
    evidence: "fixture",
    reviewedAt: "2026-10-01T00:00:00Z",
    reviewedBy: "admin",
};
const observed = (total: number) => inspectProviderTokenUsage("openai-responses", { usage: { input_tokens: total, output_tokens: 90, input_tokens_details: { cached_tokens: 300, cache_write_tokens: 200 } } });
const facts = (total: number) => textUsageFacts({ attemptId: "attempt-1", evidenceId: "response-1", observation: observed(total), meters: ["inputTotalTokens", "inputTokens", "cacheWriteTokens", "cachedInputTokens", "outputTokens"] });
const quote = (input: { version?: OfficialPriceVersion; contract?: FlatTextPriceContract; facts?: ReturnType<typeof facts> }) =>
    quoteTextFacts({ version: input.version || version, policy, modelId: "text-1", contract: input.contract || contract, contractId: "contract-1", occurredAt: "2026-10-02T00:00:00Z", facts: input.facts || facts(1000) });

describe("fact-backed text quote", () => {
    it("uses only mapped facts and names every fact consumed by each settlement line", () => {
        const priced = quote({});
        expect(priced.usage).toEqual({ ordinaryInput: "700", cachedInput: "300", output: "90" });
        expect(priced.quote).toMatchObject({
            purpose: "settlement",
            schemaVersion: 1,
            algorithmRevision: "text-fact-quote-v1",
            contractId: "contract-1",
            salesVersionId: "sales-1",
            attemptId: "attempt-1",
            evidenceId: "response-1",
            officialAmountUsd: "0.00109",
            exactPoints: "763/1000",
        });
        expect(priced.quote.lines[0]).toMatchObject({ selected: true, consumedFactIds: ["attempt-1:response-1:inputTokens", "attempt-1:response-1:cacheWriteTokens"], exactOfficialAmount: "7/10000" });
        expect(priced.quote.lines[1].consumedFactIds).toEqual(["attempt-1:response-1:cachedInputTokens"]);
    });

    it("selects one whole-request context tier from the total-input fact", () => {
        const tieredVersion: OfficialPriceVersion = {
            ...version,
            items: [
                { key: "shortInput", unit: "token", per: "1000000", price: "1", currency: "USD" },
                { key: "longInput", unit: "token", per: "1000000", price: "2", currency: "USD" },
            ],
        };
        const tieredContract: FlatTextPriceContract = {
            ...contract,
            scope: "global-standard-text-tiered",
            itemMeters: { shortInput: ["inputTokens"], longInput: ["inputTokens"] },
            contextTiers: { thresholdInputTokens: 128000, shortItemKeys: ["shortInput"], longItemKeys: ["longInput"], sourceUrl: "https://example.com/price", evidence: "fixture" },
        };
        const short = quote({ version: tieredVersion, contract: tieredContract, facts: facts(128000) });
        const long = quote({ version: tieredVersion, contract: tieredContract, facts: facts(128001) });
        expect(short.usage).toEqual({ shortInput: "127500", longInput: "0" });
        expect(long.usage).toEqual({ shortInput: "0", longInput: "127501" });
        expect(short.quote.lines[0]).toMatchObject({ selected: true, conditionFactIds: ["attempt-1:response-1:inputTotalTokens"] });
        expect(short.quote.lines[1]).toMatchObject({ selected: false, consumedFactIds: [] });
    });

    it("rejects missing provenance, crossed evidence and duplicated charge meters", () => {
        const input = facts(1000);
        expect(() => quote({ facts: input.map((fact) => (fact.meter === "cacheWriteTokens" ? { ...fact, status: "missing" as const, value: undefined } : fact)) })).toThrow("cacheWriteTokens");
        expect(() => quote({ facts: input.map((fact) => (fact.meter === "outputTokens" ? { ...fact, evidenceId: "other" } : fact)) })).toThrow("跨尝试");
        expect(() => quote({ facts: input.map((fact) => (fact.meter === "outputTokens" ? { ...fact, factId: input[0].factId } : fact)) })).toThrow("跨尝试");
        expect(() => quote({ facts: input.map((fact) => (fact.meter === "outputTokens" ? { ...fact, sourceKind: "manual-review" as const } : fact)) })).toThrow("outputTokens");
        expect(() => quote({ facts: input.map((fact) => (fact.meter === "outputTokens" ? { ...fact, schemaVersion: 0 as 1 } : fact)) })).toThrow("跨尝试");
        expect(() => quote({ contract: { ...contract, itemMeters: { ...contract.itemMeters, output: ["inputTokens"] } } })).toThrow("重复收费");
    });
});
