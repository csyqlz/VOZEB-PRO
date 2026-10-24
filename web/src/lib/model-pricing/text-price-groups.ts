import { validateOfficialPriceItems } from "./official-price-items";
import { PricingInputError, requiredText } from "./primitives";
import type { OfficialPriceItem, OfficialPriceVersion } from "./types";

export type InputTokenRange = { minInclusive: number; maxInclusive?: number };
export type TextPriceLine = Pick<OfficialPriceItem, "unit" | "per" | "price"> & { lineId: string; meter: string; currency: "USD"; evidence: string };
export type TextPriceGroup = {
    id: string;
    scopeKind: "generation";
    selector: { processingMode: "standard" | "batch" | "flex"; inputTotalTokens: InputTokenRange };
    lines: TextPriceLine[];
};
export type TextPriceSchedule = { declaredRange: InputTokenRange; meters: Array<{ meter: string; unit: "token" }>; groups: TextPriceGroup[] };
export type TextPriceGroupIssue = { code: "invalid_range" | "invalid_line" | "duplicate_group" | "coverage_gap" | "coverage_overlap" | "meter_mismatch"; groupId?: string; meter?: string };
export type TextPriceSelection = { ok: true; group: TextPriceGroup } | { ok: false; code: "usage_missing" | "usage_invalid" | "processing_mode_unsupported" | "price_no_match" | "price_ambiguous" | "price_invalid"; issues?: TextPriceGroupIssue[] };

export class TextPriceScheduleError extends PricingInputError {
    constructor(public readonly issues: TextPriceGroupIssue[]) {
        super(`文本分档价格无效：${issues.map((issue) => `${issue.groupId || "范围"}/${issue.meter || "条件"}/${issue.code}`).join("、")}`);
    }
}
export class TextPriceSelectionError extends PricingInputError {
    constructor(
        public readonly reason: Exclude<TextPriceSelection, { ok: true }>["code"],
        public readonly issues?: TextPriceGroupIssue[],
    ) {
        super(`文本分档价无法报价：${reason}`);
    }
}

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new PricingInputError("文本分档价格格式无效");
    return value as Record<string, unknown>;
}

function knownKeys(value: Record<string, unknown>, keys: string[]) {
    if (Object.keys(value).some((key) => !keys.includes(key))) throw new PricingInputError("文本分档价格包含未审核的条件字段");
}

function inputRange(value: unknown): InputTokenRange {
    const input = record(value);
    knownKeys(input, ["minInclusive", "maxInclusive"]);
    if (!Number.isSafeInteger(input.minInclusive) || Number(input.minInclusive) < 0 || (input.maxInclusive !== undefined && (!Number.isSafeInteger(input.maxInclusive) || Number(input.maxInclusive) < Number(input.minInclusive))))
        throw new TextPriceScheduleError([{ code: "invalid_range" }]);
    return { minInclusive: input.minInclusive as number, ...(input.maxInclusive === undefined ? {} : { maxInclusive: input.maxInclusive as number }) };
}

export function validateTextPriceSchedule(value: unknown): TextPriceSchedule {
    const input = record(value);
    knownKeys(input, ["declaredRange", "meters", "groups"]);
    const declaredRange = inputRange(input.declaredRange);
    if (!Array.isArray(input.meters) || !Array.isArray(input.groups)) throw new PricingInputError("文本分档价格缺少计量项或价格组");
    const meters = input.meters.map((raw) => {
        const meter = record(raw);
        knownKeys(meter, ["meter", "unit"]);
        if (meter.unit !== "token") throw new TextPriceScheduleError([{ code: "meter_mismatch", meter: String(meter.meter || "") }]);
        return { meter: requiredText(meter.meter, "计量项"), unit: "token" as const };
    });
    const groups: TextPriceGroup[] = input.groups.map((raw) => {
        const group = record(raw);
        const selector = record(group.selector);
        knownKeys(group, ["id", "scopeKind", "selector", "lines"]);
        knownKeys(selector, ["processingMode", "inputTotalTokens"]);
        if (group.scopeKind !== "generation" || !["standard", "batch", "flex"].includes(String(selector.processingMode)) || !Array.isArray(group.lines)) throw new PricingInputError("文本价格组的范围、处理档位或分项无效");
        const lines = group.lines.length
            ? validateOfficialPriceItems(
                  group.lines.map((rawLine) => {
                      const line = record(rawLine);
                      knownKeys(line, ["lineId", "meter", "unit", "per", "price", "currency", "evidence"]);
                      return { ...line, key: line.meter };
                  }),
              )
            : [];
        return {
            id: requiredText(group.id, "价格组 ID"),
            scopeKind: "generation",
            selector: { processingMode: selector.processingMode as TextPriceGroup["selector"]["processingMode"], inputTotalTokens: inputRange(selector.inputTotalTokens) },
            lines: lines.map((item, index) => {
                const line = record((group.lines as unknown[])[index]);
                if (item.currency !== "USD") throw new TextPriceScheduleError([{ code: "invalid_line", groupId: String(group.id), meter: item.key }]);
                return { lineId: requiredText(line.lineId, "价格分项 ID"), meter: item.key, unit: item.unit, per: item.per, price: item.price, currency: "USD", evidence: requiredText(line.evidence, "价格分项证据") };
            }),
        };
    });
    const issues = validateStandardTextPriceGroups(groups, declaredRange, meters);
    if (issues.length) throw new TextPriceScheduleError(issues);
    return { declaredRange, meters, groups };
}

export function officialItemsForTextPriceGroup(group: TextPriceGroup): Array<OfficialPriceItem & { lineId: string; evidence: string }> {
    return group.lines.map(({ meter, ...line }) => ({ ...line, key: meter }));
}

/** Build a quote-only view; the published version remains the immutable full schedule. */
export function selectStandardTextPriceVersion(version: OfficialPriceVersion, inputTotalTokens: number) {
    const schedule = version.textPriceSchedule;
    if (!schedule) throw new PricingInputError("官方价没有结构化文本价格组");
    const selected = selectStandardTextPriceGroup(schedule.groups, schedule.declaredRange, schedule.meters, inputTotalTokens, "standard");
    if (!selected.ok) throw new TextPriceSelectionError(selected.code, selected.issues);
    return { version: { ...version, textPriceSchedule: undefined, items: officialItemsForTextPriceGroup(selected.group) }, groupId: selected.group.id };
}

const validRange = ({ minInclusive, maxInclusive }: InputTokenRange) => Number.isSafeInteger(minInclusive) && minInclusive >= 0 && (maxInclusive === undefined || (Number.isSafeInteger(maxInclusive) && maxInclusive >= minInclusive));

/** Only Standard text groups are executable; other processing modes remain evidence. */
export function validateStandardTextPriceGroups(groups: TextPriceGroup[], declaredRange: InputTokenRange, meters: Array<{ meter: string; unit: string }>): TextPriceGroupIssue[] {
    const issues: TextPriceGroupIssue[] = [];
    if (!validRange(declaredRange)) return [{ code: "invalid_range" }];
    const seenGroups = new Set<string>();
    const seenLines = new Set<string>();
    const expectedMeters = new Map(meters.map(({ meter, unit }) => [meter, unit]));
    if (!meters.length || expectedMeters.size !== meters.length || meters.some(({ meter, unit }) => !meter.trim() || !unit.trim())) issues.push({ code: "meter_mismatch" });
    for (const group of groups) {
        if (!group.id || seenGroups.has(group.id)) issues.push({ code: "duplicate_group", groupId: group.id });
        seenGroups.add(group.id);
    }
    const standard = groups.filter((group) => group.selector.processingMode === "standard");
    for (const group of standard) {
        if (group.scopeKind !== "generation" || !validRange(group.selector.inputTotalTokens)) issues.push({ code: "invalid_range", groupId: group.id });
        try {
            validateOfficialPriceItems(officialItemsForTextPriceGroup(group));
        } catch {
            issues.push({ code: "invalid_line", groupId: group.id });
        }
        const covered = new Set<string>();
        for (const line of group.lines) {
            if (!line.lineId || !line.evidence?.trim() || seenLines.has(line.lineId) || line.currency !== "USD") issues.push({ code: "invalid_line", groupId: group.id, meter: line.meter });
            seenLines.add(line.lineId);
            covered.add(line.meter);
            if (expectedMeters.get(line.meter) !== line.unit) issues.push({ code: "meter_mismatch", groupId: group.id, meter: line.meter });
        }
        for (const meter of expectedMeters.keys()) if (!covered.has(meter)) issues.push({ code: "meter_mismatch", groupId: group.id, meter });
    }
    const ordered = standard.filter((group) => validRange(group.selector.inputTotalTokens)).sort((a, b) => a.selector.inputTotalTokens.minInclusive - b.selector.inputTotalTokens.minInclusive);
    let next = declaredRange.minInclusive;
    for (const group of ordered) {
        const { minInclusive, maxInclusive } = group.selector.inputTotalTokens;
        if (minInclusive > next) issues.push({ code: "coverage_gap", groupId: group.id });
        if (minInclusive < next || (maxInclusive !== undefined && declaredRange.maxInclusive !== undefined && maxInclusive > declaredRange.maxInclusive)) issues.push({ code: "coverage_overlap", groupId: group.id });
        if (maxInclusive === undefined) {
            next = Infinity;
            continue;
        }
        next = Math.max(next, maxInclusive + 1);
    }
    if (next !== Infinity && (declaredRange.maxInclusive === undefined || next <= declaredRange.maxInclusive)) issues.push({ code: "coverage_gap" });
    if (next === Infinity && declaredRange.maxInclusive !== undefined) issues.push({ code: "coverage_overlap" });
    return issues;
}

export function selectStandardTextPriceGroup(groups: TextPriceGroup[], declaredRange: InputTokenRange, meters: Array<{ meter: string; unit: string }>, inputTotalTokens: number | undefined, processingMode: string): TextPriceSelection {
    if (processingMode !== "standard") return { ok: false, code: "processing_mode_unsupported" };
    const issues = validateStandardTextPriceGroups(groups, declaredRange, meters);
    if (issues.length) return { ok: false, code: "price_invalid", issues };
    if (inputTotalTokens === undefined) return { ok: false, code: "usage_missing" };
    if (!Number.isSafeInteger(inputTotalTokens) || inputTotalTokens < 0) return { ok: false, code: "usage_invalid" };
    const matches = groups.filter(
        (group) =>
            group.scopeKind === "generation" &&
            group.selector.processingMode === "standard" &&
            group.selector.inputTotalTokens.minInclusive <= inputTotalTokens &&
            (group.selector.inputTotalTokens.maxInclusive === undefined || inputTotalTokens <= group.selector.inputTotalTokens.maxInclusive),
    );
    return matches.length === 1 ? { ok: true, group: matches[0] } : { ok: false, code: matches.length ? "price_ambiguous" : "price_no_match" };
}
