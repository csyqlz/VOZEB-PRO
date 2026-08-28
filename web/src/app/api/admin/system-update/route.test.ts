import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    user: null as null | { id: string; role: string; status: string; adminPermissions: string[] },
    info: vi.fn(),
    request: vi.fn(),
    audit: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: vi.fn(async () => mocks.user) }));
vi.mock("@/lib/admin-permissions", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/admin-permissions")>();
    return { ...actual, hasAdminPermission: vi.fn((user, permission) => user.adminPermissions.includes(permission)) };
});
vi.mock("@/lib/server/system-update-service", () => ({
    SystemUpdateServiceError: class SystemUpdateServiceError extends Error {
        constructor(
            message: string,
            readonly status: number,
        ) {
            super(message);
        }
    },
    getSystemUpdateInfo: mocks.info,
    requestSystemUpdate: mocks.request,
}));
vi.mock("@/lib/server/audit-log-store", () => ({ auditActorFromRequest: vi.fn(() => ({ id: "admin-one" })), safeRecordAuditLog: mocks.audit }));

import { GET, POST } from "./route";

describe("admin system update route", () => {
    beforeEach(() => {
        mocks.user = { id: "admin-one", role: "admin", status: "active", adminPermissions: ["system.manage"] };
        mocks.info.mockReset().mockResolvedValue({ currentVersion: "v0.0.8", latestVersion: "v0.0.9" });
        mocks.request.mockReset().mockResolvedValue({ id: "request-one", status: "preparing" });
        mocks.audit.mockReset();
    });

    it("requires system management permission", async () => {
        mocks.user = { ...mocks.user!, adminPermissions: [] };
        const response = await GET();
        expect(response.status).toBe(403);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
    });

    it("starts and audits an authenticated update operation", async () => {
        const response = await POST(
            new Request("http://localhost/api/admin/system-update", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    action: "upgrade",
                    targetVersion: "v0.0.9",
                    idempotencyKey: "request-one",
                    confirmations: { databaseBackup: true, environmentReviewed: true, changelogReviewed: true, rollbackReviewed: true },
                }),
            }),
        );
        expect(response.status).toBe(202);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({ action: "upgrade", targetVersion: "v0.0.9" }));
        expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "admin.system_update.upgrade" }));
    });
});
