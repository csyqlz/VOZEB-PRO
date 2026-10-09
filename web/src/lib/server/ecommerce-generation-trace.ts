import type { AgentRunTask } from "./agent-run-store";
import type { EcommerceGenerationSnapshot } from "./ecommerce-generation-snapshot";
import type { EcommerceRoleRouteSnapshot } from "./ecommerce-model-routing";
import type { JsonValue } from "./database";

export const ECOMMERCE_GENERATION_TRACE_VERSION = "ecommerce-generation-trace.v1" as const;

export type EcommerceGenerationTraceStageKey = "visual_analysis" | "edit_planning" | "image_generation" | "quality_check";
export type EcommerceGenerationTraceModel = { [key: string]: JsonValue } & {
    logicalRole?: string;
    capability?: string;
    logicalModelId?: string;
    channelId?: string;
    upstreamModel?: string;
    apiFormat?: string;
};
export type EcommerceGenerationTraceStage = { [key: string]: JsonValue } & {
    key: EcommerceGenerationTraceStageKey;
    status: string;
    model?: EcommerceGenerationTraceModel;
    completedAt?: number;
    output: JsonValue;
};
export type EcommerceGenerationTrace = { [key: string]: JsonValue } & {
    version: typeof ECOMMERCE_GENERATION_TRACE_VERSION;
    runId: string;
    agentTaskId: string;
    imageTaskIds: string[];
    stages: EcommerceGenerationTraceStage[];
    finalStatus: string;
    recordedAt: number;
    mode?: EcommerceGenerationSnapshot["mode"];
};

export function buildEcommerceGenerationTrace(input: {
    runId: string;
    task: AgentRunTask;
    snapshot: EcommerceGenerationSnapshot;
    imageTaskIds: string[];
    generationStatus: "completed" | "failed" | "needs_review";
    finalStatus: string;
    error?: string;
    recordedAt?: number;
}): EcommerceGenerationTrace {
    const analysis = input.snapshot.visualAnalysis;
    const analysisFailure = input.snapshot.visualAnalysisFailure;
    const analysisModel = analysis?.modelRole || analysisFailure?.attempts.at(-1)?.modelRole;
    const plan = input.snapshot.plan;
    const execution = input.task.ecommerceExecution;
    const quality = input.snapshot.qualityCheck;
    return sanitizeTraceValue({
        version: ECOMMERCE_GENERATION_TRACE_VERSION,
        ...(input.snapshot.mode ? { mode: input.snapshot.mode } : {}),
        runId: input.runId,
        agentTaskId: input.task.id,
        imageTaskIds: uniqueText(input.imageTaskIds),
        stages: [
            {
                key: "visual_analysis",
                status: analysis ? "completed" : analysisFailure ? "failed" : "not_run",
                ...(analysisModel ? { model: routeSnapshot(analysisModel) } : {}),
                ...(finiteTime(input.snapshot.stageTimings?.analysisCompletedAt) ? { completedAt: input.snapshot.stageTimings!.analysisCompletedAt } : {}),
                output: analysis
                    ? {
                          analysisVersion: analysis.analysisVersion,
                          references: analysis.references,
                          ...(input.snapshot.referenceDecision ? { referenceDecision: input.snapshot.referenceDecision } : {}),
                      }
                    : analysisFailure
                      ? { visualAnalysisFailure: analysisFailure }
                      : input.snapshot.referenceDecision
                        ? { referenceDecision: input.snapshot.referenceDecision }
                        : {},
            },
            {
                key: "edit_planning",
                status: plan ? "completed" : "not_run",
                ...(input.snapshot.modelRouteSnapshots?.edit_planning ? { model: routeSnapshot(input.snapshot.modelRouteSnapshots.edit_planning) } : {}),
                ...(finiteTime(input.snapshot.stageTimings?.planningCompletedAt) ? { completedAt: input.snapshot.stageTimings!.planningCompletedAt } : {}),
                output: plan || {},
            },
            {
                key: "image_generation",
                status: input.generationStatus,
                ...(execution?.modelSnapshot ? { model: routeSnapshot(execution.modelSnapshot) } : {}),
                output: {
                    ...(input.snapshot.technicalCheck ? { technicalCheck: input.snapshot.technicalCheck } : {}),
                    ...(execution
                        ? {
                              state: execution.state,
                              compilerVersion: execution.compilerVersion,
                              providerProfileId: execution.providerProfileId,
                              executionPrompt: execution.prompt,
                              referenceRoles: execution.referenceRoles,
                              ...(execution.referenceMapping ? { referenceMapping: execution.referenceMapping } : {}),
                              mask: execution.mask,
                              parameters: execution.parameters,
                              ...(execution.canvas ? { canvas: execution.canvas } : {}),
                              ...(execution.photography ? { photography: execution.photography } : {}),
                          }
                        : {}),
                    imageTaskIds: uniqueText(input.imageTaskIds),
                    ...(input.task.productProtectionRegions ? { protection: protectionSummary(input.task.productProtectionRegions) } : {}),
                    ...(input.task.sceneProtection ? { sceneProtection: sceneProtectionSummary(input.task.sceneProtection) } : {}),
                    ...(input.snapshot.continuity ? { continuity: input.snapshot.continuity } : {}),
                    ...(input.error?.trim() ? { error: input.error.trim() } : {}),
                },
            },
            {
                key: "quality_check",
                status: quality?.status || "not_run",
                ...(quality?.modelRole ? { model: routeSnapshot(quality.modelRole) } : {}),
                ...(finiteTime(quality?.checkedAt) ? { completedAt: quality!.checkedAt } : {}),
                output: {
                    ...(input.snapshot.qualityPolicy ? { policy: input.snapshot.qualityPolicy } : {}),
                    ...(quality
                        ? {
                              version: quality.version,
                              status: quality.status,
                              publicStatus: quality.publicStatus,
                              checks: quality.checks,
                              hardFailures: quality.hardFailures,
                              internalReason: quality.internalReason,
                              ...(quality.canvasEvidence ? { canvasEvidence: quality.canvasEvidence } : {}),
                              ...(quality.observations ? { observations: quality.observations } : {}),
                              ...(quality.contradictions ? { contradictions: quality.contradictions } : {}),
                              ...(quality.sceneProtectionEvidence ? { sceneProtectionEvidence: quality.sceneProtectionEvidence } : {}),
                              ...(quality.visionEvidence ? { visionEvidence: quality.visionEvidence } : {}),
                          }
                        : {}),
                },
            },
        ],
        finalStatus: input.finalStatus.trim() || input.generationStatus,
        recordedAt: input.recordedAt ?? Date.now(),
    }) as EcommerceGenerationTrace;
}

export function normalizeEcommerceGenerationTrace(value: unknown): EcommerceGenerationTrace | undefined {
    if (!isRecord(value) || value.version !== ECOMMERCE_GENERATION_TRACE_VERSION) return undefined;
    const runId = text(value.runId);
    const agentTaskId = text(value.agentTaskId);
    const imageTaskIds = Array.isArray(value.imageTaskIds) ? uniqueText(value.imageTaskIds) : [];
    const stages = Array.isArray(value.stages) ? value.stages.flatMap(normalizeStage) : [];
    const finalStatus = text(value.finalStatus);
    const recordedAt = finiteTime(value.recordedAt) ? value.recordedAt : undefined;
    if (!runId || !agentTaskId || stages.length !== 4 || !finalStatus || recordedAt === undefined) return undefined;
    return sanitizeTraceValue({
        version: ECOMMERCE_GENERATION_TRACE_VERSION,
        ...(value.mode === "active" || value.mode === "shadow" || value.mode === "legacy" ? { mode: value.mode } : {}),
        runId,
        agentTaskId,
        imageTaskIds,
        stages,
        finalStatus,
        recordedAt,
    }) as EcommerceGenerationTrace;
}

function normalizeStage(value: unknown): EcommerceGenerationTraceStage[] {
    if (!isRecord(value) || !isStageKey(value.key)) return [];
    const status = text(value.status);
    if (!status) return [];
    const model = isRecord(value.model) ? routeSnapshot(value.model) : undefined;
    const completedAt = finiteTime(value.completedAt) ? value.completedAt : undefined;
    return [
        {
            key: value.key,
            status,
            ...(Object.values(model || {}).some(Boolean) ? { model } : {}),
            ...(completedAt !== undefined ? { completedAt } : {}),
            output: sanitizeTraceValue(value.output),
        },
    ];
}

function protectionSummary(regions: NonNullable<AgentRunTask["productProtectionRegions"]>) {
    return {
        productAnchorId: regions.productAnchorId,
        sourceAssetId: regions.sourceAssetId,
        sourceSize: regions.sourceSize,
        productCore: regions.productCore.rectangles,
        fusionHalo: regions.fusionHalo.rectangles,
        editableBackground: regions.editableBackground.rectangles,
        maskProvider: regions.editableBackground.mask?.provider,
        maskTrust: regions.editableBackground.mask?.trust,
    };
}

function sceneProtectionSummary(protection: NonNullable<AgentRunTask["sceneProtection"]>) {
    const { mask: _mask, ...evidence } = protection;
    void _mask;
    return evidence;
}

function routeSnapshot(value: Partial<EcommerceRoleRouteSnapshot> | Record<string, unknown>): EcommerceGenerationTraceModel {
    return {
        ...(text(value.logicalRole) ? { logicalRole: text(value.logicalRole) } : {}),
        ...(text(value.capability) ? { capability: text(value.capability) } : {}),
        ...(text(value.logicalModelId) ? { logicalModelId: text(value.logicalModelId) } : {}),
        ...(text(value.channelId) ? { channelId: text(value.channelId) } : {}),
        ...(text(value.upstreamModel) ? { upstreamModel: text(value.upstreamModel) } : {}),
        ...(text(value.apiFormat) ? { apiFormat: text(value.apiFormat) } : {}),
    };
}

function sanitizeTraceValue(value: unknown): JsonValue {
    if (Array.isArray(value)) return value.map(sanitizeTraceValue);
    if (isRecord(value)) {
        return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => (item === undefined || /^(apiKey|authorization|cookie|headers?|dataUrl|remoteUrl|serverUrl)$/i.test(key) ? [] : [[key, sanitizeTraceValue(item)]])));
    }
    if (typeof value === "string" && /^(data|blob):/i.test(value.trim())) return "[redacted]";
    if (typeof value === "string" || typeof value === "boolean" || value === null) return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    return null;
}

function uniqueText(values: unknown[]) {
    return Array.from(new Set(values.map(text).filter(Boolean)));
}

function text(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function finiteTime(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isStageKey(value: unknown): value is EcommerceGenerationTraceStageKey {
    return value === "visual_analysis" || value === "edit_planning" || value === "image_generation" || value === "quality_check";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
