import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ settings: vi.fn(), users: vi.fn(), sales: vi.fn(), versions: vi.fn(), rate: vi.fn(), binding: vi.fn(), insert: vi.fn(), approved: vi.fn() }));
vi.mock("@/lib/auth/store", () => ({ getFreshAuthSettings: mocks.settings, getPublicUsersByIds: mocks.users }));
vi.mock("./model-pricing-store", () => ({
    getCurrentSalesVersion: mocks.sales,
    getOfficialVersionsByIds: mocks.versions,
    getBusinessExchangeRate: mocks.rate,
    insertSalesVersion: mocks.insert,
    listApprovedPriceVersionsPage: mocks.approved,
    PRICING_PAGE_SIZE: 20,
}));
vi.mock("./model-price-binding-store", () => ({ getCurrentModelPriceBinding: mocks.binding }));

import { capturePublishedPricingIdentity, getIndependentOfficialPriceOptions, previewSalesPricing, publishSalesPricing, unbindModelSalesPrice } from "./model-pricing-service";
import { DEEPSEEK_TIME_PRICE_KEYS } from "@/lib/model-pricing";
import { resolvePublishedModelPrice } from "./model-pricing-published-price";

const reference = { logicalModelId: "gpt-4o", scope: "text:generation:standard", bindingId: "binding-one", bindingRevision: "revision-one", officialVersionId: "price-one" };
const draft = {
    priceVersionIds: {},
    selectedPriceBindings: [reference],
    userPriceRules: [{ scope: "default", coefficient: "1" }],
    conversion: { cnyPerUsd: "7", pointsPerCny: "100", observedAt: "2026-10-20T00:00:00Z", evidence: "Reviewed rate" },
};
const version = {
    id: "price-one",
    logicalModelId: "",
    capability: "text",
    manufacturer: "OpenAI",
    series: "",
    sku: "gpt-4o",
    tier: "paid",
    processingTier: "standard",
    items: [{ key: "inputTokens", unit: "token", per: "1000000", price: "1", currency: "USD" }],
};

beforeEach(() => {
    vi.clearAllMocks();
    mocks.settings.mockResolvedValue({ logicalModels: [{ id: "gpt-4o", manufacturer: "OpenAI", capability: "text" }] });
    mocks.users.mockResolvedValue([{ id: "user", planId: "plan" }]);
    mocks.sales.mockResolvedValue(undefined);
    mocks.versions.mockResolvedValue([version]);
    mocks.rate.mockResolvedValue({ cnyPerUsd: "7", observedAt: draft.conversion.observedAt, evidence: draft.conversion.evidence });
    mocks.binding.mockResolvedValue({ ...reference, id: reference.bindingId, revision: reference.bindingRevision, capability: "text", operation: "generation", processingMode: "standard", status: "active", current: true });
    mocks.insert.mockImplementation(async (input) => input);
    mocks.approved.mockResolvedValue({ items: [version], total: 1 });
});

it.each([
    { capability: "text" as const, operation: "generation" as const, scope: "text:generation:standard" },
    { capability: "image" as const, operation: "edits" as const, scope: "image:edits:standard" },
])("captures the published $scope selection and model coefficient for a task", async ({ capability, operation, scope }) => {
    const selected = { ...reference, scope };
    const publishedPrice = { ...version, capability, publishedAt: "2026-10-20T00:00:00Z", reviewedBy: "admin" };
    mocks.settings.mockResolvedValue({ logicalModels: [{ id: "gpt-4o", manufacturer: "OpenAI", capability }] });
    mocks.versions.mockResolvedValue([publishedPrice]);
    mocks.binding.mockResolvedValue({ ...selected, id: selected.bindingId, revision: selected.bindingRevision, capability, operation, processingMode: "standard", status: "active", current: true });
    mocks.sales.mockResolvedValue({
        ...draft,
        id: "sale",
        publishedAt: "2026-10-20T00:00:00Z",
        publishedBy: "admin",
        selectedPriceBindings: [selected],
        userPriceRules: [{ scope: "model", modelId: "gpt-4o", coefficient: "2" }],
        usdPerCurrency: { USD: "1" },
        pointsPerCurrency: { USD: "700" },
        rateEvidence: { USD: "fixture" },
    });
    expect(await capturePublishedPricingIdentity("user", "gpt-4o", { capability, operation })).toMatchObject({
        planId: "plan",
        modelId: "gpt-4o",
        salesVersionId: "sale",
        officialVersionId: publishedPrice.id,
        priceSelection: selected,
        userCoefficient: "2",
        userCoefficientScope: "model",
    });
    mocks.binding.mockResolvedValue({ ...(await mocks.binding()), revision: "changed" });
    expect(await capturePublishedPricingIdentity("user", "gpt-4o", { capability, operation })).toMatchObject({ officialVersionId: null });
});

it("rejects a legacy price when another operation of the same model has an independent selection", async () => {
    const legacyVersion = { ...version, logicalModelId: "gpt-4o", capability: "image" };
    const conflicted = {
        ...draft,
        id: "sale",
        priceVersionIds: { "gpt-4o": legacyVersion.id },
        selectedPriceBindings: [{ ...reference, scope: "image:edits:standard" }],
    };
    mocks.versions.mockResolvedValue([legacyVersion]);
    mocks.sales.mockResolvedValue(conflicted);
    expect(await resolvePublishedModelPrice("gpt-4o", "image", "generations", conflicted as never)).toBeUndefined();
    expect(await capturePublishedPricingIdentity("user", "gpt-4o", { capability: "image", operation: "generations" })).toMatchObject({ officialVersionId: null });
    expect(await capturePublishedPricingIdentity("user", "gpt-4o")).toMatchObject({ officialVersionId: null });
    expect(mocks.versions).not.toHaveBeenCalled();
    expect(await resolvePublishedModelPrice("gpt-4o", "image", "generations", { ...conflicted, selectedPriceBindings: [] } as never)).toMatchObject({ version: legacyVersion });
});

it("accepts only H3's documented free input-audio item in an independently selected video price", async () => {
    const modelId = "minimax-h3";
    const selected = { ...reference, logicalModelId: modelId, scope: "video:generation:standard" };
    const freeAudioVersion = {
        ...version,
        logicalModelId: "",
        capability: "video",
        manufacturer: "MiniMax",
        sku: "MiniMax-H3",
        publishedAt: "2026-10-20T00:00:00Z",
        reviewedBy: "admin",
        items: [
            { key: "768P-input", unit: "second", per: "1", price: "0.01", currency: "USD" },
            { key: "inputAudioSeconds", unit: "second", per: "1", price: "0", currency: "USD" },
        ],
    };
    mocks.settings.mockResolvedValue({ logicalModels: [{ id: modelId, manufacturer: "MiniMax", capability: "video" }] });
    mocks.binding.mockResolvedValue({ ...selected, id: selected.bindingId, revision: selected.bindingRevision, capability: "video", operation: "generation", processingMode: "standard", status: "active", current: true });
    mocks.sales.mockResolvedValue({ ...draft, id: "sale", publishedAt: "2026-10-20T00:00:00Z", publishedBy: "admin", selectedPriceBindings: [selected] });
    mocks.versions.mockResolvedValue([freeAudioVersion]);
    expect(await capturePublishedPricingIdentity("user", modelId, { capability: "video", operation: "generation" })).toMatchObject({ officialVersionId: freeAudioVersion.id, priceSelection: selected });
    mocks.versions.mockResolvedValue([{ ...freeAudioVersion, items: freeAudioVersion.items.map((item) => (item.key === "768P-input" ? { ...item, price: "0" } : item)) }]);
    expect(await capturePublishedPricingIdentity("user", modelId, { capability: "video", operation: "generation" })).toMatchObject({ officialVersionId: null });
});

it("lists ownerless reviewed prices by model manufacturer and capability, with explicit eligibility", async () => {
    const options = await getIndependentOfficialPriceOptions("gpt-4o", 1, "gpt");
    expect(mocks.approved).toHaveBeenCalledWith(1, { ownerless: true, manufacturer: "OpenAI", capability: "text", skuQuery: "gpt" });
    expect(options).toMatchObject({ total: 1, page: 1, pageSize: 20, items: [{ selectable: true, issues: [] }] });
    mocks.approved.mockResolvedValue({
        items: [
            { ...version, items: [{ ...version.items[0], currency: "CNY" }] },
            { ...version, sku: "gpt-4o-mini" },
        ],
        total: 2,
    });
    expect((await getIndependentOfficialPriceOptions("gpt-4o")).items.map((item) => item.selectable)).toEqual([false, true]);
    await expect(getIndependentOfficialPriceOptions("missing")).rejects.toThrow("逻辑模型");
});

it("previews and publishes an independent selection while preserving its reviewed revision", async () => {
    const preview = await previewSalesPricing(draft, "gpt-4o", { inputTokens: "1000000" }, reference.scope);
    expect(preview).toMatchObject({ selectedBinding: reference, quote: { officialVersionId: version.id, modelId: "gpt-4o", points: "700.00" }, currentSalesVersionId: null });
    const published = await publishSalesPricing(draft, null, preview.previewToken, "admin");
    expect(published).toMatchObject({ selectedPriceBindings: [reference], priceVersionIds: {}, publishedBy: "admin" });
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ selectedPriceBindings: [reference] }), null, true);
});

it("keeps an explicit independent-price release through preview and publication", async () => {
    const legacy = { ...version, id: "legacy-price", logicalModelId: "gpt-4o" };
    mocks.versions.mockResolvedValue([version, legacy]);
    mocks.sales.mockResolvedValue({ ...draft, id: "current-sale", publishedAt: "2026-10-20T00:00:00Z", publishedBy: "admin" });
    const releaseDraft = { ...draft, priceVersionIds: { "gpt-4o": legacy.id }, selectedPriceBindings: [] };
    const preview = await previewSalesPricing(releaseDraft, "gpt-4o", { inputTokens: "1000000" });
    expect(preview.policy.selectedPriceBindings).toEqual([]);
    const omitted = { ...preview.policy };
    delete omitted.selectedPriceBindings;
    expect((await previewSalesPricing(omitted, "gpt-4o", { inputTokens: "1000000" })).policy.selectedPriceBindings).toBeUndefined();
    await expect(publishSalesPricing(omitted, preview.currentSalesVersionId, preview.previewToken, "admin")).rejects.toThrow("显式保留或解除");
    const published = await publishSalesPricing(preview.policy, preview.currentSalesVersionId, preview.previewToken, "admin");
    expect(published.priceVersionIds).toEqual({ "gpt-4o": legacy.id });
    expect(published.selectedPriceBindings).toBeUndefined();
});

it("invalidates a sales preview when reviewed exchange-rate evidence changes", async () => {
    const preview = await previewSalesPricing(draft, "gpt-4o", { inputTokens: "1000000" }, reference.scope);
    mocks.rate.mockResolvedValue({ cnyPerUsd: "7", observedAt: draft.conversion.observedAt, evidence: "new review" });
    await expect(previewSalesPricing(draft, "gpt-4o", { inputTokens: "1000000" }, reference.scope)).rejects.toThrow("汇率已变化");
    await expect(publishSalesPricing(draft, null, preview.previewToken, "admin")).rejects.toThrow("汇率已变化");
    expect(mocks.insert).not.toHaveBeenCalled();
});

it("publishes and captures a reviewed SKU selected for a differently named logical model", async () => {
    const logicalModelId = "production-text";
    const selected = { ...reference, logicalModelId };
    mocks.settings.mockResolvedValue({ logicalModels: [{ id: logicalModelId, manufacturer: "OpenAI", capability: "text" }] });
    mocks.binding.mockResolvedValue({ ...selected, id: selected.bindingId, revision: selected.bindingRevision, capability: "text", operation: "generation", processingMode: "standard", status: "active", current: true });
    const selectedDraft = { ...draft, selectedPriceBindings: [selected] };
    const preview = await previewSalesPricing(selectedDraft, logicalModelId, { inputTokens: "1000000" }, selected.scope);
    expect(preview.quote).toMatchObject({ modelId: logicalModelId, officialVersionId: version.id, points: "700.00" });
    await publishSalesPricing(selectedDraft, null, preview.previewToken, "admin");
    mocks.sales.mockResolvedValue({ ...selectedDraft, id: "sale", publishedAt: "2026-10-20T00:00:00Z", publishedBy: "admin" });
    expect(await capturePublishedPricingIdentity("user", logicalModelId, { capability: "text", operation: "generation" })).toMatchObject({ officialVersionId: version.id, priceSelection: selected });
    mocks.binding.mockResolvedValue({ ...(await mocks.binding()), revision: "stale" });
    expect(await capturePublishedPricingIdentity("user", logicalModelId, { capability: "text", operation: "generation" })).toMatchObject({ officialVersionId: null });
});

it("previews and publishes the off-peak tier of a shared DeepSeek price", async () => {
    const logicalModelId = "deepseek-studio";
    const selected = { ...reference, logicalModelId };
    const deepSeekPrice = {
        ...version,
        manufacturer: "DeepSeek",
        sku: "deepseek-v3",
        items: [...DEEPSEEK_TIME_PRICE_KEYS.peak, ...DEEPSEEK_TIME_PRICE_KEYS.offPeak].map((key) => ({
            key,
            unit: "token",
            per: "1000000",
            currency: "USD",
            price: key.endsWith("OffPeak") ? "1" : "2",
        })),
    };
    const selectedDraft = { ...draft, selectedPriceBindings: [selected], deepSeekUtcWindowModels: [logicalModelId] };
    mocks.settings.mockResolvedValue({ logicalModels: [{ id: logicalModelId, manufacturer: "DeepSeek", capability: "text" }] });
    mocks.binding.mockResolvedValue({ ...selected, id: selected.bindingId, revision: selected.bindingRevision, capability: "text", operation: "generation", processingMode: "standard", status: "active", current: true });
    mocks.versions.mockResolvedValue([deepSeekPrice]);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T04:00:00Z"));
    try {
        const preview = await previewSalesPricing(selectedDraft, logicalModelId, { cacheHitInputTokensPeak: "30", cacheMissInputTokensPeak: "70", outputTokensPeak: "10" }, selected.scope);
        expect(preview).toMatchObject({ selectedBinding: selected, deepSeekTier: "offPeak", pricingAt: "2026-10-12T04:00:00.000Z", quote: { modelId: logicalModelId, exactPoints: "77/1000" } });
        expect(preview.quote.lines.filter((line) => line.quantity !== "0").map((line) => line.key)).toEqual(DEEPSEEK_TIME_PRICE_KEYS.offPeak);
        expect(await publishSalesPricing(selectedDraft, null, preview.previewToken, "admin")).toMatchObject({ selectedPriceBindings: [selected], deepSeekUtcWindowModels: [logicalModelId] });
    } finally {
        vi.useRealTimers();
    }
});

it("removes only the requested published scope without rewriting the shared official price", async () => {
    mocks.sales.mockResolvedValue({ id: "sale-one", priceVersionIds: {}, selectedPriceBindings: [reference, { ...reference, logicalModelId: "other", bindingId: "other-binding" }] });
    const next = await unbindModelSalesPrice("gpt-4o", "sale-one", "admin", reference.scope);
    expect(next.selectedPriceBindings).toEqual([{ ...reference, logicalModelId: "other", bindingId: "other-binding" }]);
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ priceVersionIds: {}, selectedPriceBindings: [{ ...reference, logicalModelId: "other", bindingId: "other-binding" }] }), "sale-one");
    await expect(unbindModelSalesPrice("gpt-4o", "stale", "admin", reference.scope)).rejects.toThrow("刷新");
});

it("previews the selected Standard text tier and refuses publication after a binding change", async () => {
    const line = (lineId: string, meter: string, price: string) => ({ lineId, meter, unit: "token", per: "1000000", price, currency: "USD", evidence: "Official row" });
    mocks.versions.mockResolvedValue([
        {
            ...version,
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
    await expect(previewSalesPricing(draft, "gpt-4o", { inputTokens: "128001", outputTokens: "20000" }, reference.scope)).rejects.toMatchObject({ reason: "usage_missing" });
    const preview = await previewSalesPricing(draft, "gpt-4o", { inputTotalTokens: 128001, inputTokens: "128001", outputTokens: "20000" }, reference.scope);
    expect(preview).toMatchObject({ selectedGroupId: "long", quote: { points: "235.20" } });
    expect(preview.quote.lines).toEqual(expect.arrayContaining([expect.objectContaining({ lineId: "long-input" }), expect.objectContaining({ lineId: "long-output" })]));
    mocks.binding.mockResolvedValue({ ...(await mocks.binding()), revision: "revision-two" });
    await expect(publishSalesPricing(draft, null, preview.previewToken, "admin")).rejects.toThrow("已变化");
    expect(mocks.insert).not.toHaveBeenCalled();
});
