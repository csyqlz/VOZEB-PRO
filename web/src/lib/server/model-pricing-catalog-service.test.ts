import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    list: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    usage: vi.fn(),
    sources: vi.fn(),
}));

vi.mock("./model-pricing-catalog-store", () => ({
    listOfficialPriceCatalog: mocks.list,
    insertOfficialPriceCatalog: mocks.insert,
    updateOfficialPriceCatalog: mocks.update,
    deleteOfficialPriceCatalog: mocks.remove,
    getOfficialPriceCatalogUsage: mocks.usage,
}));
vi.mock("./model-pricing-store", () => ({ listOfficialPriceSources: mocks.sources }));

import { createOfficialPriceCatalog, editOfficialPriceCatalog, getOfficialPriceCatalogImpact, removeOfficialPriceCatalog, resolveOfficialPriceCatalogLink } from "./model-pricing-catalog-service";
import type { OfficialPriceInput } from "@/lib/model-pricing";

beforeEach(() => {
    vi.clearAllMocks();
    mocks.sources.mockResolvedValue([{ manufacturer: "OpenAI", url: "https://example.com", updatedAt: null }]);
    mocks.list.mockResolvedValue([]);
    mocks.insert.mockImplementation(async (entry) => entry);
    mocks.update.mockImplementation(async (entry) => entry);
    mocks.usage.mockResolvedValue({ pending: 0, approved: 0, called: false });
});

it("edits a catalog entry using its current snapshot without touching an approved price", async () => {
    const current = {
        id: "series-1",
        manufacturer: "OpenAI",
        kind: "series",
        parentId: null,
        name: "GPT 6",
        capability: "text",
        sku: null,
        sourceUrl: "https://example.com/pricing",
        evidence: "官网证据",
        createdAt: "2026-10-17T00:00:00Z",
        createdBy: "admin",
    };
    mocks.list.mockResolvedValue([current]);
    const entry = await editOfficialPriceCatalog({ ...current, name: "GPT 6 series", expected: current }, "editor");
    expect(entry).toMatchObject({ id: current.id, name: "GPT 6 series", createdBy: "admin", updatedBy: "editor" });
    expect(mocks.update).toHaveBeenCalledWith(entry, current);
    await expect(editOfficialPriceCatalog({ ...current, name: "stale", expected: { ...current, evidence: "old" } }, "editor")).rejects.toThrow("已变化");
});

it("requires child versions to be removed before a series and checks the deletion snapshot", async () => {
    const series = { id: "series-1", manufacturer: "OpenAI", kind: "series", parentId: null, name: "GPT 6" };
    const version = { id: "version-1", manufacturer: "OpenAI", kind: "version", parentId: "series-1", name: "gpt-6" };
    mocks.list.mockResolvedValue([series, version]);
    await expect(removeOfficialPriceCatalog({ id: series.id, manufacturer: "OpenAI", expected: series })).rejects.toThrow("请先删除或调整");
    await removeOfficialPriceCatalog({ id: version.id, manufacturer: "OpenAI", expected: version });
    expect(mocks.remove).toHaveBeenCalledWith(version);
});

it("creates a source-backed series without changing official prices", async () => {
    const entry = await createOfficialPriceCatalog({ manufacturer: "OpenAI", kind: "series", name: "GPT", capability: "text", sourceUrl: "https://example.com/pricing", evidence: "官网标注 GPT 系列" }, "admin");
    expect(entry).toMatchObject({ manufacturer: "OpenAI", kind: "series", parentId: null, name: "GPT", capability: "text", sku: null, createdBy: "admin" });
    expect(mocks.insert).toHaveBeenCalledOnce();
});

it("accepts an exact model with optional series and checks any selected series", async () => {
    const series = { id: "series-1", manufacturer: "OpenAI", kind: "series", name: "GPT" };
    mocks.list.mockResolvedValue([series]);
    const entry = await createOfficialPriceCatalog({ manufacturer: "OpenAI", kind: "version", parentId: "series-1", name: "gpt-new", sku: "gpt-new", sourceUrl: "https://example.com/pricing", evidence: "官网列出型号" }, "admin");
    expect(entry).toMatchObject({ kind: "version", parentId: "series-1", sku: "gpt-new" });
    const ungrouped = await createOfficialPriceCatalog({ manufacturer: "OpenAI", kind: "version", name: "gpt-direct", capability: "text", sku: "gpt-direct", sourceUrl: "https://example.com/pricing", evidence: "官网列出型号" }, "admin");
    expect(ungrouped).toMatchObject({ kind: "version", parentId: null, capability: "text", sku: "gpt-direct" });
    await expect(createOfficialPriceCatalog({ manufacturer: "OpenAI", kind: "version", name: "bad", sku: "bad", sourceUrl: "https://example.com/pricing", evidence: "官网" }, "admin")).rejects.toThrow("适用能力");
    await expect(createOfficialPriceCatalog({ manufacturer: "OpenAI", kind: "version", parentId: "other", name: "wrong", sku: "wrong", sourceUrl: "https://example.com/pricing", evidence: "官网" }, "admin")).rejects.toThrow("所属系列不存在");
});

it("keeps the series capability stable when child models are already priced", async () => {
    const series = { id: "series", manufacturer: "OpenAI", kind: "series", parentId: null, name: "GPT", capability: "text", sku: null, sourceUrl: "https://example.com/pricing", evidence: "proof", createdAt: "2026-10-17T00:00:00Z", createdBy: "admin" };
    const version = { ...series, id: "version", kind: "version", parentId: series.id, capability: null, sku: "gpt-6" };
    mocks.list.mockResolvedValue([series, version]);
    mocks.usage.mockResolvedValue({ pending: 1, approved: 0, called: false });
    await expect(editOfficialPriceCatalog({ ...series, capability: "image", expected: series }, "editor")).rejects.toThrow("不能修改系列能力");
    expect(mocks.update).not.toHaveBeenCalled();
});

it("previews child and price references before a catalog action", async () => {
    const series = { id: "series", manufacturer: "OpenAI", kind: "series" };
    const version = { id: "version", manufacturer: "OpenAI", kind: "version", parentId: series.id };
    mocks.list.mockResolvedValue([series, version]);
    mocks.usage.mockResolvedValue({ pending: 1, approved: 2, called: true });
    expect(await getOfficialPriceCatalogImpact("OpenAI", version.id)).toEqual({ pending: 1, approved: 2, called: true, childVersions: 0 });
    expect(await getOfficialPriceCatalogImpact("OpenAI", series.id)).toMatchObject({ childVersions: 1 });
});

it("rejects unregistered manufacturers and non-HTTPS evidence links", async () => {
    await expect(createOfficialPriceCatalog({ manufacturer: "Other", kind: "series", name: "Model", capability: "text", sourceUrl: "https://example.com", evidence: "官网" }, "admin")).rejects.toThrow("先在官网来源链接中登记厂商");
    await expect(createOfficialPriceCatalog({ manufacturer: "OpenAI", kind: "series", name: "GPT", capability: "text", sourceUrl: "http://example.com", evidence: "官网" }, "admin")).rejects.toThrow("HTTPS");
    expect(mocks.insert).not.toHaveBeenCalled();
});

it("resolves the latest catalog display names by ID without changing the official SKU or prices", async () => {
    mocks.list.mockResolvedValue([
        { id: "series", manufacturer: "OpenAI", kind: "series", name: "GPT 6 Current", capability: "text" },
        { id: "version", manufacturer: "OpenAI", kind: "version", parentId: "series", name: "gpt-6-current", sku: "gpt-6" },
    ]);
    const input = { manufacturer: "OpenAI", catalogVersionId: "version", series: "GPT 6 Old", officialVersion: "gpt-6-old", sku: "gpt-6", items: [{ key: "inputTokens", price: "1", currency: "USD", per: "1000000", unit: "token" }] } as OfficialPriceInput;
    expect(await resolveOfficialPriceCatalogLink(input, "text")).toMatchObject({ series: "GPT 6 Current", officialVersion: "gpt-6-current", sku: "gpt-6", items: input.items });
    await expect(resolveOfficialPriceCatalogLink({ ...input, sku: "other" }, "text")).rejects.toThrow("重新选择");
    await expect(resolveOfficialPriceCatalogLink(input, "image")).rejects.toThrow("重新选择");
    expect(await resolveOfficialPriceCatalogLink({ ...input, catalogVersionId: undefined }, "image")).toMatchObject({ series: "GPT 6 Old", sku: "gpt-6" });
    mocks.list.mockResolvedValue([{ id: "direct", manufacturer: "OpenAI", kind: "version", parentId: null, capability: "text", name: "gpt-direct", sku: "gpt-6" }]);
    expect(await resolveOfficialPriceCatalogLink({ ...input, catalogVersionId: "direct" }, "text")).toMatchObject({ series: "", officialVersion: "gpt-direct", sku: "gpt-6", items: input.items });
});
