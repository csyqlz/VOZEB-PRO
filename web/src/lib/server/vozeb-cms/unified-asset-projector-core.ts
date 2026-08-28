import type { VozebCmsProjectRef } from "@/lib/vozeb-cms/project-ref";
import type { VozebCmsAsset } from "@/lib/vozeb-cms/unified-resource-contract";

export type AssetProjectionContext = {
    projectId?: string;
    projectRef?: Pick<VozebCmsProjectRef, "id" | "type">;
    metadata?: Record<string, unknown>;
};

export function projectAssetOwnership(userId: string, context: AssetProjectionContext, fallbackProjectId?: string) {
    const projectId = text(context.projectId) || text(fallbackProjectId);
    return {
        owner: userId,
        ...(projectId ? { project_id: projectId } : {}),
        ...(context.projectRef ? { project_ref: { id: context.projectRef.id, type: context.projectRef.type } } : {}),
    };
}

export function withAssetRunIds(asset: VozebCmsAsset, runIds: Record<string, string | undefined>): VozebCmsAsset {
    if (asset.run_id || !asset.task_id || !runIds[asset.task_id]) return asset;
    return { ...asset, run_id: runIds[asset.task_id], metadata: compactMetadata({ ...asset.metadata, sourceRunId: runIds[asset.task_id] }) };
}

export function resolveAssetUrl(input: { serverUrl?: unknown; remoteUrl?: unknown; url?: unknown; content?: unknown; storageKey?: unknown }) {
    for (const candidate of [input.serverUrl, input.remoteUrl, input.url, input.content]) {
        const value = safeUrl(candidate);
        if (value) return value;
    }
    const storageKey = text(input.storageKey);
    if (!storageKey || /^[a-z][a-z0-9+.-]*:\/\//i.test(storageKey)) return undefined;
    return `/api/reference-assets/${storageKey.split("/").map(encodeURIComponent).join("/")}`;
}

export function compactMetadata(values: Record<string, unknown>) {
    return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== ""));
}

export function mediaAssetType(value: unknown) {
    return value === "image" || value === "panorama" || value === "video" || value === "audio" ? value : undefined;
}

export function firstText(value: unknown) {
    return Array.isArray(value) ? value.map(text).find(Boolean) : undefined;
}

export function object(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function text(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

export function safeUrl(value: unknown) {
    const candidate = text(value);
    if (!candidate || /^(?:data|blob):/i.test(candidate)) return undefined;
    return /^(?:https?:|\/|\\\\)/i.test(candidate) ? candidate : undefined;
}

export function positiveVersion(value: unknown) {
    const version = Number(value);
    return Number.isInteger(version) && version > 0 ? version : 1;
}

export function isoDate(value: unknown) {
    const date = value instanceof Date ? value : new Date(typeof value === "number" ? value : String(value || ""));
    return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString();
}
