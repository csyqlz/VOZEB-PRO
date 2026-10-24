import { expect, it } from "vitest";

import { validateSalesPolicy } from "./price-book";
import type { ModelPriceBinding, OfficialPriceVersion } from "./types";

const price: OfficialPriceVersion = {
    id: "official-one",
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
const binding: ModelPriceBinding = {
    id: "binding-one",
    logicalModelId: "model-one",
    capability: "text",
    operation: "generation",
    processingMode: "standard",
    scope: "text:generation:standard",
    officialVersionId: price.id,
    status: "active",
    revision: "revision-one",
    current: true,
    evidence: "Reviewed identity",
    reviewedAt: "2026-10-20T00:00:00Z",
    reviewedBy: "admin",
};
const reference = { logicalModelId: binding.logicalModelId, scope: binding.scope, bindingId: binding.id, bindingRevision: binding.revision, officialVersionId: price.id };
const draft = {
    priceVersionIds: {},
    selectedPriceBindings: [reference],
    userPriceRules: [{ scope: "default", coefficient: "1" }],
    conversion: { cnyPerUsd: "7", pointsPerCny: "100", observedAt: "2026-10-20T00:00:00Z", evidence: "Reviewed exchange rate" },
};

it("publishes a reviewed shared USD price by binding reference without copying it onto a model", () => {
    const other = { ...binding, id: "binding-two", logicalModelId: "model-two", revision: "revision-two" };
    const otherReference = { ...reference, logicalModelId: other.logicalModelId, bindingId: other.id, bindingRevision: other.revision };
    const policy = validateSalesPolicy({ ...draft, selectedPriceBindings: [reference, otherReference] }, [price], [binding.logicalModelId, other.logicalModelId], [binding, other]);
    expect(policy.priceVersionIds).toEqual({});
    expect(policy.selectedPriceBindings).toEqual([reference, otherReference]);
    expect(policy.pointsPerCurrency.USD).toBe("700");
});

it("rejects stale, revoked, conflicting and unsupported selections", () => {
    const validate = (input: unknown, selected = binding, official = price) => validateSalesPolicy(input, [official], [binding.logicalModelId], [selected]);
    expect(() => validate({ ...draft, selectedPriceBindings: [{ ...reference, bindingRevision: "old" }] })).toThrow("已变化");
    expect(() => validate(draft, { ...binding, current: false })).toThrow("已变化");
    expect(() => validate(draft, { ...binding, status: "revoked" })).toThrow("已变化");
    expect(() => validate({ ...draft, selectedPriceBindings: [reference, reference] })).toThrow("不能重复");
    expect(() => validate(draft, { ...binding, processingMode: "batch" })).toThrow("已变化");
    expect(() => validate(draft, binding, { ...price, items: [{ ...price.items[0], currency: "CNY" }] })).toThrow("USD");
    expect(() => validate(draft, binding, { ...price, tier: "free" })).toThrow("常规付费");
    expect(() => validate(draft, binding, { ...price, items: [{ ...price.items[0], price: "0" }] })).toThrow("常规付费");
    expect(() => validate({ ...draft, priceVersionIds: { [binding.logicalModelId]: price.id } }, binding, { ...price, logicalModelId: binding.logicalModelId })).toThrow("重复");
});
