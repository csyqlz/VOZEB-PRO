import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    ensurePostgresSchema: vi.fn(),
    findContextByUserId: vi.fn(),
    isPostgresDatabaseEnabled: vi.fn(() => true),
}));

vi.mock("@/lib/server/database", () => ({
    ensurePostgresSchema: mocks.ensurePostgresSchema,
    isPostgresDatabaseEnabled: mocks.isPostgresDatabaseEnabled,
    createPostgresRepositories: () => ({ tenants: { findContextByUserId: mocks.findContextByUserId } }),
}));

import { requireTenantContext } from "./tenant-context";

describe("tenant context", () => {
    beforeEach(() => {
        process.env.VOZEB_PRO_TENANT_MVP_ENABLED = "true";
        mocks.ensurePostgresSchema.mockReset();
        mocks.findContextByUserId.mockReset();
        mocks.isPostgresDatabaseEnabled.mockReturnValue(true);
    });

    afterEach(() => {
        delete process.env.VOZEB_PRO_TENANT_MVP_ENABLED;
    });

    it("returns the active membership derived from the session user", async () => {
        mocks.findContextByUserId.mockResolvedValue({ tenantId: "tenant-a", tenantName: "甲租户", userId: "user-a", role: "admin" });

        await expect(requireTenantContext("user-a", ["owner", "admin"])).resolves.toEqual({ tenantId: "tenant-a", tenantName: "甲租户", userId: "user-a", role: "admin" });
        expect(mocks.findContextByUserId).toHaveBeenCalledWith("user-a");
    });

    it("rejects users without an active membership", async () => {
        mocks.findContextByUserId.mockResolvedValue(null);

        await expect(requireTenantContext("user-a")).rejects.toMatchObject({ status: 403 });
    });

    it("keeps ordinary members outside management routes", async () => {
        mocks.findContextByUserId.mockResolvedValue({ tenantId: "tenant-a", tenantName: "甲租户", userId: "user-a", role: "member" });

        await expect(requireTenantContext("user-a", ["owner", "admin"])).rejects.toMatchObject({ status: 403 });
    });

    it("fails closed outside PostgreSQL or while the feature is disabled", async () => {
        mocks.isPostgresDatabaseEnabled.mockReturnValue(false);
        await expect(requireTenantContext("user-a")).rejects.toMatchObject({ status: 503 });

        mocks.isPostgresDatabaseEnabled.mockReturnValue(true);
        process.env.VOZEB_PRO_TENANT_MVP_ENABLED = "false";
        await expect(requireTenantContext("user-a")).rejects.toMatchObject({ status: 404 });
    });
});
