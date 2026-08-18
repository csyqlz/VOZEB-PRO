import { rawReferenceRequestUrlCandidates } from "./image-task-reference-urls";
import { after, NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { getAuthSettings, refundUserPoints } from "@/lib/auth/store";
import { buildImageReferencePromptText } from "@/lib/image-reference-prompt";
import { dedupeImageResults } from "@/lib/image-result-dedupe";
import { configureServerProxyDispatcher } from "@/lib/server/proxy-dispatcher";
import { fetchInternalApi, isInternalApiBaseUrl, resolveInternalOrigin } from "@/lib/server/internal-origin";
import { resolveGeneratedMediaUrl } from "@/lib/media-url";
import { resolveGlobalAiOpcPreset } from "@/lib/globalaiopc-catalog";
import { toSafeGenerationErrorMessage } from "@/lib/server/generation-errors";
import { generationModelId, toSystemGenerationChannel } from "@/lib/server/generation-channel";
import { finishGenerationAttempt, startGenerationAttempt } from "@/lib/server/generation-attempt";
import { resolveLogicalModelCandidates } from "@/lib/server/logical-model-router";
import { resolveChannelModelConfig } from "@/lib/channel-protocol-registry";
import { assertReferenceCapabilities } from "@/lib/server/provider-task-config";
import { countActiveImageTasksForUser, createImageTask, getImageTask, touchImageTask, transitionImageTask, type ImageTask, type ImageTaskConfig, type ImageTaskReference, updateImageTask } from "@/lib/server/image-task-store";
import { isGenerationSource, recordGenerationLog } from "@/lib/server/generation-log-store";
import { writeReferenceImageDataUrl } from "@/lib/server/reference-asset-store";
import { resolveImageTaskOptions } from "@/lib/server/image-task-config";
import { linkStoredGenerationTask, type GenerationTaskContext } from "@/lib/server/generation-task-store";
import { registerGenerationTaskAssetsForUser } from "@/lib/server/creative-runtime-service";
import { createSignedReferenceAssetUrl, signReferenceAssetInputUrl } from "@/lib/server/reference-asset-access";
import { assertCapabilityConstraints } from "@/lib/server/capability-constraints";
import { resolveModelPollingAttempts, resolveModelRequestTimeoutMs } from "@/lib/server/model-request-policy";
import { systemAiBillingHeaders } from "@/lib/server/system-ai-billing";
import { maintenanceWorkerContextHeaders } from "@/lib/server/maintenance-auth";
import { fetchSafeOutbound } from "@/lib/server/safe-outbound-fetch";
import { GenerationSubmissionSafeFailure, GenerationSubmissionUncertainError, generationSubmissionResponseError, generationSubmissionUncertainError } from "@/lib/server/generation-submission-error";

import {
    type CreateImageTaskBody,
    type ImageApiResponse,
    type ImageTaskMediaResult,
    type ImageTaskResult,
    type ImageTaskRunResult,
    type GeminiPart,
    type GeminiPayload,
    QUALITY_BASE,
    QUALITY_ALIASES,
    IMAGE_OUTPUT_FORMAT,
    TASK_HEARTBEAT_MS,
    IMAGE_TASK_POLL_INTERVAL_MS,
    IMAGE_TASK_POLL_ATTEMPTS,
    MAX_INLINE_IMAGE_BYTES,
    INLINE_IMAGE_TIMEOUT_MS,
    IMAGE_RESPONSE_FORMATS,
    IMAGE_URL_KEYS,
    IMAGE_BASE64_KEYS,
    IMAGE_CONTAINER_KEYS,
    IMAGE_TASK_ID_KEYS,
    IMAGE_STATUS_KEYS,
    IMAGE_POLL_URL_KEYS,
    type ImageEditReferenceMode,
} from "./image-task-types";

export { imageRequestAspectRatio, parseImageDimensions, parseImageRatio, resolveRequestSize, resolveResultSize, resolveSize, validateImageSize } from "./image-task-size";

export function publicTask(task: ImageTask) {
    return {
        id: task.id,
        kind: task.kind,
        status: task.status,
        model: generationModelId(task.config),
    };
}

export function sanitizeConfigs(config: ImageTaskConfig | undefined, settings: Awaited<ReturnType<typeof getAuthSettings>>): ImageTaskConfig[] {
    const requestedModel = config?.model || settings.defaultModels.imageModel;
    return resolveLogicalModelCandidates(settings, "image", requestedModel).map((resolved) => {
        const channel = toSystemGenerationChannel(resolved);
        return {
            ...channel,
            channelId: resolved.channelId,
            ...resolveImageTaskOptions(config || {}, settings.generationDefaults),
            systemPrompt: "",
            advancedConfig: sanitizeAdvancedConfig(channel.advancedConfig),
        };
    });
}

export function sanitizeAdvancedConfig(config?: ImageTaskConfig["advancedConfig"]) {
    if (!config || typeof config !== "object") return undefined;
    return {
        protocol: config.protocol || "auto",
        globalAiOpcPreset: config.globalAiOpcPreset,
        globalAiOpcPresets: config.globalAiOpcPresets,
        textModel: textOrEmpty(config.textModel),
        imageModel: textOrEmpty(config.imageModel),
        videoModel: textOrEmpty(config.videoModel),
        createPath: textOrEmpty(config.createPath),
        editPath: textOrEmpty(config.editPath),
        queryPath: textOrEmpty(config.queryPath),
        requestTemplate: textOrEmpty(config.requestTemplate),
        resultField: textOrEmpty(config.resultField),
        statusField: textOrEmpty(config.statusField),
        durationRange: textOrEmpty(config.durationRange),
        referenceRule: textOrEmpty(config.referenceRule),
        supportsReferenceImage: Boolean(config.supportsReferenceImage),
        supportsReferenceVideo: Boolean(config.supportsReferenceVideo),
        supportsReferenceAudio: Boolean(config.supportsReferenceAudio),
    };
}

export function textOrEmpty(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

export async function preferredImageResponseFormat(config: ImageTaskConfig): Promise<(typeof IMAGE_RESPONSE_FORMATS)[number]> {
    return "url";
}

export async function openAiImageTaskPath(config: ImageTaskConfig, kind: ImageTask["kind"]) {
    const configured = (config.advancedConfig?.createPath || "").trim();
    const configuredPath = configured ? normalizeImageTaskPath(configured) : "";
    if (kind !== "edit") return configuredPath || "/images/generations";
    const configuredEditPath = (config.advancedConfig?.editPath || "").trim();
    if (configuredEditPath) return normalizeImageTaskPath(configuredEditPath);
    const apiBase = await resolveConfiguredApiBaseUrl(config.baseUrl).catch(() => config.baseUrl);
    if (shouldUseSub2ApiImageEdit(config, apiBase)) return configuredPath || "/images/generations";

    const ruleEditPath = configuredImageEditPath(config);
    if (ruleEditPath) return ruleEditPath;
    if (!configuredPath) return "/images/edits";

    const referenceMode = configuredImageEditReferenceMode(config);
    if (referenceMode === "json" || referenceMode === "public-url" || globalAiOpcImagePreset(config)) return configuredPath;
    if (isStandardOpenAiImageGenerationPath(configuredPath)) return configuredPath.replace(/\/generations$/i, "/edits");
    return configuredPath;
}

export function configuredImageEditPath(config: ImageTaskConfig) {
    const rule = (config.advancedConfig?.referenceRule || "").trim();
    const match = rule.match(/\/(?:[a-z0-9._-]+\/)*images\/edits\b/i);
    return match?.[0] ? normalizeImageTaskPath(match[0]) : "";
}

export function normalizeImageTaskPath(path: string) {
    return path.startsWith("/") ? path : `/${path}`;
}

export function isStandardOpenAiImageGenerationPath(path: string) {
    return /^\/(?:v1\/)?images\/generations$/i.test(path);
}

export async function shouldUseJsonImageEdit(config: ImageTaskConfig) {
    if (globalAiOpcImagePreset(config)) return true;
    const referenceMode = configuredImageEditReferenceMode(config);
    const apiBase = await resolveConfiguredApiBaseUrl(config.baseUrl).catch(() => config.baseUrl);
    if (shouldUseSub2ApiImageEdit(config, apiBase)) return true;
    if (referenceMode === "json" || referenceMode === "public-url") return true;
    if (referenceMode === "multipart") return false;
    return false;
}

export function configuredImageEditReferenceMode(config: ImageTaskConfig): ImageEditReferenceMode {
    const rule = (config.advancedConfig?.referenceRule || "").trim().toLowerCase();
    if (!rule) return "auto";
    if (/\bmultipart\b|form-?data|file upload|\u6587\u4ef6\u4e0a\u4f20|\u4e0a\u4f20\u6587\u4ef6/i.test(rule)) return "multipart";
    if (/\u516c\u7f51|public|next_public_site_url|localhost|must.*\burl\b|\burl\b.*only|\u5fc5\u987b.*\burl\b|\u4ec5.*\burl\b|\u53ea.*\burl\b/i.test(rule)) return "public-url";
    if (/\bjson\b|base64.*json|json.*base64|data:image|inline|ref_assets|input_image|image\/images/i.test(rule)) return "json";
    return "auto";
}

export function globalAiOpcImagePreset(config: ImageTaskConfig) {
    const preset = resolveGlobalAiOpcPreset(config.advancedConfig, config.model);
    return preset?.capability === "image" ? preset : undefined;
}

export async function resolveConfiguredApiBaseUrl(baseUrl: string) {
    const systemChannelId = readSystemChannelId(baseUrl);
    if (!systemChannelId) return baseUrl;
    const settings = await getAuthSettings();
    return settings.systemChannels.find((channel) => channel.id === systemChannelId)?.baseUrl || baseUrl;
}

export function readSystemChannelId(baseUrl: string) {
    try {
        const parsed = new URL(baseUrl, "http://localhost");
        const match = parsed.pathname.match(/^\/api\/ai\/system\/([^/]+)/);
        return match?.[1] ? decodeURIComponent(match[1]) : "";
    } catch {
        return "";
    }
}

export function shouldUseSub2ApiImageEdit(config: ImageTaskConfig, apiBase: string) {
    if (config.advancedConfig?.protocol === "sub2api") return true;
    if (isCode2AlitaApiBase(apiBase)) return true;
    const advanced = config.advancedConfig;
    const requestTemplate = (advanced?.requestTemplate || "").toLowerCase();
    const referenceRule = (advanced?.referenceRule || "").toLowerCase();
    if (/\bsub2api\b/i.test(`${requestTemplate}\n${referenceRule}`)) return true;
    return /\bimage_urls\b|images\[\]\.image_url|"images"\s*:\s*\[\s*\{\s*"image_url"|images\s*:\s*\[\s*\{\s*image_url/i.test(requestTemplate);
}

export function isCode2AlitaApiBase(baseUrl: string) {
    return matchesApiHost(baseUrl, "code2alita.com");
}

export function matchesApiHost(baseUrl: string, hostname: string) {
    try {
        const host = new URL(baseUrl).hostname.toLowerCase();
        const target = hostname.toLowerCase();
        return host === target || host.endsWith(`.${target}`);
    } catch {
        return false;
    }
}

export function taskUrl(config: ImageTaskConfig, path: string, origin: string) {
    const protocol = resolveChannelModelConfig(config.advancedConfig, config.model)?.protocol || config.advancedConfig?.protocol;
    const apiBase = protocol === "custom" || protocol === "stable-diffusion" || protocol === "yumeng" ? absoluteApiBaseUrl(config.baseUrl, origin) : normalizeApiBaseUrl(config.baseUrl, config.apiFormat, origin);
    return `${apiBase}${path}`;
}

export function normalizeApiBaseUrl(baseUrl: string, apiFormat: "openai" | "gemini", origin: string) {
    const normalized = absoluteApiBaseUrl(baseUrl, origin);
    const lower = normalized.toLowerCase();
    if (isInternalSystemProxyBase(normalized)) return normalized;
    if (lower.endsWith("/v1") || lower.endsWith("/v1beta") || lower.endsWith("/api/v3") || lower.endsWith("/api/plan/v3")) return normalized;
    if (apiFormat === "gemini") return `${normalized}/v1beta`;
    return `${normalized}/v1`;
}

function absoluteApiBaseUrl(baseUrl: string, origin: string) {
    return (baseUrl.startsWith("/") ? `${origin}${baseUrl}` : baseUrl).trim().replace(/\/+$/, "");
}

export function isInternalSystemProxyBase(value: string) {
    try {
        return /^\/api\/ai\/system\/[^/]+$/i.test(new URL(value).pathname);
    } catch {
        return false;
    }
}

export function taskHeaders(config: ImageTaskConfig, cookie: string, pointsIdempotencyKey?: string) {
    const headers = new Headers();
    const internal = config.baseUrl.startsWith("/");
    const workerHeaders = maintenanceWorkerContextHeaders(cookie);
    if (internal && workerHeaders) Object.entries(workerHeaders).forEach(([key, value]) => headers.set(key, value));
    else if (internal && cookie) headers.set("cookie", cookie);
    if (internal) Object.entries(systemAiBillingHeaders(generationModelId(config), pointsIdempotencyKey, config.model)).forEach(([key, value]) => headers.set(key, value));
    if (pointsIdempotencyKey?.trim()) {
        headers.set("Idempotency-Key", pointsIdempotencyKey.trim());
        headers.set("X-Client-Request-Id", pointsIdempotencyKey.trim());
    }
    if (!internal && config.apiFormat === "gemini") headers.set("x-goog-api-key", config.apiKey);
    else if (!internal) headers.set("authorization", `Bearer ${config.apiKey}`);
    return headers;
}

export function taskFetch(config: ImageTaskConfig, url: string, init: RequestInit) {
    const nextInit = {
        ...init,
        signal: init.signal || AbortSignal.timeout(imageTaskRequestTimeoutMs(config)),
    };
    if (!isInternalApiBaseUrl(config.baseUrl)) return fetchSafeOutbound(url, nextInit);
    return fetchInternalApi(url, nextInit);
}

export async function imageSubmissionFetch(config: ImageTaskConfig, url: string, init: RequestInit) {
    try {
        return await taskFetch(config, url, init);
    } catch (error) {
        throw generationSubmissionUncertainError(error, "图片任务创建结果未知");
    }
}

export function imageSubmissionResponseError(status: number, message: string) {
    return generationSubmissionResponseError(status, message);
}

export async function parseImageSubmissionJson<T>(response: Response): Promise<T> {
    try {
        return (await response.json()) as T;
    } catch {
        throw new GenerationSubmissionUncertainError("图片接口返回了无效 JSON，创建结果待确认");
    }
}

export function imageTaskRequestTimeoutMs(config: ImageTaskConfig) {
    return resolveModelRequestTimeoutMs(config, "image");
}

export function imageTaskPollAttempts(config: ImageTaskConfig) {
    return resolveModelPollingAttempts(config, "image", IMAGE_TASK_POLL_INTERVAL_MS, IMAGE_TASK_POLL_ATTEMPTS);
}

export class ImageUpstreamTerminalError extends Error {}
export class ImageQueryContractError extends Error {}

export function geminiHeaders(config: ImageTaskConfig, cookie: string, pointsIdempotencyKey?: string) {
    const headers = taskHeaders(config, cookie, pointsIdempotencyKey);
    headers.set("content-type", "application/json");
    return headers;
}

export function imagePointsIdempotencyKey(task: Pick<ImageTask, "id" | "attemptNo">) {
    return `image-task:${task.id}:attempt:${task.attemptNo || 1}`;
}

export function geminiApiUrl(config: ImageTaskConfig, action: "generateContent", origin: string) {
    const baseUrl = normalizeApiBaseUrl(config.baseUrl, "gemini", origin);
    return `${baseUrl}/models/${encodeURIComponent(config.model.replace(/^models\//, ""))}:${action}`;
}

export function withSystemPrompt(config: ImageTaskConfig, prompt: string) {
    const systemPrompt = (config.systemPrompt || "").trim();
    return systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
}

export async function parseImagePayloadOrPoll(config: ImageTaskConfig, payload: ImageApiResponse, mediaBaseUrl: string, cookie: string, pollBaseUrl = mediaBaseUrl, singleStep = false): Promise<ImageTaskResult> {
    const payloadError = readImagePayloadError(payload);
    if (payloadError) throw new GenerationSubmissionSafeFailure(payloadError);
    const images = findImageResults(payload, mediaBaseUrl, config);
    if (images.length) return imageTaskResultFromMedia(images);

    const taskId = readImageTaskId(payload);
    if (!taskId) throw new GenerationSubmissionUncertainError("图片接口没有返回图片或任务 ID，创建结果待确认");
    const explicitPollUrl = readImagePollUrl(config, payload, mediaBaseUrl, pollBaseUrl);
    const upstream = { id: taskId, mediaBaseUrl, pollBaseUrl, explicitPollUrl: explicitPollUrl || undefined };
    if (!imageTaskPollUrls(config, pollBaseUrl, taskId, explicitPollUrl).length) {
        return { dataUrl: "", needsReview: { upstream, reason: "OpenAI 图片接口未返回图片，且渠道没有声明异步查询路径" } };
    }
    if (singleStep) return { dataUrl: "", pending: upstream };
    return pollOpenAiImageTask(config, taskId, mediaBaseUrl, pollBaseUrl, cookie, explicitPollUrl);
}

export async function pollOpenAiImageTask(config: ImageTaskConfig, taskId: string, mediaBaseUrl: string, pollBaseUrl: string, cookie: string, explicitPollUrl = "", singleStep = false): Promise<ImageTaskResult> {
    const pollUrls = imageTaskPollUrls(config, pollBaseUrl, taskId, explicitPollUrl);
    if (!pollUrls.length) throw new ImageQueryContractError("OpenAI 图片任务缺少明确的异步查询路径");
    let lastError = "";
    for (let attempt = 0; attempt < (singleStep ? 1 : imageTaskPollAttempts(config)); attempt += 1) {
        for (const pollUrl of pollUrls) {
            const response = await taskFetch(config, pollUrl, { method: "GET", headers: taskHeaders(config, cookie), cache: "no-store", signal: AbortSignal.timeout(Math.min(imageTaskRequestTimeoutMs(config), 60_000)) });
            if (!response.ok) {
                const message = await readFetchError(response, "图片任务查询失败");
                lastError = message;
                if (response.status === 404 || response.status === 405) continue;
                throw new Error(message);
            }
            const payload = await parseImageQueryJson(response);
            const baseUrl = response.headers.get("x-vozeb-pro-upstream-url") || mediaBaseUrl || pollUrl;
            const image = parseImagePayloadCompat(payload, baseUrl, config);
            if (image) return image;
            const error = readImagePayloadError(payload);
            if (error) throw new ImageUpstreamTerminalError(error);
            payload.status = readImageTaskStatus(payload) || payload.status;
            if (!isPendingImageStatus(payload.status)) throw new ImageUpstreamTerminalError("图片任务完成但没有返回图片");
        }
        if (!singleStep) await delay(IMAGE_TASK_POLL_INTERVAL_MS);
    }
    if (singleStep) return { dataUrl: "", pending: { id: taskId, mediaBaseUrl, pollBaseUrl, explicitPollUrl: explicitPollUrl || undefined } };
    throw new Error(lastError || "图片生成超时，请稍后重试");
}

export async function parseImageQueryJson(response: Response): Promise<ImageApiResponse> {
    const text = await response.text();
    const contentType = response.headers.get("content-type") || "";
    if (/^\s*(?:<!doctype\s+html|<html\b)/i.test(text)) {
        throw new ImageQueryContractError(`图片任务查询路径返回了网页内容${contentType ? `（${contentType}）` : ""}`);
    }
    try {
        return JSON.parse(text) as ImageApiResponse;
    } catch {
        throw new ImageQueryContractError("图片任务查询接口返回了无效 JSON");
    }
}

export function parseImagePayloadCompat(payload: ImageApiResponse, baseUrl: string, config: ImageTaskConfig): ImageTaskResult | null {
    const error = readImagePayloadError(payload);
    if (error) throw new Error(error);
    const images = findImageResults(payload, baseUrl, config);
    return images.length ? imageTaskResultFromMedia(images) : null;
}

export function findImageResult(value: unknown, baseUrl: string, config: ImageTaskConfig, depth = 0): ImageTaskResult | null {
    const images = findImageResults(value, baseUrl, config, depth);
    return images.length ? imageTaskResultFromMedia(images) : null;
}

export function findImageResults(value: unknown, baseUrl: string, config: ImageTaskConfig, depth = 0): ImageTaskMediaResult[] {
    const images: ImageTaskMediaResult[] = [];
    collectImageResults(value, baseUrl, config, depth, images);
    return dedupeImageResults(images);
}

function collectImageResults(value: unknown, baseUrl: string, config: ImageTaskConfig, depth: number, images: ImageTaskMediaResult[]) {
    if (!value || depth > 6) return null;
    if (typeof value === "string") {
        const inlineImage = rawImageBase64DataUrl(value);
        if (inlineImage) {
            images.push({ dataUrl: inlineImage });
            return;
        }
        const url = resolveImageUrlLike(value, baseUrl, config, false);
        if (url) images.push(url);
        const dataUrl = resolveImageBase64Like(value);
        if (!url && dataUrl) images.push({ dataUrl });
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectImageResults(item, baseUrl, config, depth + 1, images);
        return;
    }
    if (typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    for (const key of IMAGE_BASE64_KEYS) {
        const dataUrl = resolveImageBase64Like(stringField(record, key));
        if (dataUrl) images.push({ dataUrl });
    }
    for (const key of IMAGE_URL_KEYS) {
        const image = resolveImageUrlLike(stringField(record, key), baseUrl, config, true);
        if (image) images.push(image);
    }
    for (const key of IMAGE_CONTAINER_KEYS) collectImageResults(record[key], baseUrl, config, depth + 1, images);
}

function imageTaskResultFromMedia(images: ImageTaskMediaResult[]): ImageTaskResult {
    return { ...images[0], results: images };
}

export function resolveImageUrlLike(value: string, baseUrl: string, config: ImageTaskConfig, fromNamedField: boolean) {
    const mediaUrl = value.trim();
    if (!mediaUrl) return null;
    if (/^data:image\//i.test(mediaUrl) || /^blob:/i.test(mediaUrl)) return { dataUrl: mediaUrl };
    if (fromNamedField || isLikelyImageUrl(mediaUrl)) {
        const dataUrl = resolveTaskMediaUrl(config, mediaUrl, baseUrl);
        const remoteUrl = resolveGeneratedMediaUrl(mediaUrl, baseUrl);
        return { dataUrl, remoteUrl: isRemoteMediaUrl(remoteUrl) ? remoteUrl : undefined };
    }
    return null;
}

function rawImageBase64DataUrl(value: string) {
    const base64 = value.trim().replace(/\s/g, "");
    const mimeType = base64.startsWith("/9j/")
        ? "image/jpeg"
        : base64.startsWith("iVBORw0KGgo")
          ? "image/png"
          : base64.startsWith("R0lGOD")
            ? "image/gif"
            : base64.startsWith("UklGR")
              ? "image/webp"
              : "";
    return mimeType && /^[a-z0-9+/=_-]+$/i.test(base64) ? `data:${mimeType};base64,${base64}` : "";
}

export function resolveImageBase64Like(value: string) {
    const base64 = value.trim();
    if (!base64) return "";
    if (/^data:image\//i.test(base64)) return base64;
    const rawImage = rawImageBase64DataUrl(base64);
    if (rawImage) return rawImage;
    if (base64.length < 64 || !/^[a-z0-9+/=_-]+$/i.test(base64.replace(/\s/g, ""))) return "";
    return `data:image/png;base64,${base64.replace(/\s/g, "")}`;
}

export function isLikelyImageUrl(value: string) {
    return /^https?:\/\//i.test(value) || value.startsWith("/") || value.startsWith("./") || value.startsWith("../") || /\.(png|jpe?g|webp|gif|avif)(\?|#|$)/i.test(value);
}

export function readImagePayloadError(payload: ImageApiResponse) {
    if (typeof payload.code === "number" && payload.code !== 0) return payload.msg || "图片生成失败";
    if (payload.error?.message) return payload.error.message;
    const status = (payload.status || "").toLowerCase();
    if (["failed", "failure", "error", "cancelled", "canceled", "expired"].includes(status)) return payload.msg || "图片生成失败";
    return "";
}

export function readImageTaskId(payload: ImageApiResponse) {
    return findStringByKeys(payload, IMAGE_TASK_ID_KEYS);
}

export function readImageTaskStatus(payload: ImageApiResponse) {
    return findStringByKeys(payload, IMAGE_STATUS_KEYS).toLowerCase();
}

export function readImagePollUrl(config: ImageTaskConfig, payload: ImageApiResponse, mediaBaseUrl: string, pollBaseUrl: string) {
    const value = findStringByKeys(payload, IMAGE_POLL_URL_KEYS);
    if (!value || config.baseUrl.startsWith("/api/ai/system/")) return "";
    return resolveGeneratedMediaUrl(value, mediaBaseUrl || pollBaseUrl);
}

export function findStringByKeys(value: unknown, keys: string[], depth = 0): string {
    if (!value || depth > 5) return "";
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
        const found = stringField(record, key);
        if (found) return found;
    }
    for (const key of IMAGE_CONTAINER_KEYS) {
        const found = findStringByKeys(record[key], keys, depth + 1);
        if (found) return found;
    }
    return "";
}

export function isPendingImageStatus(status?: string) {
    const value = (status || "").toLowerCase();
    return !value || ["pending", "queued", "running", "processing", "in_progress", "created"].includes(value);
}

export function imageTaskPollUrls(config: ImageTaskConfig, requestUrl: string, taskId: string, explicitPollUrl = "") {
    const cleanUrl = requestUrl.split("?")[0].replace(/\/+$/, "");
    const encodedTaskId = encodeURIComponent(taskId);
    const declared = [configuredImageTaskPollUrl(config, taskId, requestUrl), explicitPollUrl].filter(Boolean);
    if (declared.length || !allowsImageProtocolFallback(config)) return Array.from(new Set(declared));
    const pollUrls = [`${cleanUrl}/${encodedTaskId}`];
    const generationsUrl = cleanUrl.replace(/\/images\/(?:generations|edits)$/i, "/images/generations");
    if (generationsUrl !== cleanUrl) pollUrls.push(`${generationsUrl}/${encodedTaskId}`);
    return Array.from(new Set(pollUrls.filter(Boolean)));
}

export function configuredImageTaskPollUrl(config: ImageTaskConfig, taskId: string, requestUrl: string) {
    const queryPath = (globalAiOpcImagePreset(config)?.queryPath || config.advancedConfig?.queryPath || "").trim();
    if (!queryPath) return "";
    let origin = "";
    try {
        origin = new URL(requestUrl).origin;
    } catch {
        return "";
    }
    const rendered = queryPath.replace(/\{\{\s*(?:taskId|task_id|id)\s*\}\}|\{(?:taskId|task_id|id)\}|:(?:taskId|task_id|id)\b/gi, encodeURIComponent(taskId));
    return taskUrl(config, rendered === queryPath ? `${queryPath.replace(/\/+$/, "")}/${encodeURIComponent(taskId)}` : rendered, origin);
}

export function resolveTaskMediaUrl(config: ImageTaskConfig, value: string, baseUrl: string) {
    if (/^(data|blob):/i.test(value)) return value;
    const remoteUrl = resolveGeneratedMediaUrl(value, baseUrl);
    if (!config.baseUrl.startsWith("/api/ai/system/")) return remoteUrl;
    const proxyBase = config.baseUrl.trim().replace(/\/+$/, "");
    return `${proxyBase}/_media?url=${encodeURIComponent(remoteUrl)}`;
}

export function shouldRetryInternalImageUrlAsBase64(result: ImageTaskResult) {
    return isInternalGeneratedImageUrl(result.remoteUrl || "") || isInternalGeneratedImageUrl(result.dataUrl || "");
}

export function isInternalGeneratedImageUrl(value: string) {
    const url = value.trim();
    if (!/^https?:\/\//i.test(url)) return false;
    try {
        const host = new URL(url).hostname.toLowerCase();
        return !host.includes(".") || host.endsWith(".internal") || host.endsWith(".local");
    } catch {
        return false;
    }
}

export async function inlineRemoteImageResult(value: string, origin: string, cookie: string, remoteFallback?: string, internalHeaders?: HeadersInit) {
    const url = (value || "").trim();
    if (!url || url.startsWith("data:")) return { dataUrl: url, remoteUrl: remoteFallback };
    const mediaSource = resolveProxiedMediaSource(url, origin);
    const remoteUrl = mediaSource.remoteUrl || remoteFallback || (isRemoteMediaUrl(url) && !mediaSource.proxyUrl ? url : undefined);
    const fallbackUrl = remoteUrl || mediaSource.proxyUrl;
    const fetchUrl = url.startsWith("/") ? `${origin}${url}` : url;
    if (!isRemoteMediaUrl(fetchUrl)) return { dataUrl: url, remoteUrl: fallbackUrl };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), INLINE_IMAGE_TIMEOUT_MS);
    try {
        const workerHeaders = maintenanceWorkerContextHeaders(cookie);
        const headers = new Headers(workerHeaders || (cookie ? { cookie } : undefined));
        new Headers(internalHeaders).forEach((headerValue, key) => headers.set(key, headerValue));
        const response = await (url.startsWith("/") ? fetchInternalApi : fetchSafeOutbound)(fetchUrl, {
            headers: url.startsWith("/") ? headers : undefined,
            cache: "no-store",
            signal: controller.signal,
        });
        if (!response.ok || !response.body) return { dataUrl: url, remoteUrl: fallbackUrl };
        const contentLength = Number(response.headers.get("content-length") || 0);
        if (contentLength > MAX_INLINE_IMAGE_BYTES) return { dataUrl: url, remoteUrl: fallbackUrl };
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > MAX_INLINE_IMAGE_BYTES) return { dataUrl: url, remoteUrl: fallbackUrl };
        const mimeType = response.headers.get("content-type")?.split(";", 1)[0] || "image/png";
        if (!mimeType.startsWith("image/")) return { dataUrl: url, remoteUrl: fallbackUrl };
        return { dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}`, remoteUrl: fallbackUrl };
    } catch {
        return { dataUrl: url, remoteUrl: fallbackUrl };
    } finally {
        clearTimeout(timer);
    }
}

export function directRemoteImageResult(remoteUrl?: string) {
    const fallback = (remoteUrl || "").trim();
    if (!isRemoteMediaUrl(fallback) || isInternalGeneratedImageUrl(fallback)) return null;
    return { dataUrl: fallback, remoteUrl: fallback };
}

export function resolveProxiedMediaSource(value: string, origin: string) {
    const trimmed = value.trim();
    const absolute = trimmed.startsWith("/") ? `${origin}${trimmed}` : trimmed;
    try {
        const parsed = new URL(absolute);
        const isSameOrigin = parsed.origin === origin;
        const isProxyPath = parsed.pathname === "/api/media-proxy" || /^\/api\/ai\/system\/[^/]+\/_media$/.test(parsed.pathname);
        if (!isProxyPath) return {};
        const sourceUrl = parsed.searchParams.get("url") || "";
        const proxyUrl = trimmed.startsWith("/") || isSameOrigin ? `${parsed.pathname}${parsed.search}` : trimmed;
        return {
            remoteUrl: isRemoteMediaUrl(sourceUrl) ? sourceUrl : undefined,
            proxyUrl,
        };
    } catch {
        return {};
    }
}

export function shouldFallbackToJsonImageEdit(status: number, message: string) {
    if (status === 404 || status === 405 || status === 415) return true;
    if (status !== 400 && status !== 422) return false;
    return (
        /multipart|form-?data|file upload|prompt.*required|required.*prompt|image url|image file|input image|reference image|invalid image|images\[\]|unsupported|not supported|failed to parse request body|parse request body|invalid request body|request body.*(?:parse|invalid)|body.*(?:parse|invalid)|cannot parse/i.test(
            message,
        ) || isPydanticDictionaryError(message)
    );
}

export function shouldTryNextImageResponseFormat(responseFormat: (typeof IMAGE_RESPONSE_FORMATS)[number], status: number, message: string) {
    if (status !== 400 && status !== 422) return false;
    if (responseFormat === "url") return /response[_ -]?format|url|unsupported|not supported|invalid/i.test(message);
    if (responseFormat === "b64_json") return /response[_ -]?format|b64|base64|unsupported|not supported|invalid/i.test(message);
    return false;
}

/** Explicit admin presets own one request shape; only legacy auto/compatible channels may probe alternatives. */
export function allowsImageProtocolFallback(config: ImageTaskConfig) {
    // A model-level protocol is authoritative even when the parent channel is legacy auto/compatible.
    const protocol = resolveChannelModelConfig(config.advancedConfig, config.model)?.protocol || config.advancedConfig?.protocol;
    return !protocol || protocol === "auto" || protocol === "compatible";
}

export function shouldRetryJsonImageEditPayload(status: number, message: string) {
    if (status !== 400 && status !== 422) return false;
    return (
        /image|images|image_url|input_image|reference|invalid type|unmarshal|deserialize|field|failed to parse request body|parse request body|invalid request body|request body.*(?:parse|invalid)|body.*(?:parse|invalid)|cannot parse/i.test(message) ||
        isPydanticDictionaryError(message)
    );
}

export function isPydanticDictionaryError(message: string) {
    return /valid dictionary|dictionary or object|extract fields/i.test(message);
}

export function shouldFallbackToResponsesImage(status: number, message: string) {
    if (status === 401 || status === 403 || status === 429) return false;
    if (status === 404 || status === 405 || status === 415) return true;
    if (status === 400 || status === 422) return /images\/generations|images\/edits|endpoint|route|not found|not implemented|no such|cannot post|unsupported|not supported/i.test(message);
    return false;
}

export function stringField(record: Record<string, unknown>, key: string) {
    const value = record[key];
    return typeof value === "string" ? value.trim() : "";
}

export function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseGeminiImagePayload(payload: GeminiPayload) {
    if (payload.error?.message) throw new Error(payload.error.message);
    if (payload.promptFeedback?.blockReason) throw new Error(`Gemini 拒绝了本次请求：${payload.promptFeedback.blockReason}`);
    const image = payload.candidates
        ?.flatMap((candidate) => candidate.content?.parts || [])
        .map((part) => {
            const inlineData = part.inlineData || (part.inline_data ? { mimeType: part.inline_data.mimeType || part.inline_data.mime_type, data: part.inline_data.data } : undefined);
            if (inlineData?.data) return `data:${inlineData.mimeType || "image/png"};base64,${inlineData.data}`;
            return part.fileData?.fileUri || "";
        })
        .find(Boolean);
    if (!image) throw new Error("Gemini 接口没有返回图片");
    return image;
}

export function toGeminiImagePart(dataUrl: string, fallbackType?: string): GeminiPart {
    const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
    if (match) return { inlineData: { mimeType: match[1], data: match[2] } };
    return { fileData: { fileUri: dataUrl, mimeType: fallbackType || "image/png" } };
}

export async function buildImageEditFormData(task: ImageTask, quality: string | undefined, requestSize: string | undefined, origin: string, cookie: string, responseFormat: (typeof IMAGE_RESPONSE_FORMATS)[number], includeCompatibilityFields = true) {
    const formData = new FormData();
    formData.set("model", task.config.model);
    formData.set("prompt", withSystemPrompt(task.config, buildImageReferencePromptText(task.prompt, task.references)));
    formData.set("n", "1");
    if (includeCompatibilityFields) {
        formData.set("response_format", responseFormat);
        formData.set("output_format", IMAGE_OUTPUT_FORMAT);
    }
    if (quality) formData.set("quality", quality);
    if (requestSize) formData.set("size", requestSize);
    const referenceFiles = await Promise.all(task.references.map((reference, index) => imageReferenceToFile(reference, reference.name || `reference-${index + 1}.png`, origin, cookie)));
    referenceFiles.forEach((file) => formData.append("image", file));
    if (task.mask) formData.set("mask", await imageReferenceToFile(task.mask, task.mask.name || "mask.png", origin, cookie));
    return formData;
}

export async function imageReferenceToFile(reference: ImageTaskReference, name: string, origin: string, cookie: string) {
    let lastError: unknown;
    for (const value of rawReferenceRequestUrlCandidates(reference)) {
        try {
            if (/^data:image\//i.test(value)) return dataUrlToFile(value, name, reference.type);
            if (/^blob:/i.test(value)) throw new Error("参考图已失效，请重新上传");
            const fetchUrl = value.startsWith("/") ? `${origin}${value}` : value;
            if (!isRemoteMediaUrl(fetchUrl)) throw new Error("参考图地址无效，请重新上传参考图");
            const workerHeaders = maintenanceWorkerContextHeaders(cookie);
            const response = await (value.startsWith("/") ? fetchInternalApi : fetchSafeOutbound)(fetchUrl, {
                headers: value.startsWith("/") ? workerHeaders || (cookie ? { cookie } : undefined) : undefined,
                cache: "no-store",
                signal: AbortSignal.timeout(INLINE_IMAGE_TIMEOUT_MS),
            });
            if (!response.ok || !response.body) throw new Error("参考图读取失败");
            const contentLength = Number(response.headers.get("content-length") || 0);
            if (contentLength > MAX_INLINE_IMAGE_BYTES) throw new Error("参考图过大，请压缩后重试");
            const bytes = Buffer.from(await response.arrayBuffer());
            if (!bytes.length) throw new Error("参考图读取失败");
            if (bytes.length > MAX_INLINE_IMAGE_BYTES) throw new Error("参考图过大，请压缩后重试");
            const mimeType = response.headers.get("content-type")?.split(";", 1)[0] || reference.type || "image/png";
            if (!mimeType.startsWith("image/")) throw new Error("参考图不是有效图片");
            return new File([bytes], name, { type: mimeType });
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError instanceof Error ? lastError : new Error("参考图读取失败");
}

export async function imageReferenceToDataUrl(reference: ImageTaskReference, name: string, origin: string, cookie: string) {
    const inline = rawReferenceRequestUrlCandidates(reference).find((value) => /^data:image\//i.test(value));
    if (inline) return inline;
    const file = await imageReferenceToFile(reference, name, origin, cookie);
    return `data:${file.type || reference.type || "image/png"};base64,${Buffer.from(await file.arrayBuffer()).toString("base64")}`;
}

export function dataUrlToFile(dataUrl: string, name: string, fallbackType?: string) {
    const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
    if (!match) throw new Error("参考图不是有效 base64 图片");
    const bytes = Buffer.from(match[2], "base64");
    if (!bytes.length) throw new Error("参考图读取失败");
    return new File([bytes], name, { type: fallbackType || match[1] || "image/png" });
}

export async function readFetchError(response: Response, fallback: string) {
    const text = await response.text();
    const statusText = `${fallback}，状态码 ${response.status}`;
    if (!text) return statusText;
    if (/^\s*(?:<!doctype\s+html|<html\b)/i.test(text)) {
        const upstreamUrl = response.headers.get("x-vozeb-pro-upstream-url") || "";
        const contentType = response.headers.get("content-type") || "";
        const details = [upstreamUrl ? `地址 ${upstreamUrl}` : "", contentType ? `类型 ${contentType}` : ""].filter(Boolean).join("，");
        return `${fallback}，上游返回了网页错误（HTTP ${response.status}${details ? `，${details}` : ""}），请检查接口路径、鉴权、参考图提交方式或网关状态`;
    }
    try {
        const payload = JSON.parse(text) as { error?: { message?: string }; message?: string; msg?: string };
        return payload.msg || payload.message || payload.error?.message || statusText;
    } catch {
        return text.slice(0, 300) || statusText;
    }
}

export function readPointsRemaining(headers: Headers) {
    const value = headers.get("x-vozeb-pro-points-remaining");
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : undefined;
}

export function readBilling(headers: Headers) {
    const rawCost = headers.get("x-vozeb-pro-points-cost");
    const pointsCost = rawCost === null ? undefined : Number(rawCost);
    return {
        pointsRemaining: readPointsRemaining(headers),
        pointsCost: pointsCost !== undefined && Number.isFinite(pointsCost) && pointsCost >= 0 ? pointsCost : undefined,
        pointsRecordId: headers.get("x-vozeb-pro-points-record-id") || undefined,
    };
}

export async function parseChargedImageResponse(task: ImageTask, response: Response, parse: () => Promise<ImageTaskResult>) {
    try {
        return { ...(await parse()), ...readBilling(response.headers) };
    } catch (error) {
        await refundChargedImageResponse(task, response.headers);
        throw error;
    }
}

export async function refundChargedImageResponse(task: ImageTask, headers: Headers) {
    const { pointsCost, pointsRecordId } = readBilling(headers);
    if (pointsCost === undefined || !pointsRecordId) return;
    const settings = await getAuthSettings();
    await refundUserPoints(task.userId, generationModelId(task.config), pointsCost, "image", imageUnits(task.config.quality, settings.generationPointMultipliers.imageQuality), undefined, pointsRecordId);
}

export function imageUnits(quality: string | undefined, multipliers: Record<string, number>) {
    const key = QUALITY_ALIASES[String(quality || "").toLowerCase()] || String(quality || "auto").toLowerCase();
    return multipliers[key] || 1;
}

export function isRemoteMediaUrl(value: string) {
    return /^https?:\/\//i.test(value);
}

export function normalizeQuality(quality: string) {
    const value = quality.trim().toLowerCase();
    const normalized = QUALITY_ALIASES[value] || value;
    return QUALITY_BASE[normalized] ? normalized : undefined;
}
