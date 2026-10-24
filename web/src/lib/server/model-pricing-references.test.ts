import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    state: {
        candidates: [] as unknown[],
        officialVersions: [] as unknown[],
        salesVersions: [] as unknown[],
        priceBindings: [] as unknown[],
        billingActivations: {} as Record<string, { officialVersionId: string }>,
        textUsageRules: {} as Record<string, Array<{ officialVersionId: string }>>,
    },
    reservations: [] as unknown[],
    tasks: [] as unknown[],
    contracts: [] as unknown[],
    write: vi.fn(),
}));
vi.mock("@/lib/server/database", () => ({ getDatabaseProvider: () => "file" }));
vi.mock("@/lib/server/data-adapter", () => ({
    readJsonDataFile: vi.fn(async (file: string) => (file === "auth.json" ? { pricingReservations: mocks.reservations } : file === "generation-tasks.json" ? mocks.tasks : file.includes("contracts.json") ? { contracts: mocks.contracts } : mocks.state)),
    withJsonDataFileLock: vi.fn(async (_file: string, callback: () => Promise<unknown>) => callback()),
    withJsonDataFileLocks: vi.fn(async (_files: string[], callback: () => Promise<unknown>) => callback()),
    writeJsonDataFile: mocks.write,
}));

import { DEFAULT_OFFICIAL_PRICE_SOURCES, PricingConflictError, type PriceCandidate } from "@/lib/model-pricing";
import { bindReviewedPriceVersion, deletePriceCandidate, insertPriceCandidate, listApprovedPriceVersionsPage, listOfficialPriceReferences, listOfficialPriceReviewLinks, listPricingPage, revisePriceCandidate } from "./model-pricing-store";

const price = (id: string, logicalModelId: string, status: PriceCandidate["status"]): PriceCandidate => ({
    id,
    logicalModelId,
    status,
    manufacturer: "Alibaba Cloud",
    series: "Qwen",
    officialVersion: "qwen3-max",
    sku: "qwen3-max",
    tier: "paid",
    conditions: "华北 2；实时调用",
    sourceKind: "manual",
    sourceUrl: "https://help.aliyun.com/zh/model-studio/model-pricing",
    evidence: "官网分项",
    observedAt: "2026-09-28T00:00:00Z",
    createdAt: "2026-09-28T00:00:00Z",
    createdBy: "admin",
    items: [{ key: "inputTokens", unit: "token", per: "1000000", price: "2.5", currency: "CNY" }],
});

describe("official price references", () => {
    beforeEach(() => {
        mocks.state.candidates = [price("pending-qwen", "qwen-model", "pending"), price("rejected-qwen", "other", "rejected")];
        mocks.state.officialVersions = [{ ...price("approved-qwen", "approved-model", "approved"), candidateId: "old", publishedAt: "2026-09-27T00:00:00Z", reviewedBy: "reviewer" }];
        mocks.state.salesVersions = [];
        mocks.state.priceBindings = [];
        mocks.state.billingActivations = {};
        mocks.state.textUsageRules = {};
        mocks.reservations = [];
        mocks.tasks = [];
        mocks.contracts = [];
        mocks.write.mockClear();
    });

    it("keeps series, versions and matching review states distinct", async () => {
        const result = await listOfficialPriceReferences("Alibaba Cloud", "Qwen", "qwen3-max");
        expect(result.series).toEqual(["Qwen"]);
        expect(result.versions).toEqual(["qwen3-max"]);
        expect(result.pending.map((item) => item.id)).toEqual(["pending-qwen"]);
        expect(result.approved.map((item) => item.id)).toEqual(["approved-qwen"]);
        expect((await listOfficialPriceReferences("Google", "Qwen", "qwen3-max")).approved).toEqual([]);
    });

    it("pages only ownerless prices for one manufacturer, capability and SKU search", async () => {
        mocks.state.officialVersions = [
            { ...price("openai-text", "", "approved"), manufacturer: "OpenAI", capability: "text", sku: "gpt-4o", publishedAt: "2026-10-20T00:00:00Z" },
            { ...price("openai-image", "", "approved"), manufacturer: "OpenAI", capability: "image", sku: "gpt-image", publishedAt: "2026-10-20T00:00:00Z" },
            { ...price("owned", "logical", "approved"), manufacturer: "OpenAI", capability: "text", sku: "gpt-4o", publishedAt: "2026-10-20T00:00:00Z" },
        ];
        const result = await listApprovedPriceVersionsPage(1, { ownerless: true, manufacturer: "OpenAI", capability: "text", skuQuery: "4O" });
        expect(result.total).toBe(1);
        expect(result.items.map((item) => item.id)).toEqual(["openai-text"]);
    });

    it("rejects a second pending candidate for the same model, ID, tier and conditions", async () => {
        await expect(insertPriceCandidate(price("duplicate", "qwen-model", "pending"))).rejects.toBeInstanceOf(PricingConflictError);
        expect(mocks.write).not.toHaveBeenCalled();
    });

    it("allows distinct OpenAI processing tiers for one model and price condition", async () => {
        mocks.state.candidates = [{ ...price("batch", "gpt-image-2", "pending"), manufacturer: "OpenAI", processingTier: "batch" }];
        await expect(insertPriceCandidate({ ...price("standard", "gpt-image-2", "pending"), manufacturer: "OpenAI", processingTier: "standard" })).resolves.toBeUndefined();
        expect(mocks.write).toHaveBeenCalledOnce();
    });

    it("links an approved unbound SKU as a separate immutable model version", async () => {
        const source = { ...price("unbound", "", "approved"), capability: "image" as const, candidateId: "candidate", publishedAt: "2026-09-29T00:00:00Z", reviewedBy: "reviewer" };
        mocks.state.officialVersions = [source];
        const linked = await bindReviewedPriceVersion(source, "seedream-model", "admin");
        expect(linked).toMatchObject({ logicalModelId: "seedream-model", linkedFromVersionId: source.id, linkedBy: "admin", items: source.items });
        expect(linked.id).not.toBe(source.id);
        const saved = mocks.write.mock.lastCall?.[1] as { officialVersions: typeof mocks.state.officialVersions };
        expect(saved.officialVersions).toEqual([source, linked]);
        mocks.state.officialVersions = saved.officialVersions;
        await expect(bindReviewedPriceVersion(source, "seedream-model", "admin")).rejects.toThrow("已关联");
        mocks.state.candidates = [price("candidate", "", "approved")];
        await expect(deletePriceCandidate("candidate", null)).rejects.toThrow("已关联逻辑模型");
    });

    it("resubmits a rejected candidate in place and rejects stale edits", async () => {
        const revised = await revisePriceCandidate("rejected-qwen", null, (existing) => ({ ...existing, status: "pending", revision: "new-revision", items: [{ ...existing.items[0], price: "3" }] }));
        expect(revised).toMatchObject({ id: "rejected-qwen", status: "pending", revision: "new-revision", items: [{ price: "3" }] });
        expect(mocks.write).toHaveBeenCalledWith("model-pricing.json", expect.objectContaining({ candidates: expect.arrayContaining([revised]) }));
        await expect(revisePriceCandidate("rejected-qwen", "stale", (existing) => existing)).rejects.toThrow("刷新");
    });

    it("reopens or deletes an unbound approved price but protects published references", async () => {
        const approved = { ...price("approved", "approved-model", "approved"), approvedVersionId: "official" };
        const version = { ...approved, id: "official", candidateId: "approved", publishedAt: approved.createdAt, reviewedBy: "admin" };
        mocks.state.candidates = [approved];
        mocks.state.officialVersions = [version];
        const revised = await revisePriceCandidate("approved", null, (existing) => ({ ...existing, status: "pending", approvedVersionId: undefined, revision: "next" }));
        expect(revised.id).toBe("approved");
        expect(mocks.write).toHaveBeenCalledWith("model-pricing.json", expect.objectContaining({ officialVersions: [] }));
        mocks.state.salesVersions = [{ priceVersionIds: { "approved-model": "official" } }];
        await expect(revisePriceCandidate("approved", null, (existing) => ({ ...existing, status: "pending" }))).rejects.toThrow("销售版本引用");
        await expect(deletePriceCandidate("approved", null)).rejects.toThrow("销售版本引用");
        mocks.state.salesVersions = [];
        await deletePriceCandidate("approved", null);
        expect(mocks.write).toHaveBeenLastCalledWith("model-pricing.json", expect.objectContaining({ candidates: [], officialVersions: [] }));
    });

    it("preserves historical sales references, usage, contracts and activation records when deleting an approved price", async () => {
        const approved = { ...price("approved", "approved-model", "approved"), approvedVersionId: "official" };
        mocks.state.candidates = [approved];
        mocks.state.officialVersions = [{ ...approved, id: "official", candidateId: "approved", publishedAt: approved.createdAt, reviewedBy: "admin" }];
        mocks.state.salesVersions = [
            { id: "old-sale", priceVersionIds: { "approved-model": "official" } },
            { id: "current-sale", priceVersionIds: { "approved-model": "standard" } },
        ];
        await expect(deletePriceCandidate("approved", null)).rejects.toThrow("销售版本引用");
        expect(mocks.write).not.toHaveBeenCalled();
        mocks.state.salesVersions = [];
        mocks.state.textUsageRules = { "approved-model/official": [{ officialVersionId: "official" }] };
        await expect(revisePriceCandidate("approved", null, (existing) => existing)).rejects.toThrow("文本用量规则");
        await expect(deletePriceCandidate("approved", null)).rejects.toThrow("文本用量规则");
        mocks.state.textUsageRules = {};
        mocks.reservations = [{ frozen: { version: { id: "official" } } }];
        await expect(deletePriceCandidate("approved", null)).rejects.toThrow("真实按量调用");
        mocks.reservations = [];
        mocks.tasks = [{ payload: { billingMode: "official-usage", pricingSnapshot: { officialVersionId: "official" } } }];
        await expect(deletePriceCandidate("approved", null)).rejects.toThrow("真实按量调用");
        mocks.tasks = [{ payload: { billingMode: "fixed-points", pricingSnapshot: { officialVersionId: "official" } } }];
        mocks.contracts = [{ officialVersionId: "official" }, { officialVersionId: "standard" }];
        mocks.state.billingActivations = { "approved-model": { officialVersionId: "official" }, other: { officialVersionId: "standard" } };
        await expect(deletePriceCandidate("approved", null)).rejects.toThrow("按量激活记录");
        mocks.state.billingActivations = { other: { officialVersionId: "standard" } };
        await expect(deletePriceCandidate("approved", null)).rejects.toThrow("计费契约");
        mocks.contracts = [{ officialVersionId: "standard" }];
        await deletePriceCandidate("approved", null);
        expect(mocks.write).toHaveBeenCalledOnce();
        expect(mocks.write).toHaveBeenCalledWith("model-pricing.json", expect.objectContaining({ candidates: [], officialVersions: [], billingActivations: { other: { officialVersionId: "standard" } }, salesVersions: [] }));
    });

    it("preserves official prices referenced by independent sales or binding history", async () => {
        const approved = { ...price("approved", "", "approved"), approvedVersionId: "official" };
        mocks.state.candidates = [approved];
        mocks.state.officialVersions = [{ ...approved, id: "official", candidateId: "approved", publishedAt: approved.createdAt, reviewedBy: "admin" }];
        mocks.state.salesVersions = [{ priceVersionIds: {}, selectedPriceBindings: [{ logicalModelId: "logical", scope: "text:generation:standard", bindingId: "selection", bindingRevision: "revision", officialVersionId: "official" }] }];
        await expect(revisePriceCandidate("approved", null, (existing) => existing)).rejects.toThrow("独立选价或销售引用");
        await expect(deletePriceCandidate("approved", null)).rejects.toThrow("独立选价或销售引用");
        mocks.state.salesVersions = [];
        mocks.state.priceBindings = [{ id: "selection", officialVersionId: "official", current: false }];
        await expect(revisePriceCandidate("approved", null, (existing) => existing)).rejects.toThrow("独立选价或销售引用");
        await expect(deletePriceCandidate("approved", null)).rejects.toThrow("独立选价或销售引用");
        expect(mocks.write).not.toHaveBeenCalled();
    });

    it("groups Qwen, Wan and HappyHorse under one Alibaba source", () => {
        expect(DEFAULT_OFFICIAL_PRICE_SOURCES.filter((item) => item.manufacturer === "Alibaba Cloud")).toHaveLength(1);
        expect(DEFAULT_OFFICIAL_PRICE_SOURCES.filter((item) => item.manufacturer === "ByteDance / Volcengine")).toHaveLength(1);
        expect(DEFAULT_OFFICIAL_PRICE_SOURCES.find((item) => item.manufacturer === "ByteDance / Volcengine")?.url).toBe("https://docs.byteplus.com/en/docs/modelark/model-pricing");
    });

    it("offers the current vendor link and non-rejected historical evidence without pagination", async () => {
        const alternate = "https://help.aliyun.com/zh/model-studio/qwen-pricing";
        mocks.state.candidates = [
            { ...price("pending-qwen", "qwen-model", "pending"), sourceUrl: alternate },
            { ...price("rejected-qwen", "other", "rejected"), sourceUrl: "https://example.com/rejected" },
        ];
        const links = await listOfficialPriceReviewLinks("Alibaba Cloud");
        expect(links.map((item) => item.url)).toEqual(["https://www.alibabacloud.com/help/en/model-studio/model-pricing", "https://help.aliyun.com/zh/model-studio/model-pricing", alternate]);
        expect((await listOfficialPriceReviewLinks("Zhipu")).map((item) => item.url)).toEqual(["https://docs.z.ai/guides/overview/pricing"]);
        expect((await listOfficialPriceReviewLinks("MiniMax")).map((item) => item.url)).toEqual(["https://platform.minimax.io/docs/pricing/overview"]);
        expect((await listOfficialPriceReviewLinks("Kuaishou / Kling")).map((item) => item.url)).toEqual(["https://kling.ai/document-api/pricing/base/video"]);
        expect((await listOfficialPriceReviewLinks("Shengshu / Vidu")).map((item) => item.url)).toEqual(["https://platform.vidu.com/pricing"]);
        expect((await listOfficialPriceReviewLinks("ByteDance / Volcengine")).map((item) => item.url)).toContain("https://ai.byteplus.com/ark/region:ap-southeast-1/docs/model-pricing");
        expect(await listOfficialPriceReviewLinks("Missing manufacturer")).toEqual([]);
    });

    it("limits model choices to candidates from the selected manufacturer", async () => {
        mocks.state.candidates = [price("alibaba", "qwen-model", "pending"), { ...price("xai", "grok-model", "pending"), manufacturer: "xAI" }];
        expect((await listPricingPage("grok-model", 1, 1)).candidateModelIds).toEqual(["qwen-model", "grok-model"]);
        const filtered = await listPricingPage("grok-model", 1, 1, { manufacturer: "xAI" });
        expect(filtered.candidateModelIds).toEqual(["grok-model"]);
        expect(filtered.candidates.map((item) => item.logicalModelId)).toEqual(["grok-model"]);
    });
});
