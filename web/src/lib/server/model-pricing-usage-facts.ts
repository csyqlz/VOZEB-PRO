import type { TokenUsageObservation } from "./model-pricing-token-usage";

export type TextUsageFact = {
    schemaVersion: 1;
    factId: string;
    meter: string;
    value?: string;
    unit: "token";
    scope: { kind: "attempt"; scopeId: string };
    sourcePath?: string;
    sourcePaths: string[];
    sourceKind?: "upstream-response" | "approved-derivation" | "manual-review";
    formula?: string;
    relation?: { kind: "derived-from"; inputMeters: string[] };
    status: "reported" | "derived" | "reviewed" | "missing" | "invalid";
    evidenceId: string;
    sourceEvidenceId?: string;
};

/** Materialize parser output without guessing missing values or changing the raw observation. */
export function textUsageFacts(input: {
    attemptId: string;
    evidenceId: string;
    observation: TokenUsageObservation;
    meters: readonly string[];
    manualReviewId?: string;
    originalObservation?: TokenUsageObservation;
    originalEvidenceId?: string;
}): TextUsageFact[] {
    if (!input.attemptId || !input.evidenceId || (input.manualReviewId !== undefined && !input.manualReviewId) || (input.originalObservation && (!input.manualReviewId || !input.originalEvidenceId))) throw new Error("计量事实缺少真实尝试或观察证据身份");
    return [...new Set(input.meters)].map((meter) => {
        const value = input.observation.quantities[meter];
        const original = input.originalObservation;
        const reported = !original?.invalid && original?.quantities[meter] === value && Boolean(original?.meterSources?.[meter]?.paths.length);
        const source = reported ? original!.meterSources?.[meter] : input.observation.meterSources?.[meter];
        const valid = !input.observation.invalid && /^\d+$/.test(value || "") && (!!source?.paths.length || !!input.manualReviewId);
        const reviewed = Boolean(input.manualReviewId && !reported);
        const status = value === undefined ? "missing" : valid ? (reviewed ? "reviewed" : source?.kind === "approved-derivation" ? "derived" : "reported") : "invalid";
        const sourcePaths = reviewed ? [`review:${input.manualReviewId}`] : [...(source?.paths || [])];
        return {
            schemaVersion: 1 as const,
            factId: [input.attemptId, input.evidenceId, meter].map(encodeURIComponent).join(":"),
            meter,
            ...(valid ? { value } : {}),
            unit: "token" as const,
            scope: { kind: "attempt" as const, scopeId: input.attemptId },
            ...(sourcePaths.length
                ? {
                      sourcePath: sourcePaths[0],
                      sourcePaths,
                      sourceKind: reviewed ? ("manual-review" as const) : source?.kind,
                      ...(!reviewed && source?.formula ? { formula: source.formula, relation: { kind: "derived-from" as const, inputMeters: [...(source.inputMeters || [])] } } : {}),
                  }
                : { sourcePaths: [] }),
            status,
            evidenceId: input.evidenceId,
            ...(reported ? { sourceEvidenceId: input.originalEvidenceId } : {}),
        };
    });
}
