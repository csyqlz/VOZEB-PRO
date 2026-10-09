import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    addMembership: vi.fn(),
    auditCreate: vi.fn(),
    auditList: vi.fn(),
    createUser: vi.fn(),
    findIdentityConflict: vi.fn(),
    getWalletSettings: vi.fn(),
    getMember: vi.fn(),
    lockTenant: vi.fn(),
    hashPassword: vi.fn(async () => "password-hash"),
    updateMemberRole: vi.fn(),
    updateMemberStatus: vi.fn(),
    updateUser: vi.fn(),
    deleteSessions: vi.fn(),
    withPostgresTransaction: vi.fn(async (handler: (client: object) => Promise<unknown>) => handler({ query: vi.fn() })),
}));

vi.mock("@/lib/server/database", () => ({
    ensurePostgresSchema: vi.fn(),
    isPostgresDatabaseEnabled: vi.fn(() => true),
    withPostgresTransaction: mocks.withPostgresTransaction,
    createPostgresRepositories: () => ({
        settings: { getWalletSettings: mocks.getWalletSettings },
        users: { findIdentityConflict: mocks.findIdentityConflict, createWithNextAccountId: mocks.createUser, update: mocks.updateUser },
        sessions: { deleteByUserId: mocks.deleteSessions },
        tenants: {
            lockTenant: mocks.lockTenant,
            addMembership: mocks.addMembership,
            getMember: mocks.getMember,
            updateMemberRole: mocks.updateMemberRole,
            updateMemberStatus: mocks.updateMemberStatus,
        },
        auditLogs: { create: mocks.auditCreate, list: mocks.auditList },
    }),
}));

vi.mock("@/lib/server/auth-mutation-lock", () => ({ lockAuthMutation: vi.fn() }));
vi.mock("@/lib/auth/password", () => ({ hashPassword: mocks.hashPassword }));

import { createTenantMember, listTenantAuditLogs, updateTenantMember } from "./tenant-service";

describe("tenant service", () => {
    beforeEach(() => {
        process.env.VOZEB_PRO_TENANT_MVP_ENABLED = "true";
        vi.clearAllMocks();
        mocks.getWalletSettings.mockResolvedValue({ settings: { defaultPlanId: "free" }, plans: [] });
        mocks.findIdentityConflict.mockResolvedValue(null);
        mocks.lockTenant.mockResolvedValue({ id: "tenant-a", name: "甲租户" });
        mocks.createUser.mockImplementation(async (input) => ({ ...input, accountId: "0012" }));
        mocks.addMembership.mockImplementation(async (input) => input);
        mocks.updateMemberRole.mockImplementation(async (_tenantId, _userId, role) => ({ role }));
        mocks.updateMemberStatus.mockImplementation(async (_tenantId, _userId, status) => ({ status }));
    });

    it("creates tenant administrators as ordinary platform users in one transaction", async () => {
        const created = await createTenantMember(
            { tenantId: "tenant-a", tenantName: "甲租户", userId: "owner-a", role: "owner" },
            { id: "owner-a", username: "owner", role: "user" },
            { username: "tenant-admin", displayName: "租户管理员", password: "password123", role: "admin" },
        );

        expect(mocks.withPostgresTransaction).toHaveBeenCalledTimes(1);
        expect(mocks.createUser).toHaveBeenCalledWith(expect.objectContaining({ role: "user", adminPermissions: [], username: "tenant-admin" }));
        expect(mocks.addMembership).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant-a", role: "admin", status: "active" }));
        expect(mocks.auditCreate).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant-a", scope: "tenant", action: "tenant.member.create" }));
        expect(created).toMatchObject({ username: "tenant-admin", role: "admin", userStatus: "active" });
    });

    it("does not let a tenant administrator create another administrator", async () => {
        await expect(
            createTenantMember(
                { tenantId: "tenant-a", tenantName: "甲租户", userId: "admin-a", role: "admin" },
                { id: "admin-a", username: "admin-a", role: "user" },
                { username: "admin-b", displayName: "同级管理员", password: "password123", role: "admin" },
            ),
        ).rejects.toMatchObject({ status: 403 });

        expect(mocks.createUser).not.toHaveBeenCalled();
        expect(mocks.addMembership).not.toHaveBeenCalled();
        expect(mocks.auditCreate).not.toHaveBeenCalled();
    });

    it("disables an ordinary membership and revokes every session without changing platform account status", async () => {
        mocks.getMember
            .mockResolvedValueOnce({ tenantId: "tenant-a", userId: "member-a", username: "member", role: "member", status: "active", userStatus: "active" })
            .mockResolvedValueOnce({ tenantId: "tenant-a", userId: "member-a", username: "member", role: "member", status: "disabled", userStatus: "active" });

        const updated = await updateTenantMember({ tenantId: "tenant-a", tenantName: "甲租户", userId: "owner-a", role: "owner" }, { id: "owner-a", username: "owner", role: "user" }, "member-a", { status: "disabled" });

        expect(mocks.updateMemberStatus).toHaveBeenCalledWith("tenant-a", "member-a", "disabled", expect.any(String));
        expect(mocks.updateUser).not.toHaveBeenCalled();
        expect(mocks.deleteSessions).toHaveBeenCalledWith("member-a");
        expect(mocks.auditCreate).toHaveBeenCalledWith(expect.objectContaining({ action: "tenant.member.status", tenantId: "tenant-a", metadata: { previousStatus: "active", status: "disabled" } }));
        expect(updated).toMatchObject({ userId: "member-a", status: "disabled", userStatus: "active" });
    });

    it("never lets another tenant manager modify the owner", async () => {
        mocks.getMember.mockResolvedValue({ tenantId: "tenant-a", userId: "owner-a", username: "owner", role: "owner", status: "active", userStatus: "active" });

        await expect(updateTenantMember({ tenantId: "tenant-a", tenantName: "甲租户", userId: "admin-a", role: "admin" }, { id: "admin-a", username: "admin", role: "user" }, "owner-a", { status: "disabled" })).rejects.toMatchObject({ status: 403 });

        expect(mocks.updateMemberStatus).not.toHaveBeenCalled();
        expect(mocks.updateUser).not.toHaveBeenCalled();
        expect(mocks.deleteSessions).not.toHaveBeenCalled();
    });

    it("does not let a tenant administrator modify another administrator or themselves", async () => {
        mocks.getMember.mockResolvedValue({ tenantId: "tenant-a", userId: "admin-b", username: "admin-b", role: "admin", status: "active", userStatus: "active" });

        await expect(updateTenantMember({ tenantId: "tenant-a", tenantName: "甲租户", userId: "admin-a", role: "admin" }, { id: "admin-a", username: "admin-a", role: "user" }, "admin-b", { role: "member" })).rejects.toMatchObject({ status: 403 });

        mocks.getMember.mockResolvedValue({ tenantId: "tenant-a", userId: "admin-a", username: "admin-a", role: "admin", status: "active", userStatus: "active" });
        await expect(updateTenantMember({ tenantId: "tenant-a", tenantName: "甲租户", userId: "admin-a", role: "admin" }, { id: "admin-a", username: "admin-a", role: "user" }, "admin-a", { status: "disabled" })).rejects.toMatchObject({ status: 403 });

        expect(mocks.updateMemberRole).not.toHaveBeenCalled();
        expect(mocks.updateMemberStatus).not.toHaveBeenCalled();
    });

    it("limits the tenant audit feed to tenant-scoped records", async () => {
        mocks.auditList.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20, totalPages: 0 });

        await listTenantAuditLogs({ tenantId: "tenant-a", tenantName: "甲租户", userId: "owner-a", role: "owner" }, { page: 1, pageSize: 20 });

        expect(mocks.auditList).toHaveBeenCalledWith({ tenantId: "tenant-a", scope: "tenant", page: 1, pageSize: 20 });
    });
});
