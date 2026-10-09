import { createPostgresRepositories, ensurePostgresSchema, withPostgresTransaction, type JsonValue } from "@/lib/server/database";
import type { AppSettingsRecord } from "@/lib/server/database/repository-types";

import { AuthInputError } from "./store-foundation";
import { encryptAuthSettingsSecrets, normalizeSettings } from "./store-normalizers";
import { readPostgresAuthSettings } from "./store-repository";
import type { AuthSettings } from "./store-types";

export async function updatePostgresAuthSettings(patch: Partial<AuthSettings>) {
    await ensurePostgresSchema();
    return withPostgresTransaction(async (client) => {
        const settingsRepository = createPostgresRepositories(client).settings;
        await settingsRepository.lock();
        const settings = normalizeSettings({ ...(await readPostgresAuthSettings(client)), ...patch });
        const encrypted = encryptAuthSettingsSecrets(settings);

        if (patch.entitlements !== undefined) {
            const retainedPlans = await settingsRepository.removeEntitlementPlansNotIn(settings.entitlements.plans.map((plan) => plan.id));
            if (retainedPlans.length) throw new AuthInputError(`套餐仍被用户或订单引用，无法删除：${retainedPlans.join("、")}`);
            for (const [sortOrder, plan] of settings.entitlements.plans.entries()) {
                await settingsRepository.upsertEntitlementPlan({
                    id: plan.id,
                    name: plan.name,
                    enabled: plan.enabled,
                    dailyPoints: plan.dailyPoints,
                    limits: asJson(plan.limits),
                    features: asJson(plan.features),
                    sortOrder,
                });
            }
        }

        const settingsPatch = postgresSettingsPatch(patch, encrypted);
        if (Object.keys(settingsPatch).length) await settingsRepository.updateSettings(settingsPatch);

        if (patch.systemChannels !== undefined) {
            for (const [sortOrder, channel] of encrypted.systemChannels.entries()) {
                await settingsRepository.upsertSystemModelChannel({
                    id: channel.id,
                    name: channel.name,
                    baseUrl: channel.baseUrl,
                    apiKeyCiphertext: channel.apiKey,
                    webhookSecretCiphertext: channel.webhookSecret || "",
                    apiFormat: channel.apiFormat,
                    models: asJson(channel.models),
                    enabled: channel.enabled,
                    advancedConfig: channel.advancedConfig ? asJson(channel.advancedConfig) : undefined,
                    sortOrder,
                });
            }
            await settingsRepository.deleteSystemModelChannelsNotIn(encrypted.systemChannels.map((channel) => channel.id));
        }
        return settings;
    });
}

function postgresSettingsPatch(patch: Partial<AuthSettings>, settings: AuthSettings) {
    const result: Partial<Omit<AppSettingsRecord, "id" | "createdAt" | "updatedAt">> = {};
    if (patch.site !== undefined) result.site = asJson(settings.site);
    if (patch.registrationEnabled !== undefined) result.registrationEnabled = settings.registrationEnabled;
    if (patch.emailRegistrationEnabled !== undefined) result.emailRegistrationEnabled = settings.emailRegistrationEnabled;
    if (patch.freeDailyPointsEnabled !== undefined) result.freeDailyPointsEnabled = settings.freeDailyPointsEnabled;
    if (patch.freeDailyPoints !== undefined) result.freeDailyPoints = settings.freeDailyPoints;
    if (patch.mail !== undefined) result.mail = asJson(settings.mail);
    if (patch.allowUserApiConfig !== undefined) result.allowUserApiConfig = settings.allowUserApiConfig;
    if (patch.modelPointCosts !== undefined) result.modelPointCosts = asJson(settings.modelPointCosts);
    if (patch.generationPointMultipliers !== undefined) result.generationPointMultipliers = asJson(settings.generationPointMultipliers);
    if (patch.generationCostControl !== undefined) result.generationCostControl = asJson(settings.generationCostControl);
    if (patch.dataLifecycle !== undefined) result.dataLifecycle = asJson(settings.dataLifecycle);
    if (patch.entitlements !== undefined) {
        result.entitlementsEnabled = settings.entitlements.enabled;
        result.defaultPlanId = settings.entitlements.defaultPlanId;
    }
    if (patch.generationConcurrency !== undefined) result.generationConcurrency = asJson(settings.generationConcurrency);
    if (patch.generationDefaults !== undefined) result.generationDefaults = asJson(settings.generationDefaults);
    if (patch.logicalModels !== undefined) result.logicalModels = asJson(settings.logicalModels);
    if (patch.defaultModels !== undefined) result.defaultModels = asJson(settings.defaultModels);
    if (patch.ecommerceGenerationEnabled !== undefined) result.ecommerceGenerationEnabled = settings.ecommerceGenerationEnabled;
    if (patch.ecommerceVisualQualityCheckEnabled !== undefined) result.ecommerceVisualQualityCheckEnabled = settings.ecommerceVisualQualityCheckEnabled;
    if (patch.ecommerceModelRoles !== undefined) result.ecommerceModelRoles = asJson(settings.ecommerceModelRoles);
    if (patch.agentSkills !== undefined) result.agentSkills = asJson(settings.agentSkills);
    return result;
}

function asJson(value: unknown) {
    return value as JsonValue;
}
