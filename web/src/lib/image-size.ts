export type ImageDimensions = { width: number; height: number };
export type ImageOrientation = "landscape" | "portrait" | "square";

export function parseImageDimensions(value: string): ImageDimensions | null {
    const match = value.trim().match(/^(\d+)\s*(?:x|\*|×)\s*(\d+)$/i);
    if (!match) return null;
    return { width: Number(match[1]), height: Number(match[2]) };
}

export function normalizeImageSizeValue(value: unknown) {
    if (typeof value !== "string") return "";
    const text = value.trim().replace(/[：；;]/g, ":");
    if (!text) return "";
    if (text.toLowerCase() === "auto") return "auto";
    const dimensions = parseImageDimensions(text);
    if (dimensions) return `${dimensions.width}x${dimensions.height}`;
    return /^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(text) ? text : "";
}

export function extractImageSizeFromPrompt(prompt: string) {
    const dimensions = prompt.match(/(?:^|[^\d])(\d{1,5})\s*(?:x|\*|×)\s*(\d{1,5})(?!\d)/i);
    if (dimensions) return normalizeImageSizeValue(`${dimensions[1]}x${dimensions[2]}`);

    const ratio = prompt.match(/(?:比例|画幅|宽高比|尺寸)?\s*(?:为|是|[:：])?\s*(\d+(?:\.\d+)?)\s*[:：；;]\s*(\d+(?:\.\d+)?)/i);
    return ratio ? normalizeImageSizeValue(`${ratio[1]}:${ratio[2]}`) : "";
}

export function extractImageOrientationFromPrompt(prompt: string): ImageOrientation | undefined {
    const matches = Array.from(prompt.matchAll(/横屏|横版|横向|横图|宽屏|宽银幕|竖屏|竖版|竖向|竖图|正方形|方形|方图/gu));
    const value = matches.at(-1)?.[0] || "";
    if (/横屏|横版|横向|横图|宽屏|宽银幕/u.test(value)) return "landscape";
    if (/竖屏|竖版|竖向|竖图/u.test(value)) return "portrait";
    if (/正方形|方形|方图/u.test(value)) return "square";
    return undefined;
}

export function imageSizeMatchesOrientation(value: unknown, orientation: ImageOrientation) {
    const normalized = normalizeImageSizeValue(value);
    const dimensions = parseImageDimensions(normalized);
    const ratio = dimensions ? dimensions.width / dimensions.height : aspectRatioValue(normalized);
    if (!ratio) return false;
    if (orientation === "square") return Math.abs(ratio - 1) < Number.EPSILON;
    return orientation === "landscape" ? ratio > 1 : ratio < 1;
}

export function closestImageAspectRatio(width: number | undefined, height: number | undefined) {
    if (!width || !height || width <= 0 || height <= 0) return "";
    const ratio = width / height;
    const candidates = [
        ["1:1", 1],
        ["3:2", 3 / 2],
        ["2:3", 2 / 3],
        ["4:3", 4 / 3],
        ["3:4", 3 / 4],
        ["16:9", 16 / 9],
        ["9:16", 9 / 16],
    ] as const;
    return candidates.reduce((best, candidate) => (Math.abs(Math.log(ratio / candidate[1])) < Math.abs(Math.log(ratio / best[1])) ? candidate : best))[0];
}

export function resolveImageRequestSize(input: { prompt: string; configuredSize?: unknown; configuredSizeExplicit?: boolean; referenceWidth?: number; referenceHeight?: number; plannedSize?: unknown; defaultSize?: unknown }) {
    const requested = extractImageSizeFromPrompt(input.prompt);
    const configured = normalizeImageSizeValue(input.configuredSize);
    const custom = parseImageDimensions(configured) ? configured : "";
    const lockedRatio = input.configuredSizeExplicit && configured !== "auto" && !custom ? configured : "";
    const reference = closestImageAspectRatio(input.referenceWidth, input.referenceHeight);
    return requested || custom || lockedRatio || reference || normalizeImageSizeValue(input.plannedSize) || configured || normalizeImageSizeValue(input.defaultSize) || "auto";
}

function aspectRatioValue(value: string) {
    const match = value.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
    if (!match) return 0;
    const width = Number(match[1]);
    const height = Number(match[2]);
    return width > 0 && height > 0 ? width / height : 0;
}
