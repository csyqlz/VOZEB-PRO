import { createPostgresRepositories, ensurePostgresSchema, isPostgresDatabaseEnabled, postgresQuery, type QueryExecutor } from "@/lib/server/database";
import { formatAccountId } from "@/lib/account-id";
import { normalizeRegistrationPolicyConsent } from "@/lib/registration-consent";
import { normalizeAdminPermissions } from "@/lib/admin-permissions";
import { readJsonDataFile, writeJsonDataFile } from "@/lib/server/data-adapter";
import { decryptSecretValue, encryptSecretValue } from "@/lib/server/secret-crypto";
import {
    type UserRole,
    type UserStatus,
    type ApiCallFormat,
    type SystemChannelProtocol,
    type SystemChannelAdvancedConfig,
    type LegacyUserQuota,
    type ModelPointCosts,
    type PointUsageKind,
    type SystemModelChannel,
    type LogicalModelCapability,
    type LogicalModelCapabilityProfile,
    type LogicalModelBinding,
    type LogicalModel,
    type SystemDefaultModels,
    type AgentSkill,
    type GenerationConcurrencySettings,
    type GenerationDefaultSettings,
    type GenerationPointMultipliers,
    type EntitlementPlanLimits,
    type EntitlementPlan,
    type EntitlementSettings,
    type CdkStatus,
    type PublicCdkRedemption,
    type PublicCdkCode,
    type CreatedCdkCode,
    type StoredCdkRedemption,
    type StoredCdkCode,
    type PublicAnnouncement,
    type AnnouncementPage,
    type SiteSettings,
    type SiteFriendLink,
    type SiteSocialKey,
    type SiteSocialSettings,
    DEFAULT_SITE_SOCIALS,
    DEFAULT_SITE_FRIEND_LINKS,
    type MailSettings,
    type PublicUser,
    type StoredUser,
    type StoredSession,
    type PublicPointRecord,
    type StoredPointRecord,
    type StoredDailyPlanPointWallet,
    type StoredQuotaUsage,
    type EmailCodePurpose,
    type StoredEmailCode,
    type AuthSettings,
    type AuthDatabase,
} from "./store-types";
import {
    AuthInputError,
    EmailCodeAttemptError,
    QuotaExceededError,
    isAuthInputError,
    isQuotaExceededError,
    SESSION_MAX_AGE_SECONDS,
    EMAIL_CODE_MAX_AGE_MS,
    EMAIL_CODE_RESEND_COOLDOWN_MS,
    DEFAULT_USER_POINTS,
    DEFAULT_MODEL_POINT_COST_KEY,
    DEFAULT_SITE_SETTINGS,
    DEFAULT_MAIL_SETTINGS,
    DEFAULT_GENERATION_POINT_MULTIPLIERS,
    DEFAULT_ENTITLEMENT_LIMITS,
    DEFAULT_ENTITLEMENT_PLAN_ID,
    DEFAULT_ENTITLEMENT_SETTINGS,
    DEFAULT_SETTINGS,
    AUTH_DATA_FILE,
    USERNAME_PATTERN,
} from "./store-foundation";
import {
    normalizeDb,
    emptyDb,
    encryptAuthDbSecretsForStorage,
    decryptAuthSettingsSecrets,
    encryptAuthSettingsSecrets,
    resolveDefaultPlan,
    resolveUserPlan,
    resolvePlanById,
    assertEntitlementUsageAllowed,
    recordQuotaUsage,
    findQuotaUsage,
    assertDailyLimit,
    resolveDailyUsageLimit,
    dailyUsageLimitLabel,
    countActiveAdmins,
    normalizeUsername,
    normalizeEmail,
    normalizeDisplayName,
    normalizeSettings,
    normalizeLogicalModels,
    deriveLogicalModels,
    normalizeAgentSkill,
    normalizeAgentSkills,
    normalizeGenerationDefaults,
    allowedText,
    normalizeEntitlementSettings,
    normalizeEntitlementPlan,
    normalizeEntitlementLimits,
    normalizePlanId,
    normalizeFeatureList,
    normalizeGenerationConcurrency,
    normalizeSiteSettings,
    normalizeSiteFriendLinks,
    normalizeSiteSocials,
    normalizeSiteSocial,
    normalizeMailSettings,
    normalizeSecretText,
    normalizeText,
    repairKnownMojibakeText,
    repairUtf8MojibakeText,
    looksLikeUtf8Mojibake,
    textQualityScore,
    normalizeLogoUrl,
    normalizeLinkUrl,
    normalizeSystemChannel,
    normalizeSystemChannelAdvancedConfig,
    normalizeApiPath,
    textOrEmpty,
    normalizePoints,
    normalizePointAmount,
    normalizePointMultiplier,
    normalizeModelPointCosts,
    normalizeGenerationPointMultipliers,
    normalizeMultiplierMap,
    resolveModelPointCost,
    buildPointRecordDescription,
    legacyQuotaToPoints,
    normalizeQuotaUsage,
    toPublicCdkCode,
    isCdkCodeExpired,
    normalizeCdkCodeRecord,
    normalizeCdkCode,
    generateCdkPlainCode,
    formatCdkCodeForDisplay,
    previewCdkCode,
    normalizeAnnouncement,
    isAnnouncementVisible,
    normalizeOptionalIsoDate,
    resolveCdkExpiresAt,
    normalizePointRecord,
    addPointRecord,
    normalizeEmailCode,
    consumeEmailCode,
    validateUsername,
    validateEmail,
    validatePassword,
    parseSessionCookie,
    hashToken,
    randomNumericCode,
} from "./store-normalizers";

export let mutationQueue = Promise.resolve();

export async function readAuthDb(): Promise<AuthDatabase> {
    if (isPostgresDatabaseEnabled()) throw new Error("PostgreSQL auth reads must use entity repositories");
    return normalizeDb(await readJsonDataFile<Partial<AuthDatabase>>(AUTH_DATA_FILE, emptyDb()));
}

export async function mutateAuthDb<T>(mutator: (db: AuthDatabase) => T | Promise<T>) {
    if (isPostgresDatabaseEnabled()) throw new Error("PostgreSQL auth mutations must use entity repositories");
    const run = mutationQueue.then(async () => {
        const db = await readAuthDb();
        try {
            const result = await mutator(db);
            await writeAuthDb(db);
            return result;
        } catch (error) {
            if (error instanceof EmailCodeAttemptError) await writeAuthDb(db);
            throw error;
        }
    });
    mutationQueue = run.then(
        () => undefined,
        () => undefined,
    );
    return run;
}

export async function writeAuthDb(db: AuthDatabase) {
    if (isPostgresDatabaseEnabled()) throw new Error("Full PostgreSQL auth writes are reserved for explicit backup restore");
    await writeJsonDataFile(AUTH_DATA_FILE, encryptAuthDbSecretsForStorage(db));
}

/** Full authentication snapshot for the explicit administrator backup transaction only. */
export async function readPostgresAuthDb(executor: QueryExecutor): Promise<AuthDatabase> {
    const query: QueryExecutor["query"] = executor.query.bind(executor);
    const [settingsResult, planResult, channelResult, userResult, sessionResult, quotaResult, pointRecordResult, dailyWalletResult, emailCodeResult, cdkResult, cdkRedemptionResult, announcementResult] = await Promise.all([
        query("SELECT * FROM app_settings WHERE id = 'default'"),
        query("SELECT * FROM entitlement_plans ORDER BY sort_order ASC, created_at ASC"),
        query("SELECT * FROM system_model_channels ORDER BY sort_order ASC, created_at ASC"),
        query("SELECT * FROM users ORDER BY created_at ASC"),
        query("SELECT * FROM sessions ORDER BY created_at ASC"),
        query("SELECT * FROM quota_usage ORDER BY date ASC"),
        query("SELECT * FROM point_records ORDER BY created_at ASC"),
        query("SELECT * FROM daily_plan_point_wallets ORDER BY date ASC"),
        query("SELECT * FROM email_codes ORDER BY created_at ASC"),
        query("SELECT * FROM cdk_codes ORDER BY created_at ASC"),
        query("SELECT * FROM cdk_redemptions ORDER BY redeemed_at ASC"),
        query("SELECT * FROM announcements ORDER BY created_at DESC"),
    ]);
    const redemptionsByCodeId = new Map<string, StoredCdkRedemption[]>();
    for (const row of cdkRedemptionResult.rows) {
        const cdkCodeId = dbText(row.cdk_code_id);
        const list = redemptionsByCodeId.get(cdkCodeId) || [];
        list.push({ userId: dbText(row.user_id), redeemedAt: dbIso(row.redeemed_at) });
        redemptionsByCodeId.set(cdkCodeId, list);
    }

    return normalizeDb({
        version: 1,
        users: userResult.rows.map(mapPostgresUser),
        sessions: sessionResult.rows.map(mapPostgresSession),
        quotaUsage: quotaResult.rows.map(mapPostgresQuotaUsage),
        pointRecords: pointRecordResult.rows.map(mapPostgresPointRecord),
        dailyPlanPointWallets: dailyWalletResult.rows.map(mapPostgresDailyPlanPointWallet),
        emailCodes: emailCodeResult.rows.map(mapPostgresEmailCode),
        cdkCodes: cdkResult.rows.map((row) => mapPostgresCdkCode(row, redemptionsByCodeId.get(dbText(row.id)) || [])),
        announcements: announcementResult.rows.map(mapPostgresAnnouncement),
        settings: mapPostgresSettings(settingsResult.rows[0], planResult.rows, channelResult.rows),
    });
}

export async function readPostgresCdkListData(input?: { page?: number; pageSize?: number; keyword?: string; codeHash?: string; filter?: "all" | "redeemed" | "unused" | "expired" }, executor?: QueryExecutor) {
    if (!executor) await ensurePostgresSchema();
    const result = await createPostgresRepositories(executor || { query: postgresQuery }).cdk.list(input);
    const cdkCodes = result.items.map(
        (item) =>
            ({
                id: item.id,
                codeHash: item.codeHash,
                code: decryptSecretValue(item.codeCiphertext) || undefined,
                codePreview: item.codePreview,
                points: item.points,
                maxRedemptions: item.maxRedemptions,
                redeemedCount: item.redeemedCount,
                status: item.status,
                note: item.note,
                expiresAt: item.expiresAt,
                redemptions: item.redemptions.map((redemption) => ({ userId: redemption.userId, redeemedAt: redemption.redeemedAt })),
                createdAt: item.createdAt,
                updatedAt: item.updatedAt,
            }) satisfies StoredCdkCode,
    );
    const usersById = new Map<string, { id: string; accountId?: string; username: string; displayName: string }>();
    for (const item of result.items) {
        for (const redemption of item.redemptions) {
            const username = redemption.username || "已删除用户";
            usersById.set(redemption.userId, { id: redemption.userId, accountId: redemption.accountId, username, displayName: redemption.displayName || username });
        }
    }
    return {
        cdkCodes,
        users: [...usersById.values()],
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        stats: result.stats,
    };
}

export async function readPostgresAnnouncementsPage(input: { includeDisabled: boolean; page: number; pageSize: number; visibleAt?: string }, executor?: QueryExecutor): Promise<AnnouncementPage> {
    if (!executor) await ensurePostgresSchema();
    const query: QueryExecutor["query"] = executor ? executor.query.bind(executor) : postgresQuery;
    const page = Number.isSafeInteger(input.page) && input.page > 0 ? input.page : 1;
    const pageSize = Number.isSafeInteger(input.pageSize) && input.pageSize > 0 ? Math.min(100, input.pageSize) : 20;
    const visibleAt = input.visibleAt || new Date().toISOString();
    const result = await query(
        `SELECT *, count(*) OVER() AS total_count
         FROM announcements
         WHERE ($1::boolean = true OR (
             enabled = true
             AND (starts_at IS NULL OR starts_at <= $2::timestamptz)
             AND (ends_at IS NULL OR ends_at > $2::timestamptz)
         ))
         ORDER BY created_at DESC, id DESC
         LIMIT $3 OFFSET $4`,
        [input.includeDisabled, visibleAt, pageSize, (page - 1) * pageSize],
    );
    return {
        items: result.rows.map(mapPostgresAnnouncement),
        total: dbNumber(result.rows[0]?.total_count, 0),
        page,
        pageSize,
    };
}

export async function readPostgresAnnouncements(executor?: QueryExecutor) {
    return (await readPostgresAnnouncementsPage({ includeDisabled: true, page: 1, pageSize: 100 }, executor)).items;
}

export async function readPostgresAuthSettings(executor?: QueryExecutor): Promise<AuthSettings> {
    if (!executor) await ensurePostgresSchema();
    const query: QueryExecutor["query"] = executor ? executor.query.bind(executor) : postgresQuery;
    const [settingsResult, planResult, channelResult] = await Promise.all([
        query("SELECT * FROM app_settings WHERE id = 'default'"),
        query("SELECT * FROM entitlement_plans ORDER BY sort_order ASC, created_at ASC"),
        query("SELECT * FROM system_model_channels ORDER BY sort_order ASC, created_at ASC"),
    ]);
    return decryptAuthSettingsSecrets(mapPostgresSettings(settingsResult.rows[0], planResult.rows, channelResult.rows));
}

export function mapPostgresSettings(settingsRow: Record<string, unknown> | undefined, planRows: Record<string, unknown>[], channelRows: Record<string, unknown>[]): AuthSettings {
    const fallback = DEFAULT_SETTINGS;
    return normalizeSettings({
        site: normalizeSiteSettings(dbJson(settingsRow?.site, fallback.site)),
        registrationEnabled: dbBool(settingsRow?.registration_enabled, fallback.registrationEnabled),
        emailRegistrationEnabled: dbBool(settingsRow?.email_registration_enabled, fallback.emailRegistrationEnabled),
        freeDailyPointsEnabled: dbBool(settingsRow?.free_daily_points_enabled, fallback.freeDailyPointsEnabled),
        freeDailyPoints: dbNumber(settingsRow?.free_daily_points, fallback.freeDailyPoints),
        mail: dbJson(settingsRow?.mail, fallback.mail),
        allowUserApiConfig: dbBool(settingsRow?.allow_user_api_config, fallback.allowUserApiConfig),
        modelPointCosts: dbJson(settingsRow?.model_point_costs, fallback.modelPointCosts),
        generationPointMultipliers: dbJson(settingsRow?.generation_point_multipliers, fallback.generationPointMultipliers),
        generationCostControl: dbJson(settingsRow?.generation_cost_control, fallback.generationCostControl),
        dataLifecycle: dbJson(settingsRow?.data_lifecycle, fallback.dataLifecycle),
        entitlements: {
            enabled: dbBool(settingsRow?.entitlements_enabled, fallback.entitlements.enabled),
            defaultPlanId: dbText(settingsRow?.default_plan_id) || fallback.entitlements.defaultPlanId,
            plans: planRows.length
                ? planRows.map((row) => ({
                      id: dbText(row.id),
                      name: dbText(row.name),
                      enabled: dbBool(row.enabled, true),
                      dailyPoints: dbNumber(row.daily_points, 0),
                      limits: dbJson(row.limits, DEFAULT_ENTITLEMENT_LIMITS),
                      features: dbJson(row.features, []),
                  }))
                : fallback.entitlements.plans,
        },
        generationConcurrency: dbJson(settingsRow?.generation_concurrency, fallback.generationConcurrency),
        generationDefaults: normalizeGenerationDefaults(dbJson(settingsRow?.generation_defaults, fallback.generationDefaults)),
        systemChannels: channelRows.map((row) => ({
            id: dbText(row.id),
            name: dbText(row.name),
            baseUrl: dbText(row.base_url),
            apiKey: dbText(row.api_key_ciphertext),
            webhookSecret: dbText(row.webhook_secret_ciphertext),
            apiFormat: row.api_format === "gemini" ? "gemini" : "openai",
            models: dbJson(row.models, []),
            enabled: dbBool(row.enabled, true),
            advancedConfig: dbJson(row.advanced_config, undefined),
        })),
        logicalModels: dbJson(settingsRow?.logical_models, fallback.logicalModels),
        defaultModels: dbJson(settingsRow?.default_models, fallback.defaultModels),
        ecommerceGenerationEnabled: dbBool(settingsRow?.ecommerce_generation_enabled, fallback.ecommerceGenerationEnabled),
        ecommerceVisualQualityCheckEnabled: dbBool(settingsRow?.ecommerce_visual_quality_check_enabled, fallback.ecommerceVisualQualityCheckEnabled),
        ecommerceModelRoles: dbJson(settingsRow?.ecommerce_model_roles, fallback.ecommerceModelRoles),
        agentSkills: dbJson(settingsRow?.agent_skills, fallback.agentSkills),
    });
}

export function mapPostgresUser(row: Record<string, unknown>): StoredUser {
    return {
        id: dbText(row.id),
        accountId: formatAccountId(row.account_id),
        username: dbText(row.username),
        email: dbOptionalText(row.email),
        displayName: dbText(row.display_name),
        bio: dbText(row.bio),
        avatarStorageKey: dbOptionalText(row.avatar_storage_key),
        role: row.role === "admin" ? "admin" : "user",
        adminPermissions: row.role === "admin" ? normalizeAdminPermissions(dbJson(row.admin_permissions, [])) : [],
        status: row.status === "disabled" ? "disabled" : "active",
        planId: dbText(row.plan_id),
        pointsBalance: dbNumber(row.points_balance, DEFAULT_USER_POINTS),
        passwordHash: dbText(row.password_hash),
        mfaSecretCiphertext: dbOptionalText(row.mfa_secret_ciphertext),
        mfaEnabledAt: dbOptionalIso(row.mfa_enabled_at),
        registrationConsent: normalizeRegistrationPolicyConsent({
            termsVersion: row.terms_version,
            termsUrl: row.terms_url,
            privacyVersion: row.privacy_version,
            privacyUrl: row.privacy_url,
            acceptedAt: row.policy_accepted_at,
        }),
        createdAt: dbIso(row.created_at),
        updatedAt: dbIso(row.updated_at),
        lastLoginAt: dbOptionalIso(row.last_login_at),
    };
}

export function mapPostgresSession(row: Record<string, unknown>): StoredSession {
    return {
        id: dbText(row.id),
        userId: dbText(row.user_id),
        tokenHash: dbText(row.token_hash),
        createdAt: dbIso(row.created_at),
        expiresAt: dbIso(row.expires_at),
    };
}

export function mapPostgresQuotaUsage(row: Record<string, unknown>): StoredQuotaUsage {
    return {
        userId: dbText(row.user_id),
        date: dbDate(row.date),
        usageKind: row.usage_kind === "image" || row.usage_kind === "video" || row.usage_kind === "audio" || row.usage_kind === "text" ? row.usage_kind : "api",
        pointsSpent: dbNumber(row.points_spent, 0),
        units: dbNumber(row.units, 0),
        updatedAt: dbIso(row.updated_at),
    };
}

export function mapPostgresPointRecord(row: Record<string, unknown>): StoredPointRecord {
    const amount = dbNumber(row.amount, 0);
    const balanceAfter = dbNumber(row.balance_after, 0);
    return {
        id: dbText(row.id),
        userId: dbText(row.user_id),
        type: row.type === "consume" || row.type === "refund" || row.type === "credit" ? row.type : "admin-adjust",
        amount,
        balanceAfter,
        permanentAmount: row.permanent_amount === undefined ? amount : dbNumber(row.permanent_amount, 0),
        dailyAmount: dbNumber(row.daily_amount, 0),
        permanentBalanceAfter: row.permanent_balance_after === undefined ? balanceAfter : dbNumber(row.permanent_balance_after, 0),
        dailyBalanceAfter: dbNumber(row.daily_balance_after, 0),
        description: dbText(row.description),
        model: dbOptionalText(row.model),
        idempotencyKey: dbOptionalText(row.idempotency_key),
        requestFingerprint: dbOptionalText(row.request_fingerprint),
        sourceRecordId: dbOptionalText(row.source_record_id),
        sourceDate: row.source_date ? dbDate(row.source_date) : undefined,
        createdAt: dbIso(row.created_at),
    };
}

export function mapPostgresDailyPlanPointWallet(row: Record<string, unknown>): StoredDailyPlanPointWallet {
    return {
        userId: dbText(row.user_id),
        date: dbDate(row.date),
        planId: dbText(row.plan_id),
        assignmentId: dbOptionalText(row.assignment_id),
        grantedPoints: dbNumber(row.granted_points, 0),
        remainingPoints: dbNumber(row.remaining_points, 0),
        createdAt: dbIso(row.created_at),
        updatedAt: dbIso(row.updated_at),
    };
}

export function mapPostgresEmailCode(row: Record<string, unknown>): StoredEmailCode {
    return {
        id: dbText(row.id),
        purpose: row.purpose === "email-change" || row.purpose === "password-reset" ? row.purpose : "register",
        email: dbText(row.email),
        userId: dbOptionalText(row.user_id),
        codeHash: dbText(row.code_hash),
        createdAt: dbIso(row.created_at),
        expiresAt: dbIso(row.expires_at),
        consumedAt: dbOptionalIso(row.consumed_at),
        attempts: dbNumber(row.attempts, 0),
    };
}

export function mapPostgresCdkCode(row: Record<string, unknown>, redemptions: StoredCdkRedemption[]): StoredCdkCode {
    return {
        id: dbText(row.id),
        codeHash: dbText(row.code_hash),
        code: decryptSecretValue(dbText(row.code_ciphertext)) || undefined,
        codePreview: dbText(row.code_preview),
        points: dbNumber(row.points, 10),
        maxRedemptions: Math.max(1, dbNumber(row.max_redemptions, 1)),
        redeemedCount: dbNumber(row.redeemed_count, redemptions.length),
        status: row.status === "disabled" ? "disabled" : "active",
        note: dbText(row.note),
        expiresAt: dbOptionalIso(row.expires_at),
        redemptions,
        createdAt: dbIso(row.created_at),
        updatedAt: dbIso(row.updated_at),
    };
}

export function mapPostgresAnnouncement(row: Record<string, unknown>): PublicAnnouncement {
    return {
        id: dbText(row.id),
        title: dbText(row.title),
        content: dbText(row.content),
        enabled: dbBool(row.enabled, true),
        popupHome: dbBool(row.popup_home, false),
        popupAfterLogin: dbBool(row.popup_after_login, false),
        startsAt: dbOptionalIso(row.starts_at),
        endsAt: dbOptionalIso(row.ends_at),
        createdAt: dbIso(row.created_at),
        updatedAt: dbIso(row.updated_at),
    };
}

export async function upsertPostgresEntitlementPlans(db: QueryExecutor, plans: EntitlementPlan[]) {
    for (const [index, plan] of plans.entries()) {
        await db.query(
            `
            INSERT INTO entitlement_plans (id, name, enabled, daily_points, limits, features, sort_order)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name,
                enabled = EXCLUDED.enabled,
                daily_points = EXCLUDED.daily_points,
                limits = EXCLUDED.limits,
                features = EXCLUDED.features,
                sort_order = EXCLUDED.sort_order
            `,
            [plan.id, plan.name, plan.enabled, plan.dailyPoints, dbJsonParam(plan.limits), dbJsonParam(plan.features), index],
        );
    }
}

export async function upsertPostgresSettings(db: QueryExecutor, settings: AuthSettings) {
    await db.query(
        `
        INSERT INTO app_settings (
            id, site, registration_enabled, email_registration_enabled, free_daily_points_enabled, mail, allow_user_api_config,
            model_point_costs, generation_point_multipliers, generation_cost_control, data_lifecycle, entitlements_enabled, default_plan_id, generation_concurrency, generation_defaults,
            logical_models, default_models, ecommerce_model_roles, ecommerce_generation_enabled, agent_skills, free_daily_points, ecommerce_visual_quality_check_enabled
        )
        VALUES ('default', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
        ON CONFLICT (id) DO UPDATE SET
            site = EXCLUDED.site,
            registration_enabled = EXCLUDED.registration_enabled,
            email_registration_enabled = EXCLUDED.email_registration_enabled,
            free_daily_points_enabled = EXCLUDED.free_daily_points_enabled,
            mail = EXCLUDED.mail,
            allow_user_api_config = EXCLUDED.allow_user_api_config,
            model_point_costs = EXCLUDED.model_point_costs,
            generation_point_multipliers = EXCLUDED.generation_point_multipliers,
            generation_cost_control = EXCLUDED.generation_cost_control,
            data_lifecycle = EXCLUDED.data_lifecycle,
            entitlements_enabled = EXCLUDED.entitlements_enabled,
            default_plan_id = EXCLUDED.default_plan_id,
            generation_concurrency = EXCLUDED.generation_concurrency,
            generation_defaults = EXCLUDED.generation_defaults,
            logical_models = EXCLUDED.logical_models,
            default_models = EXCLUDED.default_models,
            ecommerce_model_roles = EXCLUDED.ecommerce_model_roles,
            ecommerce_generation_enabled = EXCLUDED.ecommerce_generation_enabled,
            ecommerce_visual_quality_check_enabled = EXCLUDED.ecommerce_visual_quality_check_enabled,
            agent_skills = EXCLUDED.agent_skills,
            free_daily_points = EXCLUDED.free_daily_points
        `,
        [
            dbJsonParam(settings.site),
            settings.registrationEnabled,
            settings.emailRegistrationEnabled,
            settings.freeDailyPointsEnabled,
            dbJsonParam(settings.mail),
            settings.allowUserApiConfig,
            dbJsonParam(settings.modelPointCosts),
            dbJsonParam(settings.generationPointMultipliers),
            dbJsonParam(settings.generationCostControl),
            dbJsonParam(settings.dataLifecycle),
            settings.entitlements.enabled,
            settings.entitlements.defaultPlanId,
            dbJsonParam(settings.generationConcurrency),
            dbJsonParam(settings.generationDefaults),
            dbJsonParam(settings.logicalModels),
            dbJsonParam(settings.defaultModels),
            dbJsonParam(settings.ecommerceModelRoles),
            settings.ecommerceGenerationEnabled,
            dbJsonParam(settings.agentSkills),
            settings.freeDailyPoints,
            settings.ecommerceVisualQualityCheckEnabled,
        ],
    );
}

export async function upsertPostgresSystemChannels(db: QueryExecutor, channels: SystemModelChannel[]) {
    for (const [index, channel] of channels.entries()) {
        await db.query(
            `
            INSERT INTO system_model_channels (id, name, base_url, api_key_ciphertext, webhook_secret_ciphertext, api_format, models, enabled, advanced_config, sort_order)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name,
                base_url = EXCLUDED.base_url,
                api_key_ciphertext = EXCLUDED.api_key_ciphertext,
                webhook_secret_ciphertext = EXCLUDED.webhook_secret_ciphertext,
                api_format = EXCLUDED.api_format,
                models = EXCLUDED.models,
                enabled = EXCLUDED.enabled,
                advanced_config = EXCLUDED.advanced_config,
                sort_order = EXCLUDED.sort_order,
                updated_at = now()
            `,
            [channel.id, channel.name, channel.baseUrl, channel.apiKey, channel.webhookSecret || "", channel.apiFormat, dbJsonParam(channel.models), channel.enabled, dbJsonParam(channel.advancedConfig), index],
        );
    }
}

export async function insertPostgresUsers(db: QueryExecutor, users: StoredUser[]) {
    for (const user of users) {
        await db.query(
            `
            INSERT INTO users (id, account_id, username, email, display_name, bio, avatar_storage_key, role, admin_permissions, status, plan_id, points_balance, password_hash, mfa_secret_ciphertext, mfa_enabled_at, terms_version, terms_url, privacy_version, privacy_url, policy_accepted_at, last_login_at, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12::numeric, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
            ON CONFLICT (id) DO UPDATE SET
                account_id = EXCLUDED.account_id,
                username = EXCLUDED.username,
                email = EXCLUDED.email,
                display_name = EXCLUDED.display_name,
                bio = EXCLUDED.bio,
                avatar_storage_key = EXCLUDED.avatar_storage_key,
                role = EXCLUDED.role,
                admin_permissions = EXCLUDED.admin_permissions,
                status = EXCLUDED.status,
                plan_id = EXCLUDED.plan_id,
                points_balance = EXCLUDED.points_balance,
                password_hash = EXCLUDED.password_hash,
                mfa_secret_ciphertext = EXCLUDED.mfa_secret_ciphertext,
                mfa_enabled_at = EXCLUDED.mfa_enabled_at,
                terms_version = EXCLUDED.terms_version,
                terms_url = EXCLUDED.terms_url,
                privacy_version = EXCLUDED.privacy_version,
                privacy_url = EXCLUDED.privacy_url,
                policy_accepted_at = EXCLUDED.policy_accepted_at,
                last_login_at = EXCLUDED.last_login_at,
                created_at = EXCLUDED.created_at,
                updated_at = EXCLUDED.updated_at
            `,
            [
                user.id,
                Number(user.accountId),
                user.username,
                user.email || null,
                user.displayName,
                user.bio,
                user.avatarStorageKey || null,
                user.role,
                JSON.stringify(user.adminPermissions),
                user.status,
                user.planId,
                user.pointsBalance,
                user.passwordHash,
                user.mfaSecretCiphertext || null,
                user.mfaEnabledAt || null,
                user.registrationConsent?.termsVersion || null,
                user.registrationConsent?.termsUrl || null,
                user.registrationConsent?.privacyVersion || null,
                user.registrationConsent?.privacyUrl || null,
                user.registrationConsent?.acceptedAt || null,
                user.lastLoginAt || null,
                user.createdAt,
                user.updatedAt,
            ],
        );
    }
}

export async function insertPostgresSessions(db: QueryExecutor, sessions: StoredSession[]) {
    for (const session of sessions) {
        await db.query(
            `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (id) DO UPDATE SET
                user_id = EXCLUDED.user_id,
                token_hash = EXCLUDED.token_hash,
                created_at = EXCLUDED.created_at,
                expires_at = EXCLUDED.expires_at`,
            [session.id, session.userId, session.tokenHash, session.createdAt, session.expiresAt],
        );
    }
}

export async function insertPostgresEmailCodes(db: QueryExecutor, emailCodes: StoredEmailCode[]) {
    for (const code of emailCodes) {
        await db.query(
            `INSERT INTO email_codes (id, purpose, email, user_id, code_hash, created_at, expires_at, consumed_at, attempts)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (id) DO UPDATE SET
                purpose = EXCLUDED.purpose,
                email = EXCLUDED.email,
                user_id = EXCLUDED.user_id,
                code_hash = EXCLUDED.code_hash,
                created_at = EXCLUDED.created_at,
                expires_at = EXCLUDED.expires_at,
                consumed_at = EXCLUDED.consumed_at,
                attempts = EXCLUDED.attempts`,
            [code.id, code.purpose, code.email, code.userId || null, code.codeHash, code.createdAt, code.expiresAt, code.consumedAt || null, code.attempts || 0],
        );
    }
}

export async function insertPostgresQuotaUsage(db: QueryExecutor, quotaUsage: StoredQuotaUsage[]) {
    for (const usage of quotaUsage) {
        await db.query(
            `INSERT INTO quota_usage (user_id, date, usage_kind, points_spent, units, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (user_id, date, usage_kind) DO UPDATE SET
                points_spent = EXCLUDED.points_spent,
                units = EXCLUDED.units,
                updated_at = EXCLUDED.updated_at`,
            [usage.userId, usage.date, usage.usageKind, usage.pointsSpent, usage.units, usage.updatedAt],
        );
    }
}

export async function insertPostgresPointRecords(db: QueryExecutor, records: StoredPointRecord[]) {
    for (const record of records) {
        await db.query(
            `INSERT INTO point_records (id, user_id, type, amount, balance_after, permanent_amount, daily_amount, permanent_balance_after, daily_balance_after, description, model, idempotency_key, request_fingerprint, source_record_id, source_date, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
             ON CONFLICT (id) DO UPDATE SET
                user_id = EXCLUDED.user_id,
                type = EXCLUDED.type,
                amount = EXCLUDED.amount,
                balance_after = EXCLUDED.balance_after,
                permanent_amount = EXCLUDED.permanent_amount,
                daily_amount = EXCLUDED.daily_amount,
                permanent_balance_after = EXCLUDED.permanent_balance_after,
                daily_balance_after = EXCLUDED.daily_balance_after,
                description = EXCLUDED.description,
                model = EXCLUDED.model,
                idempotency_key = EXCLUDED.idempotency_key,
                request_fingerprint = EXCLUDED.request_fingerprint,
                source_record_id = EXCLUDED.source_record_id,
                source_date = EXCLUDED.source_date,
                created_at = EXCLUDED.created_at`,
            [
                record.id,
                record.userId,
                record.type,
                record.amount,
                record.balanceAfter,
                record.permanentAmount,
                record.dailyAmount,
                record.permanentBalanceAfter,
                record.dailyBalanceAfter,
                record.description,
                record.model || null,
                record.idempotencyKey || null,
                record.requestFingerprint || null,
                record.sourceRecordId || null,
                record.sourceDate || null,
                record.createdAt,
            ],
        );
    }
}

export async function insertPostgresDailyPlanPointWallets(db: QueryExecutor, wallets: StoredDailyPlanPointWallet[]) {
    for (const wallet of wallets) {
        await db.query(
            `INSERT INTO daily_plan_point_wallets (user_id, date, plan_id, assignment_id, granted_points, remaining_points, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (user_id, date) DO UPDATE SET
                plan_id = EXCLUDED.plan_id,
                assignment_id = EXCLUDED.assignment_id,
                granted_points = EXCLUDED.granted_points,
                remaining_points = EXCLUDED.remaining_points,
                created_at = EXCLUDED.created_at,
                updated_at = EXCLUDED.updated_at`,
            [wallet.userId, wallet.date, wallet.planId, wallet.assignmentId || null, wallet.grantedPoints, wallet.remainingPoints, wallet.createdAt, wallet.updatedAt],
        );
    }
}

export async function insertPostgresCdkCodes(db: QueryExecutor, codes: StoredCdkCode[]) {
    for (const code of codes) {
        await db.query(
            `
            INSERT INTO cdk_codes (id, code_hash, code_ciphertext, code_preview, points, max_redemptions, redeemed_count, status, note, expires_at, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            ON CONFLICT (id) DO UPDATE SET
                code_hash = EXCLUDED.code_hash,
                code_ciphertext = EXCLUDED.code_ciphertext,
                code_preview = EXCLUDED.code_preview,
                points = EXCLUDED.points,
                max_redemptions = EXCLUDED.max_redemptions,
                redeemed_count = EXCLUDED.redeemed_count,
                status = EXCLUDED.status,
                note = EXCLUDED.note,
                expires_at = EXCLUDED.expires_at,
                created_at = EXCLUDED.created_at,
                updated_at = EXCLUDED.updated_at
            `,
            [code.id, code.codeHash, encryptSecretValue(code.code || ""), code.codePreview, code.points, code.maxRedemptions, code.redemptions.length, code.status, code.note, code.expiresAt || null, code.createdAt, code.updatedAt],
        );
    }

    for (const code of codes) {
        for (const redemption of code.redemptions) {
            await db.query(
                `INSERT INTO cdk_redemptions (cdk_code_id, user_id, redeemed_at)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (cdk_code_id, user_id) DO UPDATE SET redeemed_at = EXCLUDED.redeemed_at`,
                [code.id, redemption.userId, redemption.redeemedAt],
            );
        }
    }
}

export async function insertPostgresAnnouncements(db: QueryExecutor, announcements: PublicAnnouncement[]) {
    for (const announcement of announcements) {
        await db.query(
            `
            INSERT INTO announcements (id, title, content, enabled, popup_home, popup_after_login, starts_at, ends_at, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (id) DO UPDATE SET
                title = EXCLUDED.title,
                content = EXCLUDED.content,
                enabled = EXCLUDED.enabled,
                popup_home = EXCLUDED.popup_home,
                popup_after_login = EXCLUDED.popup_after_login,
                starts_at = EXCLUDED.starts_at,
                ends_at = EXCLUDED.ends_at,
                created_at = EXCLUDED.created_at,
                updated_at = EXCLUDED.updated_at
            `,
            [
                announcement.id,
                announcement.title,
                announcement.content,
                announcement.enabled,
                announcement.popupHome,
                announcement.popupAfterLogin,
                announcement.startsAt || null,
                announcement.endsAt || null,
                announcement.createdAt,
                announcement.updatedAt,
            ],
        );
    }
}

export function dbText(value: unknown) {
    return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

export function dbOptionalText(value: unknown) {
    const text = dbText(value);
    return text || undefined;
}

export function dbNumber(value: unknown, fallback: number) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

export function dbBool(value: unknown, fallback: boolean) {
    if (typeof value === "boolean") return value;
    return fallback;
}

export function dbIso(value: unknown) {
    const date = value instanceof Date ? value : new Date(dbText(value));
    return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

export function dbOptionalIso(value: unknown) {
    if (!value) return undefined;
    return dbIso(value);
}

export function dbDate(value: unknown) {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return dbText(value).slice(0, 10);
}

export function dbJson<T>(value: unknown, fallback: T): T {
    if (value === null || value === undefined) return fallback;
    return value as T;
}

export function dbJsonParam(value: unknown) {
    return value === undefined ? null : JSON.stringify(value);
}
