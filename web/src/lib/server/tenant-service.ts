import { randomUUID } from "node:crypto";

import { hashPassword } from "@/lib/auth/password";
import { normalizeDisplayName, normalizeEmail, normalizeUsername, validateEmail, validatePassword, validateUsername } from "@/lib/auth/store-normalizers";
import type { PublicUser } from "@/lib/auth/store-types";
import { hasAdminPermission } from "@/lib/admin-permissions";
import { canManageTenantMember, type TenantRole } from "@/lib/tenant-permissions";
import type { TeamOverviewSummary, TenantContext, TenantMemberItem, TenantMembershipStatus, TenantRecord } from "@/lib/tenant";
import { lockAuthMutation } from "@/lib/server/auth-mutation-lock";
import { createPostgresRepositories, ensurePostgresSchema, isPostgresDatabaseEnabled, withPostgresTransaction } from "@/lib/server/database";
import { generationOverviewWindow } from "@/lib/server/generation-overview-service";
import { kindLabel, sourceLabel } from "@/lib/server/generation-log-repository";

import { isTenantMvpEnabled, TenantAccessError } from "./tenant-context";

type TenantActor = Pick<PublicUser, "id" | "username" | "role">;
type NewTenantUserInput = { username: string; email?: string; displayName?: string; password: string };

export class TenantInputError extends Error {
    constructor(
        message: string,
        public readonly status = 400,
    ) {
        super(message);
    }
}

export async function listPlatformTenants(input: { page?: number; pageSize?: number; keyword?: string }) {
    await assertTenantRuntime();
    return createPostgresRepositories().tenants.listTenants({ ...input, callsStartAt: generationOverviewWindow(new Date()).startAt });
}

export async function createTenantWithOwner(actor: PublicUser, input: { name: string; slug: string; owner: NewTenantUserInput }) {
    await assertTenantRuntime();
    if (!hasAdminPermission(actor, "tenants.manage")) throw new TenantAccessError("当前管理员没有创建租户的职责权限", 403);
    const name = normalizeTenantName(input.name);
    const slug = normalizeTenantSlug(input.slug);

    return withPostgresTransaction(async (client) => {
        await lockAuthMutation(client);
        const repos = createPostgresRepositories(client);
        const now = new Date().toISOString();
        const owner = await createTenantUser(repos, input.owner, now);
        const tenant = await repos.tenants.createTenant({ id: randomUUID(), slug, name, ownerUserId: owner.id, createdByUserId: actor.id, createdAt: now, updatedAt: now });
        const membership = await repos.tenants.addMembership({ tenantId: tenant.id, userId: owner.id, role: "owner", status: "active", createdByUserId: actor.id, createdAt: now, updatedAt: now });
        await repos.auditLogs.create({
            id: randomUUID(),
            action: "platform.tenant.create",
            status: "success",
            actorUserId: actor.id,
            actorUsername: actor.username,
            actorRole: actor.role,
            targetType: "tenant",
            targetId: tenant.id,
            targetLabel: tenant.name,
            tenantId: tenant.id,
            scope: "platform",
            metadata: { slug: tenant.slug, ownerUserId: owner.id },
            createdAt: now,
        });
        return { tenant, owner: tenantMemberFrom(owner, membership) };
    });
}

export async function renameTenant(actor: PublicUser, tenantId: string, nameInput: string): Promise<TenantRecord> {
    await assertTenantRuntime();
    if (!hasAdminPermission(actor, "tenants.manage")) throw new TenantAccessError("当前管理员没有维护租户的职责权限", 403);
    const name = normalizeTenantName(nameInput);
    return withPostgresTransaction(async (client) => {
        const repos = createPostgresRepositories(client);
        const current = await repos.tenants.lockTenant(tenantId);
        if (!current) throw new TenantInputError("租户不存在", 404);
        const now = new Date().toISOString();
        const tenant = await repos.tenants.updateName(tenantId, name, now);
        if (!tenant) throw new TenantInputError("租户不存在", 404);
        await repos.auditLogs.create({
            id: randomUUID(),
            action: "platform.tenant.rename",
            status: "success",
            actorUserId: actor.id,
            actorUsername: actor.username,
            actorRole: actor.role,
            targetType: "tenant",
            targetId: tenant.id,
            targetLabel: tenant.name,
            tenantId: tenant.id,
            scope: "platform",
            metadata: { previousName: current.name },
            createdAt: now,
        });
        return tenant;
    });
}

export async function getTeamOverview(context: TenantContext, now = new Date()): Promise<TeamOverviewSummary> {
    await assertTenantRuntime();
    const window = generationOverviewWindow(now);
    const aggregate = await createPostgresRepositories().tenants.getOverview(context.tenantId, { startAt: window.startAt, endAt: window.endAt, timeZone: "Asia/Shanghai" });
    const daily = new Map(aggregate.daily.map((item) => [item.key, item.value]));
    const completedCalls = aggregate.successCalls + aggregate.failedCalls;
    return {
        ...aggregate,
        timezone: "Asia/Shanghai",
        startAt: window.startAt,
        endAt: window.endAt,
        successRate: completedCalls ? Math.round((aggregate.successCalls / completedCalls) * 100) : null,
        daily: window.dates.map((date) => ({ key: date, value: daily.get(date) || 0 })),
        models: aggregate.models.map((item) => ({ ...item, key: item.key })),
        sources: aggregate.sources.map((item) => ({ ...item, key: sourceLabel(item.key) })),
        kinds: aggregate.kinds.map((item) => ({ ...item, key: kindLabel(item.key) })),
    };
}

export async function listTenantMembers(context: TenantContext, input: { page?: number; pageSize?: number; keyword?: string; status?: TenantMembershipStatus }) {
    await assertTenantRuntime();
    return createPostgresRepositories().tenants.listMembers(context.tenantId, input);
}

export async function createTenantMember(context: TenantContext, actor: TenantActor, input: NewTenantUserInput & { role?: Exclude<TenantRole, "owner"> }): Promise<TenantMemberItem> {
    await assertTenantRuntime();
    if (context.role !== "owner" && context.role !== "admin") throw new TenantAccessError("当前成员没有成员管理权限", 403);
    const role = input.role === "admin" ? "admin" : "member";
    if (!canManageTenantMember(context.role, role)) throw new TenantAccessError("当前角色不能创建该成员角色", 403);
    return withPostgresTransaction(async (client) => {
        await lockAuthMutation(client);
        const repos = createPostgresRepositories(client);
        if (!(await repos.tenants.lockTenant(context.tenantId))) throw new TenantInputError("租户不存在", 404);
        const now = new Date().toISOString();
        const user = await createTenantUser(repos, input, now);
        const membership = await repos.tenants.addMembership({ tenantId: context.tenantId, userId: user.id, role, status: "active", createdByUserId: actor.id, createdAt: now, updatedAt: now });
        await repos.auditLogs.create({
            id: randomUUID(),
            action: "tenant.member.create",
            status: "success",
            actorUserId: actor.id,
            actorUsername: actor.username,
            actorRole: actor.role,
            actorTenantRole: context.role,
            targetType: "user",
            targetId: user.id,
            targetLabel: user.username,
            tenantId: context.tenantId,
            scope: "tenant",
            metadata: { role },
            createdAt: now,
        });
        return tenantMemberFrom(user, membership);
    });
}

export async function updateTenantMember(context: TenantContext, actor: TenantActor, userId: string, patch: { role?: Exclude<TenantRole, "owner">; status?: TenantMembershipStatus }): Promise<TenantMemberItem> {
    await assertTenantRuntime();
    if ((patch.role === undefined) === (patch.status === undefined)) throw new TenantInputError("一次只能修改成员角色或状态");
    return withPostgresTransaction(async (client) => {
        const repos = createPostgresRepositories(client);
        if (!(await repos.tenants.lockTenant(context.tenantId))) throw new TenantInputError("租户不存在", 404);
        const member = await repos.tenants.getMember(context.tenantId, userId, true);
        if (!member) throw new TenantInputError("成员不存在", 404);
        if (actor.id === userId) throw new TenantAccessError("不能修改自己的租户角色或状态", 403);
        if (!canManageTenantMember(context.role, member.role)) throw new TenantAccessError("当前角色不能操作该成员", 403);
        const now = new Date().toISOString();
        if (patch.role) await repos.tenants.updateMemberRole(context.tenantId, userId, patch.role, now);
        if (patch.status) {
            await repos.tenants.updateMemberStatus(context.tenantId, userId, patch.status, now);
            if (patch.status === "disabled") await repos.sessions.deleteByUserId(userId);
        }
        await repos.auditLogs.create({
            id: randomUUID(),
            action: patch.role ? "tenant.member.role" : "tenant.member.status",
            status: "success",
            actorUserId: actor.id,
            actorUsername: actor.username,
            actorRole: actor.role,
            actorTenantRole: context.role,
            targetType: "user",
            targetId: userId,
            targetLabel: member.username,
            tenantId: context.tenantId,
            scope: "tenant",
            metadata: patch.role ? { previousRole: member.role, role: patch.role } : { previousStatus: member.status, status: patch.status! },
            createdAt: now,
        });
        const updated = await repos.tenants.getMember(context.tenantId, userId);
        if (!updated) throw new TenantInputError("成员不存在", 404);
        return updated;
    });
}

export async function listTenantAuditLogs(context: TenantContext, input: { page?: number; pageSize?: number; keyword?: string }) {
    await assertTenantRuntime();
    return createPostgresRepositories().auditLogs.list({ ...input, tenantId: context.tenantId, scope: "tenant" });
}

async function assertTenantRuntime() {
    if (!isTenantMvpEnabled()) throw new TenantAccessError("租户功能未启用", 404);
    if (!isPostgresDatabaseEnabled()) throw new TenantAccessError("租户功能需要 PostgreSQL", 503);
    await ensurePostgresSchema();
}

async function createTenantUser(repos: ReturnType<typeof createPostgresRepositories>, input: NewTenantUserInput, now: string) {
    const username = normalizeUsername(input.username);
    const email = normalizeEmail(input.email);
    const displayName = normalizeDisplayName(input.displayName || username);
    validateUsername(username);
    validatePassword(input.password);
    if (email) validateEmail(email);
    if (await repos.users.findIdentityConflict({ username, email: email || undefined })) throw new TenantInputError(email ? "用户名或邮箱已存在" : "用户名已存在", 409);
    const settings = await repos.settings.getWalletSettings();
    return repos.users.createWithNextAccountId({
        id: randomUUID(),
        username,
        email: email || undefined,
        displayName,
        bio: "",
        role: "user",
        adminPermissions: [],
        status: "active",
        planId: settings.settings?.defaultPlanId || "free",
        pointsBalance: 0,
        passwordHash: await hashPassword(input.password),
        createdAt: now,
        updatedAt: now,
    });
}

function tenantMemberFrom(
    user: Awaited<ReturnType<ReturnType<typeof createPostgresRepositories>["users"]["createWithNextAccountId"]>>,
    membership: Awaited<ReturnType<ReturnType<typeof createPostgresRepositories>["tenants"]["addMembership"]>>,
): TenantMemberItem {
    return { ...membership, accountId: user.accountId, username: user.username, displayName: user.displayName, email: user.email, userStatus: user.status };
}

function normalizeTenantName(value: unknown) {
    const name = typeof value === "string" ? value.trim() : "";
    if (!name || name.length > 80) throw new TenantInputError("租户名称长度应为 1–80 个字符");
    return name;
}

function normalizeTenantSlug(value: unknown) {
    const slug = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(slug)) throw new TenantInputError("租户标识应为 3–64 位小写字母、数字或连字符");
    return slug;
}

export function isTenantServiceError(error: unknown): error is TenantInputError | TenantAccessError {
    return error instanceof TenantInputError || error instanceof TenantAccessError;
}
