import { readJsonDataFile, withJsonDataFileLock, writeJsonDataFile } from "@/lib/server/data-adapter";
import { ensurePostgresSchema, getDatabaseProvider, postgresQuery } from "@/lib/server/database";
import { normalizeVozebCmsModuleState, type VozebCmsModuleState, type VozebCmsModuleStateMutation } from "@/lib/vozeb-cms/module-contract";

type ModuleStateDatabase = { version: 1; states: VozebCmsModuleState[] };

const FILE_NAME = "vozeb-cms-module-states.json";
let writeQueue = Promise.resolve();

export class VozebCmsModuleStateError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
    }
}

export async function listVozebCmsModuleStates() {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<Record<string, unknown>>("SELECT module_id, enabled, revision, last_mutation_id, updated_by, updated_at FROM vozeb_module_states ORDER BY module_id ASC");
        return result.rows.flatMap((row) => normalizeVozebCmsModuleState(mapRow(row)) || []);
    }
    return (await readDatabase()).states;
}

export async function getVozebCmsModuleState(moduleId: VozebCmsModuleState["moduleId"]) {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<Record<string, unknown>>("SELECT module_id, enabled, revision, last_mutation_id, updated_by, updated_at FROM vozeb_module_states WHERE module_id = $1", [moduleId]);
        return normalizeVozebCmsModuleState(mapRow(result.rows[0] || {}));
    }
    return (await readDatabase()).states.find((state) => state.moduleId === moduleId);
}

export async function updateVozebCmsModuleState(mutation: VozebCmsModuleStateMutation) {
    const existing = await getVozebCmsModuleState(mutation.moduleId);
    if (existing?.lastMutationId === mutation.mutationId) return existing;
    if ((existing?.revision || 0) !== mutation.baseRevision) throw new VozebCmsModuleStateError("模块状态已更新，请刷新后重试", 409);

    if (getDatabaseProvider() === "postgres") {
        const now = new Date().toISOString();
        const result = await postgresQuery<Record<string, unknown>>(
            `INSERT INTO vozeb_module_states (module_id, enabled, revision, last_mutation_id, updated_by, updated_at)
             SELECT $1, $2, 1, $4, $5, $6::timestamptz
             WHERE $3::integer = 0
             ON CONFLICT (module_id) DO UPDATE
             SET enabled = EXCLUDED.enabled,
                 revision = vozeb_module_states.revision + 1,
                 last_mutation_id = EXCLUDED.last_mutation_id,
                 updated_by = EXCLUDED.updated_by,
                 updated_at = EXCLUDED.updated_at
             WHERE vozeb_module_states.revision = $3
             RETURNING module_id, enabled, revision, last_mutation_id, updated_by, updated_at`,
            [mutation.moduleId, mutation.enabled, mutation.baseRevision, mutation.mutationId, mutation.updatedBy, now],
        );
        const saved = normalizeVozebCmsModuleState(mapRow(result.rows[0] || {}));
        if (saved) return saved;
        const latest = await getVozebCmsModuleState(mutation.moduleId);
        if (latest?.lastMutationId === mutation.mutationId) return latest;
        throw new VozebCmsModuleStateError("模块状态已更新，请刷新后重试", 409);
    }

    let saved: VozebCmsModuleState | undefined;
    await mutateDatabase((database) => {
        const current = database.states.find((state) => state.moduleId === mutation.moduleId);
        if (current?.lastMutationId === mutation.mutationId) {
            saved = current;
            return database;
        }
        if ((current?.revision || 0) !== mutation.baseRevision) throw new VozebCmsModuleStateError("模块状态已更新，请刷新后重试", 409);
        const next: VozebCmsModuleState = {
            moduleId: mutation.moduleId,
            enabled: mutation.enabled,
            revision: mutation.baseRevision + 1,
            lastMutationId: mutation.mutationId,
            updatedAt: new Date().toISOString(),
            updatedBy: mutation.updatedBy,
        };
        saved = next;
        return { ...database, states: [...database.states.filter((state) => state.moduleId !== mutation.moduleId), next] };
    });
    return saved!;
}

function readDatabase() {
    return readJsonDataFile<Partial<ModuleStateDatabase>>(FILE_NAME, { version: 1, states: [] }).then(normalizeDatabase);
}

function mutateDatabase(mutator: (database: ModuleStateDatabase) => ModuleStateDatabase) {
    const operation = writeQueue.then(() =>
        withJsonDataFileLock(FILE_NAME, async () => {
            const next = normalizeDatabase(mutator(await readDatabase()));
            await writeJsonDataFile(FILE_NAME, next);
        }),
    );
    writeQueue = operation.then(
        () => undefined,
        () => undefined,
    );
    return operation;
}

function normalizeDatabase(value: Partial<ModuleStateDatabase>): ModuleStateDatabase {
    const states = Array.isArray(value.states) ? value.states.flatMap((state) => normalizeVozebCmsModuleState(state) || []) : [];
    return { version: 1, states: [...new Map(states.map((state) => [state.moduleId, state])).values()] };
}

function mapRow(row: Record<string, unknown>) {
    return {
        moduleId: row.module_id,
        enabled: row.enabled,
        revision: row.revision,
        lastMutationId: row.last_mutation_id,
        updatedBy: row.updated_by,
        updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    };
}
