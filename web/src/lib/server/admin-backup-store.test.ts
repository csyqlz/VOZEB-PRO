import { beforeEach, describe, expect, it, vi } from "vitest";

import { emptyDb } from "@/lib/auth/store-normalizers";
import type { StoredUser } from "@/lib/auth/store-types";

import type { AdminBackupData } from "./admin-backup-store";

const mocks = vi.hoisted(() => ({
    provider: "postgres" as "postgres" | "file",
    client: {
        query: vi.fn(async (...args: [string, unknown[]?]) => {
            void args;
            return { rows: [] };
        }),
    },
    readAuthDb: vi.fn(),
    readPostgresAuthDb: vi.fn(),
    writeAuthDb: vi.fn(),
    readPromptBackup: vi.fn(),
    readPostgresPromptDb: vi.fn(),
    writePromptBackup: vi.fn(),
    upsertPostgresPromptDbWithExecutor: vi.fn(),
    readGenerationLogDb: vi.fn(),
    readPostgresGenerationLogDb: vi.fn(),
    writeGenerationLogDb: vi.fn(),
    upsertPostgresGenerationLogDbWithExecutor: vi.fn(),
    restorePostgresAuthSnapshot: vi.fn(),
    readAccountDeletionRequestBackup: vi.fn(),
    writeAccountDeletionRequestBackup: vi.fn(),
    upsertAccountDeletionRequestBackup: vi.fn(),
}));

vi.mock("@/lib/auth/store-repository", () => ({
    readAuthDb: mocks.readAuthDb,
    readPostgresAuthDb: mocks.readPostgresAuthDb,
    writeAuthDb: mocks.writeAuthDb,
}));
vi.mock("@/lib/server/admin-backup-auth-restore", () => ({ restorePostgresAuthSnapshot: mocks.restorePostgresAuthSnapshot }));
vi.mock("@/lib/prompts/store", () => ({
    readPromptBackup: mocks.readPromptBackup,
    readPostgresPromptDb: mocks.readPostgresPromptDb,
    writePromptBackup: mocks.writePromptBackup,
    upsertPostgresPromptDbWithExecutor: mocks.upsertPostgresPromptDbWithExecutor,
}));
vi.mock("@/lib/server/generation-log-repository", () => ({
    readGenerationLogDb: mocks.readGenerationLogDb,
    readPostgresGenerationLogDb: mocks.readPostgresGenerationLogDb,
    writeGenerationLogDb: mocks.writeGenerationLogDb,
    upsertPostgresGenerationLogDbWithExecutor: mocks.upsertPostgresGenerationLogDbWithExecutor,
}));
vi.mock("@/lib/server/database", () => ({
    ensurePostgresSchema: vi.fn(async () => undefined),
    getDatabaseProvider: vi.fn(() => mocks.provider),
    withPostgresTransaction: vi.fn(async (callback: (client: typeof mocks.client) => unknown) => callback(mocks.client)),
}));
vi.mock("@/lib/server/database/account-deletion-request-repository", () => ({
    readAccountDeletionRequestBackup: mocks.readAccountDeletionRequestBackup,
    writeAccountDeletionRequestBackup: mocks.writeAccountDeletionRequestBackup,
    upsertAccountDeletionRequestBackup: mocks.upsertAccountDeletionRequestBackup,
}));

import { readAdminBackupData, restoreAdminBackupData } from "./admin-backup-store";

describe("admin backup store", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.provider = "postgres";
        setReadSnapshot(emptyBackup());
    });

    it("reads every PostgreSQL backup section through the same transaction client", async () => {
        await readAdminBackupData();

        expect(mocks.readPostgresAuthDb).toHaveBeenCalledWith(mocks.client);
        expect(mocks.readPostgresPromptDb).toHaveBeenCalledWith(mocks.client);
        expect(mocks.readPostgresGenerationLogDb).toHaveBeenCalledWith(mocks.client);
        expect(mocks.readAccountDeletionRequestBackup).toHaveBeenCalledWith(mocks.client);
    });

    it("locks and upserts a merged PostgreSQL snapshot without dropping backup-missing users", async () => {
        const current = emptyBackup();
        current.auth.users = [storedUser("user-a", 10), storedUser("user-b", 20)];
        current.prompts.prompts = [storedPrompt("prompt-b")];
        setReadSnapshot(current);
        const imported = emptyBackup();
        imported.auth.users = [storedUser("user-a", 99)];
        imported.prompts.prompts = [storedPrompt("prompt-a")];

        await restoreAdminBackupData(imported);

        expect(String(mocks.client.query.mock.calls[0]?.[0])).toContain("LOCK TABLE");
        expect(mocks.restorePostgresAuthSnapshot).toHaveBeenCalledWith(mocks.client, expect.objectContaining({ users: [expect.objectContaining({ id: "user-a", pointsBalance: 99 }), expect.objectContaining({ id: "user-b", pointsBalance: 20 })] }));
        expect(mocks.upsertPostgresPromptDbWithExecutor).toHaveBeenCalledWith(expect.objectContaining({ prompts: [expect.objectContaining({ id: "prompt-b" }), expect.objectContaining({ id: "prompt-a" })] }), mocks.client);
    });

    it.each(["postgres", "file"] as const)("preserves the latest auth snapshot for non-auth %s imports", async (provider) => {
        mocks.provider = provider;
        const current = emptyBackup();
        current.auth.users = [{ ...storedUser("user-a", 10), role: "user", adminPermissions: [] }];
        setReadSnapshot(current);
        const imported = emptyBackup();
        imported.auth.users = [storedUser("user-a", 10)];
        imported.prompts.prompts = [storedPrompt("prompt-a")];

        await restoreAdminBackupData(imported, { mode: "account-config", preserveCurrentAuth: true });

        expect(mocks.restorePostgresAuthSnapshot).not.toHaveBeenCalled();
        expect(mocks.writeAuthDb).not.toHaveBeenCalled();
        if (provider === "postgres") {
            expect(mocks.upsertPostgresPromptDbWithExecutor).toHaveBeenCalledWith(expect.objectContaining({ prompts: [expect.objectContaining({ id: "prompt-a" })] }), mocks.client);
        } else {
            expect(mocks.writePromptBackup).toHaveBeenCalledWith(expect.objectContaining({ prompts: [expect.objectContaining({ id: "prompt-a" })] }));
        }
    });

    it("stops the PostgreSQL transaction when one section fails", async () => {
        const data = emptyBackup();
        mocks.upsertPostgresPromptDbWithExecutor.mockRejectedValueOnce(new Error("prompt restore failed"));

        await expect(restoreAdminBackupData(data)).rejects.toThrow("prompt restore failed");

        expect(mocks.restorePostgresAuthSnapshot).toHaveBeenCalledWith(mocks.client, expect.any(Object));
        expect(mocks.upsertPostgresPromptDbWithExecutor).toHaveBeenCalledWith(expect.any(Object), mocks.client);
        expect(mocks.upsertPostgresGenerationLogDbWithExecutor).not.toHaveBeenCalled();
    });

    it("restores every original file snapshot when a file Provider write fails", async () => {
        mocks.provider = "file";
        const current = emptyBackup();
        current.auth.users = [storedUser("user-b", 20)];
        setReadSnapshot(current);
        const imported = emptyBackup();
        imported.auth.users = [storedUser("user-a", 10)];
        mocks.writePromptBackup.mockRejectedValueOnce(new Error("disk full"));

        await expect(restoreAdminBackupData(imported)).rejects.toThrow("disk full");

        expect(mocks.writeAuthDb).toHaveBeenCalledTimes(2);
        expect(mocks.writePromptBackup).toHaveBeenCalledTimes(2);
        expect(mocks.writeGenerationLogDb).toHaveBeenCalledTimes(1);
        expect(mocks.writeAccountDeletionRequestBackup).toHaveBeenCalledTimes(1);
        expect(mocks.writeAuthDb.mock.calls[1]?.[0]).toEqual(current.auth);
        expect(mocks.writeGenerationLogDb).toHaveBeenCalledWith(current.generationLogs);
    });

    it("rejects a disaster restore when the package lacks a complete database and media manifest", async () => {
        await expect(restoreAdminBackupData(emptyBackup(), { mode: "disaster" })).rejects.toThrow("不能用于整库灾难恢复");
        expect(mocks.client.query).not.toHaveBeenCalled();
        expect(mocks.writeAuthDb).not.toHaveBeenCalled();
    });
});

function setReadSnapshot(data: AdminBackupData) {
    mocks.readAuthDb.mockResolvedValue(data.auth);
    mocks.readPostgresAuthDb.mockResolvedValue(data.auth);
    mocks.readPromptBackup.mockResolvedValue(data.prompts);
    mocks.readPostgresPromptDb.mockResolvedValue(data.prompts);
    mocks.readGenerationLogDb.mockResolvedValue(data.generationLogs);
    mocks.readPostgresGenerationLogDb.mockResolvedValue(data.generationLogs);
    mocks.readAccountDeletionRequestBackup.mockResolvedValue(data.accountDeletionRequests);
}

function emptyBackup(): AdminBackupData {
    return {
        auth: emptyDb(),
        prompts: { version: 1, prompts: [], seedSources: [] },
        generationLogs: { version: 1, logs: [] },
        accountDeletionRequests: { version: 1, requests: [] },
    };
}

function storedUser(id: string, pointsBalance: number): StoredUser {
    return {
        id,
        accountId: id === "user-a" ? "1" : "2",
        username: id,
        email: `${id}@example.com`,
        displayName: id,
        bio: "",
        role: id === "user-a" ? ("admin" as const) : ("user" as const),
        adminPermissions: id === "user-a" ? ["system.manage"] : [],
        status: "active" as const,
        planId: "free",
        pointsBalance,
        passwordHash: `${id}-hash`,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
    };
}

function storedPrompt(id: string) {
    return {
        id,
        scope: "library" as const,
        title: id,
        coverUrl: "",
        prompt: id,
        tags: [],
        category: "",
        preview: "",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
    };
}
