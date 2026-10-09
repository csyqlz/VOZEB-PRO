export const ADMIN_PERMISSION_GROUPS = [
    { key: "users", label: "经营与用户", description: "经营数据、用户账号与管理员职责" },
    { key: "generation", label: "生成与上游", description: "生成记录、任务运维与模型渠道" },
    { key: "billing", label: "商品与财务", description: "商品营销、订单支付与积分账务" },
    { key: "system", label: "系统与内容", description: "站点配置、内容治理与审计追踪" },
] as const;

export type AdminPermissionGroup = (typeof ADMIN_PERMISSION_GROUPS)[number]["key"];

export const ADMIN_PERMISSION_DEFINITIONS = [
    { key: "analytics.read", group: "users", label: "经营分析", description: "查看经营、生成和财务摘要。" },
    { key: "users.read", group: "users", label: "用户查看", description: "查看用户账号与公开身份信息。" },
    { key: "users.manage", group: "users", label: "用户运营", description: "创建、编辑、禁用和删除普通用户。" },
    { key: "administrators.manage", group: "users", label: "管理员治理", description: "创建管理员并分配职责权限。" },
    { key: "tenants.read", group: "users", label: "租户查看", description: "查看租户目录、成员数量与聚合用量。" },
    { key: "tenants.manage", group: "users", label: "租户运营", description: "创建租户并维护租户基础信息。" },
    { key: "generation.read", group: "generation", label: "生成记录", description: "查看生成任务、日志和媒体资产。" },
    { key: "generation.manage", group: "generation", label: "生成运维", description: "处理生成失败、人工确认和记录清理。" },
    { key: "upstream.manage", group: "generation", label: "上游配置", description: "管理模型渠道、路由、Skills 和生成参数。" },
    { key: "commerce.manage", group: "billing", label: "商品营销", description: "管理套餐商品、促销、优惠券和邀请奖励。" },
    { key: "billing.read", group: "billing", label: "财务查看", description: "查看订单、流水、支付和对账摘要。" },
    { key: "billing.manage", group: "billing", label: "财务管理", description: "处理收款、退款、积分、支付配置和对账。" },
    { key: "system.manage", group: "system", label: "系统管理", description: "管理站点、邮件、存储、备份和数据维护。" },
    { key: "content.manage", group: "system", label: "内容运营", description: "管理作品审核、举报申诉、公告和公共提示词。" },
    { key: "audit.read", group: "system", label: "审计查看", description: "只读查看管理员和安全审计记录。" },
] as const satisfies ReadonlyArray<{ key: string; group: AdminPermissionGroup; label: string; description: string }>;

export type AdminPermission = (typeof ADMIN_PERMISSION_DEFINITIONS)[number]["key"];

export const ADMIN_BILLING_TABS = ["orders", "products", "promotions", "coupons", "payments"] as const;
export type AdminBillingTab = (typeof ADMIN_BILLING_TABS)[number];

export const ALL_ADMIN_PERMISSIONS: AdminPermission[] = ADMIN_PERMISSION_DEFINITIONS.map((item) => item.key);

export const ADMIN_PERMISSION_PRESETS = [
    { key: "full", label: "全权限管理员", description: "负责账号权限和全站配置。", permissions: ALL_ADMIN_PERMISSIONS },
    { key: "finance", label: "财务", description: "订单、支付、退款、积分与对账。", permissions: ["users.read", "billing.read", "billing.manage"] },
    { key: "support", label: "客服与用户运营", description: "用户账号与生成任务排障。", permissions: ["users.read", "users.manage", "generation.read", "generation.manage"] },
    { key: "tenant", label: "租户运营", description: "查看、创建和维护租户。", permissions: ["users.read", "tenants.read", "tenants.manage", "audit.read"] },
    { key: "content", label: "内容审核", description: "作品、举报申诉、公告与提示词。", permissions: ["users.read", "content.manage"] },
    { key: "commerce", label: "商品与营销运营", description: "经营数据、商品、促销、优惠券和邀请。", permissions: ["analytics.read", "users.read", "commerce.manage"] },
    { key: "upstream", label: "上游运维", description: "模型渠道、Skills 与生成运行状态。", permissions: ["generation.read", "generation.manage", "upstream.manage"] },
    { key: "system", label: "系统运维", description: "系统设置、存储、备份和审计。", permissions: ["system.manage", "audit.read"] },
    { key: "audit", label: "只读审计", description: "只查看经营、用户、生成、财务和审计记录。", permissions: ["analytics.read", "users.read", "generation.read", "billing.read", "audit.read"] },
] as const satisfies ReadonlyArray<{ key: string; label: string; description: string; permissions: readonly AdminPermission[] }>;

const ADMIN_PERMISSION_KEYS = new Set<AdminPermission>(ALL_ADMIN_PERMISSIONS);

export function normalizeAdminPermissions(value: unknown): AdminPermission[] {
    if (!Array.isArray(value)) return [];
    const selected = new Set(value.filter((item): item is AdminPermission => typeof item === "string" && ADMIN_PERMISSION_KEYS.has(item as AdminPermission)));
    return ALL_ADMIN_PERMISSIONS.filter((permission) => selected.has(permission));
}

export function hasAdminPermission(user: { role?: unknown; status?: unknown; adminPermissions?: unknown } | null | undefined, permission: AdminPermission) {
    return user?.role === "admin" && user.status === "active" && normalizeAdminPermissions(user.adminPermissions).includes(permission);
}

export function hasAnyAdminPermission(user: { role?: unknown; status?: unknown; adminPermissions?: unknown } | null | undefined, permissions: readonly AdminPermission[] = ALL_ADMIN_PERMISSIONS) {
    return permissions.some((permission) => hasAdminPermission(user, permission));
}

export function hasAllAdminPermissions(user: { role?: unknown; status?: unknown; adminPermissions?: unknown } | null | undefined, permissions: readonly AdminPermission[]) {
    return permissions.every((permission) => hasAdminPermission(user, permission));
}

export function isFullAdminPermissions(value: unknown) {
    const permissions = normalizeAdminPermissions(value);
    return permissions.length === ALL_ADMIN_PERMISSIONS.length;
}

export function adminPermissionSummary(value: unknown) {
    const permissions = normalizeAdminPermissions(value);
    const preset = ADMIN_PERMISSION_PRESETS.find((item) => item.permissions.length === permissions.length && item.permissions.every((permission) => permissions.includes(permission)));
    return preset?.label || `${permissions.length} 项职责`;
}

const ADMIN_BILLING_TAB_PERMISSIONS: Record<AdminBillingTab, readonly AdminPermission[]> = {
    orders: ["billing.read", "billing.manage"],
    products: ["commerce.manage"],
    promotions: ["commerce.manage"],
    coupons: ["commerce.manage"],
    payments: ["billing.manage"],
};

export function allowedAdminBillingTabs(user: { role?: unknown; status?: unknown; adminPermissions?: unknown } | null | undefined) {
    return ADMIN_BILLING_TABS.filter((tab) => hasAnyAdminPermission(user, ADMIN_BILLING_TAB_PERMISSIONS[tab]));
}

export function resolveAdminBillingTab(user: { role?: unknown; status?: unknown; adminPermissions?: unknown } | null | undefined, requested: AdminBillingTab) {
    const allowed = allowedAdminBillingTabs(user);
    return allowed.includes(requested) ? requested : allowed[0];
}
