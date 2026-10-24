import { beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_ADMIN_PERMISSIONS } from "@/lib/admin-permissions";

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    mergeAuthBackupSecrets: vi.fn((value) => value),
    readAdminBackupData: vi.fn(),
    restoreAdminBackupData: vi.fn(),
    listDataDirectory: vi.fn(async () => []),
    audit: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/auth/store-normalizers", () => ({ encryptAuthDbSecretsForStorage: vi.fn((value) => value) }));
vi.mock("@/lib/server/admin-backup-policy", () => ({ mergeAuthBackupSecrets: mocks.mergeAuthBackupSecrets, sanitizeAuthBackup: vi.fn() }));
vi.mock("@/lib/server/admin-backup-store", () => ({ readAdminBackupData: mocks.readAdminBackupData, restoreAdminBackupData: mocks.restoreAdminBackupData }));
vi.mock("@/lib/server/audit-log-store", () => ({ auditActorFromRequest: vi.fn(() => ({ id: "admin-one" })), safeRecordAuditLog: mocks.audit }));
vi.mock("@/lib/server/database", () => ({ getDatabaseProvider: vi.fn(() => "file") }));
vi.mock("@/lib/server/data-adapter", () => ({
    copyDataFile: vi.fn(),
    ensureDataDirectory: vi.fn(),
    listDataDirectory: mocks.listDataDirectory,
    removeDataPath: vi.fn(),
    resolveDataPath: vi.fn(() => "C:/safe/restore-backups/current"),
    writeJsonDataFile: vi.fn(),
}));

import { POST } from "./route";

describe("POST /api/admin/backup", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCurrentUser.mockResolvedValue({ id: "admin-one", role: "admin", status: "active", adminPermissions: ["system.manage"] });
        mocks.listDataDirectory.mockResolvedValue([]);
        mocks.readAdminBackupData.mockResolvedValue({
            auth: { users: [{ id: "admin-one" }], settings: {} },
            prompts: { version: 1, prompts: [], seedSources: [] },
            generationLogs: { version: 1, logs: [] },
            accountDeletionRequests: { version: 1, requests: [] },
        });
    });

    it("rejects an oversized multipart backup before parsing it", async () => {
        const response = await POST(
            new Request("http://localhost/api/admin/backup", {
                method: "POST",
                headers: { "content-type": "multipart/form-data; boundary=test", "content-length": String(30 * 1024 * 1024 + 64 * 1024 + 1) },
                body: "--test--",
            }),
        );

        expect(response.status).toBe(413);
        expect((await response.json()).error).toBe("备份文件过大，请确认文件是否正确");
    });

    it("rejects a business JSON package marked as disaster restore", async () => {
        const response = await POST(backupRequest({ backupType: "disaster", files: { prompts: { version: 1, prompts: [], seedSources: [] } } }));

        expect(response.status).toBe(400);
        expect((await response.json()).error).toContain("不能用于整库灾难恢复");
        expect(mocks.restoreAdminBackupData).not.toHaveBeenCalled();
    });

    it.each([{ files: { auth: { users: [{ id: "admin-one", role: "admin", adminPermissions: ["administrators.manage"] }], settings: {} } } }, { auth: { users: [], settings: {} }, prompts: { version: 1, prompts: [], seedSources: [] } }])(
        "rejects an auth import without full administrator permissions before reading or writing",
        async (backup) => {
            const response = await POST(backupRequest(backup));

            expect(response.status).toBe(403);
            expect(mocks.readAdminBackupData).not.toHaveBeenCalled();
            expect(mocks.mergeAuthBackupSecrets).not.toHaveBeenCalled();
            expect(mocks.restoreAdminBackupData).not.toHaveBeenCalled();
        },
    );

    it("rejects an auth import when the administrator has governance permission but lacks other duties", async () => {
        mocks.getCurrentUser.mockResolvedValue({ id: "admin-one", role: "admin", status: "active", adminPermissions: ["system.manage", "administrators.manage"] });
        const response = await POST(backupRequest({ auth: { users: [], settings: {} } }));

        expect(response.status).toBe(403);
        expect(mocks.readAdminBackupData).not.toHaveBeenCalled();
        expect(mocks.restoreAdminBackupData).not.toHaveBeenCalled();
    });

    it("keeps non-auth backup imports available to system administrators", async () => {
        const response = await POST(backupRequest({ files: { prompts: { version: 1, prompts: [], seedSources: [] } } }));

        expect(response.status).toBe(200);
        expect(mocks.restoreAdminBackupData).toHaveBeenCalledWith(expect.any(Object), { mode: "account-config", preserveCurrentAuth: true });
        expect((await response.json()).imported).toEqual(["prompts"]);
    });

    it("allows an auth import for a full administrator", async () => {
        mocks.getCurrentUser.mockResolvedValue({ id: "admin-one", role: "admin", status: "active", adminPermissions: ALL_ADMIN_PERMISSIONS });
        const auth = { users: [{ id: "member", role: "user", status: "active" }], settings: {} };
        const response = await POST(backupRequest({ backupType: "account-config", files: { auth } }));

        expect(response.status).toBe(200);
        expect(mocks.mergeAuthBackupSecrets).toHaveBeenCalledWith(auth, expect.any(Object));
        expect(mocks.restoreAdminBackupData).toHaveBeenCalledWith(expect.any(Object), { mode: "account-config", preserveCurrentAuth: false });
        expect(mocks.audit).toHaveBeenCalledWith(
            expect.objectContaining({
                action: "admin.backup.restore",
                metadata: { mode: "account-config", imported: ["auth"] },
            }),
        );
    });
});

function backupRequest(value: unknown) {
    const formData = new FormData();
    formData.set("file", new File([JSON.stringify(value)], "backup.json", { type: "application/json" }));
    return new Request("http://localhost/api/admin/backup", { method: "POST", body: formData });
}
