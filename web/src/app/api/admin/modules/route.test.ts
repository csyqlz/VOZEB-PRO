import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    currentUser: vi.fn(),
    listModules: vi.fn(),
    changeState: vi.fn(),
    audit: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.currentUser }));
vi.mock("@/lib/server/vozeb-cms/module-service", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/server/vozeb-cms/module-service")>()),
    listVozebCmsModules: mocks.listModules,
    changeVozebCmsModuleState: mocks.changeState,
}));
vi.mock("@/lib/server/audit-log-store", () => ({ auditActorFromRequest: vi.fn(() => ({ id: "admin-one" })), safeRecordAuditLog: mocks.audit }));

import { GET, PATCH } from "@/app/api/admin/modules/route";

describe("admin VOZEBCMS modules route", () => {
    beforeEach(() => {
        mocks.currentUser.mockReset().mockResolvedValue({ id: "admin-one", role: "admin", status: "active", adminPermissions: ["system.manage"] });
        mocks.listModules.mockReset().mockResolvedValue([{ id: "create", name: "创作 Agent", enabled: true, revision: 0 }]);
        mocks.changeState.mockReset().mockResolvedValue({ id: "create", name: "创作 Agent", enabled: false, revision: 1 });
        mocks.audit.mockReset();
    });

    it("requires the system management duty", async () => {
        mocks.currentUser.mockResolvedValue({ id: "auditor", role: "admin", status: "active", adminPermissions: ["audit.read"] });

        expect((await GET()).status).toBe(403);
        expect(mocks.listModules).not.toHaveBeenCalled();
    });

    it("updates one known module with revision and mutation identity", async () => {
        const response = await PATCH(
            new Request("http://localhost/api/admin/modules", {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ moduleId: "create", enabled: false, baseRevision: 0, mutationId: "mutation-one" }),
            }),
        );

        expect(response.status).toBe(200);
        expect(mocks.changeState).toHaveBeenCalledWith({ moduleId: "create", enabled: false, baseRevision: 0, mutationId: "mutation-one", updatedBy: "admin-one" });
        expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "admin.module.state.update", target: expect.objectContaining({ id: "create" }) }));
    });

    it("rejects unknown module ids before mutation", async () => {
        const response = await PATCH(
            new Request("http://localhost/api/admin/modules", {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ moduleId: "unknown", enabled: false, baseRevision: 0, mutationId: "mutation-one" }),
            }),
        );

        expect(response.status).toBe(400);
        expect(mocks.changeState).not.toHaveBeenCalled();
    });
});
