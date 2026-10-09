import { closestImageAspectRatio, parseImageDimensions } from "@/lib/image-size";
import { GenerationSubmissionSafeFailure } from "@/lib/server/generation-submission-error";
import { ecommerceCanvasSize, validateEcommerceDimensions, type EcommerceCanvasProviderRequest } from "@/lib/server/ecommerce-edit-plan";
import { updateImageTask, type ImageTask } from "@/lib/server/image-task-store";

import { DEFAULT_IMAGE_SHORT_SIDE, IMAGE_MIN_PIXELS, IMAGE_SIZE_STEP, QUALITY_ALIASES, QUALITY_BASE } from "./image-task-types";

export class EcommerceCanvasAdapterReview extends Error {
    constructor(adapter: string) {
        super(`当前 ${adapter} 图片适配器尚不支持画布约束，需复核后选择已验证的适配器`);
    }
}

export function resolveCanvasRequestSize(task: ImageTask, quality: string | undefined): string | undefined {
    const canvas = task.ecommerceExecution?.canvas;
    if (!canvas) return resolveRequestSize(quality, task.config.size || "auto");
    validateEcommerceDimensions(canvas.size);
    if (canvas.mode === "exact") return ecommerceCanvasSize(canvas);
    const ratio = ecommerceCanvasSize(canvas);
    const { width, height } = parseImageRatio(ratio);
    const basePixels = quality ? QUALITY_BASE[quality] : undefined;
    const targetPixels = basePixels ? basePixels * basePixels : DEFAULT_IMAGE_SHORT_SIDE * DEFAULT_IMAGE_SHORT_SIDE * (Math.max(width, height) / Math.min(width, height));
    const scale = Math.max(1, Math.round(Math.sqrt(targetPixels / (width * height))));
    const size = { width: width * scale, height: height * scale };
    validateEcommerceDimensions(size);
    return `${size.width}x${size.height}`;
}

export function canvasProviderDimensions(request: EcommerceCanvasProviderRequest | undefined) {
    if (!request) return undefined;
    return parseImageDimensions(request.size || "") || (request.width && request.height ? { width: request.width, height: request.height } : undefined);
}

export async function recordEcommerceCanvasRequest(task: ImageTask, request: EcommerceCanvasProviderRequest, adapter: string) {
    const canvas = task.ecommerceExecution?.canvas;
    if (!canvas) return;
    const dimensions = canvasProviderDimensions(request);
    const ratio = request.aspectRatio || (request.size?.includes(":") ? request.size : undefined);
    const geometries = [dimensions, ratio ? parseImageRatio(ratio) : undefined].filter((size) => size !== undefined);
    if (!geometries.length || (canvas.mode === "exact" && !dimensions)) throw new EcommerceCanvasAdapterReview(adapter);
    for (const size of geometries) {
        validateEcommerceDimensions(size);
        if (BigInt(size.width) * BigInt(canvas.size.height) !== BigInt(size.height) * BigInt(canvas.size.width)) throw new EcommerceCanvasAdapterReview(adapter);
    }
    if (canvas.mode === "exact" && (dimensions!.width !== canvas.size.width || dimensions!.height !== canvas.size.height)) throw new EcommerceCanvasAdapterReview(adapter);
    await updateImageTask(task.id, { ecommerceCanvasRequest: request });
    task.ecommerceCanvasRequest = request;
}

export function templateCanvasRequest(template: string, payload: unknown): EcommerceCanvasProviderRequest {
    const request: EcommerceCanvasProviderRequest = {};
    const collect = (source: unknown, rendered: unknown) => {
        if (typeof source === "string") {
            const key = source.match(/^\{\{\s*(size|ratio|aspect_ratio|width|height)\s*\}\}$/)?.[1];
            if (key && (typeof rendered === "string" || typeof rendered === "number")) {
                if (key === "width" || key === "height") request[key] = Number(rendered);
                else if (key === "size") request.size = String(rendered);
                else request.aspectRatio = String(rendered);
            }
        } else if (source && typeof source === "object" && rendered && typeof rendered === "object") {
            for (const [key, value] of Object.entries(source)) collect(value, (rendered as Record<string, unknown>)[key]);
        }
    };
    collect(JSON.parse(template), payload);
    return request;
}

export function resolveRequestSize(quality: string | undefined, size: string) {
    try {
        const value = size.trim();
        if (!value || value.toLowerCase() === "auto") return undefined;
        const dimensions = parseImageDimensions(value);
        if (dimensions) {
            validateImageDimensions(dimensions.width, dimensions.height);
            return upstreamImageSize(dimensions.width, dimensions.height);
        }
        if (value.includes(":")) return resolveSize(quality, value);
        throw new Error("图片尺寸格式不支持，请使用 auto、9:16 或 1024x1024");
    } catch (error) {
        if (error instanceof GenerationSubmissionSafeFailure) throw error;
        throw new GenerationSubmissionSafeFailure(error instanceof Error ? error.message : "图片尺寸参数无效");
    }
}

export function resolveResultSize(quality: string | undefined, size: string) {
    const value = size.trim();
    const dimensions = parseImageDimensions(value);
    if (dimensions) {
        validateImageDimensions(dimensions.width, dimensions.height);
        return `${dimensions.width}x${dimensions.height}`;
    }
    const qualityValue = String(quality || "")
        .trim()
        .toLowerCase();
    const normalizedQuality = QUALITY_ALIASES[qualityValue] || qualityValue;
    return resolveRequestSize(QUALITY_BASE[normalizedQuality] ? normalizedQuality : undefined, value);
}

export function imageRequestAspectRatio(size: string) {
    const value = size.trim();
    if (value.toLowerCase() === "auto") return undefined;
    if (/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(value)) return value;
    const dimensions = parseImageDimensions(value);
    return dimensions ? closestImageAspectRatio(dimensions.width, dimensions.height) : undefined;
}

export function resolveSize(quality: string | undefined, ratio: string): string {
    const parsedRatio = parseImageRatio(ratio);
    const basePixels = quality ? QUALITY_BASE[quality] : undefined;
    const isLandscape = parsedRatio.width >= parsedRatio.height;
    const longRatio = isLandscape ? parsedRatio.width / parsedRatio.height : parsedRatio.height / parsedRatio.width;
    let longSide: number;
    let shortSide: number;
    if (basePixels) {
        const targetPixels = basePixels * basePixels;
        const longSideRaw = Math.sqrt(targetPixels * longRatio);
        longSide = Math.floor(longSideRaw / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
        shortSide = Math.round(longSide / longRatio / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
    } else {
        shortSide = DEFAULT_IMAGE_SHORT_SIDE;
        longSide = Math.round((shortSide * longRatio) / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
    }
    const width = isLandscape ? longSide : shortSide;
    const height = isLandscape ? shortSide : longSide;
    validateImageSize(width, height);
    return `${width}x${height}`;
}

export function parseImageRatio(value: string) {
    const parts = value.split(":");
    if (parts.length !== 2) throw new Error("图片尺寸格式不支持，请使用 auto、9:16 或 1024x1024");
    const width = Number(parts[0]);
    const height = Number(parts[1]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error("图片比例必须是正数，例如 9:16");
    return { width, height };
}

export { parseImageDimensions };

export function validateImageSize(width: number, height: number) {
    validateImageDimensions(width, height);
}

function validateImageDimensions(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error("图片尺寸必须是正整数，例如 1024x1024");
}

function upstreamImageSize(width: number, height: number) {
    if (width * height >= IMAGE_MIN_PIXELS) return `${width}x${height}`;
    const scale = Math.sqrt(IMAGE_MIN_PIXELS / (width * height));
    const align = (value: number) => Math.ceil(value / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
    const shortSide = align(Math.min(width, height) * scale);
    const upstreamWidth = width <= height ? shortSide : align(shortSide * (width / height));
    const upstreamHeight = height <= width ? shortSide : align(shortSide * (height / width));
    validateImageSize(upstreamWidth, upstreamHeight);
    return `${upstreamWidth}x${upstreamHeight}`;
}
