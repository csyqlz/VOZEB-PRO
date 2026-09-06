import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    ensurePostgresSchema: vi.fn(),
    getDatabaseProvider: vi.fn(),
    postgresQuery: vi.fn(),
    readJsonDataFile: vi.fn(),
    writeJsonDataFile: vi.fn(),
}));

vi.mock("@/lib/server/database", () => ({
    ensurePostgresSchema: mocks.ensurePostgresSchema,
    getDatabaseProvider: mocks.getDatabaseProvider,
    postgresQuery: mocks.postgresQuery,
}));
vi.mock("@/lib/server/data-adapter", () => ({ readJsonDataFile: mocks.readJsonDataFile, writeJsonDataFile: mocks.writeJsonDataFile }));

import {
    getLocalMediaRegistrationSummary,
    listExpiredLocalMediaRegistrations,
    listFileLocalMediaRegistrations,
    listLocalMediaMigrationRegistrations,
    listLocalMediaRegistrationPage,
    listLocalMediaRegistrationsForDeletion,
    listLocalMediaRegistrationsForUser,
    listLocalMediaRegistrationsForUserPage,
    promoteLocalMediaRegistration,
} from "./local-media-registry";

describe("listLocalMediaRegistrationsForUser", () => {
    beforeEach(() => vi.clearAllMocks());

    it("prevents the unbounded user reader from querying PostgreSQL", async () => {
        mocks.getDatabaseProvider.mockReturnValue("postgres");

        await expect(listLocalMediaRegistrationsForUser("user-one")).rejects.toThrow("paginated registration query");

        expect(mocks.ensurePostgresSchema).not.toHaveBeenCalled();
        expect(mocks.postgresQuery).not.toHaveBeenCalled();
    });

    it("filters the file provider before returning registrations", async () => {
        mocks.getDatabaseProvider.mockReturnValue("file");
        mocks.readJsonDataFile.mockResolvedValue({
            version: 1,
            assets: [
                { storageKey: "one.png", ownerUserId: "user-one", createdAt: "2026-01-02T00:00:00.000Z" },
                { storageKey: "two.png", ownerUserId: "user-two", createdAt: "2026-01-03T00:00:00.000Z" },
            ],
        });

        const registrations = await listLocalMediaRegistrationsForUser("user-one");

        expect(registrations).toEqual([expect.objectContaining({ storageKey: "one.png", ownerUserId: "user-one" })]);
    });

    it("paginates all PostgreSQL media providers for one user with stable ordering", async () => {
        mocks.getDatabaseProvider.mockReturnValue("postgres");
        mocks.postgresQuery.mockResolvedValue({
            rows: [
                {
                    storage_key: "permanent/image.png",
                    scope: "reference",
                    storage_class: "permanent",
                    type: "image",
                    owner_user_id: "user-one",
                    source: "agent",
                    mime_type: "image/png",
                    bytes: 12,
                    storage_provider: "object",
                    created_at: new Date("2026-01-02"),
                    total_count: 31,
                },
            ],
        });

        await expect(listLocalMediaRegistrationsForUserPage("user-one", { page: 2, pageSize: 20 })).resolves.toMatchObject({ items: [{ storageKey: "permanent/image.png", storageProvider: "object" }], total: 31, page: 2, pageSize: 20 });

        const [statement, params] = mocks.postgresQuery.mock.calls[0] as [string, unknown[]];
        expect(statement).toContain("WHERE owner_user_id = $1");
        expect(statement).toContain("ORDER BY created_at DESC, storage_key ASC");
        expect(statement).toContain("LIMIT $2 OFFSET $3");
        expect(statement).not.toContain("storage_provider = 'local'");
        expect(params).toEqual(["user-one", 20, 20]);
    });

    it("collects user media snapshots through bounded transaction pages", async () => {
        mocks.getDatabaseProvider.mockReturnValue("postgres");
        const query = vi
            .fn()
            .mockResolvedValueOnce({ rows: [{ storage_key: "one.png", scope: "reference", storage_class: "permanent", type: "image", owner_user_id: "user-one", source: "agent", mime_type: "image/png", bytes: 10, created_at: new Date("2026-01-02") }] })
            .mockResolvedValueOnce({ rows: [] });

        const registrations = await listLocalMediaRegistrationsForDeletion(" user-one ", { batchSize: 1, executor: { query } as never, forUpdate: true });

        expect(registrations).toMatchObject([{ storageKey: "one.png", ownerUserId: "user-one" }]);
        expect(query).toHaveBeenCalledTimes(2);
        expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining("LIMIT $2::integer OFFSET $3"), ["user-one", 1, 0]);
        expect(String(query.mock.calls[0]?.[0])).toContain("ORDER BY created_at DESC, storage_key ASC");
        expect(String(query.mock.calls[0]?.[0])).toContain("FOR UPDATE");
        expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining("LIMIT $2::integer OFFSET $3"), ["user-one", 1, 1]);
    });

    it("paginates local PostgreSQL media and calculates totals without loading all registrations", async () => {
        mocks.getDatabaseProvider.mockReturnValue("postgres");
        mocks.postgresQuery
            .mockResolvedValueOnce({
                rows: [{ storage_key: "permanent/image.png", scope: "reference", storage_class: "permanent", type: "image", owner_user_id: "user-one", source: "agent", mime_type: "image/png", bytes: 12, created_at: new Date("2026-01-02") }],
            })
            .mockResolvedValueOnce({ rows: [{ total: "42" }] })
            .mockResolvedValueOnce({ rows: [{ total_files: "42", total_bytes: "512", temporary_files: "2", temporary_bytes: "12", permanent_files: "40", permanent_bytes: "500", expired_temporary_files: "1" }] });

        const page = await listLocalMediaRegistrationPage({ page: 2, pageSize: 10, type: "image", source: "agent", search: "0001", ownerUserIds: ["user-one"] });

        expect(mocks.postgresQuery).toHaveBeenCalledWith(expect.stringContaining("LIMIT $6 OFFSET $7"), [null, "image", "agent", "0001", ["user-one"], 10, 10]);
        expect(mocks.postgresQuery).toHaveBeenCalledWith(expect.stringContaining("owner_user_id = ANY($5::text[])"), [null, "image", "agent", "0001", ["user-one"]]);
        expect(page).toMatchObject({ total: 42, items: [{ storageKey: "permanent/image.png" }], summary: { totalFiles: 42, expiredTemporaryFiles: 1 } });
    });

    it("loads only the PostgreSQL media summary for the dashboard", async () => {
        mocks.getDatabaseProvider.mockReturnValue("postgres");
        mocks.postgresQuery.mockResolvedValue({ rows: [{ total_files: "42", total_bytes: "512", temporary_files: "2", temporary_bytes: "12", permanent_files: "40", permanent_bytes: "500", expired_temporary_files: "1" }] });

        const summary = await getLocalMediaRegistrationSummary();

        expect(summary).toMatchObject({ totalFiles: 42, totalBytes: 512, permanentFiles: 40, expiredTemporaryFiles: 1 });
        expect(mocks.postgresQuery).toHaveBeenCalledTimes(1);
        expect(String(mocks.postgresQuery.mock.calls[0][0])).toContain("FROM local_media_assets");
        expect(String(mocks.postgresQuery.mock.calls[0][0])).not.toContain("ORDER BY");
    });

    it("loads expired media with a bounded PostgreSQL maintenance query", async () => {
        mocks.getDatabaseProvider.mockReturnValue("postgres");
        mocks.postgresQuery.mockResolvedValue({ rows: [] });

        await listExpiredLocalMediaRegistrations(80);

        expect(mocks.postgresQuery).toHaveBeenCalledWith(expect.stringContaining("storage_class = 'temporary'"), [80]);
        expect(String(mocks.postgresQuery.mock.calls[0][0])).toContain("expires_at <= now()");
        expect(String(mocks.postgresQuery.mock.calls[0][0])).toContain("LIMIT $1");
    });

    it("loads local migration candidates by page and counts only local registrations", async () => {
        mocks.getDatabaseProvider.mockReturnValue("postgres");
        mocks.postgresQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ total: "240" }] });

        const result = await listLocalMediaMigrationRegistrations({ limit: 40, offset: 80 });

        expect(result).toEqual({ items: [], total: 240 });
        expect(mocks.postgresQuery).toHaveBeenCalledWith(expect.stringContaining("storage_provider = 'local'"), [40, 80]);
        expect(String(mocks.postgresQuery.mock.calls[0][0])).toContain("LIMIT $1 OFFSET $2");
        expect(String(mocks.postgresQuery.mock.calls[1][0])).toContain("count(*) AS total");
    });

    it("prevents the file-provider full reader from querying PostgreSQL", async () => {
        mocks.getDatabaseProvider.mockReturnValue("postgres");

        await expect(listFileLocalMediaRegistrations()).rejects.toThrow("PostgreSQL media reads must use a scoped repository query");
        expect(mocks.postgresQuery).not.toHaveBeenCalled();
    });
});

describe("promoteLocalMediaRegistration", () => {
    beforeEach(() => vi.clearAllMocks());

    it("promotes only the owning temporary file in the file provider", async () => {
        mocks.getDatabaseProvider.mockReturnValue("file");
        mocks.readJsonDataFile.mockResolvedValue({
            version: 1,
            assets: [
                { storageKey: "temporary/one.png", ownerUserId: "user-one", storageClass: "temporary", expiresAt: "2026-01-01T00:00:00.000Z" },
                { storageKey: "temporary/two.png", ownerUserId: "user-two", storageClass: "temporary" },
            ],
        });
        mocks.writeJsonDataFile.mockResolvedValue(undefined);

        await expect(promoteLocalMediaRegistration("temporary/one.png", "user-one")).resolves.toBe(true);
        const written = mocks.writeJsonDataFile.mock.calls[0]?.[1] as { assets: Array<Record<string, unknown>> };
        expect(written.assets[0]).toMatchObject({ storageKey: "temporary/one.png", storageClass: "permanent" });
        expect(written.assets[0]?.expiresAt).toBeUndefined();
        expect(written.assets[1]).toMatchObject({ storageClass: "temporary" });
    });

    it("updates PostgreSQL ownership and clears expiry", async () => {
        mocks.getDatabaseProvider.mockReturnValue("postgres");
        mocks.postgresQuery.mockResolvedValue({ rows: [{ storage_key: "temporary/one.png" }] });

        await expect(promoteLocalMediaRegistration("temporary/one.png", "user-one")).resolves.toBe(true);
        expect(mocks.postgresQuery).toHaveBeenCalledWith(expect.stringContaining("storage_class = 'permanent'"), ["temporary/one.png", "user-one"]);
        expect(String(mocks.postgresQuery.mock.calls[0]?.[0])).toContain("expires_at = NULL");
    });
});
