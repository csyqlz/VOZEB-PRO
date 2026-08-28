import { nanoid } from "nanoid";

import type { DramaProject, DramaProjectVersion } from "@/lib/drama-project-contract";
import { readJsonDataFile, writeJsonDataFile } from "@/lib/server/data-adapter";
import { ensurePostgresSchema, getDatabaseProvider, postgresQuery, withPostgresTransaction } from "@/lib/server/database";

type VersionRecord = DramaProjectVersion & { userId: string; snapshot: DramaProject };
type VersionDatabase = { version: 1; items: VersionRecord[]; nextVersionByProject?: Record<string, number> };

const FILE_NAME = "drama-project-versions.json";
const DRAMA_PROJECT_VERSION_RETENTION = 3;
const PRUNE_POSTGRES_VERSIONS_SQL = `DELETE FROM drama_project_versions
    WHERE user_id = $1 AND project_id = $2
      AND id NOT IN (
          SELECT id FROM drama_project_versions
          WHERE user_id = $1 AND project_id = $2
          ORDER BY version DESC
          LIMIT $3
      )`;

export async function listDramaProjectVersions(userId: string, projectId: string): Promise<DramaProjectVersion[]> {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        await postgresQuery(PRUNE_POSTGRES_VERSIONS_SQL, [userId, projectId, DRAMA_PROJECT_VERSION_RETENTION]);
        const result = await postgresQuery<DramaProjectVersion>('SELECT id, project_id AS "projectId", version, reason, created_at AS "createdAt" FROM drama_project_versions WHERE user_id = $1 AND project_id = $2 ORDER BY version DESC LIMIT $3', [
            userId,
            projectId,
            DRAMA_PROJECT_VERSION_RETENTION,
        ]);
        return result.rows;
    }
    return mutateDatabase((current) => {
        const database = retainLatestProjectVersions(current, userId, projectId);
        const result = database.items
            .filter((item) => item.userId === userId && item.projectId === projectId)
            .sort((a, b) => b.version - a.version)
            .slice(0, DRAMA_PROJECT_VERSION_RETENTION)
            .map(({ userId: _userId, snapshot: _snapshot, ...item }) => item);
        return { database, result };
    });
}

export async function createDramaProjectVersion(userId: string, projectId: string, reason: string, snapshot: DramaProject) {
    const id = `drama-version-${nanoid()}`;
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        return withPostgresTransaction(async (client) => {
            const project = await client.query<{ version_sequence: number }>("SELECT version_sequence FROM drama_projects WHERE id = $1 AND user_id = $2 FOR UPDATE", [projectId, userId]);
            const existing = await client.query<{ max_version: number }>("SELECT COALESCE(MAX(version), 0) AS max_version FROM drama_project_versions WHERE user_id = $1 AND project_id = $2", [userId, projectId]);
            const version = Math.max(Number(project.rows[0]?.version_sequence || 0), Number(existing.rows[0]?.max_version || 0)) + 1;
            const createdAt = new Date().toISOString();
            await client.query("UPDATE drama_projects SET version_sequence = $3 WHERE id = $1 AND user_id = $2", [projectId, userId, version]);
            await client.query("INSERT INTO drama_project_versions (id, project_id, user_id, version, reason, snapshot, created_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)", [
                id,
                projectId,
                userId,
                version,
                reason,
                JSON.stringify(snapshot),
                new Date(createdAt),
            ]);
            await client.query(PRUNE_POSTGRES_VERSIONS_SQL, [userId, projectId, DRAMA_PROJECT_VERSION_RETENTION]);
            return { id, projectId, version, reason, createdAt } satisfies DramaProjectVersion;
        });
    }
    return mutateDatabase((database) => {
        const counterKey = versionCounterKey(userId, projectId);
        const version = Math.max(database.nextVersionByProject?.[counterKey] || 0, ...database.items.filter((item) => item.userId === userId && item.projectId === projectId).map((item) => item.version)) + 1;
        const item: VersionRecord = { id, projectId, userId, version, reason, snapshot, createdAt: new Date().toISOString() };
        const nextDatabase = retainLatestProjectVersions(
            {
                ...database,
                items: [item, ...database.items],
                nextVersionByProject: { ...database.nextVersionByProject, [counterKey]: version },
            },
            userId,
            projectId,
        );
        return {
            database: nextDatabase,
            result: item,
        };
    });
}

export async function deleteDramaProjectVersion(userId: string, projectId: string, versionId: string): Promise<boolean> {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ id: string }>("DELETE FROM drama_project_versions WHERE id = $1 AND user_id = $2 AND project_id = $3 RETURNING id", [versionId, userId, projectId]);
        return Boolean(result.rows[0]);
    }
    return mutateDatabase((database) => {
        const items = database.items.filter((item) => item.id !== versionId || item.userId !== userId || item.projectId !== projectId);
        return { database: items.length === database.items.length ? database : { ...database, items }, result: items.length < database.items.length };
    });
}

export async function getDramaProjectVersion(userId: string, projectId: string, versionId: string) {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ id: string; project_id: string; version: number; reason: string; created_at: string; snapshot: DramaProject }>(
            "SELECT id, project_id, version, reason, created_at, snapshot FROM drama_project_versions WHERE id = $1 AND user_id = $2 AND project_id = $3",
            [versionId, userId, projectId],
        );
        const row = result.rows[0];
        return row ? { id: row.id, projectId: row.project_id, version: row.version, reason: row.reason, createdAt: row.created_at, snapshot: row.snapshot } : null;
    }
    return (await readDatabase()).items.find((item) => item.id === versionId && item.userId === userId && item.projectId === projectId) || null;
}

async function readDatabase() {
    return readJsonDataFile<VersionDatabase>(FILE_NAME, { version: 1, items: [] });
}

function writeDatabase(database: VersionDatabase) {
    return writeJsonDataFile(FILE_NAME, database);
}

function versionCounterKey(userId: string, projectId: string) {
    return JSON.stringify([userId, projectId]);
}

function retainLatestProjectVersions(database: VersionDatabase, userId: string, projectId: string): VersionDatabase {
    const retainedIds = new Set(
        database.items
            .filter((item) => item.userId === userId && item.projectId === projectId)
            .sort((a, b) => b.version - a.version)
            .slice(0, DRAMA_PROJECT_VERSION_RETENTION)
            .map((item) => item.id),
    );
    const items = database.items.filter((item) => item.userId !== userId || item.projectId !== projectId || retainedIds.has(item.id));
    return items.length === database.items.length ? database : { ...database, items };
}

let mutationQueue = Promise.resolve();
function mutateDatabase<T>(mutator: (database: VersionDatabase) => { database: VersionDatabase; result: T }) {
    const operation = mutationQueue.then(async () => {
        const mutation = mutator(await readDatabase());
        await writeDatabase(mutation.database);
        return mutation.result;
    });
    mutationQueue = operation.then(
        () => undefined,
        () => undefined,
    );
    return operation;
}
