import type { TenantRole } from "@/lib/tenant-permissions";
import type { TenantContext } from "@/lib/tenant";
import { createPostgresRepositories, ensurePostgresSchema, isPostgresDatabaseEnabled } from "@/lib/server/database";

export class TenantAccessError extends Error {
    constructor(
        message: string,
        public readonly status: number,
    ) {
        super(message);
    }
}

export function isTenantMvpEnabled(): boolean {
    return ["1", "true", "yes", "on"].includes(process.env.VOZEB_PRO_TENANT_MVP_ENABLED?.trim().toLowerCase() || "");
}

export async function requireTenantContext(userId: string, allowedRoles: readonly TenantRole[] = ["owner", "admin", "member"]): Promise<TenantContext> {
    if (!isTenantMvpEnabled()) throw new TenantAccessError("租户功能未启用", 404);
    if (!isPostgresDatabaseEnabled()) throw new TenantAccessError("租户功能需要 PostgreSQL", 503);
    await ensurePostgresSchema();
    const context = await createPostgresRepositories().tenants.findContextByUserId(userId);
    if (!context) throw new TenantAccessError("当前账号不属于可用租户", 403);
    if (!allowedRoles.includes(context.role)) throw new TenantAccessError("当前成员没有租户管理权限", 403);
    return Object.freeze({ ...context });
}

export function isTenantAccessError(error: unknown): error is TenantAccessError {
    return error instanceof TenantAccessError;
}
