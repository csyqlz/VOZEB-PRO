"use client";

import type { CanvasImageDecomposition, CanvasImageLayerBox, CanvasImageLayerCandidate } from "@/lib/canvas-image-decomposition";
import { originalImageDownloadUrl } from "@/lib/media-image-url";
import { renderCanvasPromptedSubjectLayers, renderCanvasSubjectLayers, type CanvasSubjectLayerResult, type CanvasSubjectMask } from "./canvas-subject-segmentation";

type ImageCropRect = {
    x: number;
    y: number;
    width: number;
    height: number;
};

export type CanvasImageLayerData = {
    foregroundBlob: Blob;
    editMaskBlob: Blob;
    width: number;
    height: number;
    foregroundPixels: number;
    backgroundPixels: number;
};

export type CanvasImageDecompositionData = {
    width: number;
    height: number;
    editMaskBlob: Blob;
    validationMaskBlob: Blob;
    layers: Array<{ candidate: CanvasImageLayerCandidate; blob: Blob; width: number; height: number }>;
};

export type CanvasImageEditChange = {
    editedPixels: number;
    changedPixels: number;
    changedRatio: number;
    meanAbsoluteDifference: number;
};

export type ImageUpscaleAlgorithm = "nearest" | "bilinear" | "high";

export const MAX_UPSCALE_LONG_EDGE = 4096;

export function resolveCanvasImageDecompositionSource(input: { content?: string; serverUrl?: string; remoteUrl?: string }) {
    return input.serverUrl?.trim() || input.remoteUrl?.trim() || input.content?.trim() || "";
}

export type ImageUpscaleParams = {
    targetLongEdge: number;
    algorithm: ImageUpscaleAlgorithm;
};

export type ImageSplitParams = {
    rows: number;
    columns: number;
};

type ImageSplitPiece = {
    row: number;
    column: number;
    dataUrl: string;
};

export async function cropDataUrl(dataUrl: string, crop?: ImageCropRect) {
    const image = await loadImage(dataUrl);
    if (crop) {
        return drawCrop(image, Math.floor(crop.x * image.width), Math.floor(crop.y * image.height), Math.ceil(crop.width * image.width), Math.ceil(crop.height * image.height));
    }
    const size = Math.min(image.width, image.height);
    const sx = Math.max(0, Math.floor((image.width - size) / 2));
    const sy = Math.max(0, Math.floor((image.height - size) / 2));
    return drawCrop(image, sx, sy, size, size);
}

export async function splitDataUrl(dataUrl: string, params: ImageSplitParams): Promise<ImageSplitPiece[]> {
    const image = await loadImage(dataUrl);
    const rows = Math.max(1, Math.floor(params.rows));
    const columns = Math.max(1, Math.floor(params.columns));
    const pieces: ImageSplitPiece[] = [];

    for (let row = 0; row < rows; row += 1) {
        const sy = Math.floor((row * image.height) / rows);
        const sh = Math.floor(((row + 1) * image.height) / rows) - sy;
        for (let column = 0; column < columns; column += 1) {
            const sx = Math.floor((column * image.width) / columns);
            const sw = Math.floor(((column + 1) * image.width) / columns) - sx;
            pieces.push({ row, column, dataUrl: drawCrop(image, sx, sy, sw, sh) });
        }
    }

    return pieces;
}

/** Uses the local semantic mask to create a transparent subject and an edit mask. */
export async function splitSubjectAndBackgroundDataUrl(dataUrl: string, signal?: AbortSignal): Promise<CanvasImageLayerData> {
    const result = await renderCanvasSubjectLayers(dataUrl, signal);
    if (result.kind === "blobs") return result;
    const image = await loadImage(dataUrl);
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("浏览器不支持图片处理");
    context.drawImage(image, 0, 0);
    const source = context.getImageData(0, 0, canvas.width, canvas.height);
    const { foreground, editMask, foregroundPixels, backgroundPixels } = applySubjectMaskToImageData(source, result.mask);
    const [foregroundBlob, editMaskBlob] = await Promise.all([imageDataBlob(foreground, canvas.width, canvas.height), imageDataBlob(editMask, canvas.width, canvas.height)]);
    return {
        foregroundBlob,
        editMaskBlob,
        width: canvas.width,
        height: canvas.height,
        foregroundPixels,
        backgroundPixels,
    };
}

export async function buildCanvasImageDecompositionData(dataUrl: string, decomposition: CanvasImageDecomposition, onLayerProgress?: (progress: { completed: number; total: number; name: string }) => void): Promise<CanvasImageDecompositionData> {
    const image = await loadImage(originalImageDownloadUrl(dataUrl));
    const boxes = decomposition.layers.map((candidate) => {
        const box = scaleLayerBox(candidate.bbox, decomposition.width, decomposition.height, image.width, image.height);
        const cropBox = expandLayerBox(box, image.width, image.height);
        return {
            box: cropBox,
            targetRegion: layerTargetRegionWithinCrop(box, cropBox, image.width, image.height),
            removalBoxes: [candidate.bbox, ...(candidate.regions || [])].map((region) => expandLayerRemovalBox(scaleLayerBox(region, decomposition.width, decomposition.height, image.width, image.height), image.width, image.height)),
            focusPoints: layerFocusPointsWithinCrop(candidate, decomposition.width, decomposition.height, image.width, image.height, cropBox),
            candidate: {
                ...candidate,
                bbox: candidate.bbox,
            },
        };
    });
    const layers: CanvasImageDecompositionData["layers"] = [];
    const mask = document.createElement("canvas");
    mask.width = image.width;
    mask.height = image.height;
    const maskContext = mask.getContext("2d");
    if (!maskContext) throw new Error("浏览器不支持图片处理");
    maskContext.fillStyle = "#fff";
    maskContext.fillRect(0, 0, mask.width, mask.height);
    maskContext.globalCompositeOperation = "destination-out";
    const validationMask = document.createElement("canvas");
    validationMask.width = image.width;
    validationMask.height = image.height;
    const validationMaskContext = validationMask.getContext("2d");
    if (!validationMaskContext) throw new Error("浏览器不支持图片处理");
    validationMaskContext.fillStyle = "#fff";
    validationMaskContext.fillRect(0, 0, validationMask.width, validationMask.height);
    validationMaskContext.globalCompositeOperation = "destination-out";
    let completedLayers = 0;
    for (const { candidate, box, focusPoints, targetRegion, removalBoxes } of boxes) {
        await yieldToBrowser();
        const crop = drawCropCanvas(image, box);
        const foreground = await extractCanvasImageLayer(crop, candidate.name, focusPoints, targetRegion);
        validationMaskContext.drawImage(foreground, box.x, box.y);
        const trimmed = await trimTransparentCanvas(foreground, candidate.name);
        layers.push({ candidate, ...trimmed });
        for (const removalBox of removalBoxes) maskContext.fillRect(removalBox.x, removalBox.y, removalBox.width, removalBox.height);
        completedLayers += 1;
        onLayerProgress?.({ completed: completedLayers, total: boxes.length, name: candidate.name });
    }
    const [editMaskBlob, validationMaskBlob] = await Promise.all([canvasBlob(mask), canvasBlob(validationMask)]);
    return { width: image.width, height: image.height, editMaskBlob, validationMaskBlob, layers };
}

async function extractCanvasImageLayer(crop: HTMLCanvasElement, layerName: string, focusPoints: Array<{ x: number; y: number }>, targetRegion: { x: number; y: number; width: number; height: number }) {
    const source = crop.getContext("2d", { willReadFrequently: true })?.getImageData(0, 0, crop.width, crop.height);
    if (!source) throw new Error(`浏览器不支持处理${layerName}`);
    if (hasVisibleTransparency(source.data)) return crop;
    const result = await renderCanvasPromptedSubjectLayers(await canvasBlob(crop), focusPoints, targetRegion);
    return renderCanvasSubjectForeground(crop, result, layerName);
}

async function renderCanvasSubjectForeground(sourceCanvas: HTMLCanvasElement, result: CanvasSubjectLayerResult, layerName: string) {
    const canvas = document.createElement("canvas");
    canvas.width = sourceCanvas.width;
    canvas.height = sourceCanvas.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error(`浏览器不支持处理${layerName}`);
    if (result.kind === "blobs") {
        const image = await createImageBitmap(result.foregroundBlob);
        try {
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
        } finally {
            image.close();
        }
    } else {
        const source = sourceCanvas.getContext("2d", { willReadFrequently: true })?.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
        if (!source) throw new Error(`浏览器不支持处理${layerName}`);
        const foreground = applySubjectMaskToImageData(source, result.mask).foreground;
        context.putImageData(new ImageData(foreground, canvas.width, canvas.height), 0, 0);
    }
    if (!hasVisibleTransparency(context.getImageData(0, 0, canvas.width, canvas.height).data)) throw new Error(`${layerName}没有生成透明背景`);
    return canvas;
}

function layerFocusPointsWithinCrop(candidate: CanvasImageLayerCandidate, decompositionWidth: number, decompositionHeight: number, imageWidth: number, imageHeight: number, crop: CanvasImageLayerBox) {
    const sourcePoints = candidate.focusPoints?.length ? [...candidate.focusPoints] : [{ x: candidate.bbox.x + candidate.bbox.width / 2, y: candidate.bbox.y + candidate.bbox.height / 2 }];
    const unique = new Map<string, { x: number; y: number }>();
    for (const point of sourcePoints) {
        const x = Math.min(1, Math.max(0, (point.x * (imageWidth / decompositionWidth) - crop.x) / crop.width));
        const y = Math.min(1, Math.max(0, (point.y * (imageHeight / decompositionHeight) - crop.y) / crop.height));
        unique.set(`${x.toFixed(4)}:${y.toFixed(4)}`, { x, y });
    }
    return [...unique.values()];
}

function layerTargetRegionWithinCrop(target: CanvasImageLayerBox, crop: CanvasImageLayerBox, sourceWidth: number, sourceHeight: number) {
    const margin = Math.max(2, Math.round(Math.min(target.width, target.height) / 16));
    const left = Math.max(0, target.x - margin);
    const top = Math.max(0, target.y - margin);
    const right = Math.min(sourceWidth, target.x + target.width + margin);
    const bottom = Math.min(sourceHeight, target.y + target.height + margin);
    return {
        x: (left - crop.x) / crop.width,
        y: (top - crop.y) / crop.height,
        width: (right - left) / crop.width,
        height: (bottom - top) / crop.height,
    };
}

function hasVisibleTransparency(data: Uint8ClampedArray) {
    let visible = false;
    let transparent = false;
    for (let offset = 3; offset < data.length && (!visible || !transparent); offset += 4) {
        visible ||= data[offset] >= 8;
        transparent ||= data[offset] < 255;
    }
    return visible && transparent;
}

export async function compositeCanvasImageEditResult(sourceUrl: string, generatedUrl: string, editMaskUrl: string, validationMaskUrl?: string) {
    const [sourceImage, generatedImage, maskImage, validationMaskImage] = await Promise.all([loadImage(sourceUrl), loadImage(generatedUrl), loadImage(editMaskUrl), validationMaskUrl ? loadImage(validationMaskUrl) : undefined]);
    const width = sourceImage.width;
    const height = sourceImage.height;
    const source = drawImageData(sourceImage, width, height);
    const generated = drawImageData(generatedImage, width, height);
    const mask = drawImageData(maskImage, width, height);
    const validationMask = validationMaskImage ? drawImageData(validationMaskImage, width, height) : mask;
    assertCanvasImageEditChanged(source, generated, validationMask);
    const composite = compositeImageDataWithinMask(source, generated, mask);
    return imageDataBlob(composite.data, width, height);
}

export function measureCanvasImageEditChange(source: Pick<ImageData, "data" | "width" | "height">, generated: Pick<ImageData, "data" | "width" | "height">, editMask: Pick<ImageData, "data" | "width" | "height">): CanvasImageEditChange {
    const expectedLength = source.width * source.height * 4;
    if (source.width < 1 || source.height < 1 || source.data.length !== expectedLength) throw new Error("源图片像素数据无效");
    if (generated.width !== source.width || generated.height !== source.height || generated.data.length !== expectedLength) throw new Error("背景补全结果尺寸无效");
    if (editMask.width !== source.width || editMask.height !== source.height || editMask.data.length !== expectedLength) throw new Error("背景补全蒙版尺寸无效");
    let editedPixels = 0;
    let changedPixels = 0;
    let difference = 0;
    for (let offset = 0; offset < expectedLength; offset += 4) {
        if (editMask.data[offset + 3] >= 128) continue;
        editedPixels += 1;
        const pixelDifference = Math.abs(source.data[offset] - generated.data[offset]) + Math.abs(source.data[offset + 1] - generated.data[offset + 1]) + Math.abs(source.data[offset + 2] - generated.data[offset + 2]);
        difference += pixelDifference;
        if (pixelDifference >= 24) changedPixels += 1;
    }
    return {
        editedPixels,
        changedPixels,
        changedRatio: editedPixels ? changedPixels / editedPixels : 0,
        meanAbsoluteDifference: editedPixels ? difference / (editedPixels * 3) : 0,
    };
}

export function assertCanvasImageEditChanged(source: Pick<ImageData, "data" | "width" | "height">, generated: Pick<ImageData, "data" | "width" | "height">, editMask: Pick<ImageData, "data" | "width" | "height">) {
    const change = measureCanvasImageEditChange(source, generated, editMask);
    if (!change.editedPixels) throw new Error("背景补全蒙版没有可编辑区域");
    if (change.changedRatio < 0.08 || change.meanAbsoluteDifference < 4) throw new Error("背景补全未清除原有元素，请重试分层");
    return change;
}

export function compositeImageDataWithinMask(source: Pick<ImageData, "data" | "width" | "height">, generated: Pick<ImageData, "data" | "width" | "height">, editMask: Pick<ImageData, "data" | "width" | "height">) {
    const expectedLength = source.width * source.height * 4;
    if (source.width < 1 || source.height < 1 || source.data.length !== expectedLength) throw new Error("源图片像素数据无效");
    if (generated.width !== source.width || generated.height !== source.height || generated.data.length !== expectedLength) throw new Error("背景补全结果尺寸无效");
    if (editMask.width !== source.width || editMask.height !== source.height || editMask.data.length !== expectedLength) throw new Error("背景补全蒙版尺寸无效");
    const data = new Uint8ClampedArray(expectedLength);
    for (let offset = 0; offset < expectedLength; offset += 4) {
        const preserveWeight = editMask.data[offset + 3] / 255;
        const editWeight = 1 - preserveWeight;
        for (let channel = 0; channel < 4; channel += 1) data[offset + channel] = Math.round(source.data[offset + channel] * preserveWeight + generated.data[offset + channel] * editWeight);
    }
    return { data, width: source.width, height: source.height };
}

export function scaleLayerBox(box: CanvasImageLayerBox, sourceWidth: number, sourceHeight: number, targetWidth: number, targetHeight: number): CanvasImageLayerBox {
    const left = Math.max(0, Math.floor((box.x / sourceWidth) * targetWidth));
    const top = Math.max(0, Math.floor((box.y / sourceHeight) * targetHeight));
    const right = Math.min(targetWidth, Math.ceil(((box.x + box.width) / sourceWidth) * targetWidth));
    const bottom = Math.min(targetHeight, Math.ceil(((box.y + box.height) / sourceHeight) * targetHeight));
    return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

export function applySubjectMaskToImageData(source: Pick<ImageData, "data" | "width" | "height">, subjectMask: CanvasSubjectMask) {
    if (source.width < 1 || source.height < 1 || source.data.length !== source.width * source.height * 4) throw new Error("源图片像素数据无效");
    if (subjectMask.width < 1 || subjectMask.height < 1 || subjectMask.data.length !== subjectMask.width * subjectMask.height) throw new Error("主体蒙版尺寸无效");
    const foreground = new Uint8ClampedArray(source.data);
    const editMask = new Uint8ClampedArray(source.data.length);
    let foregroundPixels = 0;
    let backgroundPixels = 0;
    for (let y = 0; y < source.height; y += 1) {
        for (let x = 0; x < source.width; x += 1) {
            const confidence = sampleSubjectConfidence(subjectMask, x, y, source.width, source.height);
            const offset = (y * source.width + x) * 4;
            foreground[offset + 3] = Math.round(source.data[offset + 3] * confidence);
            editMask[offset] = 255;
            editMask[offset + 1] = 255;
            editMask[offset + 2] = 255;
            editMask[offset + 3] = Math.round(255 * (1 - confidence));
            if (confidence >= 0.5) foregroundPixels += 1;
            else backgroundPixels += 1;
        }
    }
    return { foreground, editMask, foregroundPixels, backgroundPixels };
}

export async function upscaleDataUrl(dataUrl: string, params: ImageUpscaleParams) {
    const image = await loadImage(dataUrl);
    const { width, height } = resolveUpscaleSize(image.width, image.height, params.targetLongEdge);
    return params.algorithm === "high" ? drawStepUpscale(image, width, height) : drawResize(image, image.width, image.height, width, height, params.algorithm);
}

export function resolveUpscaleSize(width: number, height: number, targetLongEdge: number) {
    const longEdge = Math.max(1, width, height);
    const target = Math.min(MAX_UPSCALE_LONG_EDGE, Math.max(1, Math.round(targetLongEdge)));
    const scale = target / longEdge;
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function drawCrop(image: HTMLImageElement, sx: number, sy: number, sw: number, sh: number) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, sw);
    canvas.height = Math.max(1, sh);
    const context = canvas.getContext("2d");
    if (!context) return image.src;
    context.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
}

function drawCropCanvas(image: HTMLImageElement, box: CanvasImageLayerBox) {
    const canvas = document.createElement("canvas");
    canvas.width = box.width;
    canvas.height = box.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器不支持图片处理");
    context.drawImage(image, box.x, box.y, box.width, box.height, 0, 0, canvas.width, canvas.height);
    return canvas;
}

export async function validateAndTrimCanvasTransparentLayer(source: string, layerName: string) {
    const canvas = await loadValidatedTransparentCanvas(source, layerName);
    return trimTransparentCanvas(canvas, layerName);
}

export async function validateCanvasTransparentLayer(source: string, layerName: string) {
    await loadValidatedTransparentCanvas(source, layerName);
}

async function loadValidatedTransparentCanvas(source: string, layerName: string) {
    const image = await loadImage(source);
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error(`浏览器不支持处理${layerName}`);
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const hasTransparency = pixels.data.some((value, index) => index % 4 === 3 && value < 255);
    if (!hasTransparency) throw new Error(`${layerName}没有生成透明背景`);
    if (!findCanvasAlphaBounds(pixels)) throw new Error(`没有识别到${layerName}的透明轮廓`);
    return canvas;
}

async function trimTransparentCanvas(canvas: HTMLCanvasElement, layerName: string) {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error(`浏览器不支持裁切${layerName}`);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const bounds = findCanvasAlphaBounds(pixels);
    if (!bounds) throw new Error(`没有识别到${layerName}的透明轮廓`);
    const trimmed = document.createElement("canvas");
    trimmed.width = bounds.width;
    trimmed.height = bounds.height;
    const trimmedContext = trimmed.getContext("2d");
    if (!trimmedContext) throw new Error(`浏览器不支持生成${layerName}`);
    trimmedContext.putImageData(context.getImageData(bounds.x, bounds.y, trimmed.width, trimmed.height), 0, 0);
    return { blob: await canvasBlob(trimmed), width: trimmed.width, height: trimmed.height };
}

export function findCanvasAlphaBounds(input: Pick<ImageData, "data" | "width" | "height">, threshold = 8): CanvasImageLayerBox | null {
    if (input.width < 1 || input.height < 1 || input.data.length !== input.width * input.height * 4) throw new Error("透明图层像素数据无效");
    let left = input.width;
    let top = input.height;
    let right = -1;
    let bottom = -1;
    for (let y = 0; y < input.height; y += 1) {
        for (let x = 0; x < input.width; x += 1) {
            if (input.data[(y * input.width + x) * 4 + 3] < threshold) continue;
            left = Math.min(left, x);
            top = Math.min(top, y);
            right = Math.max(right, x);
            bottom = Math.max(bottom, y);
        }
    }
    return right < left || bottom < top ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

export function expandLayerBox(box: CanvasImageLayerBox, sourceWidth: number, sourceHeight: number): CanvasImageLayerBox {
    const margin = Math.max(4, Math.round(Math.min(box.width, box.height) / 5));
    const left = Math.max(0, box.x - margin);
    const top = Math.max(0, box.y - margin);
    const right = Math.min(sourceWidth, box.x + box.width + margin);
    const bottom = Math.min(sourceHeight, box.y + box.height + margin);
    return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

export function expandLayerRemovalBox(box: CanvasImageLayerBox, sourceWidth: number, sourceHeight: number): CanvasImageLayerBox {
    const margin = Math.max(3, Math.round(Math.min(box.width, box.height) / 20));
    const left = Math.max(0, box.x - margin);
    const top = Math.max(0, box.y - margin);
    const right = Math.min(sourceWidth, box.x + box.width + margin);
    const bottom = Math.min(sourceHeight, box.y + box.height + margin);
    return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

export function applySubjectMaskToCropImageData(source: Pick<ImageData, "data" | "width" | "height">, box: CanvasImageLayerBox, sourceWidth: number, sourceHeight: number, mask: CanvasSubjectMask) {
    if (source.width !== box.width || source.height !== box.height || source.data.length !== box.width * box.height * 4) throw new Error("主体图层裁片尺寸无效");
    if (sourceWidth < box.x + box.width || sourceHeight < box.y + box.height) throw new Error("主体图层边界超出原图");
    const data = new Uint8ClampedArray(source.data);
    for (let y = 0; y < box.height; y += 1) {
        for (let x = 0; x < box.width; x += 1) {
            const offset = (y * box.width + x) * 4;
            const confidence = sampleSubjectConfidence(mask, box.x + x, box.y + y, sourceWidth, sourceHeight);
            data[offset + 3] = Math.round(data[offset + 3] * confidence);
        }
    }
    return { data, width: source.width, height: source.height };
}

function drawImageData(image: CanvasImageSource, width: number, height: number) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("浏览器不支持图片处理");
    context.drawImage(image, 0, 0, width, height);
    return context.getImageData(0, 0, width, height);
}

async function yieldToBrowser() {
    const scheduler = (globalThis as typeof globalThis & { scheduler?: { yield?: () => Promise<void> } }).scheduler;
    if (scheduler?.yield) return scheduler.yield();
    if (typeof requestAnimationFrame === "function") await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function drawStepUpscale(image: HTMLImageElement, width: number, height: number) {
    let source: CanvasImageSource = image;
    let sourceWidth = image.width;
    let sourceHeight = image.height;

    while (sourceWidth * 2 < width && sourceHeight * 2 < height) {
        const nextWidth = sourceWidth * 2;
        const nextHeight = sourceHeight * 2;
        const next = drawResizeCanvas(source, sourceWidth, sourceHeight, nextWidth, nextHeight, "high");
        source = next;
        sourceWidth = nextWidth;
        sourceHeight = nextHeight;
    }

    return drawResize(source, sourceWidth, sourceHeight, width, height, "high");
}

function drawResize(source: CanvasImageSource, sourceWidth: number, sourceHeight: number, width: number, height: number, algorithm: ImageUpscaleAlgorithm) {
    return drawResizeCanvas(source, sourceWidth, sourceHeight, width, height, algorithm).toDataURL("image/png");
}

function drawResizeCanvas(source: CanvasImageSource, sourceWidth: number, sourceHeight: number, width: number, height: number, algorithm: ImageUpscaleAlgorithm) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return canvas;
    context.imageSmoothingEnabled = algorithm !== "nearest";
    context.imageSmoothingQuality = algorithm === "bilinear" ? "medium" : "high";
    context.drawImage(source, 0, 0, sourceWidth, sourceHeight, 0, 0, width, height);
    return canvas;
}

function loadImage(dataUrl: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("图片读取失败，无法处理图像"));
        image.src = dataUrl;
    });
}

function sampleSubjectConfidence(mask: CanvasSubjectMask, x: number, y: number, width: number, height: number) {
    const sourceX = width === 1 ? 0 : (x / (width - 1)) * (mask.width - 1);
    const sourceY = height === 1 ? 0 : (y / (height - 1)) * (mask.height - 1);
    const left = Math.floor(sourceX);
    const top = Math.floor(sourceY);
    const right = Math.min(mask.width - 1, left + 1);
    const bottom = Math.min(mask.height - 1, top + 1);
    const horizontal = sourceX - left;
    const vertical = sourceY - top;
    const topValue = mask.data[top * mask.width + left] * (1 - horizontal) + mask.data[top * mask.width + right] * horizontal;
    const bottomValue = mask.data[bottom * mask.width + left] * (1 - horizontal) + mask.data[bottom * mask.width + right] * horizontal;
    return Math.max(0, Math.min(1, topValue * (1 - vertical) + bottomValue * vertical));
}

function imageDataBlob(data: Uint8ClampedArray, width: number, height: number) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器不支持图片处理");
    const pixels = new Uint8ClampedArray(data.length);
    pixels.set(data);
    context.putImageData(new ImageData(pixels, width, height), 0, 0);
    return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("图片编码失败，无法生成图层"))), "image/png"));
}

function canvasBlob(canvas: HTMLCanvasElement) {
    return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("图片编码失败，无法生成图层"))), "image/png"));
}
