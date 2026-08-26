import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    user: vi.fn(),
    getSettings: vi.fn(),
    saveSettings: vi.fn(),
    check: vi.fn(),
    audit: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/server/audit-log-store", () => ({ auditActorFromRequest: vi.fn(() => ({ id: "admin" })), safeRecordAuditLog: mocks.audit }));
vi.mock("@/lib/server/object-storage-config", () => ({
    getObjectStorageAdminSettings: mocks.getSettings,
    saveObjectStorageAdminSettings: mocks.saveSettings,
}));
vi.mock("@/lib/server/object-storage-service", () => ({ checkConfiguredObjectStorage: mocks.check }));

import { GET, PATCH, POST } from "./route";

const settings = {
    enabled: true,
    endpoint: "https://oss.example.com",
    region: "auto",
    bucket: "media",
    prefix: "vozeb-pro",
    forcePathStyle: false,
    hasAccessKeyId: true,
    hasSecretAccessKey: true,
};

describe("administrator object storage API", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.user.mockResolvedValue({ id: "admin", role: "admin", status: "active", adminPermissions: ["system.manage"] });
        mocks.getSettings.mockResolvedValue(settings);
        mocks.saveSettings.mockResolvedValue(settings);
    });

    it("requires an administrator for configuration and connection checks", async () => {
        mocks.user.mockResolvedValueOnce(null);
        expect((await GET()).status).toBe(401);
        mocks.user.mockResolvedValueOnce({ id: "user", role: "user" });
        expect((await POST()).status).toBe(403);
        expect(mocks.getSettings).not.toHaveBeenCalled();
        expect(mocks.check).not.toHaveBeenCalled();
    });

    it("returns only redacted administrator settings", async () => {
        const response = await GET();
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.data).toEqual(settings);
        expect(JSON.stringify(body)).not.toContain("secret-access-value");
    });

    it("returns the safe capability failure reported by the connection check", async () => {
        mocks.check.mockRejectedValueOnce(new Error("对象写入检查失败：权限不足（AccessDenied/403），请确认凭据拥有当前 Bucket 的列表、读取、写入和删除权限"));

        const response = await POST();

        expect(response.status).toBe(502);
        await expect(response.json()).resolves.toMatchObject({ code: 502, data: { available: false }, msg: expect.stringContaining("对象写入检查失败") });
    });

    it("passes normalized input boundaries to the configuration service", async () => {
        const response = await PATCH(
            new Request("http://localhost/api/admin/object-storage", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...settings, accessKeyId: "new-access", secretAccessKey: "new-secret", forcePathStyle: true }),
            }),
        );

        expect(response.status).toBe(200);
        expect(mocks.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, accessKeyId: "new-access", secretAccessKey: "new-secret", forcePathStyle: true }));
        expect(mocks.audit).toHaveBeenCalledWith(
            expect.objectContaining({
                action: "admin.object-storage.update",
                target: { type: "object_storage", id: "primary" },
                metadata: { enabled: true, forcePathStyle: true },
            }),
        );
        expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("new-secret");
    });
});
