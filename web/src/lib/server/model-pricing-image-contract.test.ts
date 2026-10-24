import { describe, expect, it } from "vitest";
import Fraction from "fraction.js";

import type { OfficialPriceVersion, SalesVersion } from "@/lib/model-pricing";
import { inspectOpenAiImageCount, inspectOpenAiImageUsage, recordImageRequestMismatches } from "./model-pricing-image-usage";
import { previewObservedImageQuote, validateImagePriceContract, type ImagePriceCallContext, type ImagePriceContract } from "./model-pricing-image-contract";
import { prepareImageRequestBound } from "./model-pricing-image-request";

const version: OfficialPriceVersion = {
    id: "official-fixture",
    candidateId: "approved",
    logicalModelId: "image-fixture",
    manufacturer: "Fixture",
    series: "Image",
    officialVersion: "image-v1",
    sku: "image-v1",
    tier: "paid",
    conditions: "Fixture global standard direct image tokens, all sizes/qualities",
    sourceKind: "manual",
    sourceUrl: "https://example.com/pricing",
    evidence: "Synthetic test prices",
    observedAt: "2026-10-01T00:00:00Z",
    publishedAt: "2026-10-01T00:00:00Z",
    reviewedBy: "price-admin",
    effectiveFrom: "2026-10-01T00:00:00Z",
    effectiveTo: "2026-11-01T00:00:00Z",
    items: [
        { key: "textInput", unit: "token", per: "1000000", price: "5", currency: "USD" },
        { key: "imageInput", unit: "token", per: "1000000", price: "10", currency: "USD" },
        { key: "imageOutput", unit: "token", per: "1000000", price: "40", currency: "USD" },
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
const contract: ImagePriceContract = {
    officialVersionId: version.id,
    channelId: "channel",
    requestedModel: "image",
    reportedModel: "image-v1",
    protocol: "openai-images",
    operation: "generations",
    modelIdentity: "response-required",
    scope: "global-standard-direct-image-tokens",
    region: "global",
    itemMeters: { textInput: ["inputTextTokens"], imageInput: ["inputImageTokens"], imageOutput: ["outputImageTokens"] },
    zeroMeters: ["outputTextTokens"],
    evidence: "fixture channel, direct Images all-size standard tokens verified",
    reviewedBy: "billing-admin",
    reviewedAt: "2026-10-01T12:00:00Z",
};
const call: ImagePriceCallContext = {
    officialVersionId: version.id,
    salesVersionId: policy.id,
    logicalModelId: version.logicalModelId,
    channelId: contract.channelId,
    requestedModel: contract.requestedModel,
    operation: "generations",
    region: "global",
    billingMode: "standard",
    usesExternalTools: false,
    responseComplete: true,
    occurredAt: "2026-10-02T00:00:00Z",
};
const observation = inspectOpenAiImageUsage({
    model: "image-v1",
    data: [{ b64_json: "fixture" }],
    usage: { input_tokens: 3000, output_tokens: 300, total_tokens: 3300, input_tokens_details: { text_tokens: 1000, image_tokens: 2000 }, output_tokens_details: { text_tokens: 0, image_tokens: 300 } },
});
const preview = (overrides: Partial<Parameters<typeof previewObservedImageQuote>[0]> = {}) => previewObservedImageQuote({ version, policy, contract, call, observation, ...overrides });

describe("reviewed direct image token contract", () => {
    it("accepts xhigh and max tiers only for the two GPT Image 2.5 SKUs", () => {
        const tier = {
            quality: "xhigh",
            size: "1024x1024",
            meterQuantities: { inputTextTokens: "100", inputImageTokens: "0", outputTextTokens: "0", outputImageTokens: "1000" },
            sourceUrl: "https://example.com/image-2.5-estimate",
            evidence: "reviewed explicit image tier",
        };
        for (const sku of ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]) {
            const price = { ...version, sku };
            const reviewed = validateImagePriceContract({ ...contract, requestedModel: sku, reportedModel: sku, holdEstimates: [tier, { ...tier, quality: "max" }] }, price, "admin", contract.reviewedAt);
            expect(reviewed.holdEstimates?.map((item) => item.quality)).toEqual(["xhigh", "max"]);
            const bound = prepareImageRequestBound({
                version: price,
                policy,
                modelId: version.logicalModelId,
                request: { contract: { ...reviewed, id: "image-2.5-tier" }, channelId: reviewed.channelId, requestedModel: sku, operation: "generations", payload: { model: sku, prompt: "test", n: 1, size: tier.size, quality: "max" } },
                occurredAt: call.occurredAt,
            });
            expect(bound.upperBoundEvidence).toContain("quality=max; requestedSize=1024x1024; sampleSize=1024x1024");
        }
        for (const sku of ["gpt-image-2", "gpt-image-1.5"]) {
            expect(() => validateImagePriceContract({ ...contract, requestedModel: sku, reportedModel: sku, holdEstimates: [tier] }, { ...version, sku }, "admin", contract.reviewedAt)).toThrow("档位");
        }
        expect(() => validateImagePriceContract({ ...contract, holdEstimates: [{ ...tier, quality: "auto" }] }, { ...version, sku: "gpt-image-2.5-flare" }, "admin", contract.reviewedAt)).toThrow("档位");
    });
    it("scales a reviewed quality baseline from requested pixels and stops unsupported requests before submission", () => {
        const low = {
            quality: "low",
            size: "1024x1024",
            meterQuantities: { inputTextTokens: "100", inputImageTokens: "0", outputTextTokens: "0", outputImageTokens: "300" },
            sourceUrl: "https://example.com/image-samples",
            evidence: "reviewed low sample",
        };
        const high = { ...low, quality: "high", meterQuantities: { ...low.meterQuantities, outputImageTokens: "10000" }, evidence: "reviewed high sample" };
        const reviewed = validateImagePriceContract({ ...contract, holdEstimates: [low, high] }, version, "admin", contract.reviewedAt);
        const bound = (payload: Record<string, unknown>) =>
            prepareImageRequestBound({
                version,
                policy,
                modelId: version.logicalModelId,
                request: { contract: { ...reviewed, id: "tiered" }, channelId: reviewed.channelId, requestedModel: reviewed.requestedModel, operation: "generations", payload },
                occurredAt: call.occurredAt,
            });
        const base = { model: contract.requestedModel, prompt: "test", n: 1, size: "1024x1024" };
        expect(bound({ ...base, quality: "low" }).upperBoundEvidence).toContain("quality=low; requestedSize=1024x1024; sampleSize=1024x1024");
        expect(bound({ ...base, quality: "low" }).upperBoundEvidence).toContain("inputText=reviewed+promptUtf8Bytes");
        expect(new Fraction(bound({ ...base, quality: "high" }).estimatedHoldPoints!).compare(new Fraction(bound({ ...base, quality: "low" }).estimatedHoldPoints!))).toBeGreaterThan(0);
        expect(new Fraction(bound({ ...base, quality: "low", size: "2048x2048" }).estimatedHoldPoints!).compare(new Fraction(bound({ ...base, quality: "low" }).estimatedHoldPoints!))).toBeGreaterThan(0);
        expect(new Fraction(bound({ ...base, quality: "low", prompt: "长".repeat(100) }).estimatedHoldPoints!).compare(new Fraction(bound({ ...base, quality: "low" }).estimatedHoldPoints!))).toBeGreaterThan(0);
        for (const payload of [
            { ...base, quality: "medium" },
            { ...base, quality: "auto" },
            { ...base, quality: "low", size: "auto" },
            { ...base, quality: "low", n: 2 },
            { ...base, quality: "low", image: "data:image/png;base64,fixture" },
            { ...base, quality: "low", output_format: "webp" },
        ])
            expect(() => bound(payload)).toThrow("按量准入暂停");
        expect(() => bound({ ...base, quality: "low", input_fidelity: "high" })).toThrow();
        expect(() => bound({ ...base, quality: "low", background: "transparent" })).toThrow();
        expect(() => bound({ ...base, quality: "low", prompt: "" })).toThrow("明确文本提示词");
        expect(() => validateImagePriceContract({ ...contract, holdEstimates: [low, low] }, version, "admin", contract.reviewedAt)).toThrow("不能重复");
        expect(() => validateImagePriceContract({ ...contract, holdEstimates: [{ ...low, size: "auto" }] }, version, "admin", contract.reviewedAt)).toThrow("档位");
    });
    it("reserves a reviewed auto-size generation sample only for matching quality and single output", () => {
        const auto = {
            quality: "low",
            size: "auto",
            observedSize: "1536x1024",
            meterQuantities: { inputTextTokens: "24", inputImageTokens: "0", outputTextTokens: "0", outputImageTokens: "343" },
            sourceUrl: "https://example.com/image-auto-sample",
            evidence: "one reviewed low-quality auto-size generation sample",
        };
        const reviewed = validateImagePriceContract({ ...contract, holdEstimates: [auto] }, version, "admin", contract.reviewedAt);
        const bound = (payload: Record<string, unknown>) =>
            prepareImageRequestBound({
                version,
                policy,
                modelId: version.logicalModelId,
                request: { contract: { ...reviewed, id: "auto-tier" }, channelId: reviewed.channelId, requestedModel: reviewed.requestedModel, operation: "generations", payload },
                occurredAt: call.occurredAt,
            });
        const request = { model: contract.requestedModel, prompt: "test", n: 1, quality: "low" };
        const omitted = bound(request);
        expect(omitted.upperBoundEvidence).toContain("requestedSize=auto; observedSampleSize=1536x1024; imageTokens=reviewedAutoSample");
        expect(bound({ ...request, size: "auto" }).estimatedHoldPoints).toBe(omitted.estimatedHoldPoints);
        for (const payload of [
            { ...request, size: "1024x1024" },
            { ...request, quality: "auto" },
            { ...request, n: 2 },
        ])
            expect(() => bound(payload)).toThrow("按量准入暂停");
        expect(() => validateImagePriceContract({ ...contract, holdEstimates: [{ ...auto, observedSize: undefined }] }, version, "admin", contract.reviewedAt)).toThrow("样本实际输出尺寸");
        expect(() => validateImagePriceContract({ ...contract, holdEstimates: [{ ...auto, size: "1024x1024" }] }, version, "admin", contract.reviewedAt)).toThrow("固定尺寸档位");
    });
    it("matches an edit tier only for one measured reference with no mask", () => {
        const tier = {
            quality: "low",
            size: "1024x1024",
            referenceSize: "1024x1024",
            meterQuantities: { inputTextTokens: "31", inputImageTokens: "1024", outputTextTokens: "0", outputImageTokens: "515" },
            sourceUrl: "https://example.com/image-edit-sample",
            evidence: "reviewed single-reference edit sample",
        };
        const reviewed = validateImagePriceContract({ ...contract, operation: "edits", holdEstimates: [tier] }, version, "admin", contract.reviewedAt);
        const bound = (referenceImages?: Array<{ width: number; height: number } | null>, hasMask = false, requestFieldNames?: string[]) =>
            prepareImageRequestBound({
                version,
                policy,
                modelId: version.logicalModelId,
                request: {
                    contract: { ...reviewed, id: "edit-tier" },
                    channelId: reviewed.channelId,
                    requestedModel: reviewed.requestedModel,
                    operation: "edits",
                    payload: { model: reviewed.requestedModel, prompt: "edit", n: "1", quality: "low", size: "1024x1024" },
                    referenceImages,
                    hasMask,
                    requestFieldNames,
                },
                occurredAt: call.occurredAt,
            });
        expect(bound([{ width: 1024, height: 1024 }]).upperBoundEvidence).toContain("referenceSize=1024x1024; sampleReferenceSize=1024x1024");
        expect(new Fraction(bound([{ width: 512, height: 512 }]).estimatedHoldPoints!).compare(new Fraction(bound([{ width: 1024, height: 1024 }]).estimatedHoldPoints!))).toBeLessThan(0);
        for (const refs of [
            undefined,
            [],
            [null],
            [
                { width: 1024, height: 1024 },
                { width: 1024, height: 1024 },
            ],
        ])
            expect(() => bound(refs)).toThrow("按量准入暂停");
        expect(() => bound([{ width: 1024, height: 1024 }], true)).toThrow("按量准入暂停");
        expect(() => bound([{ width: 1024, height: 1024 }], false, ["model", "prompt", "n", "quality", "size", "image", "input_fidelity"])).toThrow("按量准入暂停");
        expect(() => bound([{ width: 1024, height: 1024 }], false, ["model", "prompt", "n", "quality", "size", "image"])).not.toThrow();
        expect(() => validateImagePriceContract({ ...contract, operation: "edits", holdEstimates: [{ ...tier, referenceSize: "auto" }] }, version, "admin", contract.reviewedAt)).toThrow("参考图尺寸");
        expect(() => validateImagePriceContract({ ...contract, operation: "edits", holdEstimates: [{ ...tier, meterQuantities: { ...tier.meterQuantities, inputImageTokens: "0" } }] }, version, "admin", contract.reviewedAt)).toThrow("参考图输入 Token");
        expect(() => validateImagePriceContract({ ...contract, holdEstimates: [tier] }, version, "admin", contract.reviewedAt)).toThrow("生成档位不得填写参考图尺寸");
    });
    it("validates reviewed modal hold quantities and keeps old frozen contracts readable for observed settlement", () => {
        const holdEstimate = { meterQuantities: { inputTextTokens: "1000", inputImageTokens: "0", outputTextTokens: "0", outputImageTokens: "0" }, sourceUrl: "https://example.com/image-estimate", evidence: "reviewed representative request" };
        expect(validateImagePriceContract({ ...contract, holdEstimate }, version, "admin", contract.reviewedAt).holdEstimate).toMatchObject(holdEstimate);
        expect(preview({ contract })).toMatchObject({ ready: true, quote: { points: "25.90" } });
        for (const invalid of [
            { ...holdEstimate, meterQuantities: { ...holdEstimate.meterQuantities, outputTextTokens: "1" } },
            { ...holdEstimate, meterQuantities: { ...holdEstimate.meterQuantities, inputTextTokens: "0" } },
            { ...holdEstimate, meterQuantities: { ...holdEstimate.meterQuantities, inputTextTokens: "1.5" } },
            { ...holdEstimate, sourceUrl: "http://example.com/image-estimate" },
            { ...holdEstimate, evidence: "" },
        ])
            expect(() => validateImagePriceContract({ ...contract, holdEstimate: invalid }, version, "admin", contract.reviewedAt)).toThrow("预留估算");
    });
    it.each(["generations", "edits"] as const)("quotes exact modality prices once for %s", (operation) => {
        const reviewed = validateImagePriceContract({ ...contract, operation, reviewedBy: "forged", reviewedAt: "forged" }, version, "actual-admin", contract.reviewedAt);
        expect(reviewed).toMatchObject({ officialVersionId: version.id, reviewedBy: "actual-admin", reviewedAt: contract.reviewedAt });
        expect(preview({ contract: reviewed, call: { ...call, operation } })).toMatchObject({ ready: true, usage: { textInput: "1000", imageInput: "2000", imageOutput: "300" }, quote: { points: "25.90", exactPoints: "259/10" } });
    });
    it("records explicit size and quality differences without changing actual-usage pricing", () => {
        const response = {
            model: "image-v1",
            quality: "medium",
            size: "1536x1024",
            data: [{ b64_json: "fixture", width: 1254, height: 1254 }],
            usage: { input_tokens: 3000, output_tokens: 300, total_tokens: 3300, input_tokens_details: { text_tokens: 1000, image_tokens: 2000 }, output_tokens_details: { text_tokens: 0, image_tokens: 300 } },
        };
        const observed = recordImageRequestMismatches(inspectOpenAiImageUsage(response), response, { quality: "low", size: "1024x1024" });
        expect(observed.requestMismatches).toEqual([
            { field: "quality", requested: "low", reported: "medium", source: "response.quality" },
            { field: "size", requested: "1024x1024", reported: "1536x1024", source: "response.size" },
            { field: "size", requested: "1024x1024", reported: "1254x1254", source: "data[0].dimensions" },
        ]);
        expect(preview({ observation: observed })).toMatchObject({ ready: true, quote: { points: "25.90" } });
        expect(preview({ observation: { ...observed, reportedModel: "other-model" } })).toMatchObject({ ready: false });
        expect(preview({ observation: { ...observed, quantities: { ...observed.quantities, outputImageTokens: undefined as never } } })).toMatchObject({ ready: false });
    });
    it("does not price zero-only metadata on direct Images calls and blocks unexplained nonzero values", () => {
        const payload = {
            model: "image-v1",
            data: [{ b64_json: "fixture" }],
            usage: { input_tokens: 3000, output_tokens: 300, total_tokens: 3300, input_tokens_details: { text_tokens: 1000, image_tokens: 2000, cached_tokens: 0 }, output_tokens_details: { text_tokens: 0, image_tokens: 300, reasoning_tokens: 0 } },
        };
        expect(preview({ observation: inspectOpenAiImageUsage(payload) })).toMatchObject({ ready: true, usage: { textInput: "1000", imageInput: "2000", imageOutput: "300" } });
        const cached = inspectOpenAiImageUsage({ ...payload, usage: { ...payload.usage, input_tokens_details: { ...payload.usage.input_tokens_details, cached_tokens: 1 } } });
        expect(preview({ observation: cached })).toMatchObject({ ready: false, reasons: [expect.stringContaining("input_tokens_details.cached_tokens")] });
    });
    it.each(version.items.map((item) => item.key))("rejects a free %s image token component at review and quotation", (key) => {
        const zero = { ...version, items: version.items.map((item) => (item.key === key ? { ...item, price: "0" } : item)) };
        expect(() => validateImagePriceContract(contract, zero, "admin", contract.reviewedAt)).toThrow("固定积分");
        expect(preview({ version: zero })).toMatchObject({ ready: false, reasons: [expect.stringContaining("固定积分")] });
    });

    it("preserves sub-cent exact fractions and the single model coefficient", () => {
        const tiny = inspectOpenAiImageUsage({
            model: "image-v1",
            data: [{ url: "https://example.com/result.png" }],
            usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1, input_tokens_details: { text_tokens: 1, image_tokens: 0 }, output_tokens_details: { text_tokens: 0, image_tokens: 0 } },
        });
        expect(preview({ observation: tiny })).toMatchObject({ ready: true, quote: { exactPoints: "7/2000" } });
        expect(
            preview({
                observation: tiny,
                policy: {
                    ...policy,
                    userPriceRules: [
                        { scope: "default", coefficient: "3" },
                        { scope: "model", modelId: version.logicalModelId, coefficient: "1.5" },
                    ],
                },
            }),
        ).toMatchObject({ ready: true, quote: { exactPoints: "21/4000" } });
    });
    it("quotes one ownerless image price for independently selected models and operations", () => {
        const shared = { ...version, logicalModelId: "", sku: contract.requestedModel };
        const generation = { logicalModelId: "image-fixture", scope: "image:generations:standard", bindingId: "generation-binding", bindingRevision: "generation-revision", officialVersionId: shared.id };
        const edit = { logicalModelId: "image-fixture", scope: "image:edits:standard", bindingId: "edit-binding", bindingRevision: "edit-revision", officialVersionId: shared.id };
        const second = { ...generation, logicalModelId: "second-image", bindingId: "second-binding", bindingRevision: "second-revision" };
        const selectedPolicy = { ...policy, priceVersionIds: {}, selectedPriceBindings: [generation, edit, second], userPriceRules: [{ scope: "model" as const, modelId: "second-image", coefficient: "2" }] };
        const quote = (logicalModelId: string, operation: "generations" | "edits", priceSelection: typeof generation) => preview({ version: shared, policy: selectedPolicy, call: { ...call, logicalModelId, operation, priceSelection } });
        expect(quote("image-fixture", "generations", generation)).toMatchObject({ ready: true, quote: { modelId: "image-fixture", exactPoints: "259/10" } });
        expect(quote("second-image", "generations", second)).toMatchObject({ ready: true, quote: { modelId: "second-image", exactPoints: "259/5" } });
        expect(quote("image-fixture", "edits", edit)).toMatchObject({ ready: false, reasons: expect.arrayContaining(["调用不属于已审核的直接 Images 操作"]) });
        expect(preview({ version: shared, policy: selectedPolicy, contract: { ...contract, operation: "edits" }, call: { ...call, operation: "edits", priceSelection: edit } })).toMatchObject({ ready: true, quote: { exactPoints: "259/10" } });
        expect(quote("image-fixture", "generations", edit).ready).toBe(false);
        expect(quote("image-fixture", "generations", { ...generation, bindingRevision: "stale" }).ready).toBe(false);
    });
    it("requires a reviewed operation-specific identity before an ownerless image alias can quote", () => {
        const shared = { ...version, logicalModelId: "" };
        const selected = { logicalModelId: "image-fixture", scope: "image:generations:standard", bindingId: "price-binding", bindingRevision: "revision", officialVersionId: shared.id };
        const selectedPolicy = { ...policy, priceVersionIds: {}, selectedPriceBindings: [selected] };
        const identity = { channelBindingId: "channel-binding", officialSku: shared.sku, operation: "generations" as const, sourceUrl: "https://example.com/image-identity", evidence: "精确请求名、响应名及官网 SKU 已核对" };
        const selectedCall = { ...call, priceSelection: selected };
        expect(() => validateImagePriceContract(contract, shared, "admin", contract.reviewedAt)).toThrow("型号身份");
        expect(preview({ version: shared, policy: selectedPolicy, contract: { ...contract, identity }, call: selectedCall })).toMatchObject({ ready: true, quote: { exactPoints: "259/10" } });
        for (const invalid of [
            { ...identity, officialSku: "other" },
            { ...identity, operation: "edits" },
            { ...identity, sourceUrl: "http://example.com/image-identity" },
            { ...identity, evidence: "" },
        ])
            expect(() => validateImagePriceContract({ ...contract, identity: invalid }, shared, "admin", contract.reviewedAt)).toThrow("图片渠道别名");
        expect(preview({ version: shared, policy: selectedPolicy, contract: { ...contract, identity }, call: selectedCall, observation: { ...observation, reportedModel: "other" } })).toMatchObject({
            ready: false,
            reasons: expect.arrayContaining([expect.stringContaining("型号")]),
        });
    });
    it("requires every real split even when a price would be zero", () => {
        for (const meter of Object.keys(observation.quantities)) {
            const quantities = { ...observation.quantities };
            delete quantities[meter];
            expect(preview({ observation: { ...observation, quantities } })).toMatchObject({ ready: false, reasons: expect.arrayContaining([`缺少 ${meter} 的真实用量`]) });
        }
        const nonzero = { ...observation, quantities: { ...observation.quantities, outputTextTokens: "1", outputTotalTokens: "301", totalTokens: "3301" } };
        expect(preview({ observation: nonzero })).toMatchObject({ ready: false, reasons: ["outputTextTokens 必须由上游明确报告为零"] });
        expect(preview({ observation: { ...observation, quantities: { ...observation.quantities, inputTotalTokens: "1" } } })).toMatchObject({ ready: false, reasons: ["上游总量与模态分项不一致"] });
    });
    it("never maps totals, cache or per-image rows by guessing or ignores a price row", () => {
        const invalid = [
            { ...contract, itemMeters: { ...contract.itemMeters, imageOutput: ["outputTotalTokens"] } },
            { ...contract, zeroMeters: [] },
            { ...contract, zeroMeters: ["outputTextTokens", "inputTextTokens"] },
            { ...contract, itemMeters: { ...contract.itemMeters, cached: [] } },
            { ...contract, protocol: "openai-responses" },
            { ...contract, modelIdentity: "auto" },
            { ...contract, scope: "regional" },
        ];
        for (const value of invalid) expect(() => validateImagePriceContract(value, version, "admin", contract.reviewedAt)).toThrow();
        expect(() => validateImagePriceContract(contract, { ...version, items: [...version.items, { key: "cached", unit: "token", per: "1", price: "0.1", currency: "USD" }] }, "admin", contract.reviewedAt)).toThrow("分项完全一致");
        expect(() => validateImagePriceContract(contract, { ...version, items: version.items.map((item) => ({ ...item, unit: "image" })) }, "admin", contract.reviewedAt)).toThrow("真实 Token 分项");
    });
    it("allows absent response model only with explicit reviewed request identity and still rejects a wrong response model", () => {
        const noModel = { ...observation, reportedModel: undefined };
        expect(preview({ observation: noModel })).toMatchObject({ ready: false, reasons: ["上游响应型号未确认"] });
        const nestedModel = inspectOpenAiImageUsage({
            data: [{ b64_json: "fixture", model: "image-v1" }],
            usage: { input_tokens: 3000, output_tokens: 300, total_tokens: 3300, input_tokens_details: { text_tokens: 1000, image_tokens: 2000 }, output_tokens_details: { text_tokens: 0, image_tokens: 300 } },
        });
        expect(preview({ observation: nestedModel }).ready).toBe(true);
        const reviewed = { ...contract, modelIdentity: "reviewed-request" as const };
        expect(preview({ contract: reviewed, observation: noModel }).ready).toBe(true);
        expect(preview({ contract: reviewed, observation: { ...observation, reportedModel: "other" } }).ready).toBe(false);
    });
    it.each([
        { channelId: "fallback" },
        { requestedModel: "other" },
        { logicalModelId: "other" },
        { operation: "edits" },
        { region: "us" },
        { billingMode: "batch" },
        { usesExternalTools: true },
        { responseComplete: false },
        { salesVersionId: "other" },
        { officialVersionId: "other" },
        { occurredAt: "2026-09-30T00:00:00Z" },
        { occurredAt: "2026-11-01T00:00:00Z" },
        { occurredAt: "invalid" },
    ])("rejects unverified context %j", (patch) => {
        expect(preview({ call: { ...call, ...patch } }).ready).toBe(false);
    });
    it("rejects incomplete/error payloads, changed policy and malformed persisted mappings", () => {
        expect(preview({ observation: { ...observation, hasResults: false } }).ready).toBe(false);
        expect(preview({ observation: { ...observation, invalid: ["invalid upstream"] } }).ready).toBe(false);
        expect(preview({ policy: { ...policy, priceVersionIds: {} } }).ready).toBe(false);
        expect(preview({ contract: { ...contract, zeroMeters: [] } }).ready).toBe(false);
        expect(preview({ contract: { ...contract, officialVersionId: "other" } }).ready).toBe(false);
    });
});

describe("reviewed DataEyes FLUX per-image contract", () => {
    const unitVersion = { ...version, sku: "flux-kontext-pro", items: [{ key: "image", unit: "image", per: "1", price: "0.04", currency: "USD" }] };
    const unit: ImagePriceContract = {
        ...contract,
        requestedModel: "flux-kontext-pro",
        reportedModel: "flux-kontext-pro",
        modelIdentity: "reviewed-request",
        scope: "global-standard-dataeyes-flux-image",
        itemMeters: {},
        zeroMeters: [],
        imageLimit: { maxImages: 1, sourceUrl: "https://example.com/single-image", evidence: "Fixture documented single image, n ignored" },
    };
    it("refuses free per-image evidence as a billable normal rate", () => {
        const zero = { ...unitVersion, items: [{ ...unitVersion.items[0], price: "0" }] };
        expect(() => validateImagePriceContract(unit, zero, "admin", unit.reviewedAt)).toThrow("固定积分");
    });
    const observed = inspectOpenAiImageCount({ data: [{ url: "https://example.com/private.png" }] });
    const unitCall = { ...call, requestedModel: unit.requestedModel, declaredProtocol: "dataeyes-flux" };
    const quote = (patch: Partial<Parameters<typeof previewObservedImageQuote>[0]> = {}) => previewObservedImageQuote({ version: unitVersion, policy, contract: unit, call: unitCall, observation: observed, ...patch });
    it.each(["flux-kontext-pro", "flux-kontext-max", "flux-pro-1.1"])("quotes one observed image for %s without guessed tokens", (model) => {
        for (const operation of model === "flux-pro-1.1" ? ["generations"] : ["generations", "edits"]) {
            expect(
                quote({ version: { ...unitVersion, sku: model }, contract: { ...unit, requestedModel: model, reportedModel: model, operation: operation as "generations" | "edits" }, call: { ...unitCall, requestedModel: model, operation } }),
            ).toMatchObject({ ready: true, usage: { image: "1" }, quote: { exactPoints: "28", points: "28.00" } });
        }
        expect(observed.quantities).toEqual({ images: "1" });
    });
    it("preserves exact fractions and the single applicable coefficient", () => {
        expect(
            quote({
                version: { ...unitVersion, items: [{ ...unitVersion.items[0], per: "3", price: "0.00001" }] },
                policy: {
                    ...policy,
                    userPriceRules: [
                        { scope: "default", coefficient: "9" },
                        { scope: "model", modelId: version.logicalModelId, coefficient: "1.5" },
                    ],
                },
            }),
        ).toMatchObject({ ready: true, quote: { exactPoints: "7/2000" } });
    });
    it.each([
        {},
        { data: [] },
        { data: [{ url: "" }] },
        { data: [{ b64_json: "not-a-gateway-url" }] },
        { data: [{ url: "javascript:alert(1)" }] },
        { data: [{ url: "https://user:secret@example.com/result" }] },
        { data: [{ url: "https://example.com/one" }, {}] },
        { data: [{ url: "https://example.com/one" }, { url: "https://example.com/two" }] },
        { error: { message: "upstream failed" }, data: [{ url: "https://example.com/result" }] },
    ])("rejects missing, partial, excessive or error results %j", (payload) => {
        expect(quote({ observation: inspectOpenAiImageCount(payload) }).ready).toBe(false);
    });
    it("requires verified protocol, operation, price identity and HTTPS count evidence", () => {
        for (const patch of [{ declaredProtocol: "openai" }, { declaredProtocol: undefined }, { requestedModel: "other" }, { operation: "responses" }, { channelId: "other" }, { billingMode: "batch" }])
            expect(quote({ call: { ...unitCall, ...patch } }).ready).toBe(false);
        for (const patch of [
            { imageLimit: undefined },
            { imageLimit: { ...unit.imageLimit, maxImages: 2 } },
            { imageLimit: { ...unit.imageLimit, sourceUrl: "http://example.com" } },
            { imageLimit: { ...unit.imageLimit, evidence: "" } },
            { itemMeters: { image: ["outputImageTokens"] } },
            { zeroMeters: ["inputTextTokens"] },
            { requestedModel: "flux-2-pro" },
        ])
            expect(() => validateImagePriceContract({ ...unit, ...patch }, unitVersion, "admin", unit.reviewedAt)).toThrow();
        expect(() => validateImagePriceContract({ ...unit, requestedModel: "flux-pro-1.1", operation: "edits" }, { ...unitVersion, sku: "flux-pro-1.1" }, "admin", unit.reviewedAt)).toThrow();
        expect(quote({ version: { ...unitVersion, sku: "other" } }).ready).toBe(false);
        expect(quote({ observation: { ...observed, reportedModel: "other" } }).ready).toBe(false);
        expect(quote({ version: { ...unitVersion, items: [...unitVersion.items, { ...unitVersion.items[0], key: "extra" }] } }).ready).toBe(false);
        expect(quote({ observation }).ready).toBe(false);
    });
});
