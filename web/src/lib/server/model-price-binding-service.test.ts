import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ settings: vi.fn(), versions: vi.fn(), sales: vi.fn(), save: vi.fn(), current: vi.fn() }));
vi.mock("@/lib/auth/store", () => ({ getFreshAuthSettings: mocks.settings }));
vi.mock("./model-pricing-store", () => ({ getOfficialVersionsByIds: mocks.versions, getCurrentSalesVersion: mocks.sales }));
vi.mock("./model-price-binding-store", () => ({ saveModelPriceBinding: mocks.save, getCurrentModelPriceBinding: mocks.current }));

import { bindSelectedOfficialPrice, getCurrentModelPriceSelection, previewSelectedOfficialPrice, revokeSelectedOfficialPrice } from "./model-price-binding-service";

beforeEach(() => {
    vi.clearAllMocks();
    mocks.settings.mockResolvedValue({ logicalModels: [{ id: "gpt-4o", manufacturer: "OpenAI", capability: "text" }] });
    mocks.versions.mockResolvedValue([
        { id: "price-1", logicalModelId: "", manufacturer: "OpenAI", capability: "text", sku: "gpt-4o", processingTier: "standard", items: [{ key: "inputTokens", unit: "token", per: "1000000", price: "1", currency: "USD" }] },
    ]);
    mocks.sales.mockResolvedValue({ id: "sales-1", priceVersionIds: {}, userPriceRules: [{ scope: "default", coefficient: "1" }], conversion: { cnyPerUsd: "7", pointsPerCny: "100" }, pointsPerCurrency: { USD: "700" }, usdPerCurrency: {} });
    mocks.save.mockImplementation(async (input) => input);
});

it("previews one shared original price for two models with separate published user coefficients", async () => {
    mocks.versions.mockResolvedValue([
        { id: "price-1", logicalModelId: "", manufacturer: "OpenAI", capability: "text", sku: "gpt-4o", processingTier: "standard", series: "", items: [{ key: "inputTokens", unit: "token", per: "1000000", price: "1", currency: "USD" }] },
    ]);
    mocks.current.mockImplementation(async (modelId) => ({ id: `binding-${modelId}`, revision: `revision-${modelId}`, capability: "text", operation: "generation", processingMode: "standard", officialVersionId: "price-1", status: "active" }));
    mocks.sales.mockResolvedValue({
        id: "sales-1",
        priceVersionIds: {},
        userPriceRules: [
            { scope: "model", modelId: "model-a", coefficient: "1" },
            { scope: "model", modelId: "model-b", coefficient: "2" },
        ],
        conversion: { cnyPerUsd: "7", pointsPerCny: "100" },
        pointsPerCurrency: { USD: "700" },
        usdPerCurrency: {},
    });
    const a = await previewSelectedOfficialPrice("model-a", "text:generation:standard", { inputTokens: "1000000" });
    const b = await previewSelectedOfficialPrice("model-b", "text:generation:standard", { inputTokens: "1000000" });
    expect(a).toMatchObject({ bindingId: "binding-model-a", previewOnly: true, quote: { officialVersionId: "price-1", modelId: "model-a", points: "700.00" } });
    expect(b).toMatchObject({ bindingId: "binding-model-b", previewOnly: true, quote: { officialVersionId: "price-1", modelId: "model-b", points: "1400.00" } });
    mocks.current.mockImplementation(async (modelId) =>
        modelId === "model-a"
            ? { status: "revoked", officialVersionId: null }
            : { id: "binding-model-b", revision: "revision-model-b", capability: "text", operation: "generation", processingMode: "standard", officialVersionId: "price-1", status: "active" },
    );
    await expect(previewSelectedOfficialPrice("model-a", "text:generation:standard", { inputTokens: "1000000" })).rejects.toThrow("没有当前有效选价");
    await expect(previewSelectedOfficialPrice("model-b", "text:generation:standard", { inputTokens: "1000000" })).resolves.toMatchObject({ quote: { points: "1400.00" } });
});

it("returns the current binding with its exact reviewed version for a reopened sales draft", async () => {
    mocks.current.mockResolvedValue({ id: "binding-one", officialVersionId: "price-1", status: "active" });
    expect(await getCurrentModelPriceSelection("gpt-4o", "text:generation:standard")).toMatchObject({ id: "binding-one", version: { id: "price-1" } });
    expect(mocks.versions).toHaveBeenCalledWith(["price-1"]);
    mocks.current.mockResolvedValue(undefined);
    expect(await getCurrentModelPriceSelection("gpt-4o", "text:generation:standard")).toBeNull();
});

it("never turns a price without executable USD lines into a zero-point preview", async () => {
    mocks.current.mockResolvedValue({ id: "binding", revision: "revision", capability: "text", operation: "generation", processingMode: "standard", officialVersionId: "price-1", status: "active" });
    mocks.versions.mockResolvedValueOnce([{ id: "price-1", logicalModelId: "", capability: "text", items: [] }]);
    await expect(previewSelectedOfficialPrice("gpt-4o", "text:generation:standard", {})).rejects.toThrow("无可执行价格分项");
    mocks.versions.mockResolvedValueOnce([{ id: "price-1", logicalModelId: "", capability: "text", items: [{ key: "inputTokens", unit: "token", per: "1000000", price: "1", currency: "CNY" }] }]);
    await expect(previewSelectedOfficialPrice("gpt-4o", "text:generation:standard", { inputTokens: "1" })).rejects.toThrow("仅支持国际站 USD");
});

it("previews the reviewed whole-request Standard tier and requires the selector fact", async () => {
    const line = (lineId: string, meter: string, price: string) => ({ lineId, meter, unit: "token", per: "1000000", price, currency: "USD", evidence: "official tier row" });
    mocks.current.mockResolvedValue({ id: "binding", revision: "revision", capability: "text", operation: "generation", processingMode: "standard", officialVersionId: "price-1", status: "active" });
    mocks.versions.mockResolvedValue([
        {
            id: "price-1",
            logicalModelId: "",
            capability: "text",
            manufacturer: "Fixture",
            series: "",
            items: [],
            textPriceSchedule: {
                declaredRange: { minInclusive: 0, maxInclusive: 256000 },
                meters: [
                    { meter: "inputTokens", unit: "token" },
                    { meter: "outputTokens", unit: "token" },
                ],
                groups: [
                    {
                        id: "short",
                        scopeKind: "generation",
                        selector: { processingMode: "standard", inputTotalTokens: { minInclusive: 0, maxInclusive: 128000 } },
                        lines: [line("short-input", "inputTokens", "1"), line("short-output", "outputTokens", "4")],
                    },
                    {
                        id: "long",
                        scopeKind: "generation",
                        selector: { processingMode: "standard", inputTotalTokens: { minInclusive: 128001, maxInclusive: 256000 } },
                        lines: [line("long-input", "inputTokens", "2"), line("long-output", "outputTokens", "4")],
                    },
                ],
            },
        },
    ]);
    await expect(previewSelectedOfficialPrice("model-a", "text:generation:standard", { inputTokens: "128001", outputTokens: "20000" })).rejects.toMatchObject({ reason: "usage_missing" });
    const result = await previewSelectedOfficialPrice("model-a", "text:generation:standard", { inputTokens: "128001", outputTokens: "20000" }, { inputTotalTokens: 128001 });
    expect(result).toMatchObject({
        selectedGroupId: "long",
        bindingRevision: "revision",
        previewOnly: true,
        quote: { officialVersionId: "price-1", points: "235.20", officialAmountUsd: "0.336002", lines: [expect.objectContaining({ lineId: "long-input" }), expect.objectContaining({ lineId: "long-output" })] },
    });
});

it("references the original reviewed version with evidence and a scope without cloning it", async () => {
    await expect(bindSelectedOfficialPrice("price-1", "gpt-4o", "generation", " Official SKU review ", null, "admin")).resolves.toMatchObject({ officialVersionId: "price-1", scope: "text:generation:standard", evidence: "Official SKU review" });
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ logicalModelId: "gpt-4o", officialVersionId: "price-1", status: "active" }), null);
    expect(mocks.versions).toHaveBeenCalledWith(["price-1"]);
});

it("binds a differently named logical model to an exact reviewed SKU without inferring identity from its name", async () => {
    mocks.settings.mockResolvedValue({ logicalModels: [{ id: "production-text", manufacturer: "OpenAI", capability: "text" }] });
    const binding = await bindSelectedOfficialPrice("price-1", "production-text", "generation", "Reviewed channel and official SKU evidence", null, "admin");
    expect(binding).toMatchObject({ logicalModelId: "production-text", officialVersionId: "price-1", evidence: "Reviewed channel and official SKU evidence", reviewedBy: "admin" });
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ logicalModelId: "production-text", officialVersionId: "price-1" }), null);
});

it("rejects model-owned copies, mismatched capabilities and missing review evidence", async () => {
    mocks.versions.mockResolvedValueOnce([{ id: "copy", logicalModelId: "gpt-4o" }]);
    await expect(bindSelectedOfficialPrice("copy", "gpt-4o", "generation", "review", null, "admin")).rejects.toThrow("独立审核");
    mocks.versions.mockResolvedValueOnce([{ id: "price-1", logicalModelId: "", manufacturer: "OpenAI", capability: "image", sku: "gpt-4o", items: [{ key: "inputTokens", unit: "token", per: "1000000", price: "1", currency: "USD" }] }]);
    await expect(bindSelectedOfficialPrice("price-1", "gpt-4o", "generation", "review", null, "admin")).rejects.toThrow("能力");
    await expect(bindSelectedOfficialPrice("price-1", "gpt-4o", "generation", " ", null, "admin")).rejects.toThrow("依据");
    await expect(bindSelectedOfficialPrice("price-1", "gpt-4o", "edits", "review", null, "admin")).rejects.toThrow("选价操作");
    expect(mocks.save).not.toHaveBeenCalled();
});

it("revokes only an active selection and retains the expected revision", async () => {
    mocks.current.mockResolvedValue({ status: "active", revision: "old", capability: "text", operation: "generation", processingMode: "standard" });
    await revokeSelectedOfficialPrice("gpt-4o", "text:generation:standard", "retired SKU", "old", "admin");
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ status: "revoked", officialVersionId: null, scope: "text:generation:standard" }), "old");
    mocks.current.mockResolvedValue({ status: "revoked" });
    await expect(revokeSelectedOfficialPrice("gpt-4o", "text:generation:standard", "again", "old", "admin")).rejects.toThrow("没有当前有效选价");
});
