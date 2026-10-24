import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ settings: vi.fn(), versions: vi.fn(), save: vi.fn(), list: vi.fn(), binding: vi.fn() }));
vi.mock("@/lib/auth/store", () => ({ getFreshAuthSettings: mocks.settings }));
vi.mock("./model-pricing-store", () => ({ getOfficialVersionsByIds: mocks.versions }));
vi.mock("./model-pricing-video-contract-store", () => ({ saveVideoPriceContract: mocks.save, listVideoPriceContracts: mocks.list }));
vi.mock("./model-price-binding-store", () => ({ getCurrentModelPriceBinding: mocks.binding }));
import { getVideoPriceContractHistory, getVideoPriceContractOptions, reviewVideoPriceContract } from "./model-pricing-video-contract-service";

const version = {
    id: "approved",
    logicalModelId: "logical",
    sku: "MiniMax-H3",
    tier: "paid",
    publishedAt: "2026-10-01T00:00:00Z",
    reviewedBy: "price-reviewer",
    items: ["in768", "out768", "in2k", "out2k", "images", "inputAudioSeconds"].map((key) => ({ key, unit: key === "images" ? "image" : "second", price: key === "inputAudioSeconds" ? "0" : "0.0553", per: "1", currency: "USD" })),
};
const contract = {
    channelId: "channel",
    requestedModel: "MiniMax-H3",
    protocol: "minimax-video-v2",
    scope: "global-standard-minimax-h3-generation",
    resolutionItems: { "768P": { inputSeconds: "in768", outputSeconds: "out768" }, "2K": { inputSeconds: "in2k", outputSeconds: "out2k" } },
    inputImageItem: "images",
    inputImagePricing: "all-at-standard-rate",
    inputAudioItem: "inputAudioSeconds",
    evidence: "fixture normal paid rates",
};
const settings = {
    logicalModels: [{ id: "logical", enabled: true, capability: "video", bindings: [{ channelId: "channel", upstreamModel: "MiniMax-H3", enabled: true }] }],
    systemChannels: [{ id: "channel", name: "fixture", enabled: true, apiKey: "private-key", baseUrl: "https://private.example.com", advancedConfig: { protocol: "minimax" } }],
};
describe("video price contract review", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.versions.mockResolvedValue([version]);
        mocks.settings.mockResolvedValue(settings);
        mocks.save.mockImplementation(async (value) => ({ ...value, id: "saved", current: true }));
        mocks.list.mockResolvedValue([]);
    });
    it("reads the exact version, returns only safe eligible bindings and preserves actual reviewer identity", async () => {
        const options = await getVideoPriceContractOptions("approved");
        expect(options).toMatchObject({ bindings: [{ channelId: "channel", requestedModel: "MiniMax-H3" }], resolutions: ["768P", "2K"] });
        expect(JSON.stringify(options)).not.toContain("private");
        expect(mocks.versions).toHaveBeenCalledWith(["approved"]);
        expect(await reviewVideoPriceContract("approved", { ...contract, reviewedBy: "forged", reviewedAt: "old", officialVersionId: "forged" }, "previous", "billing-admin")).toMatchObject({
            reviewedBy: "billing-admin",
            officialVersionId: "approved",
            inputImagePricing: "all-at-standard-rate",
            inputAudioItem: "inputAudioSeconds",
        });
        expect(mocks.save).toHaveBeenCalledWith(expect.anything(), "previous");
        await getVideoPriceContractHistory("approved", "channel", "MiniMax-H3");
        expect(mocks.list).toHaveBeenCalledWith("approved", "channel", "MiniMax-H3");
        await expect(getVideoPriceContractHistory("approved", "", "MiniMax-H3")).rejects.toThrow("请选择");
    });
    it("reviews a shared video price only for its active model selection", async () => {
        mocks.versions.mockResolvedValue([{ ...version, logicalModelId: "", manufacturer: "Fixture", capability: "video" }]);
        mocks.settings.mockResolvedValue({ ...settings, logicalModels: [{ ...settings.logicalModels[0], id: "MiniMax-H3", manufacturer: "Fixture" }] });
        mocks.binding.mockResolvedValue({ status: "active", current: true, officialVersionId: "approved" });
        await expect(getVideoPriceContractOptions("approved")).rejects.toThrow("逻辑模型");
        expect((await getVideoPriceContractOptions("approved", "MiniMax-H3")).bindings).toHaveLength(1);
        expect(await reviewVideoPriceContract("approved", contract, null, "admin", "MiniMax-H3")).toMatchObject({ id: "saved", officialVersionId: "approved" });
        mocks.binding.mockResolvedValue({ status: "revoked", current: true, officialVersionId: null });
        await expect(reviewVideoPriceContract("approved", contract, null, "admin", "MiniMax-H3")).rejects.toThrow("选价绑定");
    });
    it("rejects disabled identities, changed protocol overrides and wrong capability without saving", async () => {
        for (const changed of [
            { ...settings, systemChannels: [{ ...settings.systemChannels[0], enabled: false }] },
            { ...settings, logicalModels: [{ ...settings.logicalModels[0], enabled: false }] },
            { ...settings, logicalModels: [{ ...settings.logicalModels[0], capability: "image" }] },
            { ...settings, logicalModels: [{ ...settings.logicalModels[0], bindings: [{ ...settings.logicalModels[0].bindings[0], enabled: false }] }] },
            { ...settings, logicalModels: [{ ...settings.logicalModels[0], bindings: [{ ...settings.logicalModels[0].bindings[0], upstreamModel: "MiniMax-H3-Max" }] }] },
            { ...settings, systemChannels: [{ ...settings.systemChannels[0], advancedConfig: { protocol: "minimax", modelConfigs: { "minimax-h3": { protocol: "openai" } } } }] },
        ]) {
            mocks.settings.mockResolvedValue(changed);
            expect((await getVideoPriceContractOptions("approved")).bindings).toEqual([]);
            await expect(reviewVideoPriceContract("approved", contract, null, "admin")).rejects.toThrow("绑定");
        }
        expect(mocks.save).not.toHaveBeenCalled();
    });
    it("rejects unknown versions, SKU mismatch, unpriced audio or supplier-free image rules", async () => {
        for (const patch of [{ inputImagePricing: "first-five-free" }, { inputAudioItem: "images" }, { requestedModel: "MiniMax-H3-Max" }, { resolutionItems: {} }])
            await expect(reviewVideoPriceContract("approved", { ...contract, ...patch }, null, "admin")).rejects.toThrow();
        mocks.versions.mockResolvedValue([]);
        await expect(getVideoPriceContractOptions("missing")).rejects.toThrow("不存在");
        await expect(getVideoPriceContractOptions("")).rejects.toThrow("请选择");
        expect(mocks.save).not.toHaveBeenCalled();
    });
    it.each(["MiniMax-Hailuo-2.3", "MiniMax-Hailuo-2.3-Fast"])("reviews independent %s tiers using fresh binding state", async (sku) => {
        const published = { ...version, sku, items: ["768P-6", "768P-10", "1080P-6"].map((key) => ({ key, unit: "video", price: "0.123", per: "1", currency: "USD" })) };
        const configured = { ...settings, logicalModels: [{ ...settings.logicalModels[0], bindings: [{ ...settings.logicalModels[0].bindings[0], upstreamModel: sku }] }] };
        const raw = {
            channelId: "channel",
            requestedModel: sku,
            protocol: "minimax-hailuo-v1",
            scope: "global-standard-minimax-hailuo-generation",
            tierItems: Object.fromEntries(published.items.map((item) => [item.key, item.key])),
            evidence: "synthetic V1 file proof",
            reviewedBy: "forged",
            reviewedAt: "old",
        };
        mocks.versions.mockResolvedValue([published]);
        mocks.settings.mockResolvedValue(configured);
        expect(await getVideoPriceContractOptions("approved")).toMatchObject({ protocol: "minimax-hailuo-v1", resolutions: [], tiers: ["768P-6", "768P-10", "1080P-6"], bindings: [{ requestedModel: sku }] });
        const reviewed = await reviewVideoPriceContract("approved", raw, null, "actual-admin");
        expect(reviewed).toMatchObject({ protocol: "minimax-hailuo-v1", reviewedBy: "actual-admin", officialVersionId: "approved", tierItems: raw.tierItems });
        expect(reviewed.reviewedAt).not.toBe("old");
        expect(reviewed).not.toHaveProperty("resolutionItems");
        for (const patch of [{ protocol: "minimax-video-v2" }, { tierItems: { ...raw.tierItems, "1080P-6": "768P-6" } }, { tierItems: {} }]) await expect(reviewVideoPriceContract("approved", { ...raw, ...patch }, null, "admin")).rejects.toThrow();
        mocks.save.mockClear();
        for (const changed of [
            { ...configured, logicalModels: [{ ...configured.logicalModels[0], enabled: false }] },
            { ...configured, logicalModels: [{ ...configured.logicalModels[0], capability: "audio" }] },
            { ...configured, logicalModels: [{ ...configured.logicalModels[0], bindings: [{ ...configured.logicalModels[0].bindings[0], enabled: false }] }] },
            { ...configured, systemChannels: [{ ...settings.systemChannels[0], enabled: false }] },
            { ...configured, systemChannels: [{ ...settings.systemChannels[0], advancedConfig: { protocol: "custom" } }] },
            { ...configured, systemChannels: [{ ...settings.systemChannels[0], advancedConfig: { protocol: "minimax", modelConfigs: { [sku.toLowerCase()]: { protocol: "openai" } } } }] },
        ]) {
            mocks.settings.mockResolvedValue(changed);
            expect((await getVideoPriceContractOptions("approved")).bindings).toEqual([]);
            await expect(reviewVideoPriceContract("approved", raw, null, "admin")).rejects.toThrow("绑定");
        }
        expect(mocks.save).not.toHaveBeenCalled();
    });
});
