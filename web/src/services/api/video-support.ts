import axios from "axios";

import { dataUrlToFile } from "@/lib/image-utils";
import { browserReadableMediaUrl } from "@/lib/browser-media-url";
import { resolveGeneratedMediaUrl } from "@/lib/media-url";
import { getMediaBlob, readStoredMediaFile, uploadGeneratedMediaFile, type UploadedFile } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { refreshUserPointsIfSystem, syncUserPointsFromHeaders } from "@/services/api/points";
import { boolConfig, buildSeedancePromptText, isSeedanceVideoConfig, normalizeSeedanceDuration, normalizeSeedanceRatio, normalizeSeedanceResolution, seedanceVideoReferenceError, SEEDANCE_REFERENCE_LIMITS } from "@/lib/seedance-video";
import { buildApiUrl, modelOptionName, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

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

export function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function aiApiUrl(config: AiConfig, path: string) {
    if (!config.baseUrl.startsWith("/api/ai/system/")) throw new Error("当前视频服务暂不可用，请稍后重试或联系客服");
    return buildApiUrl(config.baseUrl, path);
}

export function aiHeaders(config: AiConfig, contentType?: string) {
    return {
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

export function readConfiguredMediaUrl(config: AiConfig, record: Record<string, unknown>) {
    const configured = readConfiguredStringValue(record, config.advancedConfig?.resultField, "media");
    return configured && isLikelyVideoUrl(configured) ? configured : "";
}

export function readConfiguredTaskStatus(config: AiConfig, record: Record<string, unknown>) {
    return readConfiguredStringValue(record, config.advancedConfig?.statusField, "status").toLowerCase();
}

export function readConfiguredStringValue(record: Record<string, unknown>, fieldConfig: string | undefined, mode: "media" | "status") {
    for (const path of configuredFieldPaths(fieldConfig)) {
        const value = valueAtConfiguredPath(record, path);
        const text = configuredValueText(value, mode);
        if (text) return text;
    }
    return "";
}

export function configuredFieldPaths(value: string | undefined) {
    return (value || "")
        .split(/\r?\n|,|，|;|；|\s+\|\s+|\s+\/\s+/)
        .map((item) => item.trim())
        .filter((item) => item && !item.startsWith("/") && !item.includes(":task_id") && !item.includes("{task_id}"));
}

export function valueAtConfiguredPath(value: unknown, path: string): unknown {
    const parts = path
        .replace(/\[(\d+)\]/g, ".$1")
        .split(".")
        .map((item) => item.trim())
        .filter(Boolean);
    let current = value;
    for (const part of parts) {
        if (Array.isArray(current)) {
            const index = Number(part);
            current = Number.isInteger(index) ? current[index] : undefined;
            continue;
        }
        if (!isRecord(current)) return undefined;
        current = current[part] ?? current[Object.keys(current).find((key) => key.toLowerCase() === part.toLowerCase()) || ""];
    }
    return current;
}

export function configuredValueText(value: unknown, mode: "media" | "status"): string {
    if (typeof value === "string") return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (mode === "media") return findMediaUrl(value);
    if (isRecord(value)) return findStringByKeys(value, TASK_STATUS_KEYS);
    return "";
}

export function readTaskId(record: Record<string, unknown>) {
    return findStringByKeys(record, TASK_ID_KEYS);
}

export function readTaskStatus(record: Record<string, unknown>) {
    return findStringByKeys(record, TASK_STATUS_KEYS).toLowerCase();
}

export function readTaskMode(record: Record<string, unknown>) {
    return findStringByKeys(record, ["mode", "generation_mode", "generationMode", "task_mode", "taskMode"]).toLowerCase();
}

export function isCompletedStatus(status: string) {
    return ["completed", "complete", "succeeded", "success", "done", "finished"].includes(status);
}

export function isPendingStatus(status: string) {
    return !status || ["pending", "queued", "running", "processing", "in_progress", "created"].includes(status);
}

export function isFailedStatus(status: string) {
    return ["failed", "failure", "error", "cancelled", "canceled", "expired"].includes(status);
}

export function readTaskError(record: Record<string, unknown>) {
    const direct = findStringByKeys(record, ["msg", "message", "error_message", "errorMessage"]);
    if (direct) return direct;
    const error = record.error;
    if (error && typeof error === "object") return stringValue((error as Record<string, unknown>).message) || stringValue((error as Record<string, unknown>).msg);
    return typeof error === "string" ? error : "";
}

export function findMediaUrl(value: unknown, depth = 0): string {
    if (!value || depth > 5) return "";
    if (typeof value === "string") return isLikelyVideoUrl(value) ? value : "";
    if (Array.isArray(value)) {
        for (const item of value) {
            const url = findMediaUrl(item, depth + 1);
            if (url) return url;
        }
        return "";
    }
    if (typeof value !== "object") return "";
    const record = value as Record<string, unknown>;
    for (const key of VIDEO_URL_KEYS) {
        const url = stringValue(record[key]);
        if (url) return url;
    }
    for (const key of VIDEO_CONTAINER_KEYS) {
        const url = findMediaUrl(record[key], depth + 1);
        if (url) return url;
    }
    return "";
}

export function isLikelyVideoUrl(value: string) {
    return /^https?:\/\//i.test(value) || value.startsWith("/") || /\.(mp4|mov|webm)(\?|#|$)/i.test(value);
}

export function resolveVideoMediaUrl(config: AiConfig, value: string, baseUrl: string): ResolvedVideoMediaUrl {
    if (/^(data|blob):/i.test(value)) return { url: value };
    const remoteUrl = resolveGeneratedMediaUrl(value, baseUrl);
    if (!config.baseUrl.startsWith("/api/ai/system/")) return { url: remoteUrl, remoteUrl: remoteVideoSourceUrl(remoteUrl) };
    const proxyBase = config.baseUrl.trim().replace(/\/+$/, "");
    return {
        url: `${proxyBase}/_media?url=${encodeURIComponent(remoteUrl)}`,
        remoteUrl: remoteVideoSourceUrl(remoteUrl),
    };
}

export function stringValue(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

export function findStringByKeys(value: unknown, keys: string[], depth = 0): string {
    if (!value || depth > 4) return "";
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findStringByKeys(item, keys, depth + 1);
            if (found) return found;
        }
        return "";
    }
    if (typeof value !== "object") return "";
    const record = value as Record<string, unknown>;
    for (const key of keys) {
        const found = stringValue(record[key]);
        if (found) return found;
    }
    for (const key of VIDEO_CONTAINER_KEYS) {
        const found = findStringByKeys(record[key], keys, depth + 1);
        if (found) return found;
    }
    return "";
}

export async function buildSeedanceContent(prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[]) {
    const content: Array<Record<string, unknown>> = [];
    const text = buildSeedancePromptText(prompt, references, videoReferences, audioReferences);
    if (text) content.push({ type: "text", text });
    for (const image of references.slice(0, SEEDANCE_REFERENCE_LIMITS.images)) {
        content.push({ type: "image_url", image_url: { url: await resolveSeedanceImageUrl(image) }, role: "reference_image" });
    }
    for (const video of videoReferences.slice(0, SEEDANCE_REFERENCE_LIMITS.videos)) {
        content.push({ type: "video_url", video_url: { url: await resolveSeedanceVideoUrl(video) }, role: "reference_video" });
    }
    for (const audio of audioReferences.slice(0, SEEDANCE_REFERENCE_LIMITS.audios)) {
        content.push({ type: "audio_url", audio_url: { url: await resolveSeedanceAudioUrl(audio) }, role: "reference_audio" });
    }
    return content;
}

export async function resolveSeedanceImageUrl(image: ReferenceImage) {
    const directUrl = image.url || image.dataUrl;
    if (isPublicMediaUrl(directUrl) || /^asset(?:Id)?:\/\//i.test(directUrl)) return directUrl;
    const dataUrl = await imageToDataUrl(image);
    if (!dataUrl) throw new Error("参考图读取失败，请换一张图片或重新上传");
    return dataUrl;
}

export async function resolveSeedanceVideoUrl(video: ReferenceVideo) {
    if (isPublicMediaUrl(video.url) || /^asset(?:Id)?:\/\//i.test(video.url)) return video.url;
    let blob: Blob | null = null;
    if (video.storageKey) blob = await getMediaBlob(video.storageKey, video.url);
    if (!blob && video.url?.startsWith("blob:")) blob = await (await fetch(video.url)).blob();
    if (!blob) throw new Error("参考视频不可用，请重新上传");
    return blobToDataUrl(blob);
}

export async function resolveSeedanceAudioUrl(audio: ReferenceAudio) {
    if (isPublicMediaUrl(audio.url) || /^asset(?:Id)?:\/\//i.test(audio.url)) return audio.url;
    let blob: Blob | null = null;
    if (audio.storageKey) blob = await getMediaBlob(audio.storageKey, audio.url);
    if (!blob && audio.url?.startsWith("blob:")) blob = await (await fetch(audio.url)).blob();
    if (!blob) throw new Error("参考音频不可用，请重新上传");
    return blobToDataUrl(blob);
}

export async function videoResultFromUrl(source: string | ResolvedVideoMediaUrl, options?: RequestOptions): Promise<VideoGenerationResult> {
    const sourceUrl = typeof source === "string" ? source : source.url;
    const remoteUrl = remoteVideoSourceUrl(sourceUrl, typeof source === "string" ? undefined : source.remoteUrl);
    const playableUrl = browserReadableMediaUrl(sourceUrl);
    try {
        const response = await axios.get<Blob>(playableUrl, { responseType: "blob", signal: options?.signal });
        await assertVideoBlob(response.data);
        return { blob: response.data, remoteUrl, mimeType: response.data.type || "video/mp4" };
    } catch (error) {
        if (axios.isCancel(error) || options?.signal?.aborted) throw error;
        return { url: playableUrl, remoteUrl, mimeType: "video/mp4" };
    }
}

export function resolveOpenAiContentRemoteUrl(config: AiConfig, contentUrl: string, upstreamTaskUrl: string) {
    if (!config.baseUrl.startsWith("/api/ai/system/")) return remoteVideoSourceUrl(contentUrl);
    try {
        const upstreamUrl = new URL(upstreamTaskUrl);
        upstreamUrl.pathname = `${upstreamUrl.pathname.replace(/\/+$/, "")}/content`;
        upstreamUrl.search = "";
        upstreamUrl.hash = "";
        return remoteVideoSourceUrl(upstreamUrl.toString());
    } catch {
        return undefined;
    }
}

export function remoteVideoSourceUrl(value: string, fallback?: string) {
    const proxiedRemoteUrl = proxiedMediaSourceUrl(value);
    if (isPublicMediaUrl(proxiedRemoteUrl)) return proxiedRemoteUrl;
    if (isPublicMediaUrl(fallback || "")) return fallback;
    return isPublicMediaUrl(value) ? value : undefined;
}

export function proxiedMediaSourceUrl(value: string) {
    const trimmed = (value || "").trim();
    if (!trimmed) return "";
    try {
        const baseUrl = typeof window === "undefined" ? "http://localhost" : window.location.origin;
        const parsed = new URL(trimmed, baseUrl);
        const isMediaProxy = parsed.pathname === "/api/media-proxy" || /^\/api\/ai\/system\/[^/]+\/_media$/.test(parsed.pathname);
        if (!isMediaProxy) return "";
        return parsed.searchParams.get("url") || "";
    } catch {
        return "";
    }
}

export function readHeader(headers: unknown, key: string) {
    if (!headers || typeof headers !== "object") return "";
    const getter = (headers as { get?: (name: string) => unknown }).get;
    const value = typeof getter === "function" ? getter.call(headers, key) || getter.call(headers, key.toLowerCase()) : (headers as Record<string, unknown>)[key] || (headers as Record<string, unknown>)[key.toLowerCase()];
    return typeof value === "string" ? value : Array.isArray(value) ? String(value[0] || "") : "";
}

export function assertVideoConfig(config: AiConfig, model: string) {
    if (!model) throw new Error("请先配置视频模型");
    if (!config.baseUrl.startsWith("/api/ai/system/")) throw new Error("当前视频服务暂不可用，请稍后重试或联系客服");
}

export function normalizeVideoSeconds(value: string) {
    const seconds = Number(value);
    return String(Number.isSafeInteger(seconds) && (seconds > 0 || seconds === -1) ? seconds : 5);
}

export function normalizeVideoSize(value: string) {
    if (value === "auto") return null;
    const size = value || "1280x720";
    if (/^\d+x\d+$/.test(size)) return size;
    return ["9:16", "2:3", "3:4"].includes(size) ? "720x1280" : "1280x720";
}

export function normalizeVideoResolution(value: string) {
    if (value === "low") return "480p";
    if (value === "auto" || value === "high" || value === "medium") return "720p";
    const resolution = value.replace(/p$/i, "") || "720";
    return `${resolution}p`;
}

export function unwrapVideoResponse(payload: ApiVideoResponse) {
    return unwrapEnvelope(payload, "接口没有返回视频任务");
}

export function unwrapSeedanceTask(payload: ApiEnvelope<SeedanceTask>) {
    return unwrapEnvelope(payload, "Seedance 接口没有返回任务");
}

export function unwrapEnvelope<T>(payload: ApiEnvelope<T>, emptyMessage: string): T {
    if (!payload) throw new Error(emptyMessage);
    if (typeof payload === "object" && "code" in payload && typeof payload.code === "number") {
        if (payload.code !== 0) throw new Error(payload.msg || "请求失败");
        if (!payload.data) throw new Error(emptyMessage);
        return payload.data;
    }
    return payload as T;
}

export function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return "请求已取消";
    if (axios.isAxiosError<{ error?: { message?: string }; message?: string; msg?: string; code?: number }>(error)) {
        const responseData = error.response?.data;
        return responseData?.msg || responseData?.message || responseData?.error?.message || statusMessage(error.response?.status, fallback);
    }
    if (error instanceof DOMException && error.name === "AbortError") return "请求已取消";
    return error instanceof Error ? error.message : fallback;
}

export function videoCreationError(message: string) {
    return prefixedVideoError(message, VIDEO_CREATE_ERROR_PREFIX);
}

export function videoQueryError(message: string) {
    return prefixedVideoError(message, VIDEO_QUERY_ERROR_PREFIX);
}

export function videoStageError(message: string) {
    return prefixedVideoError(message, VIDEO_STAGE_ERROR_PREFIX);
}

export function prefixedVideoError(message: string, prefix: string) {
    const cleanMessage = (message || "").trim() || prefix.replace(/：$/, "");
    if (cleanMessage.startsWith(prefix) || cleanMessage.startsWith(prefix.replace(/：$/, ""))) return cleanMessage;
    return `${prefix}${cleanMessage}`;
}

export function statusMessage(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return "当前服务暂时无法使用，请稍后重试或联系客服";
    if (status === 429) return "请求被限流或额度不足，请稍后重试";
    return status ? `${fallback}（${status}）` : fallback;
}

export async function assertVideoBlob(blob: Blob) {
    if (!blob.type.includes("json")) return;
    let payload: { code?: number; msg?: string; error?: { message?: string } };
    try {
        payload = JSON.parse(await blob.text()) as { code?: number; msg?: string; error?: { message?: string } };
    } catch {
        return;
    }
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(payload.msg || "视频下载失败");
    if (payload.error?.message) throw new Error(payload.error.message);
}

export function isPublicMediaUrl(value: string) {
    return /^https?:\/\//i.test(value || "");
}

export function isExternalPublicMediaUrl(value: string) {
    if (!isPublicMediaUrl(value)) return false;
    try {
        const hostname = new URL(value).hostname.toLowerCase();
        return hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1";
    } catch {
        return false;
    }
}

export function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}

export function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取素材失败"));
        reader.readAsDataURL(blob);
    });
}
