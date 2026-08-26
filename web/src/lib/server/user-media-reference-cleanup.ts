import type { CanvasProject } from "@/lib/canvas-project-contract";
import { localMediaStorageKeyFromValue } from "@/lib/server/local-media-references";

const REMOVED = Symbol("removed-media-reference");
const MEDIA_NODE_TYPES = new Set(["image", "panorama", "video", "audio"]);
const MEDIA_FIELDS = new Set(["storagekey", "storage_key", "serverurl", "server_url", "remoteurl", "remote_url", "url", "dataurl", "data_url", "src", "previewurl", "preview_url", "coverurl", "cover_url", "thumbnailurl", "thumbnail_url"]);

type ReferenceMatcher = {
    storageKeys: Set<string>;
    tokens: string[];
};

export type MediaReferenceCleanupResult<T> = {
    value: T;
    changed: boolean;
};

export function containsUserMediaReference(value: unknown, storageKeys: string[]) {
    return containsReference(value, createMatcher(storageKeys));
}

export function cleanUserMediaReferences<T>(value: T, storageKeys: string[], referenceIds: string[] = []): MediaReferenceCleanupResult<T> {
    const matcher = createMatcher(storageKeys, referenceIds);
    const cleaned = visit(value, matcher, false);
    return cleaned === REMOVED ? { value: undefined as T, changed: true } : { value: cleaned.value as T, changed: cleaned.changed };
}

export function cleanCanvasProjectMediaReferences(project: CanvasProject, storageKeys: string[]): MediaReferenceCleanupResult<CanvasProject> & { removedNodeIds: string[] } {
    const matcher = createMatcher(storageKeys);
    const nodes = Array.isArray(project.nodes) ? project.nodes : [];
    const connections = Array.isArray(project.connections) ? project.connections : [];
    const removedNodeIds = nodes.filter((node) => MEDIA_NODE_TYPES.has(node.type) && containsReference(node, matcher)).map((node) => node.id);
    const removedNodeIdSet = new Set(removedNodeIds);
    const nextProject = {
        ...project,
        nodes: nodes.filter((node) => !removedNodeIdSet.has(node.id)),
        connections: connections.filter((connection) => !removedNodeIdSet.has(connection.fromNodeId) && !removedNodeIdSet.has(connection.toNodeId)),
    };
    const cleaned = cleanUserMediaReferences(nextProject, storageKeys, removedNodeIds);
    return { ...cleaned, changed: cleaned.changed || removedNodeIds.length > 0, removedNodeIds };
}

function visit(value: unknown, matcher: ReferenceMatcher, dropDirectMediaObject: boolean): { value: unknown; changed: boolean } | typeof REMOVED {
    if (typeof value === "string") return matchesReference(value, matcher) ? REMOVED : { value, changed: false };
    if (Array.isArray(value)) {
        let changed = false;
        const items: unknown[] = [];
        for (const item of value) {
            if (isObject(item) && isDirectMediaObject(item, matcher)) {
                changed = true;
                continue;
            }
            const cleaned = visit(item, matcher, true);
            if (cleaned === REMOVED) changed = true;
            else {
                changed ||= cleaned.changed;
                items.push(cleaned.value);
            }
        }
        return { value: items, changed };
    }
    if (!isObject(value)) return { value, changed: false };
    if (dropDirectMediaObject && isDirectMediaObject(value, matcher)) return REMOVED;
    let changed = false;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
        const cleaned = visit(item, matcher, Array.isArray(item));
        if (cleaned === REMOVED) changed = true;
        else {
            changed ||= cleaned.changed;
            result[key] = cleaned.value;
        }
    }
    return { value: result, changed };
}

function containsReference(value: unknown, matcher: ReferenceMatcher): boolean {
    if (typeof value === "string") return matchesReference(value, matcher);
    if (Array.isArray(value)) return value.some((item) => containsReference(item, matcher));
    return isObject(value) && Object.values(value).some((item) => containsReference(item, matcher));
}

function isDirectMediaObject(value: Record<string, unknown>, matcher: ReferenceMatcher) {
    return Object.entries(value).some(([key, item]) => typeof item === "string" && MEDIA_FIELDS.has(key.toLowerCase()) && matchesReference(item, matcher));
}

function matchesReference(value: string, matcher: ReferenceMatcher) {
    const normalized = value.trim().replace(/\\/g, "/");
    const storageKey = localMediaStorageKeyFromValue(normalized);
    return (storageKey && matcher.storageKeys.has(storageKey)) || matcher.tokens.some((token) => normalized.includes(token));
}

function createMatcher(storageKeys: string[], referenceIds: string[] = []): ReferenceMatcher {
    const normalizedKeys = Array.from(new Set(storageKeys.map(normalizeKey).filter(Boolean)));
    const tokens = new Set(referenceIds.map((value) => value.trim()).filter(Boolean));
    for (const key of normalizedKeys) {
        tokens.add(key);
        tokens.add(key.split("/").map(encodeURIComponent).join("/"));
    }
    return { storageKeys: new Set(normalizedKeys), tokens: Array.from(tokens).sort((left, right) => right.length - left.length) };
}

function normalizeKey(value: unknown) {
    return typeof value === "string" ? value.trim().replace(/\\/g, "/").replace(/^\/+/, "") : "";
}

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
