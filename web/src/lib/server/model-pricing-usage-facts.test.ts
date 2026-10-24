import { describe, expect, it } from "vitest";
import { inspectProviderTokenUsage } from "./model-pricing-token-usage";
import { textUsageFacts } from "./model-pricing-usage-facts";

const meters = ["inputTotalTokens", "inputTokens", "cachedInputTokens", "cacheWriteTokens", "outputTokens"];
const facts = (observation: ReturnType<typeof inspectProviderTokenUsage>) => textUsageFacts({ attemptId: "attempt-1", evidenceId: "response-1", observation, meters });

describe("text usage facts", () => {
    it("retains upstream paths, aliases and verified derivations without double-counting the input total", () => {
        const observation = inspectProviderTokenUsage("openai-responses", { usage: { input_tokens: 1000, output_tokens: 90, input_tokens_details: { cached_tokens: 300, cache_write_tokens: 200 } } });
        const byMeter = Object.fromEntries(facts(observation).map((fact) => [fact.meter, fact]));
        expect(byMeter.inputTotalTokens).toMatchObject({ value: "1000", status: "reported", sourcePath: "usage.input_tokens" });
        expect(byMeter.cachedInputTokens).toMatchObject({ value: "300", sourcePath: "usage.input_tokens_details.cached_tokens" });
        expect(byMeter.inputTokens).toMatchObject({
            value: "500",
            status: "derived",
            formula: "inputTotalTokens - cachedInputTokens - cacheWriteTokens",
            sourcePaths: ["usage.input_tokens", "usage.input_tokens_details.cached_tokens", "usage.input_tokens_details.cache_write_tokens"],
            relation: { kind: "derived-from", inputMeters: ["inputTotalTokens", "cachedInputTokens", "cacheWriteTokens"] },
        });
        expect(byMeter.inputTokens.factId).toBe("attempt-1:response-1:inputTokens");
        expect(observation.quantities.inputTokens).toBe("500");
    });

    it("keeps reported zero separate from missing and rejects unverified or contradictory values", () => {
        const reported = inspectProviderTokenUsage("openai-chat", { usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } } });
        const byMeter = Object.fromEntries(facts(reported).map((fact) => [fact.meter, fact]));
        expect(byMeter.cachedInputTokens).toMatchObject({ value: "0", status: "reported" });
        expect(byMeter.cacheWriteTokens).toMatchObject({ status: "missing", sourcePaths: [] });
        expect(byMeter.cacheWriteTokens).not.toHaveProperty("value");
        expect(facts({ ...reported, quantities: { ...reported.quantities, cacheWriteTokens: "0" } }).find((fact) => fact.meter === "cacheWriteTokens")).toMatchObject({ status: "invalid" });
        const contradictory = inspectProviderTokenUsage("openai-chat", { usage: { prompt_tokens: 10, input_tokens: 11, completion_tokens: 5 } });
        expect(facts(contradictory).find((fact) => fact.meter === "outputTokens")).toMatchObject({ status: "invalid" });
        expect(facts(contradictory).every((fact) => fact.value === undefined)).toBe(true);
    });

    it("traces Gemini totals and Anthropic zero TTL buckets to their exact inputs", () => {
        const gemini = inspectProviderTokenUsage("gemini-generate", { usageMetadata: { promptTokenCount: 500, cachedContentTokenCount: 200, candidatesTokenCount: 30, thoughtsTokenCount: 70 } });
        expect(facts(gemini).find((fact) => fact.meter === "inputTokens")).toMatchObject({ value: "300", status: "derived", sourcePaths: ["usageMetadata.promptTokenCount", "usageMetadata.cachedContentTokenCount"] });
        const anthropic = inspectProviderTokenUsage("anthropic-messages", { usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
        expect(textUsageFacts({ attemptId: "a", evidenceId: "e", observation: anthropic, meters: ["cacheWrite5mTokens"] })[0]).toMatchObject({ value: "0", status: "derived", sourcePath: "usage.cache_creation_input_tokens" });
        const explicit = inspectProviderTokenUsage("anthropic-messages", {
            usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } },
        });
        expect(textUsageFacts({ attemptId: "a", evidenceId: "e", observation: explicit, meters: ["cacheWrite5mTokens"] })[0]).toMatchObject({ value: "0", status: "reported", sourcePath: "usage.cache_creation.ephemeral_5m_input_tokens" });
    });

    it("keeps verified aliases and explicit response-header zeros as reported evidence", () => {
        const observation = inspectProviderTokenUsage(
            "openai-chat",
            { model: "kimi-k3", usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10 } },
            new Headers({ "Msh-Usage-Cache-Write-Tokens-5m": "0" }),
        );
        const byMeter = Object.fromEntries(textUsageFacts({ attemptId: "a", evidenceId: "e", observation, meters: ["cachedInputTokens", "cacheWrite5mTokens", "cacheWrite1hTokens"] }).map((fact) => [fact.meter, fact]));
        expect(byMeter.cachedInputTokens.sourcePaths).toEqual(["usage.prompt_tokens_details.cached_tokens", "usage.prompt_cache_hit_tokens"]);
        expect(byMeter.cacheWrite5mTokens).toMatchObject({ value: "0", status: "reported", sourcePath: "header:Msh-Usage-Cache-Write-Tokens-5m" });
        expect(byMeter.cacheWrite1hTokens).toMatchObject({ value: "0", status: "derived", sourcePath: "usage.prompt_tokens_details.cache_write_tokens" });
    });

    it("attributes reviewed supplemental quantities to the review without rewriting the original response", () => {
        const original = inspectProviderTokenUsage("openai-responses", { usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 0 } } });
        const supplemented = { ...original, quantities: { ...original.quantities, cacheWriteTokens: "0", inputTokens: "10" }, invalid: undefined };
        const reviewed = textUsageFacts({ attemptId: "attempt-1", evidenceId: "review-1", manualReviewId: "review-1", observation: supplemented, meters: ["cacheWriteTokens", "inputTokens"] });
        expect(reviewed).toMatchObject([
            { meter: "cacheWriteTokens", value: "0", status: "reviewed", sourceKind: "manual-review", sourcePath: "review:review-1" },
            { meter: "inputTokens", value: "10", status: "reviewed", sourceKind: "manual-review", sourcePath: "review:review-1" },
        ]);
        expect(original.quantities.cacheWriteTokens).toBeUndefined();
    });

    it("keeps unchanged upstream facts tied to the original response when a review supplies one missing meter", () => {
        const original = inspectProviderTokenUsage("openai-responses", { usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 3 } } });
        const supplemented = { ...original, quantities: { ...original.quantities, cacheWriteTokens: "0" } };
        const reviewed = textUsageFacts({
            attemptId: "attempt-1",
            evidenceId: "review-1",
            manualReviewId: "review-1",
            originalObservation: original,
            originalEvidenceId: "response-1",
            observation: supplemented,
            meters: ["inputTotalTokens", "cachedInputTokens", "cacheWriteTokens", "outputTokens"],
        });
        expect(reviewed).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ meter: "inputTotalTokens", status: "reported", sourcePath: "usage.input_tokens", sourceEvidenceId: "response-1" }),
                expect.objectContaining({ meter: "cachedInputTokens", status: "reported", sourcePath: "usage.input_tokens_details.cached_tokens", sourceEvidenceId: "response-1" }),
                expect.objectContaining({ meter: "cacheWriteTokens", status: "reviewed", sourceKind: "manual-review", sourcePath: "review:review-1" }),
                expect.objectContaining({ meter: "outputTokens", status: "reported", sourcePath: "usage.output_tokens", sourceEvidenceId: "response-1" }),
            ]),
        );
        expect(reviewed.find((fact) => fact.meter === "cacheWriteTokens")).not.toHaveProperty("sourceEvidenceId");
        expect(original.quantities.cacheWriteTokens).toBeUndefined();
    });
});
