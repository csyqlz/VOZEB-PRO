import { randomUUID } from "node:crypto";
import { readdir, stat, unlink } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";

import type { LocalMediaAsset, LocalMediaClass, LocalMediaType } from "@/lib/local-media-storage-contract";
import { classifyManagedMediaType, isManagedMediaType, isMediaSourceGroup, mediaSourceGroup } from "@/lib/media-management-contract";
import { resolveServerDataPath } from "@/lib/server/data-dir";
import { getDatabaseProvider } from "@/lib/server/database";
import { countLocalMediaReferences, type LocalMediaReferenceCountOptions } from "@/lib/server/local-media-references";
import {
    deleteLocalMediaRegistrations,
    getLocalMediaRegistration,
    getLocalMediaRegistrations,
    getLocalMediaRegistrationSummary,
    listExpiredLocalMediaRegistrations,
    listFileLocalMediaRegistrations,
    listLocalMediaRegistrationPage,
    type LocalMediaRegistration,
} from "@/lib/server/local-media-registry";
import { deleteExternalMediaObject } from "@/lib/server/object-storage-service";

export const GENERATION_MEDIA_ROOT = resolveServerDataPath("generation-assets");
export const REFERENCE_MEDIA_ROOT = resolveServerDataPath("reference-assets");
export const TEMPORARY_MEDIA_TTL_MS = 24 * 60 * 60 * 1000;
type MediaDeleteResult = { deletedFiles: number; deletedBytes: number; blocked: Array<{ id: string; storageKey: string; referenceCount: number }> };

export function createDatedMediaPath(storageClass: LocalMediaClass, type: LocalMediaType, extension: string, now = new Date()) {
    const year = String(now.getFullYear());
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const hours = String(now.getHours()).padStart(2, "0");
    const minutes = String(now.getMinutes()).padStart(2, "0");
    const seconds = String(now.getSeconds()).padStart(2, "0");
    const folder = type === "image" ? "images" : type === "video" ? "videos" : "audio";
    const suffix = extension.startsWith(".") ? extension : `.${extension}`;
    return `${storageClass}/${year}/${month}/${day}/${folder}/${year}${month}${day}-${hours}${minutes}${seconds}-${randomUUID()}${suffix.toLowerCase()}`;
}

export async function listLocalMediaAssets(input: { page?: number; pageSize?: number; storageClass?: string; type?: string; source?: string; search?: string; ownerUserIds?: string[] } = {}) {
    if (getDatabaseProvider() === "postgres") return listRegisteredLocalMediaAssets(input);
    const page = Math.max(1, Math.floor(Number(input.page) || 1));
    const pageSize = Math.max(1, Math.min(100, Math.floor(Number(input.pageSize) || 20)));
    const search = (input.search || "").trim().toLowerCase();
    const ownerUserIds = new Set(input.ownerUserIds || []);
    const registrations = new Map((await listFileLocalMediaRegistrations()).map((item) => [item.storageKey, item]));
    const all = [...(await scanGenerationMedia()), ...(await scanReferenceMedia())].map((asset) => ({ ...asset, ...registrationMetadata(registrations.get(asset.storageKey) || null) })).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const filtered = all
        .filter((asset) => (input.storageClass === "temporary" || input.storageClass === "permanent" ? asset.storageClass === input.storageClass : true))
        .filter((asset) => (isManagedMediaType(input.type) ? asset.type === input.type : true))
        .filter((asset) => (isMediaSourceGroup(input.source) ? mediaSourceGroup(asset.source) === input.source : true))
        .filter((asset) =>
            !search
                ? true
                : ownerUserIds.has(asset.ownerUserId || "") ||
                  `${asset.name} ${asset.originalName || ""} ${asset.ownerUserId || ""} ${asset.source || ""} ${asset.conversationId || ""} ${asset.runId || ""} ${asset.taskId || ""} ${asset.projectId || ""} ${asset.scope} ${asset.type}`
                      .toLowerCase()
                      .includes(search),
        );
    const start = (page - 1) * pageSize;
    const items = filtered.slice(start, start + pageSize);
    const references = await countLocalMediaReferences(items.map((item) => item.storageKey));
    return {
        items: items.map((item) => ({ ...item, referenceCount: references.get(item.storageKey) || 0 })),
        total: filtered.length,
        page,
        pageSize,
        summary: {
            totalFiles: all.length,
            totalBytes: sumBytes(all),
            temporaryFiles: all.filter((asset) => asset.storageClass === "temporary").length,
            temporaryBytes: sumBytes(all.filter((asset) => asset.storageClass === "temporary")),
            permanentFiles: all.filter((asset) => asset.storageClass === "permanent").length,
            permanentBytes: sumBytes(all.filter((asset) => asset.storageClass === "permanent")),
            expiredTemporaryFiles: all.filter((asset) => asset.storageClass === "temporary" && asset.expiresAt && Date.parse(asset.expiresAt) <= Date.now()).length,
        },
    };
}

export async function getLocalMediaAssetSummary() {
    if (getDatabaseProvider() === "postgres") return getLocalMediaRegistrationSummary();
    return (await listLocalMediaAssets({ page: 1, pageSize: 1 })).summary;
}

async function listRegisteredLocalMediaAssets(input: { page?: number; pageSize?: number; storageClass?: string; type?: string; source?: string; search?: string; ownerUserIds?: string[] }) {
    const page = await listLocalMediaRegistrationPage(input);
    const items = page.items.map(localMediaAssetFromRegistration);
    const references = await countLocalMediaReferences(items.map((item) => item.storageKey));
    return {
        ...page,
        items: items.map((item) => ({ ...item, referenceCount: references.get(item.storageKey) || 0 })),
    };
}

export async function cleanupExpiredLocalMediaAssets(limit?: number) {
    const registered = await listExpiredLocalMediaRegistrations(limit);
    const generationResult = await deleteRegisteredMediaAssets(registered.filter((asset) => asset.scope === "generation"), { includeEphemeral: false });
    const referenceResult = await deleteRegisteredMediaAssets(registered.filter((asset) => asset.scope === "reference"));
    const registeredResult = mergeDeleteResults(generationResult, referenceResult);
    if (getDatabaseProvider() === "postgres") return registeredResult;
    const registeredKeys = new Set(registered.map((asset) => asset.storageKey));
    const legacy = (await scanReferenceMedia()).filter((asset) => asset.storageClass === "temporary" && asset.expiresAt && Date.parse(asset.expiresAt) <= Date.now() && !registeredKeys.has(asset.storageKey));
    if (!legacy.length) return registeredResult;
    return mergeDeleteResults(registeredResult, await deleteLocalMediaAssets(legacy.map((asset) => asset.id)));
}

export async function deleteLocalMediaAssets(ids: string[], referenceOptions?: LocalMediaReferenceCountOptions) {
    let deletedFiles = 0;
    let deletedBytes = 0;
    const blocked: Array<{ id: string; storageKey: string; referenceCount: number }> = [];
    const targets = Array.from(new Set(ids.map((value) => value.trim()).filter(Boolean)))
        .map((id) => ({ id, target: decodeMediaId(id) }))
        .filter((item): item is { id: string; target: { scope: "generation" | "reference"; relativePath: string } } => Boolean(item.target));
    const references = await countLocalMediaReferences(targets.map((item) => item.target.relativePath), referenceOptions);
    const deletedKeys: string[] = [];
    for (const { id, target } of targets) {
        const referenceCount = references.get(target.relativePath) || 0;
        if (referenceCount) {
            blocked.push({ id, storageKey: target.relativePath, referenceCount });
            continue;
        }
        const root = target.scope === "generation" ? GENERATION_MEDIA_ROOT : REFERENCE_MEDIA_ROOT;
        const filePath = safePath(root, target.relativePath);
        if (!filePath) continue;
        const info = await stat(/*turbopackIgnore: true*/ filePath).catch(() => null);
        if (!info?.isFile()) continue;
        await unlink(/*turbopackIgnore: true*/ filePath);
        deletedKeys.push(target.relativePath);
        deletedFiles += 1;
        deletedBytes += info.size;
    }
    await deleteLocalMediaRegistrations(deletedKeys);
    return { deletedFiles, deletedBytes, blocked };
}

export async function deleteUserLocalMediaAssets(userId: string, storageKeys: string[]) {
    const registrations = await getLocalMediaRegistrations(storageKeys);
    return deleteRegisteredMediaAssets(registrations.filter((item) => item.ownerUserId === userId));
}

export async function deleteRegisteredLocalMediaSnapshots(registrations: LocalMediaRegistration[]) {
    return deleteRegisteredMediaAssets(registrations);
}

export async function deleteLocalMediaAssetsByStorageKeys(storageKeys: string[], scope?: "generation" | "reference") {
    const normalizedKeys = Array.from(new Set(storageKeys.map((key) => key.trim()).filter(Boolean)));
    const registrations = await getLocalMediaRegistrations(normalizedKeys);
    const registered = registrations.filter((item) => !scope || item.scope === scope);
    const result = await deleteRegisteredMediaAssets(registered);
    const registeredKeys = new Set(registered.map((item) => item.storageKey));
    const legacyIds = scope ? normalizedKeys.filter((key) => !registeredKeys.has(key)).map((key) => encodeMediaId(scope, key)) : [];
    if (!legacyIds.length) return result;
    const legacy = await deleteLocalMediaAssets(legacyIds);
    return { deletedFiles: result.deletedFiles + legacy.deletedFiles, deletedBytes: result.deletedBytes + legacy.deletedBytes, blocked: [...result.blocked, ...legacy.blocked] };
}

async function deleteRegisteredMediaAssets(registrations: LocalMediaRegistration[], referenceOptions?: LocalMediaReferenceCountOptions) {
    const unique = Array.from(new Map(registrations.map((item) => [item.storageKey, item])).values());
    const references = await countLocalMediaReferences(unique.map((item) => item.storageKey), referenceOptions);
    const blocked: Array<{ id: string; storageKey: string; referenceCount: number }> = [];
    const deletedKeys: string[] = [];
    let deletedFiles = 0;
    let deletedBytes = 0;
    for (const registration of unique) {
        const referenceCount = references.get(registration.storageKey) || 0;
        if (referenceCount) {
            blocked.push({ id: encodeMediaId(registration.scope, registration.storageKey), storageKey: registration.storageKey, referenceCount });
            continue;
        }
        if (registration.storageProvider === "object") {
            if (!(await deleteExternalMediaObject(registration))) continue;
        } else {
            const root = registration.scope === "generation" ? GENERATION_MEDIA_ROOT : REFERENCE_MEDIA_ROOT;
            const filePath = safePath(root, registration.storageKey);
            if (!filePath) continue;
            const info = await stat(/*turbopackIgnore: true*/ filePath).catch(() => null);
            if (!info?.isFile()) continue;
            await unlink(/*turbopackIgnore: true*/ filePath);
        }
        deletedKeys.push(registration.storageKey);
        deletedFiles += 1;
        deletedBytes += registration.bytes;
    }
    await deleteLocalMediaRegistrations(deletedKeys);
    return { deletedFiles, deletedBytes, blocked };
}

function mergeDeleteResults(left: MediaDeleteResult, right: MediaDeleteResult): MediaDeleteResult {
    return {
        deletedFiles: left.deletedFiles + right.deletedFiles,
        deletedBytes: left.deletedBytes + right.deletedBytes,
        blocked: [...left.blocked, ...right.blocked],
    };
}

async function scanGenerationMedia() {
    const files = await walkFiles(GENERATION_MEDIA_ROOT);
    return files.flatMap((file): LocalMediaAsset[] => {
        const type = classifyManagedMediaType({ name: file.path });
        const relativePath = relative(GENERATION_MEDIA_ROOT, file.path).replace(/\\/g, "/");
        return [
            {
                id: encodeMediaId("generation", relativePath),
                storageKey: relativePath,
                storageClass: "permanent",
                type,
                scope: "generation",
                name: basename(file.path),
                directory: relativePath.slice(0, Math.max(0, relativePath.lastIndexOf("/"))) || "/",
                bytes: file.bytes,
                createdAt: new Date(file.createdAt).toISOString(),
                url: `/api/generation-log-assets/${relativePath.split("/").map(encodeURIComponent).join("/")}`,
                referenceCount: 0,
            },
        ];
    });
}

async function scanReferenceMedia() {
    const files = await walkFiles(REFERENCE_MEDIA_ROOT);
    return files.flatMap((file): LocalMediaAsset[] => {
        const type = classifyManagedMediaType({ name: file.path });
        const name = basename(file.path);
        const relativePath = relative(REFERENCE_MEDIA_ROOT, file.path).replace(/\\/g, "/");
        const storageClass = relativePath.startsWith("permanent/") ? "permanent" : "temporary";
        return [
            {
                id: encodeMediaId("reference", relativePath),
                storageKey: relativePath,
                storageClass,
                type,
                scope: "reference",
                name,
                directory: relativePath.slice(0, Math.max(0, relativePath.lastIndexOf("/"))) || "/",
                bytes: file.bytes,
                createdAt: new Date(file.createdAt).toISOString(),
                expiresAt: storageClass === "temporary" ? new Date(file.updatedAt + TEMPORARY_MEDIA_TTL_MS).toISOString() : undefined,
                url: `/api/reference-assets/${relativePath.split("/").map(encodeURIComponent).join("/")}`,
                referenceCount: 0,
            },
        ];
    });
}

function registrationMetadata(registration: Awaited<ReturnType<typeof getLocalMediaRegistration>>) {
    if (!registration) return {};
    return {
        ownerUserId: registration.ownerUserId,
        storageClass: registration.storageClass,
        originalName: registration.originalName,
        source: registration.source,
        conversationId: registration.conversationId,
        runId: registration.runId,
        taskId: registration.taskId,
        projectId: registration.projectId,
        mimeType: registration.mimeType,
        createdAt: registration.createdAt,
        expiresAt: registration.expiresAt,
    };
}

function localMediaAssetFromRegistration(registration: LocalMediaRegistration): LocalMediaAsset {
    const name = basename(registration.storageKey);
    const directory = registration.storageKey.slice(0, Math.max(0, registration.storageKey.lastIndexOf("/"))) || "/";
    const prefix = registration.scope === "generation" ? "/api/generation-log-assets" : "/api/reference-assets";
    return {
        id: encodeMediaId(registration.scope, registration.storageKey),
        storageKey: registration.storageKey,
        storageClass: registration.storageClass,
        type: classifyManagedMediaType({ type: registration.type, mimeType: registration.mimeType, name }),
        scope: registration.scope,
        name,
        directory,
        bytes: registration.bytes,
        createdAt: registration.createdAt,
        expiresAt: registration.expiresAt,
        url: `${prefix}/${registration.storageKey.split("/").map(encodeURIComponent).join("/")}`,
        ownerUserId: registration.ownerUserId,
        originalName: registration.originalName,
        source: registration.source,
        conversationId: registration.conversationId,
        runId: registration.runId,
        taskId: registration.taskId,
        projectId: registration.projectId,
        mimeType: registration.mimeType,
        referenceCount: 0,
    };
}

async function walkFiles(root: string) {
    const files: Array<{ path: string; bytes: number; createdAt: number; updatedAt: number }> = [];
    await walk(root, root, files);
    return files;
}

async function walk(root: string, directory: string, files: Array<{ path: string; bytes: number; createdAt: number; updatedAt: number }>) {
    const entries = await readdir(/*turbopackIgnore: true*/ directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
    });
    for (const entry of entries) {
        const path = safePath(root, relative(root, resolve(directory, entry.name)));
        if (!path) continue;
        if (entry.isDirectory()) await walk(root, path, files);
        else if (entry.isFile()) {
            const info = await stat(/*turbopackIgnore: true*/ path);
            files.push({ path, bytes: info.size, createdAt: info.birthtimeMs || info.mtimeMs, updatedAt: info.mtimeMs });
        }
    }
}

function safePath(root: string, relativePath: string) {
    if (!relativePath || relativePath.includes("\0")) return null;
    const normalizedRoot = resolve(root);
    const filePath = resolve(normalizedRoot, relativePath);
    return filePath !== normalizedRoot && filePath.startsWith(`${normalizedRoot}${sep}`) ? filePath : null;
}

function encodeMediaId(scope: "generation" | "reference", relativePath: string) {
    return Buffer.from(JSON.stringify({ scope, relativePath }), "utf8").toString("base64url");
}

function decodeMediaId(id: string): { scope: "generation" | "reference"; relativePath: string } | null {
    try {
        const value = JSON.parse(Buffer.from(id, "base64url").toString("utf8")) as Record<string, unknown>;
        return (value.scope === "generation" || value.scope === "reference") && typeof value.relativePath === "string" ? { scope: value.scope, relativePath: value.relativePath } : null;
    } catch {
        return null;
    }
}

function sumBytes(assets: LocalMediaAsset[]) {
    return assets.reduce((sum, asset) => sum + asset.bytes, 0);
}
