import axios from "axios";

import { dataUrlToFile } from "@/lib/image-utils";
import { browserReadableMediaUrl } from "@/lib/browser-media-url";
import { resolveGeneratedMediaUrl } from "@/lib/media-url";
import { hasProviderReadSignatureShape, isProviderMediaAssetUrl } from "@/lib/reference-asset-url";
import { getMediaBlob, readStoredMediaFile, uploadGeneratedMediaFile, type UploadedFile } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { refreshUserPointsIfSystem, syncUserPointsFromHeaders } from "@/services/api/points";
import { boolConfig, buildSeedancePromptText, isSeedanceVideoConfig, normalizeSeedanceDuration, normalizeSeedanceRatio, normalizeSeedanceResolution, seedanceVideoReferenceError, SEEDANCE_REFERENCE_LIMITS } from "@/lib/seedance-video";
import { buildApiUrl, modelOptionName, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import { isRecord } from "./video-support";

export { isRecord } from "./video-support";

import {
    type VideoResponse,
    type ApiVideoResponse,
    type SeedanceTask,
    type ApiEnvelope,
    type RequestOptions,
    type ResolvedVideoMediaUrl,
    type VideoGenerationResult,
    type VideoGenerationTask,
    type VideoGenerationTaskState,
    GLOBAL_AIOPC_VIDEO_CREATE_PATH,
    GLOBAL_AIOPC_VIDEO_RESULT_PATH,
    VIDEO_CREATE_PATHS,
    VIDEO_URL_KEYS,
    VIDEO_CONTAINER_KEYS,
    TASK_ID_KEYS,
    TASK_STATUS_KEYS,
    VIDEO_CREATE_ERROR_PREFIX,
    VIDEO_QUERY_ERROR_PREFIX,
    VIDEO_STAGE_ERROR_PREFIX,
} from "./video-types";
import {
    aiApiUrl,
    aiHeaders,
    readConfiguredMediaUrl,
    readConfiguredTaskStatus,
    readConfiguredStringValue,
    configuredFieldPaths,
    valueAtConfiguredPath,
    configuredValueText,
    readTaskId,
    readTaskStatus,
    readTaskMode,
    isCompletedStatus,
    isPendingStatus,
    isFailedStatus,
    readTaskError,
    findMediaUrl,
    isLikelyVideoUrl,
    resolveVideoMediaUrl,
    stringValue,
    findStringByKeys,
    buildSeedanceContent,
    resolveSeedanceImageUrl,
    resolveSeedanceVideoUrl,
    resolveSeedanceAudioUrl,
    videoResultFromUrl,
    resolveOpenAiContentRemoteUrl,
    remoteVideoSourceUrl,
    proxiedMediaSourceUrl,
    readHeader,
    assertVideoConfig,
    normalizeVideoSeconds,
    normalizeVideoSize,
    normalizeVideoResolution,
    unwrapVideoResponse,
    unwrapSeedanceTask,
    unwrapEnvelope,
    readAxiosError,
    videoCreationError,
    videoQueryError,
    videoStageError,
    prefixedVideoError,
    statusMessage,
    assertVideoBlob,
    isPublicMediaUrl,
    isExternalPublicMediaUrl,
    delay,
    blobToDataUrl,
} from "./video-support";

export type AdvancedVideoTemplateContext = {
    duration: number;
    ratio?: string;
    resolution?: string;
    quality?: string;
    size?: string;
    width?: number;
    height?: number;
    images: string[];
    referenceVideos: string[];
    referenceAudios: string[];
};

export function buildAdvancedVideoTemplatePayloads(config: AiConfig, model: string, prompt: string, context: AdvancedVideoTemplateContext) {
    const template = (config.advancedConfig?.requestTemplate || "").trim();
    if (!template || (!template.startsWith("{") && !template.startsWith("["))) return [];

    let parsed: unknown;
    try {
        parsed = JSON.parse(template);
    } catch {
        return [];
    }

    const variables: Record<string, unknown> = {
        model: modelOptionName(model),
        prompt,
        duration: context.duration,
        seconds: String(context.duration),
        ratio: context.ratio,
        aspect_ratio: context.ratio,
        resolution: context.resolution,
        quality: context.quality,
        size: context.size,
        width: context.width,
        height: context.height,
        image: context.images[0] || "",
        images: context.images,
        referenceImage: context.images[0] || "",
        referenceImages: context.images,
        referenceVideo: context.referenceVideos[0] || "",
        referenceVideos: context.referenceVideos,
        referenceAudio: context.referenceAudios[0] || "",
        referenceAudios: context.referenceAudios,
    };
    const rendered = renderAdvancedTemplateValue(parsed, variables);
    const payloads = Array.isArray(rendered) ? rendered : [rendered];
    return payloads.filter(isRecord).map((payload) => alignAdvancedVideoPayload(payload, model, prompt, context));
}

export function renderAdvancedTemplateValue(value: unknown, variables: Record<string, unknown>): unknown {
    if (typeof value === "string") {
        const exact = value.match(/^{{\s*([a-zA-Z_][\w]*)\s*}}$/);
        if (exact) return variables[exact[1]] ?? "";
        return value.replace(/{{\s*([a-zA-Z_][\w]*)\s*}}/g, (_match, key: string) => templateVariableText(variables[key]));
    }
    if (Array.isArray(value)) return value.map((item) => renderAdvancedTemplateValue(item, variables));
    if (isRecord(value)) {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderAdvancedTemplateValue(item, variables)]));
    }
    return value;
}

export function templateVariableText(value: unknown) {
    if (value === undefined || value === null) return "";
    if (Array.isArray(value) || isRecord(value)) return JSON.stringify(value);
    return String(value);
}

export function alignAdvancedVideoPayload(payload: Record<string, unknown>, model: string, prompt: string, context: AdvancedVideoTemplateContext) {
    const next = { ...payload };
    if ("model" in next) next.model = modelOptionName(model);
    if ("prompt" in next) next.prompt = prompt;
    if ("duration" in next) next.duration = context.duration;
    if ("seconds" in next) next.seconds = typeof next.seconds === "number" ? context.duration : String(context.duration);
    alignOptionalVideoField(next, "ratio", context.ratio);
    alignOptionalVideoField(next, "aspect_ratio", context.ratio);
    alignOptionalVideoField(next, "resolution", context.resolution);
    alignOptionalVideoField(next, "quality", context.quality);
    alignOptionalVideoField(next, "size", context.size);
    alignOptionalVideoField(next, "width", context.width);
    alignOptionalVideoField(next, "height", context.height);
    alignSingleReferenceField(next, "image", context.images[0]);
    alignSingleReferenceField(next, "image_url", context.images[0]);
    alignSingleReferenceField(next, "input_image", context.images[0]);
    alignSingleReferenceField(next, "referenceImage", context.images[0]);
    alignSingleReferenceField(next, "reference_image", context.images[0]);
    alignListReferenceField(next, "images", context.images);
    alignListReferenceField(next, "image_urls", context.images);
    alignListReferenceField(next, "input_images", context.images);
    alignListReferenceField(next, "ref_assets", context.images);
    alignListReferenceField(next, "referenceImages", context.images);
    alignListReferenceField(next, "reference_images", context.images);
    alignSingleReferenceField(next, "first_image", undefined);
    alignSingleReferenceField(next, "last_image", undefined);
    alignSingleReferenceField(next, "referenceVideo", context.referenceVideos[0]);
    alignSingleReferenceField(next, "reference_video", context.referenceVideos[0]);
    alignListReferenceField(next, "referenceVideos", context.referenceVideos);
    alignListReferenceField(next, "reference_videos", context.referenceVideos);
    alignSingleReferenceField(next, "referenceAudio", context.referenceAudios[0]);
    alignSingleReferenceField(next, "reference_audio", context.referenceAudios[0]);
    alignListReferenceField(next, "referenceAudios", context.referenceAudios);
    alignListReferenceField(next, "reference_audios", context.referenceAudios);
    return next;
}

function alignOptionalVideoField(payload: Record<string, unknown>, key: string, value: string | number | undefined) {
    if (!(key in payload)) return;
    if (value !== undefined) payload[key] = value;
    else if (payload[key] === "" || payload[key] === undefined) delete payload[key];
}

export function alignSingleReferenceField(payload: Record<string, unknown>, key: string, value?: string) {
    if (!(key in payload)) return;
    if (!shouldAutoAlignReferenceField(payload[key])) return;
    if (value) payload[key] = value;
    else delete payload[key];
}

export function alignListReferenceField(payload: Record<string, unknown>, key: string, values: string[]) {
    if (!(key in payload)) return;
    if (!shouldAutoAlignReferenceField(payload[key])) return;
    if (values.length) payload[key] = values;
    else delete payload[key];
}

export function shouldAutoAlignReferenceField(value: unknown) {
    if (typeof value === "string") return !value.trim() || value.includes("{{") || value.includes("https://...");
    if (Array.isArray(value)) return !value.length || value.some((item) => typeof item === "string" && (!item.trim() || item.includes("{{") || item.includes("https://...")));
    return false;
}

export function uniquePayloads(payloads: Array<Record<string, unknown>>) {
    const seen = new Set<string>();
    return payloads.filter((payload) => {
        const key = JSON.stringify(payload);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export function shouldUsePublicVideoReferenceUrls(config: AiConfig, path: string) {
    if (path === GLOBAL_AIOPC_VIDEO_CREATE_PATH) return true;
    const rule = (config.advancedConfig?.referenceRule || "").trim().toLowerCase();
    return /\u516c\u7f51|public|next_public_site_url|localhost|must.*\burl\b|\burl\b.*only|\u5fc5\u987b.*\burl\b|\u4ec5.*\burl\b|\u53ea.*\burl\b/i.test(rule);
}

export function buildCompatibleVideoMediaPayloads(images: string[]) {
    if (!images.length) return [{}];
    const imageObjects = images.map((url) => ({ url }));
    const imageUrlObjects = images.map((url) => ({ image_url: url }));
    return [
        { image: images[0] },
        { images },
        { image: images[0], images, ref_assets: images },
        { ref_assets: images },
        { image: imageObjects[0] },
        { images: imageObjects },
        { image: imageObjects[0], images: imageObjects, ref_assets: imageObjects },
        { ref_assets: imageObjects },
        { image_url: images[0] },
        { image_url: imageObjects[0] },
        { image_urls: images },
        { image_urls: imageObjects },
        { input_image: images[0] },
        { input_image: imageObjects[0] },
        { input_images: images },
        { input_images: imageObjects },
        { input_reference: images },
        { input_reference: imageObjects },
        { input_reference: imageUrlObjects },
        { reference_image: images[0] },
        { reference_image: imageObjects[0] },
        { reference_images: images },
        { reference_images: imageObjects },
        { first_frame_url: images[0] },
        { first_frame_image: images[0] },
        { image: images[0], images: imageObjects, image_urls: images, ref_assets: imageObjects },
        { image: imageObjects[0], images: imageObjects, image_urls: images, ref_assets: imageObjects },
        { image: images[0], images, image_urls: images, ref_assets: images },
    ];
}

export function buildGlobalAiOpcVideoMediaPayloads(images: string[]) {
    if (!images.length) return [{}];
    return [{ referenceImages: images }];
}

export async function resolveCompatibleImageSources(image: ReferenceImage) {
    const sources: string[] = [];
    const dataUrl = (await imageToDataUrl(image)).trim();
    sources.push(...compatibleImageSourceCandidates(dataUrl));
    sources.push(...compatibleImageSourceCandidates(image.url));
    sources.push(...compatibleImageSourceCandidates(image.dataUrl));
    return uniqueStrings(sources);
}

export async function resolvePublicImageSources(image: ReferenceImage) {
    const directUrls = uniqueStrings([...externalPublicImageSourceCandidates(image.url), ...externalPublicImageSourceCandidates(image.dataUrl)]);
    if (directUrls.length) return directUrls;

    const dataUrl = (await imageToDataUrl(image)).trim();
    if (!dataUrl || !/^data:image\//i.test(dataUrl)) return [];
    const publishedUrl = await publishReferenceImage(dataUrl);
    return externalPublicImageSourceCandidates(publishedUrl);
}

export async function resolveGlobalAiOpcImageSources(image: ReferenceImage) {
    const directUrls = uniqueStrings([...externalPublicImageSourceCandidates(image.url), ...externalPublicImageSourceCandidates(image.dataUrl)]);
    if (directUrls.length) return directUrls;

    const dataUrl = (await imageToDataUrl(image)).trim();
    if (!dataUrl || !/^data:image\//i.test(dataUrl)) return [];
    const publishedUrl = await publishReferenceImage(dataUrl);
    return externalPublicImageSourceCandidates(publishedUrl);
}

export function resolveGlobalAiOpcMediaReferenceSources(media: { url?: string }) {
    return externalPublicImageSourceCandidates(media.url);
}

export function compatibleImageSourceCandidates(value?: string) {
    const url = (value || "").trim();
    if (!url) return [];
    if (/^data:image\//i.test(url) || isPublicMediaUrl(url)) return [url];
    try {
        const origin = typeof window === "undefined" ? "" : window.location.origin;
        if (!origin) return [];
        const absolute = new URL(url, origin);
        const proxiedUrl = absolute.searchParams.get("url") || "";
        if ((absolute.pathname === "/api/media-proxy" || /^\/api\/ai\/system\/[^/]+\/_media$/.test(absolute.pathname)) && isPublicMediaUrl(proxiedUrl)) return [proxiedUrl];
        if (url.startsWith("/api/generation-log-assets/")) return [absolute.toString()];
    } catch {
        return [];
    }
    return [];
}

export function externalPublicImageSourceCandidates(value?: string) {
    const url = (value || "").trim();
    if (!url || /^data:image\//i.test(url)) return [];
    if (isUnsignedReferenceAssetUrl(url)) return [];
    if (isExternalPublicMediaUrl(url)) return [url];
    try {
        const origin = typeof window === "undefined" ? "" : window.location.origin;
        if (!origin) return [];
        const absolute = new URL(url, origin);
        const proxiedUrl = absolute.searchParams.get("url") || "";
        if ((absolute.pathname === "/api/media-proxy" || /^\/api\/ai\/system\/[^/]+\/_media$/.test(absolute.pathname)) && isExternalPublicMediaUrl(proxiedUrl)) return [proxiedUrl];
        if (url.startsWith("/api/generation-log-assets/") && isExternalPublicMediaUrl(absolute.toString())) return [absolute.toString()];
    } catch {
        return [];
    }
    return [];
}

export async function publishReferenceImage(dataUrl: string) {
    const response = await fetch("/api/reference-assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "image", dataUrl }),
    });
    const payload = (await response.json().catch(() => ({}))) as { upstreamUrl?: unknown; error?: unknown };
    if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : "参考图临时上传失败");
    const url = typeof payload.upstreamUrl === "string" ? payload.upstreamUrl.trim() : "";
    if (!url) throw new Error("站内参考素材签名不可用，请配置 VOZEB_PRO_ENCRYPTION_KEY");
    return url;
}

function isUnsignedReferenceAssetUrl(value: string) {
    return isProviderMediaAssetUrl(value) && !hasProviderReadSignatureShape(value);
}

export function uniqueStrings(items: string[]) {
    return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean)));
}

export function normalizeCompatibleVideoDuration(value: string) {
    return Number(normalizeVideoSeconds(value));
}

export function normalizeGlobalAiOpcVideoDuration(value: string) {
    return Number(normalizeVideoSeconds(value));
}

export function normalizeCompatibleVideoRatio(value: string) {
    const normalized = normalizeSeedanceRatio(value);
    return normalized === "adaptive" ? undefined : normalized;
}

export function normalizeCompatibleVideoQuality(value: string) {
    const resolution = normalizeVideoResolution(value);
    if (!resolution) return undefined;
    return resolution === "1080p" ? "hd" : "standard";
}

export function normalizeCompatibleVideoDimensions(value: string) {
    const size = normalizeVideoSize(value);
    if (!size) return {};
    const [width, height] = size.split("x").map((item) => Number(item));
    return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : {};
}

export function shouldFallbackToCompatibleVideo(error: unknown, message: string) {
    if (axios.isCancel(error)) return false;
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    if (status === 404 || status === 405 || status === 415) return true;
    if (status && status >= 500 && /not found|not implemented|route|endpoint|unsupported|no such|cannot post|invalid url/i.test(message)) return true;
    return /not found|not implemented|route|endpoint|unsupported|no such|cannot post|invalid url|404|base64|参考图|reference image|invalid image/i.test(message);
}

export function shouldRetryCompatibleVideoPayload(error: unknown, message: string) {
    if (axios.isCancel(error)) return false;
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    if (status && status >= 500) return /task[_ -]?id is empty|invalid_response|deserialize|unmarshal|invalid type/i.test(message);
    if (status !== 400 && status !== 422) return false;
    return /duration|seconds|duplicate field|unmarshal|invalid type|resolution|quality|size|field|image|images|image_url|input_image|ref_assets|text-to-video|image-to-video|reference image|input image|required image/i.test(message);
}
