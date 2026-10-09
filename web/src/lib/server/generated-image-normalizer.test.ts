import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { normalizeGeneratedImageBytes } from "./generated-image-normalizer";

describe("generated image normalization", () => {
    it("resizes an upstream image to the exact requested dimensions", async () => {
        const source = await sharp({ create: { width: 1600, height: 900, channels: 3, background: "#7c8da5" } })
            .png()
            .toBuffer();
        const result = await normalizeGeneratedImageBytes(source, "image/png", "1824x1024");

        expect(result).toMatchObject({ mimeType: "image/png", width: 1824, height: 1024 });
        await expect(sharp(result.bytes).metadata()).resolves.toMatchObject({ format: "png", width: 1824, height: 1024 });
    });

    it("restores a provider-safe image to a small exact requested size", async () => {
        const source = await sharp({ create: { width: 672, height: 1008, channels: 3, background: "#9a6b4f" } })
            .png()
            .toBuffer();
        const result = await normalizeGeneratedImageBytes(source, "image/png", "400x600");

        expect(result).toMatchObject({ mimeType: "image/png", width: 400, height: 600 });
        await expect(sharp(result.bytes).metadata()).resolves.toMatchObject({ format: "png", width: 400, height: 600 });
    });

    it("keeps full chroma detail when resizing a generated JPEG", async () => {
        const source = await sharp({ create: { width: 1600, height: 900, channels: 3, background: "#9a6b4f" } })
            .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
            .toBuffer();
        const result = await normalizeGeneratedImageBytes(source, "image/jpeg", "1280x720");

        expect(result).toMatchObject({ mimeType: "image/jpeg", width: 1280, height: 720 });
        await expect(sharp(result.bytes).metadata()).resolves.toMatchObject({ format: "jpeg", width: 1280, height: 720, chromaSubsampling: "4:4:4" });
    });

    it("keeps the upstream file unchanged when no exact target is configured", async () => {
        const source = await sharp({ create: { width: 1280, height: 720, channels: 3, background: "#506070" } })
            .jpeg({ quality: 92 })
            .toBuffer();
        const result = await normalizeGeneratedImageBytes(source, "image/jpeg", "16:9");

        expect(result).toMatchObject({ mimeType: "image/jpeg", width: 1280, height: 720 });
        expect(result.bytes).toEqual(source);
    });

    it("keeps a large exact upstream image instead of applying a platform edge ceiling", async () => {
        const source = await sharp({ create: { width: 1600, height: 900, channels: 3, background: "#203040" } })
            .webp()
            .toBuffer();
        const result = await normalizeGeneratedImageBytes(source, "image/webp", "4096x2304");

        expect(result).toMatchObject({ width: 4096, height: 2304 });
        await expect(sharp(result.bytes).metadata()).resolves.toMatchObject({ format: "webp", width: 4096, height: 2304 });
    });
});
