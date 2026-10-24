import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    admission: vi.fn(),
    policy: vi.fn(),
    versions: vi.fn(),
    rule: vi.fn(),
    files: vi.fn(),
    read: vi.fn(),
    source: vi.fn(),
    refunded: vi.fn(),
    reversed: vi.fn(),
    wallet: vi.fn(),
    quote: vi.fn(),
    bound: vi.fn(),
    mutate: vi.fn(),
}));
vi.mock("./database", () => ({ getDatabaseProvider: () => "file" }));
vi.mock("./data-adapter", () => ({ listDataDirectory: mocks.files, readJsonDataFile: mocks.read }));
vi.mock("./model-pricing-admission", () => ({ getModelPricingAdmission: mocks.admission }));
vi.mock("./model-pricing-store", () => ({ getCurrentSalesVersion: mocks.policy, getOfficialVersionsByIds: mocks.versions }));
vi.mock("./model-pricing-text-usage-rule-store", () => ({ getTextUsageRuleById: mocks.rule }));
vi.mock("./model-pricing-effective-terms", () => ({ modelPricingEffectiveTerms: () => "terms" }));
vi.mock("./model-pricing-shadow-refund", () => ({ getShadowBillingSource: mocks.source, hasRefundedShadowBillingSource: mocks.refunded }));
vi.mock("./model-pricing-wallet-service", () => ({ getModelPriceReservation: mocks.wallet }));
vi.mock("./model-pricing-shadow-service", () => ({ prepareFlatTextShadowPrice: mocks.quote }));
vi.mock("./model-pricing-request-bound", () => ({ validateObservedRequestBound: mocks.bound }));
vi.mock("./model-pricing-shadow-store", () => ({ hasShadowPriceReversal: mocks.reversed, mutateShadowTextCall: mocks.mutate }));

import { revalueSavedTextEvidence } from "./model-pricing-shadow-evidence";

describe("saved text evidence revaluation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.admission.mockResolvedValue({ capability: "text", officialVersionId: "official", textUsageRuleId: "new-rule", bindings: [{ key: "channel/sku", fingerprint: "valid", contractIds: ["contract"] }] });
        mocks.policy.mockResolvedValue({ id: "sale", priceVersionIds: { model: "official" } });
        mocks.versions.mockResolvedValue([{ id: "official", logicalModelId: "model", items: [] }]);
        mocks.rule.mockResolvedValue({ id: "new-rule", modelId: "model", officialVersionId: "official" });
        mocks.files.mockResolvedValue([{ name: "source.json", isFile: () => true }]);
        mocks.read.mockResolvedValue({
            calls: [
                {
                    userId: "user",
                    requestId: "system-ai:original",
                    requestFingerprint: "fingerprint",
                    modelId: "model",
                    channelId: "channel",
                    requestedModel: "sku",
                    protocol: "openai-chat",
                    startedAt: "2026-10-01T00:00:00Z",
                    requestContext: { inputModalities: ["text"], outputModalities: ["text"], billingMode: "standard" },
                    requestBound: { ready: true },
                    frozen: { version: { id: "official" }, policy: { id: "sale" }, contract: { id: "contract", region: "global", serviceTier: "default" } },
                    result: { status: "unpriced", reasons: ["缺少缓存写入真实用量"], completedAt: "2026-10-01T00:00:10Z", observation: { protocol: "openai-chat", quantities: { inputTotalTokens: "10", outputTokens: "5" } } },
                },
            ],
            receipts: [],
        });
        mocks.source.mockResolvedValue({ id: "point", type: "consume", userId: "user", requestFingerprint: "fingerprint", model: "model" });
        mocks.refunded.mockResolvedValue(false);
        mocks.reversed.mockResolvedValue(false);
        mocks.bound.mockReturnValue([]);
        mocks.quote.mockReturnValue({ ready: true, warnings: [], normalizedObservation: { quantities: {} }, build: () => ({ id: "receipt", changeExactPoints: "5" }) });
        mocks.mutate.mockImplementation(async (_user, _request, build) => build(undefined, { exactPoints: "0" }).call);
    });

    it("reuses a real saved response with a zero-accrual evidence receipt", async () => {
        expect((await revalueSavedTextEvidence("model", "channel/sku")).revalued).toBe(1);
        expect(mocks.mutate).toHaveBeenCalledOnce();
        const [, requestId, build] = mocks.mutate.mock.calls[0];
        expect(requestId).toMatch(/^text-revaluation:/);
        const saved = build(undefined, { exactPoints: "0" });
        expect(saved.receipt).toMatchObject({ id: "receipt", changeExactPoints: "0" });
        expect(saved.call).toMatchObject({ taskId: undefined, frozen: { rules: { id: "new-rule" } }, result: { status: "priced", receiptId: "receipt" } });
    });

    it("does not admit identity-warning evidence", async () => {
        mocks.quote.mockReturnValue({ ready: true, warnings: ["响应型号不同"] });
        expect((await revalueSavedTextEvidence("model", "channel/sku")).revalued).toBe(0);
        expect(mocks.mutate).not.toHaveBeenCalled();
    });

    it("revalues saved zero-only detail metadata while leaving the original observation unchanged", async () => {
        const data = await mocks.read();
        const original = data.calls[0].result.observation;
        const path = "prompt_tokens_details.image_tokens";
        original.invalid = `未解释的文本用量字段：${path}`;
        original.unmappedUsageFields = [path];
        original.usageFields = { [path]: "0" };
        mocks.read.mockResolvedValue(data);
        expect((await revalueSavedTextEvidence("model", "channel/sku")).revalued).toBe(1);
        expect(original.invalid).toContain(path);
        expect(mocks.quote.mock.calls[0][0].observation.invalid).toBeUndefined();
        original.usageFields[path] = "1";
        expect((await revalueSavedTextEvidence("model", "channel/sku")).revalued).toBe(0);
    });
});
