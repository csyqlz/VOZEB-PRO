import { refundUserPoints } from "@/lib/auth/store";
import { createHash } from "node:crypto";
import { originalImageSourceUrl } from "@/lib/media-image-url";
import { CREATIVE_UPLOAD_MAX_BYTES } from "@/lib/creative-upload";
import { fetchInternalApi } from "@/lib/server/internal-origin";
import { maintenanceWorkerContextHeaders } from "@/lib/server/maintenance-auth";
import { fetchSafeOutbound } from "@/lib/server/safe-outbound-fetch";
import { hasSystemAiCharge, readSystemAiBilling, systemAiBillingHeaders, systemAiIdempotencyKey } from "@/lib/server/system-ai-billing";

import { parseValidatedAgentFunctionCall } from "./agent-function-call";
import {
    ecommercePhotographySchema,
    normalizeEcommercePhotographyPlan,
    ecommerceVisibleStructureSchema,
    normalizeEcommerceVisibleStructure,
    type EcommercePhotographyPlan,
    type EcommerceDimensions,
    type EcommerceVisibleStructure,
    type EcommerceProductFacts,
    type EcommerceSceneFacts,
    type EcommerceManualRegion,
} from "./ecommerce-edit-plan";
import { decodeEcommerceCanvasSize } from "./ecommerce-generation-service";
import type { EcommercePlanningAssetCandidate, EcommercePlanningInput } from "./ecommerce-generation-snapshot";
import type { EcommerceRoleCandidate, EcommerceRoleRouteSnapshot } from "./ecommerce-model-routing";
import { boundEcommerceVisionImage } from "./ecommerce-vision-image";
import { rankTextPlanningCandidates, requestStructuredText, TextPlanningRequestError, type TextPlanningBodyMeasurement } from "./text-planning-runtime";
import { SYSTEM_PROXY_JSON_BODY_MAX_BYTES } from "./system-proxy-request-limits";
import { ECOMMERCE_REFERENCE_PURPOSES, type EcommerceReferencePurposeSuggestion, type EcommerceReferenceIssue } from "./ecommerce-reference-purpose";

export const ECOMMERCE_VISUAL_ANALYSIS_VERSION = "ecommerce-visual-analysis.v3" as const;
export const ECOMMERCE_VISUAL_ANALYSIS_V4_VERSION = "ecommerce-visual-analysis.v4" as const;

export type EcommerceNormalizedRegion = { x: number; y: number; width: number; height: number };
export type EcommerceEditableTargetKind = "background" | "environment" | "prop" | "lighting" | "shadow";
export type EcommerceEditableTarget = {
    id: string;
    kind: EcommerceEditableTargetKind;
    label: string;
    region: EcommerceNormalizedRegion;
};
export type EcommerceVisualReference = {
    assetId: string;
    role: "product" | "scene" | "unknown";
    confidence: "high" | "medium" | "low";
    visualEvidence: {
        whiteBackground: boolean;
        transparentBackground: boolean;
        isolatedSubject: boolean;
        completeScene: boolean;
    };
    productFacts: EcommerceProductFacts | null;
    sceneFacts: EcommerceSceneFacts | null;
    productCore: EcommerceNormalizedRegion | null;
    fusionHalo: EcommerceNormalizedRegion | null;
    editableTargets: EcommerceEditableTarget[];
    visibleStructure?: EcommerceVisibleStructure[];
    photographyFacts?: EcommercePhotographyPlan;
    sourceSize?: EcommerceDimensions;
};
export type EcommerceVisualAnalysisContract = {
    analysisVersion: typeof ECOMMERCE_VISUAL_ANALYSIS_VERSION | "ecommerce-visual-analysis.v2" | "ecommerce-visual-analysis.v1";
    references: EcommerceVisualReference[];
};
export type EcommerceReferenceContentType = "isolated_product" | "product_detail" | "interior_scene" | "unknown";
export type EcommerceReferenceCue = {
    id: string;
    facet: "style" | "lighting" | "composition" | "material_appearance";
    description: string;
    confidence: "high" | "medium" | "low";
    evidenceRegion?: EcommerceManualRegion;
};
export type EcommerceVisualReferenceV4 = Omit<EcommerceVisualReference, "role" | "visibleStructure"> & {
    contentType: EcommerceReferenceContentType;
    visibleStructure: EcommerceVisibleStructure[];
    cues: EcommerceReferenceCue[];
};
export type EcommerceVisualAnalysisV4Contract = {
    analysisVersion: typeof ECOMMERCE_VISUAL_ANALYSIS_V4_VERSION;
    references: EcommerceVisualReferenceV4[];
    purposeSuggestions: EcommerceReferencePurposeSuggestion[];
    rawAnalysis: Record<string, unknown>;
    normalizationAudit: Array<{ path: string; rawValue: number; normalizedValue: null; reason: "uncertain_count" }>;
};
export type EcommerceVisualAnalysisV4Validation = {
    analysis: EcommerceVisualAnalysisV4Contract | null;
    issues: EcommerceReferenceIssue[];
    rawAnalysis: unknown;
    normalizationAudit: EcommerceVisualAnalysisV4Contract["normalizationAudit"];
};
export type EcommerceVisualAnalysis = EcommerceVisualAnalysisContract & {
    visionEvidence?: { imageCount: number; transmissions: TextPlanningBodyMeasurement[] };
    modelRole: Pick<EcommerceRoleRouteSnapshot, "logicalModelId" | "channelId" | "upstreamModel"> & Partial<Pick<EcommerceRoleRouteSnapshot, "capability" | "apiFormat">> & { logicalRole: "vision_analysis" };
};
export type EcommerceVisualAnalysisV4 = EcommerceVisualAnalysisV4Contract & Pick<EcommerceVisualAnalysis, "modelRole" | "visionEvidence">;
export type EcommerceVisualAnalysisRequest = {
    origin: string;
    cookie: string;
    userId: string;
    requestId: string;
    planningInput: EcommercePlanningInput;
    onSourcesLoaded?: (sources: EcommerceVisualSourceIdentity[]) => Promise<void>;
};

export type EcommerceVisualSourceIdentity = { assetId: string; contentSha256: string; sourceSize: EcommerceDimensions };

export type EcommerceVisualAnalysisFailure = {
    analysisVersion: typeof ECOMMERCE_VISUAL_ANALYSIS_VERSION | typeof ECOMMERCE_VISUAL_ANALYSIS_V4_VERSION;
    kind: "input_media" | "invalid_structure" | "transport" | "service_unavailable" | "authentication" | "rate_limited" | "unexpected";
    attempts: Array<{
        modelRole: EcommerceVisualAnalysis["modelRole"];
        kind: EcommerceVisualAnalysisFailure["kind"];
        status: number;
        elapsedMs: number;
        failureCode?: string;
        validation?: Omit<EcommerceVisualAnalysisV4Validation, "analysis">;
    }>;
};

export class EcommerceVisualAnalysisError extends Error {
    constructor(
        message: string,
        readonly status = 502,
        readonly failure?: EcommerceVisualAnalysisFailure,
    ) {
        super(message);
        this.name = "EcommerceVisualAnalysisError";
    }
}

export function analyzeEcommerceReferences(input: EcommerceVisualAnalysisRequest & { analysisVersion: typeof ECOMMERCE_VISUAL_ANALYSIS_V4_VERSION }, candidates: EcommerceRoleCandidate[]): Promise<EcommerceVisualAnalysisV4>;
export function analyzeEcommerceReferences(input: EcommerceVisualAnalysisRequest, candidates: EcommerceRoleCandidate[]): Promise<EcommerceVisualAnalysis>;
export async function analyzeEcommerceReferences(
    input: EcommerceVisualAnalysisRequest & { analysisVersion?: typeof ECOMMERCE_VISUAL_ANALYSIS_V4_VERSION },
    candidates: EcommerceRoleCandidate[],
): Promise<EcommerceVisualAnalysis | EcommerceVisualAnalysisV4> {
    assertRoleCandidates(candidates, "vision_analysis");
    if (!candidates.length) throw new EcommerceVisualAnalysisError("视觉分析角色没有可用模型", 503);
    const assets = input.planningInput.assetCandidates;
    const analysisVersion = input.analysisVersion || ECOMMERCE_VISUAL_ANALYSIS_VERSION;
    const inherited = input.planningInput.inheritedReferences;
    const aliases = input.planningInput.referenceAliases || [];
    const inheritedIds = new Set(inherited ? [inherited.editTargetId, ...(inherited.productAnchorId ? [inherited.productAnchorId] : [])] : []);
    const explicitIds = new Set(aliases.map((alias) => alias.assetId));
    const validInheritedInputs =
        analysisVersion === ECOMMERCE_VISUAL_ANALYSIS_V4_VERSION &&
        inherited &&
        aliases.length <= 2 &&
        explicitIds.size === aliases.length &&
        [...inheritedIds, ...explicitIds].every((id) => assets.some((asset) => asset.id === id)) &&
        assets.every((asset) => explicitIds.has(asset.id) || inheritedIds.has(asset.id));
    if (!assets.length || (assets.length > 2 && !validInheritedInputs) || new Set(assets.map((asset) => asset.id)).size !== assets.length || assets.some((asset) => asset.type !== "image" || !asset.url?.trim())) {
        throw new EcommerceVisualAnalysisError("视觉分析需要一至两张可访问的图片", 400);
    }
    let images: Awaited<ReturnType<typeof normalizePlanningImage>>[];
    try {
        images = await Promise.all(assets.map((asset) => normalizePlanningImage(asset.url!, input.origin, input.cookie)));
    } catch (error) {
        throw new EcommerceVisualAnalysisError(error instanceof Error ? error.message : "无法读取视觉分析图片", error instanceof EcommerceVisualAnalysisError ? error.status : 400, { analysisVersion, kind: "input_media", attempts: [] });
    }
    // This callback commits the phase and original source bytes before any model
    // transport. A failed commit must escape the candidate/failover loop.
    await input.onSourcesLoaded?.(images.map((image, index) => ({ assetId: assets[index].id, contentSha256: image.contentSha256, sourceSize: image.size })));
    const decodedAssets = assets.map((asset, index) => ({ ...asset, ...images[index].size }));
    const messages = (analysisVersion === ECOMMERCE_VISUAL_ANALYSIS_V4_VERSION ? visualAnalysisV4Messages : visualAnalysisMessages)(
        input.planningInput,
        decodedAssets,
        images.map((image) => image.url),
    );
    let latestError: unknown;
    const attempts: EcommerceVisualAnalysisFailure["attempts"] = [];
    for (const candidate of rankTextPlanningCandidates(candidates)) {
        const idempotencyKey = systemAiIdempotencyKey("ecommerce-visual-analysis", input.userId, input.requestId, candidate.logicalModelId, candidate.channelId, candidate.upstreamModel);
        const startedAt = Date.now();
        let lastValidation: EcommerceVisualAnalysisV4Validation | undefined;
        const validateV4 = (value: unknown) => {
            lastValidation = validateEcommerceVisualAnalysisV4(value, decodedAssets);
            return lastValidation;
        };
        try {
            const transmissions: TextPlanningBodyMeasurement[] = [];
            const call = await requestStructuredText({
                origin: input.origin,
                cookie: input.cookie,
                candidate,
                messages,
                tool:
                    analysisVersion === ECOMMERCE_VISUAL_ANALYSIS_V4_VERSION
                        ? {
                              ...ecommerceVisualAnalysisV4Tool,
                              parameters: {
                                  ...ecommerceVisualAnalysisV4Tool.parameters,
                                  properties: { ...ecommerceVisualAnalysisV4Tool.parameters.properties, references: { ...ecommerceVisualAnalysisV4Tool.parameters.properties.references, minItems: assets.length, maxItems: assets.length } },
                              },
                          }
                        : ecommerceVisualAnalysisTool,
                headers: systemAiBillingHeaders(candidate.logicalModelId, idempotencyKey, candidate.upstreamModel),
                preferNativeTools: true,
                requestBodyBudget: { maxBytes: SYSTEM_PROXY_JSON_BODY_MAX_BYTES, onMeasured: (measurement) => transmissions.push(measurement) },
                validateArguments: (argumentsText) => {
                    if (analysisVersion !== ECOMMERCE_VISUAL_ANALYSIS_V4_VERSION) return parseAnalysis(argumentsText, decodedAssets, analysisVersion) !== null;
                    let raw: unknown;
                    try {
                        raw = JSON.parse(argumentsText);
                    } catch {
                        raw = argumentsText;
                    }
                    const validation = validateV4(raw);
                    return { valid: Boolean(validation.analysis), issues: validation.issues };
                },
                onInvalidResponse: (headers) => refundInvalidResponse(input.userId, candidate.logicalModelId, headers),
            });
            const analysis = await parseValidatedAgentFunctionCall(
                call,
                (value) => (analysisVersion === ECOMMERCE_VISUAL_ANALYSIS_V4_VERSION ? validateV4(value).analysis : isRecord(value) && value.analysisVersion === analysisVersion ? normalizeEcommerceVisualAnalysis(value, decodedAssets) : null),
                () => refundInvalidResponse(input.userId, candidate.logicalModelId, call.headers),
                "视觉分析模型返回的字段不完整",
            );
            return {
                ...analysis,
                modelRole: candidate.snapshot as EcommerceVisualAnalysis["modelRole"],
                visionEvidence: { imageCount: images.length, transmissions },
            };
        } catch (error) {
            latestError = error;
            const status = error instanceof TextPlanningRequestError || error instanceof EcommerceVisualAnalysisError ? error.status : 502;
            const kind: EcommerceVisualAnalysisFailure["kind"] =
                (error instanceof TextPlanningRequestError && error.reason === "invalid-structure") || (!(error instanceof TextPlanningRequestError) && lastValidation && !lastValidation.analysis)
                    ? "invalid_structure"
                    : error instanceof TextPlanningRequestError && error.reason === "transport"
                      ? "transport"
                      : status === 401 || status === 403
                        ? "authentication"
                        : status === 429
                          ? "rate_limited"
                          : status >= 500
                            ? "service_unavailable"
                            : "unexpected";
            attempts.push({
                modelRole: { ...candidate.snapshot, logicalRole: "vision_analysis" },
                kind,
                status,
                elapsedMs: Date.now() - startedAt,
                ...(error instanceof TextPlanningRequestError && error.failureCode ? { failureCode: error.failureCode } : {}),
                ...(lastValidation && !lastValidation.analysis ? { validation: { issues: lastValidation.issues, rawAnalysis: lastValidation.rawAnalysis, normalizationAudit: lastValidation.normalizationAudit } } : {}),
            });
        }
    }
    throw new EcommerceVisualAnalysisError(latestError instanceof Error ? latestError.message : "视觉分析失败，请检查模型角色配置", attempts.at(-1)?.status || 502, { analysisVersion, kind: attempts.at(-1)?.kind || "unexpected", attempts });
}

export function normalizeEcommerceVisualAnalysis(value: unknown, assets: EcommercePlanningAssetCandidate[]): EcommerceVisualAnalysisContract | EcommerceVisualAnalysisV4Contract | null {
    if (isRecord(value) && value.analysisVersion === ECOMMERCE_VISUAL_ANALYSIS_V4_VERSION) return validateEcommerceVisualAnalysisV4(value, assets).analysis;
    if (!isRecord(value) || ![ECOMMERCE_VISUAL_ANALYSIS_VERSION, "ecommerce-visual-analysis.v2", "ecommerce-visual-analysis.v1"].includes(String(value.analysisVersion)) || !Array.isArray(value.references)) return null;
    const expectedIds = new Set(assets.map((asset) => asset.id));
    if (expectedIds.size !== assets.length || value.references.length !== assets.length) return null;
    const references = value.references.map(normalizeReference);
    if (references.some((reference) => !reference)) return null;
    const normalized = references as EcommerceVisualReference[];
    const actualIds = new Set(normalized.map((reference) => reference.assetId));
    if (actualIds.size !== normalized.length || actualIds.size !== expectedIds.size || [...actualIds].some((id) => !expectedIds.has(id))) return null;
    if ([ECOMMERCE_VISUAL_ANALYSIS_VERSION, "ecommerce-visual-analysis.v2"].includes(String(value.analysisVersion))) {
        for (const [index, reference] of normalized.entries()) {
            const rawReference = value.references[index];
            const structure = isRecord(rawReference) ? normalizeEcommerceVisibleStructure(rawReference.visibleStructure) : null;
            if (!structure) return null;
            const asset = assets.find((asset) => asset.id === reference.assetId)!;
            if (asset.width && asset.height) {
                if (structure.some(({ evidenceRegion: r }) => r.x + r.width > asset.width! || r.y + r.height > asset.height!)) return null;
                reference.sourceSize = { width: asset.width, height: asset.height };
            }
            reference.visibleStructure = structure;
            if (isRecord(rawReference) && rawReference.photographyFacts !== undefined) {
                if (value.analysisVersion !== ECOMMERCE_VISUAL_ANALYSIS_VERSION || reference.role === "unknown") return null;
                const facts = normalizeEcommercePhotographyPlan(rawReference.photographyFacts);
                if (!facts) return null;
                reference.photographyFacts = facts;
            }
        }
    } else if (value.references.some((reference) => isRecord(reference) && (reference.visibleStructure !== undefined || reference.photographyFacts !== undefined))) return null;
    return { analysisVersion: value.analysisVersion as EcommerceVisualAnalysisContract["analysisVersion"], references: normalized };
}

export function validateEcommerceVisualAnalysisV4(value: unknown, assets: EcommercePlanningAssetCandidate[]): EcommerceVisualAnalysisV4Validation {
    const issues: EcommerceReferenceIssue[] = [];
    const issue = (path: string, message: string) => issues.push({ code: "visual_field_invalid", path, message });
    if (!isRecord(value) || value.analysisVersion !== ECOMMERCE_VISUAL_ANALYSIS_V4_VERSION || !Array.isArray(value.references)) {
        issue(isRecord(value) && value.analysisVersion === ECOMMERCE_VISUAL_ANALYSIS_V4_VERSION ? "references" : "analysisVersion", "视觉分析版本或图片事实列表无效");
        return { analysis: null, issues, rawAnalysis: structuredClone(value), normalizationAudit: [] };
    }
    const assetById = new Map(assets.map((asset) => [asset.id, asset]));
    if (assetById.size !== assets.length || value.references.length !== assets.length) issue("references", "视觉事实必须逐张对应本次输入图片");
    const rawAnalysis = structuredClone(value);
    const normalizationAudit: EcommerceVisualAnalysisV4Contract["normalizationAudit"] = [];
    const references: EcommerceVisualReferenceV4[] = [];
    const seen = new Set<string>();
    for (const [index, raw] of value.references.entries()) {
        const path = `references[${index}]`;
        if (!isRecord(raw)) {
            issue(path, "图片事实必须是对象");
            continue;
        }
        const assetId = text(raw.assetId);
        const asset = assetById.get(assetId);
        if (!asset || seen.has(assetId)) issue(`${path}.assetId`, "图片身份必须唯一且属于本次输入");
        seen.add(assetId);
        if (!["isolated_product", "product_detail", "interior_scene", "unknown"].includes(String(raw.contentType))) issue(`${path}.contentType`, "图片内容类别无效");
        if (!["high", "medium", "low"].includes(String(raw.confidence))) issue(`${path}.confidence`, "图片内容置信度无效");
        const visualEvidence = normalizeEvidence(raw.visualEvidence);
        if (!isRecord(raw.visualEvidence)) issue(`${path}.visualEvidence`, "必须保存原图片视觉证据");
        else for (const key of ["whiteBackground", "transparentBackground", "isolatedSubject", "completeScene"]) if (typeof raw.visualEvidence[key] !== "boolean") issue(`${path}.visualEvidence.${key}`, "视觉证据必须是布尔值");
        const productFacts = normalizeProductFacts(raw.productFacts);
        if (raw.productFacts !== null && !productFacts) {
            if (!isRecord(raw.productFacts)) issue(`${path}.productFacts`, "商品事实必须完整或为 null");
            else {
                for (const key of ["identity", "outline", "color", "material", "view"]) if (!text(raw.productFacts[key])) issue(`${path}.productFacts.${key}`, "缺少可靠的商品事实");
                if (!stringArray(raw.productFacts.brandText)) issue(`${path}.productFacts.brandText`, "商品品牌文字必须是字符串列表");
            }
        }
        const sceneFacts = normalizeSceneFacts(raw.sceneFacts);
        if (raw.sceneFacts !== null && !sceneFacts) {
            if (!isRecord(raw.sceneFacts)) issue(`${path}.sceneFacts`, "场景事实必须完整或为 null");
            else for (const key of ["space", "composition", "lighting"]) if (!text(raw.sceneFacts[key])) issue(`${path}.sceneFacts.${key}`, "缺少实际观察的场景事实");
        }
        if (raw.contentType === "isolated_product" && (sceneFacts || visualEvidence?.completeScene || visualEvidence?.isolatedSubject === false)) issue(`${path}.contentType`, "独立商品内容与视觉事实矛盾");
        const productCore = normalizeRegion(raw.productCore);
        const fusionHalo = normalizeRegion(raw.fusionHalo);
        for (const [key, region] of [
            ["productCore", productCore],
            ["fusionHalo", fusionHalo],
        ] as const)
            if (raw[key] !== null && !region) issue(`${path}.${key}`, "保护区域必须是有效归一化坐标或 null");
        if (
            Boolean(productCore) !== Boolean(fusionHalo) ||
            (productCore && fusionHalo && (fusionHalo.x > productCore.x || fusionHalo.y > productCore.y || fusionHalo.x + fusionHalo.width < productCore.x + productCore.width || fusionHalo.y + fusionHalo.height < productCore.y + productCore.height))
        )
            issue(`${path}.fusionHalo`, "融合区域必须完整包围商品核心区域");
        const editableTargets = normalizeEditableTargets(raw.editableTargets);
        if (!editableTargets) issue(`${path}.editableTargets`, "可编辑候选区域无效");
        const structureValue = structuredClone(raw.visibleStructure);
        if (Array.isArray(structureValue))
            for (const [structureIndex, entry] of structureValue.entries()) {
                if (!isRecord(entry)) continue;
                const countPath = `${path}.visibleStructure[${structureIndex}].count`;
                if (entry.certainty === "uncertain" && Number.isSafeInteger(entry.count) && (entry.count as number) >= 0) {
                    normalizationAudit.push({ path: countPath, rawValue: entry.count as number, normalizedValue: null, reason: "uncertain_count" });
                    entry.count = null;
                } else if (entry.certainty === "confirmed" ? !Number.isSafeInteger(entry.count) || (entry.count as number) < 0 : entry.certainty === "uncertain" && entry.count !== null)
                    issue(countPath, "已确认数量必须是非负安全整数；不确定数量只能为 null");
                if (!["confirmed", "uncertain"].includes(String(entry.certainty))) issue(`${path}.visibleStructure[${structureIndex}].certainty`, "结构确定性无效");
                if (!normalizePixelRegion(entry.evidenceRegion, asset)) issue(`${path}.visibleStructure[${structureIndex}].evidenceRegion`, "结构证据必须使用有效原文件像素区域");
            }
        const visibleStructure = normalizeEcommerceVisibleStructure(structureValue);
        if (!visibleStructure) issue(`${path}.visibleStructure`, "可见结构字段无效或重复");
        const cues: EcommerceReferenceCue[] = [];
        if (!Array.isArray(raw.cues)) issue(`${path}.cues`, "局部视觉线索必须是数组");
        else
            for (const [cueIndex, cue] of raw.cues.entries()) {
                const cuePath = `${path}.cues[${cueIndex}]`;
                if (!isRecord(cue)) {
                    issue(cuePath, "视觉线索必须是对象");
                    continue;
                }
                if (!text(cue.id) || cues.some((item) => item.id === text(cue.id))) issue(`${cuePath}.id`, "视觉线索身份必须非空且唯一");
                if (!["style", "lighting", "composition", "material_appearance"].includes(String(cue.facet))) issue(`${cuePath}.facet`, "视觉线索类别无效");
                if (!text(cue.description)) issue(`${cuePath}.description`, "视觉线索必须有实际观察描述");
                if (!["high", "medium", "low"].includes(String(cue.confidence))) issue(`${cuePath}.confidence`, "视觉线索置信度无效");
                const evidenceRegion = cue.evidenceRegion === undefined ? undefined : normalizePixelRegion(cue.evidenceRegion, asset);
                if (cue.evidenceRegion !== undefined && !evidenceRegion) issue(`${cuePath}.evidenceRegion`, "线索证据必须使用有效原文件像素区域");
                cues.push({ id: text(cue.id), facet: cue.facet as EcommerceReferenceCue["facet"], description: text(cue.description), confidence: cue.confidence as EcommerceReferenceCue["confidence"], ...(evidenceRegion ? { evidenceRegion } : {}) });
            }
        const photographyFacts = raw.photographyFacts === undefined ? undefined : normalizeEcommercePhotographyPlan(raw.photographyFacts);
        if (raw.photographyFacts !== undefined && !photographyFacts) issue(`${path}.photographyFacts`, "摄影事实必须完整；局部事实应使用 cues");
        if (visualEvidence && editableTargets && visibleStructure)
            references.push({
                assetId,
                contentType: raw.contentType as EcommerceReferenceContentType,
                confidence: raw.confidence as EcommerceVisualReferenceV4["confidence"],
                visualEvidence,
                productFacts,
                sceneFacts,
                productCore,
                fusionHalo,
                editableTargets,
                visibleStructure,
                cues,
                ...(photographyFacts ? { photographyFacts } : {}),
                ...(asset?.width && asset.height ? { sourceSize: { width: asset.width, height: asset.height } } : {}),
            });
    }
    const purposeSuggestions: EcommerceReferencePurposeSuggestion[] = [];
    if (!Array.isArray(value.purposeSuggestions)) issue("purposeSuggestions", "用途建议必须是独立列表");
    else
        for (const [index, suggestion] of value.purposeSuggestions.entries()) {
            const path = `purposeSuggestions[${index}]`;
            if (!isRecord(suggestion)) {
                issue(path, "用途建议必须是对象");
                continue;
            }
            const assetId = text(suggestion.assetId);
            if (!assetById.has(assetId) || purposeSuggestions.some((item) => item.assetId === assetId)) issue(`${path}.assetId`, "建议只能引用本次图片且不得重复");
            if (!Array.isArray(suggestion.purposes) || !suggestion.purposes.length || new Set(suggestion.purposes).size !== suggestion.purposes.length || suggestion.purposes.some((purpose) => !ECOMMERCE_REFERENCE_PURPOSES.includes(purpose)))
                issue(`${path}.purposes`, "用途建议必须使用明确用途列表");
            if (!["high", "medium", "low"].includes(String(suggestion.confidence))) issue(`${path}.confidence`, "用途建议置信度无效");
            purposeSuggestions.push({ assetId, purposes: suggestion.purposes as EcommerceReferencePurposeSuggestion["purposes"], confidence: suggestion.confidence as EcommerceReferencePurposeSuggestion["confidence"] });
        }
    return { analysis: issues.length ? null : { analysisVersion: ECOMMERCE_VISUAL_ANALYSIS_V4_VERSION, references, purposeSuggestions, rawAnalysis, normalizationAudit }, issues, rawAnalysis, normalizationAudit };
}

function normalizePixelRegion(value: unknown, asset: EcommercePlanningAssetCandidate | undefined): EcommerceManualRegion | undefined {
    if (!isRecord(value)) return undefined;
    const region = { x: value.x, y: value.y, width: value.width, height: value.height };
    if (!Object.values(region).every(Number.isSafeInteger)) return undefined;
    const typed = region as EcommerceManualRegion;
    if (typed.x < 0 || typed.y < 0 || typed.width <= 0 || typed.height <= 0 || (asset?.width && typed.x + typed.width > asset.width) || (asset?.height && typed.y + typed.height > asset.height)) return undefined;
    return typed;
}

function normalizeReference(value: unknown): EcommerceVisualReference | null {
    if (!isRecord(value)) return null;
    const assetId = text(value.assetId);
    const role = value.role;
    const confidence = value.confidence;
    const evidence = normalizeEvidence(value.visualEvidence);
    if (!assetId || !["product", "scene", "unknown"].includes(String(role)) || !["high", "medium", "low"].includes(String(confidence)) || !evidence) return null;
    const productFacts = normalizeProductFacts(value.productFacts);
    const sceneFacts = normalizeSceneFacts(value.sceneFacts);
    const productCore = normalizeRegion(value.productCore);
    const fusionHalo = normalizeRegion(value.fusionHalo);
    const editableTargets = normalizeEditableTargets(value.editableTargets);
    if (!editableTargets || Boolean(productCore) !== Boolean(fusionHalo)) return null;
    const productEvidence = evidence.isolatedSubject && (evidence.whiteBackground || evidence.transparentBackground) && !evidence.completeScene;
    const sceneEvidence = evidence.completeScene && !evidence.whiteBackground && !evidence.transparentBackground;
    if (confidence === "high" && role === "product" && !productEvidence) return null;
    if (confidence === "high" && role === "scene" && !sceneEvidence) return null;
    if (role === "product" && (!productFacts || sceneFacts || !productCore || !fusionHalo || editableTargets.length)) return null;
    if (role === "scene" && (productFacts || !sceneFacts)) return null;
    if (role === "unknown" && (productFacts || sceneFacts || productCore || fusionHalo || editableTargets.length)) return null;
    return {
        assetId,
        role: role as EcommerceVisualReference["role"],
        confidence: confidence as EcommerceVisualReference["confidence"],
        visualEvidence: evidence,
        productFacts,
        sceneFacts,
        productCore,
        fusionHalo,
        editableTargets,
    };
}

function normalizeProductFacts(value: unknown): EcommerceProductFacts | null {
    if (!isRecord(value)) return null;
    const brandText = stringArray(value.brandText);
    if (!brandText) return null;
    const facts = {
        identity: text(value.identity),
        outline: text(value.outline),
        color: text(value.color),
        material: text(value.material),
        brandText,
        view: text(value.view),
    };
    return facts.identity && facts.outline && facts.color && facts.material && facts.view ? facts : null;
}

function normalizeSceneFacts(value: unknown): EcommerceSceneFacts | null {
    if (!isRecord(value)) return null;
    const facts = { space: text(value.space), composition: text(value.composition), lighting: text(value.lighting) };
    return facts.space && facts.composition && facts.lighting ? facts : null;
}

function normalizeEvidence(value: unknown) {
    if (!isRecord(value)) return null;
    const keys = ["whiteBackground", "transparentBackground", "isolatedSubject", "completeScene"] as const;
    if (keys.some((key) => typeof value[key] !== "boolean")) return null;
    return Object.fromEntries(keys.map((key) => [key, value[key]])) as EcommerceVisualReference["visualEvidence"];
}

function normalizeRegion(value: unknown): EcommerceNormalizedRegion | null {
    if (value === null) return null;
    if (!isRecord(value)) return null;
    const region = { x: value.x, y: value.y, width: value.width, height: value.height };
    if (Object.values(region).some((item) => typeof item !== "number" || !Number.isFinite(item))) return null;
    const typed = region as EcommerceNormalizedRegion;
    if (typed.x < 0 || typed.y < 0 || typed.width <= 0 || typed.height <= 0 || typed.x + typed.width > 1 || typed.y + typed.height > 1) return null;
    return typed;
}

function normalizeEditableTargets(value: unknown): EcommerceEditableTarget[] | null {
    if (!Array.isArray(value)) return null;
    const targets = value.map((item) => {
        if (!isRecord(item)) return null;
        const id = text(item.id);
        const label = text(item.label);
        const kind = item.kind;
        const region = normalizeRegion(item.region);
        if (!id || !label || !["background", "environment", "prop", "lighting", "shadow"].includes(String(kind)) || !region) return null;
        return { id, kind: kind as EcommerceEditableTargetKind, label, region };
    });
    if (targets.some((target) => !target)) return null;
    const normalized = targets as EcommerceEditableTarget[];
    return new Set(normalized.map((target) => target.id)).size === normalized.length ? normalized : null;
}

function visualAnalysisMessages(planningInput: EcommercePlanningInput, assets: EcommercePlanningAssetCandidate[], images: string[]) {
    const content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [
        {
            type: "text",
            text: JSON.stringify({
                userRequest: planningInput.userRequest,
                assets: assets.map((asset) => ({ id: asset.id, title: asset.title, width: asset.width, height: asset.height })),
                rule: "每张图片必须按给定 assetId 独立判断；不得按标题、顺序或用户描述猜测角色。visibleStructure 对商品和场景中的受保护家具都适用，只数可见抽屉、柜门、把手、支腿；遮挡或不确定时 count=null、certainty=uncertain。evidenceRegion 使用服务端提供的原文件宽高下的像素坐标，不使用传输缩略图坐标。空数组不代表结构核验通过。photographyFacts 仅记录原图可见事实：逐对象纹理方向和尺度、粗糙度与光泽、主光方向与面积、补光、白平衡、接触阴影、商品明度层次、留白和纵深；不能推测材质参数、隐藏细节或写优化目标。不能可靠观察全部摄影事实时省略该字段，materials 仅包含确认可见的对象；跨图同一对象使用稳定 objectId。",
            }),
        },
    ];
    assets.forEach((asset, index) => {
        content.push({ type: "text", text: `assetId=${asset.id}` }, { type: "image_url", image_url: { url: images[index] } });
    });
    return [
        {
            role: "system" as const,
            content:
                "你是电商商品视觉分析模型。逐图识别商品或场景，商品事实只能来自商品图，场景事实只能来自场景图。角色约束：role=product 时 productFacts 必须是完整商品事实，sceneFacts 必须为 null，productCore 与 fusionHalo 均不得为 null，fusionHalo 必须完整包围 productCore，editableTargets 必须为空；role=scene 时 productFacts 必须为 null，sceneFacts 必须完整，若场景包含本轮需要保护的商品则同时返回 productCore 与 fusionHalo，否则两者均为 null；role=unknown 时两类事实、两个区域均为 null 且 editableTargets 为空。场景 editableTargets 只列出可安全修改的背景、环境、道具、光线或阴影候选，并给每个候选稳定唯一 ID。不得把商品颜色、材质、结构或包装文字列为可编辑目标。无法可靠判断时使用 unknown，禁止为了完成任务互换角色。区域坐标使用 0 到 1 的归一化坐标。",
        },
        { role: "user" as const, content },
    ];
}

function visualAnalysisV4Messages(planningInput: EcommercePlanningInput, assets: EcommercePlanningAssetCandidate[], images: string[]) {
    const aliases = new Map((planningInput.referenceAliases || []).map((item) => [item.assetId, item.alias]));
    const content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [
        {
            type: "text",
            text: JSON.stringify({
                userRequest: planningInput.userRequest,
                referenceAliases: planningInput.referenceAliases || [],
                explicitReferenceBindings: planningInput.explicitReferenceBindings || [],
                ...(planningInput.inheritedReferences ? { inheritedReferences: planningInput.inheritedReferences } : {}),
                assets: assets.map((asset) => ({ id: asset.id, width: asset.width, height: asset.height })),
            }),
        },
    ];
    assets.forEach((asset, index) => content.push({ type: "text", text: `assetId=${asset.id};alias=${aliases.get(asset.id) || ""}` }, { type: "image_url", image_url: { url: images[index] } }));
    return [
        {
            role: "system" as const,
            content:
                "你是电商图片视觉分析模型。contentType 仅描述可见内容，不代表用户用途。保留 completeScene 等原始布尔事实与内容置信度；近景、裁切、未知房间均可提供可靠的局部 cues。逐条记录实际可见的风格、光线、构图和材质表现，并独立给出线索 confidence。缺少完整可靠商品或场景事实时相应 Facts=null，禁止编造房间布局或完整摄影事实。productCore/fusionHalo 使用归一化坐标，fusionHalo 必须包围 productCore；editableTargets 只包含安全的背景、环境、道具、光线和阴影。visibleStructure 遮挡或不确定时 certainty=uncertain、count=null，已确认数量才能用非负整数。cues.evidenceRegion 和结构 evidenceRegion 使用原文件尺寸下的像素坐标。purposeSuggestions 只给本次图片的用途建议，单图可有多个用途；建议置信度与内容和线索置信度独立。显式引用与确认优先，最终用途由服务端决定，不得互换图片或补造商品身份。完整摄影事实才可返回 photographyFacts，局部观察放入 cues；material_appearance 不代表允许改商品材质。",
        },
        { role: "user" as const, content },
    ];
}

async function normalizePlanningImage(value: string, origin: string, cookie: string) {
    const source = originalImageSourceUrl(value.trim());
    const dataMatch = source.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)$/i);
    if (dataMatch) {
        const bytes = Buffer.from(dataMatch[2], "base64");
        if (!bytes.length || bytes.length > CREATIVE_UPLOAD_MAX_BYTES) throw new EcommerceVisualAnalysisError("视觉分析图片无效或过大", 413);
        return { url: await boundEcommerceVisionImage(`data:${dataMatch[1].toLowerCase()};base64,${bytes.toString("base64")}`), size: await decodeEcommerceCanvasSize(bytes), contentSha256: createHash("sha256").update(bytes).digest("hex") };
    }
    const response = source.startsWith("/api/")
        ? await fetchInternalApi(`${origin}${source}`, { headers: maintenanceWorkerContextHeaders(cookie) || { cookie }, cache: "no-store" })
        : /^https:\/\//i.test(source)
          ? await fetchSafeOutbound(source, { cache: "no-store" })
          : null;
    if (!response?.ok) throw new EcommerceVisualAnalysisError("无法读取视觉分析图片", 400);
    const mimeType = response.headers.get("content-type")?.split(";")[0].toLowerCase() || "";
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (!mimeType.startsWith("image/") || contentLength > CREATIVE_UPLOAD_MAX_BYTES) throw new EcommerceVisualAnalysisError("视觉分析图片无效或过大", 413);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > CREATIVE_UPLOAD_MAX_BYTES) throw new EcommerceVisualAnalysisError("视觉分析图片无效或过大", 413);
    return { url: await boundEcommerceVisionImage(`data:${mimeType};base64,${bytes.toString("base64")}`), size: await decodeEcommerceCanvasSize(bytes), contentSha256: createHash("sha256").update(bytes).digest("hex") };
}

function parseAnalysis(value: string, assets: EcommercePlanningAssetCandidate[], analysisVersion: typeof ECOMMERCE_VISUAL_ANALYSIS_VERSION | typeof ECOMMERCE_VISUAL_ANALYSIS_V4_VERSION = ECOMMERCE_VISUAL_ANALYSIS_VERSION) {
    try {
        const parsed = JSON.parse(value);
        if (!isRecord(parsed) || parsed.analysisVersion !== analysisVersion) return null;
        const normalized = normalizeEcommerceVisualAnalysis(parsed, assets);
        if (!normalized) {
            console.warn("[ecommerce-visual-analysis] contract rejected", JSON.stringify(visualAnalysisDebugSummary(parsed, assets)));
        }
        return normalized;
    } catch (error) {
        console.warn("[ecommerce-visual-analysis] response was not JSON", JSON.stringify({ error: error instanceof Error ? error.message : "unknown" }));
        return null;
    }
}

export function visualAnalysisDebugSummary(value: unknown, assets: EcommercePlanningAssetCandidate[] = []): Record<string, unknown> {
    if (!isRecord(value)) return { type: typeof value };
    const references = Array.isArray(value.references) ? value.references : [];
    if (value.analysisVersion === ECOMMERCE_VISUAL_ANALYSIS_V4_VERSION) {
        const referenceAssetIds = references.map((item) => (isRecord(item) ? text(item.assetId) : ""));
        const duplicateAssetIds = [...new Set(referenceAssetIds.filter((assetId, index) => assetId && referenceAssetIds.indexOf(assetId) !== index))];
        const purposeSuggestionAssetIds = Array.isArray(value.purposeSuggestions) ? value.purposeSuggestions.map((item) => (isRecord(item) ? text(item.assetId) : "")).filter(Boolean) : [];
        const validation = assets.length ? validateEcommerceVisualAnalysisV4(value, assets) : null;
        return {
            analysisVersion: ECOMMERCE_VISUAL_ANALYSIS_V4_VERSION,
            referenceCount: references.length,
            referenceAssetIds,
            contentTypes: references.map((item) => (isRecord(item) ? text(item.contentType) : "")),
            purposeSuggestionAssetIds,
            duplicateAssetIds,
            ...(validation ? { issuePaths: validation.issues.map((issue) => issue.path).filter((path): path is string => Boolean(path)), issueCodes: validation.issues.map((issue) => issue.code) } : {}),
        };
    }
    return {
        keys: Object.keys(value).slice(0, 24),
        analysisVersion: text(value.analysisVersion),
        referenceCount: Array.isArray(value.references) ? value.references.length : null,
        referenceKeys: references.slice(0, 2).map((item) => (isRecord(item) ? Object.keys(item).slice(0, 24) : [])),
        referenceIds: references.slice(0, 4).map((item) => (isRecord(item) ? text(item.assetId || item.asset_id || item.id) : "")),
        referenceRoles: references.slice(0, 4).map((item) => (isRecord(item) ? text(item.role || item.assetRole || item.asset_role) : "")),
        referenceValidation: references.slice(0, 2).map((item) =>
            isRecord(item)
                ? {
                      role: text(item.role),
                      confidence: text(item.confidence),
                      visualEvidence:
                          item.visualEvidence === null
                              ? "null"
                              : {
                                    type: typeof item.visualEvidence,
                                    keys: isRecord(item.visualEvidence) ? Object.keys(item.visualEvidence).slice(0, 12) : [],
                                    valid: Boolean(normalizeEvidence(item.visualEvidence)),
                                },
                      productFacts: item.productFacts === null ? "null" : normalizeProductFacts(item.productFacts) ? "valid" : "invalid",
                      sceneFacts: item.sceneFacts === null ? "null" : normalizeSceneFacts(item.sceneFacts) ? "valid" : "invalid",
                      productCore: item.productCore === null ? "null" : { type: typeof item.productCore, keys: isRecord(item.productCore) ? Object.keys(item.productCore).slice(0, 12) : [] },
                      productCoreValid: item.productCore === null ? true : Boolean(normalizeRegion(item.productCore)),
                      fusionHalo: item.fusionHalo === null ? "null" : { type: typeof item.fusionHalo, keys: isRecord(item.fusionHalo) ? Object.keys(item.fusionHalo).slice(0, 12) : [] },
                      fusionHaloValid: item.fusionHalo === null ? true : Boolean(normalizeRegion(item.fusionHalo)),
                      editableTargetCount: Array.isArray(item.editableTargets) ? item.editableTargets.length : null,
                      editableTargetsValid: Boolean(normalizeEditableTargets(item.editableTargets)),
                      referenceValid: Boolean(normalizeReference(item)),
                  }
                : { type: typeof item },
        ),
    };
}

function assertRoleCandidates(candidates: EcommerceRoleCandidate[], expected: "vision_analysis"): void {
    if (candidates.some((candidate) => candidate.logicalRole !== expected || candidate.capability !== "text")) {
        throw new EcommerceVisualAnalysisError(`模型候选角色必须是 ${expected}`, 400);
    }
}

async function refundInvalidResponse(userId: string, logicalModelId: string, headers: Headers) {
    const billing = readSystemAiBilling(headers);
    if (hasSystemAiCharge(billing)) await refundUserPoints(userId, logicalModelId, billing.pointsCost, "text", 1, undefined, billing.pointsRecordId);
}

function text(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function stringArray(value: unknown) {
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? value.map((item) => item.trim()).filter(Boolean) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const regionSchema = {
    anyOf: [
        {
            type: "object",
            properties: { x: { type: "number", minimum: 0, maximum: 1 }, y: { type: "number", minimum: 0, maximum: 1 }, width: { type: "number", exclusiveMinimum: 0, maximum: 1 }, height: { type: "number", exclusiveMinimum: 0, maximum: 1 } },
            required: ["x", "y", "width", "height"],
            additionalProperties: false,
        },
        { type: "null" },
    ],
};

const productFactsSchema = {
    anyOf: [
        {
            type: "object",
            properties: {
                identity: { type: "string" },
                outline: { type: "string" },
                color: { type: "string" },
                material: { type: "string" },
                brandText: { type: "array", items: { type: "string" } },
                view: { type: "string" },
            },
            required: ["identity", "outline", "color", "material", "brandText", "view"],
            additionalProperties: false,
        },
        { type: "null" },
    ],
};

const sceneFactsSchema = {
    anyOf: [
        {
            type: "object",
            properties: { space: { type: "string" }, composition: { type: "string" }, lighting: { type: "string" } },
            required: ["space", "composition", "lighting"],
            additionalProperties: false,
        },
        { type: "null" },
    ],
};

export const ecommerceVisualAnalysisTool = {
    name: "analyze_ecommerce_references",
    description: "逐张分析电商商品图和可选场景参考图，返回严格分离的视觉事实与候选区域",
    parameters: {
        type: "object",
        properties: {
            analysisVersion: { type: "string", enum: [ECOMMERCE_VISUAL_ANALYSIS_VERSION] },
            references: {
                type: "array",
                minItems: 1,
                maxItems: 2,
                items: {
                    type: "object",
                    properties: {
                        assetId: { type: "string" },
                        role: { type: "string", enum: ["product", "scene", "unknown"] },
                        confidence: { type: "string", enum: ["high", "medium", "low"] },
                        visualEvidence: {
                            type: "object",
                            properties: {
                                whiteBackground: { type: "boolean" },
                                transparentBackground: { type: "boolean" },
                                isolatedSubject: { type: "boolean" },
                                completeScene: { type: "boolean" },
                            },
                            required: ["whiteBackground", "transparentBackground", "isolatedSubject", "completeScene"],
                            additionalProperties: false,
                        },
                        productFacts: productFactsSchema,
                        sceneFacts: sceneFactsSchema,
                        productCore: regionSchema,
                        fusionHalo: regionSchema,
                        editableTargets: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    id: { type: "string" },
                                    kind: { type: "string", enum: ["background", "environment", "prop", "lighting", "shadow"] },
                                    label: { type: "string" },
                                    region: regionSchema.anyOf[0],
                                },
                                required: ["id", "kind", "label", "region"],
                                additionalProperties: false,
                            },
                        },
                        visibleStructure: ecommerceVisibleStructureSchema,
                        photographyFacts: ecommercePhotographySchema,
                    },
                    required: ["assetId", "role", "confidence", "visualEvidence", "productFacts", "sceneFacts", "productCore", "fusionHalo", "editableTargets", "visibleStructure"],
                    additionalProperties: false,
                },
            },
        },
        required: ["analysisVersion", "references"],
        additionalProperties: false,
    },
};

const { role: legacyRoleSchema, ...v4ReferenceProperties } = ecommerceVisualAnalysisTool.parameters.properties.references.items.properties;
void legacyRoleSchema;
export const ecommerceVisualAnalysisV4Tool = {
    ...ecommerceVisualAnalysisTool,
    description: "逐图保存可见内容、独立局部线索与用途建议；服务端决定最终用途",
    parameters: {
        ...ecommerceVisualAnalysisTool.parameters,
        properties: {
            analysisVersion: { type: "string", enum: [ECOMMERCE_VISUAL_ANALYSIS_V4_VERSION] },
            references: {
                ...ecommerceVisualAnalysisTool.parameters.properties.references,
                items: {
                    ...ecommerceVisualAnalysisTool.parameters.properties.references.items,
                    properties: {
                        ...v4ReferenceProperties,
                        contentType: { type: "string", enum: ["isolated_product", "product_detail", "interior_scene", "unknown"] },
                        cues: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    id: { type: "string", minLength: 1 },
                                    facet: { type: "string", enum: ["style", "lighting", "composition", "material_appearance"] },
                                    description: { type: "string", minLength: 1 },
                                    confidence: { type: "string", enum: ["high", "medium", "low"] },
                                    evidenceRegion: ecommerceVisibleStructureSchema.items.properties.evidenceRegion,
                                },
                                required: ["id", "facet", "description", "confidence"],
                                additionalProperties: false,
                            },
                        },
                    },
                    required: [...ecommerceVisualAnalysisTool.parameters.properties.references.items.required.filter((key) => key !== "role"), "contentType", "cues"],
                },
            },
            purposeSuggestions: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        assetId: { type: "string" },
                        purposes: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", enum: [...ECOMMERCE_REFERENCE_PURPOSES] } },
                        confidence: { type: "string", enum: ["high", "medium", "low"] },
                    },
                    required: ["assetId", "purposes", "confidence"],
                    additionalProperties: false,
                },
            },
        },
        required: ["analysisVersion", "references", "purposeSuggestions"],
    },
};
