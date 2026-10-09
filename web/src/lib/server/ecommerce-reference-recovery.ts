import { createHash, randomUUID } from "node:crypto";
import type { CreativeAsset, CreativeReferenceRecovery, CreativeReferenceReview } from "@/lib/creative-runtime-contract";
import { ECOMMERCE_REFERENCE_PURPOSES } from "@/lib/creative-runtime-contract";
import type { AgentRun } from "./agent-run-store";
import type { EcommercePlanningInput } from "./ecommerce-generation-snapshot";
import type { EcommerceRoleRouteSnapshot } from "./ecommerce-model-routing";
import { allowedEcommerceReferencePurposes, ecommerceReferenceReviewMessage, resolveEcommerceReferenceDecision, type EcommerceReferenceBinding, type EcommerceReferenceDecision } from "./ecommerce-reference-purpose";
import type { EcommerceVisualAnalysisV4, EcommerceVisualAnalysisFailure, EcommerceVisualSourceIdentity } from "./ecommerce-visual-analysis";

export type EcommerceReferenceCheckpoint = {
    version: "ecommerce-reference-checkpoint.v1";
    reviewId: string;
    inputId: string;
    decisionId: string;
    state: "analyzing" | "needs_review" | "consumed" | "resolved";
    planningInput: EcommercePlanningInput;
    assets: Array<{ asset: CreativeAsset; assetVersion: string; alias: string; contentSha256?: string }>;
    analysisStage: { requestId: string; state: "created" | "sources_loaded" | "completed" | "failed" };
    analysis?: EcommerceVisualAnalysisV4;
    decision?: EcommerceReferenceDecision;
    failure?: EcommerceVisualAnalysisFailure;
    sourceReadFailure?: { kind: "source_read"; status?: number; message: string };
    sourceReadHistory?: NonNullable<EcommerceReferenceCheckpoint["sourceReadFailure"]>[];
    route?: EcommerceRoleRouteSnapshot;
    continuity?: NonNullable<AgentRun["ecommerceSnapshot"]>["continuity"];
    confirmedBindings?: Array<Omit<EcommerceReferenceBinding, "source">>;
    consumption?: { id: string; action: CreativeReferenceRecovery["action"]; acceptedAt: number; actorId: string };
    history?: Array<{ requestId: string; analysis?: EcommerceVisualAnalysisV4; decision?: EcommerceReferenceDecision; failure?: EcommerceVisualAnalysisFailure; route?: EcommerceRoleRouteSnapshot }>;
};

export const REFERENCE_CHECKPOINT_REASONS = new Set(["reference_purpose_confirmation_required", "reference_cue_unreliable", "visual_analysis_unavailable", "reference_source_unavailable", "reference_roles_need_review"]);
const PURPOSE_AMBIGUITIES = new Set(["reference_expression_unresolved", "edit_target_required", "edit_target_ambiguous", "reference_purpose_required", "product_identity_ambiguous"]);

export class EcommerceReferenceSourceChangedError extends Error {
    constructor() {
        super("参考图片内容已变化，请重新提供原图。");
        this.name = "EcommerceReferenceSourceChangedError";
    }
}

export class EcommerceReferenceSourceReadError extends Error {
    constructor(readonly status?: number) {
        super("参考图片暂时无法读取");
        this.name = "EcommerceReferenceSourceReadError";
    }
}

export function assertEcommerceReferenceContent(bytes: Buffer, expectedSha256: string) {
    if (!/^[a-f0-9]{64}$/.test(expectedSha256) || createHash("sha256").update(bytes).digest("hex") !== expectedSha256) throw new EcommerceReferenceSourceChangedError();
}

export function createEcommerceReferenceCheckpoint(run: AgentRun, planningInput: EcommercePlanningInput, assets: CreativeAsset[]): EcommerceReferenceCheckpoint {
    return {
        version: "ecommerce-reference-checkpoint.v1",
        reviewId: randomUUID(),
        inputId: randomUUID(),
        decisionId: randomUUID(),
        state: "analyzing",
        planningInput: structuredClone(planningInput),
        assets: planningInput.assetCandidates.map((candidate) => {
            const asset = assets.find((item) => item.id === candidate.id);
            if (!asset) throw new Error("参考输入缺少准确资产身份");
            return { asset: structuredClone(asset), assetVersion: referenceAssetVersion(asset), alias: planningInput.referenceAliases?.find((item) => item.assetId === asset.id)?.alias || "" };
        }),
        analysisStage: { requestId: `${run.id}:analysis:${randomUUID()}`, state: "created" },
    };
}

// Hash a declared tuple, never arbitrary jsonb objects: PostgreSQL may reorder
// object keys. URL query/preview parameters are not a source content version.
export function referenceSourceTuple(asset: CreativeAsset) {
    const stableUrl = (value: string | undefined) => {
        try {
            const url = new URL(value || "", "http://reference.local");
            return `${url.origin === "http://reference.local" ? "" : url.origin}${url.pathname}`;
        } catch {
            return "";
        }
    };
    return [asset.id, asset.userId, asset.conversationId, asset.type, asset.sourceRunId || "", asset.sourceTaskId || "", asset.storageKind || "", asset.storageKey || "", stableUrl(asset.serverUrl), stableUrl(asset.remoteUrl)];
}

export function referenceAssetVersion(asset: CreativeAsset, contentSha256 = "") {
    return createHash("sha256")
        .update(JSON.stringify([...referenceSourceTuple(asset), contentSha256]))
        .digest("hex");
}

export function referenceSourcesLoaded(checkpoint: EcommerceReferenceCheckpoint, sources: EcommerceVisualSourceIdentity[]): EcommerceReferenceCheckpoint {
    if (sources.length !== checkpoint.assets.length || new Set(sources.map((source) => source.assetId)).size !== sources.length) throw new Error("参考原图身份不完整");
    const assets = checkpoint.assets.map((item) => {
        const source = sources.find((value) => value.assetId === item.asset.id);
        if (!source || !/^[a-f0-9]{64}$/.test(source.contentSha256)) throw new Error("参考原图身份无效");
        if (item.contentSha256) {
            if (source.contentSha256 !== item.contentSha256 || source.sourceSize.width !== item.asset.width || source.sourceSize.height !== item.asset.height) throw new EcommerceReferenceSourceChangedError();
            return item;
        }
        return { ...item, asset: { ...item.asset, width: source.sourceSize.width, height: source.sourceSize.height }, contentSha256: source.contentSha256, assetVersion: referenceAssetVersion(item.asset, source.contentSha256) };
    });
    return { ...checkpoint, assets, analysisStage: { ...checkpoint.analysisStage, state: "sources_loaded" } };
}

export function referenceReviewKind(checkpoint: EcommerceReferenceCheckpoint): CreativeReferenceReview["kind"] {
    if (checkpoint.sourceReadFailure && checkpoint.analysis?.analysisVersion === "ecommerce-visual-analysis.v4" && checkpoint.analysisStage.state === "completed") return "retry_source";
    return checkpoint.analysis?.analysisVersion === "ecommerce-visual-analysis.v4" &&
        checkpoint.decision?.state === "needs_confirmation" &&
        checkpoint.decision.issues.length > 0 &&
        checkpoint.decision.issues.every((issue) => PURPOSE_AMBIGUITIES.has(issue.code)) &&
        hasResolvableReferenceBindings(checkpoint)
        ? "confirm_purposes"
        : "retry_analysis";
}

function hasResolvableReferenceBindings(checkpoint: EcommerceReferenceCheckpoint): boolean {
    const analysis = checkpoint.analysis;
    const aliases = checkpoint.assets.filter((item) => item.alias);
    if (!analysis || !aliases.length || aliases.length > 3) return false;
    const choices = aliases.map((item) => allowedEcommerceReferencePurposes(analysis.references.find((reference) => reference.assetId === item.asset.id)).map((purpose) => ({ assetId: item.asset.id, alias: item.alias, purposes: [purpose] })));
    // A nonempty subset can resolve only if one of its single purposes can:
    // extra cues add requirements, and a product target supplies its identity.
    // At most three references and five purposes keep this search bounded.
    const search = (index: number, bindings: Array<Omit<EcommerceReferenceBinding, "source">>): boolean => {
        if (index === choices.length) return resolveEcommerceReferenceDecision({ planningInput: checkpoint.planningInput, analysis, confirmedBindings: bindings }).state === "resolved";
        return choices[index].some((binding) => search(index + 1, [...bindings, binding]));
    };
    return search(0, []);
}

export function unsubmittedReferenceCheckpoint(run: AgentRun) {
    return (
        run.surface === "chat" &&
        run.status === "paused" &&
        !run.cancellation &&
        run.ecommerceSnapshot?.mode === "active" &&
        !run.ecommerceSnapshot.qualityCheck &&
        !run.assetIds?.length &&
        REFERENCE_CHECKPOINT_REASONS.has(run.ecommerceSnapshot.fallback?.reason || "") &&
        run.tasks.every((task) => task.status === "needs_review" && !task.attempts && !task.taskId && !task.taskIds?.length && !task.childTasks?.length && !task.sceneProtection)
    );
}

export function parseCreativeReferenceRecovery(value: unknown): CreativeReferenceRecovery {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("参考复核操作无效");
    const input = value as Record<string, unknown>;
    if (typeof input.reviewId !== "string" || !input.reviewId.trim() || input.reviewId.length > 200) throw new Error("参考复核身份无效");
    if (["retry_analysis", "retry_source"].includes(String(input.action)) && Object.keys(input).every((key) => ["reviewId", "action"].includes(key))) return { reviewId: input.reviewId, action: input.action as "retry_analysis" | "retry_source" };
    if (
        input.action !== "confirm_purposes" ||
        input.decisionVersion !== "ecommerce-reference-decision.v1" ||
        !Array.isArray(input.bindings) ||
        !input.bindings.length ||
        input.bindings.length > 3 ||
        Object.keys(input).some((key) => !["reviewId", "action", "decisionVersion", "bindings"].includes(key))
    )
        throw new Error("参考用途确认无效");
    const bindings = input.bindings.map((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("参考用途绑定无效");
        const binding = value as Record<string, unknown>;
        if (
            typeof binding.assetId !== "string" ||
            !binding.assetId ||
            typeof binding.assetVersion !== "string" ||
            !binding.assetVersion ||
            !Array.isArray(binding.purposes) ||
            !binding.purposes.length ||
            new Set(binding.purposes).size !== binding.purposes.length ||
            binding.purposes.some((purpose) => !ECOMMERCE_REFERENCE_PURPOSES.includes(purpose)) ||
            Object.keys(binding).some((key) => !["assetId", "assetVersion", "purposes"].includes(key))
        )
            throw new Error("参考用途绑定无效");
        return { assetId: binding.assetId, assetVersion: binding.assetVersion, purposes: binding.purposes as CreativeReferenceReview["assets"][number]["purposes"] };
    });
    if (new Set(bindings.map((binding) => binding.assetId)).size !== bindings.length) throw new Error("参考用途绑定重复");
    return { reviewId: input.reviewId, action: "confirm_purposes", decisionVersion: "ecommerce-reference-decision.v1", bindings };
}

export function confirmedReferenceDecision(checkpoint: EcommerceReferenceCheckpoint, recovery: Extract<CreativeReferenceRecovery, { action: "confirm_purposes" }>) {
    if (!checkpoint.analysis || !checkpoint.decision || referenceReviewKind(checkpoint) !== "confirm_purposes" || recovery.decisionVersion !== checkpoint.decision.version) return null;
    const aliases = checkpoint.assets.filter((item) => item.alias);
    if (recovery.bindings.length !== aliases.length) return null;
    const confirmedBindings: Array<Omit<EcommerceReferenceBinding, "source">> = [];
    for (const binding of recovery.bindings) {
        const item = aliases.find((asset) => asset.asset.id === binding.assetId && asset.assetVersion === binding.assetVersion && asset.contentSha256);
        if (!item) return null;
        const allowed = allowedEcommerceReferencePurposes(checkpoint.analysis.references.find((reference) => reference.assetId === item.asset.id));
        if (binding.purposes.some((purpose) => !allowed.includes(purpose))) return null;
        confirmedBindings.push({ assetId: item.asset.id, alias: item.alias, purposes: [...binding.purposes] });
    }
    const decision = resolveEcommerceReferenceDecision({ planningInput: checkpoint.planningInput, analysis: checkpoint.analysis, confirmedBindings });
    return decision.state === "resolved" ? { decision, confirmedBindings } : null;
}

export function referenceReviewQuestion(checkpoint: EcommerceReferenceCheckpoint) {
    if (referenceReviewKind(checkpoint) === "retry_source") return "参考图片暂时无法读取，可重试后继续这次创作。";
    if (checkpoint.decision) {
        if (checkpoint.decision.issues.every((issue) => PURPOSE_AMBIGUITIES.has(issue.code)) && referenceReviewKind(checkpoint) === "retry_analysis") return "当前参考图片缺少可用于确定完整用途的视觉线索，可重新分析后继续这次创作。";
        return ecommerceReferenceReviewMessage(checkpoint.decision);
    }
    return checkpoint.failure?.kind === "input_media" ? "无法读取参考图片，请检查图片后重新分析。" : "参考图分析暂时不可用，可重新分析后继续这次创作。";
}
