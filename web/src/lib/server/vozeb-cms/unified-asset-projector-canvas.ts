import type { VozebCmsAsset } from "@/lib/vozeb-cms/unified-resource-contract";
import { compactMetadata, firstText, isoDate, mediaAssetType, object, positiveVersion, projectAssetOwnership, resolveAssetUrl, text, type AssetProjectionContext } from "./unified-asset-projector-core";

export type CanvasNodeAssetSource = { userId: string; projectId: string; projectUpdatedAt?: string | number | Date; node: Record<string, unknown> };

export function projectCanvasNodeAsset(source: CanvasNodeAssetSource, context: AssetProjectionContext = {}): VozebCmsAsset | undefined {
    const type = mediaAssetType(source.node.type);
    const nodeId = text(source.node.id);
    if (!type || !nodeId || !source.projectId) return undefined;
    const metadata = object(source.node.metadata);
    const taskId = firstText(metadata.agentGenerationTaskIds) || text(object(metadata.imageTask).id) || text(object(metadata.videoTask).id) || text(object(metadata.audioTask).id) || text(metadata.agentTaskId);
    const runId = text(metadata.agentRunId);
    const storageKey = text(metadata.storageKey);
    const url = resolveAssetUrl({ serverUrl: metadata.serverUrl, remoteUrl: metadata.remoteUrl, url: metadata.url, content: metadata.content, storageKey });
    if (!url && !storageKey) return undefined;
    return {
        id: `canvas-node:${source.projectId}:${nodeId}`,
        ...projectAssetOwnership(source.userId, context, source.projectId),
        type,
        url,
        source: "canvas",
        ...(taskId ? { task_id: taskId } : {}),
        ...(runId ? { run_id: runId } : {}),
        version: positiveVersion(metadata.version),
        metadata: compactMetadata({
            title: text(source.node.title),
            nodeId,
            storageKey,
            mimeType: metadata.mimeType,
            naturalWidth: metadata.naturalWidth,
            naturalHeight: metadata.naturalHeight,
            width: metadata.width,
            height: metadata.height,
            durationMs: metadata.durationMs,
            bytes: metadata.bytes,
            status: metadata.status,
            taskId,
            runId,
            ...context.metadata,
        }),
        created_at: isoDate(metadata.createdAt || source.projectUpdatedAt),
    };
}
