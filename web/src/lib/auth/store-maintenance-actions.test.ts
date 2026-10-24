import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthDatabase } from "./store-types";

const mocks = vi.hoisted(() => ({
    postgres: false,
    db: null as unknown as AuthDatabase,
    sessionPrune: vi.fn(),
    emailCodePrune: vi.fn(),
}));

vi.mock("@/lib/server/database", () => ({
    isPostgresDatabaseEnabled: () => mocks.postgres,
    createPostgresRepositories: () => ({
        sessions: { pruneExpired: mocks.sessionPrune },
        emailCodes: { pruneExpired: mocks.emailCodePrune },
    }),
}));
vi.mock("./store-repository", () => ({ mutateAuthDb: (mutator: (db: AuthDatabase) => unknown) => mutator(mocks.db) }));

import { DEFAULT_SETTINGS } from "./store-foundation";
import { cleanupExpiredAuthRecords } from "./store-maintenance-actions";

const now = new Date("2026-08-09T12:00:00.000Z");

describe("expired authentication record cleanup", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.postgres = false;
        mocks.db = {
            version: 1,
            nextUserAccountId: 1,
            users: [],
            sessions: [
                { id: "expired-old", userId: "user", tokenHash: "old", createdAt: "2026-08-01T00:00:00.000Z", expiresAt: "2026-08-07T00:00:00.000Z" },
                { id: "expired-new", userId: "user", tokenHash: "new", createdAt: "2026-08-02T00:00:00.000Z", expiresAt: "2026-08-08T00:00:00.000Z" },
                { id: "active", userId: "user", tokenHash: "active", createdAt: "2026-08-09T00:00:00.000Z", expiresAt: "2026-08-10T00:00:00.000Z" },
            ],
            quotaUsage: [],
            pointRecords: [],
            pricingReservations: [],
            pricingAccruals: [],
            pricingRefunds: [],
            dailyPlanPointWallets: [],
            emailCodes: [
                { id: "consumed", purpose: "register", email: "one@example.com", codeHash: "one", createdAt: "2026-08-01T00:00:00.000Z", expiresAt: "2026-08-10T00:00:00.000Z", consumedAt: "2026-08-06T00:00:00.000Z" },
                { id: "expired", purpose: "register", email: "two@example.com", codeHash: "two", createdAt: "2026-08-01T00:00:00.000Z", expiresAt: "2026-08-08T00:00:00.000Z" },
                { id: "active", purpose: "register", email: "three@example.com", codeHash: "three", createdAt: "2026-08-09T00:00:00.000Z", expiresAt: "2026-08-10T00:00:00.000Z" },
            ],
            cdkCodes: [],
            announcements: [],
            settings: DEFAULT_SETTINGS,
        };
    });

    it("removes only the oldest configured file-provider batch", async () => {
        await expect(cleanupExpiredAuthRecords({ cleanupSessions: true, cleanupEmailCodes: true, limit: 1, now })).resolves.toEqual({ sessions: 1, emailCodes: 1 });
        expect(mocks.db.sessions.map((item) => item.id)).toEqual(["expired-new", "active"]);
        expect(mocks.db.emailCodes.map((item) => item.id)).toEqual(["expired", "active"]);
    });

    it("delegates bounded PostgreSQL cleanup to entity repositories", async () => {
        mocks.postgres = true;
        mocks.sessionPrune.mockResolvedValue(4);
        mocks.emailCodePrune.mockResolvedValue(5);

        await expect(cleanupExpiredAuthRecords({ cleanupSessions: true, cleanupEmailCodes: true, limit: 20, now })).resolves.toEqual({ sessions: 4, emailCodes: 5 });
        expect(mocks.sessionPrune).toHaveBeenCalledWith(now, 20);
        expect(mocks.emailCodePrune).toHaveBeenCalledWith(now, 20);
    });
});
