import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const memory = vi.hoisted(() => ({ value: undefined as unknown }));

vi.mock("@/lib/server/database", () => ({
    ensurePostgresSchema: vi.fn(),
    isPostgresDatabaseEnabled: vi.fn(() => false),
    postgresQuery: vi.fn(),
    withPostgresTransaction: vi.fn(),
}));

vi.mock("@/lib/server/data-adapter", () => ({
    withJsonDataFileLock: async (_file: string, action: () => Promise<unknown>) => action(),
    readJsonDataFile: vi.fn(async (_fileName: string, fallback: unknown) => memory.value ?? fallback),
    writeJsonDataFile: vi.fn(async (_fileName: string, value: unknown) => {
        memory.value = structuredClone(value);
    }),
}));

import { createFirstAdmin, createUserByAdmin, deleteUserByAdmin, updateUserByAdmin } from "./store";
import { readAuthDb, mutateAuthDb } from "./store-repository";

const INSTALL_TOKEN = "install-token-".padEnd(48, "x");

describe("administrator user-management duties", () => {
    beforeEach(() => {
        memory.value = undefined;
        vi.stubEnv("VOZEB_PRO_INSTALL_TOKEN", INSTALL_TOKEN);
    });

    afterEach(() => vi.unstubAllEnvs());

    it("removes only the deleted user's exact pricing account", async () => {
        const owner = await createFirstAdmin({ username: "owner", password: "password123", installToken: INSTALL_TOKEN });
        const member = await createUserByAdmin({ actorId: owner.id, username: "member", password: "password123", role: "user" });
        await mutateAuthDb((db) => {
            db.pricingAccruals = [
                { userId: owner.id, sourceKey: "permanent", exactPoints: "1/250" },
                { userId: member.id, sourceKey: "permanent", exactPoints: "2/125" },
            ];
        });
        await deleteUserByAdmin(owner.id, member.id);
        expect((await readAuthDb()).pricingAccruals).toEqual([{ userId: owner.id, sourceKey: "permanent", exactPoints: "1/250" }]);
    });

    it("prevents a limited administrator from managing a broader administrator", async () => {
        const owner = await createFirstAdmin({ username: "owner", password: "password123", installToken: INSTALL_TOKEN });
        const limited = await createUserByAdmin({ actorId: owner.id, username: "limited", password: "password123", role: "admin", adminPermissions: ["administrators.manage"] });
        const systemAdmin = await createUserByAdmin({ actorId: owner.id, username: "system-admin", password: "password123", role: "admin", adminPermissions: ["administrators.manage", "system.manage"] });

        await expect(updateUserByAdmin(limited.id, systemAdmin.id, { displayName: "越权修改" })).rejects.toMatchObject({ status: 403 });
        await expect(deleteUserByAdmin(limited.id, systemAdmin.id)).rejects.toMatchObject({ status: 403 });
    });

    it("allows delegation only within the current administrator permission set", async () => {
        const owner = await createFirstAdmin({ username: "owner", password: "password123", installToken: INSTALL_TOKEN });
        const limited = await createUserByAdmin({ actorId: owner.id, username: "limited", password: "password123", role: "admin", adminPermissions: ["administrators.manage"] });

        await expect(createUserByAdmin({ actorId: limited.id, username: "too-powerful", password: "password123", role: "admin", adminPermissions: ["administrators.manage", "system.manage"] })).rejects.toMatchObject({ status: 403 });
        await expect(createUserByAdmin({ actorId: limited.id, username: "peer", password: "password123", role: "admin", adminPermissions: ["administrators.manage"] })).resolves.toMatchObject({ adminPermissions: ["administrators.manage"] });
    });
});
