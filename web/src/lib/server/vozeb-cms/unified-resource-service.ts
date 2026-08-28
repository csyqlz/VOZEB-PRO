import type { VozebCmsProjectRef } from "@/lib/vozeb-cms/project-ref";
import type { VozebCmsAsset } from "@/lib/vozeb-cms/unified-resource-contract";
import { listCreativeAssetsForProject } from "@/lib/server/creative-runtime-store";
import { projectCanvasNodeAsset, projectCreativeAsset, projectDramaMediaAsset, projectDramaNamedAsset, projectDramaSourceAsset, projectLibraryAsset, withAssetRunIds } from "./unified-asset-projectors";
import { listCanvasAssetSources, listDramaAssetSources, listGenerationTaskRunIds, listLibraryAssetSources } from "./unified-asset-source-store";

export async function listVozebCmsAssets(userId: string, input: { projectId?: string; projectRef?: VozebCmsProjectRef; limit?: number } = {}) {
    const projectId = clean(input.projectRef?.id || input.projectId);
    const limit = boundedLimit(input.limit, 100);
    const projectType = input.projectRef?.type;
    const includeCanvas = projectType !== "drama" && projectType !== "conversation";
    const includeDrama = projectType !== "canvas" && projectType !== "conversation";
    const [creative, library, canvas, drama] = await Promise.all([
        listCreativeAssetsForProject(userId, projectId, limit, input.projectRef?.type),
        projectId ? Promise.resolve([]) : listLibraryAssetSources(userId, limit),
        includeCanvas ? listCanvasAssetSources(userId, projectId, limit) : Promise.resolve({ nodes: [] }),
        includeDrama ? listDramaAssetSources(userId, projectId, limit) : Promise.resolve({ named: [], sources: [], media: [] }),
    ]);
    const context = { projectId, projectRef: input.projectRef };
    const assets = [
        ...creative.map((asset) => projectCreativeAsset({ asset, projectId, projectType }, context)),
        ...library.map(projectLibraryAsset),
        ...canvas.nodes.flatMap((source) => projectCanvasNodeAsset(source, context) || []),
        ...drama.named.map((source) => projectDramaNamedAsset(source, context)),
        ...drama.sources.map((source) => projectDramaSourceAsset(source, context)),
        ...drama.media.flatMap((source) => projectDramaMediaAsset(source, context) || []),
    ];
    const runIds = await listGenerationTaskRunIds(
        userId,
        assets.flatMap((asset) => asset.task_id || []),
    );
    return assets
        .map((asset) => withAssetRunIds(asset, runIds))
        .filter(uniqueAssetId())
        .sort((left, right) => right.created_at.localeCompare(left.created_at) || left.id.localeCompare(right.id))
        .slice(0, limit);
}

function clean(value: unknown) {
    return typeof value === "string" && value.trim() ? value.trim().slice(0, 160) : undefined;
}

function boundedLimit(value: unknown, fallback: number) {
    const limit = Number(value);
    return Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : fallback;
}

function uniqueAssetId() {
    const ids = new Set<string>();
    return (asset: VozebCmsAsset) => {
        if (ids.has(asset.id)) return false;
        ids.add(asset.id);
        return true;
    };
}
