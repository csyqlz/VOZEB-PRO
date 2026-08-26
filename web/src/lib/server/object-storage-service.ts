import { stat, unlink } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";

import sharp from "sharp";

import { classifyManagedMediaType, isManagedMediaType, isMediaSourceGroup, mediaSourceGroup } from "@/lib/media-management-contract";
import { normalizeImagePreviewWidth } from "@/lib/media-image-variant";
import type { ExternalStorageFilesPayload, ObjectStorageDeleteResult, ObjectStorageMigrationResult, ObjectStoragePreviewCleanupResult } from "@/lib/object-storage-contract";
import { resolveServerDataPath } from "@/lib/server/data-dir";
import { countLocalMediaReferences } from "@/lib/server/local-media-references";
import { runImageVariantTaskOnce } from "@/lib/server/media-image-variant-cache";
import { mediaContentDisposition, requestedImageVariant } from "@/lib/server/local-media-response";
import { deleteLocalMediaRegistrations, listLocalMediaMigrationRegistrations, listMediaRegistrationsByExternalObjectKeys, registerLocalMediaAsset, type LocalMediaRegistration } from "@/lib/server/local-media-registry";
import { deleteObjects, getObjectBytes, listObjects, objectExists, objectStorageErrorMessage, putObjectBytes, putObjectFile, signObjectRead, testObjectStorageConnection } from "@/lib/server/object-storage-client";
import { assertObjectStorageConfigured, getObjectStorageRuntimeConfig, type ObjectStorageRuntimeConfig } from "@/lib/server/object-storage-config";

const MAX_INPUT_PIXELS = 100_000_000;
const PREVIEW_MARKER = ".vozeb-preview";
const IMAGE_PREVIEW_READ_URL_TTL_SECONDS = 120;
const IMAGE_ORIGINAL_READ_URL_TTL_SECONDS = 600;
const STREAMING_MEDIA_READ_URL_TTL_SECONDS = 3600;

type ExternalMediaWriteInput = {
    registration: Omit<LocalMediaRegistration, "createdAt" | "storageProvider" | "externalStorageId" | "externalObjectKey" | "externalSyncedAt"> & { createdAt?: string };
    bytes?: Buffer;
    filePath?: string;
};

export async function persistExternalMediaIfEnabled(input: ExternalMediaWriteInput) {
    const config = await getObjectStorageRuntimeConfig();
    if (!config.enabled) return null;
    assertObjectStorageConfigured(config);
    const objectKey = mediaObjectKey(config, input.registration.scope, input.registration.storageKey);
    try {
        await uploadMedia(config, objectKey, input);
    } catch (error) {
        throw new Error(`外部存储上传失败：${objectStorageErrorMessage(error)}`, { cause: error });
    }
    const syncedAt = new Date().toISOString();
    try {
        return await registerLocalMediaAsset({
            ...input.registration,
            storageProvider: "object",
            externalStorageId: config.id,
            externalObjectKey: objectKey,
            externalSyncedAt: syncedAt,
        });
    } catch (error) {
        await deleteObjects(config, [objectKey]).catch(() => undefined);
        throw error;
    }
}

export async function createExternalMediaReadUrl(request: Request, registration: LocalMediaRegistration) {
    if (registration.storageProvider !== "object" || !registration.externalObjectKey) return null;
    if (registration.expiresAt && Date.parse(registration.expiresAt) <= Date.now()) return null;
    const config = await getObjectStorageRuntimeConfig();
    assertRegistrationConfig(config, registration);
    const variant = requestedImageVariant(request, registration.mimeType);
    if (variant) return createObjectImagePreviewReadUrl(config, registration.externalObjectKey, variant.width, registration.storageKey);
    const download = new URL(request.url).searchParams.get("download") === "original";
    return signObjectRead(config, {
        key: registration.externalObjectKey,
        contentType: registration.mimeType || undefined,
        contentDisposition: mediaContentDisposition(download ? "attachment" : "inline", registration.originalName || basename(registration.storageKey), registration.mimeType, download ? registration.storageKey : ""),
        expiresIn: registration.type === "video" || registration.type === "audio" ? STREAMING_MEDIA_READ_URL_TTL_SECONDS : IMAGE_ORIGINAL_READ_URL_TTL_SECONDS,
    });
}

export async function createExternalStorageImagePreviewUrl(objectKey: string, width: unknown) {
    const config = await getObjectStorageRuntimeConfig();
    assertObjectStorageConfigured(config);
    const key = objectKey.trim().replace(/\\/g, "/");
    if (!key.startsWith(`${config.prefix}/`) || isPreviewVariantKey(key) || classifyManagedMediaType({ name: key }) !== "image") return null;
    return createObjectImagePreviewReadUrl(config, key, normalizeImagePreviewWidth(width), key);
}

export async function checkConfiguredObjectStorage() {
    const config = await getObjectStorageRuntimeConfig();
    assertObjectStorageConfigured(config);
    await testObjectStorageConnection(config);
}

export async function listExternalStorageFiles(input: { prefix?: string; cursor?: string; limit?: number; type?: string; source?: string; ownerUserId?: string }): Promise<ExternalStorageFilesPayload> {
    const config = await getObjectStorageRuntimeConfig();
    assertObjectStorageConfigured(config);
    const basePrefix = `${config.prefix}/`;
    const requestedPrefix = normalizeRelativePrefix(input.prefix);
    const fullPrefix = `${basePrefix}${requestedPrefix}`;
    const limit = Math.max(1, Math.min(100, Math.floor(Number(input.limit) || 30)));
    const type = isManagedMediaType(input.type) ? input.type : undefined;
    const source = isMediaSourceGroup(input.source) ? input.source : undefined;
    const ownerUserId = input.ownerUserId?.trim() || undefined;
    const items: ExternalStorageFilesPayload["items"] = [];
    let nextCursor = cleanCursor(input.cursor);

    for (let scan = 0; scan < 100 && items.length < limit; scan += 1) {
        const listed = await listObjects(config, { prefix: fullPrefix, cursor: nextCursor, limit: limit - items.length });
        const originalItems = listed.items.filter((item) => !isPreviewVariantKey(item.key));
        const registrations = await listMediaRegistrationsByExternalObjectKeys(originalItems.map((item) => item.key));
        const registrationByKey = new Map(registrations.flatMap((item) => (item.externalObjectKey ? [[item.externalObjectKey, item] as const] : [])));
        const references = await countLocalMediaReferences(registrations.map((item) => item.storageKey));
        const pageItems = await Promise.all(
            originalItems.map(async (item) => {
                const registration = registrationByKey.get(item.key);
                const itemType = classifyManagedMediaType({ type: registration?.type, mimeType: registration?.mimeType, name: item.key });
                const fileName = registration?.originalName || basename(item.key);
                const itemMimeType = registration?.mimeType || mimeType(item.key);
                const [signedPreviewUrl, downloadUrl] = await Promise.all([
                    itemType === "image" ? Promise.resolve("") : signObjectRead(config, { key: item.key, contentType: itemMimeType, contentDisposition: mediaContentDisposition("inline", fileName, itemMimeType) }),
                    signObjectRead(config, { key: item.key, contentType: itemMimeType, contentDisposition: mediaContentDisposition("attachment", fileName, itemMimeType, registration?.storageKey || item.key) }),
                ]);
                return {
                    ...item,
                    name: basename(item.key),
                    directory: item.key.slice(0, Math.max(0, item.key.lastIndexOf("/"))) || "/",
                    type: itemType,
                    storageKey: registration?.storageKey,
                    scope: registration?.scope,
                    originalName: registration?.originalName,
                    ownerUserId: registration?.ownerUserId,
                    source: registration?.source,
                    referenceCount: registration ? references.get(registration.storageKey) || 0 : 0,
                    previewUrl: itemType === "image" ? adminObjectImagePreviewUrl(item.key) : signedPreviewUrl,
                    downloadUrl,
                    variant: false,
                };
            }),
        );
        items.push(...pageItems.filter((item) => (!type || item.type === type) && (!source || mediaSourceGroup(item.source) === source) && (!ownerUserId || item.ownerUserId === ownerUserId)));
        const previousCursor = nextCursor;
        nextCursor = listed.nextCursor;
        if (!nextCursor || nextCursor === previousCursor || (!type && !source && !ownerUserId)) break;
    }
    return { items, nextCursor, bucket: config.bucket, prefix: fullPrefix };
}

async function createObjectImagePreviewReadUrl(config: ObjectStorageRuntimeConfig, objectKey: string, width: number, fileName: string) {
    const key = `${objectKey}${PREVIEW_MARKER}/webp-${width}.webp`;
    await runImageVariantTaskOnce(`object:${config.id}:${key}`, async () => {
        if (await objectExists(config, key)) return;
        const source = await getObjectBytes(config, objectKey);
        const bytes = await sharp(source, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" }).rotate().resize({ width, withoutEnlargement: true, fit: "inside" }).webp({ quality: 82, effort: 4 }).toBuffer();
        await putObjectBytes(config, { key, bytes, contentType: "image/webp" });
    });
    return signObjectRead(config, {
        key,
        contentType: "image/webp",
        contentDisposition: mediaContentDisposition("inline", `${basename(fileName).replace(/\.[^.]+$/, "")}.webp`),
        expiresIn: IMAGE_PREVIEW_READ_URL_TTL_SECONDS,
    });
}

function adminObjectImagePreviewUrl(key: string) {
    const query = new URLSearchParams({ key });
    return `/api/admin/object-storage/files/preview?${query}`;
}

export async function deleteExternalStorageFiles(keys: string[]): Promise<ObjectStorageDeleteResult> {
    const config = await getObjectStorageRuntimeConfig();
    assertObjectStorageConfigured(config);
    const basePrefix = `${config.prefix}/`;
    const normalizedKeys = Array.from(new Set(keys.map((key) => key.trim()).filter((key) => key.startsWith(basePrefix) && !isPreviewVariantKey(key))));
    const registrations = await listMediaRegistrationsByExternalObjectKeys(normalizedKeys);
    const registrationByKey = new Map(registrations.flatMap((item) => (item.externalObjectKey ? [[item.externalObjectKey, item] as const] : [])));
    const references = await countLocalMediaReferences(registrations.map((item) => item.storageKey));
    const blocked: ObjectStorageDeleteResult["blocked"] = [];
    const deletable: string[] = [];
    const registrationKeys: string[] = [];

    for (const key of normalizedKeys) {
        const registration = registrationByKey.get(key);
        const referenceCount = registration ? references.get(registration.storageKey) || 0 : 0;
        if (registration && referenceCount) {
            blocked.push({ key, storageKey: registration.storageKey, referenceCount });
            continue;
        }
        deletable.push(key);
        if (registration) registrationKeys.push(registration.storageKey);
        deletable.push(...(await listAllKeys(config, `${key}${PREVIEW_MARKER}/`)));
    }
    await deleteObjects(config, deletable);
    await deleteLocalMediaRegistrations(registrationKeys);
    return { deleted: normalizedKeys.length - blocked.length, blocked };
}

export async function cleanupNestedExternalStoragePreviews(): Promise<ObjectStoragePreviewCleanupResult> {
    const config = await getObjectStorageRuntimeConfig();
    assertObjectStorageConfigured(config);
    const result: ObjectStoragePreviewCleanupResult = { scanned: 0, deleted: 0, reclaimedBytes: 0 };
    let cursor: string | undefined;

    do {
        const page = await listObjects(config, { prefix: `${config.prefix}/`, cursor, limit: 100 });
        result.scanned += page.items.length;
        const invalid = page.items.filter((item) => isNestedPreviewVariantKey(item.key));
        if (invalid.length) {
            await deleteObjects(
                config,
                invalid.map((item) => item.key),
            );
            result.deleted += invalid.length;
            result.reclaimedBytes += invalid.reduce((total, item) => total + item.bytes, 0);
        }
        if (page.nextCursor && page.nextCursor === cursor) throw new Error("外部存储分页游标未推进，请重试清理");
        cursor = page.nextCursor;
    } while (cursor);

    return result;
}

function isPreviewVariantKey(key: string) {
    return key.replace(/\\/g, "/").includes(`${PREVIEW_MARKER}/`);
}

function isNestedPreviewVariantKey(key: string) {
    const normalized = key.replace(/\\/g, "/");
    const marker = `${PREVIEW_MARKER}/`;
    const first = normalized.indexOf(marker);
    return first >= 0 && normalized.indexOf(marker, first + marker.length) >= 0;
}

export async function deleteExternalMediaObject(registration: LocalMediaRegistration) {
    if (registration.storageProvider !== "object" || !registration.externalObjectKey) return false;
    const config = await getObjectStorageRuntimeConfig();
    assertRegistrationConfig(config, registration);
    const variants = await listAllKeys(config, `${registration.externalObjectKey}${PREVIEW_MARKER}/`);
    await deleteObjects(config, [registration.externalObjectKey, ...variants]);
    return true;
}

export async function migrateLocalMediaToObjectStorage(limit = 20): Promise<ObjectStorageMigrationResult> {
    const config = await getObjectStorageRuntimeConfig();
    if (!config.enabled) throw new Error("请先启用外部存储");
    assertObjectStorageConfigured(config);
    const batchSize = Math.max(1, Math.min(50, Math.floor(limit) || 20));
    const batch: Array<{ registration: LocalMediaRegistration; filePath: string; bytes: number }> = [];
    let offset = 0;
    let total = 0;
    let skipped = 0;
    while (batch.length < batchSize && offset < 500) {
        const pageLimit = Math.min(100, 500 - offset);
        const page = await listLocalMediaMigrationRegistrations({ limit: pageLimit, offset });
        total = page.total;
        if (!page.items.length) break;
        const inspected = await Promise.all(
            page.items.map(async (registration) => {
                const filePath = localMediaPath(registration);
                const info = filePath ? await stat(filePath).catch(() => null) : null;
                return info?.isFile() ? { registration, filePath, bytes: info.size } : null;
            }),
        );
        for (const candidate of inspected) {
            if (!candidate) skipped += 1;
            else if (batch.length < batchSize) batch.push(candidate);
        }
        offset += page.items.length;
        if (page.items.length < pageLimit) break;
    }
    const result: ObjectStorageMigrationResult = { migrated: 0, skipped, failed: 0, remaining: total, errors: [] };

    for (const item of batch) {
        try {
            const migrated = await persistExternalMediaIfEnabled({ registration: { ...item.registration, bytes: item.bytes }, filePath: item.filePath });
            if (!migrated) throw new Error("外部存储未启用");
            try {
                await unlink(item.filePath);
            } catch (error) {
                await registerLocalMediaAsset({ ...item.registration, storageProvider: "local", externalStorageId: undefined, externalObjectKey: undefined, externalSyncedAt: undefined });
                await deleteExternalMediaObject(migrated).catch(() => undefined);
                throw error;
            }
            result.migrated += 1;
        } catch (error) {
            result.failed += 1;
            result.errors.push({ storageKey: item.registration.storageKey, message: error instanceof Error ? error.message : "迁移失败" });
        }
    }
    result.remaining = Math.max(0, total - result.migrated);
    return result;
}

function mediaObjectKey(config: ObjectStorageRuntimeConfig, scope: LocalMediaRegistration["scope"], storageKey: string) {
    return `${config.prefix}/media/${scope}/${storageKey.replace(/^\/+/, "")}`;
}

async function uploadMedia(config: ObjectStorageRuntimeConfig, objectKey: string, input: ExternalMediaWriteInput) {
    const metadata = { "storage-key": encodeURIComponent(input.registration.storageKey).slice(0, 1800), scope: input.registration.scope };
    if (input.bytes) {
        await putObjectBytes(config, { key: objectKey, bytes: input.bytes, contentType: input.registration.mimeType, metadata });
        return;
    }
    if (!input.filePath) throw new Error("媒体写入缺少文件内容");
    await putObjectFile(config, { key: objectKey, filePath: input.filePath, bytes: input.registration.bytes, contentType: input.registration.mimeType, metadata });
}

function assertRegistrationConfig(config: ObjectStorageRuntimeConfig, registration: LocalMediaRegistration) {
    assertObjectStorageConfigured(config);
    if (registration.externalStorageId && registration.externalStorageId !== config.id) throw new Error("媒体所属的外部存储配置不可用");
}

function localMediaPath(registration: LocalMediaRegistration) {
    const root = resolve(resolveServerDataPath(registration.scope === "generation" ? "generation-assets" : "reference-assets"));
    const filePath = resolve(root, registration.storageKey);
    return filePath !== root && filePath.startsWith(`${root}${sep}`) ? filePath : "";
}

async function listAllKeys(config: ObjectStorageRuntimeConfig, prefix: string) {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
        const page = await listObjects(config, { prefix, cursor, limit: 100 });
        keys.push(...page.items.map((item) => item.key));
        cursor = page.nextCursor;
    } while (cursor);
    return keys;
}

function normalizeRelativePrefix(value: unknown) {
    const prefix = typeof value === "string" ? value.trim().replace(/\\/g, "/").replace(/^\/+/, "").slice(0, 700) : "";
    if (prefix.split("/").some((segment) => segment === "." || segment === "..")) throw new Error("对象路径前缀不合法");
    return prefix;
}

function cleanCursor(value: unknown) {
    return typeof value === "string" ? value.trim().slice(0, 4000) : undefined;
}

function mimeType(key: string) {
    const type = classifyManagedMediaType({ name: key });
    if (type === "image") return key.toLowerCase().endsWith(".webp") ? "image/webp" : key.toLowerCase().match(/\.jpe?g$/) ? "image/jpeg" : "image/png";
    if (type === "video") return key.toLowerCase().endsWith(".webm") ? "video/webm" : "video/mp4";
    if (type === "audio") return key.toLowerCase().endsWith(".wav") ? "audio/wav" : "audio/mpeg";
    return undefined;
}
