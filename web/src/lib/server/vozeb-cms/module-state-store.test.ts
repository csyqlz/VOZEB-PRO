import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    provider: "file" as "file" | "postgres",
    read: vi.fn(),
    write: vi.fn(),
    lock: vi.fn(),
    ensure: vi.fn(),
    query: vi.fn(),
}));

vi.mock("@/lib/server/data-adapter", () => ({
    readJsonDataFile: mocks.read,
    writeJsonDataFile: mocks.write,
    withJsonDataFileLock: mocks.lock,
}));
vi.mock("@/lib/server/database", () => ({
    getDatabaseProvider: () => mocks.provider,
    ensurePostgresSchema: mocks.ensure,
    postgresQuery: mocks.query,
}));

import { VozebCmsModuleStateError, listVozebCmsModuleStates, updateVozebCmsModuleState } from "@/lib/server/vozeb-cms/module-state-store";

describe("VOZEBCMS module state store", () => {
    beforeEach(() => {
        mocks.provider = "file";
        mocks.read.mockReset().mockResolvedValue({ version: 1, states: [] });
        mocks.write.mockReset().mockResolvedValue(undefined);
        mocks.lock.mockReset().mockImplementation(async (_name, action) => action());
        mocks.ensure.mockReset().mockResolvedValue(undefined);
        mocks.query.mockReset();
    });

    it("persists one file-provider state with revision and mutation identity", async () => {
        const saved = await updateVozebCmsModuleState({ moduleId: "video", enabled: false, baseRevision: 0, mutationId: "mutation-one", updatedBy: "admin-one" });

        expect(saved).toMatchObject({ moduleId: "video", enabled: false, revision: 1, lastMutationId: "mutation-one", updatedBy: "admin-one" });
        expect(mocks.write).toHaveBeenCalledWith("vozeb-cms-module-states.json", expect.objectContaining({ states: [expect.objectContaining({ moduleId: "video", enabled: false })] }));
    });

    it("rejects a stale file-provider revision", async () => {
        mocks.read.mockResolvedValue({ version: 1, states: [{ moduleId: "canvas", enabled: true, revision: 2 }] });

        await expect(updateVozebCmsModuleState({ moduleId: "canvas", enabled: false, baseRevision: 1, mutationId: "mutation-two", updatedBy: "admin-one" })).rejects.toBeInstanceOf(VozebCmsModuleStateError);
        expect(mocks.write).not.toHaveBeenCalled();
    });

    it("uses bounded PostgreSQL reads and an atomic revision upsert", async () => {
        mocks.provider = "postgres";
        mocks.query.mockImplementation(async (sql: string) => {
            if (sql.includes("WHERE module_id = $1")) return { rows: [] };
            return { rows: [{ module_id: "drama", enabled: false, revision: 1, last_mutation_id: "mutation-three", updated_by: "admin-one", updated_at: new Date("2026-08-26T00:00:00.000Z") }] };
        });

        const saved = await updateVozebCmsModuleState({ moduleId: "drama", enabled: false, baseRevision: 0, mutationId: "mutation-three", updatedBy: "admin-one" });

        expect(saved).toMatchObject({ moduleId: "drama", enabled: false, revision: 1 });
        expect(mocks.ensure).toHaveBeenCalled();
        expect(String(mocks.query.mock.calls[1]?.[0])).toContain("ON CONFLICT (module_id) DO UPDATE");
        expect(String(mocks.query.mock.calls[1]?.[0])).toContain("vozeb_module_states.revision = $3");
    });

    it("lists only normalized PostgreSQL module states", async () => {
        mocks.provider = "postgres";
        mocks.query.mockResolvedValue({
            rows: [
                { module_id: "image", enabled: false, revision: 4, updated_at: "2026-08-26T00:00:00.000Z" },
                { module_id: "unknown", enabled: true, revision: 1 },
            ],
        });

        expect(await listVozebCmsModuleStates()).toEqual([{ moduleId: "image", enabled: false, revision: 4, updatedAt: "2026-08-26T00:00:00.000Z", lastMutationId: undefined, updatedBy: undefined }]);
    });
});
