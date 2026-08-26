import sharp from "sharp";

export type ValidatedImageLayerOutput = {
    dataUrl: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
    kind: "element" | "background";
};

type RawImage = ValidatedImageLayerOutput & {
    pixels: Buffer;
    hasVisiblePixel: boolean;
    hasTransparentPixel: boolean;
};

export async function validateImageLayerOutputs(sourceDataUrl: string, outputDataUrls: string[]): Promise<ValidatedImageLayerOutput[]> {
    if (!outputDataUrls.length) throw new Error("上游没有返回分层图片");
    const source = await readImage(sourceDataUrl, "源图");
    const pixelCount = source.width * source.height;
    const coverageOwner = new Uint32Array(pixelCount);
    const outputs: ValidatedImageLayerOutput[] = [];
    const elementIndexes: number[] = [];
    let background: RawImage | undefined;
    for (const [outputIndex, dataUrl] of outputDataUrls.entries()) {
        const output = await readImage(dataUrl, "分层结果");
        assertSameCanvas(source, output);
        outputs.push(stripPixels(output));
        if (!output.hasTransparentPixel) {
            if (background) throw new Error("上游未返回完整分层：只能包含一张干净背景");
            background = output;
            continue;
        }
        elementIndexes.push(outputIndex);
        for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
            const offset = pixelIndex * 4;
            if (output.pixels[offset + 3] === 0) continue;
            if (coverageOwner[pixelIndex]) throw new Error("上游返回的元素图层存在重复像素，没有独立分层");
            if (!sameRgb(source.pixels, output.pixels, offset)) throw new Error("上游返回的元素不是源图原始像素");
            coverageOwner[pixelIndex] = outputIndex + 1;
        }
    }
    if (!elementIndexes.length || !background) throw new Error("上游未返回完整分层：需要独立透明元素和一张干净背景");

    const changedElements = new Set<number>();
    let hasUncoveredSourcePixel = false;
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
        const offset = pixelIndex * 4;
        const owner = coverageOwner[pixelIndex];
        if (!owner) {
            hasUncoveredSourcePixel = true;
            if (!sameRgba(source.pixels, background.pixels, offset)) throw new Error("上游背景改动了元素之外的源图内容");
            continue;
        }
        if (!sameRgba(source.pixels, background.pixels, offset)) changedElements.add(owner - 1);
    }
    if (!hasUncoveredSourcePixel) throw new Error("上游没有保留可验证的原图背景区域");
    if (elementIndexes.some((index) => !changedElements.has(index))) throw new Error("上游背景没有移除全部独立元素");

    return outputs;
}

async function readImage(dataUrl: string, label: string): Promise<RawImage> {
    const match = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/i);
    if (!match) throw new Error(`${label}无法读取`);
    const bytes = Buffer.from(match[2], "base64");
    if (!bytes.length) throw new Error(`${label}为空`);
    const { data, info } = await sharp(bytes, { failOn: "error" }).rotate().toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let hasVisiblePixel = false;
    let hasTransparentPixel = false;
    for (let offset = 3; offset < data.length; offset += 4) {
        const alpha = data[offset];
        if (alpha > 0) hasVisiblePixel = true;
        if (alpha < 255) hasTransparentPixel = true;
    }
    if (!hasVisiblePixel) throw new Error(`${label}是全透明空图`);
    return {
        dataUrl,
        pixels: data,
        width: info.width,
        height: info.height,
        bytes: bytes.length,
        mimeType: match[1].toLowerCase(),
        kind: hasTransparentPixel ? "element" : "background",
        hasVisiblePixel,
        hasTransparentPixel,
    };
}

function assertSameCanvas(source: RawImage, output: RawImage) {
    if (source.width !== output.width || source.height !== output.height) throw new Error("分层结果尺寸与源图不一致，无法验证原图像素");
}

function sameRgb(left: Buffer, right: Buffer, offset: number) {
    return left[offset] === right[offset] && left[offset + 1] === right[offset + 1] && left[offset + 2] === right[offset + 2];
}

function sameRgba(left: Buffer, right: Buffer, offset: number) {
    return sameRgb(left, right, offset) && left[offset + 3] === right[offset + 3];
}

function stripPixels(output: RawImage): ValidatedImageLayerOutput {
    return {
        dataUrl: output.dataUrl,
        width: output.width,
        height: output.height,
        bytes: output.bytes,
        mimeType: output.mimeType,
        kind: output.kind,
    };
}
