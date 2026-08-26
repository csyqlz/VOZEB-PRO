import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { validateImageLayerOutputs } from "./image-layer-output";

describe("image layer output validation", () => {
    it("accepts exact source pixels, independent alpha layers, and a clean background", async () => {
        const fixture = await layerFixture();

        const result = await validateImageLayerOutputs(fixture.source, [fixture.element, fixture.background]);

        expect(result).toMatchObject([
            { kind: "element", width: 4, height: 4, mimeType: "image/png" },
            { kind: "background", width: 4, height: 4, mimeType: "image/png" },
        ]);
    });

    it("rejects a redrawn element even when it has a real alpha channel", async () => {
        const fixture = await layerFixture();
        const redrawn = await transparentLayer("#22c55e");

        await expect(validateImageLayerOutputs(fixture.source, [redrawn, fixture.background])).rejects.toThrow("元素不是源图原始像素");
    });

    it("rejects a layer whose canvas no longer matches the source", async () => {
        const fixture = await layerFixture();
        const cropped = dataUrl(
            await sharp({ create: { width: 2, height: 2, channels: 4, background: "#ef4444" } })
                .png()
                .toBuffer(),
        );

        await expect(validateImageLayerOutputs(fixture.source, [cropped, fixture.background])).rejects.toThrow("尺寸与源图不一致");
    });

    it("rejects duplicate element layers instead of silently deduplicating them", async () => {
        const fixture = await layerFixture();

        await expect(validateImageLayerOutputs(fixture.source, [fixture.element, fixture.element, fixture.background])).rejects.toThrow("存在重复像素");
    });

    it("rejects a background that changes pixels outside the extracted elements", async () => {
        const fixture = await layerFixture();
        const wrongBackground = dataUrl(
            await sharp({ create: { width: 4, height: 4, channels: 3, background: "#ffffff" } })
                .png()
                .toBuffer(),
        );

        await expect(validateImageLayerOutputs(fixture.source, [fixture.element, wrongBackground])).rejects.toThrow("背景改动了元素之外的源图内容");
    });

    it("rejects a background that still contains the extracted element", async () => {
        const fixture = await layerFixture();

        await expect(validateImageLayerOutputs(fixture.source, [fixture.element, fixture.source])).rejects.toThrow("背景没有移除全部独立元素");
    });

    it("validates twenty independent element layers without merging them", async () => {
        const width = 21;
        const height = 2;
        const backgroundBytes = await sharp({ create: { width, height, channels: 3, background: "#ffffff" } })
            .png()
            .toBuffer();
        const layers = await Promise.all(
            Array.from({ length: 20 }, async (_, index) => {
                const color = { r: index + 1, g: 40 + index, b: 80 + index, alpha: 1 };
                const pixel = await sharp({ create: { width: 1, height: 1, channels: 4, background: color } })
                    .png()
                    .toBuffer();
                return dataUrl(
                    await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
                        .composite([{ input: pixel, left: index, top: 0 }])
                        .png()
                        .toBuffer(),
                );
            }),
        );
        const source = dataUrl(
            await sharp(backgroundBytes)
                .composite(
                    await Promise.all(
                        Array.from({ length: 20 }, async (_, index) => ({
                            input: await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: index + 1, g: 40 + index, b: 80 + index, alpha: 1 } } })
                                .png()
                                .toBuffer(),
                            left: index,
                            top: 0,
                        })),
                    ),
                )
                .png()
                .toBuffer(),
        );

        const result = await validateImageLayerOutputs(source, [...layers, dataUrl(backgroundBytes)]);

        expect(result.filter((item) => item.kind === "element")).toHaveLength(20);
        expect(result.filter((item) => item.kind === "background")).toHaveLength(1);
    });
});

async function layerFixture() {
    const background = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#dbeafe" } })
        .png()
        .toBuffer();
    const element = await transparentLayer("#ef4444");
    const source = await sharp(background)
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
    return { source: dataUrl(source), element, background: dataUrl(background) };
}

async function transparentLayer(color: string) {
    return dataUrl(
        await sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
            .composite([
                {
                    input: await sharp({ create: { width: 2, height: 2, channels: 4, background: color } })
                        .png()
                        .toBuffer(),
                    left: 1,
                    top: 1,
                },
            ])
            .png()
            .toBuffer(),
    );
}

function dataUrl(bytes: Buffer) {
    return `data:image/png;base64,${bytes.toString("base64")}`;
}
