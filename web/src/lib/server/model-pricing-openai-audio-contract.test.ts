import { describe, expect, it } from "vitest";
import type { OfficialPriceVersion, SalesVersion } from "@/lib/model-pricing";
import { buildOpenAiChatAudioRequest, isOpenAiChatAudioModel } from "@/lib/openai-chat-audio";
import { createProtocolFixtureServer } from "../../../scripts/protocol-fixture-server.mjs";
import type { AudioPriceCallContext } from "./model-pricing-audio-contract";
import { inspectAudioUsage } from "./model-pricing-audio-usage";
import { OPENAI_AUDIO_PRICE_METERS, prepareOpenAiAudioPriceBound, previewOpenAiAudioQuote, validateOpenAiAudioPriceContract, type OpenAiAudioPriceContract } from "./model-pricing-openai-audio-contract";
import { inspectOpenAiAudioRequestBound, OPENAI_PRICED_AUDIO_MODEL, validateOpenAiAudioRequestBound } from "./model-pricing-openai-audio-request";

const model = OPENAI_PRICED_AUDIO_MODEL;
const version: OfficialPriceVersion = {
    id: "official-fixture",
    candidateId: "fixture",
    logicalModelId: "audio-fixture",
    manufacturer: "Fixture",
    series: "Audio",
    officialVersion: model,
    sku: model,
    tier: "paid",
    conditions: "Synthetic four-modality prices",
    sourceKind: "manual",
    sourceUrl: "https://example.com/pricing",
    evidence: "Synthetic fixture; not official approval",
    observedAt: "2026-10-01T00:00:00Z",
    publishedAt: "2026-10-01T00:00:00Z",
    reviewedBy: "price-admin",
    effectiveTo: "2026-11-01T00:00:00Z",
    items: OPENAI_AUDIO_PRICE_METERS.map((key, index) => ({ key, unit: "token", per: "1000000", price: String(index + 1), currency: "USD" })),
};
const policy: SalesVersion = {
    id: "sales-fixture",
    publishedAt: version.publishedAt,
    publishedBy: "billing-admin",
    priceVersionIds: { [version.logicalModelId]: version.id },
    userPriceRules: [],
    conversion: { cnyPerUsd: "7", pointsPerCny: "100", observedAt: version.publishedAt, evidence: "fixture" },
    usdPerCurrency: { USD: "1" },
    pointsPerCurrency: { USD: "700", CNY: "100" },
    rateEvidence: { USD: "fixture" },
};
const contract: OpenAiAudioPriceContract = {
    officialVersionId: version.id,
    channelId: "channel",
    requestedModel: model,
    reportedModel: model,
    protocol: "openai-chat-audio",
    declaredProtocol: "openai",
    scope: "global-standard-openai-chat-audio-uncached",
    itemKeys: { inputTextTokens: "inputTextTokens", inputAudioTokens: "inputAudioTokens", outputTextTokens: "outputTextTokens", outputAudioTokens: "outputAudioTokens" },
    evidence: "Fixture channel and modality mapping",
    reviewedBy: "billing-admin",
    reviewedAt: version.publishedAt,
};
const call: AudioPriceCallContext = {
    officialVersionId: version.id,
    salesVersionId: policy.id,
    logicalModelId: version.logicalModelId,
    channelId: contract.channelId,
    requestedModel: model,
    declaredProtocol: "openai",
    operation: "chat/completions",
    region: "global",
    billingMode: "standard",
    occurredAt: "2026-10-10T00:00:00Z",
};
const payload = buildOpenAiChatAudioRequest({ model, prompt: "私有测试台词", voice: "alloy", format: "wav", instructions: "私有声音方向" });
const bound = inspectOpenAiAudioRequestBound(payload, model, "openai");
const response = () => ({
    model,
    service_tier: "default",
    choices: [{ message: { audio: { data: "private-audio", transcript: "private transcript" } } }],
    usage: { prompt_tokens: 8, completion_tokens: 12, total_tokens: 20, prompt_tokens_details: { text_tokens: 8, audio_tokens: 0, cached_tokens: 0, cache_write_tokens: 0 }, completion_tokens_details: { text_tokens: 2, audio_tokens: 10 } },
});
const observation = inspectAudioUsage("openai-chat-audio", response());
const quote = (patch: Partial<Parameters<typeof previewOpenAiAudioQuote>[0]> = {}) => previewOpenAiAudioQuote({ version, policy, contract, call, bound, observation, responseComplete: true, ...patch });
const prepare = (patch: Partial<Parameters<typeof prepareOpenAiAudioPriceBound>[0]> = {}) => prepareOpenAiAudioPriceBound({ version, policy, contract, call, payload, ...patch });

describe("exact OpenAI Chat Audio ordinary-price contract", () => {
    it("quotes four actual modality counters once and preserves small exact amounts", () => {
        expect(quote()).toMatchObject({ ready: true, usage: { inputTextTokens: "8", inputAudioTokens: "0", outputTextTokens: "2", outputAudioTokens: "10" }, quote: { exactPoints: "189/5000", points: "0.04" } });
        expect(
            quote({
                policy: {
                    ...policy,
                    userPriceRules: [
                        { scope: "default", coefficient: "3" },
                        { scope: "model", modelId: version.logicalModelId, coefficient: "1.5" },
                    ],
                },
            }),
        ).toMatchObject({ ready: true, quote: { exactPoints: "567/10000" } });
        expect(observation.quantities).not.toHaveProperty("inputImageTokens");
        expect(JSON.stringify(quote())).not.toMatch(/private-audio|private transcript|私有/);
    });
    it("uses public limits without modifying generation options or storing prompt text", () => {
        const before = structuredClone(payload);
        expect(prepare()).toMatchObject({ ready: true, maximumExactPoints: "106176/625", maximumUsage: { inputTextTokens: "128000", inputAudioTokens: "0", outputTextTokens: "16384", outputAudioTokens: "16384" } });
        expect(payload).toEqual(before);
        expect(prepare({ payload: { ...payload, n: 3, max_completion_tokens: 100 } })).toMatchObject({ ready: true, maximumExactPoints: "9107/100", bound: { candidateCount: 3, maxOutputTokens: 100 } });
        expect(JSON.stringify(bound)).not.toMatch(/私有|messages|voice/);
    });
    it("uses real review identity and copies mappings without trusting supplied metadata", () => {
        const reviewed = validateOpenAiAudioPriceContract({ ...contract, reviewedBy: "forged", reviewedAt: "forged" }, version, "real-admin", contract.reviewedAt);
        expect(reviewed.reviewedBy).toBe("real-admin");
        expect(reviewed.itemKeys).not.toBe(contract.itemKeys);
    });
    it.each(OPENAI_AUDIO_PRICE_METERS)("requires a normal nonzero price for %s even when its quantity is zero", (key) => {
        expect(quote({ version: { ...version, items: version.items.map((item) => (item.key === key ? { ...item, price: "0" } : item)) } })).toMatchObject({ ready: false, reasons: [expect.stringContaining("固定积分")] });
        expect(quote({ version: { ...version, items: version.items.filter((item) => item.key !== key) } }).ready).toBe(false);
    });
    it.each([...OPENAI_AUDIO_PRICE_METERS, "inputTotalTokens", "outputTotalTokens", "totalTokens", "inputCachedTokens", "inputCacheWriteTokens"])("never infers missing %s from totals or request text", (meter) => {
        const quantities = { ...observation.quantities };
        delete quantities[meter];
        expect(quote({ observation: { ...observation, quantities } })).toMatchObject({ ready: false, reasons: expect.arrayContaining([`缺少 ${meter} 的真实用量`]) });
    });
    it.each(["inputCachedTokens", "inputCacheWriteTokens", "inputImageTokens", "outputReasoningTokens", "outputAcceptedPredictionTokens", "outputRejectedPredictionTokens", "unknownMeter"])("does not price unresolved %s at a borrowed rate", (meter) => {
        expect(quote({ observation: { ...observation, quantities: { ...observation.quantities, [meter]: "1" } } }).ready).toBe(false);
    });
    it("requires an exact response model, actual default tier, completed response and audio", () => {
        for (const patch of [{ reportedModel: undefined }, { reportedModel: "gpt-4o-audio-preview" }, { serviceTier: undefined }, { serviceTier: "auto" }, { serviceTier: "priority" }, { hasAudio: false }, { protocol: "gemini-tts" as const }])
            expect(quote({ observation: { ...observation, ...patch } }).ready).toBe(false);
        expect(quote({ responseComplete: false }).ready).toBe(false);
    });
    it("rejects incompatible price identity, duplicate mapping, units, scope and review time", () => {
        for (const patch of [
            { sku: "gpt-4o-audio-preview" },
            { reviewedBy: "" },
            { tier: "free" as const },
            { publishedAt: "invalid" },
            { effectiveTo: call.occurredAt },
            { effectiveFrom: "2026-11-01T00:00:00Z" },
            { items: version.items.map((item) => ({ ...item, unit: "second" })) },
        ])
            expect(quote({ version: { ...version, ...patch } }).ready).toBe(false);
        for (const patch of [{ requestedModel: "gpt-audio" }, { reportedModel: "alias" }, { scope: "batch" }, { declaredProtocol: "custom" }, { evidence: "" }, { itemKeys: { ...contract.itemKeys, outputAudioTokens: "outputTextTokens" } }])
            expect(() => validateOpenAiAudioPriceContract({ ...contract, ...patch }, version, "admin", contract.reviewedAt)).toThrow();
        expect(quote({ contract: { ...contract, reviewedAt: "2027-01-01T00:00:00Z" } }).ready).toBe(false);
    });
    it("rejects mismatched frozen channel, version, policy, model and operation", () => {
        for (const patch of [
            { channelId: "other" },
            { salesVersionId: "other" },
            { officialVersionId: "other" },
            { logicalModelId: "other" },
            { requestedModel: "gpt-4o-audio-preview" },
            { declaredProtocol: "custom" },
            { operation: "audio/speech" },
            { region: "regional" },
            { billingMode: "batch" },
            { occurredAt: "invalid" },
        ])
            expect(quote({ call: { ...call, ...patch } }).ready).toBe(false);
        expect(quote({ policy: { ...policy, priceVersionIds: {} } }).ready).toBe(false);
    });
    it("keeps quantities integral, fully covered and within the shared output bound", () => {
        for (const value of ["-1", "1.2", "NaN", ""]) expect(quote({ observation: { ...observation, quantities: { ...observation.quantities, inputTextTokens: value } } }).ready).toBe(false);
        for (const patch of [{ totalTokens: "21" }, { outputTotalTokens: "13" }, { inputTotalTokens: "9" }, { inputAudioTokens: "1", inputTotalTokens: "9", totalTokens: "21" }] as Array<Record<string, string>>)
            expect(quote({ observation: { ...observation, quantities: { ...observation.quantities, ...patch } } }).ready).toBe(false);
        expect(quote({ bound: inspectOpenAiAudioRequestBound({ ...payload, max_tokens: 10 }, model, "openai") })).toMatchObject({ ready: false, reasons: [expect.stringContaining("共享输出总上界")] });
        expect(quote({ observation: { ...observation, quantities: { ...observation.quantities, inputTextTokens: "128001", inputTotalTokens: "128001", totalTokens: "128013" } } }).ready).toBe(false);
        expect(quote({ observation: { ...observation, quantities: { ...observation.quantities, inputTextTokens: "128000", inputTotalTokens: "128000", totalTokens: "128012" } } })).toMatchObject({
            ready: false,
            reasons: [expect.stringContaining("上下文窗口")],
        });
    });
    it.each([null, 0, -1, 1.5, "100", 16385])("rejects invalid maximum %s rather than silently changing it", (value) => {
        expect(prepare({ payload: { ...payload, max_completion_tokens: value } }).ready).toBe(false);
    });
    it("rejects streaming, ambiguous limits, tool/audio history and unsupported extensions", () => {
        for (const patch of [
            { stream: true },
            { service_tier: "auto" },
            { tools: [] },
            { prompt_cache_options: {} },
            { max_tokens: 100, max_completion_tokens: 100 },
            { n: null },
            { n: 129 },
            { modalities: ["audio"] },
            { audio: { voice: "alloy" } },
            { messages: [{ role: "assistant", audio: { id: "prior-audio" } }] },
            { messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: "base64", format: "wav" } }] }] },
        ])
            expect(prepare({ payload: { ...payload, ...patch } }).ready).toBe(false);
        expect(prepare({ payload: { ...payload, messages: [{ role: "user", content: [{ type: "text", text: "text" }] }] } }).ready).toBe(true);
    });
    it("does not reuse the new model bound or prices for legacy aliases", () => {
        for (const requestedModel of ["gpt-4o-audio-preview", "gpt-audio", "gpt-audio-mini", "gpt-audio-1.5-alias"]) expect(() => inspectOpenAiAudioRequestBound({ ...payload, model: requestedModel }, requestedModel, "openai")).toThrow("旧型号");
        expect(isOpenAiChatAudioModel(model)).toBe(true);
        expect(isOpenAiChatAudioModel("gpt-4o-audio-preview")).toBe(true);
        expect(isOpenAiChatAudioModel("gpt-audio-1.5-alias")).toBe(false);
    });
    it("rejects tampered stored bounds", () => {
        for (const patch of [
            { sourceUrl: "https://example.com" },
            { candidateCount: 0 },
            { maxOutputTokens: 16385 },
            { maximumQuantities: { ...bound.maximumQuantities, inputTextTokens: "128001" } },
            { maximumQuantities: { ...bound.maximumQuantities, other: "1" } },
        ])
            expect(() => validateOpenAiAudioRequestBound({ ...bound, ...patch } as typeof bound)).toThrow();
    });
    it("quotes the real local Chat Audio response from the unchanged native request builder", async () => {
        const fixture = createProtocolFixtureServer();
        await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        const address = fixture.server.address();
        if (!address || typeof address === "string") throw new Error("fixture did not bind");
        try {
            const upstream = await fetch(`http://127.0.0.1:${address.port}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
            expect(upstream.ok).toBe(true);
            const body = await upstream.json();
            expect(Buffer.from(body.choices[0].message.audio.data, "base64").subarray(0, 4).toString()).toBe("RIFF");
            expect(quote({ observation: inspectAudioUsage("openai-chat-audio", body) })).toMatchObject({ ready: true, quote: { exactPoints: "189/5000" } });
            expect(fixture.requests).toHaveLength(1);
        } finally {
            fixture.server.closeAllConnections();
            await new Promise<void>((resolve, reject) => fixture.server.close((error) => (error ? reject(error) : resolve())));
        }
    });
});
