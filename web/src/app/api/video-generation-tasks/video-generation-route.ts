import { after, NextResponse } from "next/server";
import { readJsonBody } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { getAuthSettings, isAuthInputError, refundUserPoints } from "@/lib/auth/store";
import { generationModelId, toSystemGenerationChannel } from "@/lib/server/generation-channel";
import { finishGenerationAttempt, startGenerationAttempt, type GenerationAttempt } from "@/lib/server/generation-attempt";
import { fetchInternalApi, resolveInternalOrigin } from "@/lib/server/internal-origin";
import { resolveLogicalModelCandidates } from "@/lib/server/logical-model-router";
import { assertReferenceCapabilities, assertReferenceUrls, assertVideoReferenceRoles, buildVideoProviderRequest, isProviderBusinessError, readProviderError, readProviderString, resolvedProviderCreatePaths } from "@/lib/server/provider-task-config";
import { buildGlobalAiOpcVideoRequest, resolveGlobalAiOpcPreset } from "@/lib/globalaiopc-catalog";
import { createVideoTask, transitionVideoTask, updateVideoTask, type VideoTask } from "@/lib/server/video-task-store";
import { toSafeGenerationErrorMessage } from "@/lib/server/generation-errors";
import { generationCapacityRetryAfterSeconds, getStoredGenerationTaskByRequest, linkStoredGenerationTask, withGenerationConcurrencyLimit, type GenerationTaskContext } from "@/lib/server/generation-task-store";
import { normalizeVideoAspectRatio, resolveUpstreamVideoDuration, resolveVideoDuration, resolveVideoGenerationParameters, withVideoReferenceFidelity } from "@/lib/server/video-task-config";
import { parseImageDimensions } from "@/lib/image-size";
import { signGenerationAssetInputUrl, signReferenceAssetInputUrl } from "@/lib/server/reference-asset-access";
import { requireManagedMediaInputOwner } from "@/lib/server/managed-media-input-access";
import { assertCapabilityConstraints } from "@/lib/server/capability-constraints";
import { checkGenerationRateLimit, rateLimitHeaders } from "@/lib/server/security";
import { resolveModelRequestTimeoutMs } from "@/lib/server/model-request-policy";
import { mediaTaskSource } from "@/lib/media-management-contract";
import { runGenerationTaskRecoveryBatch } from "@/lib/server/generation-task-recovery-service";
import { scheduleGenerationTask } from "@/lib/server/generation-task-scheduler";
import { VIDEO_PROVIDER_MEDIA_KEYS, parseVideoProviderJson, readVideoProviderHttpError, readVideoProviderId, readVideoProviderUrl } from "@/lib/server/video-provider-response";
import { buildSeedanceSpecialRequest } from "@/lib/seedance-special";
import { assertVozebRecommendedVideoReferences, buildVozebRecommendedVideoRequest } from "@/lib/vozeb-recommended-video";
import { assertGeminiVideoReferences, buildGeminiVideoRequest, geminiVideoCreatePath, normalizeGeminiVideoDuration, parseGeminiVideoCreateResponse } from "@/lib/server/gemini-video-provider";
import { systemAiBillingHeaders } from "@/lib/server/system-ai-billing";
import { maintenanceWorkerContextHeaders, requestRuntimeCredential } from "@/lib/server/maintenance-auth";
import { resolvePublicRequestOrigin } from "@/lib/server/public-request-origin";
import { writeVideoGenerationLog } from "@/lib/server/video-task-log";
import { assertOpenAiVideoImageReferences, buildOpenAiVideoFormData } from "./video-task-openai";
import { normalizeVideoGenerationReferences, regularVideoReferences, videoFrameReferences, type VideoGenerationReference } from "@/lib/video-reference-contract";
import { assertYumengVideoReferences, buildYumengVideoRequest } from "@/lib/yumeng-model-center";
import { normalizeVideoProviderImageReferences } from "@/lib/server/video-reference-image";

const CREATE_PATHS = ["/video/generations", "/videos/generations", "/videos/videos", "/videos"];
type CreateVideoTaskBody = { config?: Record<string, unknown>; prompt?: string; references?: VideoGenerationReference[]; source?: string; context?: GenerationTaskContext };

export async function POST(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    const headerRequestId = clean(request.headers.get("x-vozeb-pro-client-request-id"));
    const headerAttemptNo = positiveAttemptNo(request.headers.get("x-vozeb-pro-attempt-no"));
    if (headerRequestId) {
        const existing = await getStoredGenerationTaskByRequest<VideoTask>("video", user.id, headerRequestId, headerAttemptNo);
        if (existing) return NextResponse.json({ task: publicTask(existing) });
    }
    const rate = await checkGenerationRateLimit(user.id, request, "video");
    if (!rate.allowed) return NextResponse.json({ error: "视频生成请求过于频繁，请稍后重试" }, { status: 429, headers: rateLimitHeaders(rate) });
    let body: CreateVideoTaskBody;
    try {
        body = await readJsonBody(request);
    } catch (error) {
        if (isAuthInputError(error)) return NextResponse.json({ error: error.message }, { status: error.status });
        throw error;
    }
    if (!headerRequestId && body.context?.clientRequestId) {
        const existing = await getStoredGenerationTaskByRequest<VideoTask>("video", user.id, body.context.clientRequestId, body.context.attemptNo);
        if (existing) return NextResponse.json({ task: publicTask(existing) });
    }
    if (headerRequestId) body.context = { ...(body.context || {}), clientRequestId: headerRequestId, ...(headerAttemptNo ? { attemptNo: headerAttemptNo } : {}) };
    const concurrencyRequestId = clean(body.context?.clientRequestId) || `video-request:${user.id}:${crypto.randomUUID()}`;
    body.context = { ...(body.context || {}), clientRequestId: concurrencyRequestId };
    const settings = await getAuthSettings();
    const response = await withGenerationConcurrencyLimit(
        user.id,
        "video",
        30 * 60_000,
        settings.generationConcurrency.video,
        async () => {
            const requestedModel = typeof body.config?.model === "string" && body.config.model.trim() ? body.config.model : settings.defaultModels.videoModel;
            const channels = resolveLogicalModelCandidates(settings, "video", requestedModel).map(toSystemGenerationChannel);
            const prompt = String(body.prompt || "").trim();
            if (!channels.length || !prompt) return NextResponse.json({ error: "视频任务参数不完整或渠道不支持" }, { status: 400 });
            const publicOrigin = requestPublicOrigin(request);
            let references: VideoGenerationReference[];
            try {
                references = await Promise.all(normalizeVideoGenerationReferences(body.references).map((reference) => signProviderReference(reference, user, publicOrigin)));
            } catch (error) {
                return NextResponse.json({ error: error instanceof Error ? error.message : "视频参考素材不正确" }, { status: 400 });
            }
            const origin = resolveInternalOrigin(new URL(request.url).origin);
            const cookie = requestRuntimeCredential(request, user.id);
            try {
                references = await normalizeVideoProviderImageReferences({ references, userId: user.id, internalOrigin: origin, publicOrigin });
            } catch (error) {
                return NextResponse.json({ error: error instanceof Error ? error.message : "视频参考素材转换失败" }, { status: 400 });
            }
            const providerPrompt = withVideoReferenceFidelity(prompt, references);
            const requestedParameters = resolveVideoGenerationParameters(body.config || {}, settings.generationDefaults);
            const billingRequestId = concurrencyRequestId;
            let lastError: unknown;
            let capabilityError: unknown;
            let attempts: GenerationAttempt[] = [];
            let localTask: VideoTask | undefined;
            for (let index = 0; index < channels.length; index += 1) {
                const channel = channels[index];
                const geminiVideo = isGeminiVideoChannel(channel);
                const parameters = {
                    ...requestedParameters,
                    videoSeconds: geminiVideo
                        ? normalizeGeminiVideoDuration(requestedParameters.videoSeconds)
                        : resolveUpstreamVideoDuration(requestedParameters.videoSeconds, settings.generationDefaults.videoSeconds, {
                              durationRange: channel.advancedConfig?.durationRange,
                              minDurationSeconds: channel.capabilityProfile?.minDurationSeconds,
                              maxDurationSeconds: channel.capabilityProfile?.maxDurationSeconds,
                          }),
                };
                try {
                    assertCapabilityConstraints(channel.capabilityProfile, {
                        capability: "video",
                        referenceCount: references.filter((reference) => reference.type === "image").length,
                        durationSeconds: requestedParameters.videoSeconds === -1 ? undefined : requestedParameters.videoSeconds,
                        aspectRatio: requestedParameters.size,
                        resolution: requestedParameters.vquality,
                    });
                    const globalPreset = globalAiOpcVideoPreset(channel.advancedConfig, channel.model);
                    if (geminiVideo) {
                        assertGeminiVideoReferences(references);
                    } else {
                        assertReferenceCapabilities(
                            globalPreset
                                ? {
                                      ...channel.advancedConfig!,
                                      supportsReferenceImage: Boolean(globalPreset.supportsReferenceImage),
                                      supportsReferenceVideo: Boolean(globalPreset.supportsReferenceVideo),
                                      supportsReferenceAudio: Boolean(globalPreset.supportsReferenceAudio),
                                  }
                                : channel.advancedConfig,
                            references,
                        );
                        if (channel.advancedConfig?.protocol !== "yumeng") assertVideoReferenceRoles(channel.advancedConfig, references, globalPreset?.videoReferenceRoles);
                        if (channel.advancedConfig?.protocol === "vozeb-recommended") assertVozebRecommendedVideoReferences(channel.model, references);
                        if (channel.advancedConfig?.protocol === "yumeng") assertYumengVideoReferences(channel.model, references);
                        assertReferenceUrls(channel.advancedConfig, references, Boolean(globalPreset));
                        const regularReferences = regularVideoReferences(references);
                        if (channel.advancedConfig?.requestTemplate?.trim().toLowerCase().startsWith("multipart/form-data") && !usesStructuredReferenceBody(channel.advancedConfig, references)) {
                            assertOpenAiVideoImageReferences(referenceUrls(regularReferences, "image"));
                        }
                    }
                } catch (error) {
                    capabilityError = error;
                    continue;
                }
                const started = startGenerationAttempt(attempts, { channelId: channel.channelId, model: generationModelId(channel), capability: "video" });
                attempts = started.attempts;
                const pendingUpstream = {
                    id: "",
                    provider: "generation" as const,
                    model: channel.model,
                    pollPath: geminiVideo ? geminiVideoCreatePath(channel.model) : channel.advancedConfig?.createPath || CREATE_PATHS[0],
                };
                if (!localTask) {
                    localTask = await createVideoTask({
                        userId: user.id,
                        username: user.username,
                        displayName: user.displayName,
                        title: prompt.slice(0, 36) || "视频生成",
                        config: channel,
                        upstream: pendingUpstream,
                        requestedDurationSeconds: parameters.videoSeconds === -1 ? undefined : parameters.videoSeconds,
                        prompt,
                        source: mediaTaskSource(body.source, body.context, "video-task"),
                        attempts,
                        ...(body.context || {}),
                    });
                    await linkStoredGenerationTask("video", localTask.id, body.context || {});
                } else {
                    await updateVideoTask(localTask.id, {
                        config: channel,
                        upstream: pendingUpstream,
                        requestedDurationSeconds: parameters.videoSeconds === -1 ? undefined : parameters.videoSeconds,
                        attempts,
                    });
                    localTask = { ...localTask, config: channel, upstream: pendingUpstream, requestedDurationSeconds: parameters.videoSeconds === -1 ? undefined : parameters.videoSeconds, attempts };
                }
                const submissionStartedAt = Date.now();
                await scheduleGenerationTask("video", localTask.id, {
                    executionPhase: "submitting",
                    channelId: channel.channelId,
                    provider: channel.advancedConfig?.protocol || channel.apiFormat,
                    queryPath: channel.advancedConfig?.queryPath,
                    nextPollAt: submissionStartedAt + resolveModelRequestTimeoutMs(channel, "video"),
                    lastUpstreamStatus: "submitting",
                });
                try {
                    const upstream = await createUpstream(user.id, origin, cookie, channel, providerPrompt, parameters, references, settings.generationPointMultipliers, billingRequestId);
                    await updateVideoTask(localTask.id, { config: channel, upstream, requestedDurationSeconds: parameters.videoSeconds === -1 ? undefined : parameters.videoSeconds, attempts });
                    const task = { ...localTask, config: channel, upstream, requestedDurationSeconds: parameters.videoSeconds === -1 ? undefined : parameters.videoSeconds, attempts };
                    const submittedAt = Date.now();
                    await scheduleGenerationTask("video", task.id, {
                        executionPhase: "submitted",
                        upstreamTaskId: task.upstream.id,
                        channelId: channel.channelId,
                        provider: task.upstream.provider,
                        queryPath: task.upstream.queryPath || task.config.advancedConfig?.queryPath || task.upstream.pollPath,
                        submittedAt,
                        nextPollAt: submittedAt,
                        lastUpstreamStatus: "submitted",
                    });
                    after(() => runGenerationTaskRecoveryBatch({ origin, cookie, limit: 1, taskIds: [task.id] }));
                    return NextResponse.json({ task: publicTask(task) });
                } catch (error) {
                    lastError = error;
                    if (error instanceof SafeCandidateFailure) {
                        attempts = finishGenerationAttempt(attempts, started.attempt.attemptNo, { status: "failed", error: toSafeGenerationErrorMessage(error, "视频任务创建失败") });
                        await updateVideoTask(localTask.id, { attempts });
                        if (index < channels.length - 1) continue;
                    } else if (error instanceof VideoSubmissionUncertainError && error.billing) {
                        const upstream = { ...localTask.upstream, ...error.billing };
                        await updateVideoTask(localTask.id, { upstream, attempts });
                        localTask = { ...localTask, upstream, attempts };
                    }
                    const message = toSafeGenerationErrorMessage(error, "视频任务创建失败");
                    if (!(error instanceof SafeCandidateFailure)) {
                        const reviewReason = `${message}；上游创建结果待确认，系统不会自动重复创建。`;
                        await scheduleGenerationTask("video", localTask.id, { executionPhase: "needs_review", nextPollAt: undefined, lastUpstreamStatus: "submission_outcome_unknown", resultPayload: { reviewReason: reviewReason.slice(0, 500) } });
                        return NextResponse.json({ task: { ...publicTask({ ...localTask, attempts }), needsReview: true }, warning: reviewReason }, { status: 202 });
                    }
                    break;
                }
            }
            if (!lastError && capabilityError) return NextResponse.json({ error: capabilityError instanceof Error ? capabilityError.message : "当前渠道不支持参考素材" }, { status: 400 });
            if (localTask && lastError) {
                const message = toSafeGenerationErrorMessage(lastError, "视频任务创建失败");
                await writeVideoGenerationLog({ ...localTask, attempts }, "failed", message, lastError instanceof SafeCandidateFailure);
                await transitionVideoTask(localTask, { status: "error", error: message, retryable: lastError instanceof SafeCandidateFailure });
                await scheduleGenerationTask("video", localTask.id, { executionPhase: "completed", nextPollAt: undefined, lastUpstreamStatus: "create_failed" });
            }
            return NextResponse.json({ error: toSafeGenerationErrorMessage(lastError, "视频任务创建失败"), canRetry: lastError instanceof SafeCandidateFailure }, { status: 502 });
        },
        undefined,
        concurrencyRequestId,
    );
    if (response) return response;
    const retryAfter = await generationCapacityRetryAfterSeconds(user.id, "video", 30 * 60_000);
    return NextResponse.json({ error: "当前用户视频任务已达到并发上限" }, { status: 429, ...(retryAfter ? { headers: { "Retry-After": String(retryAfter) } } : {}) });
}

export async function signProviderReference(reference: VideoGenerationReference, user: { id: string; role: "user" | "admin" }, publicOrigin: string) {
    let url: URL;
    try {
        url = new URL(reference.url, publicOrigin);
    } catch {
        return reference;
    }
    if (url.origin !== new URL(publicOrigin).origin) return reference;
    const scope = url.pathname.startsWith("/api/reference-assets/") ? "reference" : url.pathname.startsWith("/api/generation-log-assets/") ? "generation" : null;
    if (!scope) return reference;
    const registeredOwnerUserId = await requireManagedMediaInputOwner(url.pathname, { id: user.id, role: user.role }, scope);
    return { ...reference, url: scope === "reference" ? signReferenceAssetInputUrl(reference.url, publicOrigin, registeredOwnerUserId) : signGenerationAssetInputUrl(reference.url, publicOrigin, registeredOwnerUserId) };
}

export async function createUpstream(
    userId: string,
    origin: string,
    cookie: string,
    channel: NonNullable<ReturnType<typeof toSystemGenerationChannel>>,
    prompt: string,
    raw: Record<string, unknown>,
    references: VideoGenerationReference[],
    multipliers: Awaited<ReturnType<typeof getAuthSettings>>["generationPointMultipliers"],
    billingRequestId: string,
) {
    let lastError = "";
    const regularReferences = regularVideoReferences(references);
    const { firstFrame, lastFrame } = videoFrameReferences(references);
    const images = referenceUrls(regularReferences, "image");
    const videos = referenceUrls(regularReferences, "video");
    const audios = referenceUrls(regularReferences, "audio");
    const requestImage = images[0] || "";
    const requestImages = images;
    const firstFrameUrl = firstFrame?.url || "";
    const lastFrameUrl = lastFrame?.url || "";
    const dimensions = videoDimensions(raw.size, raw.vquality);
    const generateAudio = raw.videoGenerateAudio !== false && raw.videoGenerateAudio !== "false";
    if (isGeminiVideoChannel(channel)) {
        return createGeminiVideoUpstream({ userId, origin, cookie, channel, prompt, raw, references, generateAudio, multipliers, billingRequestId });
    }
    const values = {
        model: channel.model,
        prompt,
        duration: duration(raw.videoSeconds),
        seconds: duration(raw.videoSeconds),
        ratio: ratio(raw.size),
        aspect_ratio: ratio(raw.size),
        size: sizeValue(raw.size),
        resolution: resolution(raw.vquality),
        quality: resolution(raw.vquality),
        width: dimensions.width,
        height: dimensions.height,
        generate_audio: generateAudio,
        watermark: booleanValue(raw.videoWatermark),
        images: requestImages,
        videos,
        audios,
        image: requestImage,
        video: videos[0] || "",
        audio: audios[0] || "",
        references,
        content: videoReferenceContent(prompt, references),
        first_frame: firstFrameUrl,
        first_frame_url: firstFrameUrl,
        last_frame: lastFrameUrl,
        last_frame_url: lastFrameUrl,
    };
    const defaults = {
        model: channel.model,
        prompt,
        duration: values.duration,
        seconds: values.seconds,
        ratio: values.ratio,
        aspect_ratio: values.aspect_ratio,
        size: values.size,
        width: values.width,
        height: values.height,
        resolution: values.resolution,
        quality: values.quality,
        generate_audio: generateAudio,
        watermark: booleanValue(raw.videoWatermark),
        ...(requestImage ? { image: requestImage } : {}),
        ...(requestImages.length ? { images: requestImages, image_urls: requestImages, reference_images: requestImages } : {}),
        ...(videos.length ? { video: videos[0], videos, reference_videos: videos } : {}),
        ...(audios.length ? { audio: audios[0], audios, reference_audios: audios } : {}),
        ...(references.length ? { ref_assets: references.map((item) => ({ type: item.type, url: item.url, role: item.role || "reference" })) } : {}),
        ...(firstFrameUrl ? { first_frame: firstFrameUrl, first_frame_url: firstFrameUrl } : {}),
        ...(lastFrameUrl ? { last_frame: lastFrameUrl, last_frame_url: lastFrameUrl } : {}),
    };
    const globalPreset = globalAiOpcVideoPreset(channel.advancedConfig, channel.model);
    const requestTemplate = channel.advancedConfig?.requestTemplate?.trim() || "";
    const multipartTemplate = requestTemplate.toLowerCase().startsWith("multipart/form-data");
    const structuredOpenAiReferences = multipartTemplate && usesStructuredReferenceBody(channel.advancedConfig, references);
    const multipart = multipartTemplate && !structuredOpenAiReferences;
    let requestBody: FormData | string;
    try {
        const payload = multipart
            ? undefined
            : structuredOpenAiReferences
              ? {
                    model: channel.model,
                    prompt,
                    duration: values.duration,
                    resolution: values.resolution,
                    ratio: values.ratio,
                    content: channel.advancedConfig?.protocol === "newapi" ? videoReferenceMediaContent(references) : values.content,
                    generate_audio: generateAudio,
                    watermark: booleanValue(raw.videoWatermark),
                }
              : channel.advancedConfig?.protocol === "vozeb-recommended"
                ? buildVozebRecommendedVideoRequest({
                      model: channel.model,
                      prompt,
                      duration: values.duration as number,
                      aspectRatio: values.aspect_ratio as string,
                      resolution: values.resolution as string,
                      generateAudio,
                      images,
                      videos,
                      audios,
                  })
                : channel.advancedConfig?.protocol === "seedance-special"
                  ? buildSeedanceSpecialRequest({
                        model: channel.model,
                        prompt,
                        duration: values.duration === -1 ? 5 : (values.duration as number),
                        ratio: (values.ratio as string | undefined) || "adaptive",
                        generateAudio,
                        references,
                    })
                  : channel.advancedConfig?.protocol === "yumeng"
                    ? buildYumengVideoRequest({
                          model: channel.model,
                          prompt,
                          duration: values.duration as number,
                          aspectRatio: values.aspect_ratio as string,
                          resolution: values.resolution as string,
                          generateAudio,
                          watermark: booleanValue(raw.videoWatermark),
                          images: requestImages,
                          videos,
                          audios,
                          firstFrame: firstFrameUrl || undefined,
                          lastFrame: lastFrameUrl || undefined,
                      })
                    : globalPreset
                      ? buildGlobalAiOpcVideoRequest(globalPreset, {
                            model: channel.model,
                            prompt,
                            duration: values.duration as number,
                            ratio: values.ratio as string,
                            resolution: values.resolution as string,
                            images: requestImages.length ? requestImages : requestImage ? [requestImage] : [],
                            videos,
                            audios,
                            generateAudio,
                            firstFrame: firstFrameUrl || undefined,
                            lastFrame: lastFrameUrl || undefined,
                        })
                      : buildVideoProviderRequest(requestTemplate, defaults, values);
        requestBody = multipart
            ? await buildOpenAiVideoFormData({ model: channel.model, prompt, seconds: values.seconds as number, width: dimensions.width, height: dimensions.height, imageUrls: firstFrameUrl ? [firstFrameUrl] : images, origin, cookie })
            : JSON.stringify(payload);
    } catch (error) {
        throw new SafeCandidateFailure(error instanceof Error ? error.message : "视频请求参数无法构建");
    }
    const imageToVideoPath = images.length || firstFrameUrl ? channel.advancedConfig?.imageToVideoPath?.trim() : "";
    const createPaths = globalPreset ? [globalPreset.createPath] : imageToVideoPath ? [imageToVideoPath] : resolvedProviderCreatePaths(channel.advancedConfig, "video", CREATE_PATHS);
    for (const path of createPaths) {
        const response = await proxyFetch(origin, channel.baseUrl, path, cookie, {
            method: "POST",
            headers: {
                ...(multipart ? {} : { "Content-Type": "application/json" }),
                "Idempotency-Key": billingRequestId,
                "X-Client-Request-Id": billingRequestId,
                ...systemAiBillingHeaders(generationModelId(channel), `video-request:${billingRequestId}`, channel.model),
            },
            body: requestBody,
            signal: AbortSignal.timeout(resolveModelRequestTimeoutMs(channel, "video")),
        });
        const text = await response.text();
        if (!response.ok) {
            lastError = readVideoProviderHttpError(text, response.status);
            if (!SAFE_CREATE_FAILURE_STATUSES.has(response.status)) throw new Error(lastError);
            continue;
        }
        let data: unknown;
        try {
            data = parseVideoProviderJson(text);
        } catch (error) {
            throw new VideoSubmissionUncertainError(error instanceof Error ? error.message : "视频接口返回了无效 JSON", videoSubmissionBilling(response.headers, raw, multipliers));
        }
        const providerError = readProviderError(data);
        if (isProviderBusinessError(data)) {
            const pointsCost = billedPointsCost(response.headers.get("x-vozeb-pro-points-cost"));
            const pointsRecordId = response.headers.get("x-vozeb-pro-points-record-id") || undefined;
            if (pointsCost !== undefined && pointsRecordId) await refundUserPoints(userId, generationModelId(channel), pointsCost, "video", videoUnits(raw, multipliers), undefined, pointsRecordId);
            throw new SafeCandidateFailure(providerError || "视频接口请求失败");
        }
        const resultUrl = readVideoProviderUrl(data, channel.advancedConfig?.resultField);
        const id = readVideoProviderId(data) || (resultUrl ? `direct:${Date.now()}` : "");
        if (!id) {
            throw new VideoSubmissionUncertainError(providerError || "视频接口没有返回任务 ID", videoSubmissionBilling(response.headers, raw, multipliers));
        }
        return {
            id,
            provider: "generation" as const,
            model: channel.model,
            pollPath: path,
            queryPath: undefined,
            resultUrl: resultUrl || undefined,
            pointsCost: billedPointsCost(response.headers.get("x-vozeb-pro-points-cost")),
            pointsUnits: videoUnits(raw, multipliers),
            pointsRecordId: response.headers.get("x-vozeb-pro-points-record-id") || undefined,
        };
    }
    throw new SafeCandidateFailure(lastError || "没有可用的视频创建接口");
}

async function createGeminiVideoUpstream(input: {
    userId: string;
    origin: string;
    cookie: string;
    channel: NonNullable<ReturnType<typeof toSystemGenerationChannel>>;
    prompt: string;
    raw: Record<string, unknown>;
    references: VideoGenerationReference[];
    generateAudio: boolean;
    multipliers: Awaited<ReturnType<typeof getAuthSettings>>["generationPointMultipliers"];
    billingRequestId: string;
}) {
    const payload = await buildGeminiVideoRequest({
        prompt: input.prompt,
        durationSeconds: input.raw.videoSeconds,
        aspectRatio: input.raw.size,
        resolution: input.raw.vquality,
        generateAudio: input.generateAudio,
        references: input.references,
        origin: input.origin,
        cookie: input.cookie,
    });
    const path = geminiVideoCreatePath(input.channel.model);
    const response = await proxyFetch(input.origin, input.channel.baseUrl, path, input.cookie, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": input.billingRequestId,
            "X-Client-Request-Id": input.billingRequestId,
            ...systemAiBillingHeaders(generationModelId(input.channel), `video-request:${input.billingRequestId}`, input.channel.model),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(resolveModelRequestTimeoutMs(input.channel, "video")),
    });
    const text = await response.text();
    if (!response.ok) {
        const message = readVideoProviderHttpError(text, response.status);
        if (SAFE_CREATE_FAILURE_STATUSES.has(response.status)) throw new SafeCandidateFailure(message);
        throw new Error(message);
    }
    let data: unknown;
    try {
        data = parseVideoProviderJson(text);
    } catch (error) {
        throw new VideoSubmissionUncertainError(error instanceof Error ? error.message : "Gemini Veo 返回了无效 JSON", videoSubmissionBilling(response.headers, input.raw, input.multipliers));
    }
    const created = parseGeminiVideoCreateResponse(data, input.channel.model);
    const pointsCost = billedPointsCost(response.headers.get("x-vozeb-pro-points-cost"));
    const pointsRecordId = response.headers.get("x-vozeb-pro-points-record-id") || undefined;
    if (created.error) {
        if (pointsCost !== undefined && pointsRecordId) {
            await refundUserPoints(input.userId, generationModelId(input.channel), pointsCost, "video", videoUnits(input.raw, input.multipliers), undefined, pointsRecordId);
        }
        throw new SafeCandidateFailure(created.error);
    }
    if (!created.id) throw new VideoSubmissionUncertainError("Gemini Veo 没有返回 operation ID", videoSubmissionBilling(response.headers, input.raw, input.multipliers));
    return {
        id: created.id,
        provider: "generation" as const,
        model: input.channel.model,
        pollPath: path,
        queryPath: created.queryPath || undefined,
        resultUrl: created.resultUrl || undefined,
        pointsCost,
        pointsUnits: videoUnits(input.raw, input.multipliers),
        pointsRecordId,
    };
}

function globalAiOpcVideoPreset(config: NonNullable<ReturnType<typeof toSystemGenerationChannel>>["advancedConfig"], model: string) {
    const preset = resolveGlobalAiOpcPreset(config, model);
    return preset?.capability === "video" ? preset : undefined;
}

function isGeminiVideoChannel(channel: NonNullable<ReturnType<typeof toSystemGenerationChannel>>) {
    return channel.apiFormat === "gemini" && channel.advancedConfig?.protocol !== "globalaiopc";
}

function proxyFetch(origin: string, baseUrl: string, path: string, cookie: string, init: RequestInit) {
    const headers = new Headers(init.headers);
    const workerHeaders = maintenanceWorkerContextHeaders(cookie);
    if (workerHeaders) Object.entries(workerHeaders).forEach(([key, value]) => headers.set(key, value));
    else if (cookie) headers.set("cookie", cookie);
    return fetchInternalApi(`${origin}${baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`, { ...init, headers });
}
function publicTask(task: VideoTask) {
    return { id: task.id, status: task.status, model: generationModelId(task.config), upstreamId: task.upstream.id || undefined, durationSeconds: task.requestedDurationSeconds, canRetry: task.retryable === true };
}
function duration(value: unknown) {
    return resolveVideoDuration(value, 5);
}
function ratio(value: unknown) {
    const text = clean(value);
    return text.toLowerCase() === "auto" ? undefined : normalizeVideoAspectRatio(text);
}
function resolution(value: unknown) {
    const text = clean(value).replace(/p$/i, "");
    if (text.toLowerCase() === "auto") return undefined;
    if (/^\d+$/.test(text)) return `${text}p`;
    return text || undefined;
}
function videoDimensions(size: unknown, quality: unknown): { width?: number; height?: number } {
    const exact = parseImageDimensions(String(size || ""));
    if (exact) return exact;
    const fixedRatio = ratio(size);
    const fixedResolution = resolution(quality);
    if (!fixedRatio || !fixedResolution) return {};
    const [x, y] = fixedRatio.split(":").map(Number);
    const edge = Number(fixedResolution.replace("p", ""));
    if (!x || !y || !edge) return {};
    return x >= y ? { width: Math.round((edge * x) / y), height: edge } : { width: edge, height: Math.round((edge * y) / x) };
}
function sizeValue(value: unknown) {
    const text = clean(value);
    return parseImageDimensions(text) ? text.replace(/\s+/g, "") : ratio(value);
}
function billedPointsCost(value: unknown) {
    if (value === null || value === undefined || value === "") return undefined;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function videoSubmissionBilling(headers: Headers, raw: Record<string, unknown>, multipliers: Awaited<ReturnType<typeof getAuthSettings>>["generationPointMultipliers"]) {
    const pointsCost = billedPointsCost(headers.get("x-vozeb-pro-points-cost"));
    const pointsRecordId = headers.get("x-vozeb-pro-points-record-id") || undefined;
    return pointsCost !== undefined && pointsRecordId ? { pointsCost, pointsUnits: videoUnits(raw, multipliers), pointsRecordId, refunded: false } : undefined;
}

class VideoSubmissionUncertainError extends Error {
    constructor(
        message: string,
        readonly billing?: Pick<VideoTask["upstream"], "pointsCost" | "pointsUnits" | "pointsRecordId" | "refunded">,
    ) {
        super(message);
        this.name = "VideoSubmissionUncertainError";
    }
}
function videoUnits(raw: Record<string, unknown>, multipliers: Awaited<ReturnType<typeof getAuthSettings>>["generationPointMultipliers"]) {
    const quality = clean(raw.vquality).replace(/p$/i, "") || "720";
    const seconds = String(duration(raw.videoSeconds));
    return (multipliers.videoQuality[quality] || 1) * (multipliers.videoSeconds[seconds] || 1);
}
function clean(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}
function booleanValue(value: unknown) {
    return value === true || value === "true";
}
function positiveAttemptNo(value: unknown) {
    const parsed = Math.floor(Number(value));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
function unique(values: string[]) {
    return Array.from(new Set(values.filter(Boolean)));
}
function referenceUrls(items: readonly VideoGenerationReference[], type: VideoGenerationReference["type"]) {
    return unique(items.filter((item) => item.type === type).map((item) => clean(item.url)));
}

function videoReferenceContent(prompt: string, references: readonly VideoGenerationReference[]) {
    return [{ type: "text", text: prompt }, ...videoReferenceMediaContent(references)];
}
function videoReferenceMediaContent(references: readonly VideoGenerationReference[]) {
    return references.map((reference) =>
        reference.type === "image"
            ? { type: "image_url", role: reference.role === "first_frame" || reference.role === "last_frame" ? reference.role : "reference_image", image_url: { url: reference.url } }
            : reference.type === "video"
              ? { type: "video_url", role: "reference_video", video_url: { url: reference.url } }
              : { type: "audio_url", role: "reference_audio", audio_url: { url: reference.url } },
    );
}
function usesStructuredReferenceBody(config: NonNullable<ReturnType<typeof toSystemGenerationChannel>>["advancedConfig"], references: readonly VideoGenerationReference[]) {
    const regularReferences = regularVideoReferences(references);
    if (regularReferences.some((reference) => reference.type === "video" || reference.type === "audio")) return true;
    if (config?.protocol !== "newapi") return false;
    return regularReferences.filter((reference) => reference.type === "image").length > 1 || references.some((reference) => reference.role === "first_frame" || reference.role === "last_frame");
}
function requestPublicOrigin(request: Request) {
    return resolvePublicRequestOrigin(request);
}
function normalizePublicOrigin(value: string) {
    try {
        const url = new URL(value.trim());
        return url.protocol === "http:" || url.protocol === "https:" ? url.origin : "";
    } catch {
        return "";
    }
}
const MEDIA_KEYS = VIDEO_PROVIDER_MEDIA_KEYS;
const SAFE_CREATE_FAILURE_STATUSES = new Set([400, 401, 403, 404, 405, 413, 415, 422, 429]);

class SafeCandidateFailure extends Error {}
