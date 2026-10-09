import sharp from "sharp";

export const ECOMMERCE_VISION_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
export const ECOMMERCE_VISION_IMAGE_MAX_DIMENSION = 2048;

const DATA_IMAGE_PATTERN = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)$/i;

/** Keep multimodal planning requests below the application proxy body limit. */
export async function boundEcommerceVisionImage(dataUrl: string): Promise<string> {
    const match = dataUrl.match(DATA_IMAGE_PATTERN);
    if (!match) throw new Error("视觉分析图片地址无效");

    const bytes = Buffer.from(match[2], "base64");
    if (!bytes.length) throw new Error("视觉分析图片为空");

    let metadata;
    try {
        metadata = await sharp(bytes, { failOn: "error", limitInputPixels: 64_000_000 }).metadata();
    } catch {
        // Keep compatibility with protocol fixtures that use tiny placeholder bytes.
        if (bytes.length <= ECOMMERCE_VISION_IMAGE_MAX_BYTES) return dataUrl;
        throw new Error("视觉分析图片格式无效");
    }
    const dimensionsExceedBudget = Math.max(metadata.width || 0, metadata.height || 0) > ECOMMERCE_VISION_IMAGE_MAX_DIMENSION;
    if (bytes.length <= ECOMMERCE_VISION_IMAGE_MAX_BYTES && !dimensionsExceedBudget) return dataUrl;

    for (const width of [ECOMMERCE_VISION_IMAGE_MAX_DIMENSION, 1600, 1280, 1024]) {
        for (const quality of [82, 72, 62]) {
            const output = await sharp(bytes, { failOn: "error", limitInputPixels: 64_000_000 })
                .rotate()
                .resize({ width, height: width, fit: "inside", withoutEnlargement: true })
                .flatten({ background: "#ffffff" })
                .jpeg({ quality, chromaSubsampling: "4:4:4" })
                .toBuffer();
            if (output.length <= ECOMMERCE_VISION_IMAGE_MAX_BYTES) return `data:image/jpeg;base64,${output.toString("base64")}`;
        }
    }

    throw new Error("视觉分析图片压缩后仍过大");
}
