import sharp, { type Metadata } from "sharp";

import { parseImageDimensions } from "@/lib/image-size";

const MAX_INPUT_PIXELS = 40_000_000;

type NormalizedGeneratedImage = {
    bytes: Buffer;
    mimeType: string;
    width?: number;
    height?: number;
};

export async function normalizeGeneratedImageBytes(bytes: Buffer, mimeType: string, targetSize?: string): Promise<NormalizedGeneratedImage> {
    const metadata = await sharp(bytes, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    const dimensions = orientedDimensions(metadata);
    const target = targetSize ? parseImageDimensions(targetSize) : null;
    if (!target) return { bytes, mimeType: imageMimeType(metadata.format, mimeType), ...dimensions };
    assertTargetDimensions(target.width, target.height);
    if (dimensions.width === target.width && dimensions.height === target.height) return { bytes, mimeType: imageMimeType(metadata.format, mimeType), ...dimensions };

    const pipeline = sharp(bytes, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS }).rotate().resize(target.width, target.height, { fit: "cover", position: "centre" });
    if (metadata.format === "jpeg") pipeline.jpeg({ quality: 95, chromaSubsampling: "4:4:4" });
    const result = await pipeline.toBuffer({ resolveWithObject: true });
    return {
        bytes: result.data,
        mimeType: imageMimeType(result.info.format, mimeType),
        width: result.info.width,
        height: result.info.height,
    };
}

function orientedDimensions(metadata: Metadata) {
    const rotated = metadata.orientation && metadata.orientation >= 5 && metadata.orientation <= 8;
    const width = rotated ? metadata.height : metadata.width;
    const height = rotated ? metadata.width : metadata.height;
    return {
        width: Number.isFinite(width) && Number(width) > 0 ? Number(width) : undefined,
        height: Number.isFinite(height) && Number(height) > 0 ? Number(height) : undefined,
    };
}

function assertTargetDimensions(width: number, height: number) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
        throw new Error("目标图片尺寸无效");
    }
}

function imageMimeType(format: string | undefined, fallback: string) {
    if (format === "jpg" || format === "jpeg") return "image/jpeg";
    if (format === "png" || format === "webp" || format === "gif" || format === "avif" || format === "tiff") return `image/${format}`;
    return fallback;
}
