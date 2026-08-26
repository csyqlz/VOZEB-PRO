import { randomUUID } from "node:crypto";

import { inferModelCapability } from "@/lib/model-capability";
import { lockAuthMutation } from "@/lib/server/auth-mutation-lock";
import { createPostgresRepositories, ensurePostgresSchema, isPostgresDatabaseEnabled, withPostgresTransaction } from "@/lib/server/database";
import { adjustPermanentPointsInPostgresTransaction, consumePoints, creditPermanentPointsInAuthDb, refundPoints, walletClock } from "@/lib/server/points-wallet-service";
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
    type AnnouncementPageInput,
    type SiteSettings,
    type SiteFriendLink,
    type SiteSocialKey,
    type SiteSocialSettings,
    DEFAULT_SITE_SOCIALS,
    DEFAULT_SITE_FRIEND_LINKS,
    type MailSettings,
    type PublicUser,
    type PublicUserSummary,
    type StoredSession,
    type PublicPointRecord,
    type StoredPointRecord,
    type PointRecordBillingDetail,
    type StoredQuotaUsage,
    type StoredEmailCode,
    type AuthDatabase,
} from "./store-types";
import {
    AuthInputError,
    EmailCodeAttemptError,
    QuotaExceededError,
    isAuthInputError,
    isQuotaExceededError,
    SESSION_MAX_AGE_SECONDS,
    DEFAULT_MODEL_POINT_COST_KEY,
    DEFAULT_SITE_SETTINGS,
    DEFAULT_MAIL_SETTINGS,
    DEFAULT_GENERATION_POINT_MULTIPLIERS,
    DEFAULT_ENTITLEMENT_LIMITS,
    DEFAULT_ENTITLEMENT_PLAN_ID,
    DEFAULT_SETTINGS,
    AUTH_DATA_FILE,
    USERNAME_PATTERN,
} from "./store-foundation";
import { readAuthDb, mutateAuthDb, readPostgresAnnouncementsPage, readPostgresCdkListData } from "./store-repository";

import {
    normalizeDb,
    emptyDb,
    encryptAuthDbSecretsForStorage,
    decryptAuthSettingsSecrets,
    encryptAuthSettingsSecrets,
    resolveDefaultPlan,
    resolveUserPlan,
    assertEntitlementUsageAllowed,
    recordQuotaUsage,
    findQuotaUsage,
    assertDailyLimit,
    resolveDailyUsageLimit,
    dailyUsageLimitLabel,
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
    hashToken,
} from "./store-normalizers";
import { matchesPublicUser, publicUserFromAuthenticatedRecord, summarizePublicUsers, toPublicUser } from "./store-user-projection";
import { getAuthSettings } from "./store-settings-actions";
import { effectiveBillingUnit, resolveLogicalModelPricing, mediaSalePrice, textTokenSalePrice } from "@/lib/model-pricing";
import type { TokenUsage } from "@/lib/server/text-token-billing";

export { authenticateUser, createEmailVerificationCode, createFirstAdmin, createUser, createUserByAdmin } from "./store-user-access";
export { toPublicUser };

export function sessionMaxAgeSeconds() {
    return SESSION_MAX_AGE_SECONDS;
}

export { getAuthSettings, getFreshAuthSettings, setAuthSettings } from "./store-settings-actions";

export type PublicUserListResult = {
    users: PublicUser[];
    total: number;
    page: number;
    pageSize: number;
    summary: PublicUserSummary;
};

export async function listPublicUsersPage(input?: { page?: number; pageSize?: number; keyword?: string; role?: UserRole; status?: UserStatus }): Promise<PublicUserListResult> {
    const page = Math.max(1, Math.floor(Number(input?.page) || 1));
    const pageSize = Math.max(1, Math.min(100, Math.floor(Number(input?.pageSize) || 20)));
    const keyword = normalizeText(input?.keyword, "", 120).toLowerCase();
    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        const repos = createPostgresRepositories();
        const clock = walletClock();
        const [result, summary] = await Promise.all([repos.users.list({ page, pageSize, keyword, role: input?.role, status: input?.status }), repos.users.summarize({ now: clock.now.toISOString(), date: clock.date })]);
        const details = await repos.users.getPublicDetails(
            result.items.map((user) => user.id),
            { now: clock.now.toISOString(), date: clock.date },
        );
        const usersById = new Map(details.map((record) => [record.user.id, publicUserFromAuthenticatedRecord(record, clock.expiresAt)]));
        return {
            users: result.items.map((user) => usersById.get(user.id)).filter((user): user is PublicUser => Boolean(user)),
            total: result.total,
            page: result.page,
            pageSize: result.pageSize,
            summary,
        };
    }
    const db = await readAuthDb();
    const publicUsers = db.users.map((user) => toPublicUser(user, db)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const filtered = publicUsers.filter((user) => matchesPublicUser(user, { keyword, role: input?.role, status: input?.status }));
    const total = filtered.length;
    const safePage = Math.min(page, Math.max(1, Math.ceil(total / pageSize)));
    return {
        users: filtered.slice((safePage - 1) * pageSize, safePage * pageSize),
        total,
        page: safePage,
        pageSize,
        summary: summarizePublicUsers(publicUsers, db.settings.entitlements.defaultPlanId),
    };
}

export async function getPublicUserSummary(): Promise<PublicUserSummary> {
    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        const clock = walletClock();
        return createPostgresRepositories().users.summarize({ now: clock.now.toISOString(), date: clock.date });
    }
    const db = await readAuthDb();
    return summarizePublicUsers(
        db.users.map((user) => toPublicUser(user, db)),
        db.settings.entitlements.defaultPlanId,
    );
}

export async function getPublicUsersByIds(userIds: string[]): Promise<PublicUser[]> {
    const ids = Array.from(new Set(userIds.map((id) => normalizeText(id, "", 120)).filter(Boolean)));
    if (!ids.length) return [];
    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        const clock = walletClock();
        const records = await createPostgresRepositories().users.getPublicDetails(ids, { now: clock.now.toISOString(), date: clock.date });
        return records.map((record) => publicUserFromAuthenticatedRecord(record, clock.expiresAt));
    }
    const db = await readAuthDb();
    const idSet = new Set(ids);
    return db.users.filter((user) => idSet.has(user.id)).map((user) => toPublicUser(user, db));
}

export async function findPublicUserIdsByKeyword(value: string, limit?: number): Promise<string[]> {
    const keyword = normalizeText(value, "", 120).toLowerCase();
    if (!keyword) return [];
    const requestedLimit = Number.isSafeInteger(limit) && Number(limit) > 0 ? Number(limit) : undefined;
    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        const pageSize = Math.min(100, requestedLimit || 100);
        const result = await createPostgresRepositories().users.list({ page: 1, pageSize, keyword });
        return result.items.map((user) => user.id);
    }
    const db = await readAuthDb();
    const matches = db.users
        .map((user) => toPublicUser(user, db))
        .filter((user) => matchesPublicUser(user, { keyword }))
        .map((user) => user.id);
    return requestedLimit ? matches.slice(0, requestedLimit) : matches;
}

export type PointRecordListResult = {
    records: PublicPointRecord[];
    total: number;
    page: number;
    pageSize: number;
};

export async function listPointRecordsPage(userId: string, input?: { page?: number; pageSize?: number; direction?: "credit" | "debit"; view?: "balance" | "consumption" }): Promise<PointRecordListResult> {
    const pageSize = Math.max(1, Math.min(50, Math.floor(Number(input?.pageSize) || 10)));
    const page = Math.max(1, Math.floor(Number(input?.page) || 1));
    const direction = input?.direction === "credit" || input?.direction === "debit" ? input.direction : undefined;
    const view = input?.view === "consumption" ? input.view : undefined;
    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        const result = await createPostgresRepositories().points.listRecords(userId, { page, pageSize, direction, view });
        return {
            records: result.items.map(toPublicPointRecord),
            total: result.total,
            page: result.page,
            pageSize: result.pageSize,
        };
    }
    const db = await readAuthDb();
    const records = (db.pointRecords || [])
        .filter((record) => record.userId === userId && (!direction || (direction === "credit" ? record.amount > 0 : record.amount < 0)))
        .filter((record) => view !== "consumption" || !(record.billingDetail?.estimated && record.billingDetail.settlementStatus === "settled"))
        .map(toPublicPointRecord)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const total = records.length;
    const safePage = Math.min(page, Math.max(1, Math.ceil(total / pageSize)));
    const start = (safePage - 1) * pageSize;
    return {
        records: records.slice(start, start + pageSize),
        total,
        page: safePage,
        pageSize,
    };
}

export type CdkListFilter = "all" | "redeemed" | "unused" | "expired";

export type CdkListResult = {
    codes: PublicCdkCode[];
    total: number;
    page: number;
    pageSize: number;
    stats: {
        total: number;
        redeemed: number;
        unused: number;
        expired: number;
    };
};

type PostgresRepositories = ReturnType<typeof createPostgresRepositories>;
type PostgresCdkDetails = NonNullable<Awaited<ReturnType<PostgresRepositories["cdk"]["getDetailsById"]>>>;

export async function listCdkCodes(input?: { page?: number; pageSize?: number; keyword?: string; filter?: CdkListFilter }): Promise<CdkListResult> {
    const keyword = normalizeText(input?.keyword, "", 120).toLowerCase();
    const filter = input?.filter === "redeemed" || input?.filter === "unused" || input?.filter === "expired" ? input.filter : "all";
    const pageSize = Math.max(1, Math.min(100, Math.floor(Number(input?.pageSize) || 20)));
    const page = Math.max(1, Math.floor(Number(input?.page) || 1));
    if (isPostgresDatabaseEnabled()) {
        const db = await readPostgresCdkListData({ page, pageSize, keyword, filter, codeHash: keyword ? hashToken(normalizeCdkCode(keyword)) : "" });
        return {
            codes: db.cdkCodes.map((code) => toPublicCdkCode(code, db, { includePlain: true })),
            total: db.total,
            page: db.page,
            pageSize: db.pageSize,
            stats: db.stats,
        };
    }
    const db = await readAuthDb();
    const allCodes = db.cdkCodes
        .filter((code) => code.status === "active" && Boolean(code.code))
        .map((code) => toPublicCdkCode(code, db, { includePlain: true }))
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const stats = {
        total: allCodes.length,
        redeemed: allCodes.filter((code) => code.redeemedCount > 0).length,
        unused: allCodes.filter((code) => !isCdkCodeExpired(code) && code.redeemedCount <= 0).length,
        expired: allCodes.filter(isCdkCodeExpired).length,
    };
    const filtered = allCodes.filter((code) => {
        const matchedFilter = filter === "all" || (filter === "redeemed" && code.redeemedCount > 0) || (filter === "unused" && !isCdkCodeExpired(code) && code.redeemedCount <= 0) || (filter === "expired" && isCdkCodeExpired(code));
        if (!matchedFilter) return false;
        if (!keyword) return true;
        const redemptionsText = code.redemptions.map((item) => `${item.accountId || ""} ${item.username} ${item.displayName}`).join(" ");
        return [code.code || "", code.note, redemptionsText].some((value) => value.toLowerCase().includes(keyword));
    });
    const total = filtered.length;
    const safePage = Math.min(page, Math.max(1, Math.ceil(total / pageSize)));
    const start = (safePage - 1) * pageSize;
    return {
        codes: filtered.slice(start, start + pageSize),
        total,
        page: safePage,
        pageSize,
        stats,
    };
}

function publicPostgresCdkCode(item: PostgresCdkDetails, includePlain = false) {
    const stored: StoredCdkCode = {
        id: item.id,
        codeHash: item.codeHash,
        code: decryptSecretValue(item.codeCiphertext) || undefined,
        codePreview: item.codePreview,
        points: item.points,
        maxRedemptions: item.maxRedemptions,
        redeemedCount: item.redeemedCount,
        redemptions: item.redemptions.map((redemption) => ({ userId: redemption.userId, redeemedAt: redemption.redeemedAt })),
        status: item.status,
        note: item.note,
        expiresAt: item.expiresAt,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
    };
    return toPublicCdkCode(
        stored,
        {
            users: item.redemptions.map((redemption) => ({
                id: redemption.userId,
                accountId: redemption.accountId,
                username: redemption.username || "已删除用户",
                displayName: redemption.displayName || redemption.username || "已删除用户",
            })),
        },
        { includePlain },
    );
}

export async function createCdkCodes(input: { count?: number; points?: number; maxRedemptions?: number; expiresAt?: string; expiresInDays?: number; note?: string }) {
    const count = Math.max(1, Math.min(100, Math.floor(Number(input.count) || 1)));
    const points = normalizePoints(input.points, 10);
    const maxRedemptions = Math.max(1, Math.min(10000, Math.floor(Number(input.maxRedemptions) || 1)));
    const expiresAt = resolveCdkExpiresAt(input.expiresAt, input.expiresInDays);
    const note = normalizeText(input.note, "", 120);
    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        return withPostgresTransaction(async (client) => {
            await lockAuthMutation(client);
            const cdk = createPostgresRepositories(client).cdk;
            const now = new Date().toISOString();
            const created: CreatedCdkCode[] = [];
            for (let index = 0; index < count; index += 1) {
                const id = randomUUID();
                const code = generateCdkPlainCode(id);
                const publicCode: CreatedCdkCode = {
                    id,
                    codePreview: previewCdkCode(code),
                    code,
                    points,
                    maxRedemptions,
                    redeemedCount: 0,
                    redemptions: [],
                    status: "active",
                    note,
                    ...(expiresAt ? { expiresAt } : {}),
                    createdAt: now,
                    updatedAt: now,
                };
                await cdk.create({
                    ...publicCode,
                    codeHash: hashToken(normalizeCdkCode(code)),
                    codeCiphertext: encryptSecretValue(code),
                });
                created.push(publicCode);
            }
            return created;
        });
    }
    return mutateAuthDb((db) => {
        const now = new Date().toISOString();
        const created: CreatedCdkCode[] = [];
        for (let index = 0; index < count; index += 1) {
            const id = randomUUID();
            const code = generateCdkPlainCode(id);
            const publicCode: PublicCdkCode = {
                id,
                codePreview: previewCdkCode(code),
                code,
                points,
                maxRedemptions,
                redeemedCount: 0,
                redemptions: [],
                status: "active",
                note,
                ...(expiresAt ? { expiresAt } : {}),
                createdAt: now,
                updatedAt: now,
            };
            db.cdkCodes.push({
                ...publicCode,
                codeHash: hashToken(normalizeCdkCode(code)),
                redemptions: [],
            });
            created.push({ ...publicCode, code });
        }
        return created;
    });
}

export async function updateCdkCode(id: string, patch: Partial<Pick<PublicCdkCode, "status" | "note" | "expiresAt" | "points" | "maxRedemptions">>) {
    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        return withPostgresTransaction(async (client) => {
            const cdk = createPostgresRepositories(client).cdk;
            const item = await cdk.getDetailsById(id, true);
            if (!item) throw new AuthInputError("CDK 不存在");
            const expiresAt = patch.expiresAt === undefined ? item.expiresAt : normalizeOptionalIsoDate(patch.expiresAt);
            const updated = await cdk.update({
                ...item,
                status: patch.status ? (patch.status === "active" ? "active" : "disabled") : item.status,
                note: patch.note === undefined ? item.note : normalizeText(patch.note, "", 120),
                points: patch.points === undefined ? item.points : normalizePoints(patch.points, item.points),
                maxRedemptions: patch.maxRedemptions === undefined ? item.maxRedemptions : Math.max(item.redeemedCount, Math.min(10000, Math.max(1, Math.floor(Number(patch.maxRedemptions) || item.maxRedemptions)))),
                ...(expiresAt ? { expiresAt } : { expiresAt: undefined }),
                updatedAt: new Date().toISOString(),
            });
            if (!updated) throw new AuthInputError("CDK 不存在");
            return publicPostgresCdkCode({ ...item, ...updated }, true);
        });
    }
    return mutateAuthDb((db) => {
        const item = db.cdkCodes.find((code) => code.id === id);
        if (!item) throw new AuthInputError("CDK 不存在");
        if (patch.status) item.status = patch.status === "active" ? "active" : "disabled";
        if (patch.note !== undefined) item.note = normalizeText(patch.note, "", 120);
        if (patch.expiresAt !== undefined) {
            const expiresAt = normalizeOptionalIsoDate(patch.expiresAt);
            if (expiresAt) item.expiresAt = expiresAt;
            else delete item.expiresAt;
        }
        if (patch.points !== undefined) item.points = normalizePoints(patch.points, item.points);
        if (patch.maxRedemptions !== undefined) item.maxRedemptions = Math.max(item.redeemedCount, Math.min(10000, Math.max(1, Math.floor(Number(patch.maxRedemptions) || item.maxRedemptions))));
        item.updatedAt = new Date().toISOString();
        return toPublicCdkCode(item, db, { includePlain: true });
    });
}

export async function deleteCdkCode(id: string) {
    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        const deleted = await createPostgresRepositories().cdk.delete([id]);
        if (!deleted) throw new AuthInputError("CDK 不存在");
        return { ok: true, deleted };
    }
    return mutateAuthDb((db) => {
        const index = db.cdkCodes.findIndex((code) => code.id === id);
        if (index < 0) throw new AuthInputError("CDK 不存在");
        db.cdkCodes.splice(index, 1);
        return { ok: true, deleted: 1 };
    });
}

export async function deleteCdkCodes(ids: string[]) {
    const deletingIds = Array.from(new Set(ids.map((id) => normalizeText(id, "", 80)).filter(Boolean)));
    if (!deletingIds.length) throw new AuthInputError("请选择要删除的 CDK");
    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        return { ok: true, deleted: await createPostgresRepositories().cdk.delete(deletingIds) };
    }
    return mutateAuthDb((db) => {
        const before = db.cdkCodes.length;
        db.cdkCodes = db.cdkCodes.filter((code) => !deletingIds.includes(code.id));
        return { ok: true, deleted: before - db.cdkCodes.length };
    });
}

export async function redeemCdkCode(userId: string, rawCode: string) {
    const code = normalizeCdkCode(rawCode);
    if (!code) throw new AuthInputError("请输入 CDK 密钥");
    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        const clock = walletClock();
        return withPostgresTransaction(async (client) => {
            const repos = createPostgresRepositories(client);
            const item = await repos.cdk.getByCodeHash(hashToken(code), true);
            if (!item || item.status !== "active") throw new AuthInputError("CDK 无效或已停用");
            if (item.expiresAt && Date.parse(item.expiresAt) <= clock.now.getTime()) throw new AuthInputError("CDK 已过期");
            if (item.redeemedCount >= item.maxRedemptions) throw new AuthInputError("CDK 已兑换完");
            const user = await repos.users.getById(userId, true);
            if (!user || user.status !== "active") throw new AuthInputError("用户不可用");

            const redemption = await repos.cdk.addRedemption({ cdkCodeId: item.id, userId, redeemedAt: clock.now.toISOString() });
            if (!redemption) throw new AuthInputError("该 CDK 已被当前账号兑换");
            const points = Math.max(0, normalizePoints(item.points, 0));
            if (!points) throw new AuthInputError("人民币余额金额必须大于零");
            const wallet = await adjustPermanentPointsInPostgresTransaction(client, {
                userId,
                amount: points,
                description: `CDK 兑换：${item.codePreview}`,
                idempotencyKey: `cdk:${item.id}:user:${userId}`,
                type: "credit",
                now: clock.now,
            });
            if (!wallet) throw new AuthInputError("CDK 兑换失败");
            await repos.cdk.incrementRedemptionCount(item.id, clock.now.toISOString());
            const [userRecord, cdkRecord] = await Promise.all([repos.users.getPublicDetails([userId], { now: clock.now.toISOString(), date: clock.date }), repos.cdk.getDetailsById(item.id)]);
            if (!userRecord[0] || !cdkRecord) throw new AuthInputError("CDK 兑换结果读取失败");
            return {
                user: { ...publicUserFromAuthenticatedRecord(userRecord[0], clock.expiresAt), pointsBalance: wallet.snapshot.totalPoints },
                points,
                cdk: publicPostgresCdkCode(cdkRecord),
            };
        });
    }
    return mutateAuthDb((db) => {
        const user = db.users.find((item) => item.id === userId);
        if (!user || user.status !== "active") throw new AuthInputError("用户不可用");
        const item = db.cdkCodes.find((entry) => entry.codeHash === hashToken(code));
        if (!item || item.status !== "active") throw new AuthInputError("CDK 无效或已停用");
        if (item.expiresAt && Date.parse(item.expiresAt) <= Date.now()) throw new AuthInputError("CDK 已过期");
        if (item.redeemedCount >= item.maxRedemptions) throw new AuthInputError("CDK 已兑换完");
        if (item.redemptions.some((entry) => entry.userId === userId)) throw new AuthInputError("该 CDK 已被当前账号兑换");

        const points = normalizePoints(item.points, 0);
        const now = new Date().toISOString();
        const wallet = creditPermanentPointsInAuthDb(db, {
            userId,
            amount: points,
            description: `CDK 兑换：${item.codePreview}`,
            idempotencyKey: `cdk:${item.id}:user:${userId}`,
            type: "credit",
            now: new Date(now),
        });
        item.redemptions.push({ userId, redeemedAt: now });
        item.redeemedCount = item.redemptions.length;
        item.updatedAt = now;
        return { user: { ...toPublicUser(user, db), pointsBalance: wallet.snapshot.totalPoints }, points, cdk: toPublicCdkCode(item, db) };
    });
}

export async function listAnnouncements(includeDisabled = false) {
    return (await listAnnouncementsPage(includeDisabled, { page: 1, pageSize: 100 })).items;
}

export async function listAnnouncementsPage(includeDisabled = false, input: AnnouncementPageInput = {}): Promise<AnnouncementPage> {
    const requestedPage = Number(input.page);
    const requestedPageSize = Number(input.pageSize);
    const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    const pageSize = Number.isSafeInteger(requestedPageSize) && requestedPageSize > 0 ? Math.min(100, requestedPageSize) : 20;
    if (isPostgresDatabaseEnabled()) return readPostgresAnnouncementsPage({ includeDisabled, page, pageSize });

    const announcements = (await readAuthDb()).announcements.filter((announcement) => includeDisabled || isAnnouncementVisible(announcement)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id));
    return {
        items: announcements.slice((page - 1) * pageSize, page * pageSize),
        total: announcements.length,
        page,
        pageSize,
    };
}

export async function createAnnouncement(input: Partial<PublicAnnouncement>) {
    const now = new Date().toISOString();
    const announcement = normalizeAnnouncement({
        id: randomUUID(),
        title: input.title || "",
        content: input.content || "",
        enabled: input.enabled !== false,
        popupHome: input.popupHome === true,
        popupAfterLogin: input.popupAfterLogin === true,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        createdAt: now,
        updatedAt: now,
    });
    if (!announcement.title || !announcement.content) throw new AuthInputError("请填写公告标题和内容");
    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        return createPostgresRepositories().announcements.upsert(announcement);
    }
    return mutateAuthDb((db) => {
        db.announcements.push(announcement);
        return announcement;
    });
}

export async function updateAnnouncement(id: string, patch: Partial<PublicAnnouncement>) {
    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        return withPostgresTransaction(async (client) => {
            const announcements = createPostgresRepositories(client).announcements;
            const current = await announcements.getById(id, true);
            if (!current) throw new AuthInputError("公告不存在");
            const next = normalizeAnnouncement({ ...current, ...patch, id, updatedAt: new Date().toISOString() });
            if (!next.title || !next.content) throw new AuthInputError("请填写公告标题和内容");
            return announcements.upsert(next);
        });
    }
    return mutateAuthDb((db) => {
        const index = db.announcements.findIndex((announcement) => announcement.id === id);
        if (index < 0) throw new AuthInputError("公告不存在");
        const next = normalizeAnnouncement({
            ...db.announcements[index],
            ...patch,
            id,
            updatedAt: new Date().toISOString(),
        });
        if (!next.title || !next.content) throw new AuthInputError("请填写公告标题和内容");
        db.announcements[index] = next;
        return next;
    });
}

export async function deleteAnnouncement(id: string) {
    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        if (!(await createPostgresRepositories().announcements.delete(id))) throw new AuthInputError("公告不存在");
        return { ok: true };
    }
    return mutateAuthDb((db) => {
        const before = db.announcements.length;
        db.announcements = db.announcements.filter((announcement) => announcement.id !== id);
        if (before === db.announcements.length) throw new AuthInputError("公告不存在");
        return { ok: true };
    });
}

export function toPublicPointRecord(record: StoredPointRecord): PublicPointRecord {
    const publicRecord = { ...record };
    delete publicRecord.requestFingerprint;
    return { ...publicRecord, description: displayPointRecordDescription(record) };
}

export function displayPointRecordDescription(record: StoredPointRecord) {
    const description = record.description.trim();
    const model = (record.model || "").trim();
    if (!model) return description;
    if (record.type === "consume") {
        return buildPointRecordDescription(model, legacyPointUsageKindFromModel(model), "consume");
    }
    if (record.type === "admin-adjust" && record.amount > 0) {
        return buildPointRecordDescription(model, legacyPointUsageKindFromModel(model), "refund");
    }
    return description;
}

export function legacyPointUsageKindFromModel(model: string): PointUsageKind {
    const capability = inferModelCapability(model);
    if (capability !== "text") return capability;
    return "api";
}

export async function consumeUserPoints(
    userId: string,
    model: string,
    amount = 1,
    usageKind: PointUsageKind = "api",
    idempotencyKey?: string,
    requestFingerprint?: string,
    billingDetail?: PointRecordBillingDetail,
    billingContext?: { channelId?: string; upstreamModel?: string },
) {
    const normalizedModel = model.trim();
    const db = isPostgresDatabaseEnabled() ? null : await readAuthDb();
    const user = db?.users.find((item) => item.id === userId);
    if (db && (!user || user.status !== "active")) throw new AuthInputError("用户不可用");
    const settings = db ? db.settings : await getAuthSettings();
    const pricing = resolveLogicalModelPricing(settings.logicalModels, billingContext?.upstreamModel || normalizedModel, billingContext?.channelId);
    const capability = usageKind === "text" ? "text" : usageKind === "video" ? "video" : usageKind === "image" ? "image" : "audio";
    const billingUnit = billingDetail?.billingUnit || (pricing ? effectiveBillingUnit(capability, pricing.billingUnit) : undefined);
    const tokenPricedText = usageKind === "text" && billingUnit === "per_1m_tokens";
    const secondPricedVideo = usageKind === "video" && billingUnit === "per_second";
    const multiplier = tokenPricedText ? 1 : mediaSalePrice(pricing, resolveModelPointCost(settings.modelPointCosts, normalizedModel, settings.logicalModels));
    const units = tokenPricedText ? 1 : Math.min(secondPricedVideo ? 3600 : 1000, normalizePointAmount(amount, 1));
    const cost = tokenPricedText ? normalizePointAmount(amount, 0) : normalizePointAmount(units * multiplier, 0);
    const defaultBillingDetail: PointRecordBillingDetail = tokenPricedText
        ? {
              billingUnit: "per_1m_tokens",
              currency: "CNY",
              actualCost: cost,
              inputRate: textTokenSalePrice(pricing)?.input,
              outputRate: textTokenSalePrice(pricing)?.output,
              cacheReadRate: textTokenSalePrice(pricing)?.cacheRead,
              cacheWriteRate: textTokenSalePrice(pricing)?.cacheWrite,
              estimated: true,
              settlementStatus: "reserved",
          }
        : { billingUnit: secondPricedVideo ? "per_second" : "per_call", currency: "CNY", actualCost: cost, unitRate: multiplier };
    const operationKey = idempotencyKey?.trim() || `points-consume:${randomUUID()}`;
    const result = await consumePoints({
        userId,
        amount: cost,
        units,
        usageKind,
        model: normalizedModel,
        description: buildPointRecordDescription(normalizedModel, usageKind, "consume"),
        idempotencyKey: operationKey,
        requestFingerprint,
        billingDetail: billingDetail || defaultBillingDetail,
    });
    return {
        model: normalizedModel,
        units,
        multiplier,
        cost,
        remaining: result.snapshot.totalPoints,
        permanentRemaining: result.snapshot.permanentPoints,
        dailyRemaining: result.snapshot.dailyPoints,
        dailyExpiresAt: result.snapshot.dailyExpiresAt,
        usageKind,
        planId: result.snapshot.activePlanId || (db && user ? resolveUserPlan(db, user).id : DEFAULT_ENTITLEMENT_PLAN_ID),
        recordId: result.record.id,
        idempotencyKey: result.record.idempotencyKey,
    };
}

export async function refundUserPoints(userId: string, model: string, amount: number, usageKind: PointUsageKind = "api", units = 0, idempotencyKey?: string, sourceRecordId?: string) {
    const refund = normalizePointAmount(amount, 0);
    const sourceId = sourceRecordId?.trim();
    if (isPostgresDatabaseEnabled()) {
        const clock = walletClock();
        if (!refund && !sourceId) {
            const details = await createPostgresRepositories().users.getPublicDetails([userId], { now: clock.now.toISOString(), date: clock.date });
            const user = details[0];
            return user ? publicUserFromAuthenticatedRecord(user, clock.expiresAt) : null;
        }
        if (!sourceId) throw new AuthInputError("退款缺少原消费流水");
        const result = await refundPoints({
            userId,
            sourceRecordId: sourceId,
            idempotencyKey: idempotencyKey?.trim() || `points-refund:${sourceId}`,
            usageKind,
            units: normalizePointAmount(units, 0),
            model: model.trim(),
            description: buildPointRecordDescription(model, usageKind, "refund"),
        });
        const details = await createPostgresRepositories().users.getPublicDetails([userId], { now: clock.now.toISOString(), date: clock.date });
        const user = details[0];
        return user ? { ...publicUserFromAuthenticatedRecord(user, result.snapshot.dailyExpiresAt), pointsBalance: result.snapshot.totalPoints } : null;
    }
    const db = await readAuthDb();
    const user = db.users.find((item) => item.id === userId);
    if (!user) return null;
    if (!refund && !sourceId) return toPublicUser(user, db);

    if (!sourceId) throw new AuthInputError("退款缺少原消费流水");
    const result = await refundPoints({
        userId,
        sourceRecordId: sourceId,
        idempotencyKey: idempotencyKey?.trim() || `points-refund:${sourceId}`,
        usageKind,
        units: normalizePointAmount(units, 0),
        model: model.trim(),
        description: buildPointRecordDescription(model, usageKind, "refund"),
    });
    const nextDb = await readAuthDb();
    const nextUser = nextDb.users.find((item) => item.id === userId);
    return nextUser ? { ...toPublicUser(nextUser, nextDb), pointsBalance: result.snapshot.totalPoints } : null;
}

/** Updates a persisted consumption record after the upstream reports actual usage. */
export async function updatePointRecordBillingDetail(userId: string, recordId: string, billingDetail: PointRecordBillingDetail) {
    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        return createPostgresRepositories().points.updateBillingDetail(recordId, userId, billingDetail);
    }
    return mutateAuthDb((db) => {
        const record = db.pointRecords.find((item) => item.id === recordId && item.userId === userId);
        if (!record) return null;
        record.billingDetail = billingDetail;
        return record;
    });
}

/** Reconciles a token reservation with usage reported by the upstream provider. */
export async function settleUserTokenCharge(input: {
    userId: string;
    model: string;
    reservedCost: number;
    actualCost: number;
    sourceRecordId?: string;
    businessRequestId: string;
    requestFingerprint?: string;
    usage?: TokenUsage;
    saleRates?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}) {
    const reserved = normalizePointAmount(input.reservedCost, 0);
    const actual = normalizePointAmount(input.actualCost, 0);
    const billingDetail: PointRecordBillingDetail | undefined = input.usage
        ? {
              billingUnit: "per_1m_tokens",
              currency: "CNY",
              actualCost: actual,
              inputTokens: input.usage.inputTokens,
              outputTokens: input.usage.outputTokens,
              cacheReadTokens: input.usage.cacheReadTokens,
              cacheWriteTokens: input.usage.cacheWriteTokens,
              inputRate: input.saleRates?.input,
              outputRate: input.saleRates?.output,
              cacheReadRate: input.saleRates?.cacheRead,
              cacheWriteRate: input.saleRates?.cacheWrite,
              estimated: false,
              settlementStatus: "settled",
          }
        : undefined;
    if (!input.sourceRecordId) return { adjusted: false, cost: actual };
    if (Math.abs(reserved - actual) < 0.00000001) {
        if (billingDetail) await updatePointRecordBillingDetail(input.userId, input.sourceRecordId, billingDetail);
        return { adjusted: false, cost: actual, recordId: input.sourceRecordId };
    }
    await refundUserPoints(input.userId, input.model, reserved, "text", 1, `token-settle-refund:${input.sourceRecordId}`, input.sourceRecordId);
    if (!actual) {
        if (billingDetail) await updatePointRecordBillingDetail(input.userId, input.sourceRecordId, { ...billingDetail, estimated: true });
        return { adjusted: true, cost: 0 };
    }
    const result = await consumeUserPoints(input.userId, input.model, actual, "text", `token-settle-consume:${input.businessRequestId}`, input.requestFingerprint, billingDetail);
    if (billingDetail) await updatePointRecordBillingDetail(input.userId, input.sourceRecordId, { ...billingDetail, estimated: true });
    return { adjusted: true, cost: result.cost, recordId: result.recordId };
}

export { createSession, deleteSession, deleteUserByAdmin, getUserBySession, resetPasswordByEmail, updateOwnPassword, updateOwnProfile, updateUserByAdmin, verifyUserPasswordForSensitiveAction } from "./store-account-actions";
