import type { ImageTaskMediaResult, ImageTaskResult } from "@/app/api/image-tasks/image-task-types";
import { directRemoteImageResult, imageReferenceToDataUrl, inlineRemoteImageResult, resolveProxiedMediaSource } from "@/app/api/image-tasks/image-task-support";
import { resolveResultSize } from "@/app/api/image-tasks/image-task-size";
import { dedupeImageResults } from "@/lib/image-result-dedupe";
import { generationModelId, systemGenerationChannelId } from "@/lib/server/generation-channel";
import { generationMediaProxyHeaders } from "@/lib/server/generation-media-authorization";
import { deleteLocalAsset, normalizeAssets } from "@/lib/server/generation-log-repository";
import { validateImageLayerOutputs } from "@/lib/server/image-layer-output";
import type { ImageTask, StoredImageTaskMediaResult } from "@/lib/server/image-task-store";
import { assertTransparentImageOutput } from "@/lib/server/image-transparent-output";

export async function prepareImageTaskResults(task: ImageTask, result: ImageTaskResult, origin: string, authContext: string): Promise<StoredImageTaskMediaResult[]> {
    const preserveLayers = task.config.outputMode === "layers";
    const settled = await Promise.allSettled(imageTaskMediaResults(result, preserveLayers).map((item) => normalizeSafeImageResult(task, item, origin, authContext)));
    const normalized = settled.flatMap((item) => (item.status === "fulfilled" && item.value?.dataUrl ? [item.value] : []));
    let safeResults = preserveLayers ? normalized : dedupeImageResults(normalized);

    if (preserveLayers) {
        const rejected = firstRejected(settled);
        if (rejected) throw new Error(`上游分层验收失败：${errorMessage(rejected, "上游分层图片无法读取")}，请为该模型配置真实分层接口`);
    }
    if (!safeResults.length) throw firstRejected(settled) || new Error("上游返回的图片文件无效或保存失败");

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

    return persistPreparedResults(task, safeResults, preserveLayers);
}

export function persistedImageTaskResults(task: ImageTask): StoredImageTaskMediaResult[] {
    const values = task.result?.results?.length ? task.result.results : task.result ? [task.result] : [];
    if (!values.length || values.some((item) => !isStableServerResult(item))) return [];
    return values;
}

export function deletePreparedImageTaskResults(results: StoredImageTaskMediaResult[]) {
    return Promise.allSettled(results.map((item) => deleteLocalAsset(item.serverUrl || item.dataUrl)));
}

async function persistPreparedResults(task: ImageTask, results: ImageTaskMediaResult[], requireAll: boolean) {
    const targetSize = task.config.outputMode === "layers" ? undefined : resolveResultSize(task.config.quality, task.config.size || "auto");
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
        .flatMap((item) => (item.status === "fulfilled" ? item.value : []))
        .map((asset) => ({
            dataUrl: asset.serverUrl || asset.url,
            remoteUrl: asset.remoteUrl,
            serverUrl: asset.serverUrl,
            width: asset.width,
            height: asset.height,
            bytes: asset.bytes,
            mimeType: asset.mimeType,
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
    if (task.config.outputMode === "layers") {
        const readable = inlineResult || (await inlineRemoteImageResult(result.dataUrl || remoteUrl || "", origin, authContext, remoteUrl, mediaHeaders));
        if (!readable?.dataUrl?.startsWith("data:image/")) throw new Error("上游分层图片无法读取并验收");
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
