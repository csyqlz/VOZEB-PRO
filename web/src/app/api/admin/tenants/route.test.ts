import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    createTenantWithOwner: vi.fn(),
    checkTenantMutationRateLimit: vi.fn(),
    getCurrentUser: vi.fn(),
    listPlatformTenants: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/server/tenant-rate-limit", () => ({ checkTenantMutationRateLimit: mocks.checkTenantMutationRateLimit }));
vi.mock("@/lib/server/tenant-service", () => ({
    createTenantWithOwner: mocks.createTenantWithOwner,
    listPlatformTenants: mocks.listPlatformTenants,
    isTenantServiceError: () => false,
}));

import { GET, POST } from "./route";

describe("admin tenants route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.checkTenantMutationRateLimit.mockResolvedValue({ allowed: true, remaining: 9, resetAt: Date.now() + 60_000 });
    });

    it("returns the platform tenant page in the standard envelope", async () => {
        mocks.getCurrentUser.mockResolvedValue({ id: "platform-admin", role: "admin", status: "active", adminPermissions: ["tenants.read"] });
        mocks.listPlatformTenants.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });

        const response = await GET(new Request("http://localhost/api/admin/tenants?page=1"));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ code: 0, data: { items: [], total: 0, page: 1, pageSize: 20 }, msg: "OK" });
    });

    it("keeps tenant creation behind the dedicated manage permission", async () => {
        mocks.getCurrentUser.mockResolvedValue({ id: "platform-admin", role: "admin", status: "active", adminPermissions: ["tenants.read"] });

        const response = await POST(new Request("http://localhost/api/admin/tenants", { method: "POST", body: "{}" }));

        expect(response.status).toBe(403);
        expect(mocks.createTenantWithOwner).not.toHaveBeenCalled();
    });

    it("rate limits tenant creation before parsing or mutating data", async () => {
        mocks.getCurrentUser.mockResolvedValue({ id: "platform-admin", role: "admin", status: "active", adminPermissions: ["tenants.manage"] });
        mocks.checkTenantMutationRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: Date.now() + 60_000 });

        const response = await POST(new Request("http://localhost/api/admin/tenants", { method: "POST", body: "{}" }));

        expect(response.status).toBe(429);
        expect(mocks.checkTenantMutationRateLimit).toHaveBeenCalledWith("platform-tenant-create", "platform-admin");
        expect(mocks.createTenantWithOwner).not.toHaveBeenCalled();
    });
});
