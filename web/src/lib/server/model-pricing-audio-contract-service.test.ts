import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ settings: vi.fn(), versions: vi.fn(), save: vi.fn(), list: vi.fn(), binding: vi.fn() }));
vi.mock("@/lib/auth/store", () => ({ getFreshAuthSettings: mocks.settings }));
vi.mock("./model-pricing-store", () => ({ getOfficialVersionsByIds: mocks.versions }));
vi.mock("./model-pricing-audio-contract-store", () => ({ saveAudioPriceContract: mocks.save, listAudioPriceContracts: mocks.list }));
vi.mock("./model-price-binding-store", () => ({ getCurrentModelPriceBinding: mocks.binding }));
import { getAudioPriceContractHistory, getAudioPriceContractOptions, reviewAudioPriceContract } from "./model-pricing-audio-contract-service";

const sku = "gemini-2.5-flash-preview-tts";
const version = {
    id: "approved",
    logicalModelId: "logical",
    sku,
    tier: "paid",
    publishedAt: "2026-10-01T00:00:00Z",
    reviewedBy: "price-reviewer",
    items: ["text", "audio"].map((key) => ({ key, unit: "token", price: "0.0553", per: "1000000", currency: "USD" })),
};
const contract = {
    channelId: "channel",
    requestedModel: sku,
    reportedModel: sku,
    protocol: "gemini-tts",
    declaredProtocol: "gemini",
    scope: "global-standard-gemini-tts",
    modelIdentity: "reviewed-request",
    inputTextItem: "text",
    outputAudioItem: "audio",
    evidence: "fixture normal paid rates",
};
const settings = {
    logicalModels: [{ id: "logical", enabled: true, capability: "audio", bindings: [{ channelId: "channel", upstreamModel: sku, enabled: true }] }],
    systemChannels: [{ id: "channel", name: "fixture", enabled: true, apiKey: "private-key", baseUrl: "https://private.example.com", advancedConfig: { protocol: "gemini" } }],
};
describe("audio price contract review", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.versions.mockResolvedValue([version]);
        mocks.settings.mockResolvedValue(settings);
        mocks.save.mockImplementation(async (value) => ({ ...value, id: "saved", current: true }));
        mocks.list.mockResolvedValue([]);
    });
    it.each(["gemini", "dataeyes-gemini"])("uses actual reviewer and safe current %s binding data", async (protocol) => {
        mocks.settings.mockResolvedValue({ ...settings, systemChannels: [{ ...settings.systemChannels[0], advancedConfig: { protocol } }] });
        const options = await getAudioPriceContractOptions("approved");
        expect(options).toMatchObject({ bindings: [{ channelId: "channel", requestedModel: sku, declaredProtocol: protocol }], requestSourceUrl: `https://ai.google.dev/gemini-api/docs/models/${sku}` });
        expect(JSON.stringify(options)).not.toContain("private");
        expect(mocks.versions).toHaveBeenCalledWith(["approved"]);
        expect(await reviewAudioPriceContract("approved", { ...contract, declaredProtocol: protocol, reviewedBy: "forged", reviewedAt: "old", officialVersionId: "forged" }, "previous", "billing-admin")).toMatchObject({
            reviewedBy: "billing-admin",
            officialVersionId: "approved",
            declaredProtocol: protocol,
        });
        expect(mocks.save).toHaveBeenCalledWith(expect.anything(), "previous");
        await getAudioPriceContractHistory("approved", "channel", sku);
        expect(mocks.list).toHaveBeenCalledWith("approved", "channel", sku);
        await expect(getAudioPriceContractHistory("approved", "", sku)).rejects.toThrow("请选择");
    });
    it("reviews a shared audio price only for its active model selection", async () => {
        mocks.versions.mockResolvedValue([{ ...version, logicalModelId: "", manufacturer: "Fixture", capability: "audio" }]);
        mocks.settings.mockResolvedValue({ ...settings, logicalModels: [{ ...settings.logicalModels[0], id: sku, manufacturer: "Fixture" }] });
        mocks.binding.mockResolvedValue({ status: "active", current: true, officialVersionId: "approved" });
        await expect(getAudioPriceContractOptions("approved")).rejects.toThrow("逻辑模型");
        expect((await getAudioPriceContractOptions("approved", sku)).bindings).toHaveLength(1);
        expect(await reviewAudioPriceContract("approved", contract, null, "admin", sku)).toMatchObject({ id: "saved", officialVersionId: "approved" });
        mocks.binding.mockResolvedValue({ status: "revoked", current: true, officialVersionId: null });
        await expect(reviewAudioPriceContract("approved", contract, null, "admin", sku)).rejects.toThrow("选价绑定");
    });
    it("rechecks disabled identities, protocol overrides and capability when saving", async () => {
        expect((await getAudioPriceContractOptions("approved")).bindings).toHaveLength(1);
        for (const changed of [
            { ...settings, systemChannels: [{ ...settings.systemChannels[0], enabled: false }] },
            { ...settings, logicalModels: [{ ...settings.logicalModels[0], enabled: false }] },
            { ...settings, logicalModels: [{ ...settings.logicalModels[0], capability: "text" }] },
            { ...settings, logicalModels: [{ ...settings.logicalModels[0], bindings: [{ ...settings.logicalModels[0].bindings[0], enabled: false }] }] },
            { ...settings, logicalModels: [{ ...settings.logicalModels[0], bindings: [{ ...settings.logicalModels[0].bindings[0], upstreamModel: "alias" }] }] },
            { ...settings, systemChannels: [{ ...settings.systemChannels[0], advancedConfig: { protocol: "gemini", modelConfigs: { [sku]: { protocol: "openai" } } } }] },
        ]) {
            mocks.settings.mockResolvedValue(changed);
            expect((await getAudioPriceContractOptions("approved")).bindings).toEqual([]);
            await expect(reviewAudioPriceContract("approved", contract, null, "admin")).rejects.toThrow("绑定");
        }
        expect(mocks.save).not.toHaveBeenCalled();
    });
    it("rejects a stale declared protocol even when both protocols support audio", async () => {
        mocks.settings.mockResolvedValue({ ...settings, systemChannels: [{ ...settings.systemChannels[0], advancedConfig: { protocol: "gemini", modelConfigs: { [sku]: { protocol: "dataeyes-gemini" } } } }] });
        expect((await getAudioPriceContractOptions("approved")).bindings[0].declaredProtocol).toBe("dataeyes-gemini");
        await expect(reviewAudioPriceContract("approved", contract, null, "admin")).rejects.toThrow("绑定");
        expect(mocks.save).not.toHaveBeenCalled();
    });
    it("rejects free, extra, missing or incorrect rate rows without saving", async () => {
        for (const patch of [
            { tier: "free" },
            { items: version.items.slice(0, 1) },
            { items: [...version.items, { ...version.items[0], key: "cache" }] },
            { items: version.items.map((item) => ({ ...item, price: "0" })) },
            { items: version.items.map((item) => ({ ...item, unit: "second" })) },
            { sku: "gemini-tts-alias" },
        ]) {
            mocks.versions.mockResolvedValue([{ ...version, ...patch }]);
            await expect(reviewAudioPriceContract("approved", contract, null, "admin")).rejects.toThrow();
        }
        mocks.versions.mockResolvedValue([]);
        await expect(getAudioPriceContractOptions("missing")).rejects.toThrow("不存在");
        await expect(getAudioPriceContractOptions("")).rejects.toThrow("请选择");
        expect(mocks.save).not.toHaveBeenCalled();
    });
});

describe("OpenAI four-meter contract review", () => {
    const model = "gpt-audio-1.5";
    const meters = ["inputTextTokens", "inputAudioTokens", "outputTextTokens", "outputAudioTokens"];
    const official = { ...version, sku: model, items: meters.map((key) => ({ key, unit: "token", price: "0.0553", per: "1000000", currency: "USD" })) };
    const draft = {
        channelId: "channel",
        requestedModel: model,
        reportedModel: model,
        protocol: "openai-chat-audio",
        declaredProtocol: "openai",
        scope: "global-standard-openai-chat-audio-uncached",
        itemKeys: Object.fromEntries(meters.map((key) => [key, key])),
        evidence: "Synthetic ordinary four-meter rates",
    };
    const enabled = { logicalModels: [{ ...settings.logicalModels[0], bindings: [{ channelId: "channel", upstreamModel: model, enabled: true }] }], systemChannels: [{ ...settings.systemChannels[0], advancedConfig: { protocol: "openai" } }] };
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.versions.mockResolvedValue([official]);
        mocks.settings.mockResolvedValue(enabled);
        mocks.save.mockImplementation(async (value) => ({ ...value, id: "saved", current: true }));
        mocks.list.mockResolvedValue([]);
    });
    it("reviews four independent rows with the actual actor, version and timestamp", async () => {
        const options = await getAudioPriceContractOptions("approved");
        expect(options).toMatchObject({ bindings: [{ channelId: "channel", requestedModel: model, declaredProtocol: "openai" }], requestSourceUrl: "https://developers.openai.com/api/docs/models/gpt-audio-1.5" });
        expect(JSON.stringify(options)).not.toContain("private");
        const saved = await reviewAudioPriceContract("approved", { ...draft, reviewedBy: "forged", reviewedAt: "old", officialVersionId: "forged" }, "previous", "billing-admin");
        expect(saved).toMatchObject({ ...draft, officialVersionId: "approved", reviewedBy: "billing-admin" });
        expect(Number.isFinite(Date.parse(saved.reviewedAt))).toBe(true);
        expect(mocks.save).toHaveBeenCalledWith(expect.anything(), "previous");
        mocks.list.mockResolvedValue([saved]);
        expect((await getAudioPriceContractHistory("approved", "channel", model)).contracts).toEqual([saved]);
    });
    it("reviews an ownerless OpenAI price only through its native audio operation selection", async () => {
        mocks.versions.mockResolvedValue([{ ...official, logicalModelId: "", manufacturer: "OpenAI", capability: "audio" }]);
        mocks.settings.mockResolvedValue({ ...enabled, logicalModels: [{ ...enabled.logicalModels[0], id: model, manufacturer: "OpenAI" }] });
        mocks.binding.mockImplementation(async (_modelId: string, scope: string) => (scope === "audio:chat/completions:standard" ? { status: "active", current: true, officialVersionId: "approved" } : undefined));
        await expect(getAudioPriceContractOptions("approved")).rejects.toThrow("逻辑模型");
        expect((await getAudioPriceContractOptions("approved", model)).bindings).toHaveLength(1);
        expect(mocks.binding).toHaveBeenCalledWith(model, "audio:chat/completions:standard");
        expect(await reviewAudioPriceContract("approved", draft, null, "admin", model)).toMatchObject({ id: "saved", officialVersionId: "approved" });
        mocks.binding.mockResolvedValue(undefined);
        await expect(reviewAudioPriceContract("approved", draft, null, "admin", model)).rejects.toThrow("选价绑定");
    });
    it("rechecks exact enabled native binding and per-model overrides", async () => {
        for (const changed of [
            { ...enabled, systemChannels: [{ ...enabled.systemChannels[0], enabled: false }] },
            { ...enabled, logicalModels: [{ ...enabled.logicalModels[0], enabled: false }] },
            { ...enabled, logicalModels: [{ ...enabled.logicalModels[0], capability: "text" }] },
            { ...enabled, logicalModels: [{ ...enabled.logicalModels[0], bindings: [{ channelId: "channel", upstreamModel: model, enabled: false }] }] },
            { ...enabled, logicalModels: [{ ...enabled.logicalModels[0], bindings: [{ channelId: "channel", upstreamModel: "gpt-4o-audio-preview", enabled: true }] }] },
            { ...enabled, systemChannels: [{ ...enabled.systemChannels[0], advancedConfig: { protocol: "openai", modelConfigs: { [model]: { protocol: "gemini" } } } }] },
        ]) {
            mocks.settings.mockResolvedValue(changed);
            expect((await getAudioPriceContractOptions("approved")).bindings).toEqual([]);
            await expect(reviewAudioPriceContract("approved", draft, null, "admin")).rejects.toThrow("绑定");
        }
        expect(mocks.save).not.toHaveBeenCalled();
        mocks.settings.mockResolvedValue({ ...enabled, systemChannels: [{ ...enabled.systemChannels[0], advancedConfig: { protocol: "gemini", modelConfigs: { [model]: { protocol: "openai" } } } }] });
        expect((await getAudioPriceContractOptions("approved")).bindings).toHaveLength(1);
    });
    it("never stores free, missing, zero or borrowed prices and rejects old-model substitution", async () => {
        for (const patch of [
            { tier: "free" },
            { items: official.items.slice(0, 3) },
            { items: official.items.map((item) => (item.key === "inputAudioTokens" ? { ...item, price: "0" } : item)) },
            { items: [...official.items, { ...official.items[0], key: "cache" }] },
            { sku: "gpt-4o-audio-preview" },
        ]) {
            mocks.versions.mockResolvedValue([{ ...official, ...patch }]);
            await expect(reviewAudioPriceContract("approved", draft, null, "admin")).rejects.toThrow();
        }
        mocks.versions.mockResolvedValue([official]);
        for (const patch of [{ protocol: "gemini-tts" }, { reportedModel: "gpt-4o-audio-preview" }, { itemKeys: { ...draft.itemKeys, inputAudioTokens: "inputTextTokens" } }, { declaredProtocol: "dataeyes-gemini" }])
            await expect(reviewAudioPriceContract("approved", { ...draft, ...patch }, null, "admin")).rejects.toThrow();
        expect(mocks.save).not.toHaveBeenCalled();
    });
});
