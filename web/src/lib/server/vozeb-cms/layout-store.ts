import { randomUUID } from "node:crypto";

import { readJsonDataFile, withJsonDataFileLock, writeJsonDataFile } from "@/lib/server/data-adapter";
import { ensurePostgresSchema, getDatabaseProvider, postgresQuery, withPostgresTransaction, type QueryExecutor } from "@/lib/server/database";
import { normalizeStoredVozebCmsLayout, type VozebCmsLayoutDefinition } from "@/lib/vozeb-cms/layout-contract";

type LayoutRevision = { layoutId: string; revision: number; definition: VozebCmsLayoutDefinition; createdBy: string; createdAt: number };
type SitePublication = { path: string; layoutId: string; revision: number; publishedBy: string; publishedAt: number };
type LayoutDatabase = { version: 1; layouts: VozebCmsLayoutDefinition[]; revisions: LayoutRevision[]; publications: SitePublication[] };
const FILE_NAME = "vozeb-layouts.json";
let mutationQueue = Promise.resolve();

export class VozebCmsLayoutStoreError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
    }
}

export async function createVozebCmsLayout(definition: VozebCmsLayoutDefinition) {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ definition_json: VozebCmsLayoutDefinition }>(
            `INSERT INTO vozeb_layouts (id, user_id, project_id, project_type, module_id, site_path, name, status, draft_revision, published_revision, definition_json, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10::jsonb, $11, $12)
             ON CONFLICT (id) DO NOTHING
             RETURNING definition_json`,
            [
                definition.id,
                definition.userId,
                definition.projectRef?.id || null,
                definition.projectRef?.type || null,
                definition.moduleId || null,
                definition.site?.path || null,
                definition.name,
                definition.status,
                definition.revision,
                JSON.stringify(definition),
                new Date(definition.createdAt),
                new Date(definition.updatedAt),
            ],
        );
        if (result.rows[0]?.definition_json) return normalizeStoredVozebCmsLayout(result.rows[0].definition_json, definition.userId);
        throw new VozebCmsLayoutStoreError("页面已存在", 409);
    }
    await mutateDatabase((database) => {
        if (database.layouts.some((item) => item.id === definition.id && item.userId === definition.userId)) throw new VozebCmsLayoutStoreError("页面已存在", 409);
        return { ...database, layouts: [definition, ...database.layouts] };
    });
    return definition;
}

export async function listVozebCmsLayouts(userId: string, input: { projectId?: string; projectType?: string; sitePath?: string; limit?: number } = {}) {
    const limit = boundedLimit(input.limit, 50);
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ definition_json: VozebCmsLayoutDefinition }>(
            `SELECT definition_json FROM vozeb_layouts
             WHERE user_id = $1 AND ($2::text IS NULL OR project_id = $2) AND ($3::text IS NULL OR project_type = $3) AND ($4::text IS NULL OR site_path = $4)
             ORDER BY updated_at DESC, id ASC LIMIT $5`,
            [userId, input.projectId || null, input.projectType || null, input.sitePath || null, limit],
        );
        return result.rows.map((row) => normalizeStoredVozebCmsLayout(row.definition_json, userId));
    }
    return (await readDatabase()).layouts
        .filter((item) => item.userId === userId && (!input.projectId || item.projectRef?.id === input.projectId) && (!input.projectType || item.projectRef?.type === input.projectType) && (!input.sitePath || item.site?.path === input.sitePath))
        .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
        .slice(0, limit);
}

export async function getVozebCmsLayout(userId: string, id: string) {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ definition_json: VozebCmsLayoutDefinition }>("SELECT definition_json FROM vozeb_layouts WHERE id = $1 AND user_id = $2", [id, userId]);
        return result.rows[0]?.definition_json ? normalizeStoredVozebCmsLayout(result.rows[0].definition_json, userId) : null;
    }
    return (await readDatabase()).layouts.find((item) => item.id === id && item.userId === userId) || null;
}

export async function saveVozebCmsLayoutDraft(userId: string, id: string, baseRevision: number, definition: VozebCmsLayoutDefinition, mutationId: string) {
    const current = await getVozebCmsLayout(userId, id);
    if (!current) throw new VozebCmsLayoutStoreError("页面不存在", 404);
    if (current.revision !== baseRevision && current.id === id) {
        if (current.revision === definition.revision && (current as VozebCmsLayoutDefinition & { lastMutationId?: string }).lastMutationId === mutationId) return current;
        throw new VozebCmsLayoutStoreError("页面已被其他请求更新，请刷新后重试", 409);
    }
    const next = { ...definition, id, userId, status: "draft" as const, revision: baseRevision + 1, lastMutationId: mutationId, publishedRevision: current.publishedRevision, createdAt: current.createdAt, updatedAt: Date.now() };
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ definition_json: VozebCmsLayoutDefinition }>(
            `UPDATE vozeb_layouts SET name = $3, project_id = $4, project_type = $5, module_id = $6, site_path = $7, status = 'draft', draft_revision = $8, published_revision = $9, definition_json = $10::jsonb, last_mutation_id = $11, updated_at = $12
             WHERE id = $1 AND user_id = $2 AND draft_revision = $13 RETURNING definition_json`,
            [
                id,
                userId,
                next.name,
                next.projectRef?.id || null,
                next.projectRef?.type || null,
                next.moduleId || null,
                next.site?.path || null,
                next.revision,
                next.publishedRevision || null,
                JSON.stringify(next),
                mutationId,
                new Date(next.updatedAt),
                baseRevision,
            ],
        );
        if (!result.rows[0]?.definition_json) throw new VozebCmsLayoutStoreError("页面已被其他请求更新，请刷新后重试", 409);
        return normalizeStoredVozebCmsLayout(result.rows[0].definition_json, userId);
    }
    let saved: VozebCmsLayoutDefinition | null = null;
    await mutateDatabase((database) => {
        const index = database.layouts.findIndex((item) => item.id === id && item.userId === userId);
        if (index < 0) throw new VozebCmsLayoutStoreError("页面不存在", 404);
        if (database.layouts[index].revision !== baseRevision) throw new VozebCmsLayoutStoreError("页面已被其他请求更新，请刷新后重试", 409);
        saved = next;
        return { ...database, layouts: database.layouts.map((item, itemIndex) => (itemIndex === index ? next : item)) };
    });
    return saved!;
}

export async function publishVozebCmsLayout(userId: string, id: string, baseRevision: number, publishedBy: string) {
    const current = await getVozebCmsLayout(userId, id);
    if (!current) throw new VozebCmsLayoutStoreError("页面不存在", 404);
    if (current.revision !== baseRevision) throw new VozebCmsLayoutStoreError("页面已被其他请求更新，请刷新后重试", 409);
    const publishedAt = Date.now();
    const next = { ...current, status: "published" as const, publishedRevision: current.revision, publishedAt, updatedAt: publishedAt };
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const saved = await withPostgresTransaction(async (client) => {
            const result = await client.query<{ definition_json: VozebCmsLayoutDefinition }>(
                "UPDATE vozeb_layouts SET status = 'published', published_revision = $3, definition_json = $4::jsonb, published_at = $5, updated_at = $5 WHERE id = $1 AND user_id = $2 AND draft_revision = $3 RETURNING definition_json",
                [id, userId, current.revision, JSON.stringify(next), new Date(publishedAt)],
            );
            const definition = result.rows[0]?.definition_json;
            if (!definition) throw new VozebCmsLayoutStoreError("页面已被其他请求更新，请刷新后重试", 409);
            await insertPostgresLayoutRevision(client, { layoutId: id, revision: current.revision, definition: next, createdBy: publishedBy, createdAt: publishedAt });
            await replacePostgresSitePublication(client, { path: current.site?.path || "", layoutId: id, revision: current.revision, publishedBy, publishedAt });
            return definition;
        });
        return normalizeStoredVozebCmsLayout(saved, userId);
    }
    let saved: VozebCmsLayoutDefinition | null = null;
    await mutateDatabase((database) => {
        const index = database.layouts.findIndex((item) => item.id === id && item.userId === userId);
        if (index < 0 || database.layouts[index].revision !== baseRevision) throw new VozebCmsLayoutStoreError("页面已被其他请求更新，请刷新后重试", 409);
        saved = next;
        const publication = current.site?.path ? { path: current.site.path, layoutId: id, revision: current.revision, publishedBy, publishedAt } : undefined;
        return {
            ...database,
            layouts: database.layouts.map((item, itemIndex) => (itemIndex === index ? next : item)),
            revisions: [{ layoutId: id, revision: current.revision, definition: next, createdBy: publishedBy, createdAt: publishedAt }, ...database.revisions.filter((item) => !(item.layoutId === id && item.revision === current.revision))],
            publications: publication ? [publication, ...database.publications.filter((item) => item.path !== publication.path && item.layoutId !== id)] : database.publications.filter((item) => item.layoutId !== id),
        };
    });
    return saved!;
}

export async function rollbackVozebCmsLayout(userId: string, id: string, targetRevision: number, baseRevision: number, updatedBy: string) {
    const current = await getVozebCmsLayout(userId, id);
    if (!current) throw new VozebCmsLayoutStoreError("页面不存在", 404);
    if (current.revision !== baseRevision) throw new VozebCmsLayoutStoreError("页面已被其他请求更新，请刷新后重试", 409);
    const snapshot = getDatabaseProvider() === "postgres" ? await getPostgresLayoutRevision(userId, id, targetRevision) : (await readDatabase()).revisions.find((item) => item.layoutId === id && item.revision === targetRevision)?.definition;
    if (!snapshot) throw new VozebCmsLayoutStoreError("页面版本不存在", 404);
    return saveVozebCmsLayoutDraft(userId, id, baseRevision, { ...snapshot, status: "draft", revision: baseRevision, publishedRevision: current.publishedRevision, updatedAt: Date.now() }, randomUUID() + `:${updatedBy}`);
}

export async function getPublishedVozebCmsLayout(userId: string, id: string) {
    const current = await getVozebCmsLayout(userId, id);
    if (!current?.publishedRevision) return null;
    if (getDatabaseProvider() === "postgres") return getPostgresLayoutRevision(userId, id, current.publishedRevision);
    return (await readDatabase()).revisions.find((item) => item.layoutId === id && item.revision === current.publishedRevision)?.definition || null;
}

export async function getPublishedVozebCmsSiteLayout(path: string) {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ definition_json: VozebCmsLayoutDefinition; user_id: string }>(
            `SELECT revision.definition_json, layout.user_id
             FROM vozeb_site_publications publication
             INNER JOIN vozeb_layouts layout ON layout.id = publication.layout_id
             INNER JOIN vozeb_layout_revisions revision ON revision.layout_id = publication.layout_id AND revision.revision = publication.revision
             WHERE publication.path = $1`,
            [path],
        );
        const row = result.rows[0];
        return row?.definition_json ? normalizeStoredVozebCmsLayout(row.definition_json, row.user_id) : null;
    }
    const database = await readDatabase();
    const publication = database.publications.find((item) => item.path === path);
    if (!publication) return null;
    return database.revisions.find((item) => item.layoutId === publication.layoutId && item.revision === publication.revision)?.definition || null;
}

async function replacePostgresSitePublication(client: QueryExecutor, publication: SitePublication) {
    await client.query("DELETE FROM vozeb_site_publications WHERE layout_id = $1 AND ($2::text = '' OR path <> $2)", [publication.layoutId, publication.path]);
    if (!publication.path) return;
    await client.query(
        `INSERT INTO vozeb_site_publications (path, layout_id, revision, published_by, published_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (path) DO UPDATE SET layout_id = EXCLUDED.layout_id, revision = EXCLUDED.revision, published_by = EXCLUDED.published_by, published_at = EXCLUDED.published_at`,
        [publication.path, publication.layoutId, publication.revision, publication.publishedBy, new Date(publication.publishedAt)],
    );
}

async function insertPostgresLayoutRevision(client: QueryExecutor, revision: LayoutRevision) {
    await client.query(
        "INSERT INTO vozeb_layout_revisions (layout_id, revision, definition_json, created_by, created_at) VALUES ($1, $2, $3::jsonb, $4, $5) ON CONFLICT (layout_id, revision) DO UPDATE SET definition_json = EXCLUDED.definition_json, created_by = EXCLUDED.created_by, created_at = EXCLUDED.created_at",
        [revision.layoutId, revision.revision, JSON.stringify(revision.definition), revision.createdBy, new Date(revision.createdAt)],
    );
}

async function getPostgresLayoutRevision(userId: string, layoutId: string, revision: number) {
    await ensurePostgresSchema();
    const result = await postgresQuery<{ definition_json: VozebCmsLayoutDefinition }>(
        "SELECT revision.definition_json FROM vozeb_layout_revisions revision INNER JOIN vozeb_layouts layout ON layout.id = revision.layout_id WHERE revision.layout_id = $1 AND revision.revision = $2 AND layout.user_id = $3",
        [layoutId, revision, userId],
    );
    return result.rows[0]?.definition_json ? normalizeStoredVozebCmsLayout(result.rows[0].definition_json, userId) : null;
}

function readDatabase() {
    return readJsonDataFile<Partial<LayoutDatabase>>(FILE_NAME, { version: 1, layouts: [], revisions: [], publications: [] }).then(normalizeDatabase);
}

function mutateDatabase(mutator: (database: LayoutDatabase) => LayoutDatabase) {
    const operation = mutationQueue.then(() => withJsonDataFileLock(FILE_NAME, async () => writeJsonDataFile(FILE_NAME, mutator(await readDatabase()))));
    mutationQueue = operation.then(
        () => undefined,
        () => undefined,
    );
    return operation;
}

function normalizeDatabase(value: Partial<LayoutDatabase>): LayoutDatabase {
    return { version: 1, layouts: Array.isArray(value.layouts) ? value.layouts : [], revisions: Array.isArray(value.revisions) ? value.revisions : [], publications: Array.isArray(value.publications) ? value.publications : [] };
}

function boundedLimit(value: unknown, fallback: number) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? Math.min(number, 100) : fallback;
}
