import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import type { OfficialPriceCatalogEntry, OfficialPriceVersion } from "@/lib/model-pricing";
import { writeJsonDataFile } from "./data-adapter";
import { deleteOfficialPriceCatalog, insertOfficialPriceCatalog, listOfficialPriceCatalog, updateOfficialPriceCatalog } from "./model-pricing-catalog-store";
import { readPricingState } from "./model-pricing-store";

const original = { provider: process.env.VOZEB_PRO_DATABASE_PROVIDER, directory: process.env.VOZEB_PRO_DATA_DIR };
let directory: string;

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "vozeb-price-catalog-"));
    process.env.VOZEB_PRO_DATABASE_PROVIDER = "file";
    process.env.VOZEB_PRO_DATA_DIR = directory;
});

it("refuses to delete or change the SKU of a catalog model with a recorded call", async () => {
    const version: OfficialPriceCatalogEntry = {
        id: randomUUID(),
        manufacturer: "OpenAI",
        kind: "version",
        parentId: "series",
        name: "gpt-used",
        capability: null,
        sku: "gpt-used",
        sourceUrl: "https://example.com/pricing",
        evidence: "proof",
        createdAt: new Date().toISOString(),
        createdBy: "admin",
    };
    await insertOfficialPriceCatalog(version);
    const state = await readPricingState();
    await writeJsonDataFile("model-pricing.json", { ...state, officialVersions: [{ id: "approved-used", manufacturer: "OpenAI", sku: "gpt-used" } as OfficialPriceVersion] });
    await writeJsonDataFile("generation-tasks.json", [{ status: "success", payload: { pricingSnapshot: { officialVersionId: "approved-used" } } }]);
    await expect(deleteOfficialPriceCatalog(version)).rejects.toThrow("已审核价目");
    await expect(updateOfficialPriceCatalog({ ...version, sku: "different" }, version)).rejects.toThrow("已审核价目");
    expect(await listOfficialPriceCatalog("OpenAI")).toEqual([version]);
    await updateOfficialPriceCatalog({ ...version, name: "gpt-used-current" }, version);
    expect((await readPricingState()).officialVersions[0].sku).toBe("gpt-used");
});

it("protects a pending candidate's catalog identity while allowing a display-name correction", async () => {
    const version: OfficialPriceCatalogEntry = {
        id: randomUUID(),
        manufacturer: "OpenAI",
        kind: "version",
        parentId: "series",
        name: "gpt-new",
        capability: null,
        sku: "gpt-new",
        sourceUrl: "https://example.com/pricing",
        evidence: "proof",
        createdAt: new Date().toISOString(),
        createdBy: "admin",
    };
    await insertOfficialPriceCatalog(version);
    const state = await readPricingState();
    await writeJsonDataFile("model-pricing.json", { ...state, candidates: [{ id: "candidate", status: "pending", manufacturer: "OpenAI", sku: "gpt-new", catalogVersionId: version.id }] });
    await expect(deleteOfficialPriceCatalog(version)).rejects.toThrow("待审价目");
    await expect(updateOfficialPriceCatalog({ ...version, sku: "different" }, version)).rejects.toThrow("待审价目");
    await expect(updateOfficialPriceCatalog({ ...version, parentId: "another" }, version)).rejects.toThrow("待审价目");
    const renamed = { ...version, name: "gpt-new-public" };
    await updateOfficialPriceCatalog(renamed, version);
    expect((await readPricingState()).candidates[0].sku).toBe("gpt-new");
    expect((await listOfficialPriceCatalog("OpenAI"))[0].name).toBe("gpt-new-public");
});

it("keeps a catalog model used in a completed fixed-price task even without an approved official price", async () => {
    const version: OfficialPriceCatalogEntry = {
        id: randomUUID(),
        manufacturer: "OpenAI",
        kind: "version",
        parentId: "series",
        name: "gpt-call",
        capability: null,
        sku: "gpt-call",
        sourceUrl: "https://example.com/pricing",
        evidence: "proof",
        createdAt: new Date().toISOString(),
        createdBy: "admin",
    };
    await insertOfficialPriceCatalog(version);
    await writeJsonDataFile("generation-tasks.json", [{ status: "success", payload: { config: { model: "gpt-call" } } }]);
    await expect(deleteOfficialPriceCatalog(version)).rejects.toThrow("真实调用");
    await expect(updateOfficialPriceCatalog({ ...version, sku: "other" }, version)).rejects.toThrow("真实调用");
});

afterEach(async () => {
    if (original.provider === undefined) delete process.env.VOZEB_PRO_DATABASE_PROVIDER;
    else process.env.VOZEB_PRO_DATABASE_PROVIDER = original.provider;
    if (original.directory === undefined) delete process.env.VOZEB_PRO_DATA_DIR;
    else process.env.VOZEB_PRO_DATA_DIR = original.directory;
    await rm(directory, { force: true, recursive: true });
});

it("keeps edits conditional and prevents deleting a series while versions exist", async () => {
    const series: OfficialPriceCatalogEntry = {
        id: randomUUID(),
        manufacturer: "OpenAI",
        kind: "series",
        parentId: null,
        name: "GPT",
        capability: "text",
        sku: null,
        sourceUrl: "https://example.com/pricing",
        evidence: "series proof",
        createdAt: new Date().toISOString(),
        createdBy: "admin",
    };
    const version: OfficialPriceCatalogEntry = { ...series, id: randomUUID(), kind: "version", parentId: series.id, name: "gpt-new", capability: null, sku: "gpt-new", evidence: "version proof" };
    await insertOfficialPriceCatalog(series);
    await insertOfficialPriceCatalog(version);
    await expect(deleteOfficialPriceCatalog(series)).rejects.toThrow("请先删除或调整");
    const revised = { ...version, name: "gpt-newer", updatedAt: new Date().toISOString(), updatedBy: "editor" };
    await updateOfficialPriceCatalog(revised, version);
    await expect(updateOfficialPriceCatalog({ ...revised, name: "stale" }, version)).rejects.toThrow("已变化");
    expect((await listOfficialPriceCatalog("OpenAI")).find((entry) => entry.id === version.id)).toEqual(revised);
    await deleteOfficialPriceCatalog(revised);
    await deleteOfficialPriceCatalog(series);
    expect(await listOfficialPriceCatalog("OpenAI")).toEqual([]);
});
