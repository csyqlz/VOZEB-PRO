import { closestImageAspectRatio, parseImageDimensions } from "@/lib/image-size";
import { GenerationSubmissionSafeFailure } from "@/lib/server/generation-submission-error";

import { DEFAULT_IMAGE_SHORT_SIDE, IMAGE_MIN_PIXELS, IMAGE_SIZE_STEP, QUALITY_ALIASES, QUALITY_BASE } from "./image-task-types";

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

/** Align explicit dimensions for gateways that reject non-16-pixel edges. */
export function resolveProviderRequestSize(quality: string | undefined, size: string, protocol?: string) {
    const requestSize = resolveRequestSize(quality, size);
    return (protocol === "sub2api" || protocol === "custom") && requestSize ? alignImageSizeToStep(requestSize) : requestSize;
}

export function alignImageSizeToStep(size: string, step = IMAGE_SIZE_STEP) {
    const dimensions = parseImageDimensions(size);
    if (!dimensions) return size;
    const align = (value: number) => Math.ceil(value / step) * step;
    return `${align(dimensions.width)}x${align(dimensions.height)}`;
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
    if (/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(value)) return value;
    const dimensions = parseImageDimensions(value);
    return (dimensions && closestImageAspectRatio(dimensions.width, dimensions.height)) || "1:1";
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
