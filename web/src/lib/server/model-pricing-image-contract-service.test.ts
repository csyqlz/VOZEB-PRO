import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ settings: vi.fn(), versions: vi.fn(), save: vi.fn(), list: vi.fn(), binding: vi.fn() }));
vi.mock("@/lib/auth/store", () => ({ getFreshAuthSettings: mocks.settings }));
vi.mock("./model-pricing-store", () => ({ getOfficialVersionsByIds: mocks.versions }));
vi.mock("./model-pricing-image-contract-store", () => ({ saveImagePriceContract: mocks.save, listImagePriceContracts: mocks.list }));
vi.mock("./model-price-binding-store", () => ({ getCurrentModelPriceBinding: mocks.binding }));
import { getImagePriceContractHistory, getImagePriceContractOptions, reviewImagePriceContract } from "./model-pricing-image-contract-service";

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
    requestedModel: "upstream",
    reportedModel: "upstream-v1",
    protocol: "openai-images",
    operation: "edits",
    modelIdentity: "reviewed-request",
    scope: "global-standard-direct-image-tokens",
    region: "global",
    evidence: "Fixture channel evidence",
    itemMeters: { input: ["inputTextTokens", "inputImageTokens"], output: ["outputImageTokens"] },
    zeroMeters: ["outputTextTokens"],
    holdEstimate: { meterQuantities: { inputTextTokens: "1000", inputImageTokens: "0", outputTextTokens: "0", outputImageTokens: "0" }, sourceUrl: "https://example.com/image-estimate", evidence: "fixture reviewed estimate" },
};
const { holdEstimate, ...contractWithoutHold } = contract;
const generationContract = { ...contractWithoutHold, operation: "generations", holdEstimates: [{ ...holdEstimate, quality: "low", size: "1024x1024" }] };
const settings = { logicalModels: [{ id: "logical", enabled: true, capability: "image", bindings: [{ channelId: "channel", upstreamModel: "upstream", enabled: true }] }], systemChannels: [{ id: "channel", name: "fixture", enabled: true }] };
describe("image price contract review", () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mocks.versions.mockResolvedValue([version]);
        mocks.settings.mockResolvedValue(settings);
        mocks.save.mockImplementation(async (value) => ({ ...value, id: "saved", current: true }));
        mocks.list.mockResolvedValue([]);
    });
    it("rejects official free components without publishing a metered contract", async () => {
        mocks.versions.mockResolvedValue([{ ...version, items: version.items.map((item) => ({ ...item, price: "0" })) }]);
        await expect(reviewImagePriceContract("approved", contract, null, "billing-admin")).rejects.toThrow("常规付费单价");
        expect(mocks.save).not.toHaveBeenCalled();
    });

    it("requires independently reviewed hold evidence before a direct Token contract can be saved", async () => {
        const { holdEstimates: _missing, ...withoutEstimate } = generationContract;
        await expect(reviewImagePriceContract("approved", withoutEstimate, null, "billing-admin")).rejects.toThrow("估算基准");
        expect(mocks.save).not.toHaveBeenCalled();
    });

    it("reviews a one-reference edit tier separately from generation", async () => {
        const edit = { ...contractWithoutHold, holdEstimates: [{ ...holdEstimate, referenceSize: "1024x1024", quality: "low", size: "1024x1024", meterQuantities: { ...holdEstimate.meterQuantities, inputImageTokens: "1024" } }] };
        expect(await reviewImagePriceContract("approved", edit, null, "billing-admin")).toMatchObject({ operation: "edits", holdEstimates: [{ referenceSize: "1024x1024" }] });
        expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ operation: "edits" }), null);
    });

    it("reads only the requested version and operation, accepts only exact enabled binding", async () => {
        expect(await getImagePriceContractOptions("approved")).toMatchObject({ bindings: [{ channelId: "channel", requestedModel: "upstream" }], meters: ["inputTextTokens", "inputImageTokens", "outputTextTokens", "outputImageTokens"] });
        expect(mocks.versions).toHaveBeenCalledWith(["approved"]);
        expect(await reviewImagePriceContract("approved", { ...generationContract, reviewedBy: "forged" }, null, "billing-admin")).toMatchObject({ reviewedBy: "billing-admin", officialVersionId: "approved" });
        expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ operation: "generations" }), null);
        await getImagePriceContractHistory("approved", "channel", "upstream", "edits");
        expect(mocks.list).toHaveBeenCalledWith("approved", "channel", "upstream", "edits");
        await expect(getImagePriceContractHistory("approved", "channel", "upstream", "responses")).rejects.toThrow("图片操作");
        await expect(reviewImagePriceContract("approved", { ...generationContract, requestedModel: "alias" }, null, "admin")).rejects.toThrow("渠道绑定");
        expect(mocks.save).toHaveBeenCalledTimes(1);
    });
    it("rejects disabled channel/model/binding, non-image models and unknown official version", async () => {
        for (const invalid of [
            { ...settings, systemChannels: [{ ...settings.systemChannels[0], enabled: false }] },
            { ...settings, logicalModels: [{ ...settings.logicalModels[0], enabled: false }] },
            { ...settings, logicalModels: [{ ...settings.logicalModels[0], capability: "text" }] },
            { ...settings, logicalModels: [{ ...settings.logicalModels[0], bindings: [{ ...settings.logicalModels[0].bindings[0], enabled: false }] }] },
        ]) {
            mocks.settings.mockResolvedValueOnce(invalid);
            await expect(reviewImagePriceContract("approved", generationContract, null, "admin")).rejects.toThrow();
        }
        mocks.versions.mockResolvedValue([]);
        await expect(getImagePriceContractOptions("missing")).rejects.toThrow("不存在");
        expect(mocks.save).not.toHaveBeenCalled();
    });
    it("reviews unit prices only for the current supported protocol and operation", async () => {
        const unitVersion = { ...version, sku: "flux-kontext-pro", items: [{ key: "image", unit: "image", per: "1", price: "0.04", currency: "USD" }] };
        const unit = {
            ...contract,
            requestedModel: "flux-kontext-pro",
            reportedModel: "flux-kontext-pro",
            scope: "global-standard-dataeyes-flux-image",
            itemMeters: {},
            zeroMeters: [],
            imageLimit: { maxImages: 1, sourceUrl: "https://example.com/fixture", evidence: "one image" },
        };
        const unitSettings = {
            ...settings,
            logicalModels: [{ ...settings.logicalModels[0], bindings: [{ channelId: "channel", upstreamModel: "flux-kontext-pro", enabled: true }] }],
            systemChannels: [{ ...settings.systemChannels[0], advancedConfig: { protocol: "dataeyes-flux" } }],
        };
        mocks.versions.mockResolvedValue([unitVersion]);
        mocks.settings.mockResolvedValue(unitSettings);
        expect(await getImagePriceContractOptions("approved")).toMatchObject({ bindings: [{ imageCountOperations: ["generations", "edits"] }] });
        expect(await reviewImagePriceContract("approved", unit, null, "admin")).toMatchObject({ scope: unit.scope, imageLimit: unit.imageLimit });
        mocks.settings.mockResolvedValue({ ...unitSettings, systemChannels: [{ ...unitSettings.systemChannels[0], advancedConfig: { ...unitSettings.systemChannels[0].advancedConfig, modelConfigs: { "flux-kontext-pro": { protocol: "openai" } } } }] });
        expect(await getImagePriceContractOptions("approved")).toMatchObject({ bindings: [{ imageCountOperations: [] }] });
        await expect(reviewImagePriceContract("approved", unit, null, "admin")).rejects.toThrow("渠道协议");
        expect(mocks.save).toHaveBeenCalledTimes(1);
    });
    it("keeps shared image price review scoped to the model's selected edit operation", async () => {
        mocks.versions.mockResolvedValue([{ ...version, logicalModelId: "", manufacturer: "Fixture", capability: "image", sku: "upstream" }]);
        mocks.settings.mockResolvedValue({ ...settings, logicalModels: [{ ...settings.logicalModels[0], id: "upstream", manufacturer: "Fixture" }] });
        mocks.binding.mockImplementation(async (_modelId: string, scope: string) => (scope === "image:edits:standard" ? { status: "active", current: true, officialVersionId: "approved" } : null));
        await expect(getImagePriceContractOptions("approved")).rejects.toThrow("逻辑模型");
        expect((await getImagePriceContractOptions("approved", "upstream")).bindings).toMatchObject([{ selectedOperations: ["edits"] }]);
        await expect(reviewImagePriceContract("approved", generationContract, null, "admin", "upstream")).rejects.toThrow("选价绑定");
        await expect(reviewImagePriceContract("approved", contract, null, "admin", "upstream")).rejects.toThrow("估算基准");
    });
    it("reviews an ownerless direct Images alias only against its current channel binding", async () => {
        mocks.versions.mockResolvedValue([{ ...version, logicalModelId: "", manufacturer: "Fixture", capability: "image", sku: "official-image" }]);
        mocks.settings.mockResolvedValue({
            logicalModels: [{ ...settings.logicalModels[0], id: "logical", manufacturer: "Fixture", bindings: [{ id: "image-binding", channelId: "channel", upstreamModel: "upstream", enabled: true }] }],
            systemChannels: [{ ...settings.systemChannels[0], apiFormat: "openai", advancedConfig: { protocol: "openai-images" } }],
        });
        mocks.binding.mockResolvedValue({ status: "active", current: true, officialVersionId: "approved" });
        expect((await getImagePriceContractOptions("approved", "logical")).bindings).toMatchObject([{ channelBindingId: "image-binding", requestedModel: "upstream", imageCountOperations: [] }]);
        await expect(reviewImagePriceContract("approved", generationContract, null, "admin", "logical")).rejects.toThrow("型号身份");
        const identity = { channelBindingId: "image-binding", officialSku: "official-image", operation: "generations", sourceUrl: "https://example.com/image-identity", evidence: "请求和响应型号映射已逐项核对" };
        expect(await reviewImagePriceContract("approved", { ...generationContract, identity }, null, "admin", "logical")).toMatchObject({ identity });
        await expect(reviewImagePriceContract("approved", { ...generationContract, identity: { ...identity, channelBindingId: "old-binding" } }, null, "admin", "logical")).rejects.toThrow("当前绑定");
        mocks.settings.mockResolvedValue({
            logicalModels: [{ ...settings.logicalModels[0], id: "logical", manufacturer: "Fixture", bindings: [{ id: "image-binding", channelId: "channel", upstreamModel: "upstream", enabled: true }] }],
            systemChannels: [{ ...settings.systemChannels[0], apiFormat: "openai", advancedConfig: { protocol: "dataeyes-flux" } }],
        });
        expect((await getImagePriceContractOptions("approved", "logical")).bindings).toEqual([]);
        await expect(reviewImagePriceContract("approved", { ...generationContract, identity }, null, "admin", "logical")).rejects.toThrow("直接 Images 协议");
    });
});
