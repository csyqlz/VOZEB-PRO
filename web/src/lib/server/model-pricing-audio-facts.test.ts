import { describe, expect, it } from "vitest";

import type { OfficialPriceVersion, SalesVersion } from "@/lib/model-pricing";
import type { AudioPriceContract } from "./model-pricing-audio-contract";
import { audioUsageFacts, quoteAudioFacts } from "./model-pricing-audio-facts";
import { inspectAudioUsage } from "./model-pricing-audio-usage";

const publishedAt = "2026-10-01T00:00:00Z";
const version: OfficialPriceVersion = {
    id: "official",
    candidateId: "candidate",
    logicalModelId: "logical-tts",
    manufacturer: "Fixture",
    series: "TTS",
    officialVersion: "v1",
    sku: "gemini-2.5-flash-preview-tts",
    tier: "paid",
    conditions: "fixture",
    sourceKind: "manual",
    sourceUrl: "https://example.com/pricing",
    evidence: "fixture",
    observedAt: publishedAt,
    publishedAt,
    reviewedBy: "admin",
    items: [
        { key: "input", unit: "token", per: "1000000", price: "1", currency: "USD" },
        { key: "output", unit: "token", per: "1000000", price: "20", currency: "USD" },
    ],
};
const policy: SalesVersion = {
    id: "sales",
    publishedAt,
    publishedBy: "admin",
    priceVersionIds: { "logical-tts": "official" },
    userPriceRules: [],
    conversion: { cnyPerUsd: "7", pointsPerCny: "100", observedAt: publishedAt, evidence: "fixture" },
    usdPerCurrency: { USD: "1" },
    pointsPerCurrency: { USD: "700", CNY: "100" },
    rateEvidence: { USD: "fixture" },
};
const contract: AudioPriceContract & { id: string } = {
    id: "contract",
    officialVersionId: "official",
    channelId: "gemini",
    requestedModel: "gemini-2.5-flash-preview-tts",
    reportedModel: "gemini-2.5-flash-preview-tts",
    modelIdentity: "response-required",
    declaredProtocol: "gemini",
    protocol: "gemini-tts",
    scope: "global-standard-gemini-tts",
    inputTextItem: "input",
    outputAudioItem: "output",
    evidence: "fixture",
    reviewedBy: "admin",
    reviewedAt: publishedAt,
};
const response = () => ({
    modelVersion: contract.reportedModel,
    candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/wav", data: "fixture" } }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30, promptTokensDetails: [{ modality: "TEXT", tokenCount: 10 }], candidatesTokensDetails: [{ modality: "AUDIO", tokenCount: 20 }] },
});
const meters = ["inputTextTokens", "outputAudioTokens", "inputTotalTokens", "outputTotalTokens", "totalTokens"];

describe("audio settlement facts", () => {
    it("quotes reported Gemini modality fields from one response and rejects invalid provenance", () => {
        const facts = audioUsageFacts({ attemptId: "attempt", evidenceId: "response", observation: inspectAudioUsage("gemini-tts", response()), meters });
        expect(facts[0]).toMatchObject({ value: "10", sourcePaths: ["usageMetadata.promptTokensDetails[0].tokenCount"], status: "reported" });
        const quote = (items: typeof facts) => quoteAudioFacts({ version, policy, modelId: "logical-tts", contract, facts: items });
        expect(quote(facts)).toMatchObject({
            usage: { input: "10", output: "20" },
            quote: { exactPoints: "287/1000", attemptId: "attempt", lines: [expect.objectContaining({ consumedFactIds: [facts[0].factId] }), expect.objectContaining({ consumedFactIds: [facts[1].factId] })] },
        });
        expect(() => quote([{ ...facts[0], sourcePaths: [] }, ...facts.slice(1)])).toThrow("可结算");
        expect(() => quote([...facts, facts[0]])).toThrow("重复");
        expect(() => quote([{ ...facts[0], scope: { kind: "attempt", scopeId: "other" } }, ...facts.slice(1)])).toThrow("跨尝试");
        expect(() => quote(facts.map((fact) => (fact.meter === "totalTokens" ? { ...fact, value: "31" } : fact)))).toThrow("总量");
    });

    it("preserves an unchanged reported field when another field needs manual review", () => {
        const original = inspectAudioUsage("gemini-tts", { ...response(), usageMetadata: { ...response().usageMetadata, candidatesTokensDetails: [] } });
        const corrected = { ...original, quantities: { ...original.quantities, outputAudioTokens: "20" }, invalid: [] };
        const facts = audioUsageFacts({ attemptId: "attempt", evidenceId: "review", manualReviewId: "review", originalEvidenceId: "response", originalObservation: original, observation: corrected, meters });
        expect(facts.find((fact) => fact.meter === "inputTextTokens")).toMatchObject({ status: "reported", sourceEvidenceId: "response", sourcePaths: ["usageMetadata.promptTokensDetails[0].tokenCount"] });
        expect(facts.find((fact) => fact.meter === "outputAudioTokens")).toMatchObject({ status: "reviewed", evidenceId: "review", sourcePaths: ["review:review"], value: "20" });
        expect(quoteAudioFacts({ version, policy, modelId: "logical-tts", contract, facts }).quote.exactPoints).toBe("287/1000");
    });
});
