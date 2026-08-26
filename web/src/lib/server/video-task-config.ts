import { parseImageDimensions } from "@/lib/image-size";
import type { VideoGenerationReference } from "@/lib/video-reference-contract";

export type ConfiguredVideoDurationPolicy = {
    durationRange?: string;
    durationSeconds?: number[];
    minDurationSeconds?: number;
    maxDurationSeconds?: number;
};

export function resolveVideoGenerationParameters(raw: Record<string, unknown>, defaults: { imageSize: string; videoQuality: string; videoSeconds: number }) {
    return {
        ...raw,
        size: normalizeVideoSize(text(raw.size), defaults.imageSize),
        vquality: text(raw.vquality) || defaults.videoQuality,
        videoSeconds: resolveVideoDuration(raw.videoSeconds, defaults.videoSeconds),
    };
}

export function normalizeVideoSize(value: unknown, fallback = "16:9") {
    const textValue = text(value);
    if (textValue.toLowerCase() === "auto") return "auto";
    const dimensions = parseImageDimensions(textValue);
    if (dimensions) return `${dimensions.width}x${dimensions.height}`;
    return normalizeVideoAspectRatio(textValue, fallback);
}

export function resolveUpstreamVideoDuration(value: unknown, fallback: number, policy: ConfiguredVideoDurationPolicy = {}) {
    const fallbackSeconds = positiveInteger(fallback) || 5;
    const requested = resolveVideoDuration(value, fallbackSeconds);
    const durationRange = policy.durationRange?.trim() || "";
    if (requested === -1 && /(?:^|\D)-1(?:\D|$)|智能|auto|adaptive/i.test(durationRange)) return -1;

    const seconds = requested === -1 ? fallbackSeconds : requested;
    const configured = configuredVideoDurationPolicy(policy);
    const min = Math.max(1, configured.minDurationSeconds || 1);
    const max = Math.max(min, Math.min(3600, configured.maxDurationSeconds || 3600));
    const options = (configured.durationSeconds || []).filter((item) => item >= min && item <= max);
    if (options.length) return options.find((item) => item >= seconds) || options.at(-1)!;
    return Math.max(min, Math.min(max, seconds));
}

export function configuredVideoDurationPolicy(policy: ConfiguredVideoDurationPolicy = {}) {
    const bounds = parseDurationBounds(policy.durationRange?.trim() || "");
    const minDurationSeconds = positiveInteger(policy.minDurationSeconds) || bounds?.min;
    const maxDurationSeconds = positiveInteger(policy.maxDurationSeconds) || bounds?.max;
    const configuredOptions = Array.isArray(policy.durationSeconds) ? policy.durationSeconds.map(positiveInteger).filter((item): item is number => Boolean(item)) : [];
    const rangeOptions = parseDurationOptions(policy.durationRange?.trim() || "");
    const durationSeconds = Array.from(new Set(configuredOptions.length ? configuredOptions : rangeOptions))
        .filter((item) => (!minDurationSeconds || item >= minDurationSeconds) && (!maxDurationSeconds || item <= maxDurationSeconds))
        .sort((left, right) => left - right);
    return {
        ...(durationSeconds.length ? { durationSeconds } : {}),
        ...(minDurationSeconds ? { minDurationSeconds } : {}),
        ...(maxDurationSeconds ? { maxDurationSeconds } : {}),
    };
}

export function normalizeVideoAspectRatio(value: unknown, fallback = "16:9") {
    return parseAspectRatio(value) || parseAspectRatio(fallback) || "16:9";
}

export function resolveVideoDuration(value: unknown, fallback: number) {
    const number = Number(value);
    if (number === -1) return -1;
    const seconds = Number.isFinite(number) && number > 0 ? number : fallback;
    return Math.max(1, Math.floor(seconds));
}

export function withVideoReferenceFidelity(prompt: string, references: readonly VideoGenerationReference[]) {
    const source = prompt.trim();
    const hasFirstFrame = references.some((reference) => reference.role === "first_frame");
    const hasLastFrame = references.some((reference) => reference.role === "last_frame");
    if ((hasFirstFrame || hasLastFrame) && !source.includes("首尾帧连续性要求：")) {
        const ending = hasLastFrame
            ? "首帧是唯一开场画面，尾帧是唯一结束画面；镜头、主体姿态、光线和环境变化必须在两帧之间自然连续过渡，禁止交换两帧、跳切到无关场景或把尾帧当普通参考图。"
            : "首帧是唯一开场画面；保持其中主体身份、外观、构图和场景，再按用户描述产生连续动作与运镜，禁止重设计主体或换成无关开场。";
        return `${source}\n\n首尾帧连续性要求：${ending}`;
    }
    const hasImage = references.some((reference) => reference.type === "image");
    const hasVideo = references.some((reference) => reference.type === "video");
    if ((!hasImage && !hasVideo) || source.includes("参考素材一致性要求：")) return source;
    const sourceLabel = hasImage && hasVideo ? "参考图和参考视频" : hasImage ? "参考图" : "参考视频";
    return `${source}\n\n参考素材一致性要求：将${sourceLabel}作为首帧、主体身份、外观和场景的主要依据。除非用户明确要求改变，否则必须保持同一人物或产品、五官与轮廓、服装与材质、颜色、背景、构图和镜头视角；只添加用户描述的动作、运镜和必要的自然变化，禁止替换主体、重新设计外观或生成无关场景。`;
}

function text(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function parseDurationBounds(value: string) {
    const match = value.match(/(\d{1,4})\s*(?:-|~|～|—|至|到)\s*(\d{1,4})/);
    if (!match) return undefined;
    const left = Number(match[1]);
    const right = Number(match[2]);
    return { min: Math.min(left, right), max: Math.max(left, right) };
}

function parseDurationOptions(value: string) {
    if (!value || parseDurationBounds(value)) return [];
    const options = Array.from(value.matchAll(/\d{1,4}/g), (match) => Number(match[0])).filter((item) => item > 0 && item <= 3600);
    return Array.from(new Set(options)).sort((left, right) => left - right);
}

function positiveInteger(value: unknown) {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) && number > 0 ? number : undefined;
}

function parseAspectRatio(value: unknown) {
    const match = text(value)
        .replace(/\s+/g, "")
        .match(/^(\d+)(?::|x|×)(\d+)$/i);
    if (!match) return "";
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return "";
    const divisor = greatestCommonDivisor(width, height);
    return `${width / divisor}:${height / divisor}`;
}

function greatestCommonDivisor(left: number, right: number): number {
    let a = left;
    let b = right;
    while (b) [a, b] = [b, a % b];
    return a;
}
