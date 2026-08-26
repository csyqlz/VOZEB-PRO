import axios from "axios";

import { dataUrlToFile } from "@/lib/image-utils";
import { browserReadableMediaUrl } from "@/lib/browser-media-url";
import { resolveGeneratedMediaUrl } from "@/lib/media-url";
import { buildGlobalAiOpcVideoRequest, resolveGlobalAiOpcPreset } from "@/lib/globalaiopc-catalog";
import { getMediaBlob, readStoredMediaFile, uploadGeneratedMediaFile, type UploadedFile } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { refreshUserPointsIfSystem, syncUserPointsFromHeaders } from "@/services/api/points";
import { boolConfig, buildSeedancePromptText, isSeedanceVideoConfig, normalizeSeedanceDuration, normalizeSeedanceRatio, normalizeSeedanceResolution, seedanceVideoReferenceError, SEEDANCE_REFERENCE_LIMITS } from "@/lib/seedance-video";
import { buildApiUrl, modelOptionName, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import { buildSeedanceSpecialRequest } from "@/lib/seedance-special";
import { urlHostHasLabel, urlHostMatches } from "@/lib/url-host";

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
    type AdvancedVideoTemplateContext,
    buildAdvancedVideoTemplatePayloads,
    renderAdvancedTemplateValue,
    templateVariableText,
    alignAdvancedVideoPayload,
    alignSingleReferenceField,
    alignListReferenceField,
    shouldAutoAlignReferenceField,
    uniquePayloads,
    shouldUsePublicVideoReferenceUrls,
    isRecord,
    buildCompatibleVideoMediaPayloads,
    buildGlobalAiOpcVideoMediaPayloads,
    resolveCompatibleImageSources,
    resolvePublicImageSources,
    resolveGlobalAiOpcImageSources,
    resolveGlobalAiOpcMediaReferenceSources,
    compatibleImageSourceCandidates,
    externalPublicImageSourceCandidates,
    publishReferenceImage,
    uniqueStrings,
    normalizeCompatibleVideoDuration,
    normalizeGlobalAiOpcVideoDuration,
    normalizeCompatibleVideoRatio,
    normalizeCompatibleVideoQuality,
    normalizeCompatibleVideoDimensions,
    shouldFallbackToCompatibleVideo,
    shouldRetryCompatibleVideoPayload,
} from "./video-payloads";
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

export async function createOpenAIVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    try {
        const body = new FormData();
        body.append("model", modelOptionName(model));
        body.append("prompt", prompt);
        body.append("seconds", normalizeVideoSeconds(config.videoSeconds));
        if (normalizeVideoSize(config.size)) body.append("size", normalizeVideoSize(config.size)!);
        const resolution = normalizeVideoResolution(config.vquality);
        if (resolution) body.append("resolution_name", resolution);
        body.append("preset", "normal");
        const files = await Promise.all(references.map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
        files.forEach((file) => {
            body.append("input_reference[]", file);
            body.append("input_reference", file);
        });
        const response = await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), body, { headers: aiHeaders(config), signal: options?.signal });
        syncUserPointsFromHeaders(response.headers, config.apiSource);
        const immediateUrl = findMediaUrl(response.data);
        if (immediateUrl) {
            await refreshUserPointsIfSystem(config.apiSource);
            return { id: `direct:${Date.now()}`, provider: "generation", model, pollPath: "/videos", resultUrl: immediateUrl };
        }
        const created = unwrapVideoResponse(response.data);
        if (!created.id) throw new Error("视频接口没有返回任务 ID");
        await refreshUserPointsIfSystem(config.apiSource);
        return { id: created.id, provider: "openai", model };
    } catch (error) {
        const errorMessage = readAxiosError(error, "视频任务创建失败");
        if (config.advancedConfig?.protocol !== "openai" && shouldFallbackToCompatibleVideo(error, errorMessage)) return createCompatibleVideoTask(config, model, prompt, references, options);
        await refreshUserPointsIfSystem(config.apiSource);
        throw new Error(videoCreationError(errorMessage));
    }
}

export async function pollOpenAIVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const statusResponse = await axios.get<ApiVideoResponse>(aiApiUrl(config, `/videos/${task.id}`), { headers: aiHeaders(config), signal: options?.signal });
        const video = unwrapVideoResponse(statusResponse.data);
        if (video.status === "completed") {
            const contentUrl = aiApiUrl(config, `/videos/${task.id}/content`);
            const content = await axios.get<Blob>(contentUrl, { headers: aiHeaders(config), responseType: "blob", signal: options?.signal });
            await assertVideoBlob(content.data);
            return { status: "completed", result: { blob: content.data, remoteUrl: resolveOpenAiContentRemoteUrl(config, contentUrl, readHeader(statusResponse.headers, "x-vozeb-pro-upstream-url")) } };
        }
        if (video.status === "failed" || video.status === "cancelled") return { status: "failed", error: videoStageError(video.error?.message || "视频生成失败") };
        return { status: "pending" };
    } catch (error) {
        throw new Error(videoQueryError(readAxiosError(error, "视频任务查询失败")));
    }
}

export async function createCompatibleVideoTask(
    config: AiConfig,
    model: string,
    prompt: string,
    references: ReferenceImage[],
    options?: RequestOptions,
    videoReferences: ReferenceVideo[] = [],
    audioReferences: ReferenceAudio[] = [],
): Promise<VideoGenerationTask> {
    let lastError = "";
    for (const path of compatibleVideoCreatePaths(config, model)) {
        const payloads = await buildCompatibleVideoPayloadVariants(config, model, prompt, references, path, videoReferences, audioReferences);
        for (const payload of payloads) {
            try {
                const response = await axios.post<ApiEnvelope<Record<string, unknown>>>(aiApiUrl(config, path), payload, { headers: aiHeaders(config, "application/json"), signal: options?.signal });
                syncUserPointsFromHeaders(response.headers, config.apiSource);
                const created = unwrapEnvelope(response.data, "视频接口没有返回任务") as Record<string, unknown>;
                if (references.length && readTaskMode(created) === "t2v") {
                    lastError = "video task was created without accepting reference images";
                    continue;
                }
                const id = readTaskId(created);
                const immediateUrl = readConfiguredMediaUrl(config, created) || findMediaUrl(created);
                if (immediateUrl) {
                    await refreshUserPointsIfSystem(config.apiSource);
                    return { id: id || `direct:${Date.now()}`, provider: "generation", model, pollPath: path, resultUrl: immediateUrl };
                }
                if (!id) throw new Error("视频接口没有返回任务 ID");
                await refreshUserPointsIfSystem(config.apiSource);
                return { id, provider: "generation", model, pollPath: path };
            } catch (error) {
                const message = readAxiosError(error, "视频任务创建失败");
                lastError = message;
                if (shouldFallbackToCompatibleVideo(error, message)) break;
                if (shouldRetryCompatibleVideoPayload(error, message)) continue;
                await refreshUserPointsIfSystem(config.apiSource);
                throw new Error(videoCreationError(message));
            }
        }
    }
    await refreshUserPointsIfSystem(config.apiSource);
    throw new Error(videoCreationError(lastError || "视频任务创建失败"));
}

export function compatibleVideoCreatePaths(config: AiConfig, model: string) {
    const globalPreset = globalAiOpcVideoPreset(config, model);
    if (globalPreset) return [globalPreset.createPath];
    const configuredPath = normalizeAdvancedVideoPath(config.advancedConfig?.createPath);
    if (config.advancedConfig?.protocol === "yumeng") return configuredPath ? [configuredPath] : [];
    const defaultPaths = isGlobalAiOpcVideoConfig(config, model) ? [GLOBAL_AIOPC_VIDEO_CREATE_PATH, ...VIDEO_CREATE_PATHS.filter((path) => path !== GLOBAL_AIOPC_VIDEO_CREATE_PATH)] : VIDEO_CREATE_PATHS;
    return uniqueStrings([configuredPath, ...defaultPaths]);
}

export function isGlobalAiOpcVideoConfig(config: AiConfig, model: string) {
    if (config.advancedConfig?.protocol === "yumeng") return false;
    if (config.advancedConfig?.protocol === "globalaiopc") return true;
    if (normalizeAdvancedVideoPath(config.advancedConfig?.createPath).toLowerCase().endsWith(GLOBAL_AIOPC_VIDEO_CREATE_PATH)) return true;
    const modelName = modelOptionName(model).toLowerCase();
    return urlHostMatches(config.baseUrl, "globalaiopc.com") || urlHostMatches(config.baseUrl, "aizfw.cn") || urlHostHasLabel(config.baseUrl, "kyyreactapiserver") || ["videos", "videos_stable", "videos_stable_fast"].includes(modelName);
}

export async function pollCompatibleVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    const requestUrls = compatibleVideoPollUrls(config, task);
    let lastError = "";
    for (const requestUrl of requestUrls) {
        try {
            const response = await axios.get<ApiEnvelope<Record<string, unknown>>>(requestUrl, { headers: aiHeaders(config), signal: options?.signal });
            const state = unwrapEnvelope(response.data, "视频接口没有返回任务") as Record<string, unknown>;
            const status = readConfiguredTaskStatus(config, state) || readTaskStatus(state);
            const videoUrl = readConfiguredMediaUrl(config, state) || findMediaUrl(state);
            if (videoUrl && (!status || isCompletedStatus(status) || !isPendingStatus(status))) {
                const resolvedUrl = resolveVideoMediaUrl(config, videoUrl, readHeader(response.headers, "x-vozeb-pro-upstream-url") || requestUrl);
                return { status: "completed", result: await videoResultFromUrl(resolvedUrl, options) };
            }
            if (isCompletedStatus(status)) return { status: "failed", error: videoStageError("视频任务完成但没有返回视频地址") };
            if (isFailedStatus(status)) return { status: "failed", error: videoStageError(readTaskError(state) || "视频生成失败") };
            return { status: "pending" };
        } catch (error) {
            const message = readAxiosError(error, "视频任务查询失败");
            lastError = message;
            if (!shouldFallbackToCompatibleVideo(error, message)) throw new Error(videoQueryError(message));
        }
    }
    throw new Error(videoQueryError(lastError || "视频任务查询失败"));
}

export function compatibleVideoPollUrls(config: AiConfig, task: VideoGenerationTask) {
    return compatibleVideoPollPaths(config, task).map((path) => aiApiUrl(config, applyTaskIdToVideoPath(path, task.id)));
}

export function compatibleVideoPollPaths(config: AiConfig, task: VideoGenerationTask) {
    const globalPreset = globalAiOpcVideoPreset(config, config.model);
    if (globalPreset?.queryPath) return [globalPreset.queryPath];
    const configuredPath = normalizeAdvancedVideoPath(config.advancedConfig?.queryPath);
    if (config.advancedConfig?.protocol === "yumeng") return configuredPath ? [configuredPath] : [];
    const paths = task.pollPath === GLOBAL_AIOPC_VIDEO_CREATE_PATH ? [configuredPath, GLOBAL_AIOPC_VIDEO_RESULT_PATH, task.pollPath, ...VIDEO_CREATE_PATHS] : [configuredPath, task.pollPath || VIDEO_CREATE_PATHS[0], ...VIDEO_CREATE_PATHS];
    return uniqueStrings(paths);
}

export function applyTaskIdToVideoPath(path: string, taskId: string) {
    const encodedTaskId = encodeURIComponent(taskId);
    const templated = path.replace(/\{(?:task_id|taskId|id)\}/g, encodedTaskId).replace(/:(?:task_id|taskId|id)\b/g, encodedTaskId);
    if (templated !== path) return templated;
    return `${path.replace(/\/+$/, "")}/${encodedTaskId}`;
}

export function normalizeAdvancedVideoPath(value?: string) {
    const path = (value || "").trim();
    if (!path) return "";
    return path.startsWith("/") ? path : `/${path}`;
}

export async function createSeedanceTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions): Promise<VideoGenerationTask> {
    if (audioReferences.length && !references.length && !videoReferences.length) {
        throw new Error("Seedance 参考音频不能单独使用，请同时添加参考图或参考视频");
    }
    assertSeedanceVideoReferences(videoReferences);
    assertSeedanceAudioReferences(audioReferences);
    const content = await buildSeedanceContent(prompt, references, videoReferences, audioReferences);
    if (!content.length) throw new Error("请输入视频提示词，或连接参考图片/视频/音频");
    const payload = {
        model: modelOptionName(model),
        content,
        ratio: normalizeSeedanceRatio(config.size),
        resolution: normalizeSeedanceResolution(config.vquality, modelOptionName(model)),
        duration: normalizeSeedanceDuration(config.videoSeconds),
        generate_audio: boolConfig(config.videoGenerateAudio, true),
        watermark: boolConfig(config.videoWatermark, false),
    };

    try {
        const response = await axios.post<ApiEnvelope<SeedanceTask>>(seedanceApiUrl(config), payload, { headers: aiHeaders(config, "application/json"), signal: options?.signal });
        syncUserPointsFromHeaders(response.headers, config.apiSource);
        const created = unwrapSeedanceTask(response.data);
        if (!created.id) throw new Error("Seedance 接口没有返回任务 ID");
        await refreshUserPointsIfSystem(config.apiSource);
        return { id: created.id, provider: "seedance", model };
    } catch (error) {
        await refreshUserPointsIfSystem(config.apiSource);
        throw new Error(videoCreationError(readAxiosError(error, "Seedance 任务创建失败")));
    }
}

export async function createSeedanceSpecialTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions): Promise<VideoGenerationTask> {
    assertSeedanceVideoReferences(videoReferences);
    assertSeedanceAudioReferences(audioReferences);
    const createPath = config.advancedConfig?.createPath || "/v1/seedance-special/videos";
    const duration = normalizeSeedanceDuration(config.videoSeconds);
    const payload = buildSeedanceSpecialRequest({
        model: modelOptionName(model),
        prompt,
        ratio: normalizeSeedanceRatio(config.size),
        duration: duration === -1 ? 5 : duration,
        generateAudio: boolConfig(config.videoGenerateAudio, true),
        references: {
            images: await Promise.all(references.map(resolveSeedanceImageUrl)),
            videos: await Promise.all(videoReferences.map(resolveSeedanceVideoUrl)),
            audios: await Promise.all(audioReferences.map(resolveSeedanceAudioUrl)),
        },
    });
    try {
        const response = await axios.post<ApiEnvelope<Record<string, unknown>>>(aiApiUrl(config, createPath), payload, { headers: aiHeaders(config, "application/json"), signal: options?.signal });
        syncUserPointsFromHeaders(response.headers, config.apiSource);
        const created = unwrapEnvelope(response.data, "Seedance 特价版接口没有返回任务") as Record<string, unknown>;
        const id = readTaskId(created);
        if (!id) throw new Error("Seedance 特价版接口没有返回任务 ID");
        await refreshUserPointsIfSystem(config.apiSource);
        return { id, provider: "generation", model, pollPath: createPath };
    } catch (error) {
        await refreshUserPointsIfSystem(config.apiSource);
        throw new Error(videoCreationError(readAxiosError(error, "Seedance 特价版任务创建失败")));
    }
}

export async function pollSeedanceTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const requestUrl = seedanceApiUrl(config, task.id);
        const response = await axios.get<ApiEnvelope<SeedanceTask>>(requestUrl, { headers: aiHeaders(config), signal: options?.signal });
        const state = unwrapSeedanceTask(response.data);
        if (state.status === "succeeded") {
            const url = state.content?.video_url ? resolveVideoMediaUrl(config, state.content.video_url, readHeader(response.headers, "x-vozeb-pro-upstream-url") || requestUrl) : "";
            if (!url) return { status: "failed", error: videoStageError("Seedance 任务成功但没有返回视频 URL") };
            return { status: "completed", result: await videoResultFromUrl(url, options) };
        }
        if (state.status === "failed" || state.status === "cancelled" || state.status === "expired") return { status: "failed", error: videoStageError(state.error?.message || `Seedance 视频生成${state.status === "expired" ? "超时" : "失败"}`) };
        return { status: "pending" };
    } catch (error) {
        throw new Error(videoQueryError(readAxiosError(error, "Seedance 任务查询失败")));
    }
}

export function assertSeedanceVideoReferences(videoReferences: ReferenceVideo[]) {
    const error = seedanceVideoReferenceError(videoReferences);
    if (error) throw new Error(error);
    let total = 0;
    for (const video of videoReferences) {
        if (!video.durationMs) continue;
        if (video.durationMs < 2000 || video.durationMs > 15000) throw new Error("Seedance 参考视频单个时长需要在 2-15 秒之间");
        total += video.durationMs;
    }
    if (total > 15000) throw new Error("Seedance 参考视频总时长不能超过 15 秒");
}

export function assertSeedanceAudioReferences(audioReferences: ReferenceAudio[]) {
    let total = 0;
    for (const audio of audioReferences) {
        if (!audio.durationMs) continue;
        if (audio.durationMs < 2000 || audio.durationMs > 15000) throw new Error("Seedance 参考音频单个时长需要在 2-15 秒之间");
        total += audio.durationMs;
    }
    if (total > 15000) throw new Error("Seedance 参考音频总时长不能超过 15 秒");
}

export function seedanceApiUrl(config: AiConfig, taskId?: string) {
    return buildApiUrl(config.baseUrl, `/contents/generations/tasks${taskId ? `/${encodeURIComponent(taskId)}` : ""}`);
}

export async function buildCompatibleVideoPayloadVariants(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], path: string, videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = []) {
    const globalPreset = globalAiOpcVideoPreset(config, model);
    const legacyGlobalAiOpc = !globalPreset && path === GLOBAL_AIOPC_VIDEO_CREATE_PATH;
    const publicUrlReferenceMode = Boolean(globalPreset) || shouldUsePublicVideoReferenceUrls(config, path);
    const imageSources = await Promise.all(
        references.map((reference) => (globalPreset || legacyGlobalAiOpc ? Promise.resolve(resolveGlobalAiOpcImageSources(reference)) : publicUrlReferenceMode ? resolvePublicImageSources(reference) : resolveCompatibleImageSources(reference))),
    );
    const images = uniqueStrings(imageSources.flat());
    if ((globalPreset || legacyGlobalAiOpc) && references.length && !images.length) {
        throw new Error("当前渠道无法读取这张参考图，请重新上传或更换渠道");
    }
    if (!globalPreset && !legacyGlobalAiOpc && publicUrlReferenceMode && references.length && !images.length) {
        throw new Error("\u53c2\u8003\u56fe\u9700\u8981\u516c\u7f51\u56fe\u7247 URL\uff1b\u672c\u5730\u5f00\u53d1 localhost \u4e0d\u80fd\u76f4\u63a5\u63d0\u4ea4\u7ed9\u4e0a\u6e38\uff0c\u8bf7\u90e8\u7f72\u540e\u914d\u7f6e NEXT_PUBLIC_SITE_URL");
    }
    const publicReferenceVideos = uniqueStrings(videoReferences.flatMap(resolveGlobalAiOpcMediaReferenceSources));
    const publicReferenceAudios = uniqueStrings(audioReferences.flatMap(resolveGlobalAiOpcMediaReferenceSources));
    const referenceVideos = globalPreset || legacyGlobalAiOpc ? publicReferenceVideos : [];
    const referenceAudios = globalPreset || legacyGlobalAiOpc ? publicReferenceAudios : [];
    if ((globalPreset || legacyGlobalAiOpc) && videoReferences.length && !referenceVideos.length) {
        throw new Error("当前渠道无法读取这个参考视频，请重新上传或更换渠道");
    }
    if ((globalPreset || legacyGlobalAiOpc) && audioReferences.length && !referenceAudios.length) {
        throw new Error("当前渠道无法读取这个参考音频，请重新上传或更换渠道");
    }
    const duration =
        globalPreset || legacyGlobalAiOpc ? normalizeGlobalAiOpcVideoDuration(config.videoSeconds) : config.advancedConfig?.protocol === "yumeng" ? normalizeYumengVideoDuration(config.videoSeconds) : normalizeCompatibleVideoDuration(config.videoSeconds);
    const ratio = normalizeCompatibleVideoRatio(config.size);
    const quality = normalizeCompatibleVideoQuality(config.vquality);
    const resolution = normalizeVideoResolution(config.vquality);
    const size = normalizeVideoSize(config.size) || undefined;
    const dimensions = normalizeCompatibleVideoDimensions(config.size);
    if (globalPreset) {
        return [
            buildGlobalAiOpcVideoRequest(globalPreset, {
                model: modelOptionName(model),
                prompt,
                duration,
                ratio,
                resolution,
                images,
                videos: referenceVideos,
                audios: referenceAudios,
                generateAudio: boolConfig(config.videoGenerateAudio, true),
            }),
        ];
    }
    const mediaPayloads = path === GLOBAL_AIOPC_VIDEO_CREATE_PATH ? buildGlobalAiOpcVideoMediaPayloads(images) : buildCompatibleVideoMediaPayloads(images);
    const templatePayloads = buildAdvancedVideoTemplatePayloads(config, model, prompt, {
        duration,
        ratio,
        resolution,
        quality,
        size,
        width: dimensions.width,
        height: dimensions.height,
        images,
        referenceVideos: publicReferenceVideos,
        referenceAudios: publicReferenceAudios,
    });
    if (config.advancedConfig?.protocol === "yumeng") return templatePayloads;
    if (path === GLOBAL_AIOPC_VIDEO_CREATE_PATH) {
        const payloads = mediaPayloads.map((mediaPayload) => ({
            model: modelOptionName(model),
            prompt,
            duration,
            ratio,
            resolution,
            autoFace: false,
            ...(referenceVideos.length ? { referenceVideos } : {}),
            ...(referenceAudios.length ? { referenceAudios } : {}),
            ...mediaPayload,
        }));
        return uniquePayloads([...templatePayloads, ...payloads]);
    }
    const base = {
        model: modelOptionName(model),
        prompt,
        n: 1,
        ...(size ? { size } : {}),
        ...(dimensions.width && dimensions.height ? { width: dimensions.width, height: dimensions.height } : {}),
        response_format: "url",
        ...(ratio ? { ratio, aspect_ratio: ratio } : {}),
        ...(resolution ? { resolution } : {}),
        ...(quality ? { quality } : {}),
        async: true,
        generate_audio: boolConfig(config.videoGenerateAudio, true),
        watermark: boolConfig(config.videoWatermark, false),
    };
    const payloads = mediaPayloads.flatMap((mediaPayload) => [
        { ...base, ...mediaPayload, duration },
        { ...base, ...mediaPayload, seconds: String(duration), duration },
        { ...base, ...mediaPayload, seconds: String(duration) },
    ]);
    return uniquePayloads([...templatePayloads, ...payloads]);
}

function normalizeYumengVideoDuration(value: string) {
    const seconds = Math.floor(Number(value) || 4);
    return Math.max(4, Math.min(15, seconds));
}

function globalAiOpcVideoPreset(config: AiConfig, model: string) {
    const preset = resolveGlobalAiOpcPreset(config.advancedConfig, modelOptionName(model));
    return preset?.capability === "video" ? preset : undefined;
}
