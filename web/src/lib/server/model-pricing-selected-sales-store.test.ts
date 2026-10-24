import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import type { OfficialPriceVersion, SalesVersion } from "@/lib/model-pricing";

import { saveModelPriceBinding } from "./model-price-binding-store";
import { getCurrentSalesVersion, insertSalesVersion, mutatePricingState, saveBusinessExchangeRate } from "./model-pricing-store";

const prior = { provider: process.env.VOZEB_PRO_DATABASE_PROVIDER, directory: process.env.VOZEB_PRO_DATA_DIR };
let directory: string | undefined;
afterEach(async () => {
    if (prior.provider === undefined) delete process.env.VOZEB_PRO_DATABASE_PROVIDER;
    else process.env.VOZEB_PRO_DATABASE_PROVIDER = prior.provider;
    if (prior.directory === undefined) delete process.env.VOZEB_PRO_DATA_DIR;
    else process.env.VOZEB_PRO_DATA_DIR = prior.directory;
    if (directory) await rm(directory, { recursive: true, force: true });
});

it("checks the selected binding revision atomically when publishing a sales version", async () => {
    directory = await mkdtemp(join(tmpdir(), "vozeb-selected-sales-"));
    process.env.VOZEB_PRO_DATABASE_PROVIDER = "file";
    process.env.VOZEB_PRO_DATA_DIR = directory;
    const price: OfficialPriceVersion = {
        id: "official-shared",
        candidateId: "candidate",
        logicalModelId: "",
        capability: "text",
        manufacturer: "Fixture",
        series: "",
        officialVersion: "one",
        sku: "fixture-one",
        tier: "paid",
        conditions: "Standard",
        sourceKind: "manual",
        sourceUrl: "https://example.com/pricing",
        evidence: "Reviewed",
        observedAt: "2026-10-20T00:00:00Z",
        publishedAt: "2026-10-20T00:00:00Z",
        reviewedBy: "admin",
        items: [{ key: "inputTokens", unit: "token", per: "1000000", price: "1", currency: "USD" }],
    };
    await mutatePricingState((state) => ({ next: { ...state, officialVersions: [price] }, result: undefined }));
    const input = {
        logicalModelId: "model-one",
        capability: "text" as const,
        operation: "generation" as const,
        processingMode: "standard" as const,
        scope: "text:generation:standard",
        officialVersionId: price.id,
        status: "active" as const,
        evidence: "Reviewed",
        reviewedBy: "admin",
    };
    const first = await saveModelPriceBinding(input, null);
    const sales: SalesVersion = {
        id: "sale-one",
        publishedAt: "2026-10-20T00:00:00Z",
        publishedBy: "admin",
        priceVersionIds: {},
        selectedPriceBindings: [{ logicalModelId: input.logicalModelId, scope: input.scope, bindingId: first.id, bindingRevision: first.revision, officialVersionId: price.id }],
        userPriceRules: [{ scope: "default", coefficient: "1" }],
        usdPerCurrency: { USD: "1" },
        pointsPerCurrency: { USD: "700" },
        rateEvidence: { USD: "Reviewed" },
    };
    await expect(insertSalesVersion({ ...sales, priceVersionIds: { [input.logicalModelId]: price.id } }, null)).rejects.toThrow("不能同时发布");
    const second = await saveModelPriceBinding({ ...input, evidence: "New review" }, first.revision);
    await expect(insertSalesVersion(sales, null)).rejects.toThrow("已变化");
    expect(await getCurrentSalesVersion()).toBeUndefined();
    const current = { ...sales, selectedPriceBindings: [{ ...sales.selectedPriceBindings![0], bindingId: second.id, bindingRevision: second.revision }] };
    expect(await insertSalesVersion(current, null)).toEqual(current);
    expect(await getCurrentSalesVersion()).toEqual(current);
    await saveModelPriceBinding({ ...input, evidence: "Revoked", status: "revoked", officialVersionId: null }, second.revision);
    await expect(insertSalesVersion({ ...current, id: "sale-two" }, current.id)).rejects.toThrow("已变化");
    expect((await getCurrentSalesVersion())?.id).toBe(current.id);
});

it("keeps both image operations when publishing a shared price and rejects a stale second scope", async () => {
    directory = await mkdtemp(join(tmpdir(), "vozeb-selected-image-sales-"));
    process.env.VOZEB_PRO_DATABASE_PROVIDER = "file";
    process.env.VOZEB_PRO_DATA_DIR = directory;
    const price: OfficialPriceVersion = {
        id: "shared-image-price",
        candidateId: "candidate",
        logicalModelId: "",
        capability: "image",
        manufacturer: "Fixture",
        series: "",
        officialVersion: "one",
        sku: "image-sku",
        tier: "paid",
        conditions: "Standard",
        sourceKind: "manual",
        sourceUrl: "https://example.com/pricing",
        evidence: "Reviewed",
        observedAt: "2026-10-20T00:00:00Z",
        publishedAt: "2026-10-20T00:00:00Z",
        reviewedBy: "admin",
        items: [{ key: "image", unit: "image", per: "1", price: "0.04", currency: "USD" }],
    };
    await mutatePricingState((state) => ({ next: { ...state, officialVersions: [price] }, result: undefined }));
    const input = {
        logicalModelId: "image-model",
        capability: "image" as const,
        processingMode: "standard" as const,
        officialVersionId: price.id,
        status: "active" as const,
        evidence: "Reviewed",
        reviewedBy: "admin",
    };
    const generation = await saveModelPriceBinding({ ...input, operation: "generations", scope: "image:generations:standard" }, null);
    const edit = await saveModelPriceBinding({ ...input, operation: "edits", scope: "image:edits:standard" }, null);
    const sale: SalesVersion = {
        id: "image-sale",
        publishedAt: "2026-10-20T00:00:00Z",
        publishedBy: "admin",
        priceVersionIds: {},
        selectedPriceBindings: [generation, edit].map((binding) => ({ logicalModelId: input.logicalModelId, scope: binding.scope, bindingId: binding.id, bindingRevision: binding.revision, officialVersionId: price.id })),
        userPriceRules: [{ scope: "model", modelId: input.logicalModelId, coefficient: "3" }],
        usdPerCurrency: { USD: "1" },
        pointsPerCurrency: { USD: "700" },
        rateEvidence: { USD: "Reviewed" },
    };
    await insertSalesVersion(sale, null);
    expect(await getCurrentSalesVersion()).toEqual(sale);
    await saveModelPriceBinding({ ...input, operation: "edits", scope: "image:edits:standard", evidence: "New review" }, edit.revision);
    await expect(insertSalesVersion({ ...sale, id: "stale-image-sale" }, sale.id)).rejects.toThrow("已变化");
    expect(await getCurrentSalesVersion()).toEqual(sale);
});

it("rechecks the reviewed exchange rate under the sales-version file lock", async () => {
    directory = await mkdtemp(join(tmpdir(), "vozeb-sales-rate-"));
    process.env.VOZEB_PRO_DATABASE_PROVIDER = "file";
    process.env.VOZEB_PRO_DATA_DIR = directory;
    const first = { cnyPerUsd: "7", observedAt: "2026-10-20T00:00:00Z", evidence: "first review" };
    await saveBusinessExchangeRate(first, null);
    const sale: SalesVersion = {
        id: "sale-rate",
        publishedAt: "2026-10-20T00:00:00Z",
        publishedBy: "admin",
        priceVersionIds: {},
        userPriceRules: [],
        conversion: { ...first, pointsPerCny: "100" },
        usdPerCurrency: { USD: "1" },
        pointsPerCurrency: { USD: "700" },
        rateEvidence: { USD: first.evidence },
    };
    const revised = { ...first, evidence: "new review" };
    await saveBusinessExchangeRate(revised, first.observedAt);
    await expect(insertSalesVersion(sale, null, true)).rejects.toThrow("汇率已变化");
    expect(await getCurrentSalesVersion()).toBeUndefined();
    expect(await insertSalesVersion({ ...sale, conversion: { ...revised, pointsPerCny: "100" } }, null, true)).toMatchObject({ id: sale.id });
});
