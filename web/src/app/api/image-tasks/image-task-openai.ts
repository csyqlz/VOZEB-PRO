import { after, NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { getAuthSettings, refundUserPoints } from "@/lib/auth/store";
import { normalizeImageEditRegion } from "@/lib/image-edit-region";
import { buildImageReferencePromptText } from "@/lib/image-reference-prompt";
import { configureServerProxyDispatcher } from "@/lib/server/proxy-dispatcher";
import { fetchInternalApi, isInternalApiBaseUrl, resolveInternalOrigin } from "@/lib/server/internal-origin";
import { resolveGeneratedMediaUrl } from "@/lib/media-url";
import { buildGlobalAiOpcImageRequest } from "@/lib/globalaiopc-catalog";
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
import { GenerationSubmissionSafeFailure } from "@/lib/server/generation-submission-error";
import { ecommerceCanvasSize } from "@/lib/server/ecommerce-edit-plan";
import { EcommerceCanvasAdapterReview, recordEcommerceCanvasRequest, resolveCanvasRequestSize } from "./image-task-size";

import { runNativeSub2ApiImageSubmission } from "./image-task-memory";
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
    isNativeSub2ApiImageEdit,
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
    shouldFallbackToJsonImageEdit,
    shouldTryNextImageResponseFormat,
    shouldRetryJsonImageEditPayload,
    shouldFallbackToResponsesImage,
    allowsImageProtocolFallback,
    assertStrictProductProviderTask,
    stringField,
    delay,
    parseGeminiImagePayload,
    toGeminiImagePart,
    buildImageEditFormData,
    imageReferenceToDataUrl,
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
    imageRequestAspectRatio,
    resolveSize,
    parseImageRatio,
    parseImageDimensions,
    validateImageSize,
    globalAiOpcImagePreset,
} from "./image-task-support";

export async function runOpenAiImageTask(task: ImageTask, origin: string, publicOrigin: string, cookie: string, singleStep = false): Promise<ImageTaskRunResult> {
    assertStrictProductProviderTask(task, "openai");
    const config = task.config;
    const quality = normalizeQuality(config.quality || "");
    const requestSize = resolveCanvasRequestSize(task, quality);
    const globalPreset = globalAiOpcImagePreset(config);
    if (globalPreset) return runGlobalAiOpcImageTask(task, origin, publicOrigin, cookie, quality, requestSize, singleStep);
    const path = await openAiImageTaskPath(config, task.kind);
    const url = taskUrl(config, path, origin);
    const headers = taskHeaders(config, cookie, imagePointsIdempotencyKey(task));
    const responseFormat = await preferredImageResponseFormat(config);
    const allowProtocolFallback = !task.productProtection && !task.sceneProtection && !task.ecommerceExecution?.canvas && allowsImageProtocolFallback(config);
    const useJsonImageEdit = task.kind === "edit" && (await shouldUseJsonImageEdit(config));
    if (useJsonImageEdit) return runOpenAiJsonImageEditTask(task, url, origin, publicOrigin, quality, requestSize, cookie, responseFormat, singleStep);
    let response: Response;

    if (task.kind === "edit") {
        let formData: FormData;
        try {
            formData = await buildImageEditFormData(task, quality, requestSize, origin, cookie, "url", allowProtocolFallback);
        } catch (error) {
            throw new GenerationSubmissionSafeFailure(error instanceof Error ? error.message : "参考图读取失败，请重新上传参考图");
        }
        await recordEcommerceCanvasRequest(task, { size: String(formData.get("size") || "") }, "OpenAI multipart");
        response = await imageSubmissionFetch(config, url, { method: "POST", headers, body: formData, cache: "no-store" });
        if (!response.ok) {
            const message = await readFetchError(response, "图片生成失败");
            if (allowProtocolFallback && shouldFallbackToJsonImageEdit(response.status, message)) return runOpenAiJsonImageEditTask(task, url, origin, publicOrigin, quality, requestSize, cookie, "url", singleStep, "json-edit");
            if (allowProtocolFallback && shouldTryNextImageResponseFormat("url", response.status, message)) return runOpenAiImageTaskWithBase64Response(task, origin, publicOrigin, cookie, singleStep, "base64");
            if (allowProtocolFallback && shouldFallbackToResponsesImage(response.status, message)) return runOpenAiResponsesImageTask(task, origin, cookie, singleStep, "responses");
            throw imageSubmissionResponseError(response.status, message);
        }
    } else {
        await recordEcommerceCanvasRequest(task, { size: requestSize }, "OpenAI JSON");
        headers.set("content-type", "application/json");
        response = await imageSubmissionFetch(config, url, {
            method: "POST",
            headers,
            body: JSON.stringify({
                model: config.model,
                prompt: withSystemPrompt(config, withImageOutputInstructions(config, task.prompt)),
                ...(config.outputMode === "layers" ? {} : { n: 1 }),
                ...(quality ? { quality } : {}),
                ...(requestSize ? { size: requestSize } : {}),
                ...(allowProtocolFallback ? { response_format: responseFormat, output_format: IMAGE_OUTPUT_FORMAT } : {}),
            }),
            cache: "no-store",
        });
        if (!response.ok) {
            const message = await readFetchError(response, "图片生成失败");
            if (allowProtocolFallback && shouldTryNextImageResponseFormat(responseFormat, response.status, message)) return runOpenAiImageTaskWithBase64Response(task, origin, publicOrigin, cookie, singleStep, "base64");
            if (allowProtocolFallback && shouldFallbackToResponsesImage(response.status, message)) return runOpenAiResponsesImageTask(task, origin, cookie, singleStep, "responses");
            throw imageSubmissionResponseError(response.status, message);
        }
    }

    if (!response.ok) throw imageSubmissionResponseError(response.status, await readFetchError(response, "图片生成失败"));
    const payload = await parseImageSubmissionJson<ImageApiResponse>(task, response);
    const resultBaseUrl = response.headers.get("x-vozeb-pro-upstream-url") || url;
    const result = await parseChargedImageResponse(task, response, () => parseImagePayloadOrPoll(config, payload, resultBaseUrl, cookie, url, singleStep));
    if (allowProtocolFallback && responseFormat === "url" && shouldRetryInternalImageUrlAsBase64(result)) {
        await refundChargedImageResponse(task, response.headers);
        return runOpenAiImageTaskWithBase64Response(task, origin, publicOrigin, cookie, singleStep, "base64");
    }
    return result;
}

async function runGlobalAiOpcImageTask(task: ImageTask, origin: string, publicOrigin: string, cookie: string, quality: string | undefined, requestSize: string | undefined, singleStep: boolean): Promise<ImageTaskRunResult> {
    const config = task.config;
    const preset = globalAiOpcImagePreset(config);
    if (!preset) throw new GenerationSubmissionSafeFailure("GlobalAiOpc 图片预设未配置");
    const path = preset.createPath;
    const url = taskUrl(config, path, origin);
    const headers = taskHeaders(config, cookie, imagePointsIdempotencyKey(task));
    headers.set("content-type", "application/json");
    const referenceContext = { ownerUserId: task.userId, taskId: task.id };
    const imageUrls = (await Promise.all(task.references.map((reference) => publicImageReferenceRequestUrl(reference, origin, publicOrigin, referenceContext)))).filter(Boolean);
    const ratio = task.ecommerceExecution?.canvas ? ecommerceCanvasSize({ ...task.ecommerceExecution.canvas, mode: "ratio" }) : imageRequestAspectRatio(config.size || "");
    const body: Record<string, unknown> = {
        ...buildGlobalAiOpcImageRequest(preset, {
            model: config.model,
            prompt: withSystemPrompt(config, withImageOutputInstructions(config, buildImageReferencePromptText(task.prompt, task.references))),
            quality,
            size: requestSize,
            ratio,
            resolution: quality === "high" ? "4k" : quality === "medium" ? "2k" : quality === "low" ? "1k" : undefined,
            imageUrls,
        }),
        ...(config.outputBackground === "transparent" ? { background: "transparent", output_format: IMAGE_OUTPUT_FORMAT } : {}),
    };
    await recordEcommerceCanvasRequest(task, { size: body.size as string | undefined, aspectRatio: body.ratio as string | undefined }, "GlobalAiOpc");
    const response = await imageSubmissionFetch(config, url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        cache: "no-store",
    });
    if (!response.ok) throw imageSubmissionResponseError(response.status, await readFetchError(response, "图片生成失败"));
    const payload = await parseImageSubmissionJson<ImageApiResponse>(task, response);
    const resultBaseUrl = response.headers.get("x-vozeb-pro-upstream-url") || url;
    return parseChargedImageResponse(task, response, () => parseImagePayloadOrPoll(config, payload, resultBaseUrl, cookie, url, singleStep));
}

export async function runOpenAiJsonImageEditTask(
    task: ImageTask,
    url: string,
    origin: string,
    publicOrigin: string,
    quality: string | undefined,
    requestSize: string | undefined,
    cookie: string,
    responseFormat: (typeof IMAGE_RESPONSE_FORMATS)[number] = "b64_json",
    singleStep = false,
    billingVariant = "primary",
): Promise<ImageTaskRunResult> {
    const run = () => runOpenAiJsonImageEditTaskUnlocked(task, url, origin, publicOrigin, quality, requestSize, cookie, responseFormat, singleStep, billingVariant);
    return isNativeSub2ApiImageEdit(task.config) ? runNativeSub2ApiImageSubmission(task, run) : run();
}

async function runOpenAiJsonImageEditTaskUnlocked(
    task: ImageTask,
    url: string,
    origin: string,
    publicOrigin: string,
    quality: string | undefined,
    requestSize: string | undefined,
    cookie: string,
    responseFormat: (typeof IMAGE_RESPONSE_FORMATS)[number],
    singleStep: boolean,
    billingVariant: string,
): Promise<ImageTaskRunResult> {
    const config = task.config;
    let lastMessage = "";
    const apiBase = await resolveConfiguredApiBaseUrl(task.config.baseUrl).catch(() => task.config.baseUrl);
    const referenceMode = configuredImageEditReferenceMode(config);
    const imageUrlObjectOnlyMode = shouldUseSub2ApiImageEdit(config, apiBase);
    const allowProtocolFallback = !task.sceneProtection && !task.ecommerceExecution?.canvas && allowsImageProtocolFallback(config);
    const publicUrlReferenceMode = imageUrlObjectOnlyMode || referenceMode === "public-url";
    for (const [index, body] of (await buildJsonImageEditBodies(task, quality, requestSize, responseFormat, origin, publicOrigin, cookie, publicUrlReferenceMode, imageUrlObjectOnlyMode, allowProtocolFallback)).entries()) {
        const headers = taskHeaders(config, cookie, imagePointsIdempotencyKey(task, index === 0 ? billingVariant : `${billingVariant}-${index + 1}`));
        headers.set("content-type", "application/json");
        await recordEcommerceCanvasRequest(task, { size: body.size as string | undefined }, "OpenAI JSON edit");
        const response = await imageSubmissionFetch(config, url, { method: "POST", headers, body: JSON.stringify(body), cache: "no-store" });
        if (!response.ok) {
            const message = await readFetchError(response, "图片生成失败");
            lastMessage = message;
            if (imageUrlObjectOnlyMode) throw imageSubmissionResponseError(response.status, message);
            if (allowProtocolFallback && shouldRetryJsonImageEditPayload(response.status, message)) continue;
            if (allowProtocolFallback && shouldTryNextImageResponseFormat(responseFormat, response.status, message)) {
                if (responseFormat === "url") return runOpenAiJsonImageEditTaskUnlocked(task, url, origin, publicOrigin, quality, requestSize, cookie, "b64_json", singleStep, "base64");
                return runOpenAiResponsesImageTask(task, origin, cookie, singleStep, "responses");
            }
            if (allowProtocolFallback && shouldFallbackToResponsesImage(response.status, message)) return runOpenAiResponsesImageTask(task, origin, cookie, singleStep, "responses");
            throw imageSubmissionResponseError(response.status, message);
        }
        const payload = await parseImageSubmissionJson<ImageApiResponse>(task, response);
        const resultBaseUrl = response.headers.get("x-vozeb-pro-upstream-url") || url;
        const result = await parseChargedImageResponse(task, response, () => parseImagePayloadOrPoll(config, payload, resultBaseUrl, cookie, url, singleStep));
        if (allowProtocolFallback && responseFormat === "url" && shouldRetryInternalImageUrlAsBase64(result)) {
            await refundChargedImageResponse(task, response.headers);
            return runOpenAiJsonImageEditTaskUnlocked(task, url, origin, publicOrigin, quality, requestSize, cookie, "b64_json", singleStep, "base64");
        }
        return result;
    }
    if (allowProtocolFallback && shouldTryNextImageResponseFormat(responseFormat, 400, lastMessage)) {
        if (responseFormat === "url") return runOpenAiJsonImageEditTaskUnlocked(task, url, origin, publicOrigin, quality, requestSize, cookie, "b64_json", singleStep, "base64");
        return runOpenAiResponsesImageTask(task, origin, cookie, singleStep, "responses");
    }
    throw new GenerationSubmissionSafeFailure(lastMessage || "图片生成失败");
}

export async function runOpenAiImageTaskWithBase64Response(task: ImageTask, origin: string, publicOrigin: string, cookie: string, singleStep = false, billingVariant = "base64"): Promise<ImageTaskRunResult> {
    const config = task.config;
    const quality = normalizeQuality(config.quality || "");
    const requestSize = resolveCanvasRequestSize(task, quality);
    const path = await openAiImageTaskPath(config, task.kind);
    const url = taskUrl(config, path, origin);
    const allowProtocolFallback = !task.sceneProtection && !task.ecommerceExecution?.canvas && allowsImageProtocolFallback(config);
    const headers = taskHeaders(config, cookie, imagePointsIdempotencyKey(task, billingVariant));

    if (task.kind === "edit") {
        let formData: FormData;
        try {
            formData = await buildImageEditFormData(task, quality, requestSize, origin, cookie, "b64_json", allowProtocolFallback);
        } catch (error) {
            throw new GenerationSubmissionSafeFailure(error instanceof Error ? error.message : "参考图读取失败，请重新上传参考图");
        }
        await recordEcommerceCanvasRequest(task, { size: String(formData.get("size") || "") }, "OpenAI multipart");
        const response = await imageSubmissionFetch(config, url, { method: "POST", headers, body: formData, cache: "no-store" });
        if (!response.ok) {
            const message = await readFetchError(response, "图片生成失败");
            if (allowProtocolFallback && shouldFallbackToJsonImageEdit(response.status, message)) return runOpenAiJsonImageEditTask(task, url, origin, publicOrigin, quality, requestSize, cookie, "b64_json", singleStep, `${billingVariant}-json-edit`);
            if (allowProtocolFallback && shouldFallbackToResponsesImage(response.status, message)) return runOpenAiResponsesImageTask(task, origin, cookie, singleStep, `${billingVariant}-responses`);
            throw imageSubmissionResponseError(response.status, message);
        }
        const payload = await parseImageSubmissionJson<ImageApiResponse>(task, response);
        const resultBaseUrl = response.headers.get("x-vozeb-pro-upstream-url") || url;
        return parseChargedImageResponse(task, response, () => parseImagePayloadOrPoll(config, payload, resultBaseUrl, cookie, url, singleStep));
    }

    headers.set("content-type", "application/json");
    await recordEcommerceCanvasRequest(task, { size: requestSize }, "OpenAI JSON");
    const response = await imageSubmissionFetch(config, url, {
        method: "POST",
        headers,
        body: JSON.stringify({
            model: config.model,
            prompt: withSystemPrompt(config, task.prompt),
            ...(config.outputMode === "layers" ? {} : { n: 1 }),
            ...(quality ? { quality } : {}),
            ...(requestSize ? { size: requestSize } : {}),
            response_format: "b64_json",
            output_format: IMAGE_OUTPUT_FORMAT,
        }),
        cache: "no-store",
    });
    if (!response.ok) {
        const message = await readFetchError(response, "图片生成失败");
        if (allowProtocolFallback && shouldFallbackToResponsesImage(response.status, message)) return runOpenAiResponsesImageTask(task, origin, cookie, singleStep, `${billingVariant}-responses`);
        throw imageSubmissionResponseError(response.status, message);
    }
    const payload = await parseImageSubmissionJson<ImageApiResponse>(task, response);
    const resultBaseUrl = response.headers.get("x-vozeb-pro-upstream-url") || url;
    return parseChargedImageResponse(task, response, () => parseImagePayloadOrPoll(config, payload, resultBaseUrl, cookie, url, singleStep));
}

export async function runOpenAiResponsesImageTask(task: ImageTask, origin: string, cookie: string, singleStep = false, billingVariant = "responses"): Promise<ImageTaskRunResult> {
    if (task.ecommerceExecution?.canvas) throw new EcommerceCanvasAdapterReview("OpenAI Responses");
    const config = task.config;
    const url = taskUrl(config, "/responses", origin);
    let lastError = "";

    const bodies = allowsImageProtocolFallback(config) ? buildResponsesImageBodies(task, origin) : [buildResponsesImageBodies(task, origin)[0]];
    for (const [index, body] of bodies.entries()) {
        const headers = taskHeaders(config, cookie, imagePointsIdempotencyKey(task, index === 0 ? billingVariant : `${billingVariant}-${index + 1}`));
        headers.set("content-type", "application/json");
        const response = await imageSubmissionFetch(config, url, { method: "POST", headers, body: JSON.stringify(body), cache: "no-store" });
        if (!response.ok) {
            lastError = await readFetchError(response, "图片生成失败");
            if (response.status === 400 || response.status === 422) continue;
            throw imageSubmissionResponseError(response.status, lastError);
        }
        const payload = await parseImageSubmissionJson<ImageApiResponse>(task, response);
        const resultBaseUrl = response.headers.get("x-vozeb-pro-upstream-url") || url;
        return parseChargedImageResponse(task, response, () => parseImagePayloadOrPoll(config, payload, resultBaseUrl, cookie, url, singleStep));
    }

    throw new GenerationSubmissionSafeFailure(lastError || "图片生成失败");
}

export function buildResponsesImageBodies(task: ImageTask, origin: string) {
    const prompt = withSystemPrompt(task.config, withImageOutputInstructions(task.config, buildImageReferencePromptText(task.prompt, task.references)));
    const imageContent = task.references.map((reference) => ({ type: "input_image", image_url: referenceRequestUrl(reference, origin) }));
    const content = [{ type: "input_text", text: prompt }, ...imageContent];
    return [
        {
            model: task.config.model,
            input: [{ role: "user", content }],
            tools: [{ type: "image_generation", ...(task.config.outputBackground === "transparent" ? { background: "transparent", output_format: IMAGE_OUTPUT_FORMAT } : {}) }],
        },
        {
            model: task.config.model,
            input: [{ role: "user", content }],
        },
        {
            model: task.config.model,
            input: prompt,
            tools: [{ type: "image_generation", ...(task.config.outputBackground === "transparent" ? { background: "transparent", output_format: IMAGE_OUTPUT_FORMAT } : {}) }],
        },
        {
            model: task.config.model,
            input: prompt,
        },
    ];
}

export async function buildJsonImageEditBodies(
    task: ImageTask,
    quality: string | undefined,
    requestSize: string | undefined,
    responseFormat: (typeof IMAGE_RESPONSE_FORMATS)[number],
    origin: string,
    publicOrigin: string,
    cookie = "",
    publicUrlReferenceMode = false,
    imageUrlObjectOnlyMode = false,
    includeCompatibilityFields = true,
) {
    const referenceContext = { ownerUserId: task.userId, taskId: task.id };
    const nativeSub2Api = isNativeSub2ApiImageEdit(task.config);
    const images = (
        await Promise.all(
            task.references.map((reference, index) =>
                nativeSub2Api
                    ? imageReferenceToDataUrl(reference, reference.name || `reference-${index + 1}.png`, origin, cookie)
                    : publicUrlReferenceMode
                      ? publicImageReferenceRequestUrl(reference, origin, publicOrigin, referenceContext)
                      : Promise.resolve(jsonImageReferenceRequestUrl(reference, origin)),
            ),
        )
    ).filter(Boolean);
    const mask = task.mask
        ? nativeSub2Api
            ? await imageReferenceToDataUrl(task.mask, task.mask.name || "mask.png", origin, cookie)
            : publicUrlReferenceMode
              ? await publicImageReferenceRequestUrl(task.mask, origin, publicOrigin, referenceContext)
              : jsonImageReferenceRequestUrl(task.mask, origin)
        : "";
    const prompt = withImageOutputInstructions(task.config, imageUrlObjectOnlyMode || nativeSub2Api ? buildSub2ApiImageEditPrompt(task.prompt, task.references, task.mask, nativeSub2Api) : buildImageReferencePromptText(task.prompt, task.references));
    const base = {
        model: task.config.model,
        prompt: withSystemPrompt(task.config, prompt),
        ...(task.config.outputMode === "layers" ? {} : { n: 1 }),
        ...(quality ? { quality } : {}),
        ...(requestSize ? { size: requestSize } : {}),
        ...(includeCompatibilityFields ? { response_format: responseFormat, output_format: IMAGE_OUTPUT_FORMAT } : {}),
        ...(task.config.outputBackground === "transparent" ? { background: "transparent" } : {}),
        ...(mask ? { mask } : {}),
    };
    if (nativeSub2Api) return [{ ...base, images: images.map((image_url) => ({ image_url })), ...(mask ? { mask: { image_url: mask } } : {}), input_fidelity: "high" }];
    if (!images.length) return [base];
    const first = images[0];
    const imageUrlObjects = images.map((item) => ({ image_url: item }));
    const imageObjects = images.map((item) => ({ url: item }));
    if (imageUrlObjectOnlyMode) {
        const imageUrls = mask ? [...images, mask] : images;
        return [
            {
                model: task.config.model,
                prompt: withSystemPrompt(task.config, prompt),
                ...(task.config.outputMode === "layers" ? {} : { n: 1 }),
                ...(quality ? { quality } : {}),
                ...(requestSize ? { size: requestSize } : {}),
                ...(task.config.outputBackground === "transparent" ? { background: "transparent", output_format: IMAGE_OUTPUT_FORMAT } : {}),
                ...(mask ? { mask } : {}),
                image_urls: imageUrls,
            },
        ];
    }
    return [
        { ...base, images: imageUrlObjects, ref_assets: imageUrlObjects, image_urls: imageUrlObjects },
        { ...base, ...(images.length === 1 ? { image: first } : {}), images, ref_assets: images, image_urls: images },
        { ...base, image_url: first },
        { ...base, input_image: first },
        { ...base, image: first },
        { ...base, images: imageObjects, ref_assets: imageObjects, image_urls: imageObjects },
    ];
}

export function buildSub2ApiImageEditPrompt(prompt: string, references: readonly unknown[], mask?: Pick<ImageTaskReference, "editRegion">, nativeSub2Api = false) {
    const text = prompt.trim();
    if (!references.length) return text;
    if (mask) {
        const region = normalizeImageEditRegion(mask.editRegion);
        const location = region
            ? [
                  `Editable region normalized bounds (0 to 1): left=${region.left.toFixed(4)}, top=${region.top.toFixed(4)}, right=${region.right.toFixed(4)}, bottom=${region.bottom.toFixed(4)}.`,
                  `Editable region normalized center (0 to 1): centerX=${region.centerX.toFixed(4)}, centerY=${region.centerY.toFixed(4)}.`,
              ]
            : [];
        return [
            nativeSub2Api ? "Use the first source image in images as the source scene that must be edited in place." : "Use image_urls[0] as the source scene that must be edited in place.",
            nativeSub2Api ? "The separate mask field is a binary edit mask, not a scene reference." : `The final image_urls item is a binary edit mask (image_urls[${references.length}]).`,
            "Edit only the selected region of the source scene; preserve everything outside that region.",
            ...location,
            "Apply the user request only inside the editable region and place the complete requested object inside the editable region.",
            "Preserve the source scene, composition, subjects, lighting, and perspective. Do not replace or redesign the whole scene.",
            "Match the source image's artistic style, color palette, materials, texture, and realism for all edited content.",
            "Match the source light direction, warmth, exposure, shadows, scale, and perspective so the edit belongs naturally in the original scene.",
            "Do not introduce unrelated people, animals, furniture, or objects. Generate only content required by the user request.",
            "",
            `User request: ${text}`,
        ].join("\n");
    }
    if (nativeSub2Api)
        return [
            "Edit the first source image in place, using any additional images only as references for the requested edit.",
            "Preserve the source scene, composition, subjects, artistic style, color palette, materials, lighting, and perspective unless the user explicitly requests a change.",
            "",
            `User request: ${text}`,
        ].join("\n");
    const fieldHint = references.length === 1 ? "image_urls[0]" : "image_urls";
    return [
        `Use the actual reference image supplied in the JSON field ${fieldHint} as visual input, not as a text-only hint.`,
        "The first reference image, image_urls[0], is the primary identity and character reference. Keep the same person or character, face proportions, hairstyle, body shape, clothing, and main pose as much as possible.",
        "Only apply the user's requested edit to the existing referenced subject. Do not replace the referenced person or character with a new unrelated person.",
        "",
        `User request: ${text}`,
    ].join("\n");
}

import {
    referenceRequestUrl,
    jsonImageReferenceRequestUrl,
    publicImageReferenceRequestUrl,
    referenceRequestUrlCandidates,
    rawReferenceRequestUrlCandidates,
    uniqueStrings,
    normalizeReferenceRequestUrl,
    requestPublicOrigin,
    normalizePublicOrigin,
    isExternalPublicOrigin,
    isExternalPublicMediaUrl,
    isExternalPublicHost,
} from "./image-task-reference-urls";
export {
    referenceRequestUrl,
    jsonImageReferenceRequestUrl,
    publicImageReferenceRequestUrl,
    referenceRequestUrlCandidates,
    rawReferenceRequestUrlCandidates,
    uniqueStrings,
    normalizeReferenceRequestUrl,
    requestPublicOrigin,
    normalizePublicOrigin,
    isExternalPublicOrigin,
    isExternalPublicMediaUrl,
    isExternalPublicHost,
} from "./image-task-reference-urls";
