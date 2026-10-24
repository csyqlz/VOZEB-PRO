import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ settings: vi.fn(), page: vi.fn(), approved: vi.fn(), coverage: vi.fn(), versions: vi.fn(), rate: vi.fn(), sources: vi.fn(), marks: vi.fn(), batch: vi.fn() }));
vi.mock("@/lib/auth/store", () => ({ getFreshAuthSettings: mocks.settings, getPublicUsersByIds: vi.fn() }));
vi.mock("./model-pricing-store", () => ({
    listPricingPage: mocks.page,
    listApprovedPriceVersionsPage: mocks.approved,
    getModelPricingCoverage: mocks.coverage,
    getOfficialVersionsByIds: mocks.versions,
    getBusinessExchangeRate: mocks.rate,
    listOfficialPriceSources: mocks.sources,
    listPriceLifecycleMarks: mocks.marks,
    PRICING_PAGE_SIZE: 20,
}));
vi.mock("./model-pricing-admission-batch", () => ({ getModelPricingBatchStates: mocks.batch }));

import { getModelPricingOverview } from "./model-pricing-service";

describe("unpriced logical model directory", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.settings.mockResolvedValue({
            logicalModels: [
                { id: "seedance-new", name: "Seedance new", manufacturer: "ByteDance / Volcengine", series: "Seedance", capability: "video", enabled: true, bindings: [] },
                { id: "qwen-pending", name: "Qwen pending", manufacturer: "Alibaba Cloud", series: "Qwen", capability: "text", enabled: true, bindings: [] },
                { id: "wan-approved", name: "Wan approved", manufacturer: "Alibaba Cloud", series: "Wan", capability: "video", enabled: true, bindings: [] },
                { id: "gemini-published", name: "Gemini published", manufacturer: "Google", series: "Gemini", capability: "text", enabled: true, bindings: [] },
            ],
            systemChannels: [{ id: "channel-1", name: "Xuefeng Relay" }],
            entitlements: { plans: [] },
        });
        mocks.page.mockResolvedValue({ salesVersions: [{ priceVersionIds: { "gemini-published": "approved-gemini" } }] });
        mocks.approved.mockResolvedValue({ items: [], total: 0 });
        mocks.coverage.mockResolvedValue(
            new Map([
                ["qwen-pending", { pending: true, approved: false }],
                ["wan-approved", { pending: false, approved: true }],
                ["gemini-published", { pending: false, approved: true }],
            ]),
        );
        mocks.versions.mockResolvedValue([]);
        mocks.sources.mockResolvedValue([]);
        mocks.marks.mockResolvedValue([]);
        mocks.batch.mockImplementation(
            async (modelIds: string[], settings: { logicalModels: Array<{ id: string; enabled: boolean; bindings: Array<{ enabled: boolean }> }> }) =>
                new Map(
                    modelIds.map((id) => {
                        const model = settings.logicalModels.find((item) => item.id === id)!;
                        const pendingBindings = model.enabled === false ? null : model.bindings.filter((binding) => binding.enabled).length;
                        return [id, { billingMode: model.enabled === false ? "disabled" : "fixed", qualifiedBindings: 0, activeBindings: 0, pendingBindings, blocker: null }];
                    }),
                ),
        );
    });

    it("shows new synced models without candidates and separates review from sales publication", async () => {
        const result = await getModelPricingOverview();
        expect(result.unpricedModels.map(({ id, status }) => ({ id, status }))).toEqual([
            { id: "seedance-new", status: "no-candidate" },
            { id: "qwen-pending", status: "pending-review" },
            { id: "wan-approved", status: "sales-unpublished" },
        ]);
        expect(result.unpricedTotal).toBe(3);
        expect(result.workbenchTodo).toEqual({ pendingOfficialModels: 1, unpublishedSalesModels: 1, pendingBindings: 0, reviewNeededBindings: 0 });
        expect(result.workbenchModels.find((row) => row.id === "gemini-published")).toMatchObject({ publishedPrice: true, publishedScopes: [] });
        expect(mocks.coverage).toHaveBeenCalledWith(["seedance-new", "qwen-pending", "wan-approved", "gemini-published"]);
    });

    it("shows a model with published independent selection as priced while billing remains separate", async () => {
        const settings = await mocks.settings();
        settings.logicalModels.push({ id: "selected-published", name: "Selected", manufacturer: "OpenAI", series: "", capability: "text", enabled: true, bindings: [] });
        mocks.page.mockResolvedValue({ salesVersions: [{ priceVersionIds: {}, selectedPriceBindings: [{ logicalModelId: "selected-published", scope: "text:generation:standard", officialVersionId: "shared-price" }] }] });
        mocks.versions.mockResolvedValue([{ id: "shared-price", logicalModelId: "", manufacturer: "OpenAI", capability: "text" }]);
        mocks.coverage.mockResolvedValue(new Map([["selected-published", { pending: false, approved: true }]]));
        const result = await getModelPricingOverview();
        expect(result.workbenchModels).toContainEqual(expect.objectContaining({ id: "selected-published", status: "published", publishedPrice: true, publishedScopes: ["text:generation:standard"], approvedPrice: true, billingMode: "fixed" }));
        expect(result.unpricedModels.map((model) => model.id)).not.toContain("selected-published");
        expect(result.boundVersions).toContainEqual(expect.objectContaining({ id: "shared-price" }));
        expect(mocks.versions).toHaveBeenCalledWith(["shared-price"]);
    });

    it("keeps independent image operations distinct in the published workbench row", async () => {
        const settings = await mocks.settings();
        settings.logicalModels.push({ id: "image-scoped", name: "Image", manufacturer: "Fixture", series: "", capability: "image", enabled: true, bindings: [] });
        const generation = { logicalModelId: "image-scoped", scope: "image:generations:standard", officialVersionId: "generation-price" };
        const edit = { logicalModelId: "image-scoped", scope: "image:edits:standard", officialVersionId: "edit-price" };
        mocks.coverage.mockResolvedValue(new Map([["image-scoped", { pending: false, approved: true }]]));
        mocks.page.mockResolvedValue({ salesVersions: [{ priceVersionIds: {}, selectedPriceBindings: [generation] }] });
        expect((await getModelPricingOverview()).workbenchModels.find((row) => row.id === "image-scoped")).toMatchObject({ publishedPrice: true, publishedScopes: ["image:generations:standard"] });
        mocks.page.mockResolvedValue({ salesVersions: [{ priceVersionIds: {}, selectedPriceBindings: [generation, edit] }] });
        expect((await getModelPricingOverview()).workbenchModels.find((row) => row.id === "image-scoped")).toMatchObject({ publishedPrice: true, publishedScopes: ["image:generations:standard", "image:edits:standard"] });
    });

    it("filters name, vendor, series, capability and status on the server", async () => {
        const result = await getModelPricingOverview(undefined, 1, 1, {}, 1, { manufacturer: "Alibaba Cloud", series: "Wan", capability: "video", name: "approved", status: "sales-unpublished" });
        expect(result.unpricedModels.map((model) => model.id)).toEqual(["wan-approved"]);
        expect(mocks.coverage).toHaveBeenCalledWith(["seedance-new", "qwen-pending", "wan-approved", "gemini-published"]);
        expect(mocks.marks).toHaveBeenCalledWith(["seedance-new", "qwen-pending", "wan-approved", "gemini-published"]);
        expect((await getModelPricingOverview(undefined, 1, 1, {}, 1, { status: "pending-review" })).unpricedModels.map((model) => model.id)).toEqual(["qwen-pending"]);
        await expect(getModelPricingOverview(undefined, 1, 1, {}, 0)).rejects.toThrow("页码无效");
    });

    it("pages all enabled models separately from the unpriced list and can explicitly show closed models", async () => {
        const settings = await mocks.settings();
        settings.logicalModels.push({ id: "closed-model", name: "Closed", manufacturer: "OpenAI", series: "Closed", capability: "text", enabled: false, bindings: [] });
        const active = await getModelPricingOverview();
        expect(active.selectedModelId).toBe("");
        expect(active.workbenchTotal).toBe(4);
        expect(active.workbenchModels.map((item) => item.id)).not.toContain("closed-model");
        const closed = await getModelPricingOverview(undefined, 1, 1, {}, 1, {}, 1, { enabled: "disabled" });
        expect(closed.workbenchModels).toMatchObject([{ id: "closed-model", enabled: false }]);
        expect(closed.unpricedModels.map((item) => item.id)).not.toContain("closed-model");
    });

    it("searches bindings by channel name and upstream model", async () => {
        const settings = await mocks.settings();
        settings.logicalModels[0].bindings = [{ channelId: "channel-1", upstreamModel: "seedance-special", enabled: true }];
        expect((await getModelPricingOverview(undefined, 1, 1, {}, 1, {}, 1, { name: "xuefeng" })).workbenchModels.map((item) => item.id)).toEqual(["seedance-new"]);
        expect((await getModelPricingOverview(undefined, 1, 1, {}, 1, {}, 1, { name: "seedance-special" })).workbenchModels.map((item) => item.id)).toEqual(["seedance-new"]);
    });

    it("keeps filtered totals and page boundaries consistent across more than twenty models", async () => {
        const settings = await mocks.settings();
        settings.logicalModels = Array.from({ length: 25 }, (_, index) => ({
            id: `model-${String(index).padStart(2, "0")}`,
            name: `Model ${String(index).padStart(2, "0")}`,
            manufacturer: "Fixture",
            series: "Fixture",
            capability: "text",
            enabled: index !== 24,
            bindings: Array.from({ length: index === 23 ? 4 : 0 }, (_, binding) => ({ channelId: "channel-1", upstreamModel: `upstream-${binding}`, enabled: true })),
        }));
        const first = await getModelPricingOverview(undefined, 1, 1, {}, 1, {}, 1, { manufacturer: "Fixture" });
        const second = await getModelPricingOverview(undefined, 1, 1, {}, 1, {}, 2, { manufacturer: "Fixture" });
        expect(first.workbenchTotal).toBe(24);
        expect(first.workbenchModels).toHaveLength(20);
        expect(second.workbenchModels.map((item) => item.id)).toEqual(["model-20", "model-21", "model-22", "model-23"]);
        expect(second.workbenchModels.at(-1)?.bindingCount).toBe(4);
        expect(second.workbenchModels.at(-1)?.pendingBindings).toBe(4);
        expect(second.workbenchTodo.pendingBindings).toBe(4);
        expect((await getModelPricingOverview(undefined, 1, 1, {}, 1, {}, 1, { status: "channel-pending" })).workbenchModels.map((item) => item.id)).toEqual(["model-23"]);
        expect((await getModelPricingOverview(undefined, 1, 1, {}, 1, {}, 1, { enabled: "disabled" })).workbenchModels.map((item) => item.id)).toEqual(["model-24"]);
    });
});
