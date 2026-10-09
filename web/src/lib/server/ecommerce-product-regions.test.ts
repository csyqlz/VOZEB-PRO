import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { createHash } from "node:crypto";

import type { EcommerceVisualAnalysis } from "./ecommerce-visual-analysis";
import { buildProductProtectionRegions, buildSceneEditProtection, compositeSceneEdit, compileStrictProductEdit, validateSceneEditProtection, validateProductProtectionRegions, type ProductProtectionRegions } from "./ecommerce-product-regions";
import { emptyAdvancedConfig } from "@/lib/channel-protocol-registry";

describe("local scene protection", () => {
    const region = { x: 2, y: 1, width: 2, height: 2 };
    const png = (color: string, width = 6, height = 4) =>
        sharp({ create: { width, height, channels: 4, background: color } })
            .png()
            .toBuffer();
    it("copies every outside pixel at its original coordinate and records exact differences", async () => {
        const source = await png("#123456");
        const generated = await png("#abcdef");
        const protection = await buildSceneEditProtection(source, "scene", region, ["vase and contact shadow"], "user_selection");
        const { bytes, evidence } = await compositeSceneEdit(source, generated, protection);
        const raw = await sharp(bytes).ensureAlpha().raw().toBuffer();
        const original = await sharp(source).ensureAlpha().raw().toBuffer();
        const edited = await sharp(generated).ensureAlpha().raw().toBuffer();
        for (let y = 0; y < 4; y++)
            for (let x = 0; x < 6; x++) {
                const offset = (y * 6 + x) * 4;
                expect(raw.subarray(offset, offset + 4)).toEqual((x >= 2 && x < 4 && y >= 1 && y < 3 ? edited : original).subarray(offset, offset + 4));
            }
        expect(evidence).toMatchObject({
            outsidePixels: 20,
            nativeOutsideChangedPixels: 20,
            mappedOutsideChangedPixels: 20,
            normalization: "none",
            compositeOutsideChangedPixels: 0,
            method: "source_pixels_copy",
            sourceSize: { width: 6, height: 4 },
            maskSize: { width: 6, height: 4 },
            targetRegion: region,
        });
    });
    it.each([
        { width: 6, height: 4, normalization: "uniform_scale" },
        { width: 24, height: 16, normalization: "uniform_scale" },
        { width: 11, height: 7, normalization: "pixel_grid_scale" },
    ])("maps a $width x $height native to source coordinates while preserving every outside pixel", async ({ normalization, ...nativeSize }) => {
        const sourceSize = { width: 12, height: 8 };
        const sourcePixels = Buffer.from(Array.from({ length: sourceSize.width * sourceSize.height * 4 }, (_, index) => (index % 4 === 3 ? 255 : (index * 7) % 256)));
        const source = await sharp(sourcePixels, { raw: { ...sourceSize, channels: 4 } })
            .png()
            .toBuffer();
        const nativePixels = Buffer.alloc(nativeSize.width * nativeSize.height * 4);
        const colors = [
            [255, 0, 0, 255],
            [0, 255, 0, 255],
            [0, 0, 255, 255],
            [255, 255, 0, 255],
        ];
        for (let y = 0; y < nativeSize.height; y++)
            for (let x = 0; x < nativeSize.width; x++) {
                const quadrant = (y < nativeSize.height / 2 ? 0 : 2) + (x < nativeSize.width / 2 ? 0 : 1);
                Buffer.from(colors[quadrant]).copy(nativePixels, (y * nativeSize.width + x) * 4);
            }
        const native = await sharp(nativePixels, { raw: { ...nativeSize, channels: 4 } })
            .png()
            .toBuffer();
        const allowed = { x: 1, y: 1, width: 10, height: 6 };
        const protection = await buildSceneEditProtection(source, "scene", allowed, ["change selected props"], "user_selection");
        const { bytes, evidence } = await compositeSceneEdit(source, native, protection);
        const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        expect(info).toMatchObject({ ...sourceSize, channels: 4 });
        for (let y = 0; y < sourceSize.height; y++)
            for (let x = 0; x < sourceSize.width; x++) {
                if (x >= allowed.x && x < allowed.x + allowed.width && y >= allowed.y && y < allowed.y + allowed.height) continue;
                const offset = (y * sourceSize.width + x) * 4;
                expect(data.subarray(offset, offset + 4)).toEqual(sourcePixels.subarray(offset, offset + 4));
            }
        const pixel = (x: number, y: number) => data.subarray((y * sourceSize.width + x) * 4, (y * sourceSize.width + x + 1) * 4);
        for (const [x, y, dominant] of [
            [2, 1, 0],
            [9, 1, 1],
            [2, 6, 2],
        ] as const) {
            const value = pixel(x, y);
            expect(value[dominant]).toBeGreaterThan(200);
            for (let channel = 0; channel < 3; channel++) if (channel !== dominant) expect(value[channel]).toBeLessThan(55);
        }
        expect(pixel(9, 6)[0]).toBeGreaterThan(200);
        expect(pixel(9, 6)[1]).toBeGreaterThan(200);
        expect(pixel(9, 6)[2]).toBeLessThan(55);
        expect(evidence).toMatchObject({
            sourceSize,
            nativeSize,
            maskSize: sourceSize,
            normalization,
            targetRegion: allowed,
            outsidePixels: 36,
            compositeOutsideChangedPixels: 0,
            nativeDigest: createHash("sha256").update(native).digest("hex"),
            compositeDigest: createHash("sha256").update(bytes).digest("hex"),
        });
        expect(evidence.mappedOutsideChangedPixels).toBeGreaterThan(0);
        expect(evidence).not.toHaveProperty("nativeOutsideChangedPixels");
    });
    it.each([
        { sourceSize: { width: 3840, height: 2160 }, nativeSize: { width: 1672, height: 941 } },
        { sourceSize: { width: 2160, height: 3840 }, nativeSize: { width: 941, height: 1672 } },
        { sourceSize: { width: 16, height: 9 }, nativeSize: { width: 1672, height: 940 } },
        { sourceSize: { width: 6, height: 4 }, nativeSize: { width: 5, height: 4 } },
    ])("preserves the source grid when both native edges are integer-rounded (%j)", async ({ sourceSize, nativeSize }) => {
        const source = await png("#123456", sourceSize.width, sourceSize.height);
        const native = await png("#abcdef", nativeSize.width, nativeSize.height);
        const protection = await buildSceneEditProtection(source, "scene", region, ["add prop"], "user_selection");
        const { bytes, evidence } = await compositeSceneEdit(source, native, protection);
        const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        expect(info).toMatchObject(sourceSize);
        const original = await sharp(source).ensureAlpha().raw().toBuffer();
        for (let y = 0; y < sourceSize.height; y++) {
            const start = y * sourceSize.width * 4;
            const end = start + sourceSize.width * 4;
            if (y < region.y || y >= region.y + region.height) expect(data.subarray(start, end).equals(original.subarray(start, end))).toBe(true);
            else {
                expect(data.subarray(start, start + region.x * 4).equals(original.subarray(start, start + region.x * 4))).toBe(true);
                expect(data.subarray(start + (region.x + region.width) * 4, end).equals(original.subarray(start + (region.x + region.width) * 4, end))).toBe(true);
                for (let x = region.x; x < region.x + region.width; x++) expect(data.subarray(start + x * 4, start + (x + 1) * 4)).toEqual(Buffer.from([171, 205, 239, 255]));
            }
        }
        expect(evidence).toMatchObject({ nativeSize, sourceSize, normalization: "pixel_grid_scale", targetRegion: region, compositeOutsideChangedPixels: 0 });
        expect(evidence).not.toHaveProperty("nativeOutsideChangedPixels");
    });
    it.each([
        { sourceSize: { width: 16, height: 9 }, nativeSize: { width: 1672, height: 942 } },
        { sourceSize: { width: 16, height: 9 }, nativeSize: { width: 1671, height: 941 } },
        { sourceSize: { width: 16, height: 9 }, nativeSize: { width: 1536, height: 1024 } },
        { sourceSize: { width: 3, height: 1 }, nativeSize: { width: 1, height: 1 } },
    ])("rejects a different canvas or a touching-but-empty rounding interval (%j)", async ({ sourceSize, nativeSize }) => {
        const source = await png("white", sourceSize.width, sourceSize.height);
        const allowed = { x: 1, y: 0, width: 1, height: 1 };
        const protection = await buildSceneEditProtection(source, "scene", allowed, ["prop"], "user_selection");
        await expect(compositeSceneEdit(source, await png("red", nativeSize.width, nativeSize.height), protection)).rejects.toThrow("原生画幅比例");
    });
    it("rejects non-uniform geometry with safe source and decoded native dimensions", async () => {
        const source = await png("white");
        const protection = await buildSceneEditProtection(source, "scene", region, ["vase"], "user_selection");
        const error = await compositeSceneEdit(source, await png("red", 5, 5), protection).then(
            () => null,
            (value: unknown) => value,
        );
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/6\s*[x×]\s*4/);
        expect((error as Error).message).toMatch(/5\s*[x×]\s*5/);
        expect((error as Error).message).not.toMatch(/data:image|https?:|sha256|scene-edit-mask/);
        await expect(compositeSceneEdit(source, Buffer.from("broken"), protection)).rejects.toThrow();
    });
    it("does not let a same-ratio native bypass frozen source or invalid mask validation", async () => {
        const source = await png("white");
        const protection = await buildSceneEditProtection(source, "scene", region, ["vase"], "user_selection");
        const native = await png("red", 3, 2);
        await expect(compositeSceneEdit(source, native, { ...protection, sourceDigest: "a".repeat(64) })).rejects.toThrow("来源");
        await expect(compositeSceneEdit(source, native, { ...protection, mask: { ...protection.mask, dataUrl: "data:image/png;base64,YnJva2Vu" } })).rejects.toThrow();
    });
    it("never promotes an automatic rectangle hint to a trusted mask", async () => {
        await expect(buildSceneEditProtection(await png("white"), "scene", region, ["vase"], "analysis_hint")).rejects.toThrow("用户确认");
    });
    it("rejects reverse, corrupt and wrong-size masks and native results", async () => {
        const source = await png("white");
        const protection = await buildSceneEditProtection(source, "scene", region, ["vase"], "user_selection");
        const maskBytes = Buffer.from(protection.mask.dataUrl.split(",")[1], "base64");
        const { data, info } = await sharp(maskBytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        for (let index = 3; index < data.length; index += 4) data[index] = 255 - data[index];
        const reverse = await sharp(data, { raw: info }).png().toBuffer();
        for (const bad of [reverse, Buffer.from("broken"), await png("white", 5, 4)]) {
            await expect(validateSceneEditProtection(source, { ...protection, mask: { ...protection.mask, dataUrl: `data:image/png;base64,${bad.toString("base64")}` } })).rejects.toThrow();
        }
        await expect(compositeSceneEdit(source, await png("red", 5, 5), protection)).rejects.toThrow("原生");
        await expect(buildSceneEditProtection(source, "scene", { ...region, x: 5 }, ["vase"], "user_selection")).rejects.toThrow("越界");
    });
});

describe("ecommerce product protection regions", () => {
    it("builds a complete non-overlapping core, halo, and editable background partition", () => {
        const regions = buildProductProtectionRegions(visualAnalysis(), { width: 1000, height: 800 });

        expect(regions.productCore.rectangles).toEqual([{ x: 300, y: 160, width: 400, height: 480 }]);
        expect(regions.fusionHalo.rectangles.length).toBeGreaterThan(0);
        expect(regions.editableBackground.rectangles.length).toBeGreaterThan(0);
        expect(() => validateProductProtectionRegions(regions, { width: 1000, height: 800 })).not.toThrow();
        expect(maskPixels(regions.productCore) + maskPixels(regions.fusionHalo) + maskPixels(regions.editableBackground)).toBe(800_000);
    });

    it("rejects an empty product core", () => {
        const regions = buildProductProtectionRegions(visualAnalysis(), { width: 1000, height: 800 });

        expect(() => validateProductProtectionRegions({ ...regions, productCore: { ...regions.productCore, rectangles: [] } }, regions.sourceSize)).toThrow(/商品核心区不能为空/);
    });

    it("rejects a detached fusion halo", () => {
        const regions = buildProductProtectionRegions(visualAnalysis(), { width: 1000, height: 800 });

        expect(() => validateProductProtectionRegions({ ...regions, fusionHalo: { ...regions.fusionHalo, rectangles: [{ x: 0, y: 0, width: 20, height: 20 }] } }, regions.sourceSize)).toThrow(/融合光晕区必须与商品核心区相邻/);
    });

    it("rejects a fusion halo that expands beyond the bounded allowance", () => {
        const regions = buildProductProtectionRegions(visualAnalysis(), { width: 1000, height: 800 });

        expect(() =>
            validateProductProtectionRegions(
                {
                    ...regions,
                    fusionHalo: {
                        ...regions.fusionHalo,
                        rectangles: [
                            { x: 0, y: 0, width: 1000, height: 160 },
                            { x: 0, y: 160, width: 300, height: 480 },
                            { x: 700, y: 160, width: 300, height: 480 },
                            { x: 0, y: 640, width: 1000, height: 160 },
                        ],
                    },
                },
                regions.sourceSize,
            ),
        ).toThrow(/融合光晕区范围过大/);
    });

    it("rejects editable background overlap with product core", () => {
        const regions = buildProductProtectionRegions(visualAnalysis(), { width: 1000, height: 800 });

        expect(() =>
            validateProductProtectionRegions(
                {
                    ...regions,
                    editableBackground: {
                        ...regions.editableBackground,
                        rectangles: [{ x: 350, y: 200, width: 100, height: 100 }],
                    },
                },
                regions.sourceSize,
            ),
        ).toThrow(/可编辑背景不得覆盖商品核心区/);
    });

    it("rejects masks whose dimensions do not match the source", () => {
        const regions = trustedRegions();

        expect(() => validateProductProtectionRegions({ ...regions, editableBackground: { ...regions.editableBackground, width: 999 } }, regions.sourceSize)).toThrow(/蒙版尺寸必须与源图一致/);
    });

    it("compiles a trusted OpenAI edit into an independent mask request", () => {
        const result = compileStrictProductEdit(openAiTask(), trustedRegions());

        expect(result.state).toBe("ready");
        if (result.state !== "ready") throw new Error(result.reason);
        expect(result.task.mask).toMatchObject({ name: "editable-background.png", width: 1000, height: 800 });
        expect(result.task.prompt).toContain("商品核心像素");
        expect(result.task.productProtection).toMatchObject({
            compilerVersion: "strict-product.v1",
            state: "ready",
            productAnchorId: "product-asset",
        });
    });

    it("requires a trustworthy mask instead of silently generating the whole image", () => {
        const result = compileStrictProductEdit(openAiTask(), buildProductProtectionRegions(visualAnalysis(), { width: 1000, height: 800 }));

        expect(result).toMatchObject({ state: "needs_review", reason: expect.stringMatching(/可信商品蒙版/) });
        expect(result.task.mask).toBeUndefined();
        expect(result.task.productProtection).toMatchObject({ state: "needs_review" });
    });

    it.each([{ referenceRule: "JSON images[].image_url" }, { referenceRule: "public URL only" }, { editPath: "/images/generations" }])("rejects strict product edits when the effective transport has no independent mask (%j)", (advancedConfig) => {
        const source = openAiTask();
        const result = compileStrictProductEdit({ ...source, config: { ...source.config, advancedConfig: { ...emptyAdvancedConfig(), ...advancedConfig } } }, trustedRegions());
        expect(result.state).toBe("needs_review");
        expect(result.task.mask).toBeUndefined();
    });

    it("accepts the native sub2api independent mask contract for strict product edits", () => {
        const source = openAiTask();
        const result = compileStrictProductEdit({ ...source, config: { ...source.config, advancedConfig: { ...emptyAdvancedConfig(), protocol: "sub2api" as const } } }, trustedRegions());
        expect(result.state).toBe("ready");
        expect(result.task.mask).toEqual(trustedRegions().editableBackground.mask!.reference);
    });

    it("routes strict-product Gemini edits to review because prompt-only masks are not trustworthy", () => {
        const source = openAiTask();
        const result = compileStrictProductEdit({ ...source, config: { ...source.config, apiFormat: "gemini" as const } }, trustedRegions());

        expect(result).toMatchObject({ state: "needs_review", reason: expect.stringMatching(/不支持可信独立蒙版/) });
    });
});

function visualAnalysis(): EcommerceVisualAnalysis {
    return {
        analysisVersion: "ecommerce-visual-analysis.v1",
        modelRole: { logicalRole: "vision_analysis", logicalModelId: "vision-model", channelId: "vision-channel", upstreamModel: "vision-upstream" },
        references: [
            {
                assetId: "product-asset",
                role: "product",
                confidence: "high",
                visualEvidence: { whiteBackground: true, transparentBackground: false, isolatedSubject: true, completeScene: false },
                productFacts: { identity: "chair", outline: "chair outline", color: "oak", material: "wood", brandText: [], view: "front" },
                sceneFacts: null,
                productCore: { x: 0.3, y: 0.2, width: 0.4, height: 0.6 },
                fusionHalo: { x: 0.25, y: 0.15, width: 0.5, height: 0.7 },
                editableTargets: [],
            },
        ],
    };
}

function trustedRegions(): ProductProtectionRegions {
    const regions = buildProductProtectionRegions(visualAnalysis(), { width: 1000, height: 800 });
    return {
        ...regions,
        editableBackground: {
            ...regions.editableBackground,
            mask: {
                trust: "trusted",
                provider: "subject-segmentation",
                reference: { id: "background-mask", name: "editable-background.png", type: "image/png", dataUrl: "data:image/png;base64,AA==", width: 1000, height: 800 },
            },
        },
    };
}

function openAiTask() {
    return {
        kind: "edit" as const,
        prompt: "put the product in a bright living room",
        config: { baseUrl: "https://images.example/v1", apiKey: "secret", apiFormat: "openai" as const, model: "gpt-image" },
        references: [{ id: "product-asset", dataUrl: "data:image/png;base64,AA==", width: 1000, height: 800 }],
    };
}

function maskPixels(mask: { rectangles: Array<{ width: number; height: number }> }) {
    return mask.rectangles.reduce((total, region) => total + region.width * region.height, 0);
}
