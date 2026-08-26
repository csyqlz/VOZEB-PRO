import { describe, expect, it } from "vitest";
import sharp from "sharp";

import { assertTransparentImageOutput } from "./image-transparent-output";

describe("transparent image output validation", () => {
    it("accepts an image containing both visible content and transparent background", async () => {
        const base = await sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
            .composite([
                {
                    input: await sharp({ create: { width: 2, height: 2, channels: 4, background: "#ef4444" } })
                        .png()
                        .toBuffer(),
                    left: 1,
                    top: 1,
                },
            ])
            .png()
            .toBuffer();

        await expect(assertTransparentImageOutput(dataUrl(base))).resolves.toBeUndefined();
    });

    it("rejects an opaque result", async () => {
        const opaque = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#ef4444" } })
            .png()
            .toBuffer();

        await expect(assertTransparentImageOutput(dataUrl(opaque))).rejects.toThrow("上游没有生成透明背景");
    });

    it("rejects an empty transparent result", async () => {
        const empty = await sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
            .png()
            .toBuffer();

        await expect(assertTransparentImageOutput(dataUrl(empty))).rejects.toThrow("上游生成了全透明空图");
    });
});

function dataUrl(bytes: Buffer) {
    return `data:image/png;base64,${bytes.toString("base64")}`;
}
