import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ settings: vi.fn(), versions: vi.fn(), save: vi.fn(), list: vi.fn(), binding: vi.fn() }));
vi.mock("@/lib/auth/store", () => ({ getFreshAuthSettings: mocks.settings }));
vi.mock("./model-pricing-store", () => ({ getOfficialVersionsByIds: mocks.versions }));
vi.mock("./model-pricing-token-contract-store", () => ({ saveFlatTextPriceContract: mocks.save, listFlatTextPriceContracts: mocks.list }));
vi.mock("./model-price-binding-store", () => ({ getCurrentModelPriceBinding: mocks.binding }));

import { getFlatTextPriceContractHistory, getFlatTextPriceContractOptions, reviewFlatTextPriceContract } from "./model-pricing-token-contract-service";

const version = {
    id: "approved",
    logicalModelId: "logical",
    tier: "paid",
    publishedAt: "2026-10-01T00:00:00Z",
    reviewedBy: "price-reviewer",
    items: [
        { key: "input", unit: "token", per: "1000000", price: "1", currency: "USD" },
        { key: "output", unit: "token", per: "1000000", price: "2", currency: "USD" },
    ],
};
const contract = {
    channelId: "channel",
    protocol: "openai-responses",
    requestedModel: "upstream",
    reportedModel: "upstream-2026",
    scope: "global-standard-text-flat",
    region: "global",
    serviceTier: "default",
    evidence: "官网计费分项与实际渠道响应已核对",
    itemMeters: { input: ["inputTokens", "cachedInputTokens", "cacheWriteTokens"], output: ["outputTokens"] },
    reservationEstimate: { method: "request-size-recent-output", sourceUrl: "https://example.com/text-estimate", evidence: "fixture reviewed estimate" },
};

describe("admin flat text price contract review", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.versions.mockResolvedValue([version]);
        mocks.settings.mockResolvedValue({ logicalModels: [{ id: "logical", enabled: true, capability: "text", bindings: [{ channelId: "channel", upstreamModel: "upstream", enabled: true }] }], systemChannels: [{ id: "channel", enabled: true }] });
        mocks.save.mockImplementation(async (value) => ({ ...value, id: "saved", current: true }));
        mocks.list.mockResolvedValue([]);
    });

    it("rejects official free components without publishing a metered contract", async () => {
        mocks.versions.mockResolvedValue([{ ...version, items: version.items.map((item) => ({ ...item, price: "0" })) }]);
        await expect(reviewFlatTextPriceContract("approved", contract, null, "billing-admin")).rejects.toThrow("常规付费单价");
        expect(mocks.save).not.toHaveBeenCalled();
    });

    it("requires reviewed text reservation evidence before publishing a new contract", async () => {
        const { reservationEstimate: _missing, ...withoutEstimate } = contract;
        await expect(reviewFlatTextPriceContract("approved", withoutEstimate, null, "billing-admin")).rejects.toThrow("预留估算");
        expect(mocks.save).not.toHaveBeenCalled();
    });

    it("saves only an active exact model/channel binding and stamps the reviewer", async () => {
        expect(await getFlatTextPriceContractOptions("approved")).toMatchObject({
            bindings: [{ channelId: "channel", requestedModel: "upstream", suggestedProtocol: "openai-chat" }],
            protocolMeters: { "openai-chat": ["inputTokens", "cachedInputTokens", "cacheWriteTokens", "outputTokens"] },
        });
        expect(await reviewFlatTextPriceContract("approved", contract, null, "billing-admin")).toMatchObject({ id: "saved", officialVersionId: "approved", reviewedBy: "billing-admin" });
        expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ requestedModel: "upstream", reviewedBy: "billing-admin" }), null);
        expect(await getFlatTextPriceContractHistory("approved", "channel", "upstream")).toMatchObject({ contracts: [] });
        expect(mocks.list).toHaveBeenCalledWith("approved", "channel", "upstream");
        await expect(reviewFlatTextPriceContract("approved", { ...contract, requestedModel: "alias" }, null, "billing-admin")).rejects.toThrow("渠道绑定");
        expect(mocks.save).toHaveBeenCalledTimes(1);
    });

    it("suggests the native Messages contract only for an explicit Anthropic channel", async () => {
        mocks.settings.mockResolvedValueOnce({
            logicalModels: [{ id: "logical", enabled: true, capability: "text", bindings: [{ channelId: "channel", upstreamModel: "upstream", enabled: true }] }],
            systemChannels: [{ id: "channel", name: "DataEyes Claude", enabled: true, apiFormat: "openai", advancedConfig: { protocol: "anthropic" } }],
        });
        expect((await getFlatTextPriceContractOptions("approved")).bindings[0]).toMatchObject({ suggestedProtocol: "anthropic-messages" });
    });

    it("rejects disabled channels, non-text models and incomplete meters", async () => {
        mocks.settings.mockResolvedValueOnce({ logicalModels: [{ id: "logical", enabled: true, capability: "text", bindings: [{ channelId: "channel", upstreamModel: "upstream", enabled: true }] }], systemChannels: [{ id: "channel", enabled: false }] });
        await expect(reviewFlatTextPriceContract("approved", contract, null, "billing-admin")).rejects.toThrow("渠道绑定");
        mocks.settings.mockResolvedValueOnce({ logicalModels: [{ id: "logical", enabled: true, capability: "image", bindings: [] }], systemChannels: [{ id: "channel", enabled: true }] });
        await expect(reviewFlatTextPriceContract("approved", contract, null, "billing-admin")).rejects.toThrow("文本逻辑模型");
        await expect(reviewFlatTextPriceContract("approved", { ...contract, itemMeters: { input: ["inputTokens"], output: ["outputTokens"] } }, null, "billing-admin")).rejects.toThrow("全部计量字段");
        expect(mocks.save).not.toHaveBeenCalled();
    });

    it("reviews a shared official version only for the explicitly selected model and its exact channel SKU", async () => {
        mocks.versions.mockResolvedValue([{ ...version, logicalModelId: "", manufacturer: "Fixture", capability: "text", sku: "upstream" }]);
        mocks.settings.mockResolvedValue({
            logicalModels: [{ id: "upstream", manufacturer: "Fixture", enabled: true, capability: "text", bindings: [{ channelId: "channel", upstreamModel: "upstream", enabled: true }] }],
            systemChannels: [{ id: "channel", enabled: true }],
        });
        mocks.binding.mockResolvedValue({ logicalModelId: "upstream", scope: "text:generation:standard", officialVersionId: version.id, status: "active", current: true });
        await expect(getFlatTextPriceContractOptions("approved")).rejects.toThrow("逻辑模型");
        expect((await getFlatTextPriceContractOptions("approved", "upstream")).bindings).toMatchObject([{ requestedModel: "upstream" }]);
        expect(await reviewFlatTextPriceContract("approved", contract, null, "billing-admin", "upstream")).toMatchObject({ id: "saved", officialVersionId: "approved" });
        mocks.binding.mockResolvedValueOnce({ logicalModelId: "upstream", scope: "text:generation:standard", officialVersionId: "other", status: "active", current: true });
        await expect(reviewFlatTextPriceContract("approved", contract, null, "billing-admin", "upstream")).rejects.toThrow("选价绑定");
        await expect(reviewFlatTextPriceContract("approved", { ...contract, requestedModel: "alias" }, null, "billing-admin", "upstream")).rejects.toThrow("渠道别名缺少");
    });

    it("requires reviewed identity for an ownerless price reached through a channel alias", async () => {
        mocks.versions.mockResolvedValue([{ ...version, logicalModelId: "", manufacturer: "Fixture", capability: "text", sku: "upstream" }]);
        mocks.settings.mockResolvedValue({
            logicalModels: [{ id: "upstream", manufacturer: "Fixture", enabled: true, capability: "text", bindings: [{ id: "live-binding", channelId: "channel", upstreamModel: "proxy-alias", enabled: true }] }],
            systemChannels: [{ id: "channel", enabled: true }],
        });
        mocks.binding.mockResolvedValue({ logicalModelId: "upstream", scope: "text:generation:standard", officialVersionId: version.id, status: "active", current: true });
        expect((await getFlatTextPriceContractOptions("approved", "upstream")).bindings).toMatchObject([{ channelBindingId: "live-binding", requestedModel: "proxy-alias" }]);
        const aliased = {
            ...contract,
            requestedModel: "proxy-alias",
            identity: { channelBindingId: "live-binding", officialSku: "upstream", operation: "generation", modelIdentity: "response-required", sourceUrl: "https://example.com/identity", evidence: "渠道请求与官网 SKU 已逐项核对" },
        };
        await expect(reviewFlatTextPriceContract("approved", { ...aliased, identity: { ...aliased.identity, channelBindingId: "old-binding" } }, null, "billing-admin", "upstream")).rejects.toThrow("渠道绑定");
        expect(await reviewFlatTextPriceContract("approved", aliased, null, "billing-admin", "upstream")).toMatchObject({ id: "saved", requestedModel: "proxy-alias", identity: { channelBindingId: "live-binding", officialSku: "upstream" } });
    });
});
