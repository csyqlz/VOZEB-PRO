import { describe, expect, it, vi } from "vitest";

import type { QueryExecutor } from "./postgres";
import { TenantRepository } from "./tenant-repository";

function mockExecutor(rows: Record<string, unknown>[][]) {
    const query = vi.fn(async () => ({ rows: rows.shift() || [], rowCount: 1 }));
    return { executor: { query } as unknown as QueryExecutor, query };
}

function queryArgs(query: ReturnType<typeof mockExecutor>["query"], index = 0) {
    return (query.mock.calls as unknown[][])[index] || [];
}

describe("TenantRepository", () => {
    it("derives the only active tenant context from a user id", async () => {
        const { executor, query } = mockExecutor([[{ tenant_id: "tenant-a", tenant_name: "甲租户", user_id: "user-a", role: "admin", status: "active" }]]);

        await expect(new TenantRepository(executor).findContextByUserId("user-a")).resolves.toEqual({
            tenantId: "tenant-a",
            tenantName: "甲租户",
            userId: "user-a",
            role: "admin",
        });
        expect(queryArgs(query)[0]).toContain("memberships.user_id = $1");
        expect(queryArgs(query)[0]).toContain("memberships.status = 'active'");
        expect(queryArgs(query)[1]).toEqual(["user-a"]);
    });

    it("lists members through an explicitly tenant-scoped paginated query", async () => {
        const timestamp = "2026-09-08T00:00:00.000Z";
        const { executor, query } = mockExecutor([
            [
                {
                    tenant_id: "tenant-a",
                    user_id: "user-a",
                    role: "member",
                    membership_status: "active",
                    account_id: 12,
                    username: "member-a",
                    display_name: "成员甲",
                    user_status: "active",
                    created_at: timestamp,
                    updated_at: timestamp,
                    total_count: "1",
                },
            ],
        ]);

        const result = await new TenantRepository(executor).listMembers("tenant-a", { page: 1, pageSize: 20, keyword: "成员" });

        expect(result.total).toBe(1);
        expect(result.items[0]).toMatchObject({ tenantId: "tenant-a", userId: "user-a", username: "member-a", role: "member" });
        expect(queryArgs(query)[0]).toContain("memberships.tenant_id = $1");
        expect(queryArgs(query)[0]).toContain("LIMIT $5 OFFSET $6");
        expect(queryArgs(query)[1]).toEqual(["tenant-a", "成员", "%成员%", null, 20, 0]);
    });

    it("aggregates historical calls while counting only currently active creators", async () => {
        const { executor, query } = mockExecutor([
            [
                {
                    member_total: 3,
                    active_members: 2,
                    admin_count: 1,
                    total_calls: 8,
                    success_calls: 6,
                    failed_calls: 1,
                    active_creators: 1,
                    daily: [{ key: "2026-09-08", value: 8 }],
                    models: [{ key: "image-pro", value: 8 }],
                    sources: [],
                    kinds: [],
                },
            ],
        ]);

        const result = await new TenantRepository(executor).getOverview("tenant-a", {
            startAt: "2026-09-01T16:00:00.000Z",
            endAt: "2026-09-08T16:00:00.000Z",
            timeZone: "Asia/Shanghai",
        });

        expect(result).toMatchObject({ memberTotal: 3, activeMembers: 2, totalCalls: 8, activeCreators: 1 });
        const statement = String(queryArgs(query)[0]);
        expect(statement).toContain("memberships.tenant_id = $1");
        expect(statement).toContain("members.user_status = 'active'");
        expect(statement).not.toMatch(/SELECT\s+\*/i);
    });
});
