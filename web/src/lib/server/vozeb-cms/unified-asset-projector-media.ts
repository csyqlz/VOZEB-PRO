import type { CreativeAsset } from "@/lib/creative-runtime-contract";
import type { Asset as LibraryAsset } from "@/lib/library-asset-contract";
import type { VozebCmsAsset } from "@/lib/vozeb-cms/unified-resource-contract";
import { compactMetadata, isoDate, object, positiveVersion, projectAssetOwnership, resolveAssetUrl, safeUrl, type AssetProjectionContext } from "./unified-asset-projector-core";

export type CreativeAssetSource = { asset: CreativeAsset; projectId?: string; projectType?: "canvas" | "drama" | "conversation" };
export type LibraryAssetSource = { userId: string; asset: LibraryAsset };

export function projectCreativeAsset(source: CreativeAssetSource, context: AssetProjectionContext = {}): VozebCmsAsset {
    const asset = source.asset;
    const projectRef = context.projectRef || (source.projectId && source.projectType ? { id: source.projectId, type: source.projectType } : undefined);
    return {
        id: `creative:${asset.id}`,
        ...projectAssetOwnership(asset.userId, { ...context, projectRef }, source.projectId),
        type: asset.type,
        url: resolveAssetUrl(asset),
        source: asset.metadata.source === "upload" ? "upload" : "generation",
        ...(asset.sourceTaskId ? { task_id: asset.sourceTaskId } : {}),
        ...(asset.sourceRunId ? { run_id: asset.sourceRunId } : {}),
        version: positiveVersion(asset.metadata.version),
        metadata: compactMetadata({
            title: asset.title,
            conversationId: asset.conversationId,
            messageId: asset.messageId,
            storageKey: asset.storageKey,
            mimeType: asset.mimeType,
            width: asset.width,
            height: asset.height,
            durationMs: asset.durationMs,
            bytes: asset.bytes,
            sourceTaskId: asset.sourceTaskId,
            sourceRunId: asset.sourceRunId,
            ...asset.metadata,
        }),
        created_at: isoDate(asset.createdAt),
    };
}

export function projectLibraryAsset(source: LibraryAssetSource): VozebCmsAsset {
    const { asset } = source;
    const data = object(asset.data);
    return {
        id: `library:${asset.id}`,
        owner: source.userId,
        type: asset.kind,
        url: resolveAssetUrl({ serverUrl: data.serverUrl, remoteUrl: data.remoteUrl, url: data.url, content: asset.coverUrl, storageKey: data.storageKey }),
        source: "library",
        version: positiveVersion(asset.metadata?.version),
        metadata: compactMetadata({
            title: asset.title,
            coverUrl: safeUrl(asset.coverUrl),
            tags: asset.tags,
            source: asset.source,
            note: asset.note,
            mimeType: data.mimeType,
            width: data.width,
            height: data.height,
            durationMs: data.durationMs,
            bytes: data.bytes,
            storageKey: data.storageKey,
            ...asset.metadata,
        }),
        created_at: isoDate(asset.createdAt),
    };
}
