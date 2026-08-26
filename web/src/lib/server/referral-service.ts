import { createHmac, randomUUID } from "node:crypto";

import { lockAuthMutation } from "@/lib/server/auth-mutation-lock";
import { BillingInputError } from "@/lib/server/billing-errors";
import { assertBillingDatabaseReady, normalizeId, normalizeInteger, normalizeMoneyLike, normalizeText } from "@/lib/server/billing-service-helpers";
import { issueCouponInPostgresTransaction } from "@/lib/server/coupon-service";
import {
    createPostgresRepositories,
    withPostgresTransaction,
    type BillingOrderRecord,
    type JsonValue,
    type QueryExecutor,
    type ReferralProgramRecord,
    type ReferralRelationshipRecord,
    type ReferralRewardRecord,
    type ReferralRewardStatus,
    type ReferralRiskStatus,
} from "@/lib/server/database";
import { adjustPermanentPointsInPostgresTransaction } from "@/lib/server/points-wallet-service";

const REGISTRATION_NETWORK_WINDOW_MS = 30 * 24 * 60 * 60_000;
const REGISTRATION_NETWORK_REVIEW_COUNT = 3;
export const REFERRAL_COOKIE_NAME = "vozeb_referral";

export type ReferralProgramInput = {
    enabled?: unknown;
    inviterPoints?: unknown;
    inviteeRewardType?: unknown;
    inviteePoints?: unknown;
    inviteeCouponTemplateId?: unknown;
    minimumPaidCents?: unknown;
    coolingOffDays?: unknown;
    inviterMonthlyLimit?: unknown;
    campaignTotalLimit?: unknown;
    autoFreezeRisk?: unknown;
};

export type ReferralRegistrationInput = {
    inviteeUserId: string;
    referralCode: unknown;
    attributionSource?: unknown;
    attributionMetadata?: unknown;
    clientIp?: unknown;
    strict?: boolean;
};

export async function getReferralProgram() {
    await assertBillingDatabaseReady();
    const program = await createPostgresRepositories().referrals.getProgram();
    if (!program) throw new BillingInputError("邀请奖励设置不存在", 500);
    return program;
}

export async function saveReferralProgram(input: ReferralProgramInput, operatorUserId: string) {
    await assertBillingDatabaseReady();
    return withPostgresTransaction(async (client) => {
        const repos = createPostgresRepositories(client);
        const current = await repos.referrals.getProgram(true);
        if (!current) throw new BillingInputError("邀请奖励设置不存在", 500);
        const now = new Date().toISOString();
        if (input.inviteeRewardType !== undefined && input.inviteeRewardType !== "points" && input.inviteeRewardType !== "coupon") throw new BillingInputError("新用户奖励类型无效");
        const inviteeRewardType = input.inviteeRewardType === undefined ? current.inviteeRewardType : input.inviteeRewardType;
        const inviteeCouponTemplateId = input.inviteeCouponTemplateId === undefined ? current.inviteeCouponTemplateId : normalizeId(input.inviteeCouponTemplateId) || undefined;
        const program: ReferralProgramRecord = {
            ...current,
            enabled: input.enabled === undefined ? current.enabled : input.enabled === true,
            inviterPoints: normalizeMoneyLike(input.inviterPoints, current.inviterPoints, 1_000_000),
            inviteeRewardType,
            inviteePoints: normalizeMoneyLike(input.inviteePoints, current.inviteePoints, 1_000_000),
            inviteeCouponTemplateId: inviteeRewardType === "coupon" ? inviteeCouponTemplateId : undefined,
            minimumPaidCents: normalizeInteger(input.minimumPaidCents, 0, 100_000_000, current.minimumPaidCents),
            coolingOffDays: normalizeInteger(input.coolingOffDays, 0, 365, current.coolingOffDays),
            inviterMonthlyLimit: normalizeInteger(input.inviterMonthlyLimit, 0, 100_000, current.inviterMonthlyLimit),
            campaignTotalLimit: normalizeInteger(input.campaignTotalLimit, 0, 10_000_000, current.campaignTotalLimit),
            autoFreezeRisk: input.autoFreezeRisk === undefined ? current.autoFreezeRisk : input.autoFreezeRisk !== false,
            createdByUserId: current.createdByUserId || operatorUserId,
            updatedByUserId: operatorUserId,
            updatedAt: now,
        };
        if (program.enabled && program.inviterPoints <= 0) throw new BillingInputError("启用邀请奖励前，请配置大于 0 的邀请人余额");
        if (program.enabled && program.inviteeRewardType === "points" && program.inviteePoints <= 0) throw new BillingInputError("启用邀请奖励前，请配置大于 0 的新用户余额");
        if (program.inviteeRewardType === "coupon") {
            if (!program.inviteeCouponTemplateId) throw new BillingInputError("请选择新用户优惠券模板");
            const template = await repos.coupons.getTemplateById(program.inviteeCouponTemplateId);
            if (!template || !template.enabled) throw new BillingInputError("新用户优惠券不存在或已停用", 404);
        }
        return repos.referrals.upsertProgram(program);
    });
}

export async function getOrCreateReferralCode(userId: string, db?: QueryExecutor) {
    await assertBillingDatabaseReady();
    const run = async (client: QueryExecutor) => {
        const repos = createPostgresRepositories(client);
        const user = await repos.users.getById(userId);
        if (!user || user.status !== "active") throw new BillingInputError("用户不可用", 403);
        const existing = await repos.referrals.getCodeByUserId(userId);
        if (existing) return existing;
        const now = new Date().toISOString();
        const created = await repos.referrals.createCode({ id: randomUUID(), userId, code: referralCodeForAccountId(user.accountId), enabled: true, clickCount: 0, createdAt: now, updatedAt: now });
        if (created) return created;
        const concurrent = await repos.referrals.getCodeByUserId(userId);
        if (concurrent) return concurrent;
        throw new BillingInputError("生成邀请码失败，请稍后重试", 409);
    };
    return db ? run(db) : withPostgresTransaction(run);
}

export async function recordReferralVisit(codeInput: unknown, options: { countClick?: boolean } = {}) {
    await assertBillingDatabaseReady();
    const code = normalizeReferralCode(codeInput);
    if (!code) return null;
    return withPostgresTransaction(async (client) => {
        const repos = createPostgresRepositories(client);
        const program = await repos.referrals.getProgram();
        if (!program?.enabled) return null;
        if (options.countClick === false) {
            const referralCode = await repos.referrals.getCodeByCode(code);
            return referralCode?.enabled ? referralCode : null;
        }
        return repos.referrals.recordClick(code, new Date().toISOString());
    });
}

export async function bindReferralRelationshipAfterRegistration(client: QueryExecutor, input: ReferralRegistrationInput) {
    const code = normalizeReferralCode(input.referralCode);
    if (!code) return null;
    const repos = createPostgresRepositories(client);
    const program = await repos.referrals.getProgram(true);
    if (!program?.enabled) {
        if (input.strict) throw new BillingInputError("邀请活动当前未开放", 409);
        return null;
    }
    const referralCode = await repos.referrals.getCodeByCode(code, true);
    if (!referralCode?.enabled) {
        if (input.strict) throw new BillingInputError("邀请码无效或已停用", 400);
        return null;
    }
    if (referralCode.userId === input.inviteeUserId) throw new BillingInputError("不能使用自己的邀请码", 409);
    const inviter = await repos.users.getById(referralCode.userId, true);
    if (!inviter || inviter.status !== "active") throw new BillingInputError("邀请人账号不可用", 409);
    if (await repos.referrals.getRelationshipByInviteeUserId(input.inviteeUserId, true)) throw new BillingInputError("当前账号已绑定邀请关系", 409);
    if (await repos.referrals.hasReverseRelationship(referralCode.userId, input.inviteeUserId)) throw new BillingInputError("不能建立循环邀请关系", 409);

    const now = new Date();
    const registrationIpHash = hashReferralRiskValue("registration-ip", input.clientIp);
    const recentMatches = registrationIpHash ? await repos.referrals.countRecentIpMatches(referralCode.userId, registrationIpHash, new Date(now.getTime() - REGISTRATION_NETWORK_WINDOW_MS).toISOString()) : 0;
    const networkMatchCount = recentMatches + 1;
    const riskyNetwork = networkMatchCount >= REGISTRATION_NETWORK_REVIEW_COUNT;
    const riskStatus: ReferralRiskStatus = riskyNetwork ? (program.autoFreezeRisk ? "frozen" : "review") : "clear";
    const riskSignals: JsonValue = riskyNetwork ? { registrationNetworkMatchCount: networkMatchCount } : {};
    const nowIso = now.toISOString();
    const relationship: ReferralRelationshipRecord = {
        id: randomUUID(),
        inviterUserId: referralCode.userId,
        inviteeUserId: input.inviteeUserId,
        referralCodeId: referralCode.id,
        attributionSource: normalizeText(input.attributionSource, "registration-form", 80),
        attributionMetadata: sanitizeReferralMetadata(input.attributionMetadata),
        registrationIpHash,
        riskStatus,
        riskSignals,
        registeredAt: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso,
    };
    return repos.referrals.createRelationship(relationship);
}

export async function prepareReferralRewardsForPaidOrder(client: QueryExecutor, input: { order: BillingOrderRecord; provider: string; rawPayload?: JsonValue; paidAt: string }) {
    const { order } = input;
    if (!order.userId) return [];
    const repos = createPostgresRepositories(client);
    const relationship = await repos.referrals.getRelationshipByInviteeUserId(order.userId, true);
    if (!relationship) return [];
    const existing = await repos.referrals.getRewardsByRelationship(relationship.id, true);
    if (existing.length) return existing;
    const program = await repos.referrals.getProgram(true);
    if (!program?.enabled) return [];

    let nextRelationship = relationship;
    const paymentIdentityHash = extractPaymentIdentityHash(input.provider, input.rawPayload);
    if (paymentIdentityHash) {
        const matches = await repos.referrals.countPaymentIdentityMatches(paymentIdentityHash, order.userId);
        const riskSignals = mergeJsonObject(relationship.riskSignals, matches > 0 ? { paymentIdentityAccountCount: matches + 1 } : {});
        nextRelationship =
            (await repos.referrals.updateRelationship(relationship.id, {
                paymentIdentityHash,
                riskSignals,
                ...(matches > 0 ? { riskStatus: program.autoFreezeRisk ? "frozen" : "review" } : {}),
            })) || relationship;
    }

    const priorPaidOrder = await repos.referrals.hasPriorPaidOrder(order.userId, order.id);
    const rejectionReason = priorPaidOrder ? "当前订单不是受邀用户首笔实付订单" : order.amountCents < program.minimumPaidCents ? "首笔实付金额未达到邀请奖励门槛" : "";
    const createdAt = input.paidAt;
    const settleAfter = new Date(Date.parse(input.paidAt) + program.coolingOffDays * 24 * 60 * 60_000).toISOString();
    const initialStatus = rejectionReason ? "rejected" : "pending";
    const rewards: ReferralRewardRecord[] = [
        buildReferralReward({
            relationship: nextRelationship,
            role: "inviter",
            userId: nextRelationship.inviterUserId,
            type: "points",
            points: program.inviterPoints,
            orderId: order.id,
            status: initialStatus,
            reason: rejectionReason,
            settleAfter,
            createdAt,
        }),
        buildReferralReward({
            relationship: nextRelationship,
            role: "invitee",
            userId: nextRelationship.inviteeUserId,
            type: program.inviteeRewardType,
            points: program.inviteePoints,
            couponTemplateId: program.inviteeCouponTemplateId,
            orderId: order.id,
            status: initialStatus,
            reason: rejectionReason,
            settleAfter,
            createdAt,
        }),
    ];
    const created = (await Promise.all(rewards.map((reward) => repos.referrals.createReward(reward)))).filter(Boolean) as ReferralRewardRecord[];
    if (!rejectionReason && program.coolingOffDays === 0 && nextRelationship.riskStatus === "clear") await settleRelationshipRewards(client, nextRelationship.id, input.paidAt);
    return created.length ? created : repos.referrals.getRewardsByRelationship(nextRelationship.id);
}

export async function settleDueReferralRewards(input: { now?: Date; limit?: number } = {}) {
    await assertBillingDatabaseReady();
    const now = input.now || new Date();
    const limit = normalizeInteger(input.limit, 1, 100, 50);
    return withPostgresTransaction(async (client) => {
        await lockAuthMutation(client);
        const repos = createPostgresRepositories(client);
        const program = await repos.referrals.getProgram(true);
        if (!program?.enabled) return { processed: 0, settled: 0, rejected: 0 };
        const due = await repos.referrals.lockDueRewards(now.toISOString(), limit);
        const relationshipIds = [...new Set(due.map((reward) => reward.relationshipId))];
        let settled = 0;
        let rejected = 0;
        for (const relationshipId of relationshipIds) {
            const result = await settleRelationshipRewards(client, relationshipId, now.toISOString());
            settled += result.settled;
            rejected += result.rejected;
        }
        return { processed: relationshipIds.length, settled, rejected };
    });
}

export async function reverseReferralRewardsForRefundedOrder(client: QueryExecutor, input: { orderId: string; refundedAt: string; reason?: string }) {
    const repos = createPostgresRepositories(client);
    const rewards = await repos.referrals.getRewardsByTriggerOrder(input.orderId, true);
    if (!rewards.length) return [];
    return reverseReferralRewardSet(client, rewards, {
        reason: input.reason || "触发订单已退款",
        revokedAt: input.refundedAt,
        pendingStatus: "revoked",
        conflictRiskStatus: "frozen",
    });
}

async function reverseReferralRewardSet(client: QueryExecutor, rewards: ReferralRewardRecord[], input: { reason: string; revokedAt: string; pendingStatus: "revoked" | "rejected"; conflictRiskStatus: ReferralRiskStatus }) {
    const repos = createPostgresRepositories(client);
    const updated: ReferralRewardRecord[] = [];
    for (const reward of rewards) {
        if (reward.status === "pending") {
            const next = await repos.referrals.updateReward(reward.id, { status: input.pendingStatus, reason: input.reason, revokedAt: input.revokedAt });
            if (next) updated.push(next);
            continue;
        }
        if (reward.status !== "settled") {
            updated.push(reward);
            continue;
        }
        if (reward.rewardType === "points") {
            const reversal = await adjustPermanentPointsInPostgresTransaction(client, {
                userId: reward.beneficiaryUserId,
                amount: -reward.pointsAmount,
                description: "邀请奖励撤销：触发订单已退款",
                idempotencyKey: `referral-reward:${reward.id}:reversal`,
                type: "admin-adjust",
                requireActive: false,
                now: new Date(input.revokedAt),
            });
            const next = await repos.referrals.updateReward(reward.id, { status: "revoked", reversalWalletRecordId: reversal?.record.id, reason: input.reason, revokedAt: input.revokedAt });
            if (next) updated.push(next);
            continue;
        }
        const coupon = reward.userCouponId ? await repos.coupons.getUserCouponById(reward.userCouponId, true) : null;
        if (!coupon || coupon.status === "available" || coupon.status === "expired" || coupon.status === "revoked") {
            if (coupon && coupon.status !== "revoked") await repos.coupons.updateUserCoupon(coupon.id, { status: "revoked", revokedAt: input.revokedAt, lockedOrderId: undefined, lockedAt: undefined });
            const next = await repos.referrals.updateReward(reward.id, { status: "revoked", reason: input.reason, revokedAt: input.revokedAt });
            if (next) updated.push(next);
            continue;
        }
        const relationship = await repos.referrals.getRelationshipById(reward.relationshipId, true);
        if (relationship) {
            await repos.referrals.updateRelationship(relationship.id, {
                riskStatus: input.conflictRiskStatus,
                riskSignals: mergeJsonObject(relationship.riskSignals, { couponReversalConflict: coupon.status }),
            });
        }
        const next = await repos.referrals.updateReward(reward.id, { status: "reversal_pending", reason: `奖励优惠券已${coupon.status === "locked" ? "被订单锁定" : "核销"}，需人工复核`, revokedAt: input.revokedAt });
        if (next) updated.push(next);
    }
    return updated;
}

export async function getReferralCenter(userId: string, origin: string, input: { referralsPage?: unknown; rewardsPage?: unknown; pageSize?: unknown } = {}) {
    await assertBillingDatabaseReady();
    const repos = createPostgresRepositories();
    const referralsPage = normalizeInteger(input.referralsPage, 1, 100_000, 1);
    const rewardsPage = normalizeInteger(input.rewardsPage, 1, 100_000, 1);
    const pageSize = normalizeInteger(input.pageSize, 1, 50, 8);
    const [program, code, stats, relationships, rewards] = await Promise.all([
        repos.referrals.getProgram(),
        getOrCreateReferralCode(userId),
        repos.referrals.getUserStats(userId),
        repos.referrals.listRelationships({ inviterUserId: userId, page: referralsPage, pageSize }),
        repos.referrals.listRewards({ beneficiaryUserId: userId, page: rewardsPage, pageSize }),
    ]);
    if (!program) throw new BillingInputError("邀请奖励设置不存在", 500);
    return {
        program: publicReferralProgram(program),
        code: code.code,
        link: `${normalizeOrigin(origin)}/invite/${encodeURIComponent(code.code)}`,
        stats,
        referrals: relationships.items.map((relationship) => ({
            id: relationship.id,
            inviteeName: maskDisplayName(relationship.inviteeDisplayName || relationship.inviteeUsername || "新用户"),
            riskStatus: relationship.riskStatus,
            registeredAt: relationship.registeredAt,
        })),
        referralsTotal: relationships.total,
        referralsPage: relationships.page,
        referralsPageSize: relationships.pageSize,
        rewards: rewards.items,
        rewardsTotal: rewards.total,
        rewardsPage: rewards.page,
        rewardsPageSize: rewards.pageSize,
    };
}

export async function getAdminReferralOverview() {
    await assertBillingDatabaseReady();
    const repos = createPostgresRepositories();
    const [program, stats] = await Promise.all([repos.referrals.getProgram(), repos.referrals.getAdminStats()]);
    if (!program) throw new BillingInputError("邀请奖励设置不存在", 500);
    return { program, stats };
}

export async function listAdminReferralRelationships(input: { page?: unknown; pageSize?: unknown; keyword?: unknown; riskStatus?: unknown }) {
    await assertBillingDatabaseReady();
    const riskStatus = normalizeRiskStatus(input.riskStatus);
    return createPostgresRepositories().referrals.listRelationships({
        page: normalizeInteger(input.page, 1, 100_000, 1),
        pageSize: normalizeInteger(input.pageSize, 1, 100, 20),
        keyword: normalizeText(input.keyword, "", 120),
        riskStatus,
    });
}

export async function listAdminReferralRewards(input: { page?: unknown; pageSize?: unknown; status?: unknown }) {
    await assertBillingDatabaseReady();
    const status = normalizeRewardStatus(input.status);
    return createPostgresRepositories().referrals.listRewards({
        page: normalizeInteger(input.page, 1, 100_000, 1),
        pageSize: normalizeInteger(input.pageSize, 1, 100, 20),
        status,
    });
}

export async function updateReferralRelationshipRisk(input: { id: unknown; riskStatus: unknown; reason?: unknown }) {
    await assertBillingDatabaseReady();
    return withPostgresTransaction(async (client) => {
        const repos = createPostgresRepositories(client);
        const id = normalizeId(input.id);
        const riskStatus = normalizeRiskStatus(input.riskStatus);
        if (!id || !riskStatus) throw new BillingInputError("风险处置参数无效");
        const relationship = await repos.referrals.getRelationshipById(id, true);
        if (!relationship) throw new BillingInputError("邀请关系不存在", 404);
        const reason = normalizeText(input.reason, "管理员人工处置", 240);
        let updated = await repos.referrals.updateRelationship(id, { riskStatus, riskSignals: mergeJsonObject(relationship.riskSignals, { adminDecision: reason }) });
        if (riskStatus === "rejected") {
            const rewards = await repos.referrals.getRewardsByRelationship(id, true);
            await reverseReferralRewardSet(client, rewards, {
                reason,
                revokedAt: new Date().toISOString(),
                pendingStatus: "rejected",
                conflictRiskStatus: "rejected",
            });
            updated = await repos.referrals.getRelationshipById(id, true);
        }
        return updated;
    });
}

async function settleRelationshipRewards(client: QueryExecutor, relationshipId: string, nowIso: string) {
    const repos = createPostgresRepositories(client);
    const relationship = await repos.referrals.getRelationshipById(relationshipId, true);
    if (!relationship || relationship.riskStatus !== "clear") return { settled: 0, rejected: 0 };
    const program = await repos.referrals.getProgram(true);
    if (!program?.enabled) return { settled: 0, rejected: 0 };
    const rewards = await repos.referrals.getRewardsByRelationship(relationshipId, true);
    const pending = rewards.filter((reward) => reward.status === "pending" && Date.parse(reward.settleAfter) <= Date.parse(nowIso));
    if (!pending.length) return { settled: 0, rejected: 0 };
    await repos.users.getById(relationship.inviterUserId, true);
    const month = monthBounds(nowIso);
    const inviterCounts = await repos.referrals.countSettledInviterRewards(relationship.inviterUserId, month.start, month.end);
    const campaignTotal = await repos.referrals.countAllSettledInviterRewards();
    const limitReason =
        program.inviterMonthlyLimit > 0 && inviterCounts.monthly >= program.inviterMonthlyLimit ? "邀请人本月奖励名额已达上限" : program.campaignTotalLimit > 0 && campaignTotal >= program.campaignTotalLimit ? "邀请活动累计奖励名额已达上限" : "";
    if (limitReason) {
        for (const reward of pending) await repos.referrals.updateReward(reward.id, { status: "rejected", reason: limitReason });
        return { settled: 0, rejected: pending.length };
    }

    const savepoint = "referral_reward_settlement";
    await client.query(`SAVEPOINT ${savepoint}`);
    try {
        const couponRewards = pending.filter((reward) => reward.rewardType === "coupon");
        const pointRewards = pending.filter((reward) => reward.rewardType === "points");
        let settled = 0;
        for (const reward of couponRewards) {
            const coupon = await issueCouponInPostgresTransaction(client, { userId: reward.beneficiaryUserId, templateId: reward.couponTemplateId, source: "referral", now: new Date(nowIso) });
            await repos.referrals.updateReward(reward.id, { status: "settled", userCouponId: coupon.id, settledAt: nowIso });
            settled += 1;
        }
        for (const reward of pointRewards) {
            const adjustment = await adjustPermanentPointsInPostgresTransaction(client, {
                userId: reward.beneficiaryUserId,
                amount: reward.pointsAmount,
                description: reward.beneficiaryRole === "inviter" ? "邀请奖励：新用户完成首笔有效支付" : "新用户邀请奖励",
                idempotencyKey: `referral-reward:${reward.id}:credit`,
                type: "credit",
                now: new Date(nowIso),
            });
            if (!adjustment?.record) throw new BillingInputError("邀请余额奖励金额无效", 409);
            await repos.referrals.updateReward(reward.id, { status: "settled", walletRecordId: adjustment.record.id, settledAt: nowIso });
            settled += 1;
        }
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        return { settled, rejected: 0 };
    } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        if (!(error instanceof BillingInputError)) throw error;
        const reason = `奖励发放失败：${error.message}`;
        for (const reward of pending) await repos.referrals.updateReward(reward.id, { status: "rejected", reason });
        return { settled: 0, rejected: pending.length };
    }
}

function buildReferralReward(input: {
    relationship: ReferralRelationshipRecord;
    role: "inviter" | "invitee";
    userId: string;
    type: "points" | "coupon";
    points: number;
    couponTemplateId?: string;
    orderId: string;
    status: "pending" | "rejected";
    reason: string;
    settleAfter: string;
    createdAt: string;
}): ReferralRewardRecord {
    return {
        id: randomUUID(),
        relationshipId: input.relationship.id,
        beneficiaryUserId: input.userId,
        beneficiaryRole: input.role,
        rewardType: input.type,
        pointsAmount: input.type === "points" ? input.points : 0,
        couponTemplateId: input.type === "coupon" ? input.couponTemplateId : undefined,
        triggerOrderId: input.orderId,
        status: input.status,
        settleAfter: input.settleAfter,
        reason: input.reason || undefined,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
    };
}

function publicReferralProgram(program: ReferralProgramRecord) {
    return {
        enabled: program.enabled,
        inviterPoints: program.inviterPoints,
        inviteeRewardType: program.inviteeRewardType,
        inviteePoints: program.inviteePoints,
        minimumPaidCents: program.minimumPaidCents,
        coolingOffDays: program.coolingOffDays,
    };
}

export function normalizeReferralCode(value: unknown) {
    return normalizeText(value, "", 24)
        .toUpperCase()
        .replace(/[^0-9A-Z]/g, "");
}

function referralCodeForAccountId(accountId: string) {
    const normalized = accountId.trim();
    if (!/^\d+$/.test(normalized)) throw new BillingInputError("用户公开账号 ID 无效", 500);
    return `VZ${normalized}`;
}

function hashReferralRiskValue(kind: string, value: unknown) {
    const text = typeof value === "string" ? value.trim() : "";
    const secret = process.env.VOZEB_PRO_ENCRYPTION_KEY?.trim() || "";
    if (!text || !secret) return undefined;
    return createHmac("sha256", secret).update(`${kind}\0${text}`).digest("hex");
}

function extractPaymentIdentityHash(provider: string, payload: JsonValue | undefined) {
    const paths = ["customer", "customer_id", "buyer_id", "buyer_user_id", "payer.openid", "payer.user_id", "payerId", "payer_id", "userId", "user_id", "data.customer", "data.buyer_id", "data.payer.openid"];
    for (const path of paths) {
        const value = readJsonPath(payload, path);
        if (typeof value === "string" || typeof value === "number") {
            const hash = hashReferralRiskValue(`payment:${provider}`, String(value));
            if (hash) return hash;
        }
    }
    return undefined;
}

function readJsonPath(value: JsonValue | undefined, path: string): JsonValue | undefined {
    let current: JsonValue | undefined = value;
    for (const part of path.split(".")) {
        if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
        current = current[part];
    }
    return current;
}

function sanitizeReferralMetadata(value: unknown): JsonValue {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const allowed = ["campaign", "medium", "source", "sharePath"];
    return Object.fromEntries(
        allowed.flatMap((key) => {
            const item = (value as Record<string, unknown>)[key];
            const text = normalizeText(item, "", 160);
            return text ? [[key, text]] : [];
        }),
    );
}

function mergeJsonObject(current: JsonValue, patch: Record<string, JsonValue>): JsonValue {
    const source = current && typeof current === "object" && !Array.isArray(current) ? current : {};
    return { ...source, ...patch };
}

function normalizeRiskStatus(value: unknown): ReferralRiskStatus | undefined {
    if (value === "clear" || value === "review" || value === "frozen" || value === "rejected") return value;
    return undefined;
}

function normalizeRewardStatus(value: unknown): ReferralRewardStatus | undefined {
    if (value === "pending" || value === "settled" || value === "revoked" || value === "rejected" || value === "reversal_pending") return value;
    return undefined;
}

function monthBounds(value: string) {
    const date = new Date(value);
    const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
    const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
    return { start: start.toISOString(), end: end.toISOString() };
}

function normalizeOrigin(origin: string) {
    try {
        return new URL(origin).origin.replace(/\/+$/, "");
    } catch {
        return (process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000").replace(/\/+$/, "");
    }
}

function maskDisplayName(value: string) {
    const text = value.trim();
    if (!text) return "新用户";
    return `${text.slice(0, 1)}${"*".repeat(Math.min(4, Math.max(2, text.length - 1)))}`;
}
