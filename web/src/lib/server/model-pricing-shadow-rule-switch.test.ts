import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    policy: vi.fn(),
    published: vi.fn(),
    contracts: vi.fn(),
    activation: vi.fn(),
    latestRule: vi.fn(),
    ruleById: vi.fn(),
    mutate: vi.fn(),
}));
vi.mock("./model-pricing-shadow-store", () => ({ getShadowTextCall: async () => undefined, mutateShadowTextCall: mocks.mutate }));
vi.mock("./model-pricing-store", () => ({ getCurrentSalesVersion: mocks.policy }));
vi.mock("./model-pricing-published-price", () => ({ resolvePublishedModelPrice: mocks.published }));
vi.mock("./model-pricing-token-contract-store", () => ({ listFlatTextPriceContracts: mocks.contracts }));
vi.mock("./model-pricing-activation-store", () => ({ getModelPricingActivation: mocks.activation }));
vi.mock("./model-pricing-text-usage-rule-store", () => ({ getLatestTextUsageRule: mocks.latestRule, getTextUsageRuleById: mocks.ruleById }));
vi.mock("./model-pricing-request-bound", () => ({ prepareFlatTextRequestBound: () => ({ ready: true }), validateObservedRequestBound: () => [] }));
vi.mock("./model-pricing-text-request", () => ({ inspectFlatTextRequestContext: () => ({ inputModalities: ["text"], outputModalities: ["text"] }), onlyTextContent: () => true }));

import { beginShadowTextCall } from "./model-pricing-shadow-call";

describe("shadow text rule selection during a sales switch", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.policy.mockResolvedValue({ id: "new-sale" });
        mocks.published.mockResolvedValue({ version: { id: "new-official", items: [{ key: "inputTokens", unit: "token", per: "1000000", price: "1", currency: "USD" }] } });
        mocks.contracts.mockResolvedValue([{ id: "new-contract", current: true, protocol: "openai-chat" }]);
        mocks.activation.mockResolvedValue({ enabled: true, officialVersionId: "old-official", textUsageRuleId: "old-rule" });
        mocks.latestRule.mockResolvedValue({ id: "new-rule", modelId: "model", officialVersionId: "new-official" });
        mocks.ruleById.mockResolvedValue({ id: "old-rule", modelId: "model", officialVersionId: "old-official" });
        mocks.mutate.mockImplementation(async (_user, _request, build) => build(undefined).call);
    });

    it("freezes the new published version's rule while the old activation remains enabled", async () => {
        const call = await beginShadowTextCall({ userId: "user", requestId: "request", requestFingerprint: "fingerprint", modelId: "model", channelId: "channel", requestedModel: "sku", path: ["chat", "completions"], payload: { model: "sku" } });
        expect(call.frozen?.rules?.id).toBe("new-rule");
        expect(mocks.latestRule).toHaveBeenCalledWith("model", "new-official");
        expect(mocks.ruleById).not.toHaveBeenCalled();
    });
});
