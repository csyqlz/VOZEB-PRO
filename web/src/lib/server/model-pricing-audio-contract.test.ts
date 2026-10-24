import { describe, expect, it } from "vitest";
import type { OfficialPriceVersion, SalesVersion } from "@/lib/model-pricing";
import { createProtocolFixtureServer } from "../../../scripts/protocol-fixture-server.mjs";
import { geminiAudioRequest } from "./gemini-audio-provider";
import { prepareAudioRequestPriceBound, previewObservedAudioQuote, validateAudioPriceContract, type AudioPriceCallContext, type AudioPriceContract } from "./model-pricing-audio-contract";
import { GEMINI_TTS_MODELS, inspectGeminiTtsRequestBound, validateAudioRequestBound } from "./model-pricing-audio-request";
import { inspectAudioUsage } from "./model-pricing-audio-usage";

const version: OfficialPriceVersion = {
    id: "official-fixture",
    candidateId: "approved",
    logicalModelId: "audio-fixture",
    manufacturer: "Fixture",
    series: "TTS",
    officialVersion: GEMINI_TTS_MODELS[0],
    sku: GEMINI_TTS_MODELS[0],
    tier: "paid",
    conditions: "Fixture standard global text-in/audio-out",
    sourceKind: "manual",
    sourceUrl: "https://example.com/pricing",
    evidence: "Synthetic fixture prices, not a production approval",
    observedAt: "2026-10-01T00:00:00Z",
    publishedAt: "2026-10-01T00:00:00Z",
    reviewedBy: "price-admin",
    effectiveFrom: "2026-10-01T00:00:00Z",
    effectiveTo: "2026-11-01T00:00:00Z",
    items: [
        { key: "textInput", unit: "token", per: "1000000", price: "1", currency: "USD" },
        { key: "audioOutput", unit: "token", per: "1000000", price: "20", currency: "USD" },
    ],
};
const policy: SalesVersion = {
    id: "sales-fixture",
    publishedAt: "2026-10-01T12:00:00Z",
    publishedBy: "billing-admin",
    priceVersionIds: { [version.logicalModelId]: version.id },
    userPriceRules: [],
    conversion: { cnyPerUsd: "7", pointsPerCny: "100", observedAt: "2026-10-01T00:00:00Z", evidence: "fixture" },
    usdPerCurrency: { USD: "1", CNY: "1/7" },
    pointsPerCurrency: { USD: "700", CNY: "100" },
    rateEvidence: { USD: "fixture" },
};
const contract: AudioPriceContract = {
    officialVersionId: version.id,
    channelId: "channel",
    requestedModel: GEMINI_TTS_MODELS[0],
    reportedModel: GEMINI_TTS_MODELS[0],
    protocol: "gemini-tts",
    declaredProtocol: "gemini",
    scope: "global-standard-gemini-tts",
    modelIdentity: "response-required",
    inputTextItem: "textInput",
    outputAudioItem: "audioOutput",
    evidence: "Fixture channel identity and standard scope reviewed",
    reviewedBy: "billing-admin",
    reviewedAt: "2026-10-01T12:00:00Z",
};
const call: AudioPriceCallContext = {
    officialVersionId: version.id,
    salesVersionId: policy.id,
    logicalModelId: version.logicalModelId,
    channelId: contract.channelId,
    requestedModel: contract.requestedModel,
    declaredProtocol: contract.declaredProtocol,
    operation: "generateContent",
    region: "global",
    billingMode: "standard",
    occurredAt: "2026-10-02T00:00:00Z",
};
const payload = geminiAudioRequest("私有台词", "Kore");
const bound = inspectGeminiTtsRequestBound(payload, call.requestedModel, call.declaredProtocol);
const response = (input = 10, output = 20) => ({
    modelVersion: contract.reportedModel,
    candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/wav", data: "private-audio" } }] } }],
    usageMetadata: { promptTokenCount: input, candidatesTokenCount: output, totalTokenCount: input + output, promptTokensDetails: [{ modality: "TEXT", tokenCount: input }], candidatesTokensDetails: [{ modality: "AUDIO", tokenCount: output }] },
});
const observation = inspectAudioUsage("gemini-tts", response());
const quote = (patch: Partial<Parameters<typeof previewObservedAudioQuote>[0]> = {}) => previewObservedAudioQuote({ version, policy, contract, call, bound, observation, responseComplete: true, ...patch });
const prepare = (patch: Partial<Parameters<typeof prepareAudioRequestPriceBound>[0]> = {}) => prepareAudioRequestPriceBound({ version, policy, contract, call, payload, ...patch });

describe("reviewed Gemini TTS price contract", () => {
    it.each(GEMINI_TTS_MODELS)("quotes separate real text and audio totals for %s on both supported transports", (model) => {
        for (const declaredProtocol of ["gemini", "dataeyes-gemini"] as const) {
            const reviewed = validateAudioPriceContract({ ...contract, requestedModel: model, reportedModel: model, declaredProtocol, reviewedBy: "forged", reviewedAt: "forged" }, { ...version, sku: model }, "actual-admin", contract.reviewedAt);
            expect(reviewed.reviewedBy).toBe("actual-admin");
            expect(reviewed.reviewedAt).toBe(contract.reviewedAt);
            expect(
                quote({
                    version: { ...version, sku: model },
                    contract: reviewed,
                    call: { ...call, requestedModel: model, declaredProtocol },
                    bound: inspectGeminiTtsRequestBound(payload, model, declaredProtocol),
                    observation: { ...observation, reportedModel: model },
                }),
            ).toMatchObject({ ready: true, usage: { textInput: "10", audioOutput: "20" }, quote: { exactPoints: "287/1000", points: "0.29" } });
        }
    });
    it("uses all actual usage with one coefficient and preserves sub-cent fractions", () => {
        expect(quote({ observation: inspectAudioUsage("gemini-tts", response(1, 0)) })).toMatchObject({ ready: true, quote: { exactPoints: "7/10000" } });
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
        ).toMatchObject({ ready: true, quote: { exactPoints: "861/2000" } });
        expect(quote({ observation: inspectAudioUsage("gemini-tts", response(0, 0)) })).toMatchObject({ ready: true, quote: { exactPoints: "0" } });
    });
    it("does not insert zero for non-applicable counters or infer a missing priced modality", () => {
        expect(observation.missing).toContain("cachedContentTokenCount");
        const before = structuredClone(observation);
        expect(quote().ready).toBe(true);
        expect(observation).toEqual(before);
        expect(observation.quantities).not.toHaveProperty("cachedInputTokens");
        for (const meter of ["inputTextTokens", "outputAudioTokens", "inputTotalTokens", "outputTotalTokens", "totalTokens"]) {
            const quantities = { ...observation.quantities };
            delete quantities[meter];
            expect(quote({ observation: { ...observation, quantities } })).toMatchObject({ ready: false, reasons: expect.arrayContaining([`缺少 ${meter} 的真实用量`]) });
        }
    });
    it.each(["textInput", "audioOutput"])("rejects absent regular paid price for %s even with zero actual usage", (key) => {
        const free = { ...version, items: version.items.map((item) => (item.key === key ? { ...item, price: "0" } : item)) };
        expect(() => validateAudioPriceContract(contract, free, "admin", contract.reviewedAt)).toThrow("固定积分");
        expect(prepare({ version: free }).ready).toBe(false);
        expect(quote({ version: free, observation: inspectAudioUsage("gemini-tts", response(0, 0)) }).ready).toBe(false);
    });
    it("rejects unreviewed, free-tier, incomplete or extra price rows", () => {
        for (const patch of [
            { reviewedBy: "" },
            { publishedAt: "invalid" },
            { tier: "free" as const },
            { sku: "alias" },
            { items: version.items.slice(0, 1) },
            { items: [...version.items, { ...version.items[0], key: "cache" }] },
            { items: version.items.map((item) => ({ ...item, unit: "second" })) },
        ])
            expect(quote({ version: { ...version, ...patch } }).ready).toBe(false);
        for (const patch of [{ inputTextItem: "audioOutput" }, { outputAudioItem: "totalTokens" }, { protocol: "openai-chat-audio" }, { scope: "batch" }, { modelIdentity: "guess" }, { evidence: "" }, { channelId: "" }, { requestedModel: "alias" }])
            expect(() => validateAudioPriceContract({ ...contract, ...patch }, version, "admin", contract.reviewedAt)).toThrow();
        expect(() => validateAudioPriceContract(contract, version, "", contract.reviewedAt)).toThrow();
    });
    it.each(["cachedInputTokens", "cachedInputTextTokens", "thoughtTokens", "toolInputTokens", "toolInputTextTokens", "inputAudioTokens", "inputImageTokens", "outputTextTokens", "futureMeter"])("rejects nonzero out-of-scope %s", (meter) => {
        expect(quote({ observation: { ...observation, quantities: { ...observation.quantities, [meter]: "1" } } }).ready).toBe(false);
    });
    it.each(["flex", "priority", "STANDARD", ""])("rejects unreviewed actual service tier %j", (serviceTier) => {
        expect(quote({ observation: { ...observation, serviceTier } }).ready).toBe(false);
    });
    it("requires valid model and service metadata without silently accepting malformed fields", () => {
        for (const value of [0, [], {}, null, "", " "]) {
            expect(quote({ contract: { ...contract, modelIdentity: "reviewed-request" }, observation: inspectAudioUsage("gemini-tts", { ...response(), modelVersion: value }) }).ready).toBe(false);
            expect(quote({ observation: inspectAudioUsage("gemini-tts", { ...response(), usageMetadata: { ...response().usageMetadata, serviceTier: value } }) }).ready).toBe(false);
        }
        for (const serviceTier of [undefined, "standard", "unspecified"]) expect(quote({ observation: { ...observation, serviceTier } }).ready).toBe(true);
        const absent = { ...observation, reportedModel: undefined };
        expect(quote({ observation: absent }).ready).toBe(false);
        expect(quote({ observation: absent, contract: { ...contract, modelIdentity: "reviewed-request" } }).ready).toBe(true);
        expect(quote({ observation: { ...absent, reportedModel: "alias" }, contract: { ...contract, modelIdentity: "reviewed-request" } }).ready).toBe(false);
    });
    it.each([
        { channelId: "fallback" },
        { requestedModel: "alias" },
        { declaredProtocol: "openai" },
        { logicalModelId: "other" },
        { operation: "streamGenerateContent" },
        { region: "us" },
        { billingMode: "batch" },
        { salesVersionId: "other" },
        { officialVersionId: "other" },
        { occurredAt: "2026-09-30T00:00:00Z" },
        { occurredAt: "2026-11-01T00:00:00Z" },
        { occurredAt: "invalid" },
    ])("rejects an unfrozen call context %j before and after submission", (patch) => {
        expect(prepare({ call: { ...call, ...patch } }).ready).toBe(false);
        expect(quote({ call: { ...call, ...patch } }).ready).toBe(false);
    });
    it("rejects changed policies, unfinished results and inconsistent totals", () => {
        expect(quote({ policy: { ...policy, priceVersionIds: {} } }).ready).toBe(false);
        expect(prepare({ policy: { ...policy, publishedAt: "2026-10-03T00:00:00Z" } }).ready).toBe(false);
        expect(quote({ contract: { ...contract, officialVersionId: "other" } }).ready).toBe(false);
        expect(quote({ responseComplete: false }).ready).toBe(false);
        expect(quote({ observation: { ...observation, hasAudio: false } }).ready).toBe(false);
        expect(quote({ observation: { ...observation, invalid: ["incomplete upstream"] } }).ready).toBe(false);
        for (const quantity of ["-1", "1.5", "NaN", ""]) expect(quote({ observation: { ...observation, quantities: { ...observation.quantities, inputTextTokens: quantity } } }).ready).toBe(false);
        for (const meter of ["inputTotalTokens", "outputTotalTokens", "totalTokens"]) expect(quote({ observation: { ...observation, quantities: { ...observation.quantities, [meter]: "1" } } }).ready).toBe(false);
    });
});

describe("documented Gemini TTS request bound", () => {
    it("uses official model ceilings without changing request settings or retaining private text", () => {
        const before = structuredClone(payload);
        expect(prepare()).toMatchObject({ ready: true, maximumUsage: { textInput: "8192", audioOutput: "16384" }, maximumExactPoints: "146944/625" });
        expect(payload).toEqual(before);
        expect(payload.generationConfig).not.toHaveProperty("maxOutputTokens");
        expect(JSON.stringify(bound)).not.toContain("私有台词");
        expect(() => validateAudioRequestBound(bound)).not.toThrow();
    });
    it("respects an explicit per-candidate cap and counts all requested candidates exactly", () => {
        const custom = { ...payload, generationConfig: { ...payload.generationConfig, maxOutputTokens: 100, candidateCount: 3 } };
        const prepared = prepare({ payload: custom });
        expect(prepared).toMatchObject({ ready: true, maximumUsage: { textInput: "8192", audioOutput: "300" } });
        if (!prepared.ready) throw new Error("Expected valid bound");
        expect(quote({ bound: prepared.bound, observation: inspectAudioUsage("gemini-tts", response(8192, 300)) }).ready).toBe(true);
        expect(quote({ bound: prepared.bound, observation: inspectAudioUsage("gemini-tts", response(8192, 301)) }).ready).toBe(false);
        expect(quote({ observation: inspectAudioUsage("gemini-tts", response(8193, 20)) }).ready).toBe(false);
        expect(quote({ observation: inspectAudioUsage("gemini-tts", response(8192, 16385)) }).ready).toBe(false);
        const large = inspectGeminiTtsRequestBound({ ...payload, generationConfig: { ...payload.generationConfig, candidateCount: Number.MAX_SAFE_INTEGER } }, call.requestedModel, call.declaredProtocol);
        expect(large.maximumQuantities.outputAudioTokens).toBe(String(BigInt(Number.MAX_SAFE_INTEGER) * BigInt(16384)));
    });
    it.each([0, -1, 1.5, "2", null, Number.MAX_SAFE_INTEGER + 1])("rejects invalid request quantity %j without rewriting it", (value) => {
        for (const key of ["candidateCount", "maxOutputTokens"]) expect(prepare({ payload: { ...payload, generationConfig: { ...payload.generationConfig, [key]: value } } }).ready).toBe(false);
    });
    it("rejects unproven request features and altered saved bounds", () => {
        for (const extension of [
            { cachedContent: "cache" },
            { tools: [] },
            { futureFeature: true },
            { serviceTier: "flex" },
            { serviceTier: "priority" },
            { contents: [{ parts: [{ inlineData: { data: "private" } }] }] },
            { systemInstruction: { parts: [] } },
        ])
            expect(prepare({ payload: { ...payload, ...extension } }).ready).toBe(false);
        for (const config of [{ responseModalities: [] }, { responseModalities: ["TEXT", "AUDIO"] }, { maxOutputTokens: 16385 }, { thinkingConfig: {} }, { responseMimeType: "application/json" }])
            expect(prepare({ payload: { ...payload, generationConfig: { ...payload.generationConfig, ...config } } }).ready).toBe(false);
        for (const patch of [{ candidateCount: 2 }, { maxOutputTokens: 0 }, { sourceUrl: "https://example.com/guess" }, { maximumQuantities: { inputTextTokens: "8193", outputAudioTokens: "16384" } }, { requestedModel: GEMINI_TTS_MODELS[1] }])
            expect(quote({ bound: { ...bound, ...patch } }).ready).toBe(false);
        expect(() => inspectGeminiTtsRequestBound(payload, "gemini-tts-alias", "gemini")).toThrow();
        expect(() => inspectGeminiTtsRequestBound(payload, call.requestedModel, "openai")).toThrow();
    });
    it.each(GEMINI_TTS_MODELS)("quotes a real local TCP response to the provider request for %s", async (model) => {
        const fixture = createProtocolFixtureServer();
        await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        try {
            const address = fixture.server.address();
            if (!address || typeof address === "string") throw new Error("Fixture did not bind");
            const prepared = prepare({ version: { ...version, sku: model }, contract: { ...contract, requestedModel: model }, call: { ...call, requestedModel: model } });
            if (!prepared.ready) throw new Error("Expected a pre-submission bound");
            const upstream = await fetch(`http://127.0.0.1:${address.port}/models/${model}:generateContent`, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": "fixture-only" }, body: JSON.stringify(payload) });
            expect(upstream.ok).toBe(true);
            const observed = inspectAudioUsage("gemini-tts", await upstream.json());
            expect(quote({ version: { ...version, sku: model }, contract: { ...contract, requestedModel: model, modelIdentity: "reviewed-request" }, call: { ...call, requestedModel: model }, bound: prepared.bound, observation: observed })).toMatchObject({
                ready: true,
                usage: { textInput: "8", audioOutput: "12" },
                quote: { exactPoints: "217/1250" },
            });
            expect(fixture.requests).toHaveLength(1);
            expect(fixture.requests[0].path).toBe(`/models/${model}:generateContent`);
            expect(JSON.parse(fixture.requests[0].body.toString("utf8"))).toEqual(payload);
            expect(JSON.stringify(observed)).not.toContain("私有台词");
        } finally {
            fixture.server.closeAllConnections();
            await new Promise<void>((resolve, reject) => fixture.server.close((error) => (error ? reject(error) : resolve())));
        }
    });
});
