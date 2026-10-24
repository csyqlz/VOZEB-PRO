import Fraction from "fraction.js";
import { describe, expect, it } from "vitest";
import type { OfficialPriceVersion, SalesVersion } from "@/lib/model-pricing";
import { estimateFlatTextRequestQuote, estimateFlatTextRequestUsage, prepareFlatTextRequestBound, validateObservedRequestBound } from "./model-pricing-request-bound";
import { validateFlatTextPriceContract, type FlatTextPriceContract } from "./model-pricing-token-contract";
import { inspectProviderTokenUsage } from "./model-pricing-token-usage";

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

const limits = { maxInputTokens: 1000, maxOutputTokens: 100, maxCandidates: 3, sourceUrl: "https://example.com/limits", evidence: "Fixture hard limits include cache input and reasoning output", includesReasoning: true as const };
const input = { version, policy, contract: { ...contract, requestLimits: limits }, payload: { model: "gpt-test", input: "hello" }, occurredAt: "2026-10-02T00:00:00Z" };

describe("audited text request bounds", () => {
    it("covers every published Standard group at the audited input ceiling without turning an estimate into usage", () => {
        const line = (lineId: string, meter: string, price: string) => ({ lineId, meter, unit: "token" as const, per: "1000000", price, currency: "USD" as const, evidence: "fixture" });
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
        const priceSelection = { logicalModelId: "text-model", scope: "text:generation:standard", bindingId: "binding", bindingRevision: "revision", officialVersionId: scheduled.id };
        const published = { ...policy, priceVersionIds: {}, selectedPriceBindings: [priceSelection] };
        const reviewed = {
            ...contract,
            scope: "global-standard-text-tiered" as const,
            itemMeters: { inputTokens: ["inputTokens", "cacheWriteTokens"], cachedInputTokens: ["cachedInputTokens"], outputTokens: ["outputTokens"] } as FlatTextPriceContract["itemMeters"],
            requestLimits: { ...limits, maxInputTokens: 128001 },
        };
        const request = { ...input, version: scheduled, policy: published, contract: reviewed, modelId: "text-model", priceSelection };
        const bound = prepareFlatTextRequestBound(request);
        expect(bound).toMatchObject({ ready: true, maximumGroupId: "long", inputTokens: "128001" });
        if (!bound.ready) return;
        expect(estimateFlatTextRequestQuote({ ...request, bound })).toMatchObject({ modelId: "text-model", lines: expect.arrayContaining([expect.objectContaining({ lineId: "short-input" })]) });
        expect(prepareFlatTextRequestBound({ ...request, contract: { ...reviewed, requestLimits: { ...limits, maxInputTokens: 256001 } } })).toMatchObject({ ready: false, reasons: [expect.stringContaining("未覆盖请求上界")] });
        expect(prepareFlatTextRequestBound({ ...request, priceSelection: { ...priceSelection, bindingRevision: "stale" } })).toMatchObject({ ready: false });
    });
    it("reserves the dearer complete context tier when an audited request can cross its threshold", () => {
        const prices = { inputTokens: ["2", "4"], cachedInputTokens: ["0.1", "0.2"], cacheWriteTokens: ["2.5", "5"], outputTokens: ["10", "15"] } as const;
        const keys = (tier: "short" | "long") => Object.keys(prices).map((meter) => `${tier}-${meter}`);
        const tieredVersion: OfficialPriceVersion = {
            ...version,
            items: (["short", "long"] as const).flatMap((tier, index) => Object.entries(prices).map(([meter, rates]) => ({ key: `${tier}-${meter}`, unit: "token", per: "1000000", price: rates[index], currency: "USD" }))),
        };
        const tieredContract: FlatTextPriceContract = {
            ...input.contract,
            scope: "global-standard-text-tiered",
            itemMeters: Object.fromEntries(tieredVersion.items.map((item) => [item.key, [item.key.split("-")[1]]])) as FlatTextPriceContract["itemMeters"],
            contextTiers: {
                thresholdInputTokens: 272,
                shortItemKeys: keys("short"),
                longItemKeys: keys("long"),
                sourceUrl: "https://developers.openai.com/api/docs/models/gpt-6.1-sol",
                evidence: "Full request switches above the reviewed input threshold",
            },
        };
        const short = prepareFlatTextRequestBound({ ...input, version: tieredVersion, contract: { ...tieredContract, requestLimits: { ...limits, maxInputTokens: 272 } } });
        expect(short).toMatchObject({ ready: true, maximumQuoteUsage: { "short-cacheWriteTokens": "272", "short-outputTokens": "100", "long-inputTokens": "0" }, maximumExactPoints: "147/125" });
        const long = prepareFlatTextRequestBound({ ...input, version: tieredVersion, contract: tieredContract });
        expect(long).toMatchObject({ ready: true, maximumQuoteUsage: { "short-inputTokens": "0", "long-cacheWriteTokens": "1000", "long-outputTokens": "100" }, maximumExactPoints: "91/20" });
        if (!long.ready) throw new Error("fixture request bound missing");
        const estimated = estimateFlatTextRequestUsage({ version: tieredVersion, policy, contract: tieredContract, payload: input.payload, bound: long, recentOutputTokens: "5" });
        expect(estimated["short-cacheWriteTokens"]).not.toBe("0");
        expect(estimated["short-outputTokens"]).toBe("5");
        expect(estimated["long-cacheWriteTokens"]).toBe("0");
        const dearerShortVersion = { ...tieredVersion, items: tieredVersion.items.map((item) => (item.key === "short-inputTokens" ? { ...item, price: "25" } : item)) };
        const dearerShort = prepareFlatTextRequestBound({ ...input, version: dearerShortVersion, contract: tieredContract });
        expect(dearerShort).toMatchObject({ ready: true, maximumQuoteUsage: { "short-inputTokens": "272", "short-outputTokens": "100", "long-inputTokens": "0" }, maximumExactPoints: "273/50" });
        const observed = inspectProviderTokenUsage("openai-responses", { usage: { input_tokens: 273, output_tokens: 100, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 32 } } });
        expect(validateObservedRequestBound(long, tieredContract, observed)).toEqual([]);
        expect(validateObservedRequestBound(short, tieredContract, observed)).toEqual(["实际用量超过调用开始时核实的请求上界"]);
    });
    it("rejects an unpriced cache component before submission even when the maximum quote uses ordinary input", () => {
        const zero = { ...version, items: version.items.map((item) => (item.key === "cachedInput" ? { ...item, price: "0" } : item)) };
        expect(prepareFlatTextRequestBound({ ...input, version: zero })).toMatchObject({ ready: false, reasons: [expect.stringContaining("固定积分")] });
    });

    it("requires reviewed hard limits and does not mutate the caller request", () => {
        expect(prepareFlatTextRequestBound({ ...input, contract })).toMatchObject({ ready: false });
        const before = structuredClone(input);
        const bound = prepareFlatTextRequestBound(input);
        expect(input).toEqual(before);
        expect(bound).toMatchObject({
            ready: true,
            inputTokens: "1000",
            outputTokens: "100",
            maximumUsage: { ordinaryInput: "1000", cachedInput: "1000", output: "100" },
            maximumQuoteUsage: { ordinaryInput: "1000", cachedInput: "0", output: "100" },
            maximumExactPoints: "49/50",
        });
    });

    it.each(["openai-chat", "openai-responses", "anthropic-messages", "gemini-generate"] as const)("uses the %s output ceiling and candidate count", (protocol) => {
        const itemMeters: FlatTextPriceContract["itemMeters"] = {
            ordinaryInput: protocol === "anthropic-messages" ? ["inputTokens", "cacheWrite5mTokens", "cacheWrite1hTokens"] : protocol === "gemini-generate" ? ["inputTokens"] : ["inputTokens", "cacheWriteTokens"],
            cachedInput: ["cachedInputTokens"],
            output: ["outputTokens"],
        };
        const messages = [{ role: "user", content: "hello" }];
        const payload =
            protocol === "openai-chat"
                ? { messages, max_completion_tokens: 10, n: 2 }
                : protocol === "openai-responses"
                  ? { input: "hello", max_output_tokens: 10 }
                  : protocol === "anthropic-messages"
                    ? { messages, max_tokens: 10 }
                    : { contents: [{ parts: [{ text: "hello" }] }], generationConfig: { maxOutputTokens: 10, candidateCount: 2 } };
        const candidates = protocol === "openai-chat" || protocol === "gemini-generate" ? 2 : 1;
        const bound = prepareFlatTextRequestBound({ ...input, contract: { ...input.contract, protocol, itemMeters }, payload });
        expect(bound).toMatchObject({ ready: true, candidates, outputTokens: String(10 * candidates) });
        expect(prepareFlatTextRequestBound({ ...input, contract: { ...input.contract, protocol, itemMeters }, payload: { ...payload, ...(protocol === "anthropic-messages" ? { max_tokens: 0 } : {}) } }).ready).toBe(true);
    });

    it("selects the highest input rate in a shared cache/input budget and bounds every possible mix", () => {
        const expensiveCache = { ...version, items: version.items.map((item) => (item.key === "cachedInput" ? { ...item, price: "6" } : item)) };
        const bound = prepareFlatTextRequestBound({ ...input, version: expensiveCache });
        expect(bound).toMatchObject({ ready: true, maximumQuoteUsage: { ordinaryInput: "0", cachedInput: "1000", output: "100" }, maximumExactPoints: "112/25" });
        if (!bound.ready) throw Error("bound missing");
        for (const ordinary of [0, 1, 500, 999, 1000]) {
            const actual = new Fraction(ordinary)
                .add(new Fraction(1000 - ordinary).mul(6))
                .add(400)
                .mul(700)
                .div(1000000);
            expect(actual.lte(bound.maximumExactPoints)).toBe(true);
        }
    });

    it("adds input and output when one official item covers both, using frozen conversion and coefficient", () => {
        const combined: OfficialPriceVersion = { ...version, items: [{ key: "tokens", unit: "token", per: "1000000", price: "1", currency: "USD" }] };
        expect(
            prepareFlatTextRequestBound({
                ...input,
                version: combined,
                policy: { ...policy, userPriceRules: [{ scope: "default", coefficient: "0.85" }] },
                contract: { ...input.contract, itemMeters: { tokens: ["inputTokens", "cachedInputTokens", "cacheWriteTokens", "outputTokens"] } },
            }),
        ).toMatchObject({ ready: true, maximumUsage: { tokens: "1100" }, maximumQuoteUsage: { tokens: "1100" }, maximumExactPoints: "1309/2000" });
    });

    it.each([
        { tools: [{ type: "web_search" }] },
        { input: [{ role: "user", content: [{ type: "input_image", image_url: "https://example.com/image" }] }] },
        { previous_response_id: "previous" },
        { background: true },
        { prediction: { content: "predicted" } },
        { best_of: 2 },
        { max_output_tokens: -1 },
        { max_output_tokens: 0 },
        { max_output_tokens: 1.5 },
        { max_output_tokens: "10" },
        { service_tier: "priority" },
        { inference_geo: "us" },
        { model: "other" },
    ])("refuses unsupported or mismatched request %j", (extra) => {
        expect(prepareFlatTextRequestBound({ ...input, payload: { ...input.payload, ...extra } }).ready).toBe(false);
    });

    it("does not guess legacy Chat limits or accept unreviewed candidate counts", () => {
        const chat = { ...input, contract: { ...input.contract, protocol: "openai-chat" as const } };
        const messages = [{ role: "user", content: "hello" }];
        for (const extra of [{ max_tokens: 10 }, { n: 4 }, { n: 0 }, { n: 1.5 }]) expect(prepareFlatTextRequestBound({ ...chat, payload: { messages, ...extra } }).ready).toBe(false);
        expect(prepareFlatTextRequestBound({ ...chat, payload: { messages, n: 3 } })).toMatchObject({ ready: true, outputTokens: "300" });
    });

    it("uses Kimi K2.7 Code's documented reasoning-inclusive max_tokens only for the exact model", () => {
        const kimiVersion = { ...version, manufacturer: "Moonshot", sku: "kimi-k2.7-code" };
        const kimiContract: FlatTextPriceContract = {
            ...input.contract,
            protocol: "openai-chat",
            requestedModel: "kimi-k2.7-code",
            reportedModel: "kimi-k2.7-code",
            itemMeters: {
                ordinaryInput: ["uncachedInputTokens"],
                cachedInput: ["cachedInputTokens"],
                output: ["outputTokens"],
            },
            requestLimits: {
                ...limits,
                maxOutputTokens: 32768,
                maxCandidates: 1,
                sourceUrl: "https://platform.kimi.ai/docs/guide/use-thinking-models",
                evidence: "Kimi 官方明确 max_tokens 包含 reasoning_content 与 content；精确型号默认 32768，渠道输入上界已审核",
            },
        };
        const kimi = { ...input, version: kimiVersion, contract: kimiContract, payload: { model: "kimi-k2.7-code", messages: [{ role: "user", content: "hello" }], max_tokens: 4096 } };
        expect(prepareFlatTextRequestBound(kimi)).toMatchObject({ ready: true, outputTokens: "4096", candidates: 1, maximumQuoteUsage: { output: "4096" } });
        expect(prepareFlatTextRequestBound({ ...kimi, payload: { model: "kimi-k2.7-code", messages: kimi.payload.messages } })).toMatchObject({ ready: true, outputTokens: "32768" });
        expect(prepareFlatTextRequestBound({ ...kimi, contract: { ...kimiContract, requestLimits: { ...kimiContract.requestLimits!, maxOutputTokens: 100 } } })).toMatchObject({ ready: false, reasons: ["请求输出 Token 上限超出已审核上界"] });
        expect(prepareFlatTextRequestBound({ ...kimi, payload: { ...kimi.payload, max_tokens: 32769 } })).toMatchObject({ ready: false, reasons: ["请求输出 Token 上限超出已审核上界"] });
        expect(prepareFlatTextRequestBound({ ...kimi, payload: { ...kimi.payload, max_completion_tokens: 4096 } })).toMatchObject({ ready: false, reasons: ["Kimi K2 按量请求须使用已核实的 max_tokens 上界"] });
        expect(prepareFlatTextRequestBound({ ...kimi, version: { ...kimiVersion, sku: "kimi-k2.7-code-highspeed" } })).toMatchObject({ ready: false, reasons: ["旧 max_tokens 尚无推理计费上界契约"] });
        const k26 = { ...kimi, version: { ...kimiVersion, sku: "kimi-k2.6" }, contract: { ...kimiContract, requestedModel: "kimi-k2.6", reportedModel: "kimi-k2.6" }, payload: { ...kimi.payload, model: "kimi-k2.6" } };
        expect(prepareFlatTextRequestBound(k26)).toMatchObject({ ready: true, outputTokens: "4096" });
        expect(prepareFlatTextRequestBound({ ...k26, payload: { model: "kimi-k2.6", messages: kimi.payload.messages } })).toMatchObject({ ready: true, outputTokens: "32768" });
        const highspeed = {
            ...kimi,
            version: { ...kimiVersion, sku: "kimi-k2.7-code-highspeed" },
            contract: { ...kimiContract, requestedModel: "kimi-k2.7-code-highspeed", reportedModel: "kimi-k2.7-code-highspeed" },
            payload: { ...kimi.payload, model: "kimi-k2.7-code-highspeed" },
        };
        expect(prepareFlatTextRequestBound(highspeed)).toMatchObject({ ready: true, outputTokens: "4096" });
        expect(prepareFlatTextRequestBound({ ...highspeed, payload: { model: "kimi-k2.7-code-highspeed", messages: kimi.payload.messages } })).toMatchObject({ ready: true, outputTokens: "32768" });
    });

    it("reserves Kimi K3's documented default output instead of a smaller audited fixture limit", () => {
        const k3Version: OfficialPriceVersion = {
            ...version,
            manufacturer: "Moonshot",
            sku: "kimi-k3",
            items: [
                { key: "ordinaryInput", unit: "token", per: "1000000", price: "3", currency: "USD" },
                { key: "cachedInput", unit: "token", per: "1000000", price: "0.3", currency: "USD" },
                { key: "write5m", unit: "token", per: "1000000", price: "3", currency: "USD" },
                { key: "write1h", unit: "token", per: "1000000", price: "6", currency: "USD" },
                { key: "output", unit: "token", per: "1000000", price: "15", currency: "USD" },
            ],
        };
        const k3Contract: FlatTextPriceContract = {
            ...input.contract,
            protocol: "openai-chat",
            requestedModel: "kimi-k3",
            reportedModel: "kimi-k3",
            itemMeters: {
                ordinaryInput: ["inputTokens"],
                cachedInput: ["cachedInputTokens"],
                write5m: ["cacheWrite5mTokens"],
                write1h: ["cacheWrite1hTokens"],
                output: ["outputTokens"],
            },
            requestLimits: { ...limits, maxOutputTokens: 131072, maxCandidates: 1, sourceUrl: "https://platform.kimi.ai/docs/guide/kimi-k3-quickstart", evidence: "Kimi K3 max_completion_tokens defaults to 131072" },
        };
        const request = { ...input, version: k3Version, contract: k3Contract, payload: { model: "kimi-k3", messages: [{ role: "user", content: "hello" }] } };
        expect(prepareFlatTextRequestBound(request)).toMatchObject({ ready: true, outputTokens: "131072", maximumQuoteUsage: { output: "131072" } });
        expect(prepareFlatTextRequestBound({ ...request, contract: { ...k3Contract, requestLimits: { ...k3Contract.requestLimits!, maxOutputTokens: 16 } } })).toMatchObject({ ready: false, reasons: ["请求输出 Token 上限超出已审核上界"] });
    });

    it("rejects request output above the reviewed ceiling instead of reserving a smaller amount", () => {
        expect(prepareFlatTextRequestBound({ ...input, payload: { ...input.payload, max_output_tokens: 101 } })).toMatchObject({ ready: false, reasons: ["请求输出 Token 上限超出已审核上界"] });
    });

    it("refuses forged, incomplete, or future audit evidence", () => {
        for (const changes of [
            { maxInputTokens: 0 },
            { maxOutputTokens: -1 },
            { maxCandidates: 1.5 },
            { maxInputTokens: Number.MAX_SAFE_INTEGER + 1 },
            { sourceUrl: "http://example.com" },
            { sourceUrl: "https://user:secret@example.com" },
            { evidence: " " },
            { includesReasoning: false },
        ]) {
            expect(() => validateFlatTextPriceContract({ ...input.contract, requestLimits: { ...limits, ...changes } }, version, "admin", contract.reviewedAt)).toThrow();
        }
        expect(prepareFlatTextRequestBound({ ...input, occurredAt: "2026-09-30T00:00:00Z" }).ready).toBe(false);
        expect(prepareFlatTextRequestBound({ ...input, contract: { ...input.contract, officialVersionId: "other" } }).ready).toBe(false);
        expect(prepareFlatTextRequestBound({ ...input, policy: { ...policy, priceVersionIds: {} } }).ready).toBe(false);
    });

    it("validates total disjoint input rather than individual cache bucket limits", () => {
        const bound = prepareFlatTextRequestBound(input);
        const observed = (total: number, output: number) => inspectProviderTokenUsage("openai-responses", { usage: { input_tokens: total, output_tokens: output, input_tokens_details: { cached_tokens: 300, cache_write_tokens: 300 } } });
        expect(validateObservedRequestBound(bound, input.contract, observed(1000, 100))).toEqual([]);
        expect(validateObservedRequestBound(bound, input.contract, observed(1001, 100))).toEqual(["实际用量超过调用开始时核实的请求上界"]);
        expect(validateObservedRequestBound(bound, input.contract, observed(1000, 101))).toHaveLength(1);
        expect(validateObservedRequestBound(bound, input.contract, { ...observed(1000, 100), quantities: {} })).toHaveLength(1);
        const inclusive = { ...input.contract, itemMeters: { ordinaryInput: ["uncachedInputTokens"] as const, cachedInput: ["cachedInputTokens"] as const, output: ["outputTokens"] as const } };
        expect(validateObservedRequestBound(bound, { ...inclusive, itemMeters: { ordinaryInput: ["uncachedInputTokens"], cachedInput: ["cachedInputTokens"], output: ["outputTokens"] } }, observed(1000, 100))).toEqual([]);
    });
});
