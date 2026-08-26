import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    ensurePostgresSchema: vi.fn(),
    query: vi.fn(),
    getLocalMediaRegistrations: vi.fn(),
    deleteRegisteredLocalMediaSnapshots: vi.fn(),
}));

const executor = { query: mocks.query };

vi.mock("@/lib/server/database", () => ({
    ensurePostgresSchema: mocks.ensurePostgresSchema,
    getDatabaseProvider: () => "postgres",
    withPostgresTransaction: (callback: (client: typeof executor) => unknown) => callback(executor),
}));
vi.mock("@/lib/server/local-media-registry", () => ({ getLocalMediaRegistrations: mocks.getLocalMediaRegistrations }));
vi.mock("@/lib/server/local-media-storage", () => ({ deleteRegisteredLocalMediaSnapshots: mocks.deleteRegisteredLocalMediaSnapshots }));

import { deleteUserMediaAssetsCascade } from "./user-media-deletion-service";

describe("user media cascade deletion PostgreSQL boundary", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getLocalMediaRegistrations.mockResolvedValue([
            {
                storageKey: "permanent/one.png",
                scope: "reference",
                storageClass: "permanent",
                type: "image",
                ownerUserId: "user-one",
                source: "user-upload",
                mimeType: "image/png",
                bytes: 4,
                storageProvider: "object",
                externalStorageId: "default",
                externalObjectKey: "vozeb-pro/media/reference/permanent/one.png",
                createdAt: "2026-08-21T00:00:00.000Z",
            },
        ]);
        mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
        mocks.deleteRegisteredLocalMediaSnapshots.mockResolvedValue({ deletedFiles: 1, deletedBytes: 4, blocked: [] });
    });

    it("queries only the requested user and storage keys", async () => {
        await expect(deleteUserMediaAssetsCascade("user-one", ["permanent/one.png"])).resolves.toMatchObject({ deletedFiles: 1, blocked: [] });

        expect(mocks.getLocalMediaRegistrations).toHaveBeenCalledWith(["permanent/one.png"], { ownerUserId: "user-one", executor, forUpdate: true });
        const searchCalls = mocks.query.mock.calls.filter(([sql]) =>
            /creative_assets|creative_messages|library_assets|canvas_projects|drama_projects|drama_project_versions|generation_log_assets|generation_logs|generation_tasks|published_work_assets|users/.test(String(sql)),
        );
        expect(searchCalls.length).toBeGreaterThanOrEqual(10);
        for (const [sql, params] of searchCalls) {
            expect(String(sql)).toMatch(/user_id|owner_user_id|conversation\.user_id|log\.user_id|work\.owner_user_id|WHERE id = \$1/);
            expect(params[0]).toBe("user-one");
        }
        expect(mocks.query.mock.calls.map(([sql]) => String(sql)).join("\n")).not.toMatch(/SELECT\s+\*\s+FROM\s+(creative_assets|library_assets|canvas_projects|drama_projects|generation_logs|generation_tasks)/i);
        expect(mocks.deleteRegisteredLocalMediaSnapshots).toHaveBeenCalledWith([expect.objectContaining({ storageKey: "permanent/one.png", externalObjectKey: "vozeb-pro/media/reference/permanent/one.png" })]);
    });

    it("does not truncate large owned media sets", async () => {
        const storageKeys = Array.from({ length: 201 }, (_, index) => `permanent/${index}.png`);
        mocks.getLocalMediaRegistrations.mockResolvedValueOnce(storageKeys.map((storageKey) => ({ storageKey, ownerUserId: "user-one" })));

        await deleteUserMediaAssetsCascade("user-one", storageKeys);

        expect(mocks.getLocalMediaRegistrations).toHaveBeenCalledWith(storageKeys, { ownerUserId: "user-one", executor, forUpdate: true });
        expect(mocks.deleteRegisteredLocalMediaSnapshots).toHaveBeenCalledWith(storageKeys.map((storageKey) => ({ storageKey, ownerUserId: "user-one" })));
    });
});
