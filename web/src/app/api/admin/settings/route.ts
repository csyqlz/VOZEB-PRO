import { NextResponse } from "next/server";

import { AuthInputError, getFreshAuthSettings, isAuthInputError, setAuthSettings, type AuthSettings, type SiteSocialKey, type SiteSocialSettings } from "@/lib/auth/store";
import { normalizeSiteSocial } from "@/lib/auth/store-normalizers";
import { modelRoutingValidationErrors, normalizeDefaultModelsConfig, synchronizeLogicalModelsWithChannels } from "@/lib/model-routing-config";
import { readJsonBody } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { mergeSystemChannelSecrets, serializeAdminSettingsForUser, systemChannelWebhookSecretValidationError } from "@/lib/server/admin-channel-config";
import { auditActorFromRequest, safeRecordAuditLog } from "@/lib/server/audit-log-store";
import { invalidatePublicSiteSettings } from "@/lib/server/site-metadata";
import { channelProtocolValidationErrors } from "@/lib/channel-protocol-registry";
import { hasAllAdminPermissions, hasAnyAdminPermission, type AdminPermission } from "@/lib/admin-permissions";
import { ecommerceModelRoleValidationErrors, normalizeEcommerceModelRoles } from "@/lib/ecommerce-model-role-config";

export const runtime = "nodejs";

export async function GET() {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    if (!hasAnyAdminPermission(currentUser)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });

    return NextResponse.json({ settings: serializeAdminSettingsForUser(await getFreshAuthSettings(), currentUser) });
}

export async function PATCH(request: Request) {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    if (!hasAnyAdminPermission(currentUser)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });

    try {
        const body = await readJsonBody<Partial<AuthSettings>>(request);
        const requiredPermissions = settingsPermissionsForPatch(body);
        if (!hasAllAdminPermissions(currentUser, requiredPermissions)) return NextResponse.json({ error: "当前管理员没有修改这些设置的职责权限" }, { status: 403 });
        const socialValidationError = siteSocialValidationError(body.site?.socials);
        if (socialValidationError) throw new AuthInputError(socialValidationError);
        const currentSettings = await getFreshAuthSettings();
        const patch: Partial<AuthSettings> = {};
        if (body.site) patch.site = body.site;
        if (typeof body.registrationEnabled === "boolean") patch.registrationEnabled = body.registrationEnabled;
        if (typeof body.emailRegistrationEnabled === "boolean") patch.emailRegistrationEnabled = body.emailRegistrationEnabled;
        if (typeof body.freeDailyPointsEnabled === "boolean") patch.freeDailyPointsEnabled = body.freeDailyPointsEnabled;
        if (typeof body.freeDailyPoints === "number") patch.freeDailyPoints = body.freeDailyPoints;
        if (body.mail) patch.mail = body.mail;
        if (body.modelPointCosts && typeof body.modelPointCosts === "object") patch.modelPointCosts = body.modelPointCosts;
        if (body.generationPointMultipliers && typeof body.generationPointMultipliers === "object") patch.generationPointMultipliers = body.generationPointMultipliers;
        if (body.generationCostControl && typeof body.generationCostControl === "object") patch.generationCostControl = body.generationCostControl;
        if (body.dataLifecycle && typeof body.dataLifecycle === "object") patch.dataLifecycle = body.dataLifecycle;
        if (body.entitlements && typeof body.entitlements === "object") patch.entitlements = body.entitlements;
        if (body.generationConcurrency && typeof body.generationConcurrency === "object") patch.generationConcurrency = body.generationConcurrency;
        if (body.generationDefaults && typeof body.generationDefaults === "object") patch.generationDefaults = body.generationDefaults;
        if (typeof body.ecommerceGenerationEnabled === "boolean") patch.ecommerceGenerationEnabled = body.ecommerceGenerationEnabled;
        if (typeof body.ecommerceVisualQualityCheckEnabled === "boolean") patch.ecommerceVisualQualityCheckEnabled = body.ecommerceVisualQualityCheckEnabled;
        if (Array.isArray(body.systemChannels)) {
            patch.systemChannels = mergeSystemChannelSecrets(body.systemChannels, currentSettings.systemChannels);
            const webhookSecretError = patch.systemChannels.map(systemChannelWebhookSecretValidationError).find(Boolean);
            if (webhookSecretError) throw new AuthInputError(webhookSecretError);
        }
        if (Array.isArray(body.systemChannels) || Array.isArray(body.logicalModels) || body.defaultModels) {
            const channels = patch.systemChannels || currentSettings.systemChannels;
            const protocolErrors = channels.flatMap(channelProtocolValidationErrors);
            if (protocolErrors.length) throw new AuthInputError(protocolErrors[0]);
            const sourceLogicalModels = Array.isArray(body.logicalModels) ? body.logicalModels : currentSettings.logicalModels;
            const logicalModels = synchronizeLogicalModelsWithChannels(sourceLogicalModels, channels);
            const defaultModels = { ...currentSettings.defaultModels, ...body.defaultModels };
            const normalizedDefaults = normalizeDefaultModelsConfig(defaultModels, logicalModels, channels);
            const errors = modelRoutingValidationErrors(logicalModels, channels, normalizedDefaults);
            if (errors.length) throw new AuthInputError(errors[0]);
            patch.logicalModels = logicalModels;
            patch.defaultModels = normalizedDefaults;
        }
        if (body.ecommerceModelRoles && typeof body.ecommerceModelRoles === "object") {
            const logicalModels = patch.logicalModels || currentSettings.logicalModels;
            const errors = ecommerceModelRoleValidationErrors(body.ecommerceModelRoles, logicalModels);
            if (errors.length) throw new AuthInputError(errors[0]);
            patch.ecommerceModelRoles = normalizeEcommerceModelRoles(body.ecommerceModelRoles, logicalModels);
        }
        if (Array.isArray(body.agentSkills)) patch.agentSkills = body.agentSkills;
        if (!Object.keys(patch).length) return NextResponse.json({ error: "没有可更新的设置" }, { status: 400 });

        const settings = await setAuthSettings(patch);
        if (patch.site) invalidatePublicSiteSettings();
        await safeRecordAuditLog({
            action: "admin.settings.update",
            actor: auditActorFromRequest(request, currentUser),
            target: { type: "settings", id: "auth" },
            metadata: { fields: Object.keys(patch) },
        });
        return NextResponse.json({ settings: serializeAdminSettingsForUser(settings, currentUser) });
    } catch (error) {
        await safeRecordAuditLog({
            action: "admin.settings.update",
            status: "failure",
            actor: auditActorFromRequest(request, currentUser),
            target: { type: "settings", id: "auth" },
            metadata: { error: error instanceof Error ? error.message : "unknown" },
        });
        if (isAuthInputError(error)) return NextResponse.json({ error: error.message }, { status: error.status });
        console.error("Admin settings update failed", error);
        return NextResponse.json({ error: "更新设置失败" }, { status: 500 });
    }
}

const SETTINGS_PERMISSION_BY_FIELD = {
    site: "system.manage",
    registrationEnabled: "system.manage",
    emailRegistrationEnabled: "system.manage",
    mail: "system.manage",
    dataLifecycle: "system.manage",
    freeDailyPointsEnabled: "billing.manage",
    freeDailyPoints: "billing.manage",
    modelPointCosts: "billing.manage",
    generationPointMultipliers: "billing.manage",
    entitlements: "billing.manage",
    generationCostControl: "upstream.manage",
    generationConcurrency: "upstream.manage",
    generationDefaults: "upstream.manage",
    systemChannels: "upstream.manage",
    logicalModels: "upstream.manage",
    defaultModels: "upstream.manage",
    ecommerceGenerationEnabled: "upstream.manage",
    ecommerceVisualQualityCheckEnabled: "upstream.manage",
    ecommerceModelRoles: "upstream.manage",
    agentSkills: "upstream.manage",
} as const satisfies Partial<Record<keyof AuthSettings, AdminPermission>>;

function settingsPermissionsForPatch(patch: Partial<AuthSettings>) {
    const permissions: AdminPermission[] = [];
    for (const key of Object.keys(patch)) {
        const permission = SETTINGS_PERMISSION_BY_FIELD[key as keyof typeof SETTINGS_PERMISSION_BY_FIELD];
        if (permission && !permissions.includes(permission)) permissions.push(permission);
    }
    return permissions;
}

function siteSocialValidationError(socials: Partial<SiteSocialSettings> | undefined) {
    if (!socials) return "";
    const labels: Record<SiteSocialKey, string> = { email: "邮箱", telegram: "Telegram", x: "X", instagram: "Instagram" };
    for (const key of Object.keys(labels) as SiteSocialKey[]) {
        const social = socials[key];
        if (typeof social?.url !== "string" || !social.url.trim()) continue;
        if (!normalizeSiteSocial(key, social).url) return `${labels[key]} 地址无效，请填写完整链接或 @用户名`;
    }
    return "";
}
