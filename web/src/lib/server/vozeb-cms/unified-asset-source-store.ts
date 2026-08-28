import type { Asset as LibraryAsset } from "@/lib/library-asset-contract";
import { readJsonDataFile } from "@/lib/server/data-adapter";
import { ensurePostgresSchema, getDatabaseProvider, postgresQuery } from "@/lib/server/database";
import { object, text } from "./unified-asset-projector-core";
import type { CanvasNodeAssetSource } from "./unified-asset-projector-canvas";
import type { DramaMediaAssetSource, DramaNamedAssetSource, DramaSourceAssetSource } from "./unified-asset-projector-drama";

export type CanvasAssetSources = { nodes: CanvasNodeAssetSource[] };
export type DramaAssetSources = { named: DramaNamedAssetSource[]; sources: DramaSourceAssetSource[]; media: DramaMediaAssetSource[] };

export async function listCanvasAssetSources(userId: string, projectId: string | undefined, limit: number): Promise<CanvasAssetSources> {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<Record<string, unknown>>(
            `SELECT project.id AS project_id, project.updated_at AS project_updated_at, node.value AS node
             FROM canvas_projects project
             CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(project.project_json->'nodes') = 'array' THEN project.project_json->'nodes' ELSE '[]'::jsonb END) WITH ORDINALITY AS node(value, ordinal)
             WHERE project.user_id = $1
               AND ($2::text IS NULL OR project.id = $2)
               AND node.value->>'type' IN ('image', 'panorama', 'video', 'audio')
               AND COALESCE(node.value->'metadata'->>'status', '') <> 'error'
               AND (
                    COALESCE(btrim(node.value->'metadata'->>'serverUrl'), '') <> ''
                 OR COALESCE(btrim(node.value->'metadata'->>'remoteUrl'), '') <> ''
                 OR COALESCE(btrim(node.value->'metadata'->>'url'), '') <> ''
                 OR COALESCE(btrim(node.value->'metadata'->>'content'), '') <> ''
                 OR COALESCE(btrim(node.value->'metadata'->>'storageKey'), '') <> ''
               )
             ORDER BY project.updated_at DESC, project.id ASC, node.ordinal DESC
             LIMIT $3`,
            [userId, projectId || null, limit],
        );
        return { nodes: result.rows.map((row) => ({ userId, projectId: text(row.project_id), projectUpdatedAt: timestamp(row.project_updated_at), node: object(row.node) })) };
    }
    const database = await readJsonDataFile<{ projects?: Array<{ userId?: string; project?: Record<string, unknown> }> }>("canvas-projects.json", { projects: [] });
    const nodes = (database.projects || [])
        .filter((record) => record.userId === userId && (!projectId || text(record.project?.id) === projectId))
        .sort((a, b) => text(b.project?.updatedAt).localeCompare(text(a.project?.updatedAt)))
        .flatMap((record) => {
            const project = object(record.project);
            return array(project.nodes).flatMap((node) => {
                const source = { userId, projectId: text(project.id), projectUpdatedAt: project.updatedAt as string | undefined, node: object(node) };
                return isCanvasMediaSource(source.node) ? [source] : [];
            });
        })
        .slice(0, limit);
    return { nodes };
}

export async function listDramaAssetSources(userId: string, projectId: string | undefined, limit: number): Promise<DramaAssetSources> {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<Record<string, unknown>>(
            `WITH selected AS (
                 SELECT id, updated_at, project_json
                 FROM drama_projects
                 WHERE user_id = $1 AND ($2::text IS NULL OR id = $2)
                 ORDER BY updated_at DESC, id ASC
                 LIMIT $3
             )
             SELECT selected.id AS project_id, selected.updated_at AS project_updated_at,
                    selected.project_json->'characters' AS characters, selected.project_json->'scenes' AS scenes,
                    selected.project_json->'props' AS props, selected.project_json->'clues' AS clues,
                    selected.project_json->'sourceAssets' AS source_assets, selected.project_json->'episodes' AS episodes
             FROM selected ORDER BY selected.updated_at DESC, selected.id ASC`,
            [userId, projectId || null, limit],
        );
        return result.rows.reduce<DramaAssetSources>((all, row) => mergeDramaSources(all, projectDramaSources(userId, text(row.project_id), timestamp(row.project_updated_at), row)), emptyDramaSources());
    }
    const database = await readJsonDataFile<{ projects?: Array<{ userId?: string; project?: Record<string, unknown> }> }>("drama-projects.json", { projects: [] });
    return (database.projects || [])
        .filter((record) => record.userId === userId && (!projectId || text(record.project?.id) === projectId))
        .sort((a, b) => text(b.project?.updatedAt).localeCompare(text(a.project?.updatedAt)))
        .slice(0, limit)
        .reduce<DramaAssetSources>((all, record) => mergeDramaSources(all, projectDramaSources(userId, text(record.project?.id), text(record.project?.updatedAt), object(record.project))), emptyDramaSources());
}

export async function listLibraryAssetSources(userId: string, limit: number) {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ asset_json: LibraryAsset }>("SELECT asset_json FROM library_assets WHERE user_id = $1 ORDER BY updated_at DESC, id ASC LIMIT $2", [userId, limit]);
        return result.rows.map((row) => ({ userId, asset: row.asset_json }));
    }
    const database = await readJsonDataFile<{ assets?: Array<{ userId?: string; asset?: LibraryAsset }> }>("library-assets.json", { assets: [] });
    return (database.assets || [])
        .filter((record): record is { userId: string; asset: LibraryAsset } => record.userId === userId && Boolean(record.asset))
        .sort((a, b) => b.asset.updatedAt.localeCompare(a.asset.updatedAt) || a.asset.id.localeCompare(b.asset.id))
        .slice(0, limit);
}

export async function listGenerationTaskRunIds(userId: string, taskIds: string[]) {
    const ids = Array.from(new Set(taskIds.map(text).filter(Boolean)));
    if (!ids.length) return {};
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ id: string; run_id?: string | null }>("SELECT id, run_id FROM generation_tasks WHERE user_id = $1 AND id = ANY($2::text[])", [userId, ids]);
        return Object.fromEntries(result.rows.flatMap((row) => (text(row.run_id) ? [[row.id, text(row.run_id)] as [string, string]] : [])));
    }
    const tasks = await readJsonDataFile<Array<{ id?: string; userId?: string; runId?: string }>>("generation-tasks.json", []);
    const idSet = new Set(ids);
    return Object.fromEntries(tasks.filter((task) => task.userId === userId && idSet.has(text(task.id)) && text(task.runId)).map((task) => [text(task.id), text(task.runId)]));
}

function projectDramaSources(userId: string, projectId: string, projectUpdatedAt: string, source: Record<string, unknown>) {
    const named = (
        [
            ["character", source.characters],
            ["scene", source.scenes],
            ["prop", source.props],
            ["clue", source.clues],
        ] as const
    ).flatMap(([kind, values]) => array(values).map((asset) => ({ userId, projectId, projectUpdatedAt, kind, asset: object(asset) as DramaNamedAssetSource["asset"] })));
    const sources = array(source.sourceAssets || source.source_assets).map((asset) => ({ userId, projectId, projectUpdatedAt, asset: object(asset) as DramaSourceAssetSource["asset"] }));
    const media: DramaMediaAssetSource[] = [];
    for (const episodeValue of array(source.episodes)) {
        const episode = object(episodeValue);
        const episodeId = text(episode.id);
        for (const shotValue of array(episode.shots)) {
            const shot = object(shotValue);
            const shotId = text(shot.id);
            const sceneId = text(shot.sceneId);
            pushDramaMedia(media, {
                userId,
                projectId,
                projectUpdatedAt,
                kind: "storyboard-first",
                episodeId,
                shotId,
                sceneId,
                url: text(shot.storyboardImageUrl),
                storageKey: text(shot.storyboardImageStorageKey),
                taskId: text(shot.storyboardTaskId),
                width: numberValue(shot.storyboardImageWidth),
                height: numberValue(shot.storyboardImageHeight),
            });
            pushDramaMedia(media, {
                userId,
                projectId,
                projectUpdatedAt,
                kind: "storyboard-last",
                episodeId,
                shotId,
                sceneId,
                url: text(shot.storyboardEndImageUrl),
                storageKey: text(shot.storyboardEndImageStorageKey),
                taskId: text(shot.storyboardEndTaskId),
                width: numberValue(shot.storyboardEndImageWidth),
                height: numberValue(shot.storyboardEndImageHeight),
            });
            pushDramaMedia(media, { userId, projectId, projectUpdatedAt, kind: "video", episodeId, shotId, sceneId, url: text(shot.videoUrl), storageKey: text(shot.videoStorageKey), taskId: text(shot.generationTaskId) });
            pushDramaMedia(media, { userId, projectId, projectUpdatedAt, kind: "audio", episodeId, shotId, sceneId, url: text(shot.audioUrl), storageKey: text(shot.audioStorageKey), taskId: text(shot.audioTaskId) });
        }
        const render = object(episode.renderTask);
        const result = object(render.result);
        pushDramaMedia(media, { userId, projectId, projectUpdatedAt, kind: "composite", episodeId, url: text(result.url), taskId: text(render.id) });
    }
    return { named, sources, media } satisfies DramaAssetSources;
}

function pushDramaMedia(target: DramaMediaAssetSource[], source: DramaMediaAssetSource) {
    if (source.url || source.storageKey) target.push(source);
}

function isCanvasMediaSource(node: Record<string, unknown>) {
    if (!["image", "panorama", "video", "audio"].includes(text(node.type))) return false;
    const metadata = object(node.metadata);
    return metadata.status !== "error" && [metadata.serverUrl, metadata.remoteUrl, metadata.url, metadata.content, metadata.storageKey].some((value) => text(value));
}

function emptyDramaSources(): DramaAssetSources {
    return { named: [], sources: [], media: [] };
}

function mergeDramaSources(left: DramaAssetSources, right: DramaAssetSources): DramaAssetSources {
    return { named: [...left.named, ...right.named], sources: [...left.sources, ...right.sources], media: [...left.media, ...right.media] };
}

function array(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    if (typeof value !== "string") return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function numberValue(value: unknown) {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
}

function timestamp(value: unknown) {
    const date = value instanceof Date ? value : new Date(String(value || ""));
    return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString();
}
