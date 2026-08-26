import { describe, expect, it } from "vitest";

import { chargeFromUsage, estimateTextCharge, extractTokenUsage } from "./text-token-billing";

const logicalModels = [
    {
        id: "writer",
        bindings: [
            {
                upstreamModel: "vendor-text",
                capabilityProfile: {
                    pricing: {
                        currency: "CNY" as const,
                        billingUnit: "per_1m_tokens" as const,
                        inputCostPrice: 1,
                        outputCostPrice: 4,
                        inputSalePrice: 2,
                        outputSalePrice: 8,
                    },
                },
            },
        ],
    },
];

describe("text token billing", () => {
    it("prices input and output tokens in CNY per million tokens", () => {
        expect(chargeFromUsage({ input: 2, output: 8, cacheRead: 0, cacheWrite: 0 }, { inputTokens: 500_000, outputTokens: 250_000, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(3);
    });

    it("reads OpenAI usage and Gemini usage metadata", () => {
        expect(extractTokenUsage({ usage: { prompt_tokens: 12, completion_tokens: 7 } })).toEqual({ inputTokens: 12, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 });
        expect(extractTokenUsage({ usage: { prompt_tokens: 12, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 8 } } })).toEqual({ inputTokens: 12, outputTokens: 7, cacheReadTokens: 8, cacheWriteTokens: 0 });
        expect(extractTokenUsage('data: {"usage":{"prompt_tokens":12,"completion_tokens":7}}\n\ndata: [DONE]\n')).toEqual({ inputTokens: 12, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 });
        expect(extractTokenUsage({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, cachedContentTokenCount: 2 } })).toEqual({ inputTokens: 10, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 0 });
    });

    it("charges cached input at its cache rate instead of charging it twice", () => {
        expect(chargeFromUsage({ input: 2, output: 8, cacheRead: 0.5, cacheWrite: 3 }, { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 200_000, cacheWriteTokens: 0 })).toBe(1.7);
    });

    it("creates a non-zero reservation from the request before output usage is known", () => {
        expect(estimateTextCharge({ logicalModels, model: "writer", body: { messages: [{ role: "user", content: "hello" }], max_tokens: 1000 } })).toBeGreaterThan(0);
    });
});
