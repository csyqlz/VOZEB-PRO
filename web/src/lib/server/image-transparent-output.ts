import sharp from "sharp";

export async function assertTransparentImageOutput(dataUrl: string) {
    const match = dataUrl.match(/^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=]+)$/i);
    if (!match) throw new Error("透明图片结果无法读取");
    const bytes = Buffer.from(match[1], "base64");
    const image = sharp(bytes, { failOn: "error" });
    const metadata = await image.metadata();
    if (!metadata.hasAlpha) throw new Error("上游没有生成透明背景");
    const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let hasVisiblePixel = false;
    let hasTransparentPixel = false;
    for (let offset = info.channels - 1; offset < data.length; offset += info.channels) {
        const alpha = data[offset];
        if (alpha > 0) hasVisiblePixel = true;
        if (alpha < 255) hasTransparentPixel = true;
        if (hasVisiblePixel && hasTransparentPixel) return;
    }
    if (!hasVisiblePixel) throw new Error("上游生成了全透明空图");
    throw new Error("上游没有生成透明背景");
}
