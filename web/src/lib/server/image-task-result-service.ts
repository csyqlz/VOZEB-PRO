import type { ImageTaskMediaResult, ImageTaskResult } from "@/app/api/image-tasks/image-task-types";
import { directRemoteImageResult, imageReferenceToDataUrl, inlineRemoteImageResult, resolveProxiedMediaSource } from "@/app/api/image-tasks/image-task-support";
import { canvasProviderDimensions, parseImageDimensions, resolveResultSize } from "@/app/api/image-tasks/image-task-size";
import { dedupeImageResults } from "@/lib/image-result-dedupe";
import { isCustomGeminiImageModel } from "@/lib/server/custom-gemini-image-model";
import { generationModelId, systemGenerationChannelId } from "@/lib/server/generation-channel";
import { generationMediaProxyHeaders } from "@/lib/server/generation-media-authorization";
import { deleteLocalAsset, normalizeAssets } from "@/lib/server/generation-log-repository";
import { validateImageLayerOutputs } from "@/lib/server/image-layer-output";
import type { ImageTask, ImageTaskResultEvidence, StoredImageTaskMediaResult } from "@/lib/server/image-task-store";
import { assertTransparentImageOutput } from "@/lib/server/image-transparent-output";
import { decodeEcommerceCanvasSize } from "@/lib/server/ecommerce-generation-service";
import { compositeSceneEdit } from "./ecommerce-product-regions";
import { ecommerceSceneProtectionReferencesMatch } from "./ecommerce-image-task-orchestration";

export type PreparedImageTaskResults = { results: StoredImageTaskMediaResult[]; batchEvidence?: ImageTaskResultEvidence[] };

export async function prepareImageTaskResults(task: ImageTask, result: ImageTaskResult, origin: string, authContext: string): Promise<PreparedImageTaskResults> {
    const preserveLayers = task.config.outputMode === "layers";
    const preserveResults = preserveLayers || Boolean(task.ecommerceExecution?.canvas || task.sceneProtection);
    const settled = await Promise.allSettled(imageTaskMediaResults(result, preserveResults).map((item) => normalizeSafeImageResult(task, item, origin, authContext)));
    if (task.ecommerceExecution?.canvas && !preserveLayers && !task.sceneProtection) return persistCanvasBatch(task, settled);
    const normalized = settled.flatMap((item) => (item.status === "fulfilled" && item.value?.dataUrl ? [item.value] : []));
    let safeResults = preserveResults ? normalized : dedupeImageResults(normalized);

    if (preserveLayers) {
        const rejected = firstRejected(settled);
        if (rejected) throw new Error(`上游分层验收失败：${errorMessage(rejected, "上游分层图片无法读取")}，请为该模型配置真实分层接口`);
    }
    if (!safeResults.length) throw firstRejected(settled) || new Error("上游返回的图片文件无效或保存失败");
    if (task.sceneProtection && firstRejected(settled)) throw firstRejected(settled);
    if (task.sceneProtection) return { results: await persistSceneProtectionResults(task, safeResults, origin, authContext) };

    if (task.config.outputBackground === "transparent") {
        const validated = await Promise.allSettled(safeResults.map(async (item) => (await assertTransparentImageOutput(item.dataUrl), item)));
        safeResults = validated.flatMap((item) => (item.status === "fulfilled" ? [item.value] : []));
        if (!safeResults.length) throw firstRejected(validated) || new Error("上游没有生成有效透明图层");
    }

    if (preserveLayers) {
        if (task.kind !== "edit" || task.references.length !== 1) throw new Error("上游分层验收失败：电商分层需要且只能使用一张源图，请为该模型配置真实分层接口");
        try {
            const source = await imageReferenceToDataUrl(task.references[0], task.references[0].name || "source.png", origin, authContext);
            const validated = await validateImageLayerOutputs(
                source,
                safeResults.map((item) => item.dataUrl),
            );
            safeResults = validated.map((output, index) => ({ ...safeResults[index], ...output, remoteUrl: undefined }));
        } catch (error) {
            throw new Error(`上游分层验收失败：${errorMessage(error, "上游分层结果无法验证")}，请为该模型配置真实分层接口`);
        }
    }

    return { results: await persistPreparedResults(task, safeResults, preserveLayers) };
}

async function persistCanvasBatch(task: ImageTask, normalized: PromiseSettledResult<ImageTaskMediaResult>[]): Promise<PreparedImageTaskResults> {
    const canvas = task.ecommerceExecution!.canvas!;
    const batchEvidence: ImageTaskResultEvidence[] = normalized.map((_, index) => ({ resultId: `${task.id}:${index + 1}`, resultIndex: index + 1, nativeStatus: "unavailable", storageStatus: "unavailable" }));
    const prepared = await Promise.all(
        normalized.map(async (item, index): Promise<StoredImageTaskMediaResult | null> => {
            const evidence = batchEvidence[index];
            if (item.status === "rejected") {
                Object.assign(evidence, { failureStage: "read", failureReason: "上游原生图片无法读取" });
                return null;
            }
            try {
                evidence.nativeSize = await decodeEcommerceCanvasSize(Buffer.from(item.value.dataUrl.split(",")[1], "base64"));
                evidence.nativeStatus = "readable";
            } catch {
                Object.assign(evidence, { failureStage: "decode", failureReason: "上游原生图片无法解码" });
                return null;
            }
            if (task.config.outputBackground === "transparent") {
                try {
                    await assertTransparentImageOutput(item.value.dataUrl);
                } catch {
                    Object.assign(evidence, { failureStage: "validation", failureReason: "上游图片透明背景验收失败" });
                    return null;
                }
            }
            try {
                const [asset] = await normalizeAssets([{ type: "image", url: item.value.dataUrl, remoteUrl: item.value.remoteUrl }], {
                    ownerUserId: task.userId,
                    source: task.source,
                    conversationId: task.conversationId,
                    taskId: task.id,
                    originalName: `${task.title || task.prompt.slice(0, 80) || "图片生成"}-${index + 1}`,
                });
                if (!asset?.serverUrl) throw new Error("原生图片保存失败");
                evidence.storageStatus = "stored";
                evidence.storedUrl = asset.serverUrl;
                if (asset.width && asset.height) evidence.storedSize = { width: asset.width, height: asset.height };
                return {
                    resultId: evidence.resultId,
                    dataUrl: asset.serverUrl,
                    remoteUrl: asset.remoteUrl,
                    serverUrl: asset.serverUrl,
                    width: asset.width,
                    height: asset.height,
                    bytes: asset.bytes,
                    mimeType: asset.mimeType,
                    canvasEvidence: {
                        constraint: structuredClone(canvas),
                        ...(task.ecommerceCanvasRequest ? { providerRequest: { ...task.ecommerceCanvasRequest }, requestedSize: canvasProviderDimensions(task.ecommerceCanvasRequest) } : {}),
                        nativeSize: evidence.nativeSize,
                        storedSize: { width: asset.width!, height: asset.height! },
                        nativeUrl: asset.serverUrl,
                        normalization: "none",
                    },
                };
            } catch {
                Object.assign(evidence, { failureStage: "store", failureReason: "原生图片保存失败" });
                return null;
            }
        }),
    );
    return { results: prepared.filter((item): item is StoredImageTaskMediaResult => item !== null), batchEvidence };
}

export function persistedImageTaskResults(task: ImageTask): StoredImageTaskMediaResult[] {
    const values = task.result?.results?.length ? task.result.results : task.result ? [task.result] : [];
    if (!values.length || values.some((item) => !isStableServerResult(item))) return [];
    return values;
}

export function deletePreparedImageTaskResults(results: StoredImageTaskMediaResult[]) {
    return Promise.allSettled(results.flatMap((item) => [item.serverUrl || item.dataUrl, item.sceneProtectionEvidence?.maskUrl, item.sceneProtectionEvidence?.nativeUrl].filter((url): url is string => Boolean(url))).map((url) => deleteLocalAsset(url)));
}

async function persistSceneProtectionResults(task: ImageTask, results: ImageTaskMediaResult[], origin: string, authContext: string): Promise<StoredImageTaskMediaResult[]> {
    const protection = task.sceneProtection!;
    const reference = task.references.find((item) => item.id === protection.sourceAssetId);
    if (task.kind !== "edit" || !ecommerceSceneProtectionReferencesMatch(protection.sourceAssetId, task.references, task.ecommerceExecution) || !reference || task.mask?.dataUrl !== protection.mask.dataUrl)
        throw new Error("局部场景缺少完整原图与独立蒙版");
    const source = Buffer.from((await imageReferenceToDataUrl(reference, "scene.png", origin, authContext)).split(",")[1], "base64");
    // Validate source, mask and native aspect before any save; retain native bytes separately from the protected delivery.
    const composites = await Promise.all(results.map((item) => compositeSceneEdit(source, Buffer.from(item.dataUrl.split(",")[1], "base64"), protection)));
    const context = { ownerUserId: task.userId, source: task.source, conversationId: task.conversationId, taskId: task.id };
    const stored: StoredImageTaskMediaResult[] = [];
    const written: string[] = [];
    const save = async (url: string, originalName: string) => {
        const [asset] = await normalizeAssets([{ type: "image", url }], { ...context, originalName });
        if (!asset?.serverUrl) throw new Error("场景保护证据保存失败");
        written.push(asset.serverUrl);
        return asset;
    };
    try {
        const mask = await save(protection.mask.dataUrl, "scene-edit-mask.png");
        for (let index = 0; index < results.length; index++) {
            const native = await save(results[index].dataUrl, `scene-edit-native-${index + 1}.png`);
            const composite = await save("data:image/png;base64," + composites[index].bytes.toString("base64"), `scene-edit-composite-${index + 1}.png`);
            const canvas = task.ecommerceExecution?.canvas;
            stored.push({
                dataUrl: composite.serverUrl!,
                serverUrl: composite.serverUrl,
                width: composite.width,
                height: composite.height,
                bytes: composite.bytes,
                mimeType: composite.mimeType,
                ...(canvas
                    ? {
                          canvasEvidence: {
                              constraint: structuredClone(canvas),
                              ...(task.ecommerceCanvasRequest ? { providerRequest: { ...task.ecommerceCanvasRequest }, requestedSize: canvasProviderDimensions(task.ecommerceCanvasRequest) } : {}),
                              nativeSize: { width: native.width!, height: native.height! },
                              storedSize: { width: composite.width!, height: composite.height! },
                              nativeUrl: native.serverUrl!,
                              normalization: composites[index].evidence.normalization,
                          },
                      }
                    : {}),
                sceneProtectionEvidence: { ...composites[index].evidence, maskUrl: mask.serverUrl!, nativeUrl: native.serverUrl!, compositeUrl: composite.serverUrl! },
            });
        }
        return stored;
    } catch (error) {
        await Promise.allSettled(written.map((url) => deleteLocalAsset(url)));
        throw error;
    }
}

async function persistPreparedResults(task: ImageTask, results: ImageTaskMediaResult[], requireAll: boolean) {
    const canvas = task.ecommerceExecution?.canvas;
    const nativeSizes = canvas ? await Promise.all(results.map((item) => decodeEcommerceCanvasSize(Buffer.from(item.dataUrl.split(",")[1], "base64")))) : [];
    const preserveNativeSize = task.config.advancedConfig?.protocol === "custom" && isCustomGeminiImageModel(task.config.model) && !parseImageDimensions(task.config.size || "");
    const targetSize = canvas || task.config.outputMode === "layers" || preserveNativeSize ? undefined : resolveResultSize(task.config.quality, task.config.size || "auto");
    const settled = await Promise.allSettled(
        results.map((item, index) =>
            normalizeAssets([{ type: "image", url: item.dataUrl, remoteUrl: item.remoteUrl, targetSize }], {
                ownerUserId: task.userId,
                source: task.source,
                conversationId: task.conversationId,
                taskId: task.id,
                originalName: `${task.title || task.prompt.slice(0, 80) || "图片生成"}-${index + 1}`,
            }),
        ),
    );
    const stored = settled
        .flatMap((item, index) => (item.status === "fulfilled" ? item.value.map((asset) => ({ asset, nativeSize: nativeSizes[index] })) : []))
        .map(({ asset, nativeSize }) => ({
            dataUrl: asset.serverUrl || asset.url,
            remoteUrl: asset.remoteUrl,
            serverUrl: asset.serverUrl,
            width: asset.width,
            height: asset.height,
            bytes: asset.bytes,
            mimeType: asset.mimeType,
            ...(canvas
                ? {
                      canvasEvidence: {
                          constraint: { ...canvas, size: { ...canvas.size } },
                          ...(task.ecommerceCanvasRequest ? { providerRequest: { ...task.ecommerceCanvasRequest }, requestedSize: canvasProviderDimensions(task.ecommerceCanvasRequest) } : {}),
                          nativeSize,
                          storedSize: { width: asset.width!, height: asset.height! },
                          nativeUrl: asset.serverUrl || asset.url,
                          normalization: "none" as const,
                      },
                  }
                : {}),
        }));
    if (requireAll && stored.length !== results.length) {
        await deletePreparedImageTaskResults(stored);
        throw firstRejected(settled) || new Error("上游分层图片保存失败");
    }
    if (!stored.length) throw firstRejected(settled) || new Error("生成图片保存到服务器失败");
    return stored;
}

function imageTaskMediaResults(result: ImageTaskResult, preserveDuplicates: boolean): ImageTaskMediaResult[] {
    const values = result.results?.length ? result.results : result.dataUrl || result.remoteUrl ? [{ dataUrl: result.dataUrl, remoteUrl: result.remoteUrl }] : [];
    return preserveDuplicates ? values : dedupeImageResults(values);
}

async function normalizeSafeImageResult(task: ImageTask, result: ImageTaskMediaResult, origin: string, authContext: string): Promise<ImageTaskMediaResult> {
    const remoteUrl = typeof result.remoteUrl === "string" ? result.remoteUrl : undefined;
    const proxiedMedia = resolveProxiedMediaSource(result.dataUrl || "", origin);
    const proxiedRemoteUrl = proxiedMedia.remoteUrl;
    const channelId = task.config.channelId || systemGenerationChannelId(task.config.baseUrl);
    const mediaHeaders = proxiedRemoteUrl && channelId ? generationMediaProxyHeaders({ userId: task.userId, taskType: "image", taskId: task.id, channelId, upstreamModel: generationModelId(task.config), url: proxiedRemoteUrl }) : undefined;
    const inlineResult = proxiedMedia.proxyUrl ? await inlineRemoteImageResult(result.dataUrl, origin, authContext, remoteUrl, mediaHeaders) : null;
    if (proxiedMedia.proxyUrl && !inlineResult?.dataUrl?.startsWith("data:image/")) throw new Error("上游图片无法通过授权媒体路径读取");
    if (task.config.outputMode === "layers" || task.ecommerceExecution?.canvas || task.sceneProtection) {
        const readable = inlineResult || (await inlineRemoteImageResult(result.dataUrl || remoteUrl || "", origin, authContext, remoteUrl, mediaHeaders));
        if (!readable?.dataUrl?.startsWith("data:image/")) throw new Error("上游原生图片无法读取并验收");
        return readable;
    }
    return inlineResult || directRemoteImageResult(remoteUrl) || (await inlineRemoteImageResult(result.dataUrl, origin, authContext, remoteUrl, mediaHeaders));
}

function isStableServerResult(result: StoredImageTaskMediaResult) {
    const value = result.serverUrl || result.dataUrl;
    return value.startsWith("/api/generation-log-assets/") || value.startsWith("/api/reference-assets/");
}

function firstRejected(results: PromiseSettledResult<unknown>[]) {
    return results.find((item): item is PromiseRejectedResult => item.status === "rejected")?.reason;
}

function errorMessage(error: unknown, fallback: string) {
    return error instanceof Error ? error.message : fallback;
}
