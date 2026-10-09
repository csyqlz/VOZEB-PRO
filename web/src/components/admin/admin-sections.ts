import { hasAnyAdminPermission, type AdminPermission } from "@/lib/admin-permissions";

export const ADMIN_SECTION_KEYS = [
    "overview",
    "site",
    "channels",
    "skills",
    "settings",
    "accountDeletion",
    "mediaStorage",
    "externalStorage",
    "backup",
    "points",
    "wallet",
    "orders",
    "products",
    "promotions",
    "coupons",
    "referrals",
    "payments",
    "updates",
    "cdk",
    "announcements",
    "works",
    "users",
    "tenants",
    "logs",
    "generationOperations",
    "prompts",
    "adminHelp",
] as const;

export type AdminSectionKey = (typeof ADMIN_SECTION_KEYS)[number];

export const ADMIN_SECTION_PERMISSIONS: Record<AdminSectionKey, readonly AdminPermission[]> = {
    overview: ["analytics.read"],
    users: ["users.read"],
    tenants: ["tenants.read", "tenants.manage"],
    logs: ["generation.read"],
    generationOperations: ["generation.manage"],
    products: ["commerce.manage"],
    promotions: ["commerce.manage"],
    coupons: ["commerce.manage"],
    referrals: ["commerce.manage"],
    orders: ["billing.read", "billing.manage"],
    points: ["billing.manage"],
    payments: ["billing.manage"],
    cdk: ["billing.manage"],
    wallet: ["billing.read", "billing.manage"],
    channels: ["upstream.manage"],
    skills: ["upstream.manage"],
    site: ["system.manage"],
    settings: ["system.manage", "upstream.manage"],
    accountDeletion: ["system.manage"],
    mediaStorage: ["system.manage"],
    externalStorage: ["system.manage"],
    backup: ["system.manage"],
    announcements: ["content.manage"],
    works: ["content.manage"],
    prompts: ["content.manage"],
    updates: [],
    adminHelp: [],
};

const adminSectionKeys = new Set<AdminSectionKey>(ADMIN_SECTION_KEYS);

export function parseAdminSection(value: string | string[] | undefined): AdminSectionKey {
    const section = Array.isArray(value) ? value[0] : value;
    return adminSectionKeys.has(section as AdminSectionKey) ? (section as AdminSectionKey) : "overview";
}

export function adminSectionHref(section: AdminSectionKey, currentHref = "/admin") {
    const url = new URL(currentHref, "http://localhost");
    if (section === "overview") url.searchParams.delete("section");
    else url.searchParams.set("section", section);
    return `${url.pathname}${url.search}${url.hash}`;
}

export function canAccessAdminSection(user: { role?: unknown; status?: unknown; adminPermissions?: unknown }, section: AdminSectionKey) {
    const permissions = ADMIN_SECTION_PERMISSIONS[section];
    return hasAnyAdminPermission(user, permissions.length ? permissions : undefined);
}

export function allowedAdminSections(user: { role?: unknown; status?: unknown; adminPermissions?: unknown }) {
    return ADMIN_SECTION_KEYS.filter((section) => canAccessAdminSection(user, section));
}

export function resolveAdminSection(user: { role?: unknown; status?: unknown; adminPermissions?: unknown }, requested: AdminSectionKey) {
    if (canAccessAdminSection(user, requested)) return requested;
    return allowedAdminSections(user)[0];
}
