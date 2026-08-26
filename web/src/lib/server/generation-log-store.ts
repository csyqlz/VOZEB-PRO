import { randomUUID } from "node:crypto";
import { relative, resolve } from "node:path";

import { getAuthSettings, type UserRole } from "@/lib/auth/store";
import { createPostgresRepositories, ensurePostgresSchema, isPostgresDatabaseEnabled, withPostgresTransaction } from "@/lib/server/database";
import { collectLocalMediaStorageKeys, countLocalMediaReferences, localMediaStorageKeyFromValue } from "@/lib/server/local-media-references";
import { deleteLocalMediaAssetsByStorageKeys, deleteUserLocalMediaAssets, GENERATION_MEDIA_ROOT } from "@/lib/server/local-media-storage";
import { deleteUserMediaAssetsCascade } from "@/lib/server/user-media-deletion-service";
import { getLocalMediaRegistration } from "@/lib/server/local-media-registry";
import {
    defaultSummary,
    isGenerationKind,
    isGenerationSource,
    isGenerationStatus,
    kindLabel,
    listLocalAssetFiles,
    localAssetUrls,
    mutateGenerationLogDb,
    normalizeAssets,
    normalizeGenerationLogRequestSnapshot,
    normalizeModelName,
    normalizeNonNegativeInteger,
    normalizeNonNegativeNumber,
    normalizeOptionalText,
    normalizePositiveInteger,
    normalizeText,
    normalizeTime,
    parseDateEnd,
    parseDateStart,
    readGenerationLogDb,
    sourceLabel,
    stableAssetUrl,
} from "./generation-log-repository";
import type { GenerationAssetStats, GenerationLogInput, GenerationLogListOptions, StoredGenerationLog } from "./generation-log-types";

export type { GenerationAssetStats, GenerationLogAsset, GenerationLogInput, GenerationLogSource, StoredGenerationLog } from "./generation-log-types";
export { isGenerationSource } from "./generation-log-repository";

export async function listGenerationLogs(options: GenerationLogListOptions = {}) {
    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        const page = Math.max(1, Math.floor(Number(options.page) || 1));
        const pageSize = Math.max(1, Math.min(100, Math.floor(Number(options.pageSize) || 20)));
        const result = await createPostgresRepositories().generationLogs.list({
            page,
            pageSize,
            userId: options.userId,
            kind: isGenerationKind(options.kind) ? options.kind : undefined,
            source: isGenerationSource(options.source) ? options.source : undefined,
            status: isGenerationStatus(options.status) ? options.status : undefined,
            keyword: options.keyword,
            startAt: dateFilterValue(options.start),
            endAt: dateFilterValue(options.end, true),
        });
        return { ...result, items: result.items.map(toStoredGenerationLog) };
    }
    const db = await readGenerationLogDb();
    const page = Math.max(1, Math.floor(Number(options.page) || 1));
    const pageSize = Math.max(1, Math.min(100, Math.floor(Number(options.pageSize) || 20)));
    const keyword = (options.keyword || "").trim().toLowerCase();
    const startMs = parseDateStart(options.start);
    const endMs = parseDateEnd(options.end);

    const filtered = db.logs
        .filter((log) => (isGenerationKind(options.kind) ? log.kind === options.kind : true))
        .filter((log) => (isGenerationSource(options.source) ? log.source === options.source : true))
        .filter((log) => (isGenerationStatus(options.status) ? log.status === options.status : true))
        .filter((log) => (options.userId ? log.userId === options.userId : true))
        .filter((log) => {
            const time = Date.parse(log.createdAt);
            if (startMs && time < startMs) return false;
            if (endMs && time > endMs) return false;
            return true;
        })
        .filter((log) => {
            if (!keyword) return true;
            return [log.displayName, log.username, log.prompt, log.model, log.title, log.summary, sourceLabel(log.source), kindLabel(log.kind)].join(" ").toLowerCase().includes(keyword);
        })
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

    const total = filtered.length;
    const startIndex = (page - 1) * pageSize;
    return { items: filtered.slice(startIndex, startIndex + pageSize), total, page, pageSize };
}

export async function listUserGenerationLogsForDelete(userId: string, ids: string[]) {
    const targetUserId = userId.trim();
    const idSet = new Set(ids.map((id) => id.trim()).filter(Boolean));
    if (!targetUserId || !idSet.size) return [];

    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        const repository = createPostgresRepositories().generationLogs;
        const requestedLogs = await repository.getByIds(Array.from(idSet), targetUserId);
        const assetUrls = Array.from(new Set(requestedLogs.flatMap((log) => log.assets.map(stableAssetUrl).filter(Boolean))));
        const sharedLogs = await repository.listByUserAndAssetUrls(targetUserId, assetUrls);
        return uniqueGenerationLogs([...requestedLogs, ...sharedLogs]).map(toStoredGenerationLog);
    }
    const db = await readGenerationLogDb();
    const userLogs = db.logs.filter((log) => log.userId === targetUserId);
    const requestedLogs = userLogs.filter((log) => idSet.has(log.id));
    const assetUrls = new Set(requestedLogs.flatMap((log) => log.assets.map(stableAssetUrl).filter(Boolean)));

    return userLogs.filter((log) => idSet.has(log.id) || log.assets.some((asset) => assetUrls.has(stableAssetUrl(asset))));
}

export async function recordGenerationLog(input: GenerationLogInput) {
    const id = normalizeText(input.id, randomUUID(), 120);
    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        const repository = createPostgresRepositories().generationLogs;
        const existing = await repository.getById(id);
        if (existing && existing.userId !== input.userId) throw new Error("generation log id belongs to another user");
        const assets = await normalizeAssets(input.assets || [], {
            ownerUserId: input.userId,
            source: input.source || (existing && isGenerationSource(existing.source) ? existing.source : "unknown"),
            conversationId: input.conversationId || existing?.conversationId,
            taskId: input.taskId || existing?.taskId,
            originalName: input.title || existing?.title,
        });
        return withPostgresTransaction(async (client) => {
            const transactionRepository = createPostgresRepositories(client).generationLogs;
            const current = await transactionRepository.getById(id, true);
            if (current && current.userId !== input.userId) throw new Error("generation log id belongs to another user");
            const next = buildGenerationLog(input, id, current ? toStoredGenerationLog(current) : undefined, assets);
            return toStoredGenerationLog(await transactionRepository.upsert(next));
        });
    }
    return mutateGenerationLogDb(async (db) => {
        const now = new Date().toISOString();
        const existing = db.logs.find((log) => log.id === id);
        if (existing && existing.userId !== input.userId) {
            throw new Error("generation log id belongs to another user");
        }
        const assets = await normalizeAssets(input.assets || [], {
            ownerUserId: input.userId,
            source: input.source || existing?.source || "unknown",
            conversationId: input.conversationId || existing?.conversationId,
            taskId: input.taskId || existing?.taskId,
            originalName: input.title || existing?.title,
        });
        const completedAt = input.status === "pending" ? undefined : normalizeTime(input.completedAt, now);
        const next = buildGenerationLog(input, id, existing, assets, now, completedAt);

        db.logs = [next, ...db.logs.filter((log) => log.id !== id)];
        return next;
    });
}

export async function deleteGenerationLogs(ids: string[], options: { cascadeUserMedia?: boolean } = {}) {
    const normalizedIds = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
    if (!normalizedIds.length) return { deleted: 0 };
    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        const removed = await withPostgresTransaction(async (client) => {
            const repository = createPostgresRepositories(client).generationLogs;
            const logs = await repository.getByIds(normalizedIds, undefined, true);
            await repository.delete(logs.map((log) => log.id));
            return logs.map(toStoredGenerationLog);
        });
        await deleteRemovedLogMedia(removed, options.cascadeUserMedia);
        return { deleted: removed.length };
    }
    let removed: StoredGenerationLog[] = [];
    const result = await mutateGenerationLogDb(async (db) => {
        const idSet = new Set(normalizedIds);
        removed = db.logs.filter((log) => idSet.has(log.id));
        db.logs = db.logs.filter((log) => !idSet.has(log.id));
        return { deleted: removed.length };
    });
    await deleteRemovedLogMedia(removed, options.cascadeUserMedia);
    return result;
}

export async function deleteGenerationLogsByUserId(userId: string) {
    const targetUserId = userId.trim();
    if (!targetUserId) return { deleted: 0 };
    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        const { dataLifecycle } = await getAuthSettings();
        let deleted = 0;
        while (true) {
            const removed = await withPostgresTransaction(async (client) => {
                const repository = createPostgresRepositories(client).generationLogs;
                const logs = await repository.listByUserIdBatch(targetUserId, dataLifecycle.maintenanceBatchSize, true);
                if (!logs.length) return [];
                await repository.delete(logs.map((log) => log.id));
                return logs.map(toStoredGenerationLog);
            });
            if (!removed.length) break;
            await deleteRemovedLogMedia(removed);
            deleted += removed.length;
        }
        return { deleted };
    }
    let removed: StoredGenerationLog[] = [];
    const result = await mutateGenerationLogDb(async (db) => {
        removed = db.logs.filter((log) => log.userId === targetUserId);
        db.logs = db.logs.filter((log) => log.userId !== targetUserId);
        return { deleted: removed.length };
    });
    await deleteRemovedLogMedia(removed);
    return result;
}

export async function getGenerationAssetStats(): Promise<GenerationAssetStats> {
    const db = isPostgresDatabaseEnabled() ? null : await readGenerationLogDb();
    const files = await listLocalAssetFiles();
    const fileKeys = files.map((file) => relative(resolve(GENERATION_MEDIA_ROOT), file.path).replace(/\\/g, "/"));
    const references = await countLocalMediaReferences(fileKeys);
    const referencedFiles = files.filter((_, index) => (references.get(fileKeys[index]) || 0) > 0);
    const unreferencedFiles = files.filter((_, index) => (references.get(fileKeys[index]) || 0) === 0);
    const logReferences = db ? collectGenerationLogAssetKeys(db) : new Set<string>();

    return {
        totalFiles: files.length,
        totalBytes: files.reduce((total, file) => total + file.bytes, 0),
        referencedFiles: referencedFiles.length,
        referencedBytes: referencedFiles.reduce((total, file) => total + file.bytes, 0),
        unreferencedFiles: unreferencedFiles.length,
        unreferencedBytes: unreferencedFiles.reduce((total, file) => total + file.bytes, 0),
        missingReferences: Array.from(logReferences).filter((key) => !fileKeys.includes(key)).length,
    };
}

export async function cleanupUnreferencedGenerationAssets() {
    const files = await listLocalAssetFiles();
    const fileKeys = files.map((file) => relative(resolve(GENERATION_MEDIA_ROOT), file.path).replace(/\\/g, "/"));
    const references = await countLocalMediaReferences(fileKeys);
    const removable = fileKeys.filter((key) => (references.get(key) || 0) === 0);
    const result = await deleteLocalMediaAssetsByStorageKeys(removable, "generation");
    const blockedKeys = new Set(result.blocked.map((item) => item.storageKey));
    const deletedKeys = removable.filter((key) => !blockedKeys.has(key));

    return {
        deletedFiles: result.deletedFiles,
        deletedBytes: files.filter((_, index) => deletedKeys.includes(fileKeys[index])).reduce((total, file) => total + file.bytes, 0),
        blocked: result.blocked,
        stats: await getGenerationAssetStats(),
    };
}

export async function canAccessGenerationAsset(userId: string, role: UserRole, url: string) {
    if (role === "admin") return true;
    const storageKey = localMediaStorageKeyFromValue(url);
    if (storageKey) {
        const registration = await getLocalMediaRegistration(storageKey);
        if (registration) return registration.ownerUserId === userId;
    }
    if (isPostgresDatabaseEnabled()) return false;
    const db = await readGenerationLogDb();
    return db.logs.some((log) => log.userId === userId && log.assets.some((asset) => localAssetUrls(asset).includes(url)));
}

function buildGenerationLog(
    input: GenerationLogInput,
    id: string,
    existing: StoredGenerationLog | undefined,
    assets: StoredGenerationLog["assets"],
    now = new Date().toISOString(),
    completedAt = input.status === "pending" ? undefined : normalizeTime(input.completedAt, now),
): StoredGenerationLog {
    return {
        id,
        userId: normalizeText(input.userId, existing?.userId || "", 120),
        conversationId: normalizeOptionalText(input.conversationId, existing?.conversationId, 160),
        username: normalizeText(input.username, existing?.username || "", 80),
        displayName: normalizeText(input.displayName, existing?.displayName || input.username || "未知用户", 80),
        kind: input.kind,
        source: input.source || existing?.source || "unknown",
        status: input.status,
        title: normalizeText(input.title, existing?.title || input.prompt || "未命名记录", 80),
        prompt: normalizeText(input.prompt, existing?.prompt || "", 5000),
        model: normalizeModelName(input.model || existing?.model || ""),
        summary: normalizeText(input.summary, existing?.summary || defaultSummary(input.kind, input.status), 160),
        durationMs: normalizeNonNegativeNumber(input.durationMs, existing?.durationMs || 0),
        count: normalizePositiveInteger(input.count, existing?.count || 1),
        successCount: normalizeNonNegativeInteger(input.successCount, existing?.successCount || (input.status === "success" ? 1 : 0)),
        failCount: normalizeNonNegativeInteger(input.failCount, existing?.failCount || (input.status === "failed" ? 1 : 0)),
        assets: assets.length ? assets : existing?.assets || [],
        requestSnapshot: normalizeGenerationLogRequestSnapshot(input.requestSnapshot) || existing?.requestSnapshot,
        taskId: normalizeOptionalText(input.taskId, existing?.taskId, 160),
        error: normalizeOptionalText(input.error, existing?.error, 1000),
        createdAt: normalizeTime(input.createdAt, existing?.createdAt || now),
        updatedAt: now,
        completedAt,
    };
}

function toStoredGenerationLog(log: { source: string; requestSnapshot?: unknown } & Omit<StoredGenerationLog, "source" | "requestSnapshot">): StoredGenerationLog {
    return {
        ...log,
        source: isGenerationSource(log.source) ? log.source : "unknown",
        requestSnapshot: normalizeGenerationLogRequestSnapshot(log.requestSnapshot),
    };
}

function uniqueGenerationLogs<T extends { id: string }>(logs: T[]) {
    return Array.from(new Map(logs.map((log) => [log.id, log])).values());
}

async function deleteRemovedLogMedia(logs: StoredGenerationLog[], cascadeUserMedia = false) {
    const byUser = new Map<string, Set<string>>();
    logs.forEach((log) => {
        const keys = byUser.get(log.userId) || new Set<string>();
        collectLocalMediaStorageKeys(log.assets).forEach((key) => keys.add(key));
        byUser.set(log.userId, keys);
    });
    await Promise.all(Array.from(byUser, ([userId, keys]) => (cascadeUserMedia ? deleteUserMediaAssetsCascade(userId, Array.from(keys)) : deleteUserLocalMediaAssets(userId, Array.from(keys)))));
}

function collectGenerationLogAssetKeys(db: Awaited<ReturnType<typeof readGenerationLogDb>>) {
    const keys = new Set<string>();
    db.logs.forEach((log) =>
        log.assets.forEach((asset) =>
            localAssetUrls(asset)
                .filter((url) => url.startsWith("/api/generation-log-assets/"))
                .map(localMediaStorageKeyFromValue)
                .filter(Boolean)
                .forEach((key) => keys.add(key)),
        ),
    );
    return keys;
}

function dateFilterValue(value: string | undefined, end = false) {
    const time = end ? parseDateEnd(value) : parseDateStart(value);
    return time ? new Date(time).toISOString() : undefined;
}
