import { fetchInternalApi } from "@/lib/server/internal-origin";
import { maintenanceWorkerContextHeaders } from "@/lib/server/maintenance-auth";
import { fetchSafeOutbound } from "@/lib/server/safe-outbound-fetch";
import { regularVideoReferences, videoFrameReferences, type VideoGenerationReference } from "@/lib/video-reference-contract";

const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;
const INLINE_IMAGE_TIMEOUT_MS = 60_000;
const GEMINI_VIDEO_DURATIONS = [4, 6, 8] as const;

export type GeminiVideoInlineImage = { inlineData: { mimeType: string; data: string } };

export type GeminiVideoRequest = {
    instances: [
        {
            prompt: string;
            image?: GeminiVideoInlineImage;
            lastFrame?: GeminiVideoInlineImage;
            referenceImages?: Array<{ image: GeminiVideoInlineImage; referenceType: "asset" }>;
        },
    ];
    parameters: {
        durationSeconds: number;
        aspectRatio?: "16:9" | "9:16";
        resolution?: "720p" | "1080p";
        generateAudio: boolean;
    };
};

export type GeminiVideoOperationState = { state: "pending"; status: "processing" } | { state: "succeeded"; status: "completed"; resultUrl: string } | { state: "failed"; status: "failed"; error: string };

export function geminiVideoCreatePath(model: string) {
    return `/models/${encodeURIComponent(geminiModelName(model))}:predictLongRunning`;
}

export function geminiVideoQueryPath(model: string, operationId: string) {
    return `/models/${encodeURIComponent(geminiModelName(model))}/operations/${encodeURIComponent(operationId.trim())}`;
}

export function normalizeGeminiVideoDuration(value: unknown) {
    const requested = Math.max(1, Math.floor(Number(value) || 5));
    return GEMINI_VIDEO_DURATIONS.find((seconds) => seconds >= requested) || GEMINI_VIDEO_DURATIONS.at(-1)!;
}

export function assertGeminiVideoReferences(references: readonly VideoGenerationReference[]) {
    const unsupported = references.find((reference) => reference.type !== "image");
    if (unsupported) throw new Error(`Gemini Veo 暂不支持参考${unsupported.type === "video" ? "视频" : "音频"}输入`);
    const regularImages = regularVideoReferences(references).filter((reference) => reference.type === "image");
    if (regularImages.length > 3) throw new Error("Gemini Veo 一次最多使用 3 张普通参考图");
}

export async function buildGeminiVideoRequest(input: {
    prompt: string;
    durationSeconds: unknown;
    aspectRatio: unknown;
    resolution: unknown;
    generateAudio: boolean;
    references: readonly VideoGenerationReference[];
    origin: string;
    cookie: string;
}): Promise<GeminiVideoRequest> {
    assertGeminiVideoReferences(input.references);
    const regularImages = regularVideoReferences(input.references).filter((reference) => reference.type === "image");
    const { firstFrame, lastFrame } = videoFrameReferences(input.references);
    const [firstFrameImage, lastFrameImage, ...referenceImages] = await Promise.all([
        firstFrame ? imageInlineData(firstFrame.url, input.origin, input.cookie) : undefined,
        lastFrame ? imageInlineData(lastFrame.url, input.origin, input.cookie) : undefined,
        ...regularImages.map((reference) => imageInlineData(reference.url, input.origin, input.cookie)),
    ]);
    const instance: GeminiVideoRequest["instances"][number] = {
        prompt: input.prompt.trim(),
        ...(firstFrameImage ? { image: firstFrameImage } : {}),
        ...(lastFrameImage ? { lastFrame: lastFrameImage } : {}),
        ...(referenceImages.length ? { referenceImages: referenceImages.map((image) => ({ image: image!, referenceType: "asset" as const })) } : {}),
    };
    const aspectRatio = geminiAspectRatio(input.aspectRatio);
    const resolution = geminiResolution(input.resolution);
    return {
        instances: [instance],
        parameters: {
            durationSeconds: normalizeGeminiVideoDuration(input.durationSeconds),
            ...(aspectRatio ? { aspectRatio } : {}),
            ...(resolution ? { resolution } : {}),
            generateAudio: input.generateAudio,
        },
    };
}

export function parseGeminiVideoCreateResponse(value: unknown, model: string) {
    const record = objectValue(value);
    const error = geminiOperationError(record);
    if (error) return { id: "", queryPath: "", resultUrl: "", error };
    const resultUrl = geminiVideoResultUrl(record);
    const name = text(record.name);
    if (!name) return { id: "", queryPath: "", resultUrl, error: "" };
    const identity = operationIdentity(name, model);
    return { ...identity, resultUrl, error: "" };
}

export function parseGeminiVideoOperation(value: unknown): GeminiVideoOperationState {
    const record = objectValue(value);
    const error = geminiOperationError(record);
    if (error) return { state: "failed", status: "failed", error };
    const resultUrl = geminiVideoResultUrl(record);
    if (resultUrl) return { state: "succeeded", status: "completed", resultUrl };
    if (record.done === true) return { state: "failed", status: "failed", error: "Gemini Veo 任务已完成但没有返回视频地址" };
    return { state: "pending", status: "processing" };
}

async function imageInlineData(value: string, origin: string, cookie: string): Promise<GeminiVideoInlineImage> {
    const inline = parseImageDataUrl(value);
    if (inline) return inline;
    if (/^blob:/i.test(value)) throw new Error("参考图已失效，请重新上传");
    const target = referenceFetchTarget(value, origin);
    if (!target) throw new Error("参考图地址无效，请重新上传参考图");
    const workerHeaders = maintenanceWorkerContextHeaders(cookie);
    const response = await (target.internal ? fetchInternalApi : fetchSafeOutbound)(target.url, {
        headers: target.internal ? workerHeaders || (cookie ? { cookie } : undefined) : undefined,
        cache: "no-store",
        signal: AbortSignal.timeout(INLINE_IMAGE_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) throw new Error("参考图读取失败");
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_INLINE_IMAGE_BYTES) throw new Error("参考图过大，请压缩后重试");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new Error("参考图读取失败");
    if (bytes.length > MAX_INLINE_IMAGE_BYTES) throw new Error("参考图过大，请压缩后重试");
    const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || "image/png";
    if (!mimeType.startsWith("image/")) throw new Error("参考图不是有效图片");
    return { inlineData: { mimeType, data: bytes.toString("base64") } };
}

function parseImageDataUrl(value: string): GeminiVideoInlineImage | undefined {
    const match = value.trim().match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i);
    if (!match) return undefined;
    const bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");
    if (!bytes.length) throw new Error("参考图读取失败");
    if (bytes.length > MAX_INLINE_IMAGE_BYTES) throw new Error("参考图过大，请压缩后重试");
    return { inlineData: { mimeType: match[1].toLowerCase(), data: bytes.toString("base64") } };
}

function referenceFetchTarget(value: string, origin: string) {
    try {
        const source = new URL(value.trim(), origin || "http://localhost");
        const internalMedia = source.pathname.startsWith("/api/reference-assets/") || source.pathname.startsWith("/api/generation-log-assets/");
        if (internalMedia && origin) return { url: `${origin.replace(/\/+$/, "")}${source.pathname}${source.search}`, internal: true };
        if (!/^https?:$/i.test(source.protocol)) return undefined;
        return { url: source.toString(), internal: value.startsWith("/") };
    } catch {
        return undefined;
    }
}

function operationIdentity(name: string, model: string) {
    const normalized = name
        .trim()
        .replace(/^\/+/, "")
        .replace(/^v1beta\//i, "");
    const full = normalized.match(/^models\/([^/]+)\/operations\/([^/?#]+)$/i);
    if (full) {
        const returnedModel = decodeURIComponent(full[1]);
        if (geminiModelName(returnedModel).toLowerCase() !== geminiModelName(model).toLowerCase()) throw new Error("Gemini Veo operation 与请求模型不匹配");
        const id = decodeURIComponent(full[2]);
        return { id, queryPath: geminiVideoQueryPath(model, id) };
    }
    const short = normalized.match(/^operations\/([^/?#]+)$/i);
    if (short) {
        const id = decodeURIComponent(short[1]);
        return { id, queryPath: geminiVideoQueryPath(model, id) };
    }
    throw new Error("Gemini Veo 返回了无效 operation 名称");
}

function geminiVideoResultUrl(value: Record<string, unknown>) {
    const response = objectValue(value.response);
    const generateVideoResponse = objectValue(response.generateVideoResponse);
    return firstVideoUri(generateVideoResponse.generatedSamples) || firstVideoUri(response.generatedSamples) || firstVideoUri(response.generatedVideos);
}

function firstVideoUri(value: unknown) {
    if (!Array.isArray(value)) return "";
    for (const item of value) {
        const video = objectValue(objectValue(item).video);
        const uri = text(video.uri) || text(video.url);
        if (uri) return uri;
    }
    return "";
}

function geminiOperationError(value: Record<string, unknown>) {
    const error = value.error;
    if (typeof error === "string") return error.trim();
    const record = objectValue(error);
    return text(record.message) || text(record.status);
}

function geminiAspectRatio(value: unknown): "16:9" | "9:16" | undefined {
    const ratio = text(value);
    if (!ratio || ratio.toLowerCase() === "auto") return undefined;
    if (ratio === "16:9" || ratio === "9:16") return ratio;
    throw new Error("Gemini Veo 仅支持 16:9 或 9:16 画幅");
}

function geminiResolution(value: unknown): "720p" | "1080p" | undefined {
    const textValue = text(value).toLowerCase();
    if (!textValue || textValue === "auto") return undefined;
    const resolution = textValue.replace(/p$/, "");
    return resolution === "1080" ? "1080p" : "720p";
}

function geminiModelName(value: string) {
    return value.trim().replace(/^models\//i, "");
}

function objectValue(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}
