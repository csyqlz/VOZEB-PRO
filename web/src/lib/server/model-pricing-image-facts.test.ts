import { describe, expect, it } from "vitest";

import type { OfficialPriceVersion, SalesVersion } from "@/lib/model-pricing";
import type { ImagePriceContract } from "./model-pricing-image-contract";
import { imageUsageFacts, quoteImageFacts } from "./model-pricing-image-facts";
import { inspectOpenAiImageCount, inspectOpenAiImageUsage } from "./model-pricing-image-usage";

const publishedAt = "2026-10-01T00:00:00Z";
const version: OfficialPriceVersion = {
    id: "official",
    candidateId: "candidate",
    logicalModelId: "",
    manufacturer: "Fixture",
    series: "Image",
    officialVersion: "v1",
    sku: "flux-kontext-pro",
    tier: "paid",
    conditions: "fixture",
    sourceKind: "manual",
    sourceUrl: "https://example.com/pricing",
    evidence: "fixture",
    observedAt: publishedAt,
    publishedAt,
    reviewedBy: "admin",
    items: [{ key: "images", unit: "image", per: "1", price: "0.04", currency: "USD" }],
};
const policy: SalesVersion = {
    id: "sales",
    publishedAt,
    publishedBy: "admin",
    priceVersionIds: {},
    userPriceRules: [{ scope: "model", modelId: "logical-image", coefficient: "0.25" }],
    conversion: { cnyPerUsd: "7", pointsPerCny: "100", observedAt: publishedAt, evidence: "fixture" },
    usdPerCurrency: { USD: "1" },
    pointsPerCurrency: { USD: "700", CNY: "100" },
    rateEvidence: { USD: "fixture" },
};
const contract: ImagePriceContract & { id: string } = {
    id: "contract",
    officialVersionId: version.id,
    channelId: "flux",
    requestedModel: version.sku,
    reportedModel: version.sku,
    modelIdentity: "reviewed-request",
    protocol: "openai-images",
    operation: "generations",
    scope: "global-standard-dataeyes-flux-image",
    region: "global",
    itemMeters: {},
    zeroMeters: [],
    imageLimit: { maxImages: 1, sourceUrl: "https://example.com/limit", evidence: "fixture" },
    evidence: "fixture",
    reviewedBy: "admin",
    reviewedAt: publishedAt,
};

describe("image settlement facts", () => {
    it("derives the count from the complete result array and quotes the selected logical model", () => {
        const observation = inspectOpenAiImageCount({ data: [{ url: "https://example.com/image.png" }] });
        const facts = imageUsageFacts({ attemptId: "attempt", evidenceId: "response", observation, meters: ["images"] });
        expect(facts[0]).toMatchObject({ value: "1", sourcePaths: ["data.length"], sourceKind: "approved-derivation", status: "derived", evidenceId: "response" });
        const { usage, quote } = quoteImageFacts({ version, policy, modelId: "logical-image", contract, facts });
        expect(usage).toEqual({ images: "1" });
        expect(quote).toMatchObject({ exactPoints: "7", purpose: "settlement", attemptId: "attempt", evidenceId: "response", lines: [{ consumedFactIds: [facts[0].factId], exactOfficialAmount: "1/25" }] });
    });

    it("rejects missing sources, duplicate meters, and facts from another attempt", () => {
        const observation = inspectOpenAiImageCount({ data: [{ url: "https://example.com/image.png" }] });
        const facts = imageUsageFacts({ attemptId: "attempt", evidenceId: "response", observation, meters: ["images"] });
        const quote = (items: typeof facts) => quoteImageFacts({ version, policy, modelId: "logical-image", contract, facts: items });
        expect(() => quote([{ ...facts[0], sourcePaths: [] }])).toThrow("可结算");
        expect(() => quote([facts[0], facts[0]])).toThrow("重复");
        expect(() => quote([{ ...facts[0], scope: { kind: "attempt", scopeId: "other" } }])).toThrow("跨尝试");
    });

    it("keeps unchanged response meters tied to the original evidence during review", () => {
        const original = inspectOpenAiImageUsage({ usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5, unexpected: 1, input_tokens_details: { text_tokens: 2, image_tokens: 0 }, output_tokens_details: { text_tokens: 0 } } });
        expect(original.invalid.length).toBeGreaterThan(0);
        const reviewed = { ...original, quantities: { ...original.quantities, outputImageTokens: "3" }, invalid: [] };
        const facts = imageUsageFacts({ attemptId: "attempt", evidenceId: "review", manualReviewId: "review", originalEvidenceId: "response", originalObservation: original, observation: reviewed, meters: ["inputTextTokens", "outputImageTokens"] });
        expect(facts[0]).toMatchObject({ status: "reported", sourceKind: "upstream-response", sourcePaths: ["usage.input_tokens_details.text_tokens"], evidenceId: "review", sourceEvidenceId: "response" });
        expect(facts[1]).toMatchObject({ status: "reviewed", sourceKind: "manual-review", sourcePaths: ["review:review"], evidenceId: "review", value: "3" });
    });
});
