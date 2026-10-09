import type { CreativeAsset } from "@/lib/creative-runtime-contract";
import type { AgentRun } from "./agent-run-store";
import type { EcommerceReferenceDecision, EcommerceReferencePurpose } from "./ecommerce-reference-purpose";

export type EcommerceReferenceRole = "product" | "scene" | "unknown";
export type EcommerceReferenceDecisionStatus = "resolved" | "needs_clarification" | "rejected";
export type EcommerceReferenceAmbiguity =
    "too_many_images" | "missing_product_reference" | "multiple_product_candidates" | "multiple_scene_candidates" | "unclassified_reference" | "multiple_history_results" | "missing_product_anchor" | "invalid_reference_selection";

export type EcommerceReferenceVisualHint = {
    assetId: string;
    confidence: "high" | "medium" | "low";
    whiteBackground: boolean;
    transparentBackground: boolean;
    isolatedSubject: boolean;
    completeScene: boolean;
};

export type ReferenceRoleDecision = {
    status: EcommerceReferenceDecisionStatus;
    productAssetId: string | null;
    sceneAssetId: string | null;
    roles: Array<{ assetId: string; role: EcommerceReferenceRole }>;
    ambiguityReason: EcommerceReferenceAmbiguity | null;
    clarificationQuestion: string | null;
};

export type EcommerceExplicitReferenceSelection = {
    assets: CreativeAsset[];
    decision: ReferenceRoleDecision;
};

export type EcommerceDualBaselineReference = EcommerceExplicitReferenceSelection & {
    results: CreativeAsset[];
};

export type EcommerceSources = {
    status: "resolved" | "needs_clarification";
    productAnchorId: string | null;
    sceneRootAssetId?: string | null;
    currentSceneBaselineId: string | null;
    sceneReferenceIds: string[];
    parentResultId: string | null;
    startsNewProductAnchor: boolean;
    createsBranch: boolean;
    ambiguityReason: EcommerceReferenceAmbiguity | null;
    clarificationQuestion: string | null;
};

export function classifyReferenceRoles(assets: CreativeAsset[], visualHints: EcommerceReferenceVisualHint[]): ReferenceRoleDecision {
    const imageAssets = uniqueReadyImages(assets);
    if (imageAssets.length > 2) return unresolvedDecision("rejected", "too_many_images");

    const hintByAssetId = new Map(visualHints.map((hint) => [hint.assetId.trim(), hint]));
    const roles = imageAssets.map((asset) => ({ assetId: asset.id, role: referenceRole(hintByAssetId.get(asset.id)) }));
    const productCandidates = roles.filter((item) => item.role === "product");
    const sceneCandidates = roles.filter((item) => item.role === "scene");
    const unknownCandidates = roles.filter((item) => item.role === "unknown");

    if (productCandidates.length > 1) return unresolvedDecision("needs_clarification", "multiple_product_candidates", roles);
    if (sceneCandidates.length > 1) return unresolvedDecision("needs_clarification", "multiple_scene_candidates", roles);
    if (unknownCandidates.length) return unresolvedDecision("needs_clarification", "unclassified_reference", roles);

    const productAssetId = productCandidates[0]?.assetId || null;
    const sceneAssetId = sceneCandidates[0]?.assetId || null;
    if (!productAssetId) {
        return {
            ...unresolvedDecision("needs_clarification", "missing_product_reference", roles),
            sceneAssetId,
        };
    }
    return {
        status: "resolved",
        productAssetId,
        sceneAssetId,
        roles,
        ambiguityReason: null,
        clarificationQuestion: null,
    };
}

export function resolveContinuitySources(run: Pick<AgentRun, "id" | "referencedAssetIds">, explicitAssets: EcommerceExplicitReferenceSelection, selectedHistory: CreativeAsset[]): EcommerceSources {
    const explicitIds = new Set(run.referencedAssetIds);
    const assetsById = new Map(explicitAssets.assets.filter((asset) => explicitIds.has(asset.id)).map((asset) => [asset.id, asset]));
    const product = explicitAssets.decision.productAssetId ? assetsById.get(explicitAssets.decision.productAssetId) : undefined;
    const scene = explicitAssets.decision.sceneAssetId ? assetsById.get(explicitAssets.decision.sceneAssetId) : undefined;
    const expectedRoleIds = [explicitAssets.decision.productAssetId, explicitAssets.decision.sceneAssetId].filter((id): id is string => Boolean(id));

    if (expectedRoleIds.some((id) => !assetsById.has(id))) return unresolvedSources("invalid_reference_selection");
    if (explicitAssets.decision.ambiguityReason && explicitAssets.decision.ambiguityReason !== "missing_product_reference") {
        return unresolvedSources(explicitAssets.decision.ambiguityReason);
    }

    const history = Array.from(new Map(selectedHistory.filter((asset) => explicitIds.has(asset.id) && asset.type === "image" && asset.status === "ready" && asset.sourceRunId).map((asset) => [asset.id, asset])).values());
    if (history.length > 1) return unresolvedSources("multiple_history_results");

    if (product) {
        return resolvedSources({
            productAnchorId: product.id,
            sceneReferenceIds: scene ? [scene.id] : [],
            startsNewProductAnchor: true,
        });
    }

    const selectedResult = history[0];
    if (!selectedResult && scene && explicitAssets.decision.ambiguityReason === "missing_product_reference") {
        return resolvedSources({
            productAnchorId: null,
            sceneRootAssetId: scene.id,
            currentSceneBaselineId: scene.id,
            sceneReferenceIds: [],
            startsNewProductAnchor: false,
            createsBranch: false,
        });
    }
    if (!selectedResult) return unresolvedSources("missing_product_anchor", scene ? [scene.id] : []);
    const productAnchorId = selectedHistoryProductAnchorId(selectedResult);
    const sceneRootAssetId = selectedHistorySceneRootAssetId(selectedResult);
    if (!productAnchorId && !sceneRootAssetId) return unresolvedSources("missing_product_anchor", scene ? [scene.id] : []);
    return resolvedSources({
        productAnchorId: productAnchorId || null,
        sceneRootAssetId: sceneRootAssetId || null,
        currentSceneBaselineId: selectedResult.id,
        sceneReferenceIds: scene ? [scene.id] : [],
        parentResultId: selectedResult.id,
        startsNewProductAnchor: false,
        createsBranch: true,
    });
}

export function resolveDualBaseline(run: Pick<AgentRun, "id" | "referencedAssetIds">, explicitReference: EcommerceDualBaselineReference): EcommerceSources {
    const selectedResults = explicitReference.results.filter((asset) => run.referencedAssetIds.includes(asset.id));
    const latestResult = selectedResults.length
        ? selectedResults[0]
        : [...explicitReference.results]
              .filter((asset) => asset.type === "image" && asset.status === "ready" && asset.sourceRunId && (selectedHistoryProductAnchorId(asset) || selectedHistorySceneRootAssetId(asset)))
              .sort((left, right) => right.createdAt - left.createdAt || right.ordinal - left.ordinal)[0];
    if (explicitReference.decision.productAssetId) {
        const sources = resolveContinuitySources(run, explicitReference, []);
        return sources.status === "resolved" && explicitReference.decision.sceneAssetId && latestResult ? { ...sources, parentResultId: latestResult.id, createsBranch: true } : sources;
    }
    if (!latestResult) return resolveContinuitySources(run, explicitReference, []);
    if (!selectedResults.length && explicitReference.decision.sceneAssetId && !selectedHistoryProductAnchorId(latestResult)) return resolveContinuitySources(run, explicitReference, []);
    const sources = resolveContinuitySources({ ...run, referencedAssetIds: [...run.referencedAssetIds, latestResult.id] }, explicitReference, selectedResults.length ? selectedResults : [latestResult]);
    if (sources.status !== "resolved" || !explicitReference.decision.sceneAssetId || !sources.productAnchorId) return sources;
    return { ...sources, currentSceneBaselineId: null, sceneReferenceIds: [explicitReference.decision.sceneAssetId] };
}

/**
 * Preserve the v4 purpose decision as the source of truth. Re-projecting it
 * through the legacy product/scene classifier loses a scene target and its
 * continuity parent, which is especially common when a new style reference is
 * paired with an existing generated scene.
 */
export function resolveSourcesFromEcommerceReferenceDecision(
    decision: Pick<EcommerceReferenceDecision, "state" | "editTargetId" | "productAnchorId" | "currentSceneBaselineId"> & { bindings: Array<{ assetId: string; purposes: EcommerceReferencePurpose[] }> },
    explicitAssets: CreativeAsset[],
    selectedHistory: CreativeAsset[] = [],
): EcommerceSources {
    if (decision.state !== "resolved") return unresolvedSources("invalid_reference_selection");

    const assets = uniqueReadyImages([...explicitAssets, ...selectedHistory]);
    const assetIds = new Set(assets.map((asset) => asset.id));
    const selectedResults = Array.from(new Map(selectedHistory.filter((asset) => assetIds.has(asset.id) && asset.type === "image" && asset.status === "ready" && Boolean(asset.sourceRunId)).map((asset) => [asset.id, asset])).values());
    if (selectedResults.length > 1) return unresolvedSources("multiple_history_results");

    const decisionIds = [decision.editTargetId, decision.productAnchorId, decision.currentSceneBaselineId, ...decision.bindings.map((binding) => binding.assetId)].filter((id): id is string => Boolean(id));
    if (decisionIds.some((id) => !assetIds.has(id))) return unresolvedSources("invalid_reference_selection");

    const sceneReferenceIds = decision.bindings
        .filter((binding) => binding.purposes.some((purpose) => ["style", "lighting", "composition"].includes(purpose)))
        .map((binding) => binding.assetId)
        .filter((id) => id !== decision.productAnchorId && id !== decision.currentSceneBaselineId);
    if (sceneReferenceIds.length > 1) return unresolvedSources("multiple_scene_candidates");
    const selectedResult = selectedResults[0];
    const parentResultId = selectedResult?.id || null;

    if (decision.currentSceneBaselineId) {
        const baseline = assets.find((asset) => asset.id === decision.currentSceneBaselineId);
        if (!baseline) return unresolvedSources("invalid_reference_selection");
        return resolvedSources({
            productAnchorId: decision.productAnchorId && decision.productAnchorId !== decision.currentSceneBaselineId ? decision.productAnchorId : null,
            sceneRootAssetId: selectedHistorySceneRootAssetId(baseline) || baseline.id,
            currentSceneBaselineId: baseline.id,
            sceneReferenceIds,
            parentResultId,
            startsNewProductAnchor: false,
            createsBranch: Boolean(parentResultId),
        });
    }

    if (decision.productAnchorId) {
        return resolvedSources({
            productAnchorId: decision.productAnchorId,
            sceneReferenceIds,
            parentResultId,
            startsNewProductAnchor: !parentResultId,
            createsBranch: Boolean(parentResultId),
        });
    }

    return unresolvedSources("missing_product_anchor", sceneReferenceIds);
}

export function ecommerceProductAnchorIdFromRun(run: Pick<AgentRun, "ecommerceSnapshot">): string | undefined {
    return normalizedId(run.ecommerceSnapshot?.plan?.source.productAnchorId);
}

function uniqueReadyImages(assets: CreativeAsset[]) {
    return Array.from(new Map(assets.filter((asset) => asset.type === "image" && asset.status === "ready" && normalizedId(asset.id)).map((asset) => [asset.id, asset])).values());
}

function referenceRole(hint: EcommerceReferenceVisualHint | undefined): EcommerceReferenceRole {
    if (!hint || hint.confidence !== "high") return "unknown";
    const productEvidence = hint.isolatedSubject && (hint.whiteBackground || hint.transparentBackground) && !hint.completeScene;
    const sceneEvidence = hint.completeScene && !hint.whiteBackground && !hint.transparentBackground;
    if (productEvidence === sceneEvidence) return "unknown";
    return productEvidence ? "product" : "scene";
}

function selectedHistoryProductAnchorId(asset: CreativeAsset) {
    const continuity = isRecord(asset.metadata.ecommerceContinuity) ? asset.metadata.ecommerceContinuity : undefined;
    if (continuity?.productAnchorId === null || normalizedId(continuity?.sceneRootAssetId)) return normalizedId(continuity?.productAnchorId);
    return normalizedId(continuity?.productAnchorId) || normalizedId(asset.parentAssetId);
}

function selectedHistorySceneRootAssetId(asset: CreativeAsset) {
    const continuity = isRecord(asset.metadata.ecommerceContinuity) ? asset.metadata.ecommerceContinuity : undefined;
    return normalizedId(continuity?.sceneRootAssetId);
}

function unresolvedDecision(status: "needs_clarification" | "rejected", reason: EcommerceReferenceAmbiguity, roles: ReferenceRoleDecision["roles"] = []): ReferenceRoleDecision {
    return {
        status,
        productAssetId: null,
        sceneAssetId: null,
        roles,
        ambiguityReason: reason,
        clarificationQuestion: clarificationQuestion(reason),
    };
}

function resolvedSources(input: Partial<EcommerceSources> & Pick<EcommerceSources, "productAnchorId">): EcommerceSources {
    return {
        status: "resolved",
        productAnchorId: input.productAnchorId,
        sceneRootAssetId: input.sceneRootAssetId || null,
        currentSceneBaselineId: input.currentSceneBaselineId || null,
        sceneReferenceIds: input.sceneReferenceIds || [],
        parentResultId: input.parentResultId || null,
        startsNewProductAnchor: input.startsNewProductAnchor || false,
        createsBranch: input.createsBranch || false,
        ambiguityReason: null,
        clarificationQuestion: null,
    };
}

function unresolvedSources(reason: EcommerceReferenceAmbiguity, sceneReferenceIds: string[] = []): EcommerceSources {
    return {
        status: "needs_clarification",
        productAnchorId: null,
        sceneRootAssetId: null,
        currentSceneBaselineId: null,
        sceneReferenceIds,
        parentResultId: null,
        startsNewProductAnchor: false,
        createsBranch: false,
        ambiguityReason: reason,
        clarificationQuestion: clarificationQuestion(reason),
    };
}

function clarificationQuestion(reason: EcommerceReferenceAmbiguity) {
    switch (reason) {
        case "too_many_images":
            return "首期最多支持一张商品图和一张场景参考图，请只保留两张图片。";
        case "missing_product_reference":
            return "请再提供一张需要保留商品外观的商品图。";
        case "multiple_product_candidates":
            return "检测到多张商品候选图，请只保留一张商品图。";
        case "multiple_scene_candidates":
            return "检测到多张场景候选图，请只保留一张场景参考图。";
        case "unclassified_reference":
            return "请确认这张图片是商品图还是场景参考图。";
        case "multiple_history_results":
            return "请只选择一张历史结果继续编辑。";
        case "missing_product_anchor":
            return "无法确认这张历史结果对应的原始商品图，请重新提供商品图。";
        case "invalid_reference_selection":
            return "参考图片与当前请求不一致，请重新选择图片。";
    }
}

function normalizedId(value: unknown) {
    return typeof value === "string" ? value.trim() || undefined : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
