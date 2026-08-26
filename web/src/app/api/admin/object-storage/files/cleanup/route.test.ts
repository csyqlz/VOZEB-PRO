import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    cleanup: vi.fn(),
    audit: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/server/object-storage-service", () => ({ cleanupNestedExternalStoragePreviews: mocks.cleanup }));
vi.mock("@/lib/server/audit-log-store", () => ({ auditActorFromRequest: vi.fn(() => ({ id: "admin" })), safeRecordAuditLog: mocks.audit }));

import { POST } from "./route";

describe("POST /api/admin/object-storage/files/cleanup", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCurrentUser.mockResolvedValue({ id: "admin", role: "admin", status: "active", adminPermissions: ["system.manage"] });
        mocks.cleanup.mockResolvedValue({ scanned: 18, deleted: 12, reclaimedBytes: 4096 });
    });

    it("cleans nested previews and records the exact result", async () => {
        const response = await POST(new Request("http://localhost/api/admin/object-storage/files/cleanup", { method: "POST" }));
        const payload = await response.json();

        expect(response.status).toBe(200);
        expect(payload.data).toEqual({ scanned: 18, deleted: 12, reclaimedBytes: 4096 });
        expect(mocks.cleanup).toHaveBeenCalledOnce();
        expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "admin.object-storage.previews.cleanup", metadata: { scanned: 18, deleted: 12, reclaimedBytes: 4096 } }));
    });

    it("requires storage management permission", async () => {
        mocks.getCurrentUser.mockResolvedValueOnce({ id: "user-one", role: "user", adminPermissions: [] });

        expect((await POST(new Request("http://localhost/api/admin/object-storage/files/cleanup", { method: "POST" }))).status).toBe(403);
        expect(mocks.cleanup).not.toHaveBeenCalled();
    });
});
