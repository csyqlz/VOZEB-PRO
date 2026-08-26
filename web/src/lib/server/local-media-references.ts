import { readJsonDataFile } from "@/lib/server/data-adapter";
import { ensurePostgresSchema, getDatabaseProvider, postgresQuery } from "@/lib/server/database";

export type LocalMediaReferenceCountOptions = {
    /** Exclude generation logs, tasks, and the transient creative timeline when expiring temporary media. */
    includeEphemeral?: boolean;
};

export async function countLocalMediaReferences(storageKeys: string[], options: LocalMediaReferenceCountOptions = {}) {
    const keys = Array.from(new Set(storageKeys.map(normalizeKey).filter(Boolean)));
    const counts = new Map(keys.map((key) => [key, 0]));
    if (!keys.length) return counts;
    const includeEphemeral = options.includeEphemeral !== false;
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const referenceQueries = [
            `SELECT r.storage_key, count(*)::int AS total
             FROM requested r
             JOIN library_assets a ON position(r.storage_key in COALESCE(a.asset_json::text, '')) > 0
             GROUP BY r.storage_key`,
            `SELECT r.storage_key, count(*)::int
             FROM requested r
             JOIN canvas_projects p ON position(r.storage_key in COALESCE(p.project_json::text, '')) > 0
             GROUP BY r.storage_key`,
            `SELECT r.storage_key, count(*)::int
             FROM requested r
             JOIN drama_projects p ON position(r.storage_key in COALESCE(p.project_json::text, '')) > 0
             GROUP BY r.storage_key`,
            `SELECT r.storage_key, count(*)::int
             FROM requested r
             JOIN published_work_assets a ON a.storage_key = r.storage_key
             GROUP BY r.storage_key`,
            `SELECT r.storage_key, count(*)::int
             FROM requested r
             JOIN users u ON u.avatar_storage_key = r.storage_key
             GROUP BY r.storage_key`,
        ];
        if (includeEphemeral) {
            referenceQueries.unshift(
                `SELECT r.storage_key, count(*)::int AS total
                 FROM requested r
                 JOIN creative_assets a ON a.status <> 'deleted'
                     AND (a.storage_key = r.storage_key OR position(r.storage_key in COALESCE(a.server_url, '')) > 0)
                 GROUP BY r.storage_key`,
            );
            referenceQueries.splice(
                4,
                0,
                `SELECT r.storage_key, count(*)::int
                 FROM requested r
                 JOIN generation_log_assets a ON position(r.storage_key in COALESCE(a.server_url, '')) > 0
                     OR position(r.storage_key in COALESCE(a.url, '')) > 0
                 GROUP BY r.storage_key`,
                `SELECT r.storage_key, count(*)::int
                 FROM requested r
                 JOIN generation_tasks t ON position(r.storage_key in COALESCE(t.payload::text, '')) > 0
                     OR position(r.storage_key in COALESCE(t.result_payload::text, '')) > 0
                 GROUP BY r.storage_key`,
            );
        }
        const result = await postgresQuery<{ storage_key: string; total: number | string }>(
            `WITH requested AS (
                SELECT unnest($1::text[]) AS storage_key
            ), reference_counts AS (${referenceQueries.join(" UNION ALL ")})
            SELECT r.storage_key, COALESCE(sum(c.total), 0)::int AS total
            FROM requested r
            LEFT JOIN reference_counts c ON c.storage_key = r.storage_key
            GROUP BY r.storage_key`,
            [keys],
        );
        for (const row of result.rows) counts.set(normalizeKey(row.storage_key), Number(row.total) || 0);
        return counts;
    }
    const databaseNames = [
        ...(includeEphemeral ? ["creative-runtime.json"] : []),
        "library-assets.json",
        "canvas-projects.json",
        "drama-projects.json",
        ...(includeEphemeral ? ["generation-logs.json", "generation-tasks.json"] : []),
        "auth.json",
    ];
    const databases: unknown[] = await Promise.all(databaseNames.map((name) => readJsonDataFile<unknown>(name, name === "generation-tasks.json" ? [] : {})));
    for (const key of keys)
        counts.set(
            key,
            databases.reduce<number>((total, database) => total + countEntitiesContaining(database, key), 0),
        );
    return counts;
}

export function collectLocalMediaStorageKeys(value: unknown) {
    const keys = new Set<string>();
    visit(value, keys);
    return Array.from(keys);
}

function visit(value: unknown, keys: Set<string>) {
    if (typeof value === "string") {
        const key = localMediaStorageKeyFromValue(value);
        if (key) keys.add(key);
        return;
    }
    if (Array.isArray(value)) return value.forEach((item) => visit(item, keys));
    if (value && typeof value === "object") Object.values(value as Record<string, unknown>).forEach((item) => visit(item, keys));
}

export function localMediaStorageKeyFromValue(value: string) {
    const normalized = value.trim().replace(/\\/g, "/");
    for (const route of ["/api/reference-assets/", "/api/generation-log-assets/"]) {
        const routeIndex = normalized.indexOf(route);
        if (routeIndex >= 0) return decodeStoragePath(normalized.slice(routeIndex + route.length).split(/[?#]/, 1)[0]);
    }
    return /^(?:temporary|permanent)\//.test(normalized) ? normalized : "";
}

function decodeStoragePath(value: string) {
    try {
        return value.split("/").map(decodeURIComponent).join("/");
    } catch {
        return "";
    }
}

function countEntitiesContaining(value: unknown, key: string): number {
    if (!value || typeof value !== "object") return 0;
    const roots = Array.isArray(value)
        ? value
        : (Object.values(value as Record<string, unknown>)
              .filter(Array.isArray)
              .flat() as unknown[]);
    return roots.reduce<number>((total, item) => total + (contains(item, key) ? 1 : 0), 0);
}

function contains(value: unknown, key: string): boolean {
    if (typeof value === "string") return value.includes(key);
    if (Array.isArray(value)) return value.some((item) => contains(item, key));
    if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).some((item) => contains(item, key));
    return false;
}

function normalizeKey(value: unknown) {
    return typeof value === "string" ? value.trim().replace(/\\/g, "/").replace(/^\/+/, "") : "";
}
