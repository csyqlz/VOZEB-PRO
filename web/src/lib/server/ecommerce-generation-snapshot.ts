import type { CreativeAsset, CreativeConversationContext, CreativeSurface } from "@/lib/creative-runtime-contract";
import { typedReferenceAliases } from "@/lib/creative-asset-references";
import type { AgentRun } from "./agent-run-store";
import type { EcommerceEditPlan } from "./ecommerce-edit-plan";
import type { EcommerceRoleRouteSnapshot } from "./ecommerce-model-routing";
import type { EcommerceQualityCheck, EcommerceResultTechnicalCheck } from "./ecommerce-quality-check";
import type { EcommerceLogicalModelRole } from "./agent-run-surface-policy";
import type { EcommerceVisualAnalysis, EcommerceVisualAnalysisV4, EcommerceVisualAnalysisFailure } from "./ecommerce-visual-analysis";
import { parseExplicitEcommerceReferenceBindings, type EcommerceReferenceAlias, type EcommerceReferenceBinding, type EcommerceReferenceDecision } from "./ecommerce-reference-purpose";
import type { EcommerceReferenceCheckpoint } from "./ecommerce-reference-recovery";

export const ECOMMERCE_GENERATION_SNAPSHOT_VERSION = "ecommerce-generation.v1" as const;

export type EcommercePlanningAssetCandidate = {
    id: string;
    type: CreativeAsset["type"];
    title: string;
    url?: string;
    width?: number;
    height?: number;
};

export type EcommercePlanningInput = {
    userRequest: string;
    conversationId: string;
    surface: CreativeSurface;
    assetCandidates: EcommercePlanningAssetCandidate[];
    referenceAliases?: EcommerceReferenceAlias[];
    explicitReferenceBindings?: EcommerceReferenceBinding[];
    inheritedReferences?: { editTargetId: string; productAnchorId: string | null };
    conversationContext: {
        summary: string;
        recentMessages: Array<{ role: string; content: string; sequence: number }>;
    };
};

export type EcommerceSnapshotInput = {
    userRequest: string;
    assetIds: string[];
    conversationId: string;
    surface: CreativeSurface;
    referenceAliases?: EcommerceReferenceAlias[];
    inheritedReferences?: EcommercePlanningInput["inheritedReferences"];
};

export type EcommerceGenerationSnapshot = {
    version: typeof ECOMMERCE_GENERATION_SNAPSHOT_VERSION;
    mode: "shadow" | "legacy" | "active";
    input: EcommerceSnapshotInput;
    continuity?: { parentResultId: string | null; branchId: string; sceneRootAssetId?: string | null; parentQualityCheck?: EcommerceQualityCheck };
    visualAnalysis?: EcommerceVisualAnalysis | EcommerceVisualAnalysisV4;
    visualAnalysisFailure?: EcommerceVisualAnalysisFailure;
    referenceDecision?: EcommerceReferenceDecision;
    referenceCheckpoint?: EcommerceReferenceCheckpoint;
    plan?: EcommerceEditPlan;
    modelRoles?: Record<string, string | null>;
    modelRouteSnapshots?: Partial<Record<EcommerceLogicalModelRole, EcommerceRoleRouteSnapshot>>;
    compilerVersion?: string;
    qualityCheck?: EcommerceQualityCheck;
    qualityPolicy?: "disabled" | "advisory";
    technicalCheck?: EcommerceResultTechnicalCheck;
    stageTimings?: { analysisCompletedAt?: number; planningCompletedAt?: number };
    fallback?: { reason: string };
    createdAt: number;
};

export type EcommerceGenerationSnapshotRecord = EcommerceGenerationSnapshot & {
    runId: string;
    userId: string;
};

export type EcommerceLegacyFallback = {
    mode: "legacy";
    reason: "ecommerce_planner_disabled";
    input: EcommerceSnapshotInput;
};

export function ecommerceSceneSelectionTask(run: AgentRun) {
    const snapshot = run.ecommerceSnapshot;
    const plan = snapshot?.plan;
    const task = run.tasks[0];
    if (
        run.status !== "paused" ||
        run.cancellation ||
        snapshot?.mode !== "active" ||
        snapshot.fallback?.reason !== "scene_selection_required" ||
        snapshot.qualityCheck ||
        !plan ||
        !["ecommerce-edit.v3", "ecommerce-edit.v4", "ecommerce-edit.v5", "ecommerce-edit.v6"].includes(plan.planVersion) ||
        plan.operation !== "scene_edit" ||
        plan.protection?.scope !== "local" ||
        !plan.source.currentSceneBaselineId ||
        run.tasks.length !== 1 ||
        task?.status !== "needs_review" ||
        task.sceneProtection ||
        task.ecommerceExecution?.state !== "ready" ||
        task.taskId ||
        task.taskIds?.length ||
        task.childTasks?.length ||
        task.attempts
    )
        return undefined;
    return task;
}

export function ecommerceShadowPlanningEnabled(value: unknown): boolean {
    return typeof value === "string" && value.trim().toLowerCase() === "shadow";
}

export function buildEcommercePlanningInput(
    run: Pick<AgentRun, "prompt" | "conversationId" | "surface" | "referencedAssetIds"> & Partial<Pick<AgentRun, "userId">>,
    assets: CreativeAsset[],
    conversationContext: Pick<CreativeConversationContext, "summary" | "recentMessages">,
): EcommercePlanningInput {
    const assetsById = new Map(assets.filter((asset) => asset.status === "ready" && asset.conversationId === run.conversationId && (!run.userId || asset.userId === run.userId)).map((asset) => [asset.id, asset]));
    const availableAssets = [...assetsById.values()];
    const referenceIds = [...new Set(run.referencedAssetIds)].filter((id) => assetsById.has(id));
    const orderedAssets = [...referenceIds.map((id) => assetsById.get(id)!), ...availableAssets.filter((asset) => !referenceIds.includes(asset.id))];
    const referenceAliases = [...typedReferenceAliases(availableAssets, referenceIds)].map(([assetId, alias]) => ({ assetId, alias }));
    return {
        userRequest: run.prompt,
        conversationId: run.conversationId,
        surface: run.surface,
        referenceAliases,
        explicitReferenceBindings: parseExplicitEcommerceReferenceBindings(run.prompt, referenceAliases),
        assetCandidates: orderedAssets.map((asset) => ({
            id: asset.id,
            type: asset.type,
            title: asset.title,
            ...(asset.remoteUrl || asset.serverUrl ? { url: asset.remoteUrl || asset.serverUrl } : {}),
            ...(Number.isFinite(asset.width) ? { width: asset.width } : {}),
            ...(Number.isFinite(asset.height) ? { height: asset.height } : {}),
        })),
        conversationContext: {
            summary: conversationContext.summary,
            recentMessages: conversationContext.recentMessages.map((message) => ({ role: message.role, content: message.content, sequence: message.sequence })),
        },
    };
}

export function recordEcommerceGenerationSnapshot(run: Pick<AgentRun, "id" | "userId">, snapshot: EcommerceGenerationSnapshot): EcommerceGenerationSnapshotRecord {
    return {
        ...snapshot,
        input: structuredClone(snapshot.input),
        ...(snapshot.continuity ? { continuity: structuredClone(snapshot.continuity) } : {}),
        ...(snapshot.visualAnalysis ? { visualAnalysis: structuredClone(snapshot.visualAnalysis) } : {}),
        ...(snapshot.visualAnalysisFailure ? { visualAnalysisFailure: structuredClone(snapshot.visualAnalysisFailure) } : {}),
        ...(snapshot.referenceDecision ? { referenceDecision: structuredClone(snapshot.referenceDecision) } : {}),
        ...(snapshot.referenceCheckpoint ? { referenceCheckpoint: structuredClone(snapshot.referenceCheckpoint) } : {}),
        ...(snapshot.plan ? { plan: structuredClone(snapshot.plan) } : {}),
        ...(snapshot.modelRoles ? { modelRoles: { ...snapshot.modelRoles } } : {}),
        ...(snapshot.modelRouteSnapshots
            ? {
                  modelRouteSnapshots: Object.fromEntries(Object.entries(snapshot.modelRouteSnapshots).map(([role, route]) => [role, route ? { ...route } : route])) as EcommerceGenerationSnapshot["modelRouteSnapshots"],
              }
            : {}),
        ...(snapshot.qualityCheck
            ? {
                  qualityCheck: structuredClone(snapshot.qualityCheck),
              }
            : {}),
        ...(snapshot.technicalCheck ? { technicalCheck: structuredClone(snapshot.technicalCheck) } : {}),
        ...(snapshot.stageTimings ? { stageTimings: { ...snapshot.stageTimings } } : {}),
        runId: run.id,
        userId: run.userId,
    };
}

export function legacyPlanFallback(input: EcommerceSnapshotInput): EcommerceLegacyFallback {
    return { mode: "legacy", reason: "ecommerce_planner_disabled", input: { ...input, assetIds: [...input.assetIds] } };
}
