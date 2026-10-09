import type { ImageTaskConfig, ImageTaskReference } from "./image-task-store";
import type { EcommerceNormalizedRegion, EcommerceVisualAnalysis } from "./ecommerce-visual-analysis";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { resolveImageEditProtocol } from "./image-edit-protocol";

export type SceneEditProtection = {
    version: "scene-edit-protection.v1";
    sourceAssetId: string;
    sourceSize: ProductProtectionSourceSize;
    sourceDigest: string;
    maskSize: ProductProtectionSourceSize;
    maskDigest: string;
    targetRegion: ProductProtectionRectangle;
    semantics: string[];
    selectionSource: "user_selection";
    confirmation?: { actorUserId: string; confirmedAt: number };
    maskSemantics: "alpha_zero_edit";
    method: "source_pixels_copy";
    mask: ImageTaskReference;
};
export type SceneEditProtectionEvidence = Omit<SceneEditProtection, "mask"> & {
    nativeSize: ProductProtectionSourceSize;
    normalization: "none" | "uniform_scale" | "pixel_grid_scale";
    nativeDigest: string;
    compositeDigest: string;
    outsidePixels: number;
    mappedOutsideChangedPixels: number;
    nativeOutsideChangedPixels?: number;
    compositeOutsideChangedPixels: 0;
    maskUrl?: string;
    nativeUrl?: string;
    compositeUrl?: string;
};

export async function buildSceneEditProtection(source: Buffer, sourceAssetId: string, region: ProductProtectionRectangle, semantics: string[], selectionSource: "user_selection" | "analysis_hint"): Promise<SceneEditProtection> {
    if (selectionSource !== "user_selection") throw new Error("局部场景编辑需要用户确认允许区域，自动矩形不是可信语义蒙版");
    const { info } = await decodeScenePixels(source);
    const sourceSize = { width: info.width, height: info.height };
    if (!sourceAssetId?.trim() || !validRectangle(region, sourceSize)) throw new Error("允许编辑区域越界或尺寸无效");
    if (region.width * region.height === sourceSize.width * sourceSize.height) throw new Error("整图选区必须使用全局编辑范围");
    if (!semantics.length || semantics.some((value) => typeof value !== "string" || !value.trim())) throw new Error("允许编辑区域缺少语义");
    const pixels = Buffer.alloc(sourceSize.width * sourceSize.height * 4, 255);
    for (let y = region.y; y < region.y + region.height; y++) for (let x = region.x; x < region.x + region.width; x++) pixels[(y * sourceSize.width + x) * 4 + 3] = 0;
    const bytes = await sharp(pixels, { raw: { ...sourceSize, channels: 4 } })
        .png()
        .toBuffer();
    return {
        version: "scene-edit-protection.v1",
        sourceAssetId,
        sourceSize,
        sourceDigest: digest(source),
        maskSize: { ...sourceSize },
        maskDigest: digest(bytes),
        targetRegion: { ...region },
        semantics: [...semantics],
        selectionSource,
        maskSemantics: "alpha_zero_edit",
        method: "source_pixels_copy",
        mask: { id: sourceAssetId + "-scene-edit-mask", name: "scene-edit-mask.png", type: "image/png", ...sourceSize, dataUrl: "data:image/png;base64," + bytes.toString("base64") },
    };
}

export async function validateSceneEditProtection(source: Buffer, protection: SceneEditProtection) {
    if (protection?.version !== "scene-edit-protection.v1" || protection.selectionSource !== "user_selection" || protection.maskSemantics !== "alpha_zero_edit" || protection.method !== "source_pixels_copy" || protection.sourceDigest !== digest(source))
        throw new Error("局部场景保护来源或语义无效");
    const decoded = await decodeScenePixels(source);
    if (!sameSize(decoded.info, protection.sourceSize) || !sameSize(protection.maskSize, protection.sourceSize) || !sameSize(protection.mask, protection.sourceSize) || !validRectangle(protection.targetRegion, protection.sourceSize))
        throw new Error("源图或蒙版尺寸与保护快照不一致");
    if (protection.targetRegion.width * protection.targetRegion.height === protection.sourceSize.width * protection.sourceSize.height) throw new Error("局部场景保护不能覆盖整图");
    const bytes = inlinePngBytes(protection.mask.dataUrl);
    const mask = await decodeScenePixels(bytes);
    if (!sameSize(mask.info, protection.sourceSize)) throw new Error("蒙版尺寸必须与源图一致");
    for (let y = 0; y < mask.info.height; y++)
        for (let x = 0; x < mask.info.width; x++) {
            const alpha = mask.data[(y * mask.info.width + x) * 4 + 3];
            if (alpha !== (inside(protection.targetRegion, x, y) ? 0 : 255)) throw new Error("蒙版反向或覆盖了允许区域之外的像素");
        }
    if (digest(bytes) !== protection.maskDigest) throw new Error("蒙版与不可变快照不一致");
    return decoded;
}

export async function compositeSceneEdit(source: Buffer, generated: Buffer, protection: SceneEditProtection): Promise<{ bytes: Buffer; evidence: SceneEditProtectionEvidence }> {
    const original = await validateSceneEditProtection(source, protection);
    const native = await decodeScenePixels(generated);
    const sourceSize = protection.sourceSize;
    const nativeSize = { width: native.info.width, height: native.info.height };
    const cross = BigInt(nativeSize.width) * BigInt(sourceSize.height) - BigInt(nativeSize.height) * BigInt(sourceSize.width);
    // Both rounded edges must admit one common scale: each half-up interval excludes its upper bound.
    if (BigInt(2) * (cross < BigInt(0) ? -cross : cross) >= BigInt(sourceSize.width) + BigInt(sourceSize.height))
        throw new Error(`局部编辑上游原生画幅比例与源图不一致，禁止拉伸或裁切（源图 ${sourceSize.width}x${sourceSize.height}，原生 ${nativeSize.width}x${nativeSize.height}）`);
    const normalization = sameSize(nativeSize, sourceSize) ? "none" : cross === BigInt(0) ? "uniform_scale" : "pixel_grid_scale";
    const pixels =
        normalization === "none"
            ? Buffer.from(native.data)
            : await sharp(native.data, { raw: { ...nativeSize, channels: 4 } })
                  .resize(sourceSize.width, sourceSize.height, { fit: "fill" })
                  .raw()
                  .toBuffer();
    let outsidePixels = 0;
    let mappedOutsideChangedPixels = 0;
    for (let y = 0; y < sourceSize.height; y++)
        for (let x = 0; x < sourceSize.width; x++) {
            if (inside(protection.targetRegion, x, y)) continue;
            const offset = (y * sourceSize.width + x) * 4;
            outsidePixels++;
            const originalPixel = original.data.readUInt32LE(offset);
            if (pixels.readUInt32LE(offset) !== originalPixel) mappedOutsideChangedPixels++;
            pixels.writeUInt32LE(originalPixel, offset);
        }
    const bytes = await sharp(pixels, { raw: { ...sourceSize, channels: 4 } })
        .png()
        .toBuffer();
    const persistedPixels = (await decodeScenePixels(bytes)).data;
    for (let y = 0; y < sourceSize.height; y++)
        for (let x = 0; x < sourceSize.width; x++) {
            if (inside(protection.targetRegion, x, y)) continue;
            const offset = (y * sourceSize.width + x) * 4;
            if (persistedPixels.readUInt32LE(offset) !== original.data.readUInt32LE(offset)) throw new Error("选区外像素保护验证失败");
        }
    const { mask: _mask, ...snapshot } = protection;
    return {
        bytes,
        evidence: {
            ...structuredClone(snapshot),
            nativeSize,
            normalization,
            nativeDigest: digest(generated),
            compositeDigest: digest(bytes),
            outsidePixels,
            mappedOutsideChangedPixels,
            ...(normalization === "none" ? { nativeOutsideChangedPixels: mappedOutsideChangedPixels } : {}),
            compositeOutsideChangedPixels: 0,
        },
    };
}

function decodeScenePixels(bytes: Buffer) {
    return sharp(bytes).rotate().toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}
function inlinePngBytes(value: string) {
    if (!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value || "")) throw new Error("独立蒙版必须为可验证的 PNG");
    return Buffer.from(value.split(",")[1], "base64");
}
function digest(bytes: Buffer) {
    return createHash("sha256").update(bytes).digest("hex");
}
function inside(region: ProductProtectionRectangle, x: number, y: number) {
    return x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height;
}

export const STRICT_PRODUCT_COMPILER_VERSION = "strict-product.v1" as const;

export type ProductProtectionSourceSize = { width: number; height: number };
export type ProductProtectionRectangle = { x: number; y: number; width: number; height: number };
export type ProductProtectionMask = {
    width: number;
    height: number;
    rectangles: ProductProtectionRectangle[];
    mask?: {
        trust: "trusted" | "untrusted";
        provider: string;
        reference: ImageTaskReference;
    };
};
export type ProductProtectionRegions = {
    productAnchorId: string;
    sourceAssetId: string;
    sourceSize: ProductProtectionSourceSize;
    productCore: ProductProtectionMask;
    fusionHalo: ProductProtectionMask;
    editableBackground: ProductProtectionMask;
};
export type ProductProtectionSnapshot = {
    compilerVersion: typeof STRICT_PRODUCT_COMPILER_VERSION;
    state: "ready" | "needs_review";
    productAnchorId: string;
    sourceAssetId: string;
    sourceSize: ProductProtectionSourceSize;
    productCore: ProductProtectionRectangle[];
    fusionHalo: ProductProtectionRectangle[];
    editableBackground: ProductProtectionRectangle[];
    maskProvider?: string;
    reason?: string;
};

type StrictProductEditTask = {
    kind: "edit";
    prompt: string;
    config: Pick<ImageTaskConfig, "apiFormat" | "model" | "baseUrl" | "advancedConfig">;
    references: ImageTaskReference[];
    mask?: ImageTaskReference;
    productProtection?: ProductProtectionSnapshot;
};

export type StrictProductCompilation<T extends StrictProductEditTask> =
    { state: "ready"; task: T & { mask: ImageTaskReference; productProtection: ProductProtectionSnapshot } } | { state: "needs_review"; reason: string; task: T & { mask?: undefined; productProtection: ProductProtectionSnapshot } };

export function buildProductProtectionRegions(analysis: EcommerceVisualAnalysis, sourceSize: ProductProtectionSourceSize): ProductProtectionRegions {
    assertSourceSize(sourceSize);
    const products = analysis.references.filter((reference) => reference.role === "product" && reference.productCore && reference.fusionHalo);
    if (products.length !== 1) throw new Error("商品保护区域需要且只能使用一张已确认商品图");
    const product = products[0];
    return buildProtectionRegions(product.assetId, product.assetId, product.productCore!, product.fusionHalo!, sourceSize);
}

export function buildSceneProductProtectionRegions(analysis: EcommerceVisualAnalysis, sourceAssetId: string, productAnchorId: string, sourceSize: ProductProtectionSourceSize): ProductProtectionRegions {
    assertSourceSize(sourceSize);
    const scene = analysis.references.find((reference) => reference.assetId === sourceAssetId && reference.role === "scene" && reference.productCore && reference.fusionHalo);
    if (!scene?.productCore || !scene.fusionHalo) throw new Error("当前场景缺少可信商品保护区域");
    return buildProtectionRegions(productAnchorId, sourceAssetId, scene.productCore, scene.fusionHalo, sourceSize);
}

function buildProtectionRegions(productAnchorId: string, sourceAssetId: string, productRegion: EcommerceNormalizedRegion, haloRegion: EcommerceNormalizedRegion, sourceSize: ProductProtectionSourceSize) {
    const productCore = toPixelRectangle(productRegion, sourceSize);
    const haloBounds = toPixelRectangle(haloRegion, sourceSize);
    if (!contains(haloBounds, productCore)) throw new Error("融合光晕区必须完整包围商品核心区");

    const regions: ProductProtectionRegions = {
        productAnchorId,
        sourceAssetId,
        sourceSize: { ...sourceSize },
        productCore: mask(sourceSize, [productCore]),
        fusionHalo: mask(sourceSize, innerRing(haloBounds, productCore)),
        editableBackground: mask(sourceSize, outerArea(sourceSize, haloBounds)),
    };
    validateProductProtectionRegions(regions, sourceSize);
    return regions;
}

export function validateProductProtectionRegions(regions: ProductProtectionRegions, sourceSize: ProductProtectionSourceSize): void {
    assertSourceSize(sourceSize);
    if (!regions || typeof regions !== "object") throw new Error("商品保护区域无效");
    if (!regions.productAnchorId?.trim()) throw new Error("商品保护区域缺少商品锚点");
    if (!regions.sourceAssetId?.trim()) throw new Error("商品保护区域缺少当前编辑源图");
    if (!sameSize(regions.sourceSize, sourceSize)) throw new Error("商品保护区域尺寸必须与源图一致");

    const entries = [
        ["商品核心区", regions.productCore],
        ["融合光晕区", regions.fusionHalo],
        ["可编辑背景", regions.editableBackground],
    ] as const;
    for (const [, regionMask] of entries) validateLogicalMask(regionMask, sourceSize);
    if (!regions.productCore.rectangles.length) throw new Error("商品核心区不能为空");
    if (!regions.fusionHalo.rectangles.length) throw new Error("融合光晕区不能为空");

    if (hasOverlap(regions.productCore.rectangles, regions.editableBackground.rectangles)) {
        throw new Error("可编辑背景不得覆盖商品核心区");
    }
    if (hasOverlap(regions.productCore.rectangles, regions.fusionHalo.rectangles)) {
        throw new Error("融合光晕区不得覆盖商品核心区");
    }
    if (regions.fusionHalo.rectangles.some((rectangle) => !regions.productCore.rectangles.some((core) => adjacent(rectangle, core)))) {
        throw new Error("融合光晕区必须与商品核心区相邻");
    }
    assertBoundedHalo(regions.productCore.rectangles, regions.fusionHalo.rectangles);

    const allRectangles = entries.flatMap(([, regionMask]) => regionMask.rectangles);
    if (containsOverlap(allRectangles)) throw new Error("商品保护区域不得互相重叠");
    if (pixelCount(allRectangles) !== sourceSize.width * sourceSize.height) throw new Error("商品保护区域必须完整覆盖源图");

    const trustedMask = regions.editableBackground.mask;
    if (trustedMask?.trust === "trusted") {
        if (!sameSize(trustedMask.reference, sourceSize)) throw new Error("蒙版尺寸必须与源图一致");
        if (!hasImageSource(trustedMask.reference)) throw new Error("可信商品蒙版缺少可读取的图片来源");
    }
}

export function compileStrictProductEdit<T extends StrictProductEditTask>(task: T, regions: ProductProtectionRegions): StrictProductCompilation<T> {
    validateProductProtectionRegions(regions, regions.sourceSize);
    const review = (reason: string): StrictProductCompilation<T> => ({
        state: "needs_review",
        reason,
        task: {
            ...task,
            mask: undefined,
            productProtection: protectionSnapshot(regions, "needs_review", reason),
        },
    });
    const source = task.references.find((reference) => reference.id === regions.sourceAssetId);
    if (!source) return review("严格商品任务没有找到当前编辑源图");
    if (!sameSize(source, regions.sourceSize)) return review("当前编辑源图尺寸与商品保护区域不一致");
    const maskInput = regions.editableBackground.mask;
    if (maskInput?.trust !== "trusted" || !hasImageSource(maskInput.reference)) {
        return review("严格商品任务缺少可信商品蒙版，禁止静默执行整图生成");
    }
    if (!resolveImageEditProtocol(task.config).supportsIndependentMask) {
        return review("当前 provider 不支持可信独立蒙版，严格商品任务需要人工复核");
    }
    return {
        state: "ready",
        task: {
            ...task,
            prompt: strictProductPrompt(task.prompt),
            mask: { ...maskInput.reference },
            productProtection: protectionSnapshot(regions, "ready"),
        },
    };
}

function protectionSnapshot(regions: ProductProtectionRegions, state: ProductProtectionSnapshot["state"], reason?: string): ProductProtectionSnapshot {
    return {
        compilerVersion: STRICT_PRODUCT_COMPILER_VERSION,
        state,
        productAnchorId: regions.productAnchorId,
        sourceAssetId: regions.sourceAssetId,
        sourceSize: { ...regions.sourceSize },
        productCore: cloneRectangles(regions.productCore.rectangles),
        fusionHalo: cloneRectangles(regions.fusionHalo.rectangles),
        editableBackground: cloneRectangles(regions.editableBackground.rectangles),
        maskProvider: regions.editableBackground.mask?.provider,
        reason,
    };
}

function strictProductPrompt(prompt: string) {
    return [
        "严格商品保护：商品核心像素不得重绘；保持商品外观、颜色、比例、材质、Logo 与关键辨识细节。",
        "仅使用独立编辑蒙版重绘可编辑背景；融合光晕只用于接触阴影、边缘光和场景融合，不得改变商品结构。",
        "不得把蒙版当作视觉参考图，也不得在缺少独立蒙版支持时退回整图生成。",
        "",
        `用户要求：${prompt.trim()}`,
    ].join("\n");
}

function validateLogicalMask(regionMask: ProductProtectionMask, sourceSize: ProductProtectionSourceSize) {
    if (!regionMask || !sameSize(regionMask, sourceSize)) throw new Error("蒙版尺寸必须与源图一致");
    if (!Array.isArray(regionMask.rectangles)) throw new Error("商品保护区域矩形列表无效");
    for (const rectangle of regionMask.rectangles) {
        if (!validRectangle(rectangle, sourceSize)) throw new Error("商品保护区域矩形越界或尺寸无效");
    }
    if (containsOverlap(regionMask.rectangles)) throw new Error("同一商品保护区域内不得重叠");
}

function assertBoundedHalo(core: ProductProtectionRectangle[], halo: ProductProtectionRectangle[]) {
    const coreBounds = bounds(core);
    const protectedBounds = bounds([...core, ...halo]);
    const horizontalAllowance = Math.max(1, Math.ceil(coreBounds.width * 0.25));
    const verticalAllowance = Math.max(1, Math.ceil(coreBounds.height * 0.25));
    if (
        coreBounds.x - protectedBounds.x > horizontalAllowance ||
        protectedBounds.x + protectedBounds.width - (coreBounds.x + coreBounds.width) > horizontalAllowance ||
        coreBounds.y - protectedBounds.y > verticalAllowance ||
        protectedBounds.y + protectedBounds.height - (coreBounds.y + coreBounds.height) > verticalAllowance
    ) {
        throw new Error("融合光晕区范围过大");
    }
}

function toPixelRectangle(region: EcommerceNormalizedRegion, sourceSize: ProductProtectionSourceSize): ProductProtectionRectangle {
    const values = [region.x, region.y, region.width, region.height];
    if (values.some((value) => !Number.isFinite(value)) || region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0) {
        throw new Error("商品保护区域坐标无效");
    }
    const x = Math.round(region.x * sourceSize.width);
    const y = Math.round(region.y * sourceSize.height);
    const right = Math.round((region.x + region.width) * sourceSize.width);
    const bottom = Math.round((region.y + region.height) * sourceSize.height);
    const rectangle = { x, y, width: right - x, height: bottom - y };
    if (!validRectangle(rectangle, sourceSize)) throw new Error("商品保护区域矩形越界或尺寸无效");
    return rectangle;
}

function innerRing(outer: ProductProtectionRectangle, inner: ProductProtectionRectangle) {
    return compactRectangles([
        { x: outer.x, y: outer.y, width: outer.width, height: inner.y - outer.y },
        { x: outer.x, y: inner.y, width: inner.x - outer.x, height: inner.height },
        { x: inner.x + inner.width, y: inner.y, width: outer.x + outer.width - inner.x - inner.width, height: inner.height },
        { x: outer.x, y: inner.y + inner.height, width: outer.width, height: outer.y + outer.height - inner.y - inner.height },
    ]);
}

function outerArea(sourceSize: ProductProtectionSourceSize, inner: ProductProtectionRectangle) {
    return compactRectangles([
        { x: 0, y: 0, width: sourceSize.width, height: inner.y },
        { x: 0, y: inner.y, width: inner.x, height: inner.height },
        { x: inner.x + inner.width, y: inner.y, width: sourceSize.width - inner.x - inner.width, height: inner.height },
        { x: 0, y: inner.y + inner.height, width: sourceSize.width, height: sourceSize.height - inner.y - inner.height },
    ]);
}

function mask(sourceSize: ProductProtectionSourceSize, rectangles: ProductProtectionRectangle[]): ProductProtectionMask {
    return { ...sourceSize, rectangles };
}

function compactRectangles(rectangles: ProductProtectionRectangle[]) {
    return rectangles.filter((rectangle) => rectangle.width > 0 && rectangle.height > 0);
}

function cloneRectangles(rectangles: ProductProtectionRectangle[]) {
    return rectangles.map((rectangle) => ({ ...rectangle }));
}

function validRectangle(rectangle: ProductProtectionRectangle, sourceSize: ProductProtectionSourceSize) {
    return (
        rectangle &&
        [rectangle.x, rectangle.y, rectangle.width, rectangle.height].every(Number.isInteger) &&
        rectangle.x >= 0 &&
        rectangle.y >= 0 &&
        rectangle.width > 0 &&
        rectangle.height > 0 &&
        rectangle.x + rectangle.width <= sourceSize.width &&
        rectangle.y + rectangle.height <= sourceSize.height
    );
}

function adjacent(left: ProductProtectionRectangle, right: ProductProtectionRectangle) {
    const horizontalTouch = (left.x + left.width === right.x || right.x + right.width === left.x) && Math.max(left.y, right.y) < Math.min(left.y + left.height, right.y + right.height);
    const verticalTouch = (left.y + left.height === right.y || right.y + right.height === left.y) && Math.max(left.x, right.x) < Math.min(left.x + left.width, right.x + right.width);
    return horizontalTouch || verticalTouch;
}

function contains(outer: ProductProtectionRectangle, inner: ProductProtectionRectangle) {
    return outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.width >= inner.x + inner.width && outer.y + outer.height >= inner.y + inner.height;
}

function hasOverlap(left: ProductProtectionRectangle[], right: ProductProtectionRectangle[]) {
    return left.some((first) => right.some((second) => overlaps(first, second)));
}

function containsOverlap(rectangles: ProductProtectionRectangle[]) {
    return rectangles.some((rectangle, index) => rectangles.slice(index + 1).some((candidate) => overlaps(rectangle, candidate)));
}

function overlaps(left: ProductProtectionRectangle, right: ProductProtectionRectangle) {
    return Math.max(left.x, right.x) < Math.min(left.x + left.width, right.x + right.width) && Math.max(left.y, right.y) < Math.min(left.y + left.height, right.y + right.height);
}

function bounds(rectangles: ProductProtectionRectangle[]) {
    const left = Math.min(...rectangles.map((rectangle) => rectangle.x));
    const top = Math.min(...rectangles.map((rectangle) => rectangle.y));
    const right = Math.max(...rectangles.map((rectangle) => rectangle.x + rectangle.width));
    const bottom = Math.max(...rectangles.map((rectangle) => rectangle.y + rectangle.height));
    return { x: left, y: top, width: right - left, height: bottom - top };
}

function pixelCount(rectangles: ProductProtectionRectangle[]) {
    return rectangles.reduce((total, rectangle) => total + rectangle.width * rectangle.height, 0);
}

function sameSize(value: { width?: number; height?: number } | undefined, sourceSize: ProductProtectionSourceSize) {
    return value?.width === sourceSize.width && value.height === sourceSize.height;
}

function hasImageSource(reference: ImageTaskReference) {
    return Boolean(reference.dataUrl || reference.url || reference.remoteUrl || reference.serverUrl);
}

function assertSourceSize(sourceSize: ProductProtectionSourceSize) {
    if (!Number.isInteger(sourceSize?.width) || !Number.isInteger(sourceSize?.height) || sourceSize.width <= 0 || sourceSize.height <= 0) {
        throw new Error("源图尺寸必须是正整数");
    }
}
