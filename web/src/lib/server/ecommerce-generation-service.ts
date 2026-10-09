import sharp from "sharp";

import { CREATIVE_UPLOAD_MAX_BYTES } from "@/lib/creative-upload";
import { extractImageSizeFromPrompt, normalizeImageSizeValue, parseImageDimensions } from "@/lib/image-size";
import type { CreativeAsset, CreativeGenerationPreferences, CreativeSurface } from "@/lib/creative-runtime-contract";
import { fetchInternalApi } from "@/lib/server/internal-origin";
import { maintenanceWorkerContextHeaders } from "@/lib/server/maintenance-auth";
import { fetchSafeOutbound } from "@/lib/server/safe-outbound-fetch";

import { ecommerceCanvasSize, validateEcommerceDimensions, type EcommerceCanvasInput, type EcommerceDimensions, type EcommerceEditPlan } from "./ecommerce-edit-plan";
import { normalizeGeneratedImageBytes } from "./generated-image-normalizer";
import type { EcommerceCompiledImageRequest } from "./ecommerce-image-compiler";
import type { EcommerceResolvedLocalEditTarget } from "./ecommerce-edit-planner";
import { buildProductProtectionRegions, buildSceneProductProtectionRegions, buildSceneEditProtection, type SceneEditProtection, type ProductProtectionRectangle, type ProductProtectionRegions } from "./ecommerce-product-regions";
import type { EcommerceVisualAnalysis } from "./ecommerce-visual-analysis";
import type { AgentRun, AgentRunTask } from "./agent-run-store";
import { getCreativeAssetsByIds } from "./creative-runtime-store";
import { assetAccessUrl } from "./agent-run-surface-policy";
import { ecommerceSceneSelectionTask } from "./ecommerce-generation-snapshot";
import { assertEcommerceReferenceContent, EcommerceReferenceSourceReadError } from "./ecommerce-reference-recovery";

const WHITE_BACKGROUND_MIN_CHANNEL = 240;
const TRANSPARENT_BACKGROUND_MAX_ALPHA = 24;
const MIN_BORDER_BACKGROUND_RATIO = 0.9;
const MIN_SUBJECT_PIXELS = 16;
const SECOND_SUBJECT_RATIO = 0.05;
const HALO_RATIO = 0.08;

export type EcommerceProgressStage = "identifying_product" | "planning_scene" | "generating_image" | "checking_result";
export type EcommerceRolloutStage = "default" | "shadow" | "internal" | "canary";
export type EcommerceRolloutSettings = { mode?: unknown; canaryUserIds?: unknown };

export class EcommerceProductSegmentationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "EcommerceProductSegmentationError";
    }
}

export function isEcommerceImageRequest(run: { generationPreferences?: CreativeGenerationPreferences }, selectedModelCapabilities: string[] = [], hasReferenceImage = false): boolean {
    const explicitMode = run.generationPreferences?.mode;
    if (explicitMode) return explicitMode === "image";
    if (selectedModelCapabilities.length) return selectedModelCapabilities.every((capability) => capability === "image");
    return hasReferenceImage;
}

export function isEcommerceNoAttachmentContinuation(run: { referencedAssetIds: string[]; generationPreferences?: CreativeGenerationPreferences }, selectedModelCapabilities: string[] = []): boolean {
    return run.referencedAssetIds.length === 0 && !run.generationPreferences?.mode && !selectedModelCapabilities.some((capability) => capability !== "image");
}

export function ecommerceGenerationEnabled(
    value: unknown,
    run: { userId?: string; surface: CreativeSurface; referencedAssetIds: string[]; generationPreferences?: CreativeGenerationPreferences },
    hasContinuityResult = false,
    selectedModelCapabilities: string[] = [],
    hasReferenceImage = false,
): boolean {
    const stage = ecommerceRolloutStage(value, run.userId || "");
    return (
        (stage === "internal" || stage === "canary") &&
        run.surface === "chat" &&
        (isEcommerceImageRequest(run, selectedModelCapabilities, hasReferenceImage) || (hasContinuityResult && isEcommerceNoAttachmentContinuation(run, selectedModelCapabilities))) &&
        ((run.referencedAssetIds.length >= 1 && hasReferenceImage) || hasContinuityResult)
    );
}

export function ecommerceRolloutStage(value: unknown, userId: string): EcommerceRolloutStage {
    const settings = normalizeRolloutSettings(value);
    const mode = typeof settings.mode === "string" ? settings.mode.trim().toLowerCase() : "";
    if (mode === "shadow") return "shadow";
    if (mode === "internal") return "internal";
    if (mode === "enabled") return "canary";
    if (mode !== "canary") return "default";
    const canaryUserIds = Array.isArray(settings.canaryUserIds)
        ? settings.canaryUserIds
              .filter((item): item is string => typeof item === "string")
              .map((item) => item.trim())
              .filter(Boolean)
        : [];
    return userId.trim() && canaryUserIds.includes(userId.trim()) ? "canary" : "default";
}

export function publicEcommerceProgress(stage: EcommerceProgressStage): string {
    return {
        identifying_product: "正在识别商品",
        planning_scene: "正在规划场景",
        generating_image: "正在生成图片",
        checking_result: "正在检查商品细节",
    }[stage];
}

function normalizeRolloutSettings(value: unknown): EcommerceRolloutSettings {
    if (value && typeof value === "object" && !Array.isArray(value)) return value as EcommerceRolloutSettings;
    if (typeof value !== "string") return {};
    const source = value.trim();
    if (!source.startsWith("{")) return { mode: source };
    try {
        const parsed = JSON.parse(source);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as EcommerceRolloutSettings) : {};
    } catch {
        return {};
    }
}

export async function loadEcommercePlanningImage(url: string, origin: string, cookie: string, expectedSha256?: string): Promise<Buffer> {
    const source = url.trim();
    let response: Response | null;
    try {
        response = source.startsWith("/api/")
            ? await fetchInternalApi(`${origin}${source}`, { headers: maintenanceWorkerContextHeaders(cookie) || { cookie }, cache: "no-store" })
            : /^https:\/\//i.test(source)
              ? await fetchSafeOutbound(source, { cache: "no-store" })
              : null;
    } catch {
        throw new EcommerceReferenceSourceReadError();
    }
    if (!response?.ok) throw new EcommerceReferenceSourceReadError(response?.status);
    const mimeType = response.headers.get("content-type")?.split(";")[0].toLowerCase() || "";
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (!mimeType.startsWith("image/") || contentLength > CREATIVE_UPLOAD_MAX_BYTES) {
        throw new EcommerceProductSegmentationError("商品图片无效或过大");
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > CREATIVE_UPLOAD_MAX_BYTES) {
        throw new EcommerceProductSegmentationError("商品图片无效或过大");
    }
    if (expectedSha256 !== undefined) assertEcommerceReferenceContent(bytes, expectedSha256);
    return bytes;
}

export async function decodeEcommerceCanvasSize(bytes: Buffer): Promise<EcommerceDimensions> {
    const decoded = await normalizeGeneratedImageBytes(bytes, "image/png");
    const size = { width: decoded.width!, height: decoded.height! };
    validateEcommerceDimensions(size);
    return size;
}

export function ecommerceCanvasInputFromRequest(prompt: string, configuredSize?: string, baselineSize?: EcommerceDimensions): Omit<EcommerceCanvasInput, "operation"> {
    const requested = extractImageSizeFromPrompt(prompt);
    const exact = parseImageDimensions(requested);
    const ratio = !exact && requested.includes(":") ? requested.split(":") : null;
    const scale = ratio ? 10 ** Math.max(...ratio.map((part) => part.split(".")[1]?.length || 0)) : 1;
    const userRequest: EcommerceCanvasInput["userRequest"] = exact
        ? { mode: "exact", size: exact }
        : ratio
          ? { mode: "ratio", size: { width: Math.round(Number(ratio[0]) * scale), height: Math.round(Number(ratio[1]) * scale) } }
          : /(?:保持|保留|维持|沿用|使用|不改变|不变更).{0,8}(?:原(?:图|始)?(?:的)?尺寸|原(?:图|始)?(?:的)?分辨率)|(?:尺寸|分辨率).{0,4}(?:保持不变|不变)|(?:preserve|keep|retain|maintain)\s+(?:the\s+)?original\s+(?:size|dimensions|resolution)|same\s+(?:size|dimensions|resolution)/i.test(
                  prompt,
              )
            ? { mode: "preserve" }
            : undefined;
    const explicitSize = parseImageDimensions(normalizeImageSizeValue(configuredSize));
    return { ...(userRequest ? { userRequest } : {}), ...(explicitSize ? { explicitSize } : {}), ...(baselineSize ? { baselineSize } : {}) };
}

export async function buildWhiteBackgroundProductProtection(source: Buffer, analysis: EcommerceVisualAnalysis, productAssetId: string): Promise<ProductProtectionRegions> {
    const anchors = analysis.references.filter((item) => item.assetId === productAssetId);
    const reference = anchors.length === 1 && anchors[0].role === "product" ? anchors[0] : undefined;
    const detailAnchorAllowed = reference?.role === "product" && reference.confidence === "medium" && reference.visualEvidence.isolatedSubject && (reference.visualEvidence.whiteBackground || reference.visualEvidence.transparentBackground);
    if (!reference || (!detailAnchorAllowed && reference.confidence !== "high") || !reference.visualEvidence.isolatedSubject || (!reference.visualEvidence.whiteBackground && !reference.visualEvidence.transparentBackground)) {
        throw new EcommerceProductSegmentationError("商品图不是高置信度白色或透明背景单主体");
    }

    let decoded: Awaited<ReturnType<typeof decodeProductPixels>>;
    try {
        decoded = await decodeProductPixels(source);
    } catch {
        throw new EcommerceProductSegmentationError("商品图片无法解码");
    }
    const { width, height, channels } = decoded.info;
    if (!width || !height || channels !== 4) throw new EcommerceProductSegmentationError("商品图片像素格式无效");
    const pixels = width * height;
    const transparent = reference.visualEvidence.transparentBackground;
    const backgroundCandidate = (index: number) => {
        const offset = index * channels;
        const alpha = decoded.data[offset + 3];
        if (alpha <= TRANSPARENT_BACKGROUND_MAX_ALPHA) return true;
        if (transparent) return false;
        const red = decoded.data[offset];
        const green = decoded.data[offset + 1];
        const blue = decoded.data[offset + 2];
        return Math.min(red, green, blue) >= WHITE_BACKGROUND_MIN_CHANNEL && Math.max(red, green, blue) - Math.min(red, green, blue) <= 10;
    };
    const border = borderIndexes(width, height);
    const borderRatio = border.filter(backgroundCandidate).length / border.length;
    if (borderRatio < 0.1) throw new EcommerceProductSegmentationError("商品图边界不是可信白色或透明背景");

    const background = floodBackground(width, height, backgroundCandidate);
    const components = connectedComponents(width, height, (index) => !background[index] && decoded.data[index * channels + 3] > TRANSPARENT_BACKGROUND_MAX_ALPHA);
    const minimumArea = Math.max(MIN_SUBJECT_PIXELS, Math.ceil(pixels * 0.005));
    const eligible = components.filter((component) => component.length >= minimumArea).sort((left, right) => right.length - left.length);
    if (!eligible.length) throw new EcommerceProductSegmentationError("没有检测到商品主体");
    if (eligible.slice(1).some((component) => component.length >= eligible[0].length * SECOND_SUBJECT_RATIO)) {
        throw new EcommerceProductSegmentationError("检测到多个独立主体，需要人工复核");
    }

    const subject = eligible[0];
    const subjectSet = new Set(subject);
    const bounds = componentBounds(subject, width);
    if (bounds.x === 0 || bounds.y === 0 || bounds.x + bounds.width === width || bounds.y + bounds.height === height) {
        throw new EcommerceProductSegmentationError("商品主体接触图片边缘，无法生成可信保护蒙版");
    }
    if (borderRatio < MIN_BORDER_BACKGROUND_RATIO) throw new EcommerceProductSegmentationError("商品图边界不是可信白色或透明背景");
    const halo = expand(bounds, width, height);
    const normalizedAnalysis: EcommerceVisualAnalysis = {
        ...analysis,
        references: [{ ...reference, productCore: normalize(bounds, width, height), fusionHalo: normalize(halo, width, height) }],
    };
    const regions = buildProductProtectionRegions(normalizedAnalysis, { width, height });
    const maskBytes = Buffer.alloc(pixels * 4, 255);
    for (let index = 0; index < pixels; index += 1) maskBytes[index * 4 + 3] = subjectSet.has(index) ? 255 : 0;
    const mask = await sharp(maskBytes, { raw: { width, height, channels: 4 } })
        .png()
        .toBuffer();
    regions.editableBackground.mask = {
        trust: "trusted",
        provider: "white-background-flood-fill.v1",
        reference: {
            id: productAssetId + "-background-mask",
            name: "editable-background.png",
            type: "image/png",
            dataUrl: "data:image/png;base64," + mask.toString("base64"),
            width,
            height,
        },
    };
    return regions;
}

export async function buildLocalEditProductProtection(source: Buffer, analysis: EcommerceVisualAnalysis, sourceAssetId: string, productAnchorId: string, target: EcommerceResolvedLocalEditTarget): Promise<ProductProtectionRegions> {
    let decoded: Awaited<ReturnType<typeof decodeProductPixels>>;
    try {
        decoded = await decodeProductPixels(source);
    } catch {
        throw new EcommerceProductSegmentationError("当前场景图片无法解码");
    }
    const { width, height, channels } = decoded.info;
    if (!width || !height || channels !== 4) throw new EcommerceProductSegmentationError("当前场景图片像素格式无效");
    const regions = buildSceneProductProtectionRegions(analysis, sourceAssetId, productAnchorId, { width, height });
    const targetRectangle = normalizedRectangle(target.region, width, height);
    const protectedRectangles = [...regions.productCore.rectangles, ...regions.fusionHalo.rectangles];
    const pixels = width * height;
    const maskBytes = Buffer.alloc(pixels * 4, 255);
    let editablePixels = 0;
    for (let y = targetRectangle.y; y < targetRectangle.y + targetRectangle.height; y += 1) {
        for (let x = targetRectangle.x; x < targetRectangle.x + targetRectangle.width; x += 1) {
            if (protectedRectangles.some((rectangle) => containsPixel(rectangle, x, y))) continue;
            maskBytes[(y * width + x) * 4 + 3] = 0;
            editablePixels += 1;
        }
    }
    if (!editablePixels) throw new EcommerceProductSegmentationError("局部编辑目标完全位于商品保护区域内");
    const mask = await sharp(maskBytes, { raw: { width, height, channels: 4 } })
        .png()
        .toBuffer();
    regions.editableBackground.mask = {
        trust: "trusted",
        provider: "local-edit-target.v1",
        reference: {
            id: sourceAssetId + "-local-edit-mask",
            name: "local-edit-mask.png",
            type: "image/png",
            dataUrl: "data:image/png;base64," + mask.toString("base64"),
            width,
            height,
        },
    };
    return regions;
}

export function createEcommerceProductSceneTask(
    run: { id: string; prompt: string; generationPreferences?: CreativeGenerationPreferences },
    plan: EcommerceEditPlan,
    assets: CreativeAsset[],
    productProtectionRegions: ProductProtectionRegions,
    ecommerceExecution: EcommerceCompiledImageRequest,
): AgentRunTask {
    if (plan.operation !== "product_to_scene" || plan.strategy !== "strict_product") {
        throw new Error("首期商品场景生成只允许 product_to_scene + strict_product");
    }
    if (!plan.source.productAnchorId) throw new Error("商品场景生成缺少商品锚点");
    assertReadyEcommerceExecution(plan, ecommerceExecution);
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    const product = byId.get(plan.source.productAnchorId);
    if (!product || product.type !== "image" || !assetAccessUrl(product)) throw new Error("商品锚点图片不可用");
    const sceneAssets = plan.source.sceneReferenceIds.map((id) => byId.get(id));
    if (sceneAssets.some((asset) => !asset || asset.type !== "image" || !assetAccessUrl(asset))) throw new Error("场景参考图片不可用");
    const references = [product, ...(sceneAssets as CreativeAsset[])].map((asset, index) => ({
        assetId: asset.id,
        url: assetAccessUrl(asset)!,
        type: "image" as const,
        ecommerceRole: index === 0 ? ("product" as const) : ("scene" as const),
        ...(index === 0
            ? {
                  width: productProtectionRegions.sourceSize.width,
                  height: productProtectionRegions.sourceSize.height,
              }
            : {
                  ...(Number.isFinite(asset.width) ? { width: asset.width } : {}),
                  ...(Number.isFinite(asset.height) ? { height: asset.height } : {}),
              }),
    }));
    assertCompiledReferences(references, ecommerceExecution);
    const userPrompt = run.prompt.trim();
    const preferences = run.generationPreferences?.image;
    return {
        id: "ecommerce-product-scene",
        referenceAssetId: product.id,
        referenceUrl: references[0].url,
        referenceType: "image",
        references,
        productProtectionRegions,
        title: "商品场景图",
        type: "image",
        model: ecommerceExecution.modelSnapshot.logicalModelId,
        ecommerceExecution,
        optimizedPrompt: userPrompt,
        prompt: ecommerceExecution.prompt,
        count: Math.max(1, preferences?.count || 1),
        ...(ecommerceExecution.canvas ? { ratio: ecommerceCanvasSize(ecommerceExecution.canvas) } : preferences?.size ? { ratio: preferences.size } : {}),
        ...(preferences?.quality ? { quality: preferences.quality } : {}),
        dependencies: [],
        status: "ready",
        attempts: 0,
    };
}

export function createEcommerceLocalEditTask(
    run: { id: string; prompt: string; generationPreferences?: CreativeGenerationPreferences },
    plan: EcommerceEditPlan,
    assets: CreativeAsset[],
    productProtectionRegions: ProductProtectionRegions,
    ecommerceExecution: EcommerceCompiledImageRequest,
): AgentRunTask {
    if (plan.operation !== "local_edit" || plan.strategy !== "strict_product" || !plan.source.currentSceneBaselineId) {
        throw new Error("首期局部编辑只允许有明确场景基线的 local_edit + strict_product");
    }
    if (!plan.source.productAnchorId) throw new Error("商品局部编辑缺少商品锚点");
    if (productProtectionRegions.productAnchorId !== plan.source.productAnchorId || productProtectionRegions.sourceAssetId !== plan.source.currentSceneBaselineId) {
        throw new Error("局部编辑保护区域与商品锚点或当前场景基线不一致");
    }
    assertReadyEcommerceExecution(plan, ecommerceExecution);
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    const scene = byId.get(plan.source.currentSceneBaselineId);
    const product = byId.get(plan.source.productAnchorId);
    if (!scene || scene.type !== "image" || !assetAccessUrl(scene)) throw new Error("当前场景基线不可用");
    if (!product || product.type !== "image" || !assetAccessUrl(product)) throw new Error("原始商品锚点不可用");
    const references = [
        {
            assetId: scene.id,
            url: assetAccessUrl(scene)!,
            type: "image" as const,
            ecommerceRole: "scene" as const,
            width: productProtectionRegions.sourceSize.width,
            height: productProtectionRegions.sourceSize.height,
        },
        {
            assetId: product.id,
            url: assetAccessUrl(product)!,
            type: "image" as const,
            ecommerceRole: "product" as const,
            ...(Number.isFinite(product.width) ? { width: product.width } : {}),
            ...(Number.isFinite(product.height) ? { height: product.height } : {}),
        },
        ...sceneReferenceAssets(plan, assets).map((asset) => ({
            assetId: asset.id,
            url: assetAccessUrl(asset)!,
            type: "image" as const,
            ecommerceRole: "scene" as const,
            ...(Number.isFinite(asset.width) ? { width: asset.width } : {}),
            ...(Number.isFinite(asset.height) ? { height: asset.height } : {}),
        })),
    ];
    assertCompiledReferences(references, ecommerceExecution);
    const userPrompt = run.prompt.trim();
    const preferences = run.generationPreferences?.image;
    return {
        id: "ecommerce-local-edit",
        referenceAssetId: scene.id,
        referenceUrl: references[0].url,
        referenceType: "image",
        references,
        productProtectionRegions,
        title: "商品场景局部修改",
        type: "image",
        model: ecommerceExecution.modelSnapshot.logicalModelId,
        ecommerceExecution,
        optimizedPrompt: userPrompt,
        prompt: ecommerceExecution.prompt,
        count: Math.max(1, preferences?.count || 1),
        ...(ecommerceExecution.canvas ? { ratio: ecommerceCanvasSize(ecommerceExecution.canvas) } : preferences?.size ? { ratio: preferences.size } : {}),
        ...(preferences?.quality ? { quality: preferences.quality } : {}),
        dependencies: [],
        status: "ready",
        attempts: 0,
    };
}

export function createEcommerceSceneEditTask(
    run: { id: string; prompt: string; generationPreferences?: CreativeGenerationPreferences },
    plan: EcommerceEditPlan,
    assets: CreativeAsset[],
    ecommerceExecution: EcommerceCompiledImageRequest,
    sceneProtection?: SceneEditProtection,
): AgentRunTask {
    if (plan.operation !== "scene_edit" || plan.strategy !== "integrated_scene" || !plan.source.currentSceneBaselineId || plan.source.productAnchorId) {
        throw new Error("场景编辑只允许无商品锚点的 scene_edit + integrated_scene");
    }
    assertReadyEcommerceExecution(plan, ecommerceExecution);
    if (plan.protection?.scope === "local" && (!sceneProtection || sceneProtection.sourceAssetId !== plan.source.currentSceneBaselineId)) throw new Error("局部场景编辑缺少用户确认的允许区域");
    const scene = assets.find((asset) => asset.id === plan.source.currentSceneBaselineId);
    const sceneUrl = scene ? assetAccessUrl(scene) : undefined;
    if (!scene || scene.type !== "image" || !sceneUrl) throw new Error("当前场景基线不可用");
    const references = [
        {
            assetId: scene.id,
            url: sceneUrl,
            type: "image" as const,
            ecommerceRole: "scene" as const,
            ...(Number.isFinite(scene.width) ? { width: scene.width } : {}),
            ...(Number.isFinite(scene.height) ? { height: scene.height } : {}),
        },
        ...sceneReferenceAssets(plan, assets).map((asset) => ({
            assetId: asset.id,
            url: assetAccessUrl(asset)!,
            type: "image" as const,
            ecommerceRole: "scene" as const,
            ...(Number.isFinite(asset.width) ? { width: asset.width } : {}),
            ...(Number.isFinite(asset.height) ? { height: asset.height } : {}),
        })),
    ];
    assertCompiledReferences(references, ecommerceExecution);
    const preferences = run.generationPreferences?.image;
    return {
        id: "ecommerce-scene-edit",
        referenceAssetId: scene.id,
        referenceUrl: sceneUrl,
        referenceType: "image",
        references,
        title: "场景图片修改",
        type: "image",
        model: ecommerceExecution.modelSnapshot.logicalModelId,
        ecommerceExecution,
        ...(sceneProtection ? { sceneProtection: structuredClone(sceneProtection) } : {}),
        optimizedPrompt: run.prompt.trim(),
        prompt: ecommerceExecution.prompt,
        count: Math.max(1, preferences?.count || 1),
        ...(ecommerceExecution.canvas ? { ratio: ecommerceCanvasSize(ecommerceExecution.canvas) } : preferences?.size ? { ratio: preferences.size } : {}),
        ...(preferences?.quality ? { quality: preferences.quality } : {}),
        dependencies: [],
        status: "ready",
        attempts: 0,
    };
}

function assertReadyEcommerceExecution(plan: EcommerceEditPlan, execution: EcommerceCompiledImageRequest) {
    if (JSON.stringify(plan.canvas) !== JSON.stringify(execution.canvas)) throw new Error("生图执行快照与编辑计划的画布约束不一致");
    if (JSON.stringify(plan.protection) !== JSON.stringify(execution.protection)) throw new Error("生图执行快照与编辑计划的保护约束不一致");
    if (execution.state !== "ready") throw new Error("当前生图模型不满足电商图片执行要求");
    if (execution.modelSnapshot.logicalRole !== "image_generation" || execution.modelSnapshot.logicalModelId !== plan.modelRoles.generation) {
        throw new Error("生图执行快照与编辑计划的模型角色不一致");
    }
}

export async function prepareEcommerceSceneSelectionResume(run: AgentRun, selection: unknown, origin: string, cookie: string, actorUserId: string): Promise<AgentRunTask[]> {
    const plan = run.ecommerceSnapshot?.plan;
    const task = ecommerceSceneSelectionTask(run);
    if (!plan || !task?.ecommerceExecution) throw new Error("当前任务不能确认编辑区域");
    if (!actorUserId?.trim() || !selection || typeof selection !== "object") throw new Error("请在原图上确认允许编辑的区域，包含新增物体及其接触阴影");
    const input = selection as { baselineAssetId?: unknown; region?: ProductProtectionRectangle };
    if (input.baselineAssetId !== plan.source.currentSceneBaselineId || !input.region) throw new Error("选区与任务的原图基线不匹配");
    const ids = task.ecommerceExecution.referenceRoles.map((reference) => reference.assetId);
    const assets = await getCreativeAssetsByIds(ids, run.userId);
    if (ids.some((id) => !assets.some((asset) => asset.id === id && asset.userId === run.userId && asset.conversationId === run.conversationId && asset.type === "image" && asset.status === "ready" && assetAccessUrl(asset))))
        throw new Error("参考图片不可用或没有访问权限");
    const baseline = assets.find((asset) => asset.id === input.baselineAssetId && asset.userId === run.userId && asset.conversationId === run.conversationId && asset.type === "image" && asset.status === "ready");
    const url = baseline ? assetAccessUrl(baseline) : undefined;
    if (!baseline || !url) throw new Error("原图不可用或没有访问权限");
    const source = await loadEcommercePlanningImage(url, origin, cookie);
    const protection = await buildSceneEditProtection(source, baseline.id, input.region, plan.delta.requestedChanges, "user_selection");
    protection.confirmation = { actorUserId, confirmedAt: Date.now() };
    const canvas = plan.canvas;
    if (!canvas || canvas.mode !== "exact" || canvas.size.width !== protection.sourceSize.width || canvas.size.height !== protection.sourceSize.height) throw new Error("局部编辑必须保持原图画幅，请重新发起符合原图尺寸的请求");
    const executable = createEcommerceSceneEditTask(run, plan, assets, task.ecommerceExecution, protection);
    return [{ ...executable, id: task.id, count: task.count, attempts: task.attempts }];
}

function sceneReferenceAssets(plan: EcommerceEditPlan, assets: CreativeAsset[]) {
    return [...new Set(plan.source.sceneReferenceIds)]
        .filter((id) => id !== plan.source.currentSceneBaselineId && id !== plan.source.productAnchorId)
        .map((id) => {
            const asset = assets.find((candidate) => candidate.id === id && candidate.type === "image" && candidate.status === "ready");
            if (!asset || !assetAccessUrl(asset)) throw new Error("辅助参考图片不可用");
            return asset;
        });
}

function assertCompiledReferences(references: NonNullable<AgentRunTask["references"]>, execution: EcommerceCompiledImageRequest) {
    const actual = references.map((reference) => ({ assetId: reference.assetId || "", role: reference.ecommerceRole || "" }));
    if (actual.length !== execution.referenceRoles.length || actual.some((reference, index) => reference.assetId !== execution.referenceRoles[index]?.assetId || reference.role !== execution.referenceRoles[index]?.role)) {
        throw new Error("生图编译器的参考图角色与实际任务不一致");
    }
}

function borderIndexes(width: number, height: number) {
    const indexes = new Set<number>();
    for (let x = 0; x < width; x += 1) {
        indexes.add(x);
        indexes.add((height - 1) * width + x);
    }
    for (let y = 0; y < height; y += 1) {
        indexes.add(y * width);
        indexes.add(y * width + width - 1);
    }
    return [...indexes];
}

function decodeProductPixels(source: Buffer) {
    return sharp(source).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

function floodBackground(width: number, height: number, candidate: (index: number) => boolean) {
    const visited = new Uint8Array(width * height);
    const queue = borderIndexes(width, height).filter(candidate);
    queue.forEach((index) => (visited[index] = 1));
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const index = queue[cursor];
        for (const next of neighbors(index, width, height)) {
            if (!visited[next] && candidate(next)) {
                visited[next] = 1;
                queue.push(next);
            }
        }
    }
    return visited;
}

function connectedComponents(width: number, height: number, foreground: (index: number) => boolean) {
    const visited = new Uint8Array(width * height);
    const output: number[][] = [];
    for (let start = 0; start < visited.length; start += 1) {
        if (visited[start] || !foreground(start)) continue;
        const component: number[] = [];
        const queue = [start];
        visited[start] = 1;
        for (let cursor = 0; cursor < queue.length; cursor += 1) {
            const index = queue[cursor];
            component.push(index);
            for (const next of neighbors(index, width, height)) {
                if (!visited[next] && foreground(next)) {
                    visited[next] = 1;
                    queue.push(next);
                }
            }
        }
        output.push(component);
    }
    return output;
}

function neighbors(index: number, width: number, height: number) {
    const x = index % width;
    const y = Math.floor(index / width);
    return [...(x > 0 ? [index - 1] : []), ...(x + 1 < width ? [index + 1] : []), ...(y > 0 ? [index - width] : []), ...(y + 1 < height ? [index + width] : [])];
}

function componentBounds(component: number[], width: number): ProductProtectionRectangle {
    let left = width;
    let top = Number.POSITIVE_INFINITY;
    let right = -1;
    let bottom = -1;
    for (const index of component) {
        const x = index % width;
        const y = Math.floor(index / width);
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
    }
    return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

function expand(bounds: ProductProtectionRectangle, width: number, height: number) {
    const horizontalPadding = Math.max(1, Math.ceil(bounds.width * HALO_RATIO));
    const verticalPadding = Math.max(1, Math.ceil(bounds.height * HALO_RATIO));
    const left = Math.max(0, bounds.x - horizontalPadding);
    const top = Math.max(0, bounds.y - verticalPadding);
    const right = Math.min(width, bounds.x + bounds.width + horizontalPadding);
    const bottom = Math.min(height, bounds.y + bounds.height + verticalPadding);
    return { x: left, y: top, width: right - left, height: bottom - top };
}

function normalize(bounds: ProductProtectionRectangle, width: number, height: number) {
    return { x: bounds.x / width, y: bounds.y / height, width: bounds.width / width, height: bounds.height / height };
}

function normalizedRectangle(region: { x: number; y: number; width: number; height: number }, width: number, height: number): ProductProtectionRectangle {
    const left = Math.round(region.x * width);
    const top = Math.round(region.y * height);
    const right = Math.round((region.x + region.width) * width);
    const bottom = Math.round((region.y + region.height) * height);
    if (left < 0 || top < 0 || right > width || bottom > height || right <= left || bottom <= top) throw new EcommerceProductSegmentationError("局部编辑目标区域无效");
    return { x: left, y: top, width: right - left, height: bottom - top };
}

function containsPixel(rectangle: ProductProtectionRectangle, x: number, y: number) {
    return x >= rectangle.x && x < rectangle.x + rectangle.width && y >= rectangle.y && y < rectangle.y + rectangle.height;
}
