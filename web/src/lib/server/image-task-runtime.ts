import { runCustomImageTask, pollCustomImageTask } from "@/app/api/image-tasks/image-task-custom";
import { customGeminiImageTaskPath } from "@/app/api/image-tasks/image-task-gemini-config";
import { EcommerceCanvasAdapterReview } from "@/app/api/image-tasks/image-task-size";
import { runGeminiImageTask } from "@/app/api/image-tasks/image-task-gemini";
import { runOpenAiImageTask } from "@/app/api/image-tasks/image-task-openai";
import { imageUnits, ImageQueryContractError, ImageUpstreamTerminalError, pollOpenAiImageTask } from "@/app/api/image-tasks/image-task-support";
import type { ImageTaskRunResult } from "@/app/api/image-tasks/image-task-types";
import { stableMediaUrl, writeImageGenerationLog } from "@/app/api/image-tasks/image-task-runner";
import { getAuthSettings, refundUserPoints } from "@/lib/auth/store";
import { registerGenerationTaskAssetsForUser } from "@/lib/server/creative-runtime-service";
import { finishGenerationAttempt, startGenerationAttempt } from "@/lib/server/generation-attempt";
import { generationModelId } from "@/lib/server/generation-channel";
import { refundImageTask } from "@/lib/server/image-task-refund";
import { deletePreparedImageTaskResults, persistedImageTaskResults, prepareImageTaskResults } from "@/lib/server/image-task-result-service";
import { scheduleGenerationTask } from "@/lib/server/generation-task-scheduler";
import { GenerationSubmissionSafeFailure, generationSubmissionUncertainError } from "@/lib/server/generation-submission-error";
import { getImageTask, transitionImageTask, updateImageTask, type ImageTask, type StoredImageTaskMediaResult } from "@/lib/server/image-task-store";
import { maintenanceWorkerContext } from "@/lib/server/maintenance-auth";
import { resolveModelRequestTimeoutMs } from "@/lib/server/model-request-policy";
import { imageReferenceToDataUrl, resolveImageTaskEditProtocol } from "@/app/api/image-tasks/image-task-support";
import { validateSceneEditProtection } from "./ecommerce-product-regions";
import { assertEcommerceImageExecutionSnapshot, ecommerceSceneProtectionReferencesMatch } from "./ecommerce-image-task-orchestration";
import { getAgentRun } from "./agent-run-store";
import { assertEcommerceReferenceContent, EcommerceReferenceSourceChangedError, EcommerceReferenceSourceReadError, referenceAssetVersion } from "./ecommerce-reference-recovery";
import { originalImageSourceUrl } from "@/lib/media-image-url";

export type ImageUpstreamStep =
    | { state: "pending"; upstream: NonNullable<ImageTask["upstream"]>; status: string }
    | { state: "needs_review"; reason: string; status: string }
    | { state: "result_ready"; resultUrl: string; status: string }
    | { state: "completed" }
    | { state: "failed"; error: string; status: string; retryReason?: "upstream_failed" };

export async function createImageTaskUpstreamStep(task: ImageTask, origin: string, publicOrigin: string, cookie = "", workerUserId = ""): Promise<ImageUpstreamStep> {
    const current = await getImageTask(task.id);
    if (!current || current.status === "cancelled") return { state: "failed", error: "任务已取消", status: "cancelled" };
    const running = current.status === "pending" ? await transitionImageTask(current, ["pending"], { status: "running" }) : current;
    if (!running) return { state: "failed", error: "图片任务状态已变化", status: "conflict" };
    const prepared = persistedImageTaskResults(running);
    if (prepared.length || running.result?.batchEvidence) return readyImageStep(running, prepared[0]?.serverUrl || prepared[0]?.dataUrl || "");
    if (running.upstream?.id) return queryImageTaskUpstreamStep(running, origin, cookie, workerUserId);
    if (running.ecommerceExecution?.canvas && (customGeminiImageTaskPath(running.config, running.kind) || (!usesDeclarativeImageProtocol(running.config.advancedConfig?.protocol) && running.config.apiFormat === "gemini"))) {
        return { state: "needs_review", reason: new EcommerceCanvasAdapterReview("Gemini generateContent").message, status: "canvas_adapter_unsupported" };
    }

    const authContext = cookie || maintenanceWorkerContext(workerUserId || task.userId);
    let submissionReferences: ImageTask["references"];
    try {
        submissionReferences = await frozenImageSubmissionReferences(running, origin, authContext);
    } catch (error) {
        if (error instanceof EcommerceReferenceSourceChangedError) return { state: "needs_review", reason: error.message, status: "reference_source_changed" };
        const infrastructure = error instanceof EcommerceReferenceValidationUnavailableError;
        return {
            state: "needs_review",
            reason: infrastructure ? "参考任务暂时无法核对，请稍后点击“检查状态”继续原任务。" : "参考图片暂时无法读取，请稍后点击“检查状态”继续原任务。",
            status: infrastructure ? "reference_validation_unavailable" : "reference_source_unavailable",
        };
    }
    if (running.config.apiSource === "system" && running.ecommerceExecution) {
        try {
            assertEcommerceImageExecutionSnapshot(await getAuthSettings(), running.ecommerceExecution, running.config);
        } catch (error) {
            return { state: "needs_review", reason: error instanceof Error ? error.message : "电商生图执行配置已变化", status: "ecommerce_execution_snapshot_changed" };
        }
    }
    const localSceneEdit = running.sceneProtection || (running.ecommerceExecution?.protection?.scope === "local" && !running.productProtection);
    if (running.productProtection || localSceneEdit) {
        try {
            if (!running.mask) throw new Error("局部编辑缺少可信独立蒙版");
            if (!(await resolveImageTaskEditProtocol(running.config)).supportsIndependentMask) throw new Error("当前渠道尚未配置可用的独立蒙版编辑方式，请联系管理员。");
            if (localSceneEdit) {
                if (!running.sceneProtection || !ecommerceSceneProtectionReferencesMatch(running.sceneProtection.sourceAssetId, running.references, running.ecommerceExecution) || running.mask.dataUrl !== running.sceneProtection.mask.dataUrl)
                    throw new Error("局部场景编辑缺少完整原图与可信独立蒙版");
                const source = await imageReferenceToDataUrl(submissionReferences[0], "scene.png", origin, authContext);
                await validateSceneEditProtection(Buffer.from(source.split(",")[1], "base64"), running.sceneProtection);
            }
        } catch (error) {
            return { state: "needs_review", reason: error instanceof Error ? error.message : "局部编辑蒙版无法验证", status: running.productProtection ? "product_mask_review_required" : "scene_mask_review_required" };
        }
    }
    const config = running.config;
    let attempts = running.attempts || [];
    const started = startGenerationAttempt(attempts, { channelId: config.channelId, model: generationModelId(config), capability: "image" });
    attempts = started.attempts;
    const candidate = { ...running, config, attempts, attemptNo: started.attempt.attemptNo, upstream: undefined, billing: undefined };
    await updateImageTask(task.id, { config, attempts, attemptNo: candidate.attemptNo, upstream: undefined, billing: undefined });
    const submissionStartedAt = Date.now();
    await scheduleGenerationTask("image", task.id, {
        executionPhase: "submitting",
        submittedAt: submissionStartedAt,
        nextPollAt: submissionStartedAt + resolveModelRequestTimeoutMs(config, "image"),
        channelId: config.channelId,
        provider: config.advancedConfig?.protocol || config.apiFormat,
        lastUpstreamStatus: "submitting",
    });
    try {
        // Verified source bytes are used only for this submission. Persisted task
        // references and result/log processing retain the stable owned URLs.
        const submission = { ...candidate, references: submissionReferences };
        const result = customGeminiImageTaskPath(config, candidate.kind)
            ? await runGeminiImageTask(submission, origin, authContext)
            : usesDeclarativeImageProtocol(config.advancedConfig?.protocol)
              ? await runCustomImageTask(submission, origin, publicOrigin, authContext, true)
              : config.apiFormat === "gemini"
                ? await runGeminiImageTask(submission, origin, authContext)
                : await runOpenAiImageTask(submission, origin, publicOrigin, authContext, true);
        return await handleImageProviderResult(candidate, result, origin, authContext);
    } catch (error) {
        if (error instanceof EcommerceCanvasAdapterReview) return { state: "needs_review", reason: error.message, status: "canvas_adapter_unsupported" };
        if (error instanceof ImageUpstreamTerminalError) return { state: "failed", error: error.message || "图片生成失败", status: "failed", retryReason: "upstream_failed" };
        if (!(error instanceof GenerationSubmissionSafeFailure)) throw generationSubmissionUncertainError(error, "图片任务创建结果未知");
        attempts = finishGenerationAttempt(attempts, candidate.attemptNo, { status: "failed", error: error.message });
        await refundImageCandidate(candidate);
        await updateImageTask(task.id, { attempts, attemptNo: candidate.attemptNo, upstream: undefined, billing: undefined });
        return { state: "failed", error: error.message, status: "failed" };
    }
}

class EcommerceReferenceValidationUnavailableError extends Error {}

async function frozenImageSubmissionReferences(task: ImageTask, origin: string, authContext: string): Promise<ImageTask["references"]> {
    if (!task.runId) return task.references;
    let parent;
    try {
        parent = await getAgentRun(task.runId);
    } catch {
        throw new EcommerceReferenceValidationUnavailableError();
    }
    const checkpoint = parent?.ecommerceSnapshot?.referenceCheckpoint;
    if (!checkpoint && !task.referenceDispatch) return task.references;
    const fence = task.referenceDispatch;
    if (
        !parent ||
        parent.id !== task.runId ||
        parent.userId !== task.userId ||
        parent.conversationId !== task.conversationId ||
        parent.cancellation ||
        checkpoint?.version !== "ecommerce-reference-checkpoint.v1" ||
        checkpoint.state !== "resolved" ||
        checkpoint.analysisStage.state !== "completed" ||
        checkpoint.planningInput.conversationId !== parent.conversationId ||
        !fence ||
        fence.inputId !== checkpoint.inputId ||
        fence.decisionId !== checkpoint.decisionId ||
        fence.analysisRequestId !== checkpoint.analysisStage.requestId ||
        new Set(task.references.map((reference) => reference.id)).size !== task.references.length
    )
        throw new EcommerceReferenceSourceChangedError();
    const references: ImageTask["references"] = [];
    for (const [index, reference] of task.references.entries()) {
        const item = checkpoint.assets.find((value) => value.asset.id === reference.id);
        const source = checkpoint.planningInput.assetCandidates.find((value) => value.id === reference.id && value.type === "image")?.url;
        if (
            !item ||
            !source ||
            !item.contentSha256 ||
            item.assetVersion !== referenceAssetVersion(item.asset, item.contentSha256) ||
            item.asset.userId !== parent.userId ||
            item.asset.conversationId !== parent.conversationId ||
            item.asset.type !== "image" ||
            item.asset.status !== "ready"
        )
            throw new EcommerceReferenceSourceChangedError();
        const original = { ...reference, dataUrl: "", url: originalImageSourceUrl(source), serverUrl: undefined, remoteUrl: undefined };
        const dataUrl = await imageReferenceToDataUrl(original, reference.name || `reference-${index + 1}.png`, origin, authContext);
        const encoded = dataUrl.match(/^data:image\/[^;,]+;base64,(.+)$/i)?.[1];
        if (!encoded) throw new EcommerceReferenceSourceReadError();
        assertEcommerceReferenceContent(Buffer.from(encoded, "base64"), item.contentSha256);
        references.push({ ...reference, dataUrl, url: undefined, remoteUrl: undefined, serverUrl: undefined });
    }
    return references;
}

export async function queryImageTaskUpstreamStep(task: ImageTask, origin: string, cookie = "", workerUserId = ""): Promise<ImageUpstreamStep> {
    const prepared = persistedImageTaskResults(task);
    if (prepared.length || task.result?.batchEvidence) return readyImageStep(task, prepared[0]?.serverUrl || prepared[0]?.dataUrl || "");
    const upstream = task.upstream;
    if (!upstream?.id) return { state: "failed", error: "图片任务缺少上游任务 ID", status: "missing_upstream_id" };
    const authContext = cookie || maintenanceWorkerContext(workerUserId || task.userId);
    try {
        const result = usesDeclarativeImageProtocol(task.config.advancedConfig?.protocol)
            ? await pollCustomImageTask(task, upstream.id, upstream.mediaBaseUrl, upstream.pollBaseUrl, authContext, true)
            : await pollOpenAiImageTask(task.config, upstream.id, upstream.mediaBaseUrl, upstream.pollBaseUrl, authContext, upstream.explicitPollUrl || "", true);
        return await handleImageProviderResult(task, { ...result, pointsCost: task.billing?.pointsCost, pointsRecordId: task.billing?.pointsRecordId }, origin, authContext);
    } catch (error) {
        if (error instanceof ImageQueryContractError) return { state: "needs_review", reason: error.message, status: "query_contract_invalid" };
        if (error instanceof ImageUpstreamTerminalError) return { state: "failed", error: error.message, status: "failed", retryReason: "upstream_failed" };
        if (error instanceof GenerationSubmissionSafeFailure) return { state: "failed", error: error.message, status: "failed" };
        throw error;
    }
}

export async function prepareImageTaskAutomaticRetry(task: ImageTask, error: string) {
    const current = (await getImageTask(task.id)) || task;
    if (current.status !== "pending" && current.status !== "running") return null;
    const attemptNo = current.attemptNo || current.attempts?.at(-1)?.attemptNo || 1;
    if (attemptNo >= 2) return null;
    const attempts = finishGenerationAttempt(current.attempts || [], attemptNo, {
        status: "failed",
        error,
        pointsCost: current.billing?.pointsCost,
        pointsRecordId: current.billing?.pointsRecordId,
    });
    await refundImageCandidate(current);
    const nextConfig = current.candidateConfigs?.[0] || current.config;
    return updateImageTask(current.id, {
        config: nextConfig,
        candidateConfigs: [],
        attempts,
        attemptNo,
        upstream: undefined,
        billing: undefined,
        retryable: false,
    });
}

export async function queryCancelledImageTaskUpstreamStep(task: ImageTask, origin: string, cookie = "", workerUserId = "") {
    const upstream = task.upstream;
    if (!upstream?.id) return { state: "terminal" as const, status: "missing_upstream_id" };
    const authContext = cookie || maintenanceWorkerContext(workerUserId || task.userId);
    try {
        const result = usesDeclarativeImageProtocol(task.config.advancedConfig?.protocol)
            ? await pollCustomImageTask(task, upstream.id, upstream.mediaBaseUrl, upstream.pollBaseUrl, authContext, true)
            : await pollOpenAiImageTask(task.config, upstream.id, upstream.mediaBaseUrl, upstream.pollBaseUrl, authContext, upstream.explicitPollUrl || "", true);
        return result.pending ? { state: "pending" as const, status: "processing" } : { state: "terminal" as const, status: "completed" };
    } catch (error) {
        if (error instanceof ImageUpstreamTerminalError || error instanceof GenerationSubmissionSafeFailure) return { state: "terminal" as const, status: "failed" };
        throw error;
    }
}

export async function persistImageTaskResult(task: ImageTask, origin: string, resultUrl: string, cookie = "", workerUserId = "") {
    const authContext = cookie || maintenanceWorkerContext(workerUserId || task.userId);
    const current = (await getImageTask(task.id)) || task;
    let results = persistedImageTaskResults(current);
    if (results.length || current.result?.batchEvidence) return completeImageResult(current, results);

    const inlineDataUrl = resultUrl === "inline://image-task-result" ? current.result?.dataUrl || "" : resultUrl;
    const remoteUrl = resultUrl === "inline://image-task-result" ? current.result?.remoteUrl : /^https?:\/\//i.test(resultUrl) ? resultUrl : undefined;
    if (!inlineDataUrl && !remoteUrl) throw new GenerationSubmissionSafeFailure("图片任务缺少可持久化结果");
    const legacyResults = current.result?.results?.length ? current.result.results : [{ dataUrl: inlineDataUrl, remoteUrl }];
    const normalizedResults = legacyResults.map((item, index) => (index === 0 ? { ...item, dataUrl: inlineDataUrl || item.dataUrl, remoteUrl: remoteUrl || item.remoteUrl } : item));
    let prepared: Awaited<ReturnType<typeof prepareImageTaskResults>>;
    try {
        prepared = await prepareImageTaskResults(current, { ...normalizedResults[0], results: normalizedResults }, origin, authContext);
        results = prepared.results;
    } catch (error) {
        return markImageTaskFailed(current, error instanceof Error ? error.message : "上游返回的图片文件无效或保存失败");
    }
    try {
        await updateImageTask(current.id, { result: { ...(results[0] || { dataUrl: "" }), ...prepared } });
    } catch (error) {
        await deletePreparedImageTaskResults(results);
        throw error;
    }
    return completeImageResult(current, results);
}

export async function markImageTaskFailed(task: ImageTask, error: string) {
    const current = (await getImageTask(task.id)) || task;
    if (current.status === "success" || current.status === "cancelled") return current;
    const attempts = finishGenerationAttempt(current.attempts || [], current.attemptNo || current.attempts?.at(-1)?.attemptNo || 1, {
        status: "failed",
        error,
        pointsCost: current.billing?.pointsCost,
        pointsRecordId: current.billing?.pointsRecordId,
    });
    const failed = await transitionImageTask(current, ["pending", "running"], { status: "error", error: error.slice(0, 500), retryable: true, billing: current.billing });
    if (!failed) {
        const latest = await getImageTask(current.id);
        if (latest?.status === "error" || latest?.status === "cancelled") return refundImageTask(latest);
        return latest;
    }
    await updateImageTask(current.id, { attempts, candidateConfigs: [], attemptNo: attempts.at(-1)?.attemptNo });
    const refunded = await refundImageTask(failed);
    await writeImageGenerationLog({ ...refunded, retryable: true }, "failed", "", Date.now() - current.createdAt, error).catch((logError) => console.error("Image generation failure log write failed", logError));
    return refunded;
}

async function handleImageProviderResult(task: ImageTask, result: ImageTaskRunResult, origin: string, authContext: string): Promise<ImageUpstreamStep> {
    const billing = result.pointsRecordId ? { pointsCost: result.pointsCost ?? 0, pointsRecordId: result.pointsRecordId, refunded: false } : undefined;
    if (billing) await updateImageTask(task.id, { billing });
    if (result.needsReview) {
        const submittedAt = Date.now();
        await updateImageTask(task.id, { upstream: result.needsReview.upstream, billing });
        await scheduleGenerationTask("image", task.id, {
            executionPhase: "needs_review",
            upstreamTaskId: result.needsReview.upstream.id,
            channelId: task.config.channelId,
            provider: task.config.advancedConfig?.protocol || task.config.apiFormat,
            queryPath: result.needsReview.upstream.explicitPollUrl || task.config.advancedConfig?.queryPath,
            submittedAt,
            nextPollAt: undefined,
            lastUpstreamStatus: "query_contract_missing",
            resultPayload: { reviewReason: result.needsReview.reason.slice(0, 500) },
        });
        return { state: "needs_review", reason: result.needsReview.reason, status: "query_contract_missing" };
    }
    if (result.pending) {
        const submittedAt = Date.now();
        await updateImageTask(task.id, { upstream: result.pending, billing });
        await scheduleGenerationTask("image", task.id, {
            executionPhase: "submitted",
            upstreamTaskId: result.pending.id,
            channelId: task.config.channelId,
            provider: task.config.advancedConfig?.protocol || task.config.apiFormat,
            queryPath: result.pending.explicitPollUrl || task.config.advancedConfig?.queryPath,
            submittedAt,
            nextPollAt: submittedAt,
            lastUpstreamStatus: "submitted",
        });
        return { state: "pending", upstream: result.pending, status: "submitted" };
    }
    let prepared: Awaited<ReturnType<typeof prepareImageTaskResults>>;
    try {
        prepared = await prepareImageTaskResults(task, result, origin, authContext);
    } catch (error) {
        return { state: "failed", error: error instanceof Error ? error.message : "上游返回的图片文件无效或保存失败", status: "failed" };
    }
    const results = prepared.results;
    const first = results[0];
    if (!first && !prepared.batchEvidence) return { state: "failed", error: "上游返回的图片文件无效或保存失败", status: "failed" };
    const current = await getImageTask(task.id);
    if (!current || current.status === "cancelled") {
        await deletePreparedImageTaskResults(results);
        return { state: "failed", error: "任务已取消", status: "cancelled" };
    }
    try {
        await updateImageTask(task.id, { result: { ...(first || { dataUrl: "" }), ...prepared } });
    } catch (error) {
        await deletePreparedImageTaskResults(results);
        return { state: "failed", error: error instanceof Error ? error.message : "上游返回的图片文件无效或保存失败", status: "failed" };
    }
    return readyImageStep({ ...task, result: { ...(first || { dataUrl: "" }), ...prepared } }, first?.serverUrl || first?.dataUrl || "");
}

async function readyImageStep(task: ImageTask, resultUrl: string): Promise<ImageUpstreamStep> {
    if (!resultUrl && task.result?.batchEvidence) {
        await completeImageResult(task, []);
        return { state: "completed" };
    }
    if (!stableMediaUrl(resultUrl)) return { state: "failed", error: "上游返回的图片文件无效或保存失败", status: "failed" };
    await persistReadyImageSchedule(task, resultUrl);
    return { state: "result_ready", resultUrl, status: "completed" };
}

function persistReadyImageSchedule(task: ImageTask, resultUrl: string) {
    return scheduleGenerationTask("image", task.id, {
        executionPhase: "result_ready",
        channelId: task.config.channelId,
        provider: task.config.advancedConfig?.protocol || task.config.apiFormat,
        nextPollAt: Date.now(),
        lastUpstreamStatus: "completed",
        resultPayload: { url: resultUrl },
    });
}

async function refundImageCandidate(task: ImageTask) {
    const current = await getImageTask(task.id);
    const billing = current?.billing;
    if (!billing?.pointsRecordId || billing.refunded) return;
    const settings = await getAuthSettings();
    await refundUserPoints(
        task.userId,
        generationModelId(task.config),
        billing.pointsCost,
        "image",
        imageUnits(task.config.quality, settings.generationPointMultipliers.imageQuality),
        `image-task:${task.id}:attempt:${task.attemptNo || 1}:refund`,
        billing.pointsRecordId,
    );
}

async function completeImageResult(task: ImageTask, safeResults: StoredImageTaskMediaResult[]) {
    const beforePersistence = await getImageTask(task.id);
    if (!beforePersistence || beforePersistence.status === "cancelled") {
        if (beforePersistence?.status === "cancelled") await refundImageTask(beforePersistence);
        return beforePersistence;
    }
    task = beforePersistence;
    const current = await getImageTask(task.id);
    if (!current || current.status === "cancelled") {
        if (current?.status === "cancelled") await refundImageTask(current);
        return current;
    }
    const completed = await transitionImageTask(current, ["pending", "running"], {
        status: "success",
        result: { ...(safeResults[0] || { dataUrl: "" }), results: safeResults, ...(task.result?.batchEvidence ? { batchEvidence: task.result.batchEvidence } : {}) },
        pointsRemaining: task.pointsRemaining,
        retryable: false,
    });
    if (!completed) {
        const latest = await getImageTask(task.id);
        if (latest?.status === "cancelled") await refundImageTask(latest);
        return latest;
    }
    const logged = await writeImageGenerationLog(completed, "success", safeResults, Date.now() - completed.createdAt).catch((logError) => {
        console.error("Image generation success log write failed", logError);
        return undefined;
    });
    const loggedAssets = logged?.assets?.length ? logged.assets : logged?.asset ? [logged.asset] : [];
    const finalResults =
        loggedAssets.length && !completed.ecommerceExecution?.canvas && !completed.sceneProtection
            ? loggedAssets.map((asset) => ({ dataUrl: asset.serverUrl || asset.url, remoteUrl: asset.remoteUrl, serverUrl: asset.serverUrl, width: asset.width, height: asset.height, bytes: asset.bytes, mimeType: asset.mimeType }))
            : safeResults;
    const finalResult = finalResults[0];
    const attempts = finishGenerationAttempt(completed.attempts || [], completed.attemptNo || completed.attempts?.at(-1)?.attemptNo || 1, {
        status: "succeeded",
        pointsCost: completed.billing?.pointsCost,
        pointsRecordId: completed.billing?.pointsRecordId,
    });
    const finalized =
        (await updateImageTask(task.id, {
            result: { ...(finalResult || { dataUrl: "" }), results: finalResults, ...(completed.result?.batchEvidence ? { batchEvidence: completed.result.batchEvidence } : {}) },
            config: { ...completed.config, apiKey: "system" },
            candidateConfigs: [],
            attempts,
            attemptNo: attempts.at(-1)?.attemptNo,
        })) || completed;
    const assets = (finalized.result?.results?.length ? finalized.result.results : finalized.result ? [finalized.result] : []).flatMap((item) => {
        const url = item.serverUrl || item.remoteUrl || stableMediaUrl(item.dataUrl);
        return url ? [{ type: "image" as const, url, mimeType: item.mimeType, width: item.width, height: item.height, bytes: item.bytes }] : [];
    });
    if (assets.length)
        await registerGenerationTaskAssetsForUser(finalized.userId, {
            ...finalized,
            taskId: finalized.id,
            title: finalized.title || finalized.prompt.slice(0, 80),
            assets,
        }).catch((error) => console.error("Creative image asset registration failed", error));
    return finalized;
}

function usesDeclarativeImageProtocol(protocol: NonNullable<ImageTask["config"]["advancedConfig"]>["protocol"] | undefined) {
    return protocol === "custom" || protocol === "stable-diffusion" || protocol === "yumeng";
}
