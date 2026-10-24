import { expect, it } from "vitest";

import { quoteSalesPrice } from "./rate-engine";
import { validateOfficialPriceInput } from "./price-book";
import { officialItemsForTextPriceGroup, selectStandardTextPriceGroup, TextPriceScheduleError, validateStandardTextPriceGroups, type TextPriceGroup } from "./text-price-groups";
import type { OfficialPriceVersion, SalesPolicy } from "./types";

const range = { minInclusive: 0, maxInclusive: 256000 };
const meters = [
    { meter: "inputTokens", unit: "token" },
    { meter: "outputTokens", unit: "token" },
];
const groups: TextPriceGroup[] = [
    {
        id: "normal",
        scopeKind: "generation",
        selector: { processingMode: "standard", inputTotalTokens: { minInclusive: 0, maxInclusive: 128000 } },
        lines: [
            { lineId: "normal-input", meter: "inputTokens", unit: "token", per: "1000000", price: "1", currency: "USD", evidence: "Official Standard input tier" },
            { lineId: "normal-output", meter: "outputTokens", unit: "token", per: "1000000", price: "4", currency: "USD", evidence: "Official Standard output tier" },
        ],
    },
    {
        id: "long",
        scopeKind: "generation",
        selector: { processingMode: "standard", inputTotalTokens: { minInclusive: 128001, maxInclusive: 256000 } },
        lines: [
            { lineId: "long-input", meter: "inputTokens", unit: "token", per: "1000000", price: "2", currency: "USD", evidence: "Official long-context input tier" },
            { lineId: "long-output", meter: "outputTokens", unit: "token", per: "1000000", price: "4", currency: "USD", evidence: "Official long-context output tier" },
        ],
    },
];
const version: OfficialPriceVersion = {
    id: "official-shared",
    candidateId: "candidate",
    logicalModelId: "",
    capability: "text",
    manufacturer: "Fixture",
    series: "",
    officialVersion: "fixture-text",
    sku: "fixture-text",
    tier: "paid",
    conditions: "Standard online text",
    sourceKind: "manual",
    sourceUrl: "https://example.com/pricing",
    evidence: "Fixture source",
    observedAt: "2026-10-20T00:00:00Z",
    publishedAt: "2026-10-20T00:00:00Z",
    reviewedBy: "reviewer",
    items: [],
};
const policy: SalesPolicy = {
    priceVersionIds: {},
    userPriceRules: [{ scope: "default", coefficient: "1" }],
    conversion: { cnyPerUsd: "7", pointsPerCny: "100", observedAt: "2026-10-20T00:00:00Z", evidence: "Fixture rate" },
    usdPerCurrency: {},
    pointsPerCurrency: { USD: "700" },
    rateEvidence: { USD: "Fixture rate" },
};

it("selects one whole-request Standard tier at 128000 and 128001 input tokens", () => {
    expect(validateStandardTextPriceGroups(groups, range, meters)).toEqual([]);
    const normal = selectStandardTextPriceGroup(groups, range, meters, 128000, "standard");
    const long = selectStandardTextPriceGroup(groups, range, meters, 128001, "standard");
    expect(normal.ok && normal.group.id).toBe("normal");
    expect(long.ok && long.group.id).toBe("long");
    if (!long.ok) throw new Error("long-context group missing");
    const quote = quoteSalesPrice({ version: { ...version, items: officialItemsForTextPriceGroup(long.group) }, modelId: "logical-a", policy, usage: { inputTokens: "128001", outputTokens: "20000" } });
    expect(quote).toMatchObject({ officialVersionId: version.id, modelId: "logical-a", points: "235.20", officialAmountUsd: "0.336002", lines: [expect.objectContaining({ lineId: "long-input" }), expect.objectContaining({ lineId: "long-output" })] });
});

it("rejects gaps, overlap, duplicate lines and missing or wrong-unit meters before quoting", () => {
    const changed = (second: TextPriceGroup): TextPriceGroup[] => [groups[0], second];
    expect(validateStandardTextPriceGroups(changed({ ...groups[1], selector: { ...groups[1].selector, inputTotalTokens: { minInclusive: 128002, maxInclusive: 256000 } } }), range, meters)).toContainEqual(expect.objectContaining({ code: "coverage_gap" }));
    expect(validateStandardTextPriceGroups(changed({ ...groups[1], selector: { ...groups[1].selector, inputTotalTokens: { minInclusive: 128000, maxInclusive: 256000 } } }), range, meters)).toContainEqual(
        expect.objectContaining({ code: "coverage_overlap" }),
    );
    expect(validateStandardTextPriceGroups(changed({ ...groups[1], lines: [{ ...groups[1].lines[0], lineId: "normal-input" }] }), range, meters)).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "invalid_line" }), expect.objectContaining({ code: "meter_mismatch", meter: "outputTokens" })]),
    );
    expect(validateStandardTextPriceGroups(changed({ ...groups[1], lines: [{ ...groups[1].lines[0], unit: "image" }, groups[1].lines[1]] }), range, meters)).toContainEqual(expect.objectContaining({ code: "meter_mismatch", meter: "inputTokens" }));
    expect(validateStandardTextPriceGroups(groups, range, [{ meter: "", unit: "token" }])).toContainEqual(expect.objectContaining({ code: "meter_mismatch" }));
    expect(selectStandardTextPriceGroup(changed({ ...groups[1], selector: { ...groups[1].selector, inputTotalTokens: { minInclusive: 128002, maxInclusive: 256000 } } }), range, meters, 128001, "standard")).toMatchObject({
        ok: false,
        code: "price_invalid",
    });
});

it("does not execute evidence-only processing modes or infer a missing selector fact", () => {
    const batch: TextPriceGroup = { ...groups[0], id: "batch-evidence", selector: { ...groups[0].selector, processingMode: "batch" }, lines: [] };
    expect(validateStandardTextPriceGroups([...groups, batch], range, meters)).toEqual([]);
    expect(selectStandardTextPriceGroup([...groups, batch], range, meters, 1, "batch")).toEqual({ ok: false, code: "processing_mode_unsupported" });
    expect(selectStandardTextPriceGroup(groups, range, meters, undefined, "standard")).toEqual({ ok: false, code: "usage_missing" });
    expect(selectStandardTextPriceGroup(groups, range, meters, 256001, "standard")).toEqual({ ok: false, code: "price_no_match" });
});

it("validates and preserves reviewed Standard text groups instead of flattening them into one price", () => {
    const schedule = { declaredRange: range, meters, groups };
    const reviewed = validateOfficialPriceInput({ ...version, textPriceSchedule: schedule });
    expect(reviewed.items).toEqual([]);
    expect(reviewed.textPriceSchedule).toEqual(schedule);
    expect(() => validateOfficialPriceInput({ ...version, textPriceSchedule: schedule, items: groups[0].lines.map((line) => ({ ...line, key: line.meter })) })).toThrow("不能同时填写平价分项");
    const gap = { ...schedule, groups: [groups[0], { ...groups[1], selector: { ...groups[1].selector, inputTotalTokens: { minInclusive: 128002, maxInclusive: 256000 } } }] };
    try {
        validateOfficialPriceInput({ ...version, textPriceSchedule: gap });
        throw new Error("gap should be rejected");
    } catch (error) {
        expect(error).toBeInstanceOf(TextPriceScheduleError);
        expect((error as TextPriceScheduleError).issues).toContainEqual(expect.objectContaining({ code: "coverage_gap" }));
    }
    expect(() => validateOfficialPriceInput({ ...version, textPriceSchedule: { ...schedule, groups: [{ ...groups[0], selector: { ...groups[0].selector, processingMode: "batch" } }] } })).toThrow("coverage_gap");
    expect(() => validateOfficialPriceInput({ ...version, textPriceSchedule: { ...schedule, groups: [{ ...groups[0], selector: { ...groups[0].selector, javascript: "inputTotalTokens > 1" } }] } })).toThrow("未审核的条件字段");
});
