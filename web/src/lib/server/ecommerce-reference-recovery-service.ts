import { createHash, randomUUID } from "node:crypto";
import type { CreativeReferenceRecovery } from "@/lib/creative-runtime-contract";
import { originalImageSourceUrl } from "@/lib/media-image-url";
import { AGENT_RUN_TTL_MS, type AgentRun } from "./agent-run-store";
import { getCreativeAssetsByIds, mutateCreativeRun } from "./creative-runtime-store";
import { loadEcommercePlanningImage } from "./ecommerce-generation-service";
import { confirmedReferenceDecision, referenceReviewKind, referenceSourceTuple, unsubmittedReferenceCheckpoint } from "./ecommerce-reference-recovery";

export async function recoverEcommerceReferences(input: { run: AgentRun; recovery: CreativeReferenceRecovery; actorId: string; conversationId: string; origin: string; cookie: string }) {
    const { run, recovery } = input;
    const frozen = run.ecommerceSnapshot?.referenceCheckpoint;
    if (
        run.userId !== input.actorId ||
        run.conversationId !== input.conversationId ||
        !unsubmittedReferenceCheckpoint(run) ||
        frozen?.version !== "ecommerce-reference-checkpoint.v1" ||
        frozen.state !== "needs_review" ||
        frozen.reviewId !== recovery.reviewId ||
        referenceReviewKind(frozen) !== recovery.action
    )
        return null;
    const decision = recovery.action === "confirm_purposes" ? confirmedReferenceDecision(frozen, recovery) : null;
    if (recovery.action === "confirm_purposes" && !decision) return null;
    const owned = await getCreativeAssetsByIds(
        frozen.assets.map((item) => item.asset.id),
        run.userId,
    );
    for (const item of frozen.assets) {
        const current = owned.find((asset) => asset.id === item.asset.id && asset.userId === run.userId && asset.conversationId === run.conversationId && asset.type === "image" && asset.status === "ready");
        if (!current || referenceSourceTuple(current).some((value, index) => value !== referenceSourceTuple(item.asset)[index])) return null;
        if (item.contentSha256) {
            const source = frozen.planningInput.assetCandidates.find((asset) => asset.id === item.asset.id)?.url;
            if (!source) return null;
            const bytes = await loadEcommercePlanningImage(originalImageSourceUrl(source), input.origin, input.cookie);
            if (createHash("sha256").update(bytes).digest("hex") !== item.contentSha256) return null;
        }
    }
    return mutateCreativeRun<AgentRun>(
        run.id,
        AGENT_RUN_TTL_MS,
        (current, context) => {
            const checkpoint = current.ecommerceSnapshot?.referenceCheckpoint;
            if (
                !unsubmittedReferenceCheckpoint(current) ||
                context.persistedChildren.length ||
                current.userId !== input.actorId ||
                current.conversationId !== input.conversationId ||
                checkpoint?.state !== "needs_review" ||
                checkpoint.version !== frozen.version ||
                checkpoint.reviewId !== frozen.reviewId ||
                checkpoint.inputId !== frozen.inputId ||
                checkpoint.decisionId !== frozen.decisionId ||
                checkpoint.analysisStage.requestId !== frozen.analysisStage.requestId ||
                checkpoint.analysisStage.state !== frozen.analysisStage.state ||
                checkpoint.analysis?.analysisVersion !== frozen.analysis?.analysisVersion ||
                checkpoint.decision?.version !== frozen.decision?.version ||
                checkpoint.assets.length !== frozen.assets.length ||
                checkpoint.assets.some(
                    (item, index) =>
                        item.assetVersion !== frozen.assets[index].assetVersion ||
                        item.alias !== frozen.assets[index].alias ||
                        item.contentSha256 !== frozen.assets[index].contentSha256 ||
                        referenceSourceTuple(item.asset).some((value, field) => value !== referenceSourceTuple(frozen.assets[index].asset)[field]),
                )
            )
                return null;
            const consumed = {
                ...checkpoint,
                state: "consumed" as const,
                decisionId: randomUUID(),
                consumption: { id: randomUUID(), action: recovery.action, actorId: input.actorId, acceptedAt: Date.now() },
                ...(decision
                    ? { decision: decision.decision, confirmedBindings: decision.confirmedBindings }
                    : recovery.action === "retry_source"
                      ? {}
                      : {
                            analysis: undefined,
                            decision: undefined,
                            failure: undefined,
                            route: undefined,
                            confirmedBindings: undefined,
                            analysisStage: { requestId: `${current.id}:analysis:${randomUUID()}`, state: "created" as const },
                            history: [...(checkpoint.history || []), { requestId: checkpoint.analysisStage.requestId, analysis: checkpoint.analysis, decision: checkpoint.decision, failure: checkpoint.failure, route: checkpoint.route }],
                        }),
            };
            return {
                run: {
                    ...current,
                    status: "planning",
                    executionId: undefined,
                    tasks: [],
                    reviewed: false,
                    ecommerceSnapshot: {
                        ...current.ecommerceSnapshot!,
                        referenceCheckpoint: consumed,
                        referenceDecision: decision?.decision || (recovery.action === "retry_source" ? checkpoint.decision : undefined),
                        visualAnalysis: decision || recovery.action === "retry_source" ? checkpoint.analysis : undefined,
                        visualAnalysisFailure: undefined,
                        plan: undefined,
                        fallback: undefined,
                    },
                },
                event: { type: "run.reference.recovered" },
                assistant: { status: "running", content: recovery.action === "confirm_purposes" ? "已确认参考用途，继续这次创作。" : recovery.action === "retry_source" ? "正在核对参考图片，继续这次创作。" : "正在重新分析参考图片。" },
            };
        },
        ["paused"],
        undefined,
        { referenceRecovery: true },
    );
}
