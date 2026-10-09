export type TenantRole = "owner" | "admin" | "member";

export function isTenantManager(role: TenantRole): boolean {
    return role === "owner" || role === "admin";
}

export function canAccessTenantConsole(role: TenantRole): boolean {
    return isTenantManager(role);
}

export function canManageTenantMember(actorRole: TenantRole, targetRole: TenantRole): boolean {
    if (actorRole === "owner") return targetRole !== "owner";
    return actorRole === "admin" && targetRole === "member";
}
