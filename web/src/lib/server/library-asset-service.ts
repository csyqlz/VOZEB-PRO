import { nanoid } from "nanoid";

import type { Asset, CreateLibraryAssetInput } from "@/lib/library-asset-contract";
import { createLibraryAsset, deleteLibraryAsset, getLibraryAsset, listLibraryAssetPage, updateLibraryAsset } from "@/lib/server/library-asset-store";
import { deleteUserMediaAssetsCascade } from "@/lib/server/user-media-deletion-service";

export class LibraryAssetServiceError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
    }
}

export function listLibraryAssetPageForUser(userId: string, input: { page?: unknown; pageSize?: unknown; kind?: unknown; keyword?: unknown }) {
    const kind = input.kind === "text" || input.kind === "image" || input.kind === "video" || input.kind === "audio" ? input.kind : undefined;
    return listLibraryAssetPage(userId, {
        page: positiveInteger(input.page, 1, 1_000_000),
        pageSize: positiveInteger(input.pageSize, 20, 100),
        kind,
        keyword: cleanText(input.keyword, 160),
    });
}

export function createLibraryAssetForUser(userId: string, value: unknown) {
    const now = new Date().toISOString();
    return createLibraryAsset(userId, normalizeAsset(value, { id: `asset-${nanoid()}`, createdAt: now, updatedAt: now }));
}

export async function updateLibraryAssetForUser(userId: string, id: string, value: unknown) {
    const current = await getLibraryAsset(userId, cleanText(id, 160));
    if (!current) throw new LibraryAssetServiceError("素材不存在", 404);
    const asset = normalizeAsset(value, { id: current.id, createdAt: current.createdAt, updatedAt: new Date().toISOString() });
    const updated = await updateLibraryAsset(userId, asset);
    if (!updated) throw new LibraryAssetServiceError("素材不存在", 404);
    return updated;
}

export async function deleteLibraryAssetForUser(userId: string, id: string) {
    const asset = await getLibraryAsset(userId, cleanText(id, 160));
    if (!asset || !(await deleteLibraryAsset(userId, asset.id))) throw new LibraryAssetServiceError("素材不存在", 404);
    if (asset.kind !== "text" && asset.data.storageKey) await deleteUserMediaAssetsCascade(userId, [asset.data.storageKey]);
}

function normalizeAsset(value: unknown, identity: Pick<Asset, "id" | "createdAt" | "updatedAt">): Asset {
    if (Buffer.byteLength(JSON.stringify(value || {})) > 1024 * 1024) throw new LibraryAssetServiceError("素材数据过大", 413);
    const input = object(value) as Partial<CreateLibraryAssetInput>;
    const kind = input.kind === "image" || input.kind === "video" || input.kind === "audio" ? input.kind : "text";
    const title = cleanText(input.title, 160);
    if (!title) throw new LibraryAssetServiceError("素材名称不能为空", 400);
    const base = {
        ...identity,
        kind,
        title,
        coverUrl: stableUrl(input.coverUrl),
        tags: array(input.tags)
            .map((tag) => cleanText(tag, 50))
            .filter(Boolean)
            .slice(0, 30),
        source: optionalText(input.source, 160),
        note: optionalText(input.note, 2000),
        metadata: object(input.metadata),
    };
    const data = object(input.data);
    if (kind === "text") return { ...base, kind, data: { content: cleanText(data.content, 100_000) } };
    const storageKey = optionalText(data.storageKey, 500);
    const serverUrl = stableUrl(data.serverUrl) || stableUrl(kind === "image" ? data.dataUrl : data.url);
    if (!storageKey || !serverUrl) throw new LibraryAssetServiceError("媒体素材必须先保存到服务器", 400);
    const media = {
        storageKey,
        remoteUrl: stableUrl(data.remoteUrl) || undefined,
        serverUrl,
        bytes: Math.max(0, Math.floor(Number(data.bytes) || 0)),
        mimeType: cleanText(data.mimeType, 120),
    };
    if (kind === "image") return { ...base, kind, data: { ...media, dataUrl: serverUrl, width: Math.max(0, Math.floor(Number(data.width) || 0)), height: Math.max(0, Math.floor(Number(data.height) || 0)) } };
    if (kind === "video") return { ...base, kind, data: { ...media, url: serverUrl, width: Math.max(0, Math.floor(Number(data.width) || 0)), height: Math.max(0, Math.floor(Number(data.height) || 0)) } };
    return { ...base, kind, data: { ...media, url: serverUrl, durationMs: Math.max(0, Math.floor(Number(data.durationMs) || 0)) || undefined } };
}

function stableUrl(value: unknown) {
    const url = cleanText(value, 4000);
    return url && !url.startsWith("data:") && !url.startsWith("blob:") ? url : "";
}

function optionalText(value: unknown, max: number) {
    return cleanText(value, max) || undefined;
}

function cleanText(value: unknown, max: number) {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function object(value: unknown) {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function array(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function positiveInteger(value: unknown, fallback: number, max: number) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}
