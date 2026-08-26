import { after, NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { getAuthSettings, refundUserPoints } from "@/lib/auth/store";
import { buildImageReferencePromptText } from "@/lib/image-reference-prompt";
import { configureServerProxyDispatcher } from "@/lib/server/proxy-dispatcher";
import { fetchInternalApi, isInternalApiBaseUrl, resolveInternalOrigin } from "@/lib/server/internal-origin";
import { resolveGeneratedMediaUrl } from "@/lib/media-url";
import { toSafeGenerationErrorMessage } from "@/lib/server/generation-errors";
import { generationModelId, toSystemGenerationChannel } from "@/lib/server/generation-channel";
import { finishGenerationAttempt, startGenerationAttempt } from "@/lib/server/generation-attempt";
import { resolveLogicalModelCandidates } from "@/lib/server/logical-model-router";
import { assertReferenceCapabilities } from "@/lib/server/provider-task-config";
import { countActiveImageTasksForUser, createImageTask, getImageTask, touchImageTask, transitionImageTask, type ImageTask, type ImageTaskConfig, type ImageTaskReference, updateImageTask } from "@/lib/server/image-task-store";
import { isGenerationSource, recordGenerationLog } from "@/lib/server/generation-log-store";
import { writeReferenceImageDataUrl } from "@/lib/server/reference-asset-store";
import { resolveImageTaskOptions } from "@/lib/server/image-task-config";
import { linkStoredGenerationTask, type GenerationTaskContext } from "@/lib/server/generation-task-store";
import { registerGenerationTaskAssetsForUser } from "@/lib/server/creative-runtime-service";
import { createSignedReferenceAssetUrl, signReferenceAssetInputUrl } from "@/lib/server/reference-asset-access";
import { assertCapabilityConstraints } from "@/lib/server/capability-constraints";
import { GenerationSubmissionSafeFailure, GenerationSubmissionUncertainError } from "@/lib/server/generation-submission-error";

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
    imagePointsIdempotencyKey,
    imageSubmissionFetch,
    imageSubmissionResponseError,
    parseImageSubmissionJson,
    geminiHeaders,
    geminiApiUrl,
    withSystemPrompt,
    withImageOutputInstructions,
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
    imageReferenceToDataUrl,
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

export async function runGeminiImageTask(task: ImageTask, origin: string, cookie: string): Promise<ImageTaskRunResult> {
    const config = task.config;
    const maskInstruction = task.mask ? "\n\n最后一张图片是编辑蒙版：透明区域需要重新生成，白色不透明区域必须保持原图。只补全透明区域，不要把蒙版当作画面内容。" : "";
    const parts: GeminiPart[] = [{ text: withSystemPrompt(config, withImageOutputInstructions(config, buildImageReferencePromptText(task.prompt, task.references) + maskInstruction)) }];
    const [referenceDataUrls, maskDataUrl] = await Promise.all([
        Promise.all(task.references.map((reference, index) => imageReferenceToDataUrl(reference, reference.name || `reference-${index + 1}.png`, origin, cookie))),
        task.mask ? imageReferenceToDataUrl(task.mask, task.mask.name || "mask.png", origin, cookie) : undefined,
    ]);
    referenceDataUrls.forEach((dataUrl, index) => parts.push(toGeminiImagePart(dataUrl, task.references[index]?.type)));
    if (maskDataUrl) parts.push(toGeminiImagePart(maskDataUrl, task.mask?.type));
    const response = await imageSubmissionFetch(config, `${geminiApiUrl(config, "generateContent", origin)}`, {
        method: "POST",
        headers: geminiHeaders(config, cookie, imagePointsIdempotencyKey(task)),
        body: JSON.stringify({
            contents: [{ role: "user", parts }],
            generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
        }),
        cache: "no-store",
    });
    if (!response.ok) throw imageSubmissionResponseError(response.status, await readFetchError(response, "图片生成失败"));
    const payload = await parseImageSubmissionJson<GeminiPayload>(task, response);
    return parseChargedImageResponse(task, response, async () => {
        if (payload.error?.message) throw new GenerationSubmissionSafeFailure(payload.error.message);
        if (payload.promptFeedback?.blockReason) throw new GenerationSubmissionSafeFailure(`Gemini 拒绝了本次请求：${payload.promptFeedback.blockReason}`);
        try {
            return { dataUrl: parseGeminiImagePayload(payload) };
        } catch (error) {
            throw new GenerationSubmissionUncertainError(error instanceof Error ? error.message : "Gemini 没有返回图片，创建结果待确认");
        }
    });
}
