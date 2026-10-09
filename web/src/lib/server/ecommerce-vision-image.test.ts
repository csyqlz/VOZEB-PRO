import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { ECOMMERCE_VISION_IMAGE_MAX_BYTES, ECOMMERCE_VISION_IMAGE_MAX_DIMENSION, boundEcommerceVisionImage } from "./ecommerce-vision-image";

describe("ecommerce vision image payloads", () => {
    it("bounds large reference images before they are embedded in a model request", async () => {
        const source = await sharp({ create: { width: 4096, height: 3072, channels: 4, background: { r: 245, g: 245, b: 245, alpha: 1 } } })
            .png()
            .toBuffer();

        const bounded = await boundEcommerceVisionImage(`data:image/png;base64,${source.toString("base64")}`);
        const match = bounded.match(/^data:image\/([^;]+);base64,(.+)$/);

        expect(match?.[1]).toBe("jpeg");
        expect(Buffer.from(match?.[2] || "", "base64").length).toBeLessThanOrEqual(ECOMMERCE_VISION_IMAGE_MAX_BYTES);
        await expect(sharp(Buffer.from(match?.[2] || "", "base64")).metadata()).resolves.toMatchObject({
            format: "jpeg",
            width: ECOMMERCE_VISION_IMAGE_MAX_DIMENSION,
        });
    });
});
