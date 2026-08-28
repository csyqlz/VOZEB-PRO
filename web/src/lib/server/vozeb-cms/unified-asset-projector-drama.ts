import type { VozebCmsAsset } from "@/lib/vozeb-cms/unified-resource-contract";
import { compactMetadata, isoDate, positiveVersion, projectAssetOwnership, resolveAssetUrl, type AssetProjectionContext } from "./unified-asset-projector-core";

export type DramaNamedAssetKind = "character" | "scene" | "prop" | "clue";
export type DramaNamedAssetSource = {
    userId: string;
    projectId: string;
    projectUpdatedAt?: string | number | Date;
    kind: DramaNamedAssetKind;
    asset: { id: string; name: string; description?: string; primaryReferenceId?: string; referenceImageUrl?: string; referenceStorageKey?: string; references?: Array<{ id: string; url: string; storageKey?: string; source?: string }>; version?: number };
};
export type DramaSourceAssetSource = {
    userId: string;
    projectId: string;
    projectUpdatedAt?: string | number | Date;
    asset: { id: string; type: string; title: string; textContent?: string; storageKey?: string; remoteUrl?: string; serverUrl?: string; mimeType?: string; width?: number; height?: number };
};
export type DramaMediaAssetKind = "storyboard-first" | "storyboard-last" | "video" | "audio" | "composite";
export type DramaMediaAssetSource = {
    userId: string;
    projectId: string;
    projectUpdatedAt?: string | number | Date;
    kind: DramaMediaAssetKind;
    episodeId: string;
    shotId?: string;
    sceneId?: string;
    url?: string;
    storageKey?: string;
    taskId?: string;
    runId?: string;
    width?: number;
    height?: number;
    mimeType?: string;
};

export function projectDramaNamedAsset(source: DramaNamedAssetSource, context: AssetProjectionContext = {}): VozebCmsAsset {
    const reference = source.asset.references?.find((item) => item.id === source.asset.primaryReferenceId) || source.asset.references?.[0];
    return {
        id: `drama-${source.kind}:${source.asset.id}`,
        ...projectAssetOwnership(source.userId, context, source.projectId),
        type: source.kind,
        url: resolveAssetUrl({ url: reference?.url || source.asset.referenceImageUrl, storageKey: reference?.storageKey || source.asset.referenceStorageKey }),
        source: "drama",
        version: positiveVersion(source.asset.version),
        metadata: compactMetadata({
            title: source.asset.name,
            description: source.asset.description,
            assetId: source.asset.id,
            referenceId: reference?.id,
            referenceSource: reference?.source,
            referenceStorageKey: reference?.storageKey || source.asset.referenceStorageKey,
            referenceCount: source.asset.references?.length || 0,
            ...context.metadata,
        }),
        created_at: isoDate(source.projectUpdatedAt),
    };
}

export function projectDramaSourceAsset(source: DramaSourceAssetSource, context: AssetProjectionContext = {}): VozebCmsAsset {
    return {
        id: `drama-source:${source.asset.id}`,
        ...projectAssetOwnership(source.userId, context, source.projectId),
        type: source.asset.type,
        url: resolveAssetUrl(source.asset),
        source: "drama",
        version: 1,
        metadata: compactMetadata({
            title: source.asset.title,
            sourceAssetId: source.asset.id,
            storageKey: source.asset.storageKey,
            mimeType: source.asset.mimeType,
            width: source.asset.width,
            height: source.asset.height,
            textContent: source.asset.textContent,
            ...context.metadata,
        }),
        created_at: isoDate(source.projectUpdatedAt),
    };
}

export function projectDramaMediaAsset(source: DramaMediaAssetSource, context: AssetProjectionContext = {}): VozebCmsAsset | undefined {
    const url = resolveAssetUrl(source);
    if (!url) return undefined;
    return {
        id: dramaMediaId(source),
        ...projectAssetOwnership(source.userId, context, source.projectId),
        type: source.kind === "audio" ? "audio" : source.kind.startsWith("storyboard-") ? "image" : "video",
        url,
        source: "drama",
        ...(source.taskId ? { task_id: source.taskId } : {}),
        ...(source.runId ? { run_id: source.runId } : {}),
        version: 1,
        metadata: compactMetadata({
            episodeId: source.episodeId,
            shotId: source.shotId,
            sceneId: source.sceneId,
            role: source.kind,
            storageKey: source.storageKey,
            mimeType: source.mimeType,
            width: source.width,
            height: source.height,
            taskId: source.taskId,
            runId: source.runId,
            ...context.metadata,
        }),
        created_at: isoDate(source.projectUpdatedAt),
    };
}

function dramaMediaId(source: DramaMediaAssetSource) {
    if (source.kind === "storyboard-first" || source.kind === "storyboard-last") return `drama-storyboard:${source.episodeId}:${source.shotId}:${source.kind === "storyboard-first" ? "first" : "last"}`;
    if (source.kind === "composite") return `drama-composite:${source.episodeId}`;
    return `drama-${source.kind}:${source.episodeId}:${source.shotId}`;
}
