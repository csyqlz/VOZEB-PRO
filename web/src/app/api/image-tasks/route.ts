import { requestPublicOrigin } from "./image-task-reference-urls";
import { after, NextResponse } from "next/server";

import { readJsonBody } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { getAuthSettings, isAuthInputError, refundUserPoints } from "@/lib/auth/store";
import { buildImageReferencePromptText } from "@/lib/image-reference-prompt";
import { configureServerProxyDispatcher } from "@/lib/server/proxy-dispatcher";
import { fetchInternalApi, isInternalApiBaseUrl, resolveInternalOrigin } from "@/lib/server/internal-origin";
import { resolveGeneratedMediaUrl } from "@/lib/media-url";
import { toSafeGenerationErrorMessage } from "@/lib/server/generation-errors";
import { generationModelId, toSystemGenerationChannel } from "@/lib/server/generation-channel";
import { finishGenerationAttempt, startGenerationAttempt } from "@/lib/server/generation-attempt";
import { resolveLogicalModelCandidates } from "@/lib/server/logical-model-router";
import { assertReferenceCapabilities } from "@/lib/server/provider-task-config";
import { createImageTask, getImageTask, touchImageTask, transitionImageTask, type ImageTask, type ImageTaskConfig, type ImageTaskReference, updateImageTask } from "@/lib/server/image-task-store";
import { isGenerationSource, recordGenerationLog } from "@/lib/server/generation-log-store";
import { writeReferenceImageDataUrl } from "@/lib/server/reference-asset-store";
import { resolveImageTaskOptions } from "@/lib/server/image-task-config";
import { generationCapacityRetryAfterSeconds, getStoredGenerationTaskByRequest, linkStoredGenerationTask, withGenerationConcurrencyLimit, type GenerationTaskContext } from "@/lib/server/generation-task-store";
import { verifyCanvasImageLayerGrant } from "@/lib/server/canvas-image-layer-grant";
import { registerGenerationTaskAssetsForUser } from "@/lib/server/creative-runtime-service";
import { createSignedReferenceAssetUrl, signReferenceAssetInputUrl } from "@/lib/server/reference-asset-access";
import { assertCapabilityConstraints } from "@/lib/server/capability-constraints";
import { checkGenerationRateLimit, rateLimitHeaders } from "@/lib/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2400;

configureServerProxyDispatcher();

import {
    type CreateImageTaskBody,
    type ImageApiResponse,
    type ImageTaskResult,
    type ImageTaskRunResult,
    type GeminiPart,
    type GeminiPayload,
    QUALITY_BASE,
    QUALITY_ALIASES,
    DEFAULT_IMAGE_SHORT_SIDE,
    IMAGE_SIZE_STEP,
    IMAGE_MIN_PIXELS,
    IMAGE_OUTPUT_FORMAT,
    TASK_HEARTBEAT_MS,
    MODEL_REQUEST_TIMEOUT_MS,
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
import { runGenerationTaskRecoveryBatch } from "@/lib/server/generation-task-recovery-service";
import { scheduleGenerationTask } from "@/lib/server/generation-task-scheduler";
import {
    publicTask,
    sanitizeConfigs,
    sanitizeAdvancedConfig,
    textOrEmpty,
    preferredImageResponseFormat,
    openAiImageTaskPath,
    shouldUseJsonImageEdit,
    configuredImageEditReferenceMode,
    resolveConfiguredApiBaseUrl,
    readSystemChannelId,
    shouldUseSub2ApiImageEdit,
    isCode2AlitaApiBase,
    matchesApiHost,
    taskUrl,
    normalizeApiBaseUrl,
    isInternalSystemProxyBase,
    taskHeaders,
    taskFetch,
    geminiHeaders,
    geminiApiUrl,
    withSystemPrompt,
    parseImagePayloadOrPoll,
    pollOpenAiImageTask,
    parseImagePayloadCompat,
    findImageResult,
    resolveImageUrlLike,
    resolveImageBase64Like,
    isLikelyImageUrl,
    readImagePayloadError,
    readImageTaskId,
    readImageTaskStatus,
    readImagePollUrl,
    findStringByKeys,
    isPendingImageStatus,
    imageTaskPollUrls,
    resolveTaskMediaUrl,
    shouldRetryInternalImageUrlAsBase64,
    isInternalGeneratedImageUrl,
    inlineRemoteImageResult,
    directRemoteImageResult,
    resolveProxiedMediaSource,
    shouldFallbackToJsonImageEdit,
    shouldTryNextImageResponseFormat,
    shouldRetryJsonImageEditPayload,
    shouldFallbackToResponsesImage,
    stringField,
    delay,
    parseGeminiImagePayload,
    toGeminiImagePart,
    buildImageEditFormData,
    imageReferenceToFile,
    dataUrlToFile,
    readFetchError,
    readPointsRemaining,
    readBilling,
    parseChargedImageResponse,
    refundChargedImageResponse,
    imageUnits,
    isRemoteMediaUrl,
    normalizeQuality,
    resolveRequestSize,
    resolveSize,
    parseImageRatio,
    parseImageDimensions,
    validateImageSize,
} from "./image-task-support";

export async function POST(request: Request) {
    const currentUser = await getCurrentUser(request);
    if (!currentUser) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    const headerRequestId = request.headers.get("x-vozeb-pro-client-request-id")?.trim();
    const headerAttemptNo = positiveAttemptNo(request.headers.get("x-vozeb-pro-attempt-no"));
    if (headerRequestId) {
        const existing = await getStoredGenerationTaskByRequest<ImageTask>("image", currentUser.id, headerRequestId, headerAttemptNo);
        if (existing) return NextResponse.json({ task: publicTask(existing) });
    }
    const rate = await checkGenerationRateLimit(currentUser.id, request, "image");
    if (!rate.allowed) return NextResponse.json({ error: "生图请求过于频繁，请稍后重试" }, { status: 429, headers: rateLimitHeaders(rate) });
    let resolvedBody: CreateImageTaskBody;
    try {
        resolvedBody = await readJsonBody(request, 32 * 1024 * 1024);
    } catch (error) {
        if (isAuthInputError(error)) return NextResponse.json({ error: error.message }, { status: error.status });
        throw error;
    }
    const requestId = headerRequestId || resolvedBody.context?.clientRequestId?.trim();
    if (!headerRequestId && requestId) {
        const existing = await getStoredGenerationTaskByRequest<ImageTask>("image", currentUser.id, requestId, resolvedBody.context?.attemptNo);
        if (existing) return NextResponse.json({ task: publicTask(existing) });
    }
    const layerGrant = resolveCanvasLayerGrant(resolvedBody, currentUser.id);
    if (resolvedBody.layerBatch && !layerGrant) return NextResponse.json({ error: "图片分层批次凭证无效，请重新发起分层" }, { status: 400 });
    const concurrencyRequestId = layerGrant?.requestId || requestId || `image-request:${currentUser.id}:${crypto.randomUUID()}`;
    resolvedBody.context = {
        ...(resolvedBody.context || {}),
        clientRequestId: concurrencyRequestId,
        ...(headerAttemptNo ? { attemptNo: headerAttemptNo } : {}),
        ...(layerGrant ? { concurrencyClass: "canvas-layer" as const } : {}),
    };
    const settings = await getAuthSettings();
    const createTask = async () => {
        const configs = sanitizeConfigs(resolvedBody.config, settings);
        const prompt = (resolvedBody.prompt || "").trim();
        const kind = resolvedBody.kind === "edit" ? "edit" : "generation";
        if (!configs.length || !prompt) return NextResponse.json({ error: "任务参数不完整" }, { status: 400 });
        const references = Array.isArray(resolvedBody.references) ? resolvedBody.references.filter((item) => Boolean(item?.dataUrl || item?.url || item?.remoteUrl || item?.serverUrl)) : [];
        const constrainedConfigs = configs.filter((config) => {
            try {
                assertCapabilityConstraints(config.capabilityProfile, {
                    capability: "image",
                    referenceCount: references.length,
                    aspectRatio: config.size,
                    resolution: config.quality,
                });
                return true;
            } catch {
                return false;
            }
        });
        const compatibleConfigs = constrainedConfigs.filter((config) => {
            try {
                assertReferenceCapabilities(config.advancedConfig, [...references.map(() => ({ type: "image" })), ...(resolvedBody.mask ? [{ type: "image" }] : [])]);
                return true;
            } catch {
                return false;
            }
        });
        if (!compatibleConfigs.length) return NextResponse.json({ error: "当前模型能力不满足参考素材、比例或分辨率参数" }, { status: 400 });
        const config = compatibleConfigs[0];
        if (config.outputMode === "layers" && (kind !== "edit" || references.length !== 1)) {
            return NextResponse.json({ error: "电商分层需要且只能使用一张源图" }, { status: 400 });
        }
        const task = await createImageTask({
            ...(resolvedBody.context || {}),
            userId: currentUser.id,
            username: currentUser.username,
            displayName: currentUser.displayName,
            kind,
            source: isGenerationSource(resolvedBody.source) ? resolvedBody.source : "image-workbench",
            title: typeof resolvedBody.title === "string" ? resolvedBody.title : "",
            config,
            candidateConfigs: compatibleConfigs.slice(1),
            prompt,
            references,
            mask: resolvedBody.mask?.dataUrl || resolvedBody.mask?.url || resolvedBody.mask?.remoteUrl || resolvedBody.mask?.serverUrl ? resolvedBody.mask : undefined,
        });
        await linkStoredGenerationTask("image", task.id, resolvedBody.context || {});
        const cookie = request.headers.get("cookie") || "";
        const origin = resolveInternalOrigin(new URL(request.url).origin);
        const publicOrigin = requestPublicOrigin(request);
        await scheduleGenerationTask("image", task.id, { executionPhase: "created", channelId: task.config.channelId, provider: task.config.advancedConfig?.protocol || task.config.apiFormat, nextPollAt: Date.now(), lastUpstreamStatus: "created" });
        after(() => runGenerationTaskRecoveryBatch({ origin, publicOrigin, cookie, limit: 1, taskIds: [task.id] }));

        return NextResponse.json({ task: publicTask(task) });
    };
    const response = layerGrant ? await createTask() : await withGenerationConcurrencyLimit(currentUser.id, "image", 10 * 60 * 1000, settings.generationConcurrency.image, createTask, undefined, concurrencyRequestId);
    if (response) return response;
    const retryAfter = await generationCapacityRetryAfterSeconds(currentUser.id, "image", 10 * 60 * 1000);
    return NextResponse.json({ error: "当前用户生图任务已达到并发上限，请稍后再试" }, { status: 429, ...(retryAfter ? { headers: { "Retry-After": String(retryAfter) } } : {}) });
}

function resolveCanvasLayerGrant(body: CreateImageTaskBody, userId: string) {
    if (body.source !== "canvas" || body.kind !== "edit" || body.context?.surface !== "canvas" || !Array.isArray(body.references) || body.references.length !== 1) return null;
    const sourceCandidates = [body.references[0]?.serverUrl, body.references[0]?.url, body.references[0]?.remoteUrl, body.references[0]?.dataUrl].filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
    for (const source of sourceCandidates) {
        const verified = verifyCanvasImageLayerGrant({ userId, source, batch: body.layerBatch, outputBackground: body.config?.outputBackground });
        if (verified) return verified;
    }
    return null;
}

function positiveAttemptNo(value: string | null) {
    const parsed = Math.floor(Number(value));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
