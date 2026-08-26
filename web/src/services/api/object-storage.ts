"use client";

import type { ExternalStorageFilesPayload, ObjectStorageDeleteResult, ObjectStorageMigrationResult, ObjectStoragePreviewCleanupResult, ObjectStorageSettings, ObjectStorageSettingsUpdate } from "@/lib/object-storage-contract";

type ApiPayload<T> = { code?: number; data?: T; msg?: string; error?: string };

export async function getObjectStorageSettings() {
    return request<ObjectStorageSettings>("/api/admin/object-storage");
}

export async function saveObjectStorageSettings(input: ObjectStorageSettingsUpdate) {
    return request<ObjectStorageSettings>("/api/admin/object-storage", { method: "PATCH", headers: jsonHeaders, body: JSON.stringify(input) });
}

export async function testObjectStorageSettings() {
    return request<{ available: boolean }>("/api/admin/object-storage", { method: "POST" });
}

export async function getExternalStorageFiles(input: { prefix?: string; cursor?: string; limit?: number; type?: string; source?: string; ownerUserId?: string }) {
    const query = new URLSearchParams();
    if (input.prefix) query.set("prefix", input.prefix);
    if (input.cursor) query.set("cursor", input.cursor);
    if (input.limit) query.set("limit", String(input.limit));
    if (input.type) query.set("type", input.type);
    if (input.source) query.set("source", input.source);
    if (input.ownerUserId) query.set("ownerUserId", input.ownerUserId);
    return request<ExternalStorageFilesPayload>(`/api/admin/object-storage/files?${query}`);
}

export async function deleteExternalStorageFiles(keys: string[]) {
    return request<ObjectStorageDeleteResult>("/api/admin/object-storage/files", { method: "DELETE", headers: jsonHeaders, body: JSON.stringify({ keys }) });
}

export async function cleanupExternalStoragePreviews() {
    return request<ObjectStoragePreviewCleanupResult>("/api/admin/object-storage/files/cleanup", { method: "POST" });
}

export async function migrateLocalMedia(limit = 20) {
    return request<ObjectStorageMigrationResult>("/api/admin/object-storage/sync", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ limit }) });
}

async function request<T>(url: string, init?: RequestInit) {
    const response = await fetch(url, { cache: "no-store", ...init });
    const payload = (await response.json().catch(() => ({}))) as ApiPayload<T>;
    if (!response.ok || payload.data === undefined) throw new Error(payload.msg || payload.error || "请求失败");
    return payload.data;
}

const jsonHeaders = { "Content-Type": "application/json" };
