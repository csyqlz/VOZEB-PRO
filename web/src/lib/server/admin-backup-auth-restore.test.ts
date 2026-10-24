import { beforeEach, describe, expect, it, vi } from "vitest";

import { emptyDb } from "@/lib/auth/store-normalizers";
import type { QueryExecutor } from "@/lib/server/database";

const mocks = vi.hoisted(() => ({
    upsertPostgresEntitlementPlans: vi.fn(),
    upsertPostgresSettings: vi.fn(),
    upsertPostgresSystemChannels: vi.fn(),
    insertPostgresUsers: vi.fn(),
    insertPostgresSessions: vi.fn(),
    insertPostgresEmailCodes: vi.fn(),
    insertPostgresQuotaUsage: vi.fn(),
    insertPostgresPointRecords: vi.fn(),
    insertPostgresDailyPlanPointWallets: vi.fn(),
    insertPostgresCdkCodes: vi.fn(),
    insertPostgresAnnouncements: vi.fn(),
}));

vi.mock("@/lib/auth/store-repository", () => mocks);

import { restorePostgresAuthSnapshot } from "./admin-backup-auth-restore";

describe("PostgreSQL account-config auth restore", () => {
    beforeEach(() => vi.clearAllMocks());

    it("rejects a partial restore of a priced wallet before mutating users or balances", async () => {
        const db = emptyDb();
        db.pricingAccruals.push({ userId: "user-a", sourceKey: "permanent", exactPoints: "1/250" });
        const client = { query: vi.fn() } as unknown as QueryExecutor;
        await expect(restorePostgresAuthSnapshot(client, db)).rejects.toThrow("完整数据库");
        expect(mocks.insertPostgresUsers).not.toHaveBeenCalled();
    });

    it("uses upserts and never deletes users or backup-missing auth entities", async () => {
        const query = vi.fn(async (...args: [string]) => {
            void args;
            return { rows: [] };
        });
        const client = { query } as unknown as QueryExecutor;
        const db = emptyDb();
        db.users.push({
            id: "user-a",
            accountId: "1",
            username: "admin",
            email: "admin@example.com",
            displayName: "管理员",
            bio: "",
            role: "admin",
            adminPermissions: ["system.manage"],
            status: "active",
            planId: "free",
            pointsBalance: 10,
            passwordHash: "hash",
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
        });

        await restorePostgresAuthSnapshot(client, db);

        expect(mocks.insertPostgresUsers).toHaveBeenCalledWith(client, [expect.objectContaining({ id: "user-a", accountId: "0001" })]);
        expect(query.mock.calls.map(([sql]) => sql.toUpperCase()).some((sql) => sql.includes("DELETE FROM"))).toBe(false);
    });
});
