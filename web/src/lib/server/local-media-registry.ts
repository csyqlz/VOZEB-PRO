import { readJsonDataFile, writeJsonDataFile } from "@/lib/server/data-adapter";
import { ensurePostgresSchema, getDatabaseProvider, postgresQuery, type QueryExecutor } from "@/lib/server/database";
import type { LocalMediaClass, LocalMediaType } from "@/lib/local-media-storage-contract";
import { isManagedMediaType, isMediaSourceGroup } from "@/lib/media-management-contract";

export type LocalMediaRegistration = {
    storageKey: string;
    scope: "generation" | "reference";
    storageClass: LocalMediaClass;
    type: LocalMediaType;
    ownerUserId: string;
    originalName?: string;
    source: string;
    conversationId?: string;
    runId?: string;
    taskId?: string;
    projectId?: string;
    mimeType: string;
    bytes: number;
    storageProvider?: "local" | "object";
    externalStorageId?: string;
    externalObjectKey?: string;
    externalSyncedAt?: string;
    createdAt: string;
    expiresAt?: string;
};

type RegistryDatabase = { version: 1; assets: LocalMediaRegistration[] };

export type LocalMediaRegistrationPage = {
    items: LocalMediaRegistration[];
    total: number;
    page: number;
    pageSize: number;
    summary: {
        totalFiles: number;
        totalBytes: number;
        temporaryFiles: number;
        temporaryBytes: number;
        permanentFiles: number;
        permanentBytes: number;
        expiredTemporaryFiles: number;
    };
};

export type UserLocalMediaRegistrationPage = Pick<LocalMediaRegistrationPage, "items" | "total" | "page" | "pageSize">;

export function isLocalMediaRegistrationExpired(registration: Pick<LocalMediaRegistration, "storageClass" | "expiresAt">, now = Date.now()) {
    return registration.storageClass === "temporary" && Boolean(registration.expiresAt) && Date.parse(registration.expiresAt || "") <= now;
}

const FILE_NAME = "local-media-assets.json";
let mutationQueue = Promise.resolve();

export async function registerLocalMediaAsset(input: Omit<LocalMediaRegistration, "createdAt"> & { createdAt?: string }) {
    const asset = normalizeRegistration(input);
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        await postgresQuery(
            `INSERT INTO local_media_assets (
                storage_key, scope, storage_class, type, owner_user_id, original_name, source,
                conversation_id, run_id, task_id, project_id, mime_type, bytes, storage_provider,
                external_storage_id, external_object_key, external_synced_at, created_at, expires_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
             ON CONFLICT (storage_key) DO UPDATE SET
                owner_user_id = EXCLUDED.owner_user_id, original_name = COALESCE(EXCLUDED.original_name, local_media_assets.original_name),
                source = EXCLUDED.source, conversation_id = COALESCE(EXCLUDED.conversation_id, local_media_assets.conversation_id),
                run_id = COALESCE(EXCLUDED.run_id, local_media_assets.run_id), task_id = COALESCE(EXCLUDED.task_id, local_media_assets.task_id),
                project_id = COALESCE(EXCLUDED.project_id, local_media_assets.project_id), mime_type = EXCLUDED.mime_type,
                bytes = EXCLUDED.bytes, storage_provider = EXCLUDED.storage_provider,
                external_storage_id = EXCLUDED.external_storage_id, external_object_key = EXCLUDED.external_object_key,
                external_synced_at = EXCLUDED.external_synced_at, expires_at = EXCLUDED.expires_at`,
            [
                asset.storageKey,
                asset.scope,
                asset.storageClass,
                asset.type,
                asset.ownerUserId,
                asset.originalName || null,
                asset.source,
                asset.conversationId || null,
                asset.runId || null,
                asset.taskId || null,
                asset.projectId || null,
                asset.mimeType,
                asset.bytes,
                asset.storageProvider,
                asset.externalStorageId || null,
                asset.externalObjectKey || null,
                asset.externalSyncedAt ? new Date(asset.externalSyncedAt) : null,
                new Date(asset.createdAt),
                asset.expiresAt ? new Date(asset.expiresAt) : null,
            ],
        );
        return asset;
    }
    await mutateRegistry((db) => ({ ...db, assets: [asset, ...db.assets.filter((item) => item.storageKey !== asset.storageKey)] }));
    return asset;
}

export async function getLocalMediaRegistration(storageKey: string) {
    const key = normalizeKey(storageKey);
    if (!key) return null;
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery("SELECT * FROM local_media_assets WHERE storage_key = $1", [key]);
        return result.rows[0] ? mapRegistration(result.rows[0]) : null;
    }
    return (await readRegistry()).assets.find((item) => item.storageKey === key) || null;
}

export async function getLocalMediaRegistrations(storageKeys: string[], options: { ownerUserId?: string; executor?: QueryExecutor; forUpdate?: boolean } = {}) {
    const keys = Array.from(new Set(storageKeys.map(normalizeKey).filter(Boolean)));
    if (!keys.length) return [];
    if (getDatabaseProvider() === "postgres") {
        if (!options.executor) await ensurePostgresSchema();
        const query: QueryExecutor["query"] = options.executor ? options.executor.query.bind(options.executor) : postgresQuery;
        const ownerUserId = options.ownerUserId ? text(options.ownerUserId, 160) : "";
        const result = await query(
            `SELECT * FROM local_media_assets
             WHERE storage_key = ANY($1::text[])
               AND ($2::text = '' OR owner_user_id = $2)
             ${options.forUpdate ? "FOR UPDATE" : ""}`,
            [keys, ownerUserId],
        );
        return result.rows.map(mapRegistration);
    }
    const keySet = new Set(keys);
    const ownerUserId = options.ownerUserId ? text(options.ownerUserId, 160) : "";
    return (await readRegistry()).assets.filter((item) => keySet.has(item.storageKey) && (!ownerUserId || item.ownerUserId === ownerUserId)).map(normalizeRegistration);
}

export async function listFileLocalMediaRegistrations() {
    if (getDatabaseProvider() === "postgres") throw new Error("PostgreSQL media reads must use a scoped repository query");
    return (await readRegistry()).assets.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listExpiredLocalMediaRegistrations(limit = 100) {
    const pageSize = boundedBatchSize(limit, 500, 100);
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery(
            `SELECT * FROM local_media_assets
             WHERE storage_class = 'temporary' AND expires_at IS NOT NULL AND expires_at <= now()
             ORDER BY expires_at ASC, storage_key ASC
             LIMIT $1`,
            [pageSize],
        );
        return result.rows.map(mapRegistration);
    }
    return (await readRegistry()).assets
        .filter((asset) => asset.storageClass === "temporary" && asset.expiresAt && Date.parse(asset.expiresAt) <= Date.now())
        .toSorted((left, right) => String(left.expiresAt).localeCompare(String(right.expiresAt)) || left.storageKey.localeCompare(right.storageKey))
        .slice(0, pageSize);
}

export async function listLocalMediaMigrationRegistrations(input: { limit?: number; offset?: number } = {}) {
    const limit = boundedBatchSize(input.limit, 100, 20);
    const offset = Math.max(0, Math.floor(Number(input.offset) || 0));
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const [itemsResult, totalResult] = await Promise.all([
            postgresQuery("SELECT * FROM local_media_assets WHERE storage_provider = 'local' ORDER BY created_at ASC, storage_key ASC LIMIT $1 OFFSET $2", [limit, offset]),
            postgresQuery<{ total: string | number }>("SELECT count(*) AS total FROM local_media_assets WHERE storage_provider = 'local'"),
        ]);
        return { items: itemsResult.rows.map(mapRegistration), total: Number(totalResult.rows[0]?.total || 0) };
    }
    const items = (await readRegistry()).assets.filter((item) => item.storageProvider !== "object").toSorted((left, right) => left.createdAt.localeCompare(right.createdAt) || left.storageKey.localeCompare(right.storageKey));
    return { items: items.slice(offset, offset + limit), total: items.length };
}

export async function listLocalMediaRegistrationsForUser(userId: string) {
    const ownerUserId = text(userId, 160);
    if (!ownerUserId) return [];
    if (getDatabaseProvider() === "postgres") throw new Error("PostgreSQL user media reads must use a paginated registration query");
    return (await readRegistry()).assets.filter((item) => item.ownerUserId === ownerUserId).toSorted((a, b) => b.createdAt.localeCompare(a.createdAt) || a.storageKey.localeCompare(b.storageKey));
}

export async function listLocalMediaRegistrationsForUserPage(userId: string, input: { page: number; pageSize: number }): Promise<UserLocalMediaRegistrationPage> {
    const ownerUserId = text(userId, 160);
    const page = Math.max(1, Math.floor(Number(input.page) || 1));
    const pageSize = Math.max(1, Math.min(100, Math.floor(Number(input.pageSize) || 20)));
    if (!ownerUserId) return { items: [], total: 0, page, pageSize };
    const offset = (page - 1) * pageSize;
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<Record<string, unknown>>(
            `WITH filtered AS (
                 SELECT *
                 FROM local_media_assets
                 WHERE owner_user_id = $1
             ), page_items AS (
                 SELECT *
                 FROM filtered
                 ORDER BY created_at DESC, storage_key ASC
                 LIMIT $2 OFFSET $3
             )
             SELECT page_items.*, totals.total_count
             FROM (SELECT count(*)::integer AS total_count FROM filtered) totals
             LEFT JOIN page_items ON TRUE
             ORDER BY page_items.created_at DESC NULLS LAST, page_items.storage_key ASC`,
            [ownerUserId, pageSize, offset],
        );
        return {
            items: result.rows.filter((row) => row.storage_key).map(mapRegistration),
            total: Math.max(0, Number(result.rows[0]?.total_count) || 0),
            page,
            pageSize,
        };
    }
    const registrations = await listLocalMediaRegistrationsForUser(ownerUserId);
    return { items: registrations.slice(offset, offset + pageSize), total: registrations.length, page, pageSize };
}

export async function listLocalMediaRegistrationsForDeletion(userId: string, input: { batchSize: number; executor?: QueryExecutor; forUpdate?: boolean }) {
    const ownerUserId = text(userId, 160);
    if (!ownerUserId) return [];
    if (!Number.isSafeInteger(input.batchSize) || input.batchSize < 1) throw new Error("local media deletion batch size must be a positive safe integer");
    if (getDatabaseProvider() !== "postgres") {
        return (await readRegistry()).assets.filter((item) => item.ownerUserId === ownerUserId).toSorted((a, b) => b.createdAt.localeCompare(a.createdAt) || a.storageKey.localeCompare(b.storageKey));
    }
    if (!input.executor) await ensurePostgresSchema();
    const query: QueryExecutor["query"] = input.executor ? input.executor.query.bind(input.executor) : postgresQuery;
    const registrations: LocalMediaRegistration[] = [];
    let offset = 0;
    while (true) {
        const result = await query<Record<string, unknown>>(
            `SELECT * FROM local_media_assets
             WHERE owner_user_id = $1
             ORDER BY created_at DESC, storage_key ASC
             LIMIT $2::integer OFFSET $3${input.forUpdate ? " FOR UPDATE" : ""}`,
            [ownerUserId, input.batchSize, offset],
        );
        const page = result.rows.map(mapRegistration);
        registrations.push(...page);
        if (page.length < input.batchSize) return registrations;
        offset += page.length;
    }
}

export async function listLocalMediaRegistrationPage(input: { page?: number; pageSize?: number; storageClass?: string; type?: string; source?: string; search?: string; ownerUserIds?: string[] } = {}): Promise<LocalMediaRegistrationPage> {
    const page = Math.max(1, Math.floor(Number(input.page) || 1));
    const pageSize = Math.max(1, Math.min(100, Math.floor(Number(input.pageSize) || 20)));
    if (getDatabaseProvider() !== "postgres") return listFileMediaRegistrationPage(input, page, pageSize);

    await ensurePostgresSchema();
    const storageClass = input.storageClass === "temporary" || input.storageClass === "permanent" ? input.storageClass : null;
    const type = isManagedMediaType(input.type) ? input.type : null;
    const source = isMediaSourceGroup(input.source) ? input.source : null;
    const search = (input.search || "").trim().slice(0, 160);
    const ownerUserIds = Array.from(new Set((input.ownerUserIds || []).map((value) => text(value, 160)).filter(Boolean)));
    const params = [storageClass, type, source, search, ownerUserIds.length ? ownerUserIds : null];
    const [itemsResult, totalResult, summary] = await Promise.all([
        postgresQuery(`${localMediaPageSelect()} ${localMediaPageWhere()} ORDER BY created_at DESC LIMIT $6 OFFSET $7`, [...params, pageSize, (page - 1) * pageSize]),
        postgresQuery<{ total: string | number }>(`SELECT count(*) AS total FROM local_media_assets ${localMediaPageWhere()}`, params),
        queryPostgresLocalMediaRegistrationSummary(),
    ]);
    return {
        items: itemsResult.rows.map(mapRegistration),
        total: Number(totalResult.rows[0]?.total || 0),
        page,
        pageSize,
        summary,
    };
}

export async function getLocalMediaRegistrationSummary(): Promise<LocalMediaRegistrationPage["summary"]> {
    if (getDatabaseProvider() !== "postgres") return summarizeLocalRegistrations((await readRegistry()).assets);
    await ensurePostgresSchema();
    return queryPostgresLocalMediaRegistrationSummary();
}

export async function listMediaRegistrationsByExternalObjectKeys(objectKeys: string[]) {
    const keys = Array.from(new Set(objectKeys.map(normalizeKey).filter(Boolean)));
    if (!keys.length) return [];
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery("SELECT * FROM local_media_assets WHERE external_object_key = ANY($1::text[])", [keys]);
        return result.rows.map(mapRegistration);
    }
    const keySet = new Set(keys);
    return (await readRegistry()).assets.map(normalizeRegistration).filter((item) => item.externalObjectKey && keySet.has(item.externalObjectKey));
}

export async function deleteLocalMediaRegistrations(storageKeys: string[]) {
    const keys = Array.from(new Set(storageKeys.map(normalizeKey).filter(Boolean)));
    if (!keys.length) return 0;
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        return (await postgresQuery("DELETE FROM local_media_assets WHERE storage_key = ANY($1::text[]) RETURNING storage_key", [keys])).rows.length;
    }
    let deleted = 0;
    await mutateRegistry((db) => ({
        ...db,
        assets: db.assets.filter((item) => {
            if (!keys.includes(item.storageKey)) return true;
            deleted += 1;
            return false;
        }),
    }));
    return deleted;
}

function normalizeRegistration(input: Omit<LocalMediaRegistration, "createdAt"> & { createdAt?: string }): LocalMediaRegistration {
    return {
        storageKey: normalizeKey(input.storageKey),
        scope: input.scope,
        storageClass: input.storageClass,
        type: input.type,
        ownerUserId: text(input.ownerUserId, 160),
        originalName: optionalText(input.originalName, 260),
        source: text(input.source, 120),
        conversationId: optionalText(input.conversationId, 160),
        runId: optionalText(input.runId, 160),
        taskId: optionalText(input.taskId, 160),
        projectId: optionalText(input.projectId, 160),
        mimeType: text(input.mimeType, 120),
        bytes: Math.max(0, Math.floor(Number(input.bytes) || 0)),
        storageProvider: input.storageProvider === "object" ? "object" : "local",
        externalStorageId: optionalText(input.externalStorageId, 160),
        externalObjectKey: optionalText(input.externalObjectKey, 1000),
        externalSyncedAt: validIso(input.externalSyncedAt),
        createdAt: validIso(input.createdAt) || new Date().toISOString(),
        expiresAt: validIso(input.expiresAt),
    };
}

function mapRegistration(row: Record<string, unknown>): LocalMediaRegistration {
    return normalizeRegistration({
        storageKey: String(row.storage_key || ""),
        scope: row.scope === "generation" ? "generation" : "reference",
        storageClass: row.storage_class === "temporary" ? "temporary" : "permanent",
        type: row.type === "video" || row.type === "audio" ? row.type : "image",
        ownerUserId: String(row.owner_user_id || ""),
        originalName: optionalText(row.original_name, 260),
        source: String(row.source || ""),
        conversationId: optionalText(row.conversation_id, 160),
        runId: optionalText(row.run_id, 160),
        taskId: optionalText(row.task_id, 160),
        projectId: optionalText(row.project_id, 160),
        mimeType: String(row.mime_type || ""),
        bytes: Number(row.bytes) || 0,
        storageProvider: row.storage_provider === "object" ? "object" : "local",
        externalStorageId: optionalText(row.external_storage_id, 160),
        externalObjectKey: optionalText(row.external_object_key, 1000),
        externalSyncedAt: row.external_synced_at ? databaseIso(row.external_synced_at) : undefined,
        createdAt: databaseIso(row.created_at),
        expiresAt: row.expires_at ? databaseIso(row.expires_at) : undefined,
    });
}

function localMediaPageSelect() {
    return "SELECT * FROM local_media_assets";
}

function localMediaPageWhere() {
    return `WHERE storage_provider = 'local'
              AND ($1::text IS NULL OR storage_class = $1)
              AND ($2::text IS NULL OR type = $2)
              AND ($3::text IS NULL OR ${sourceGroupSql()} = $3)
              AND (
                  $4 = ''
                  OR storage_key ILIKE '%' || $4 || '%'
                  OR coalesce(original_name, '') ILIKE '%' || $4 || '%'
                  OR owner_user_id ILIKE '%' || $4 || '%'
                  OR source ILIKE '%' || $4 || '%'
                  OR coalesce(conversation_id, '') ILIKE '%' || $4 || '%'
                  OR coalesce(run_id, '') ILIKE '%' || $4 || '%'
                  OR coalesce(task_id, '') ILIKE '%' || $4 || '%'
                  OR coalesce(project_id, '') ILIKE '%' || $4 || '%'
                  OR ($5::text[] IS NOT NULL AND owner_user_id = ANY($5::text[]))
              )`;
}

function sourceGroupSql() {
    return `CASE
                WHEN source = 'agent' THEN 'agent'
                WHEN source IN ('image-workbench', 'image-task', 'image-task-reference') THEN 'image-workbench'
                WHEN source IN ('video-workbench', 'video-task') THEN 'video-workbench'
                WHEN source = 'canvas' THEN 'canvas'
                WHEN source IN ('drama', 'drama-render') THEN 'drama'
                WHEN source IN ('user-upload', 'creative-upload') THEN 'upload'
                ELSE 'other'
            END`;
}

async function listFileMediaRegistrationPage(input: { storageClass?: string; type?: string; source?: string; search?: string; ownerUserIds?: string[] }, page: number, pageSize: number): Promise<LocalMediaRegistrationPage> {
    const search = (input.search || "").trim().toLowerCase();
    const ownerUserIds = new Set(input.ownerUserIds || []);
    const all = (await readRegistry()).assets.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
    const filtered = all
        .filter((item) => (input.storageClass === "temporary" || input.storageClass === "permanent" ? item.storageClass === input.storageClass : true))
        .filter((item) => (isManagedMediaType(input.type) ? item.type === input.type : true))
        .filter((item) => (isMediaSourceGroup(input.source) ? sourceGroup(item.source) === input.source : true))
        .filter(
            (item) =>
                !search ||
                ownerUserIds.has(item.ownerUserId) ||
                `${item.storageKey} ${item.originalName || ""} ${item.ownerUserId} ${item.source} ${item.conversationId || ""} ${item.runId || ""} ${item.taskId || ""} ${item.projectId || ""}`.toLowerCase().includes(search),
        );
    return {
        items: filtered.slice((page - 1) * pageSize, page * pageSize),
        total: filtered.length,
        page,
        pageSize,
        summary: summarizeLocalRegistrations(all),
    };
}

function summarizeLocalRegistrations(items: LocalMediaRegistration[]) {
    const temporary = items.filter((item) => item.storageClass === "temporary");
    const permanent = items.filter((item) => item.storageClass === "permanent");
    return {
        totalFiles: items.length,
        totalBytes: sumRegistrationBytes(items),
        temporaryFiles: temporary.length,
        temporaryBytes: sumRegistrationBytes(temporary),
        permanentFiles: permanent.length,
        permanentBytes: sumRegistrationBytes(permanent),
        expiredTemporaryFiles: temporary.filter((item) => item.expiresAt && Date.parse(item.expiresAt) <= Date.now()).length,
    };
}

async function queryPostgresLocalMediaRegistrationSummary(): Promise<LocalMediaRegistrationPage["summary"]> {
    const result = await postgresQuery<Record<string, unknown>>(
        `SELECT
            count(*)::int AS total_files,
            coalesce(sum(bytes), 0) AS total_bytes,
            count(*) FILTER (WHERE storage_class = 'temporary')::int AS temporary_files,
            coalesce(sum(bytes) FILTER (WHERE storage_class = 'temporary'), 0) AS temporary_bytes,
            count(*) FILTER (WHERE storage_class = 'permanent')::int AS permanent_files,
            coalesce(sum(bytes) FILTER (WHERE storage_class = 'permanent'), 0) AS permanent_bytes,
            count(*) FILTER (WHERE storage_class = 'temporary' AND expires_at <= now())::int AS expired_temporary_files
         FROM local_media_assets
         WHERE storage_provider = 'local'`,
    );
    const row = result.rows[0] || {};
    return {
        totalFiles: Number(row.total_files || 0),
        totalBytes: Number(row.total_bytes || 0),
        temporaryFiles: Number(row.temporary_files || 0),
        temporaryBytes: Number(row.temporary_bytes || 0),
        permanentFiles: Number(row.permanent_files || 0),
        permanentBytes: Number(row.permanent_bytes || 0),
        expiredTemporaryFiles: Number(row.expired_temporary_files || 0),
    };
}

function sourceGroup(source: string) {
    const value = source.trim().toLowerCase();
    if (value === "agent") return "agent";
    if (["image-workbench", "image-task", "image-task-reference"].includes(value)) return "image-workbench";
    if (["video-workbench", "video-task"].includes(value)) return "video-workbench";
    if (value === "canvas") return "canvas";
    if (["drama", "drama-render"].includes(value)) return "drama";
    if (["user-upload", "creative-upload"].includes(value)) return "upload";
    return "other";
}

function sumRegistrationBytes(items: LocalMediaRegistration[]) {
    return items.reduce((sum, item) => sum + item.bytes, 0);
}

function boundedBatchSize(value: unknown, max: number, fallback: number) {
    return Math.max(1, Math.min(max, Math.floor(Number(value) || fallback)));
}

function readRegistry() {
    return readJsonDataFile<RegistryDatabase>(FILE_NAME, { version: 1, assets: [] });
}

function mutateRegistry(mutator: (db: RegistryDatabase) => RegistryDatabase) {
    const operation = mutationQueue.then(async () => writeJsonDataFile(FILE_NAME, mutator(await readRegistry())));
    mutationQueue = operation.catch(() => undefined);
    return operation;
}

function normalizeKey(value: unknown) {
    return typeof value === "string" ? value.trim().replace(/\\/g, "/").replace(/^\/+/, "").slice(0, 700) : "";
}

function text(value: unknown, max: number) {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function optionalText(value: unknown, max: number) {
    return text(value, max) || undefined;
}

function validIso(value: unknown) {
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return undefined;
    return new Date(value).toISOString();
}

function databaseIso(value: unknown) {
    const date = value instanceof Date ? value : new Date(String(value || ""));
    return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}
