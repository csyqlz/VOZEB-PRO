import { randomUUID } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import { ensureMediaFileExtension, mediaFileExtension } from "@/lib/media-file";
import type { GenerationLogReferenceSnapshot, GenerationLogRequestSnapshot, GenerationLogSlotSnapshot, GenerationLogSnapshotParameters } from "@/lib/generation-log-snapshot";
import { isPostgresDatabaseEnabled, type QueryExecutor } from "@/lib/server/database";
import { readJsonDataFile, withJsonDataFileLock, writeJsonDataFile } from "@/lib/server/data-adapter";
import { normalizeGeneratedImageBytes } from "@/lib/server/generated-image-normalizer";
import { resolveMediaMimeType } from "@/lib/server/media-content-type";
import { createDatedMediaPath, GENERATION_MEDIA_ROOT } from "@/lib/server/local-media-storage";
import { deleteLocalMediaRegistrations, getLocalMediaRegistration, registerLocalMediaAsset } from "@/lib/server/local-media-registry";
import { deleteExternalMediaObject, persistExternalMediaIfEnabled } from "@/lib/server/object-storage-service";
import { fetchSafeOutbound } from "@/lib/server/safe-outbound-fetch";
import { isSafeOutboundUrl } from "@/lib/server/security";
import type { GenerationLogAsset, GenerationLogDatabase, GenerationLogKind, GenerationLogSource, GenerationLogStatus, StoredGenerationLog } from "./generation-log-types";
import { normalizeEcommerceGenerationTrace } from "./ecommerce-generation-trace";

const LOG_DATA_FILE = "generation-logs.json";
const ASSET_ROOT = GENERATION_MEDIA_ROOT;
const MAX_SERVER_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_SERVER_VIDEO_BYTES = 300 * 1024 * 1024;
const SERVER_ASSET_DOWNLOAD_TIMEOUT_MS = 15000;

let mutationQueue = Promise.resolve();

export function sourceLabel(source: string) {
    if (source === "agent") return "Agent 工作台";
    if (source === "image-workbench") return "图片生成";
    if (source === "video-workbench") return "视频生成";
    if (source === "canvas") return "画布";
    if (source === "drama") return "短剧";
    return "未知入口";
}

export function kindLabel(kind: string) {
    return kind === "video" ? "视频" : "图片";
}

export function isGenerationKind(value?: string): value is GenerationLogKind {
    return value === "image" || value === "video";
}

export function isGenerationSource(value?: string): value is GenerationLogSource {
    return value === "agent" || value === "image-workbench" || value === "video-workbench" || value === "canvas" || value === "drama" || value === "unknown";
}

export function isGenerationStatus(value?: string): value is GenerationLogStatus {
    return value === "pending" || value === "success" || value === "failed";
}

type GenerationAssetContext = { ownerUserId: string; source: string; conversationId?: string; taskId?: string; originalName?: string; targetSize?: string; assetIndex?: number; assetCount?: number };

export async function normalizeAssets(assets: Array<Partial<GenerationLogAsset> & { url?: string; targetSize?: string }>, context: GenerationAssetContext) {
    const normalized: GenerationLogAsset[] = [];
    for (const [assetIndex, asset] of assets.entries()) {
        const assetContext = { ...context, targetSize: asset.targetSize, assetIndex, assetCount: assets.length };
        const type = asset.type === "video" ? "video" : "image";
        const sourceUrl = (asset.url || "").trim();
        const remoteUrl = normalizeRemoteUrl(asset.remoteUrl || (isRemoteAssetUrl(sourceUrl) ? sourceUrl : ""));
        const existingServerUrl = normalizeServerAssetUrl(asset.serverUrl || (isServerAssetUrl(sourceUrl) ? sourceUrl : ""));
        let serverUrl = existingServerUrl;
        let stored: GenerationLogAsset | null = null;

        if (!sourceUrl || sourceUrl.startsWith("blob:")) {
            if (!remoteUrl && !serverUrl) continue;
        } else if (sourceUrl.startsWith("data:")) {
            stored = await writeDataUrlAsset(sourceUrl, type, assetContext);
        } else if (isRemoteAssetUrl(sourceUrl)) {
            stored = await writeRemoteAsset(sourceUrl, type, assetContext);
            if (!stored) throw new Error("生成媒体保存到服务器失败");
        }

        if (stored) serverUrl = stored.serverUrl || stored.url;
        const accessUrl = serverUrl || remoteUrl || sourceUrl;
        if (!accessUrl || accessUrl.startsWith("blob:") || accessUrl.startsWith("data:")) continue;

        normalized.push({
            type,
            url: normalizeText(accessUrl, "", 4000),
            remoteUrl: normalizeOptionalText(remoteUrl, undefined, 4000),
            serverUrl: normalizeOptionalText(serverUrl, undefined, 4000),
            mimeType: normalizeOptionalText(stored?.mimeType || asset.mimeType, undefined, 120),
            width: toOptionalNumber(stored?.width || asset.width),
            height: toOptionalNumber(stored?.height || asset.height),
            bytes: toOptionalNumber(stored?.bytes || asset.bytes),
        });
    }
    return normalized;
}

export async function writeDataUrlAsset(dataUrl: string, type: GenerationLogKind, context: GenerationAssetContext): Promise<GenerationLogAsset | null> {
    const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
    if (!match) return null;
    const mimeType = match[1] || (type === "video" ? "video/mp4" : "image/png");
    if (!mimeType.startsWith(`${type}/`)) return null;
    const bytes = Buffer.from(match[2], "base64");
    if (bytes.length > maxServerAssetBytes(type)) return null;
    return writeAssetBytes(bytes, mimeType, type, context);
}

export async function writeRemoteAsset(url: string, type: GenerationLogKind, context: GenerationAssetContext): Promise<GenerationLogAsset | null> {
    if (!(await isSafeRemoteAssetUrl(url))) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SERVER_ASSET_DOWNLOAD_TIMEOUT_MS);
    try {
        const response = await fetchSafeOutbound(url, { cache: "no-store", redirect: "follow", signal: controller.signal });
        if (!response.ok || !response.body) return null;
        const contentLength = Number(response.headers.get("content-length") || 0);
        const maxBytes = maxServerAssetBytes(type);
        if (contentLength > maxBytes) return null;
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > maxBytes) return null;
        const mimeType = await resolveMediaMimeType(bytes, type, response.headers.get("content-type"));
        if (!mimeType) return null;
        return writeAssetBytes(bytes, mimeType, type, context);
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

export async function isSafeRemoteAssetUrl(value: string) {
    return isSafeOutboundUrl(value, { allowCredentials: false });
}

export async function writeAssetBytes(bytes: Buffer, mimeType: string, type: GenerationLogKind, context: GenerationAssetContext): Promise<GenerationLogAsset> {
    const normalized: { bytes: Buffer; mimeType: string; width?: number; height?: number } = type === "image" ? await normalizeGeneratedImageBytes(bytes, mimeType, context.targetSize) : { bytes, mimeType };
    bytes = normalized.bytes;
    mimeType = normalized.mimeType;
    const extension = extensionFromMime(mimeType, type);
    const relativePath = createDatedMediaPath("permanent", type, extension);
    const registration = {
        storageKey: relativePath,
        scope: "generation" as const,
        storageClass: "permanent" as const,
        type,
        ownerUserId: context.ownerUserId,
        originalName: generationAssetFileName(context, mimeType),
        source: context.source,
        conversationId: context.conversationId,
        taskId: context.taskId,
        mimeType,
        bytes: bytes.length,
    };
    const external = await persistExternalMediaIfEnabled({ registration, bytes });
    const serverUrl = `/api/generation-log-assets/${relativePath.split("/").map(encodeURIComponent).join("/")}`;
    if (external) return { type, url: serverUrl, serverUrl, mimeType, bytes: bytes.length, width: normalized.width, height: normalized.height };
    const filePath = resolve(ASSET_ROOT, relativePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, bytes);
    try {
        await registerLocalMediaAsset(registration);
    } catch (error) {
        await unlink(filePath).catch(() => undefined);
        throw error;
    }
    return { type, url: serverUrl, serverUrl, mimeType, bytes: bytes.length, width: normalized.width, height: normalized.height };
}

export function maxServerAssetBytes(type: GenerationLogKind) {
    return type === "video" ? MAX_SERVER_VIDEO_BYTES : MAX_SERVER_IMAGE_BYTES;
}

export function isRemoteAssetUrl(value: string) {
    return /^https?:\/\//i.test(value);
}

export function isServerAssetUrl(value: string) {
    return value.startsWith("/api/generation-log-assets/") || value.startsWith("/api/reference-assets/");
}

export function normalizeRemoteUrl(value: unknown) {
    const text = normalizeOptionalText(value, undefined, 4000) || "";
    return isRemoteAssetUrl(text) ? text : "";
}

export function normalizeServerAssetUrl(value: unknown) {
    const text = normalizeOptionalText(value, undefined, 4000) || "";
    return isServerAssetUrl(text) ? text : "";
}

export async function deleteLocalAsset(url: string) {
    if (!url.startsWith("/api/generation-log-assets/")) return;
    const relative = url.replace("/api/generation-log-assets/", "");
    const registration = await getLocalMediaRegistration(relative);
    if (registration?.storageProvider === "object") {
        if (await deleteExternalMediaObject(registration)) await deleteLocalMediaRegistrations([relative]);
        return;
    }
    const filePath = resolve(ASSET_ROOT, relative);
    const root = resolve(ASSET_ROOT);
    if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) return;
    await unlink(filePath).catch(() => undefined);
    await deleteLocalMediaRegistrations([relative]).catch(() => undefined);
}

export function collectReferencedLocalAssetPaths(db: GenerationLogDatabase) {
    const root = resolve(ASSET_ROOT);
    const paths = new Set<string>();
    for (const log of db.logs) {
        for (const asset of log.assets) {
            for (const url of localAssetUrls(asset)) {
                const filePath = localAssetUrlToPath(url);
                if (filePath && filePath !== root && filePath.startsWith(`${root}${sep}`)) paths.add(filePath);
            }
        }
    }
    return paths;
}

export function localAssetUrls(asset: GenerationLogAsset) {
    return [asset.url, asset.serverUrl].filter((url): url is string => Boolean(url && isServerAssetUrl(url)));
}

export function stableAssetUrl(asset: GenerationLogAsset) {
    return asset.serverUrl || asset.url || asset.remoteUrl || "";
}

export function localAssetUrlToPath(url: string) {
    if (!url.startsWith("/api/generation-log-assets/")) return "";
    const relative = url.replace("/api/generation-log-assets/", "");
    const filePath = resolve(ASSET_ROOT, relative);
    const root = resolve(ASSET_ROOT);
    return filePath !== root && filePath.startsWith(`${root}${sep}`) ? filePath : "";
}

export async function listLocalAssetFiles() {
    const root = resolve(ASSET_ROOT);
    const files: Array<{ path: string; bytes: number }> = [];
    await walkAssetDir(root, files);
    return files;
}

export async function walkAssetDir(dir: string, files: Array<{ path: string; bytes: number }>) {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
    }

    await Promise.all(
        entries.map(async (entry) => {
            const entryPath = resolve(dir, entry.name);
            const root = resolve(ASSET_ROOT);
            if (entryPath !== root && !entryPath.startsWith(`${root}${sep}`)) return;
            if (entry.isDirectory()) {
                await walkAssetDir(entryPath, files);
                return;
            }
            if (!entry.isFile()) return;
            const info = await stat(entryPath).catch(() => null);
            if (info?.isFile()) files.push({ path: entryPath, bytes: info.size });
        }),
    );
}

export async function readGenerationLogDb(): Promise<GenerationLogDatabase> {
    if (isPostgresDatabaseEnabled()) throw new Error("PostgreSQL generation log reads must use scoped repositories");
    return normalizeDb(await readJsonDataFile<Partial<GenerationLogDatabase>>(LOG_DATA_FILE, emptyDb()));
}

export async function mutateGenerationLogDb<T>(mutator: (db: GenerationLogDatabase) => T | Promise<T>) {
    const run = mutationQueue.then(() =>
        withJsonDataFileLock(LOG_DATA_FILE, async () => {
            const db = await readGenerationLogDb();
            const result = await mutator(db);
            await writeGenerationLogDb(db);
            return result;
        }),
    );
    mutationQueue = run.then(
        () => undefined,
        () => undefined,
    );
    return run;
}

export async function writeGenerationLogDb(db: GenerationLogDatabase) {
    if (isPostgresDatabaseEnabled()) throw new Error("Full PostgreSQL generation log writes are reserved for explicit backup restore");
    await writeJsonDataFile(LOG_DATA_FILE, normalizeDb(db));
}

/** Full generation snapshot for the explicit administrator backup transaction only. */
export async function readPostgresGenerationLogDb(executor: QueryExecutor): Promise<GenerationLogDatabase> {
    const query: QueryExecutor["query"] = executor.query.bind(executor);
    const [logResult, assetResult] = await Promise.all([query("SELECT * FROM generation_logs ORDER BY created_at DESC"), query("SELECT * FROM generation_log_assets ORDER BY generation_log_id ASC, sort_order ASC")]);
    const assetsByLogId = new Map<string, GenerationLogAsset[]>();
    for (const row of assetResult.rows) {
        const logId = dbText(row.generation_log_id);
        const assets = assetsByLogId.get(logId) || [];
        assets.push(mapPostgresGenerationLogAsset(row));
        assetsByLogId.set(logId, assets);
    }
    return normalizeDb({
        version: 1,
        logs: logResult.rows.map((row) => mapPostgresGenerationLog(row, assetsByLogId.get(dbText(row.id)) || [])),
    });
}

export async function writePostgresGenerationLogDbWithExecutor(db: GenerationLogDatabase, client: QueryExecutor) {
    const normalized = normalizeDb(db);
    const userResult = await client.query("SELECT id FROM users");
    const userIds = new Set(userResult.rows.map((row) => dbText(row.id)));
    const logs = normalized.logs.filter((log) => userIds.has(log.userId));
    await client.query("DELETE FROM generation_log_assets");
    await client.query("DELETE FROM generation_logs");
    await insertPostgresGenerationLogs(client, logs);
}

export async function upsertPostgresGenerationLogDbWithExecutor(db: GenerationLogDatabase, client: QueryExecutor) {
    const normalized = normalizeDb(db);
    const userResult = await client.query("SELECT id FROM users");
    const userIds = new Set(userResult.rows.map((row) => dbText(row.id)));
    await insertPostgresGenerationLogs(
        client,
        normalized.logs.filter((log) => userIds.has(log.userId)),
    );
}

export async function insertPostgresGenerationLogs(db: QueryExecutor, logs: StoredGenerationLog[]) {
    for (const log of logs) {
        await db.query(
            `
            INSERT INTO generation_logs (
                id, user_id, conversation_id, username, display_name, kind, source, status, title, prompt, model, summary,
                duration_ms, count, success_count, fail_count, request_snapshot, task_id, error, created_at, updated_at, completed_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18, $19, $20, $21, $22)
            ON CONFLICT (id) DO UPDATE SET
                user_id = EXCLUDED.user_id,
                conversation_id = EXCLUDED.conversation_id,
                username = EXCLUDED.username,
                display_name = EXCLUDED.display_name,
                kind = EXCLUDED.kind,
                source = EXCLUDED.source,
                status = EXCLUDED.status,
                title = EXCLUDED.title,
                prompt = EXCLUDED.prompt,
                model = EXCLUDED.model,
                summary = EXCLUDED.summary,
                duration_ms = EXCLUDED.duration_ms,
                count = EXCLUDED.count,
                success_count = EXCLUDED.success_count,
                fail_count = EXCLUDED.fail_count,
                request_snapshot = EXCLUDED.request_snapshot,
                task_id = EXCLUDED.task_id,
                error = EXCLUDED.error,
                created_at = EXCLUDED.created_at,
                updated_at = EXCLUDED.updated_at,
                completed_at = EXCLUDED.completed_at
            `,
            [
                log.id,
                log.userId,
                log.conversationId || null,
                log.username,
                log.displayName,
                log.kind,
                log.source,
                log.status,
                log.title,
                log.prompt,
                log.model,
                log.summary,
                log.durationMs,
                log.count,
                log.successCount,
                log.failCount,
                JSON.stringify(log.requestSnapshot || {}),
                log.taskId || null,
                log.error || null,
                log.createdAt,
                log.updatedAt,
                log.completedAt || null,
            ],
        );
        await db.query("DELETE FROM generation_log_assets WHERE generation_log_id = $1", [log.id]);
        await insertPostgresGenerationLogAssets(db, log.id, log.assets);
    }
}

export async function insertPostgresGenerationLogAssets(db: QueryExecutor, logId: string, assets: GenerationLogAsset[]) {
    for (const [index, asset] of assets.entries()) {
        await db.query(
            `
            INSERT INTO generation_log_assets (generation_log_id, type, url, remote_url, server_url, mime_type, width, height, bytes, sort_order)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            `,
            [logId, asset.type, asset.url, asset.remoteUrl || null, asset.serverUrl || null, asset.mimeType || null, asset.width || null, asset.height || null, asset.bytes || null, index],
        );
    }
}

export function mapPostgresGenerationLog(row: Record<string, unknown>, assets: GenerationLogAsset[]): StoredGenerationLog {
    return {
        id: dbText(row.id),
        userId: dbText(row.user_id),
        conversationId: dbOptionalText(row.conversation_id),
        username: dbText(row.username),
        displayName: dbText(row.display_name),
        kind: row.kind === "video" ? "video" : "image",
        source: isGenerationSource(dbText(row.source)) ? (dbText(row.source) as GenerationLogSource) : "unknown",
        status: row.status === "pending" || row.status === "failed" ? row.status : "success",
        title: dbText(row.title),
        prompt: dbText(row.prompt),
        model: dbText(row.model),
        summary: dbText(row.summary),
        durationMs: dbNumber(row.duration_ms, 0),
        count: dbNumber(row.count, 1),
        successCount: dbNumber(row.success_count, 0),
        failCount: dbNumber(row.fail_count, 0),
        assets,
        requestSnapshot: normalizeGenerationLogRequestSnapshot(row.request_snapshot),
        ecommerceTrace: normalizeEcommerceGenerationTrace(row.ecommerce_trace),
        taskId: dbOptionalText(row.task_id),
        error: dbOptionalText(row.error),
        createdAt: dbIso(row.created_at),
        updatedAt: dbIso(row.updated_at),
        completedAt: dbOptionalIso(row.completed_at),
    };
}

export function mapPostgresGenerationLogAsset(row: Record<string, unknown>): GenerationLogAsset {
    return {
        type: row.type === "video" ? "video" : "image",
        url: dbText(row.url),
        remoteUrl: dbOptionalText(row.remote_url),
        serverUrl: dbOptionalText(row.server_url),
        mimeType: dbOptionalText(row.mime_type),
        width: dbOptionalNumber(row.width),
        height: dbOptionalNumber(row.height),
        bytes: dbOptionalNumber(row.bytes),
    };
}

export function dbText(value: unknown) {
    return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

export function dbOptionalText(value: unknown) {
    const text = dbText(value);
    return text || undefined;
}

export function dbNumber(value: unknown, fallback: number) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

export function dbOptionalNumber(value: unknown) {
    if (value === null || value === undefined) return undefined;
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
}

export function dbIso(value: unknown) {
    const date = value instanceof Date ? value : new Date(dbText(value));
    return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

export function dbOptionalIso(value: unknown) {
    if (!value) return undefined;
    return dbIso(value);
}

export function normalizeDb(db: Partial<GenerationLogDatabase>): GenerationLogDatabase {
    return {
        version: 1,
        logs: Array.isArray(db.logs) ? db.logs.map(normalizeStoredLog).filter(Boolean) : [],
    };
}

export function normalizeStoredLog(log: Partial<StoredGenerationLog>): StoredGenerationLog {
    const kind = isGenerationKind(log.kind) ? log.kind : "image";
    const status = isGenerationStatus(log.status) ? log.status : "success";
    return {
        id: normalizeText(log.id, randomUUID(), 120),
        userId: normalizeText(log.userId, "", 120),
        conversationId: normalizeOptionalText(log.conversationId, undefined, 160),
        username: normalizeText(log.username, "", 80),
        displayName: normalizeText(log.displayName, log.username || "未知用户", 80),
        kind,
        source: isGenerationSource(log.source) ? log.source : "unknown",
        status,
        title: normalizeText(log.title, "未命名记录", 80),
        prompt: normalizeText(log.prompt, "", 5000),
        model: normalizeModelName(log.model),
        summary: normalizeText(log.summary, defaultSummary(kind, status), 160),
        durationMs: normalizeNonNegativeNumber(log.durationMs, 0),
        count: normalizePositiveInteger(log.count, 1),
        successCount: normalizeNonNegativeInteger(log.successCount, status === "success" ? 1 : 0),
        failCount: normalizeNonNegativeInteger(log.failCount, status === "failed" ? 1 : 0),
        assets: Array.isArray(log.assets) ? log.assets.map(normalizeStoredAsset).filter((asset): asset is GenerationLogAsset => Boolean(asset?.url)) : [],
        requestSnapshot: normalizeGenerationLogRequestSnapshot(log.requestSnapshot),
        ecommerceTrace: normalizeEcommerceGenerationTrace(log.ecommerceTrace),
        taskId: normalizeOptionalText(log.taskId, undefined, 160),
        error: normalizeOptionalText(log.error, undefined, 1000),
        createdAt: normalizeTime(log.createdAt, new Date().toISOString()),
        updatedAt: normalizeTime(log.updatedAt, log.createdAt || new Date().toISOString()),
        completedAt: log.completedAt ? normalizeTime(log.completedAt, log.completedAt) : undefined,
    };
}

export function normalizeGenerationLogRequestSnapshot(value: unknown): GenerationLogRequestSnapshot | undefined {
    const source = jsonObject(value);
    if (!source || Number(source.version) !== 1) return undefined;
    const userPrompt = normalizeOptionalText(source.userPrompt, undefined, 4000);
    const parameters = normalizeSnapshotParameters(source.parameters);
    const references = Array.isArray(source.references) ? source.references.flatMap(normalizeSnapshotReference) : [];
    const slots = Array.isArray(source.slots) ? source.slots.flatMap(normalizeSnapshotSlot) : [];
    if (!userPrompt && !Object.keys(parameters).length && !references.length && !slots.length) return undefined;
    return { version: 1, ...(userPrompt ? { userPrompt } : {}), parameters, references, slots };
}

function normalizeSnapshotParameters(value: unknown): GenerationLogSnapshotParameters {
    const source = jsonObject(value);
    if (!source) return {};
    const result: GenerationLogSnapshotParameters = {};
    for (const key of ["model", "size", "quality", "count", "resolution", "seconds", "generateAudio", "watermark"] as const) {
        const normalized = normalizeOptionalText(source[key], undefined, 160);
        if (normalized !== undefined) result[key] = normalized;
    }
    return result;
}

function normalizeSnapshotReference(value: unknown): GenerationLogReferenceSnapshot[] {
    const source = jsonObject(value);
    if (!source) return [];
    const kind = source.kind === "video" || source.kind === "audio" ? source.kind : "image";
    const id = normalizeOptionalText(source.id, undefined, 160);
    const storageKey = normalizeOptionalText(source.storageKey, undefined, 1000);
    const url = normalizeSnapshotUrl(source.url);
    const remoteUrl = normalizeRemoteUrl(typeof source.remoteUrl === "string" ? source.remoteUrl : "");
    const serverUrl = normalizeSnapshotUrl(source.serverUrl);
    if (!id || (!storageKey && !url && !remoteUrl && !serverUrl)) return [];
    return [
        {
            id,
            kind,
            name: normalizeText(source.name, `reference-${id}`, 240),
            mimeType: normalizeText(source.mimeType, kind === "video" ? "video/mp4" : kind === "audio" ? "audio/mpeg" : "image/png", 120),
            url,
            remoteUrl: remoteUrl || undefined,
            serverUrl,
            storageKey,
            bytes: toOptionalNumber(source.bytes),
            width: toOptionalNumber(source.width),
            height: toOptionalNumber(source.height),
            durationMs: toOptionalNumber(source.durationMs),
        },
    ];
}

function normalizeSnapshotSlot(value: unknown): GenerationLogSlotSnapshot[] {
    const source = jsonObject(value);
    if (!source) return [];
    const id = normalizeOptionalText(source.id, undefined, 200);
    const status = source.status === "pending" || source.status === "failed" ? source.status : source.status === "success" ? "success" : undefined;
    if (!id || !status) return [];
    return [
        {
            id,
            index: normalizeNonNegativeInteger(source.index, 0),
            status,
            prompt: normalizeOptionalText(source.prompt, undefined, 5000),
            parameters: normalizeSnapshotParameters(source.parameters),
            referenceIds: Array.isArray(source.referenceIds) ? Array.from(new Set(source.referenceIds.map((item) => normalizeOptionalText(item, undefined, 160)).filter((item): item is string => Boolean(item)))) : undefined,
            assetIndex: toOptionalNumber(source.assetIndex),
            clientRequestId: normalizeOptionalText(source.clientRequestId, undefined, 200),
            taskId: normalizeOptionalText(source.taskId, undefined, 200),
            taskKind: source.taskKind === "edit" ? "edit" : source.taskKind === "generation" ? "generation" : undefined,
            taskProvider: source.taskProvider === "openai" || source.taskProvider === "seedance" || source.taskProvider === "generation" ? source.taskProvider : undefined,
            taskModel: normalizeOptionalText(source.taskModel, undefined, 200),
            taskPollPath: normalizeOptionalText(source.taskPollPath, undefined, 1000),
            taskResultUrl: normalizeSnapshotUrl(source.taskResultUrl),
            serverTaskId: normalizeOptionalText(source.serverTaskId, undefined, 200),
            startedAt: toOptionalNumber(source.startedAt),
            error: normalizeOptionalText(source.error, undefined, 1000),
            canRetry: source.canRetry === true ? true : undefined,
        },
    ];
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
    if (typeof value === "string") {
        try {
            return jsonObject(JSON.parse(value));
        } catch {
            return undefined;
        }
    }
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function normalizeSnapshotUrl(value: unknown) {
    const url = normalizeOptionalText(value, undefined, 4000);
    return url && !/^(data|blob):/i.test(url) ? url : undefined;
}

export function normalizeStoredAsset(asset: Partial<GenerationLogAsset> | undefined): GenerationLogAsset | null {
    if (!asset) return null;
    const type = asset.type === "video" ? "video" : "image";
    const url = normalizeOptionalText(asset.url, undefined, 4000) || "";
    const remoteUrl = normalizeRemoteUrl(asset.remoteUrl || (isRemoteAssetUrl(url) ? url : ""));
    const serverUrl = normalizeServerAssetUrl(asset.serverUrl || (isServerAssetUrl(url) ? url : ""));
    const accessUrl = serverUrl || remoteUrl || url;
    if (!accessUrl) return null;
    return {
        type,
        url: normalizeText(accessUrl, "", 4000),
        remoteUrl: normalizeOptionalText(remoteUrl, undefined, 4000),
        serverUrl: normalizeOptionalText(serverUrl, undefined, 4000),
        mimeType: normalizeOptionalText(asset.mimeType, undefined, 120),
        width: toOptionalNumber(asset.width),
        height: toOptionalNumber(asset.height),
        bytes: toOptionalNumber(asset.bytes),
    };
}

export function emptyDb(): GenerationLogDatabase {
    return { version: 1, logs: [] };
}

export function defaultSummary(kind: GenerationLogKind, status: GenerationLogStatus) {
    const type = kind === "video" ? "视频" : "图片";
    if (status === "failed") return `${type}生成失败`;
    if (status === "pending") return `${type}生成中`;
    return `${type}生成完成`;
}

export function normalizeText(value: unknown, fallback: string, maxLength: number) {
    const text = typeof value === "string" ? value.trim() : "";
    return (text || fallback).slice(0, maxLength);
}

export function normalizeModelName(value: unknown) {
    const text = normalizeText(value, "", 160);
    const separatorIndex = text.indexOf("::");
    return separatorIndex >= 0
        ? text
              .slice(separatorIndex + 2)
              .trim()
              .slice(0, 160)
        : text;
}

export function normalizeOptionalText(value: unknown, fallback: string | undefined, maxLength: number) {
    const text = typeof value === "string" ? value.trim() : "";
    return text ? text.slice(0, maxLength) : fallback;
}

export function normalizeTime(value: unknown, fallback: string | number) {
    const raw = typeof value === "number" ? value : typeof value === "string" ? value : fallback;
    const date = typeof raw === "number" ? new Date(raw) : new Date(raw);
    return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

export function normalizeNonNegativeNumber(value: unknown, fallback: number) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) && numberValue >= 0 ? Math.round(numberValue) : fallback;
}

export function normalizePositiveInteger(value: unknown, fallback: number) {
    const numberValue = Math.floor(Number(value));
    return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : fallback;
}

export function normalizeNonNegativeInteger(value: unknown, fallback: number) {
    const numberValue = Math.floor(Number(value));
    return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : fallback;
}

export function toOptionalNumber(value: unknown) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : undefined;
}

export function parseDateStart(value?: string) {
    if (!value) return 0;
    const date = new Date(`${value}T00:00:00`);
    return Number.isFinite(date.getTime()) ? date.getTime() : 0;
}

export function parseDateEnd(value?: string) {
    if (!value) return 0;
    const date = new Date(`${value}T23:59:59.999`);
    return Number.isFinite(date.getTime()) ? date.getTime() : 0;
}

export function extensionFromMime(mimeType: string, type: GenerationLogKind) {
    return `.${mediaFileExtension(mimeType, "", type === "video" ? "mp4" : "png")}`;
}

function generationAssetFileName(context: GenerationAssetContext, mimeType: string) {
    if (!context.originalName) return undefined;
    const fileName = ensureMediaFileExtension(context.originalName, mimeType);
    if (!context.assetCount || context.assetCount <= 1) return fileName;
    const extension = mediaFileExtension(mimeType, fileName);
    return `${fileName.slice(0, -(extension.length + 1))}-${(context.assetIndex || 0) + 1}.${extension}`;
}
