import { checkRateLimit } from "@/lib/server/security";

export type TenantMutationAction = "platform-tenant-create" | "platform-tenant-rename" | "tenant-member-create" | "tenant-member-update";

const tenantMutationLimits: Readonly<Record<TenantMutationAction, Readonly<{ maxRequests: number; windowMs: number }>>> = Object.freeze({
    "platform-tenant-create": Object.freeze({ maxRequests: 60, windowMs: 60 * 60 * 1000 }),
    "platform-tenant-rename": Object.freeze({ maxRequests: 30, windowMs: 60 * 1000 }),
    "tenant-member-create": Object.freeze({ maxRequests: 30, windowMs: 60 * 60 * 1000 }),
    "tenant-member-update": Object.freeze({ maxRequests: 60, windowMs: 60 * 1000 }),
});

export function checkTenantMutationRateLimit(action: TenantMutationAction, actorIdentity: string) {
    return checkRateLimit(`tenant-mvp:${action}:${actorIdentity}`, tenantMutationLimits[action]);
}
