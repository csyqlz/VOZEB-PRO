import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createPostgresRepositories, initializePostgresSchema, postgresQuery } from "./index";
import type { GenerationLogRecord } from "./repository-types";

const postgresIt = process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION === "1" ? it : it.skip;

describe("PostgreSQL tenant isolation", () => {
    postgresIt("keeps members, overview metrics and audit logs inside their tenant", async () => {
        await initializePostgresSchema();
        await initializePostgresSchema();
        const repositories = createPostgresRepositories();
        const settings = await repositories.settings.getSettings();
        const planId = settings.settings?.defaultPlanId || settings.plans[0]?.id;
        if (!planId) throw new Error("PostgreSQL integration test requires an entitlement plan");

        const suffix = randomUUID();
        const tenantA = `test-tenant-a-${suffix}`;
        const tenantB = `test-tenant-b-${suffix}`;
        const ownerA = `test-owner-a-${suffix}`;
        const memberA = `test-member-a-${suffix}`;
        const disabledA = `test-disabled-a-${suffix}`;
        const ownerB = `test-owner-b-${suffix}`;
        const userIds = [ownerA, memberA, disabledA, ownerB];
        const tenantIds = [tenantA, tenantB];
        const logIds = [`test-log-a-${suffix}`, `test-log-disabled-${suffix}`, `test-log-b-${suffix}`];
        const now = new Date();
        const timestamp = now.toISOString();

        try {
            for (const [index, userId] of userIds.entries()) {
                await repositories.users.createWithNextAccountId({
                    id: userId,
                    username: `tenant_${index}_${suffix.replaceAll("-", "").slice(0, 16)}`,
                    displayName: `租户隔离成员 ${index}`,
                    bio: "",
                    role: "user",
                    adminPermissions: [],
                    status: index === 2 ? "disabled" : "active",
                    planId,
                    pointsBalance: 0,
                    passwordHash: "integration-test-only",
                    createdAt: timestamp,
                    updatedAt: timestamp,
                });
            }

            await repositories.tenants.createTenant({ id: tenantA, slug: `test-a-${suffix}`, name: "隔离测试甲", ownerUserId: ownerA, createdAt: timestamp, updatedAt: timestamp });
            await repositories.tenants.createTenant({ id: tenantB, slug: `test-b-${suffix}`, name: "隔离测试乙", ownerUserId: ownerB, createdAt: timestamp, updatedAt: timestamp });
            await repositories.tenants.addMembership({ tenantId: tenantA, userId: ownerA, role: "owner", status: "active", createdAt: timestamp, updatedAt: timestamp });
            await repositories.tenants.addMembership({ tenantId: tenantA, userId: memberA, role: "member", status: "active", createdAt: timestamp, updatedAt: timestamp });
            await repositories.tenants.addMembership({ tenantId: tenantA, userId: disabledA, role: "member", status: "disabled", createdAt: timestamp, updatedAt: timestamp });
            await repositories.tenants.addMembership({ tenantId: tenantB, userId: ownerB, role: "owner", status: "active", createdAt: timestamp, updatedAt: timestamp });

            await repositories.generationLogs.upsert(generationLog(logIds[0], memberA, "success", timestamp));
            await repositories.generationLogs.upsert(generationLog(logIds[1], disabledA, "failed", timestamp));
            await repositories.generationLogs.upsert(generationLog(logIds[2], ownerB, "success", timestamp));
            await repositories.auditLogs.create({ id: `test-audit-a-${suffix}`, action: "tenant.member.create", status: "success", tenantId: tenantA, scope: "tenant", actorTenantRole: "owner", createdAt: timestamp });
            await repositories.auditLogs.create({ id: `test-platform-audit-a-${suffix}`, action: "platform.tenant.rename", status: "success", tenantId: tenantA, scope: "platform", createdAt: timestamp });
            await repositories.auditLogs.create({ id: `test-audit-b-${suffix}`, action: "tenant.member.create", status: "success", tenantId: tenantB, scope: "tenant", actorTenantRole: "owner", createdAt: timestamp });

            const startAt = new Date(now.getTime() - 60_000).toISOString();
            const endAt = new Date(now.getTime() + 60_000).toISOString();
            const [overviewA, overviewB, membersA, auditA] = await Promise.all([
                repositories.tenants.getOverview(tenantA, { startAt, endAt, timeZone: "Asia/Shanghai" }),
                repositories.tenants.getOverview(tenantB, { startAt, endAt, timeZone: "Asia/Shanghai" }),
                repositories.tenants.listMembers(tenantA, { pageSize: 20 }),
                repositories.auditLogs.list({ tenantId: tenantA, scope: "tenant", pageSize: 20 }),
            ]);

            expect(overviewA).toMatchObject({ memberTotal: 3, activeMembers: 2, adminCount: 1, totalCalls: 2, successCalls: 1, failedCalls: 1, activeCreators: 1 });
            expect(overviewB).toMatchObject({ memberTotal: 1, activeMembers: 1, adminCount: 1, totalCalls: 1, successCalls: 1, failedCalls: 0, activeCreators: 1 });
            expect(membersA.items.map((member) => member.userId).sort()).toEqual([disabledA, memberA, ownerA].sort());
            expect(auditA.items).toHaveLength(1);
            expect(auditA.items[0]).toMatchObject({ tenantId: tenantA, scope: "tenant" });

            await expect(repositories.tenants.addMembership({ tenantId: tenantB, userId: memberA, role: "member", status: "active", createdAt: timestamp, updatedAt: timestamp })).rejects.toMatchObject({ code: "23505" });
            await expect(repositories.tenants.updateMemberRole(tenantA, memberA, "owner", timestamp)).rejects.toMatchObject({ code: "23505" });
        } finally {
            await repositories.generationLogs.delete(logIds);
            await postgresQuery("DELETE FROM audit_logs WHERE tenant_id = ANY($1::text[])", [tenantIds]);
            await postgresQuery("DELETE FROM tenant_memberships WHERE tenant_id = ANY($1::text[])", [tenantIds]);
            await postgresQuery("DELETE FROM tenants WHERE id = ANY($1::text[])", [tenantIds]);
            for (const userId of userIds) await repositories.users.delete(userId);
        }
    });
});

function generationLog(id: string, userId: string, status: GenerationLogRecord["status"], timestamp: string): GenerationLogRecord {
    return {
        id,
        userId,
        username: userId,
        displayName: userId,
        kind: "image",
        source: "image-workbench",
        status,
        title: "租户隔离测试",
        prompt: "integration test",
        model: "test-model",
        summary: "",
        durationMs: 1,
        count: 1,
        successCount: status === "success" ? 1 : 0,
        failCount: status === "failed" ? 1 : 0,
        assets: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: timestamp,
    };
}
