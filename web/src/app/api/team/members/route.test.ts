import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    createTenantMember: vi.fn(),
    checkTenantMutationRateLimit: vi.fn(),
    getCurrentUser: vi.fn(),
    listTenantMembers: vi.fn(),
    requireTenantContext: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/server/tenant-rate-limit", () => ({ checkTenantMutationRateLimit: mocks.checkTenantMutationRateLimit }));
vi.mock("@/lib/server/tenant-context", () => ({
    requireTenantContext: mocks.requireTenantContext,
    isTenantAccessError: () => false,
}));
vi.mock("@/lib/server/tenant-service", () => ({
    createTenantMember: mocks.createTenantMember,
    listTenantMembers: mocks.listTenantMembers,
    isTenantServiceError: () => false,
}));

import { GET, POST } from "./route";

describe("team members route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCurrentUser.mockResolvedValue({ id: "admin-a", username: "admin-a", role: "user" });
        mocks.requireTenantContext.mockResolvedValue({ tenantId: "tenant-a", tenantName: "甲租户", userId: "admin-a", role: "admin" });
        mocks.listTenantMembers.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
        mocks.checkTenantMutationRateLimit.mockResolvedValue({ allowed: true, remaining: 29, resetAt: Date.now() + 60_000 });
    });

    it("derives tenant scope from the current session even when a query tries to override it", async () => {
        const response = await GET(new Request("http://localhost/api/team/members?tenantId=tenant-b&page=1"));

        expect(response.status).toBe(200);
        expect(mocks.requireTenantContext).toHaveBeenCalledWith("admin-a", ["owner", "admin"]);
        expect(mocks.listTenantMembers).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant-a" }), expect.not.objectContaining({ tenantId: "tenant-b" }));
        await expect(response.json()).resolves.toMatchObject({ code: 0, data: { tenant: { tenantId: "tenant-a" } } });
    });

    it("ignores a tenant id in the request body and creates the member inside session scope", async () => {
        mocks.createTenantMember.mockResolvedValue({ tenantId: "tenant-a", userId: "member-a", role: "member" });

        const response = await POST(
            new Request("http://localhost/api/team/members", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ tenantId: "tenant-b", username: "member-a", password: "password123", role: "member" }),
            }),
        );

        expect(response.status).toBe(201);
        expect(mocks.createTenantMember).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant-a" }), expect.objectContaining({ id: "admin-a" }), expect.not.objectContaining({ tenantId: "tenant-b" }));
    });

    it("rate limits member creation inside the session-derived tenant", async () => {
        mocks.checkTenantMutationRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: Date.now() + 60_000 });

        const response = await POST(new Request("http://localhost/api/team/members", { method: "POST", body: "{}" }));

        expect(response.status).toBe(429);
        expect(mocks.checkTenantMutationRateLimit).toHaveBeenCalledWith("tenant-member-create", "tenant-a:admin-a");
        expect(mocks.createTenantMember).not.toHaveBeenCalled();
    });
});
