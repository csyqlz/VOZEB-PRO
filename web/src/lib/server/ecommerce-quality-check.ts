import { refundUserPoints } from "@/lib/auth/store";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { CREATIVE_UPLOAD_MAX_BYTES } from "@/lib/creative-upload";
import { fetchInternalApi } from "@/lib/server/internal-origin";
import { fetchSafeOutbound } from "@/lib/server/safe-outbound-fetch";
import { maintenanceWorkerContextHeaders } from "@/lib/server/maintenance-auth";
import { hasSystemAiCharge, readSystemAiBilling, systemAiBillingHeaders, systemAiIdempotencyKey } from "@/lib/server/system-ai-billing";

import { parseValidatedAgentFunctionCall } from "./agent-function-call";
import {
    ecommerceVisibleStructureSchema,
    normalizeEcommerceVisibleStructure,
    validateEcommerceDimensions,
    type EcommerceVisibleStructure,
    type EcommerceManualRegion,
    type EcommerceCanvasConstraint,
    type EcommerceDimensions,
    type EcommerceEditPlan,
} from "./ecommerce-edit-plan";
import { decodeEcommerceCanvasSize } from "./ecommerce-generation-service";
import type { EcommerceRoleCandidate, EcommerceRoleRouteSnapshot } from "./ecommerce-model-routing";
import { boundEcommerceVisionImage } from "./ecommerce-vision-image";
import { rankTextPlanningCandidates, requestStructuredText, type TextPlanningBodyMeasurement } from "./text-planning-runtime";
import { compositeSceneEdit, type SceneEditProtectionEvidence } from "./ecommerce-product-regions";
import { SYSTEM_PROXY_JSON_BODY_MAX_BYTES } from "./system-proxy-request-limits";
import type { ImageTaskResultEvidence } from "./image-task-store";

export const ECOMMERCE_QUALITY_CHECK_VERSION = "ecommerce-quality.v2" as const;
export const ECOMMERCE_QUALITY_CHECK_KEYS = [
    "product_identity",
    "product_silhouette",
    "product_color_material",
    "product_proportions_view",
    "brand_logo",
    "packaging_text",
    "scene_intent",
    "composition_lighting",
    "protected_structure",
    "protected_material",
    "unmodified_region",
] as const;
const LEGACY_CHECK_KEYS = ECOMMERCE_QUALITY_CHECK_KEYS.slice(0, 8);

export type EcommerceQualityCheckKey = (typeof ECOMMERCE_QUALITY_CHECK_KEYS)[number] | "canvas_geometry" | "stored_media";
export type EcommerceCanvasEvaluation = { hardFailures: string[]; nativeMatches: boolean; storedMatches: boolean };
export type EcommerceCanvasQualityEvidence = {
    resultId: string;
    resultIndex?: number;
    storageStatus?: ImageTaskResultEvidence["storageStatus"];
    failureStage?: ImageTaskResultEvidence["failureStage"];
    failureReason?: string;
    constraint: EcommerceCanvasConstraint;
    nativeSize?: EcommerceDimensions;
    storedSize?: EcommerceDimensions;
    nativeUrl?: string;
    storedUrl: string;
    nativeStatus?: "readable" | "unavailable";
    storedStatus?: "readable" | "unavailable";
    nativeMatches: boolean | null;
    storedMatches: boolean | null;
    normalization?: SceneEditProtectionEvidence["normalization"];
    mappingVerified?: boolean;
    hardFailures: string[];
};

export function evaluateEcommerceCanvas(constraint: EcommerceCanvasConstraint, nativeSize: EcommerceDimensions, storedSize: EcommerceDimensions): EcommerceCanvasEvaluation {
    validateEcommerceDimensions(constraint.size);
    const nativeMatches = matchesEcommerceCanvas(constraint, nativeSize);
    const storedMatches = matchesEcommerceCanvas(constraint, storedSize);
    return { hardFailures: nativeMatches && storedMatches ? [] : ["canvas_geometry"], nativeMatches, storedMatches };
}

function matchesEcommerceCanvas(constraint: EcommerceCanvasConstraint, size: EcommerceDimensions) {
    try {
        validateEcommerceDimensions(size);
    } catch {
        return false;
    }
    return constraint.mode === "exact" ? size.width === constraint.size.width && size.height === constraint.size.height : BigInt(size.width) * BigInt(constraint.size.height) === BigInt(size.height) * BigInt(constraint.size.width);
}
export type EcommerceQualityCheckItem = {
    resultId: string;
    key: EcommerceQualityCheckKey;
    status: "passed" | "failed" | "not_applicable";
    reason: string;
    source?: "vision" | "independent_structure" | "media" | "protection";
    evidence?: { objectId?: string; feature?: EcommerceVisibleStructure["feature"]; baselineCount?: number | null; resultCount?: number | null; baselineRegion?: EcommerceManualRegion; resultRegion?: EcommerceManualRegion };
};
export type EcommerceQualityObservation = { readable: boolean; logo: "absent" | "readable" | "unreadable" | "uncertain"; packagingText: "absent" | "readable" | "unreadable" | "uncertain"; visibleStructure: EcommerceVisibleStructure[] };
type QualityObservations = { baseline: EcommerceQualityObservation; productAnchor?: EcommerceQualityObservation; results: Array<{ resultId: string; observation: EcommerceQualityObservation }> };
type QualityContradiction = {
    source: "plan" | "analysis";
    objectId: string;
    feature: EcommerceVisibleStructure["feature"];
    reportedCount: number | null;
    observedCount: number | null;
    reportedRegion: EcommerceManualRegion;
    observedRegion?: EcommerceManualRegion;
};
export type EcommerceQualityCheck = {
    version: typeof ECOMMERCE_QUALITY_CHECK_VERSION | "ecommerce-quality.v1";
    status: "passed" | "needs_adjustment" | "blocked" | "unavailable";
    publicStatus: "passed" | "needs_adjustment" | "needs_review";
    modelRole: EcommerceRoleRouteSnapshot;
    checks: EcommerceQualityCheckItem[];
    hardFailures: EcommerceQualityCheckItem[];
    internalReason: string;
    checkedAt: number;
    canvasEvidence?: EcommerceCanvasQualityEvidence[];
    observations?: QualityObservations;
    contradictions?: QualityContradiction[];
    sceneProtectionEvidence?: Array<{ resultId: string; evidence: SceneEditProtectionEvidence }>;
    visionEvidence?: { imageCount: number; transmissions: TextPlanningBodyMeasurement[]; images: Array<{ source: string; size: EcommerceDimensions; region?: EcommerceManualRegion }> };
};
export type EcommerceResultTechnicalCheck = {
    version: "ecommerce-technical.v1";
    status: "passed" | "blocked" | "unavailable";
    checks: EcommerceQualityCheckItem[];
    hardFailures: EcommerceQualityCheckItem[];
    canvasEvidence: EcommerceCanvasQualityEvidence[];
    sceneProtectionEvidence: NonNullable<EcommerceQualityCheck["sceneProtectionEvidence"]>;
    checkedAt: number;
};

export type EcommerceQualityCheckRequest = {
    origin: string;
    cookie: string;
    userId: string;
    requestId: string;
    plan: EcommerceEditPlan;
    baselineReference: { assetId: string; url: string; role: "product" | "scene" };
    productAnchorReference?: { assetId: string; url: string };
    analysisVisibleStructure?: EcommerceVisibleStructure[];
    resultImages: Array<{ resultId: string; url: string; nativeUrl?: string; nativeSize?: EcommerceDimensions; sceneProtectionEvidence?: SceneEditProtectionEvidence }>;
    batchEvidence?: ImageTaskResultEvidence[];
};

const HARD_CHECKS = new Set<EcommerceQualityCheckKey>([
    "product_identity",
    "product_silhouette",
    "product_color_material",
    "product_proportions_view",
    "brand_logo",
    "packaging_text",
    "protected_structure",
    "protected_material",
    "unmodified_region",
    "canvas_geometry",
    "stored_media",
]);

async function collectEcommerceTechnicalEvidence(input: EcommerceQualityCheckRequest) {
    let canvasEvidence: EcommerceCanvasQualityEvidence[] = [];
    let geometryChecks: EcommerceQualityCheckItem[] = [];
    const sceneProtectionEvidence = input.resultImages.flatMap((result) => (result.sceneProtectionEvidence ? [{ resultId: result.resultId, evidence: structuredClone(result.sceneProtectionEvidence) }] : []));
    const protectionChecks = await qualityProtectionChecks(input);
    if (input.plan.canvas) {
        const constraint = input.plan.canvas;
        validateEcommerceDimensions(constraint.size);
        const slots = [
            ...(input.batchEvidence || []).map((evidence) => ({ evidence, result: input.resultImages.find((result) => result.resultId === evidence.resultId) })),
            ...input.resultImages.filter((result) => !input.batchEvidence?.some((slot) => slot.resultId === result.resultId)).map((result) => ({ evidence: undefined, result })),
        ];
        canvasEvidence = await Promise.all(
            slots.map(async ({ evidence, result }) => {
                const [native, stored] = await Promise.allSettled([
                    result?.nativeUrl ? qualityCanvasSize(result.nativeUrl, input) : Promise.reject(new Error("上游原生画幅证据缺失")),
                    result?.url ? qualityCanvasSize(result.url, input) : Promise.reject(new Error("落盘画幅证据缺失")),
                ]);
                const nativeSize = native.status === "fulfilled" ? native.value : (evidence?.nativeStatus === "readable" ? evidence.nativeSize : undefined) || result?.nativeSize;
                const storedSize = stored.status === "fulfilled" ? stored.value : undefined;
                const nativeMatches = nativeSize ? matchesEcommerceCanvas(constraint, nativeSize) : null;
                const storedMatches = storedSize ? matchesEcommerceCanvas(constraint, storedSize) : null;
                const mappingVerified =
                    native.status === "fulfilled" &&
                    stored.status === "fulfilled" &&
                    (result?.sceneProtectionEvidence?.normalization === "uniform_scale" || result?.sceneProtectionEvidence?.normalization === "pixel_grid_scale") &&
                    protectionChecks.some((check) => check.resultId === result.resultId && check.key === "unmodified_region" && check.status === "passed");
                return {
                    resultId: evidence?.resultId || result!.resultId,
                    ...(evidence ? { resultIndex: evidence.resultIndex, storageStatus: evidence.storageStatus, ...(evidence.failureStage ? { failureStage: evidence.failureStage, failureReason: evidence.failureReason } : {}) } : {}),
                    constraint: { ...constraint, size: { ...constraint.size } },
                    ...(result?.nativeUrl ? { nativeUrl: result.nativeUrl } : {}),
                    storedUrl: result?.url || evidence?.storedUrl || "",
                    ...(nativeSize ? { nativeSize } : {}),
                    ...(storedSize ? { storedSize } : {}),
                    nativeStatus: nativeSize ? ("readable" as const) : ("unavailable" as const),
                    storedStatus: storedSize ? ("readable" as const) : ("unavailable" as const),
                    nativeMatches,
                    storedMatches,
                    normalization: result?.sceneProtectionEvidence?.normalization || ("none" as const),
                    mappingVerified,
                    hardFailures: (nativeMatches === false && !mappingVerified) || storedMatches === false ? ["canvas_geometry"] : [],
                };
            }),
        );
        geometryChecks = canvasEvidence.map((evidence) => ({
            resultId: evidence.resultId,
            key: "canvas_geometry",
            source: "media",
            status: evidence.hardFailures.length ? "failed" : evidence.nativeStatus === "unavailable" || evidence.storedStatus === "unavailable" ? "not_applicable" : "passed",
            reason: `native=${evidence.nativeSize ? evidence.nativeSize.width + "x" + evidence.nativeSize.height : "unavailable"};stored=${evidence.storedSize ? evidence.storedSize.width + "x" + evidence.storedSize.height : "unavailable"};constraint=${constraint.mode}:${constraint.size.width}x${constraint.size.height};normalization=${evidence.normalization}`,
        }));
    }
    return { checks: [...geometryChecks, ...protectionChecks], canvasEvidence, sceneProtectionEvidence };
}

export async function checkEcommerceResult(input: EcommerceQualityCheckRequest, candidate: EcommerceRoleCandidate, technicalCheck?: EcommerceResultTechnicalCheck): Promise<EcommerceQualityCheck> {
    let canvasEvidence: EcommerceCanvasQualityEvidence[] = [];
    let geometryChecks: EcommerceQualityCheckItem[] = [];
    let protectionChecks: EcommerceQualityCheckItem[] = [];
    let visionEvidence: EcommerceQualityCheck["visionEvidence"];
    let sceneProtectionEvidence: EcommerceQualityCheck["sceneProtectionEvidence"] = [];
    const independent = ["ecommerce-edit.v4", "ecommerce-edit.v5", "ecommerce-edit.v6"].includes(input.plan.planVersion);
    try {
        assertQualityRequest(input, candidate);
        const technical = technicalCheck || (await collectEcommerceTechnicalEvidence(input));
        sceneProtectionEvidence = technical.sceneProtectionEvidence;
        canvasEvidence = technical.canvasEvidence;
        protectionChecks = technical.checks.filter((check) => check.source === "protection");
        geometryChecks = technical.checks.filter((check) => check.source === "media");
        const unavailableEvidence = canvasEvidence.find((evidence) => evidence.nativeStatus === "unavailable" || evidence.storedStatus === "unavailable");
        if (unavailableEvidence) throw new Error(!unavailableEvidence.nativeUrl ? "上游原生画幅证据缺失" : "画幅验收真实文件不可读");
        const resultIds = input.resultImages.map((item) => item.resultId);
        const prepared = await qualityCheckMessages(input);
        visionEvidence = prepared.evidence;
        const normalize = (value: unknown) => normalizeQualityResult(value, resultIds, independent, Boolean(input.productAnchorReference), prepared.evidence.images);
        const idempotencyKey = systemAiIdempotencyKey("ecommerce-quality-check", input.userId, input.requestId, candidate.logicalModelId, candidate.channelId, candidate.upstreamModel);
        const call = await requestStructuredText({
            origin: input.origin,
            cookie: input.cookie,
            candidate,
            messages: prepared.messages,
            tool: independent ? ecommerceQualityCheckTool : legacyQualityCheckTool,
            requestBodyBudget: { maxBytes: SYSTEM_PROXY_JSON_BODY_MAX_BYTES, onMeasured: (measurement) => visionEvidence!.transmissions.push(measurement) },
            headers: {
                ...qualityImageRequestHeaders(input.cookie),
                ...systemAiBillingHeaders(candidate.logicalModelId, idempotencyKey, candidate.upstreamModel),
            },
            preferNativeTools: true,
            validateArguments: (argumentsText) => {
                try {
                    return normalize(JSON.parse(argumentsText)) !== null;
                } catch {
                    return false;
                }
            },
            onInvalidResponse: (headers) => refundInvalidResponse(input.userId, candidate.logicalModelId, headers),
        });
        const raw = await parseValidatedAgentFunctionCall(call, normalize, () => refundInvalidResponse(input.userId, candidate.logicalModelId, call.headers), "结果验收模型返回的字段不完整");
        const structureChecks = raw.observations ? compareQualityStructures(input, raw.observations) : [];
        const overrides = [...structureChecks, ...protectionChecks, ...geometryChecks];
        const mergedOverrides = overrides.map((override) => {
            const visual = raw.checks.find((item) => item.resultId === override.resultId && item.key === override.key);
            return override.key === "protected_structure" && override.status !== "failed" && visual?.status === "failed" ? { ...visual, evidence: override.evidence, reason: `${visual.reason};${override.reason}` } : override;
        });
        const checks = [...raw.checks.filter((item) => !mergedOverrides.some((override) => override.resultId === item.resultId && override.key === item.key)), ...mergedOverrides];
        const hardFailures = checks.filter((item) => HARD_CHECKS.has(item.key) && (item.status === "failed" || (!independent && item.status === "not_applicable" && requiresVisibleProductEvidence(item.key, input.plan))));
        const failed = checks.filter((item) => item.status === "failed");
        const requiresOutsidePixelEvidence = !independent || input.plan.operation !== "local_edit" || input.plan.protection?.preserveOutsideMask !== false;
        const unchecked =
            (input.plan.protection?.scope === "local" && requiresOutsidePixelEvidence && protectionChecks.some((item) => item.status === "not_applicable")) || (raw.observations && qualityObservationUnavailable(input, raw.observations, checks));
        const status = hardFailures.length ? "blocked" : unchecked ? "unavailable" : failed.length ? "needs_adjustment" : "passed";
        return {
            version: independent ? ECOMMERCE_QUALITY_CHECK_VERSION : "ecommerce-quality.v1",
            status,
            publicStatus: status === "blocked" || status === "unavailable" ? "needs_review" : status,
            modelRole: candidate.snapshot,
            checks,
            hardFailures,
            internalReason: hardFailures.length
                ? hardFailures.map((item) => `${item.resultId}:${item.key}:${item.status}`).join(",")
                : unchecked
                  ? "受保护事实或选区外证据不可检查"
                  : failed.length
                    ? failed.map((item) => `${item.resultId}:${item.key}`).join(",")
                    : "all required checks passed",
            checkedAt: Date.now(),
            ...(canvasEvidence.length ? { canvasEvidence } : {}),
            ...(raw.observations ? { observations: raw.observations, contradictions: qualityContradictions(input, raw.observations.baseline) } : {}),
            sceneProtectionEvidence,
            visionEvidence,
        };
    } catch (error) {
        const unavailable = unavailableEcommerceQualityCheck(error instanceof Error ? error.message : "结果验收模型不可用", candidate.snapshot);
        const checks = [...geometryChecks, ...protectionChecks];
        const hardFailures = checks.filter((check) => check.status === "failed");
        return {
            ...unavailable,
            version: independent ? ECOMMERCE_QUALITY_CHECK_VERSION : "ecommerce-quality.v1",
            checks,
            hardFailures,
            sceneProtectionEvidence,
            ...(canvasEvidence.length ? { canvasEvidence } : {}),
            ...(visionEvidence ? { visionEvidence } : {}),
            ...(hardFailures.length ? { status: "blocked" as const } : {}),
        };
    }
}

export async function checkEcommerceTechnicalResult(input: EcommerceQualityCheckRequest): Promise<EcommerceResultTechnicalCheck> {
    let evidence: Awaited<ReturnType<typeof collectEcommerceTechnicalEvidence>> = { checks: [], canvasEvidence: [], sceneProtectionEvidence: [] };
    try {
        evidence = await collectEcommerceTechnicalEvidence(input);
        if (!input.plan.canvas) {
            evidence.checks.push(
                ...(await Promise.all(
                    input.resultImages.map(async (result): Promise<EcommerceQualityCheckItem> => {
                        try {
                            const size = await qualityCanvasSize(result.url, input);
                            return { resultId: result.resultId, key: "stored_media", source: "media", status: "passed", reason: `stored=${size.width}x${size.height}` };
                        } catch {
                            return { resultId: result.resultId, key: "stored_media", source: "media", status: "not_applicable", reason: "保存的图片无法读取或解码" };
                        }
                    }),
                )),
            );
        }
    } catch {
        evidence.checks.push({ resultId: "batch", key: "stored_media", source: "media", status: "not_applicable", reason: "无法验证实际结果媒体" });
    }
    if (!input.resultImages.length) evidence.checks.push({ resultId: "batch", key: "stored_media", source: "media", status: "not_applicable", reason: "没有可交付的图片" });
    const hardFailures = evidence.checks.filter((check) => check.status === "failed");
    const unavailable = evidence.checks.some((check) => check.status === "not_applicable" && (check.source === "media" || (input.plan.protection?.scope === "local" && input.plan.protection.preserveOutsideMask !== false)));
    return { version: "ecommerce-technical.v1", ...evidence, hardFailures, status: hardFailures.length ? "blocked" : unavailable ? "unavailable" : "passed", checkedAt: Date.now() };
}

export function ecommerceResultDeliveryGate(technical: EcommerceResultTechnicalCheck, quality?: EcommerceQualityCheck) {
    if (technical.status !== "passed") return { action: "pause" as const, publicStatus: "needs_review" as const, publicMessage: "图片保存、尺寸或选区保护检查未完成，请检查原任务。" };
    if (quality && quality.status !== "passed") return { action: "publish" as const, publicStatus: "needs_adjustment" as const, publicMessage: "图片已生成，可按需要继续调整。" };
    return { action: "publish" as const, publicStatus: quality ? ("passed" as const) : undefined, publicMessage: "图片已生成。" };
}

export async function checkEcommerceResultWithFallback(input: EcommerceQualityCheckRequest, candidates: EcommerceRoleCandidate[], technical?: EcommerceResultTechnicalCheck): Promise<EcommerceQualityCheck> {
    let latest: EcommerceQualityCheck | null = null;
    for (const candidate of rankTextPlanningCandidates(candidates)) {
        latest = await checkEcommerceResult(input, candidate, technical);
        if (latest.status !== "unavailable") return latest;
    }
    if (latest) return latest;
    throw new Error("结果验收角色没有可用模型");
}

function requiresVisibleProductEvidence(key: EcommerceQualityCheckKey, plan: EcommerceEditPlan) {
    if (!plan.baseline.productFacts) return false;
    if (key === "brand_logo" || key === "packaging_text") return plan.baseline.productFacts.brandText.length > 0;
    return key === "product_identity" || key === "product_silhouette" || key === "product_color_material" || key === "product_proportions_view";
}

export function unavailableEcommerceQualityCheck(reason: string, modelRole: EcommerceRoleRouteSnapshot): EcommerceQualityCheck {
    return {
        version: ECOMMERCE_QUALITY_CHECK_VERSION,
        status: "unavailable",
        publicStatus: "needs_review",
        modelRole: { ...modelRole },
        checks: [],
        hardFailures: [],
        internalReason: reason.trim() || "结果验收模型不可用",
        checkedAt: Date.now(),
    };
}

export function shouldBlockEcommerceResult(check: EcommerceQualityCheck): boolean {
    return check.status === "blocked" || check.status === "unavailable";
}

export function ecommerceQualityGate(check: EcommerceQualityCheck) {
    if (shouldBlockEcommerceResult(check)) {
        return { action: "pause" as const, publicStatus: "needs_review" as const, publicMessage: "商品一致性检查未通过，需要复核。" };
    }
    if (check.status === "needs_adjustment") {
        return { action: "publish" as const, publicStatus: "needs_adjustment" as const, publicMessage: "图片已生成，场景细节可继续调整。" };
    }
    return { action: "publish" as const, publicStatus: "passed" as const, publicMessage: "商品一致性检查通过。" };
}

async function qualityCheckMessages(input: EcommerceQualityCheckRequest) {
    const independent = ["ecommerce-edit.v4", "ecommerce-edit.v5", "ecommerce-edit.v6"].includes(input.plan.planVersion);
    const evidence: NonNullable<EcommerceQualityCheck["visionEvidence"]> = { imageCount: 0, transmissions: [], images: [] };
    const regionHints = [...new Map((input.plan.visibleStructure || []).map((fact) => [JSON.stringify(fact.evidenceRegion), fact.evidenceRegion])).values()];
    const appendImage = async (content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>, source: string, url: string, crop: boolean) => {
        if (!independent) {
            content.push({ type: "image_url", image_url: { url: await normalizeQualityImage(url, input.origin, input.cookie) } });
            evidence.imageCount++;
            return;
        }
        const bytes = await qualityImageBytes(url, input);
        const size = await decodeEcommerceCanvasSize(bytes);
        const oriented = await sharp(bytes, { limitInputPixels: 64_000_000 }).rotate().png().toBuffer();
        content.push({ type: "image_url", image_url: { url: await boundEcommerceVisionImage(`data:image/png;base64,${oriented.toString("base64")}`) } });
        evidence.images.push({ source, size });
        evidence.imageCount++;
        if (crop) {
            for (const region of regionHints) {
                if (region.x + region.width > size.width || region.y + region.height > size.height) throw new Error("结构取证裁片超出原文件");
                const clipped = await sharp(oriented).extract({ left: region.x, top: region.y, width: region.width, height: region.height }).png().toBuffer();
                content.push(
                    { type: "text", text: `qaOnlyCrop=${source};region=${JSON.stringify(region)};sourceSize=${JSON.stringify(size)}` },
                    { type: "image_url", image_url: { url: await boundEcommerceVisionImage(`data:image/png;base64,${clipped.toString("base64")}`) } },
                );
                evidence.images.push({ source, size, region: { ...region } });
                evidence.imageCount++;
            }
        }
    };
    const content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [
        {
            type: "text",
            text: JSON.stringify({
                task: input.baselineReference.role === "product" ? "compare_product_reference_with_generated_results" : "compare_scene_baseline_with_generated_results",
                baselineAssetId: input.baselineReference.assetId,
                baselineRole: input.baselineReference.role,
                plan: {
                    operation: input.plan.operation,
                    ...(!independent ? { baseline: input.plan.baseline } : {}),
                    delta: input.plan.delta,
                    preserve: input.plan.preserve,
                    strategy: input.plan.strategy,
                    requiredChecks: input.plan.validation.requiredChecks,
                    protection: input.plan.protection,
                    ...(input.plan.photography ? { photography: input.plan.photography } : {}),
                    ...(independent ? { structureRegionHints: [...(input.plan.visibleStructure || []), ...(input.analysisVisibleStructure || [])].map(({ objectId, feature, evidenceRegion }) => ({ objectId, feature, evidenceRegion })) } : {}),
                },
                resultIds: input.resultImages.map((item) => item.resultId),
            }),
        },
        { type: "text", text: `baselineReference=${input.baselineReference.assetId};role=${input.baselineReference.role}` },
    ];
    await appendImage(content, "baseline", input.baselineReference.url, true);
    if (input.productAnchorReference) {
        content.push({ type: "text", text: `originalProductAnchor=${input.productAnchorReference.assetId}` });
        await appendImage(content, "productAnchor", input.productAnchorReference.url, false);
    }
    for (const result of input.resultImages) {
        content.push({ type: "text", text: `resultId=${result.resultId}` });
        await appendImage(content, `result:${result.resultId}`, result.url, !input.plan.canvas?.allowReframe);
    }
    content.unshift({ type: "text", text: JSON.stringify({ imageSources: evidence.images, rule: "区域坐标必须以实际sourceSize原像素为基准；qaOnlyCrop只是内部局部证据，不是新的基线或生图参考。" }) });
    const photographyRules = input.plan.photography
        ? "摄影字段是本轮目标，不是观察答案。protected_material 必须独立比较实际基线与结果的木纹方向与尺度、织物尺度、粗糙度与光泽、颜色；不能为了摄影目标改变材质。composition_lighting 检查主光方向与面积、补光、白平衡、接触阴影、主体明度层次、留白与空间纵深；scene_intent 检查本轮空间和风格目标。局部光影融合只能发生在允许区域，禁止全图染黄或新增未请求的灯具。看不清或无法验收时返回 not_applicable，不能写 passed；所有硬失败优先于摄影审美。"
        : "";
    return {
        evidence,
        messages: [
            {
                role: "system" as const,
                content:
                    (independent
                        ? "你是电商结果验收模型。必须调用 check_ecommerce_results。先独立观察实际主基线、可用原商品锚点及各结果整图/内部裁片，不把分析或计划当答案。家具即使位于scene中仍需检查身份、结构、材质、颜色和非目标变化，不能按图片role把硬项整体N/A。baselineObservation、productAnchorObservation（有锚点时）和各result.observation的 readable 表示实际图像整体是否足以进行独立视觉检查，不表示图片中有无可阅读文字。清楚的无文字、无 Logo 商品或场景图可以为 true；文字状态分别由 logo 和 packagingText 表达。实际内容不可访问、损坏、严重模糊或不足以检查时为 false，不得猜测。true 不保证每个局部细节都可确认，局部遮挡或文字模糊仍使用对应 uncertain/unreadable；true 不等于一致性通过，结构、材质、身份和其他硬项仍须独立判断。可见抽屉/柜门/把手/腿只根据图片独立计数，遮挡或不确定时count=null、certainty=uncertain；同一物体跨图使用稳定objectId。Logo/包装文字分别判断absent、readable、unreadable或uncertain；不可读不等于没有。商品身份、结构、受保护颜色材质、非法范围是硬项，构图、摄影光线和场景意图是软项；审美不能抵消硬失败。unmodified_region不能凭图感证明像素不变，确定性证据由服务端验算。reason只写简短事实。"
                        : "你是电商结果验收模型。必须调用 check_ecommerce_results，并为每个 resultId 返回全部八项检查。商品或场景中的受保护家具仍需检查身份、外形、颜色材质与比例视角；审美不能抵消硬失败。reason 只写简短事实，不输出推理过程。") +
                    photographyRules,
            },
            { role: "user" as const, content },
        ],
    };
}

async function normalizeQualityImage(value: string, origin: string, cookie: string) {
    const source = value.trim();
    const dataMatch = source.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)$/i);
    if (dataMatch) {
        const bytes = Buffer.from(dataMatch[2], "base64");
        if (!bytes.length || bytes.length > CREATIVE_UPLOAD_MAX_BYTES) throw new Error("结果验收图片无效或过大");
        return boundEcommerceVisionImage(`data:${dataMatch[1].toLowerCase()};base64,${bytes.toString("base64")}`);
    }
    if (/^https:\/\//i.test(source)) return source;
    if (!source.startsWith("/api/")) throw new Error("结果验收图片地址无效");
    const response = await fetchInternalApi(`${origin}${source}`, {
        headers: qualityImageRequestHeaders(cookie),
        cache: "no-store",
    });
    if (!response.ok) throw new Error("无法读取结果验收图片");
    const mimeType = response.headers.get("content-type")?.split(";")[0].toLowerCase() || "";
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (!mimeType.startsWith("image/") || contentLength > CREATIVE_UPLOAD_MAX_BYTES) throw new Error("结果验收图片无效或过大");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > CREATIVE_UPLOAD_MAX_BYTES) throw new Error("结果验收图片无效或过大");
    return boundEcommerceVisionImage(`data:${mimeType};base64,${bytes.toString("base64")}`);
}

async function qualityCanvasSize(value: string, input: EcommerceQualityCheckRequest): Promise<EcommerceDimensions> {
    return decodeEcommerceCanvasSize(await qualityImageBytes(value, input));
}

async function qualityImageBytes(value: string, input: EcommerceQualityCheckRequest): Promise<Buffer> {
    const data = value.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)$/i);
    let bytes: Buffer;
    if (data) bytes = Buffer.from(data[2], "base64");
    else {
        const response = value.startsWith("/api/")
            ? await fetchInternalApi(`${input.origin}${value}`, { headers: qualityImageRequestHeaders(input.cookie), cache: "no-store" })
            : /^https:\/\//i.test(value)
              ? await fetchSafeOutbound(value, { cache: "no-store" })
              : null;
        if (!response?.ok || !response.headers.get("content-type")?.toLowerCase().startsWith("image/") || Number(response.headers.get("content-length") || 0) > CREATIVE_UPLOAD_MAX_BYTES) throw new Error("无法读取画幅验收原文件");
        bytes = Buffer.from(await response.arrayBuffer());
    }
    if (!bytes.length || bytes.length > CREATIVE_UPLOAD_MAX_BYTES) throw new Error("画幅验收原文件无效或过大");
    return bytes;
}

function qualityImageRequestHeaders(credential: string): Record<string, string> {
    const normalized = credential.trim();
    if (normalized.startsWith("vozeb-worker-v1.")) {
        const workerHeaders = maintenanceWorkerContextHeaders(normalized);
        if (!workerHeaders) throw new Error("quality worker credential invalid");
        return workerHeaders;
    }
    return normalized ? { cookie: normalized } : {};
}

function assertQualityRequest(input: EcommerceQualityCheckRequest, candidate: EcommerceRoleCandidate) {
    if (candidate.logicalRole !== "quality_check" || candidate.capability !== "text") throw new Error("结果验收模型角色无效");
    if (!input.baselineReference.assetId.trim() || !input.baselineReference.url.trim()) throw new Error("验收基线图片不可用");
    const expectedRole = input.plan.source.currentSceneBaselineId && input.plan.operation !== "product_to_scene" ? "scene" : "product";
    if (input.baselineReference.role !== expectedRole) throw new Error("验收基线角色与编辑计划不一致");
    if (input.plan.canvas && input.batchEvidence) {
        if (
            !input.batchEvidence.length ||
            new Set(input.batchEvidence.map((slot) => slot.resultId)).size !== input.batchEvidence.length ||
            input.batchEvidence.some((slot) => !slot.resultId.trim() || !Number.isSafeInteger(slot.resultIndex) || slot.resultIndex < 1) ||
            new Set(input.resultImages.map((result) => result.resultId)).size !== input.resultImages.length ||
            input.resultImages.some((result) => !result.resultId.trim())
        )
            throw new Error("生成结果批次证据无效");
        return;
    }
    if (!input.resultImages.length || new Set(input.resultImages.map((item) => item.resultId)).size !== input.resultImages.length || input.resultImages.some((item) => !item.resultId.trim() || !item.url.trim())) {
        throw new Error("生成结果图片不可用");
    }
}

function normalizeQualityResult(
    value: unknown,
    resultIds: string[],
    independent: boolean,
    hasAnchor: boolean,
    images: NonNullable<EcommerceQualityCheck["visionEvidence"]>["images"],
): { checks: EcommerceQualityCheckItem[]; observations?: QualityObservations } | null {
    if (!isRecord(value) || !Array.isArray(value.results) || value.results.length !== resultIds.length) return null;
    const expectedIds = new Set(resultIds);
    const seenIds = new Set<string>();
    const checks: EcommerceQualityCheckItem[] = [];
    const observedResults: QualityObservations["results"] = [];
    const baseline = independent ? normalizeQualityObservation(value.baselineObservation, images.find((image) => image.source === "baseline")?.size) : null;
    const productAnchor = independent && hasAnchor ? normalizeQualityObservation(value.productAnchorObservation, images.find((image) => image.source === "productAnchor")?.size) : null;
    if (independent && (!baseline || (hasAnchor && !productAnchor))) return null;
    for (const result of value.results) {
        if (!isRecord(result) || typeof result.resultId !== "string" || !expectedIds.has(result.resultId) || seenIds.has(result.resultId) || !Array.isArray(result.checks)) return null;
        seenIds.add(result.resultId);
        const observation = independent ? normalizeQualityObservation(result.observation, images.find((image) => image.source === `result:${result.resultId}`)?.size) : null;
        if (independent && !observation) return null;
        if (observation) observedResults.push({ resultId: result.resultId, observation });
        const seenKeys = new Set<EcommerceQualityCheckKey>();
        for (const check of result.checks) {
            if (!isRecord(check) || !isQualityKey(check.key) || seenKeys.has(check.key) || !["passed", "failed", "not_applicable"].includes(String(check.status)) || typeof check.reason !== "string" || !check.reason.trim()) {
                return null;
            }
            seenKeys.add(check.key);
            checks.push({
                resultId: result.resultId,
                key: check.key,
                status: check.status as EcommerceQualityCheckItem["status"],
                reason: check.reason.trim(),
                source: "vision",
                ...(observation?.visibleStructure[0] ? { evidence: { baselineRegion: baseline?.visibleStructure[0]?.evidenceRegion, resultRegion: observation.visibleStructure[0].evidenceRegion } } : {}),
            });
        }
        const requiredKeys = independent ? ECOMMERCE_QUALITY_CHECK_KEYS : LEGACY_CHECK_KEYS;
        if (requiredKeys.some((key) => !seenKeys.has(key))) return null;
    }
    return seenIds.size === expectedIds.size
        ? {
              checks: independent ? checks : checks.filter((item) => LEGACY_CHECK_KEYS.includes(item.key as (typeof ECOMMERCE_QUALITY_CHECK_KEYS)[number])),
              ...(baseline ? { observations: { baseline, ...(productAnchor ? { productAnchor } : {}), results: observedResults } } : {}),
          }
        : null;
}

function normalizeQualityObservation(value: unknown, size?: EcommerceDimensions): EcommerceQualityObservation | null {
    if (!isRecord(value) || typeof value.readable !== "boolean" || !["absent", "readable", "unreadable", "uncertain"].includes(String(value.logo)) || !["absent", "readable", "unreadable", "uncertain"].includes(String(value.packagingText))) return null;
    const visibleStructure = normalizeEcommerceVisibleStructure(value.visibleStructure);
    if (!visibleStructure || !size || visibleStructure.some(({ evidenceRegion: r }) => r.x + r.width > size.width || r.y + r.height > size.height)) return null;
    return { readable: value.readable, logo: value.logo as EcommerceQualityObservation["logo"], packagingText: value.packagingText as EcommerceQualityObservation["packagingText"], visibleStructure };
}

function requiredQualityStructureObjects(input: EcommerceQualityCheckRequest, observations: QualityObservations) {
    const objectIds = new Set([...(input.plan.visibleStructure || []), ...(input.analysisVisibleStructure || [])].map((fact) => fact.objectId));
    const protectedIds = input.plan.protection?.protectedObjectIds || [];
    let unresolved = Boolean(input.plan.preserve.sceneElements.length && !objectIds.size && !protectedIds.length);
    for (const id of protectedIds) {
        if (id === input.plan.source.currentSceneBaselineId || id === input.plan.source.productAnchorId) {
            const source = id === input.baselineReference.assetId ? observations.baseline : id === input.productAnchorReference?.assetId ? observations.productAnchor : undefined;
            if (!source?.visibleStructure.length) unresolved = true;
            else source.visibleStructure.forEach((fact) => objectIds.add(fact.objectId));
        } else objectIds.add(id);
    }
    return { objectIds: [...objectIds], unresolved };
}

function compareQualityStructures(input: EcommerceQualityCheckRequest, observations: QualityObservations): EcommerceQualityCheckItem[] {
    const required = requiredQualityStructureObjects(input, observations);
    return observations.results.map(({ resultId, observation }) => {
        const missingIds = required.objectIds.filter((id) => !observations.baseline.visibleStructure.some((fact) => fact.objectId === id) || !observation.visibleStructure.some((fact) => fact.objectId === id));
        const comparisons = [observations.baseline, ...(observations.productAnchor ? [observations.productAnchor] : [])].flatMap((source) =>
            source.visibleStructure.map((fact) => ({ fact, readable: source.readable, result: observation.visibleStructure.find((item) => item.objectId === fact.objectId && item.feature === fact.feature) })),
        );
        const mismatch = observations.baseline.readable && observation.readable ? comparisons.find(({ fact, readable, result }) => readable && fact.certainty === "confirmed" && result?.certainty === "confirmed" && fact.count !== result.count) : undefined;
        const uncertain =
            required.unresolved ||
            missingIds.length ||
            !observations.baseline.readable ||
            !observation.readable ||
            !comparisons.length ||
            comparisons.some(({ fact, readable, result }) => !readable || fact.certainty !== "confirmed" || result?.certainty !== "confirmed");
        const selected = mismatch || (!required.unresolved && (missingIds.length ? comparisons.find(({ fact }) => missingIds.includes(fact.objectId)) : comparisons[0]));
        return {
            resultId,
            key: "protected_structure",
            status: mismatch ? "failed" : uncertain ? "not_applicable" : "passed",
            source: "independent_structure",
            reason: mismatch
                ? `${mismatch.fact.objectId}:${mismatch.fact.feature};baseline=${mismatch.fact.count};result=${mismatch.result!.count}`
                : missingIds.length
                  ? `受保护对象缺少独立基线或结果观察:${missingIds.join(",")}`
                  : required.unresolved
                    ? "受保护对象与基线或商品素材的关系无法确认"
                    : uncertain
                      ? "可见结构无法独立确认"
                      : "独立基线与结果可见结构一致",
            ...(selected
                ? {
                      evidence: {
                          objectId: selected.fact.objectId,
                          feature: selected.fact.feature,
                          baselineCount: selected.fact.count,
                          resultCount: selected.result?.count ?? null,
                          baselineRegion: selected.fact.evidenceRegion,
                          resultRegion: selected.result?.evidenceRegion,
                      },
                  }
                : {}),
        };
    });
}

function qualityObservationUnavailable(input: EcommerceQualityCheckRequest, observations: QualityObservations, checks: EcommerceQualityCheckItem[]) {
    if ([...(input.plan.visibleStructure || []), ...(input.analysisVisibleStructure || [])].some((fact) => !observations.baseline.visibleStructure.some((actual) => actual.objectId === fact.objectId && actual.feature === fact.feature))) return true;
    const sources = [observations.baseline, ...(observations.productAnchor ? [observations.productAnchor] : []), ...observations.results.map((result) => result.observation)];
    if (sources.some((source) => !source.readable || source.logo === "unreadable" || source.logo === "uncertain" || source.packagingText === "unreadable" || source.packagingText === "uncertain")) return true;
    return checks.some(
        (item) =>
            item.status === "not_applicable" &&
            item.key !== "unmodified_region" &&
            !(
                (item.key === "brand_logo" && observations.baseline.logo === "absent" && (!observations.productAnchor || observations.productAnchor.logo === "absent")) ||
                (item.key === "packaging_text" && observations.baseline.packagingText === "absent" && (!observations.productAnchor || observations.productAnchor.packagingText === "absent"))
            ),
    );
}

function qualityContradictions(input: EcommerceQualityCheckRequest, observed: EcommerceQualityObservation): QualityContradiction[] {
    return [
        { source: "plan" as const, facts: input.plan.visibleStructure || [] },
        { source: "analysis" as const, facts: input.analysisVisibleStructure || [] },
    ].flatMap(({ source, facts }) =>
        facts.flatMap((fact) => {
            const actual = observed.visibleStructure.find((item) => item.objectId === fact.objectId && item.feature === fact.feature);
            return !actual || actual.count !== fact.count || actual.certainty !== fact.certainty
                ? [
                      {
                          source,
                          objectId: fact.objectId,
                          feature: fact.feature,
                          reportedCount: fact.count,
                          observedCount: actual?.count ?? null,
                          reportedRegion: { ...fact.evidenceRegion },
                          ...(actual ? { observedRegion: { ...actual.evidenceRegion } } : {}),
                      },
                  ]
                : [];
        }),
    );
}

async function qualityProtectionChecks(input: EcommerceQualityCheckRequest): Promise<EcommerceQualityCheckItem[]> {
    if (input.plan.protection?.scope !== "local")
        return ["ecommerce-edit.v4", "ecommerce-edit.v5", "ecommerce-edit.v6"].includes(input.plan.planVersion)
            ? input.resultImages.map((result) => ({ resultId: result.resultId, key: "unmodified_region", status: "not_applicable", source: "protection", reason: "当前全局编辑没有局部选区外像素不变承诺" }))
            : [];
    return Promise.all(
        input.resultImages.map(async (result) => {
            const proof = result.sceneProtectionEvidence;
            const item: EcommerceQualityCheckItem = { resultId: result.resultId, key: "unmodified_region", status: "not_applicable", source: "protection", reason: "缺少真实选区外合成证据，不能宣称像素保持" };
            if (!input.plan.protection?.preserveOutsideMask || !proof) return item;
            try {
                const [source, stored] = await Promise.all([qualityImageBytes(input.baselineReference.url, input), qualityImageBytes(result.url, input)]);
                const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
                const decode = (bytes: Buffer) => sharp(bytes, { limitInputPixels: 64_000_000 }).rotate().toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
                const [original, composite] = await Promise.all([decode(source), decode(stored)]);
                const r = proof.targetRegion;
                const valid =
                    proof.version === "scene-edit-protection.v1" &&
                    proof.selectionSource === "user_selection" &&
                    proof.method === "source_pixels_copy" &&
                    proof.maskSemantics === "alpha_zero_edit" &&
                    proof.sourceAssetId === input.baselineReference.assetId &&
                    proof.sourceDigest === digest(source) &&
                    proof.compositeDigest === digest(stored) &&
                    proof.sourceSize.width === original.info.width &&
                    proof.sourceSize.height === original.info.height &&
                    original.info.width === composite.info.width &&
                    original.info.height === composite.info.height &&
                    r &&
                    Object.values(r).every(Number.isSafeInteger) &&
                    r.x >= 0 &&
                    r.y >= 0 &&
                    r.width > 0 &&
                    r.height > 0 &&
                    r.x + r.width <= composite.info.width &&
                    r.y + r.height <= composite.info.height;
                if (!valid) return { ...item, status: "failed", reason: "真实源图或合成文件与独立保护证据不一致" };
                if (proof.normalization === "uniform_scale" || proof.normalization === "pixel_grid_scale") {
                    if (proof.nativeOutsideChangedPixels !== undefined) return { ...item, status: "failed", reason: "跨分辨率映射不得声明原生逐像素变化数量" };
                    if (!result.nativeUrl || !proof.maskUrl) return { ...item, reason: "局部尺寸适配缺少原生图片或独立蒙版" };
                    const [native, mask] = await Promise.all([qualityImageBytes(result.nativeUrl, input), qualityImageBytes(proof.maskUrl, input)]);
                    const rebuilt = await compositeSceneEdit(source, native, { ...proof, mask: { ...proof.maskSize, type: "image/png", dataUrl: "data:image/png;base64," + mask.toString("base64") } });
                    if (
                        rebuilt.evidence.normalization !== proof.normalization ||
                        rebuilt.evidence.nativeSize.width !== proof.nativeSize.width ||
                        rebuilt.evidence.nativeSize.height !== proof.nativeSize.height ||
                        rebuilt.evidence.nativeDigest !== proof.nativeDigest ||
                        rebuilt.evidence.compositeDigest !== proof.compositeDigest ||
                        rebuilt.evidence.mappedOutsideChangedPixels !== proof.mappedOutsideChangedPixels
                    )
                        return { ...item, status: "failed", reason: "真实原生图片、尺寸映射或重建成图与保护证据不一致" };
                }
                let outsidePixels = 0;
                let changedPixels = 0;
                for (let y = 0; y < composite.info.height; y++)
                    for (let x = 0; x < composite.info.width; x++) {
                        if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) continue;
                        outsidePixels++;
                        const offset = (y * composite.info.width + x) * 4;
                        if (!original.data.subarray(offset, offset + 4).equals(composite.data.subarray(offset, offset + 4))) changedPixels++;
                    }
                return {
                    ...item,
                    status: changedPixels || !outsidePixels || proof.outsidePixels !== outsidePixels || proof.compositeOutsideChangedPixels !== 0 ? "failed" : "passed",
                    evidence: { baselineRegion: { ...r }, resultRegion: { ...r } },
                    reason: `actualOutsidePixels=${outsidePixels};actualChangedPixels=${changedPixels};mappedChangedPixels=${proof.mappedOutsideChangedPixels};normalization=${proof.normalization || "none"}`,
                };
            } catch {
                return { ...item, reason: "无法读取真实保护源图或合成文件" };
            }
        }),
    );
}

function isQualityKey(value: unknown): value is EcommerceQualityCheckKey {
    return typeof value === "string" && (ECOMMERCE_QUALITY_CHECK_KEYS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function refundInvalidResponse(userId: string, logicalModelId: string, headers: Headers) {
    const billing = readSystemAiBilling(headers);
    if (hasSystemAiCharge(billing)) await refundUserPoints(userId, logicalModelId, billing.pointsCost, "text", 1, undefined, billing.pointsRecordId);
}

const observationSchema = {
    type: "object",
    properties: {
        readable: {
            type: "boolean",
            description:
                "readable 表示实际图像整体是否足以进行独立视觉检查，不表示图片中有无可阅读文字。清楚的无文字、无 Logo 商品或场景图可以为 true；文字状态分别由 logo 和 packagingText 表达。实际内容不可访问、损坏、严重模糊或不足以检查时为 false，不得猜测。true 不保证每个局部细节都可确认，局部遮挡或文字模糊仍使用对应 uncertain/unreadable；true 不等于一致性通过，结构、材质、身份和其他硬项仍须独立判断。",
        },
        logo: { type: "string", enum: ["absent", "readable", "unreadable", "uncertain"] },
        packagingText: { type: "string", enum: ["absent", "readable", "unreadable", "uncertain"] },
        visibleStructure: ecommerceVisibleStructureSchema,
    },
    required: ["readable", "logo", "packagingText", "visibleStructure"],
    additionalProperties: false,
};

export const ecommerceQualityCheckTool = {
    name: "check_ecommerce_results",
    description: "比较商品或场景基线与生成结果，返回商品硬检查和场景软检查",
    parameters: {
        type: "object",
        properties: {
            baselineObservation: observationSchema,
            productAnchorObservation: observationSchema,
            results: {
                type: "array",
                minItems: 1,
                items: {
                    type: "object",
                    properties: {
                        resultId: { type: "string" },
                        observation: observationSchema,
                        checks: {
                            type: "array",
                            minItems: ECOMMERCE_QUALITY_CHECK_KEYS.length,
                            maxItems: ECOMMERCE_QUALITY_CHECK_KEYS.length,
                            items: {
                                type: "object",
                                properties: {
                                    key: { type: "string", enum: [...ECOMMERCE_QUALITY_CHECK_KEYS] },
                                    status: { type: "string", enum: ["passed", "failed", "not_applicable"] },
                                    reason: { type: "string" },
                                },
                                required: ["key", "status", "reason"],
                                additionalProperties: false,
                            },
                        },
                    },
                    required: ["resultId", "checks", "observation"],
                    additionalProperties: false,
                },
            },
        },
        required: ["baselineObservation", "results"],
        additionalProperties: false,
    },
};

const legacyQualityCheckTool = {
    ...ecommerceQualityCheckTool,
    parameters: {
        ...ecommerceQualityCheckTool.parameters,
        properties: {
            results: {
                ...ecommerceQualityCheckTool.parameters.properties.results,
                items: {
                    ...ecommerceQualityCheckTool.parameters.properties.results.items,
                    properties: {
                        resultId: { type: "string" },
                        checks: {
                            ...ecommerceQualityCheckTool.parameters.properties.results.items.properties.checks,
                            minItems: LEGACY_CHECK_KEYS.length,
                            maxItems: LEGACY_CHECK_KEYS.length,
                            items: {
                                ...ecommerceQualityCheckTool.parameters.properties.results.items.properties.checks.items,
                                properties: { ...ecommerceQualityCheckTool.parameters.properties.results.items.properties.checks.items.properties, key: { type: "string", enum: LEGACY_CHECK_KEYS } },
                            },
                        },
                    },
                    required: ["resultId", "checks"],
                },
            },
        },
        required: ["results"],
    },
};
