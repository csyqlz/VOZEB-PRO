import { createHash, randomUUID } from "node:crypto";

import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";

import { AuthInputError, QuotaExceededError } from "@/lib/auth/store-foundation";
import { mutateAuthDb } from "@/lib/auth/store-repository";
import { normalizePointAmount, resolveDefaultPlan, resolveUserPlan } from "@/lib/auth/store-normalizers";
import type { AuthDatabase, PointRecordBillingDetail, PointUsageKind, PublicPointRecord, StoredDailyPlanPointWallet, StoredPointRecord, StoredUser } from "@/lib/auth/store-types";
import { createPostgresRepositories, ensurePostgresSchema, isPostgresDatabaseEnabled, withPostgresTransaction, type QueryExecutor } from "@/lib/server/database";
import type { AppSettingsRecord, EntitlementPlanRecord, JsonValue, UserPlanAssignmentRecord, UserRecord } from "@/lib/server/database/repository-shared";

dayjs.extend(utc);
dayjs.extend(timezone);

const DEFAULT_TIME_ZONE = "Asia/Shanghai";

export type PointsWalletSnapshot = {
    permanentPoints: number;
    dailyPoints: number;
    totalPoints: number;
    dailyDate: string;
    dailyExpiresAt: string;
    activePlanId?: string;
    activePlanName?: string;
    assignmentId?: string;
};

export type PointsWalletMutationResult = {
    snapshot: PointsWalletSnapshot;
    record: StoredPointRecord;
    applied: boolean;
};

export type PointsWalletRefundResult = PointsWalletMutationResult & {
    permanentRestored: number;
    dailyRestored: number;
    dailyExpired: number;
};

type WalletClockInput = {
    now?: Date;
    timeZone?: string;
};

type CreditPermanentPointsInput = WalletClockInput & {
    userId: string;
    amount: number;
    description: string;
    idempotencyKey: string;
    type?: "credit" | "admin-adjust";
    model?: string;
};

type AdjustPermanentPointsInput = WalletClockInput & {
    userId: string;
    amount: number;
    description: string;
    idempotencyKey: string;
};

type PostgresPermanentAdjustmentInput = AdjustPermanentPointsInput & {
    type: "credit" | "admin-adjust";
    minimumBalance?: number;
    requireActive?: boolean;
};

type ConsumePointsInput = WalletClockInput & {
    userId: string;
    amount: number;
    units: number;
    usageKind: PointUsageKind;
    model: string;
    description: string;
    idempotencyKey: string;
    requestFingerprint?: string;
    billingDetail?: PointRecordBillingDetail;
};

type RefundPointsInput = WalletClockInput & {
    userId: string;
    sourceRecordId?: string;
    sourceIdempotencyKey?: string;
    idempotencyKey: string;
    usageKind: PointUsageKind;
    units: number;
    model?: string;
    description: string;
    billingDetail?: PointRecordBillingDetail;
};

type WalletClock = {
    now: Date;
    date: string;
    expiresAt: string;
    timeZone: string;
};

type PostgresWalletContext = {
    user: UserRecord;
    wallet: StoredDailyPlanPointWallet | null;
    assignment: UserPlanAssignmentRecord | null;
    activePlan?: EntitlementPlanRecord;
    quotaPlan?: EntitlementPlanRecord;
    settings?: AppSettingsRecord;
    clock: WalletClock;
};

class PointsWalletConflictError extends AuthInputError {
    status = 409;
}

export function walletClock(input: WalletClockInput = {}): WalletClock {
    const now = input.now || new Date();
    const timeZone = validTimeZone(input.timeZone || process.env.VOZEB_PRO_TIME_ZONE || DEFAULT_TIME_ZONE);
    const zoned = dayjs(now).tz(timeZone);
    return {
        now,
        date: zoned.format("YYYY-MM-DD"),
        expiresAt: zoned.endOf("day").toISOString(),
        timeZone,
    };
}

export function splitPointConsumption(dailyPoints: number, permanentPoints: number, amount: number) {
    const cost = positivePoints(amount);
    const dailyAvailable = nonNegativePoints(dailyPoints);
    const permanentAvailable = normalizePointAmount(permanentPoints, 0);
    const totalAvailable = Math.max(0, normalizePointAmount(dailyAvailable + permanentAvailable, 0));
    if (cost > totalAvailable) throw new QuotaExceededError("人民币余额不足");
    const dailyDebit = Math.min(dailyAvailable, cost);
    return { cost, dailyDebit, permanentDebit: normalizePointAmount(cost - dailyDebit, 0) };
}

export async function getPointsWalletSnapshot(userId: string, input: WalletClockInput = {}) {
    if (isPostgresDatabaseEnabled()) return getPostgresSnapshot(userId, input);
    return mutateAuthDb((db) => snapshotFileWallet(db, userId, walletClock(input)));
}

export async function creditPermanentPoints(input: CreditPermanentPointsInput): Promise<PointsWalletMutationResult> {
    const amount = positivePoints(input.amount);
    const idempotencyKey = requiredIdempotencyKey(input.idempotencyKey);
    if (!amount) throw new AuthInputError("人民币余额金额必须大于零");
    if (isPostgresDatabaseEnabled()) return creditPostgresPoints({ ...input, amount, idempotencyKey });
    return mutateAuthDb((db) => creditFilePoints(db, { ...input, amount, idempotencyKey }, walletClock(input)));
}

export function creditPermanentPointsInAuthDb(db: AuthDatabase, input: CreditPermanentPointsInput): PointsWalletMutationResult {
    const amount = positivePoints(input.amount);
    if (!amount) throw new AuthInputError("人民币余额金额必须大于零");
    return creditFilePoints(db, { ...input, amount, idempotencyKey: requiredIdempotencyKey(input.idempotencyKey) }, walletClock(input));
}

export function adjustPermanentPointsInAuthDb(db: AuthDatabase, input: AdjustPermanentPointsInput): PointsWalletMutationResult | null {
    const amount = normalizePointAmount(input.amount, 0);
    if (!amount) return null;
    const idempotencyKey = requiredIdempotencyKey(input.idempotencyKey);
    const clock = walletClock(input);
    const user = db.users.find((item) => item.id === input.userId);
    if (!user || user.status !== "active") throw new AuthInputError("用户不可用");
    const existing = db.pointRecords.find((record) => record.idempotencyKey === idempotencyKey);
    const snapshotBefore = snapshotFileWallet(db, user.id, clock);
    if (existing) return existingFileMutation(existing, snapshotBefore, user.id, "admin-adjust");

    user.pointsBalance = normalizePointAmount(user.pointsBalance + amount, 0);
    user.updatedAt = clock.now.toISOString();
    const snapshot = snapshotFileWallet(db, user.id, clock);
    const record: PublicPointRecord = {
        id: randomUUID(),
        userId: user.id,
        type: "admin-adjust",
        amount,
        balanceAfter: snapshot.totalPoints,
        permanentAmount: amount,
        dailyAmount: 0,
        permanentBalanceAfter: snapshot.permanentPoints,
        dailyBalanceAfter: snapshot.dailyPoints,
        description: input.description,
        idempotencyKey,
        createdAt: clock.now.toISOString(),
    };
    db.pointRecords.push(record);
    return { snapshot, record, applied: true };
}

export async function consumePoints(input: ConsumePointsInput): Promise<PointsWalletMutationResult> {
    const amount = normalizePointAmount(input.amount, -1);
    const idempotencyKey = requiredIdempotencyKey(input.idempotencyKey);
    const requestFingerprint = consumptionRequestFingerprint({ ...input, amount });
    if (amount < 0) throw new AuthInputError("本次人民币余额消费不能小于零");
    if (isPostgresDatabaseEnabled()) return consumePostgresPoints({ ...input, amount, idempotencyKey, requestFingerprint });
    return mutateAuthDb((db) => consumeFilePoints(db, { ...input, amount, idempotencyKey, requestFingerprint }, walletClock(input)));
}

export async function refundPoints(input: RefundPointsInput): Promise<PointsWalletRefundResult> {
    const idempotencyKey = requiredIdempotencyKey(input.idempotencyKey);
    if (!input.sourceRecordId?.trim() && !input.sourceIdempotencyKey?.trim()) throw new AuthInputError("退款缺少原消费记录");
    if (isPostgresDatabaseEnabled()) return refundPostgresPoints({ ...input, idempotencyKey });
    return mutateAuthDb((db) => refundFilePoints(db, { ...input, idempotencyKey }, walletClock(input)));
}

export async function adjustPermanentPointsInPostgresTransaction(client: QueryExecutor, input: PostgresPermanentAdjustmentInput): Promise<PointsWalletMutationResult | null> {
    const requestedAmount = normalizePointAmount(input.amount, 0);
    if (!requestedAmount) return null;
    const idempotencyKey = requiredIdempotencyKey(input.idempotencyKey);
    const repos = createPostgresRepositories(client);
    const user = await repos.users.getById(input.userId, true);
    if (!user || (input.requireActive !== false && user.status !== "active")) throw new AuthInputError("用户不可用");
    const existing = await repos.points.getRecordByIdempotencyKey(idempotencyKey);
    const context = await settlePostgresWallet(client, user, walletClock(input));
    if (existing) return existingMutation(existing, context, input.userId, input.type);

    const minimumBalance = input.minimumBalance === undefined ? Number.NEGATIVE_INFINITY : normalizePointAmount(input.minimumBalance, 0);
    const nextPermanentPoints = Math.max(minimumBalance, normalizePointAmount(user.pointsBalance + requestedAmount, 0));
    const appliedAmount = normalizePointAmount(nextPermanentPoints - user.pointsBalance, 0);
    if (!appliedAmount) return null;
    const updatedUser = await repos.users.update(user.id, { pointsBalance: nextPermanentPoints });
    if (!updatedUser) throw new AuthInputError("用户不存在");
    context.user = updatedUser;
    const snapshot = postgresSnapshot(context);
    const record = await repos.points.addRecord({
        id: randomUUID(),
        userId: user.id,
        type: input.type,
        amount: appliedAmount,
        balanceAfter: snapshot.totalPoints,
        permanentAmount: appliedAmount,
        dailyAmount: 0,
        permanentBalanceAfter: snapshot.permanentPoints,
        dailyBalanceAfter: snapshot.dailyPoints,
        description: input.description,
        idempotencyKey,
        createdAt: context.clock.now.toISOString(),
    });
    return { snapshot, record, applied: true };
}

async function getPostgresSnapshot(userId: string, input: WalletClockInput) {
    await ensurePostgresSchema();
    return withPostgresTransaction(async (client) => {
        const repos = createPostgresRepositories(client);
        const user = await repos.users.getById(userId, true);
        if (!user || user.status !== "active") throw new AuthInputError("用户不可用");
        return postgresSnapshot(await settlePostgresWallet(client, user, walletClock(input)));
    });
}

async function creditPostgresPoints(input: CreditPermanentPointsInput & { amount: number; idempotencyKey: string }) {
    await ensurePostgresSchema();
    return withPostgresTransaction(async (client) => {
        const repos = createPostgresRepositories(client);
        const user = await repos.users.getById(input.userId, true);
        if (!user || user.status !== "active") throw new AuthInputError("用户不可用");
        const existing = await repos.points.getRecordByIdempotencyKey(input.idempotencyKey);
        const context = await settlePostgresWallet(client, user, walletClock(input));
        if (existing) return existingMutation(existing, context, input.userId, input.type || "credit");

        const permanentPoints = normalizePointAmount(user.pointsBalance + input.amount, 0);
        const updatedUser = await repos.users.update(user.id, { pointsBalance: permanentPoints });
        if (!updatedUser) throw new AuthInputError("用户不存在");
        context.user = updatedUser;
        const snapshot = postgresSnapshot(context);
        const record = await repos.points.addRecord({
            id: randomUUID(),
            userId: user.id,
            type: input.type || "credit",
            amount: input.amount,
            balanceAfter: snapshot.totalPoints,
            permanentAmount: input.amount,
            dailyAmount: 0,
            permanentBalanceAfter: snapshot.permanentPoints,
            dailyBalanceAfter: snapshot.dailyPoints,
            description: input.description,
            model: input.model?.trim(),
            idempotencyKey: input.idempotencyKey,
            createdAt: context.clock.now.toISOString(),
        });
        return { snapshot, record, applied: true };
    });
}

async function consumePostgresPoints(input: ConsumePointsInput & { amount: number; idempotencyKey: string; requestFingerprint: string }) {
    await ensurePostgresSchema();
    return withPostgresTransaction(async (client) => {
        const repos = createPostgresRepositories(client);
        const user = await repos.users.getById(input.userId, true);
        if (!user || user.status !== "active") throw new AuthInputError("用户不可用");
        const existing = await repos.points.getRecordByIdempotencyKey(input.idempotencyKey);
        const context = await settlePostgresWallet(client, user, walletClock(input));
        if (existing) {
            assertMatchingConsumption(existing, input);
            return existingMutation(existing, context, input.userId, "consume");
        }

        const split = splitPointConsumption(context.wallet?.remainingPoints || 0, user.pointsBalance, input.amount);
        await assertPostgresQuota(client, context, input.usageKind, input.units, split.cost);
        if (split.dailyDebit && context.wallet) {
            const wallet = await repos.pointsWallet.updateRemaining(user.id, context.clock.date, normalizePointAmount(context.wallet.remainingPoints - split.dailyDebit, 0));
            if (!wallet) throw new Error("更新今日套餐余额失败");
            context.wallet = wallet;
        }
        if (split.permanentDebit) {
            const updatedUser = await repos.users.update(user.id, { pointsBalance: normalizePointAmount(user.pointsBalance - split.permanentDebit, 0) });
            if (!updatedUser) throw new AuthInputError("用户不存在");
            context.user = updatedUser;
        }
        await updatePostgresQuota(client, context.settings, context.clock.date, input.userId, input.usageKind, input.units, split.cost, context.clock.now.toISOString());
        const snapshot = postgresSnapshot(context);
        const record = await repos.points.addRecord({
            id: randomUUID(),
            userId: user.id,
            type: "consume",
            amount: split.cost ? -split.cost : 0,
            balanceAfter: snapshot.totalPoints,
            permanentAmount: split.permanentDebit ? -split.permanentDebit : 0,
            dailyAmount: split.dailyDebit ? -split.dailyDebit : 0,
            permanentBalanceAfter: snapshot.permanentPoints,
            dailyBalanceAfter: snapshot.dailyPoints,
            description: input.description,
            model: input.model.trim(),
            usageKind: input.usageKind,
            units: normalizePointAmount(input.units, 0),
            billingDetail: input.billingDetail,
            idempotencyKey: input.idempotencyKey,
            requestFingerprint: input.requestFingerprint,
            sourceDate: context.clock.date,
            createdAt: context.clock.now.toISOString(),
        });
        return { snapshot, record, applied: true };
    });
}

async function refundPostgresPoints(input: RefundPointsInput & { idempotencyKey: string }) {
    await ensurePostgresSchema();
    return withPostgresTransaction(async (client) => {
        const repos = createPostgresRepositories(client);
        const user = await repos.users.getById(input.userId, true);
        if (!user) throw new AuthInputError("用户不存在");
        const existing = await repos.points.getRecordByIdempotencyKey(input.idempotencyKey);
        const source = input.sourceRecordId?.trim() ? await repos.points.getRecordById(input.sourceRecordId.trim()) : await repos.points.getRecordByIdempotencyKey(input.sourceIdempotencyKey!.trim());
        if (!source || source.userId !== input.userId || source.type !== "consume") throw new AuthInputError("原消费记录不存在");
        const priorRefund = await repos.points.getRefundRecordBySourceRecordId(source.id);
        const context = await settlePostgresWallet(client, user, walletClock(input));
        if (existing) return existingRefund(existing, context, input.userId);
        if (priorRefund) return existingRefund(priorRefund, context, input.userId);

        const restored = resolveRefund(source, context.clock.date, Boolean(context.wallet && context.assignment?.id === context.wallet.assignmentId), context.wallet);
        if (restored.dailyRestored && context.wallet) {
            const wallet = await repos.pointsWallet.updateRemaining(user.id, context.clock.date, normalizePointAmount(context.wallet.remainingPoints + restored.dailyRestored, 0));
            if (!wallet) throw new Error("恢复今日套餐余额失败");
            context.wallet = wallet;
        }
        if (restored.permanentRestored) {
            const updatedUser = await repos.users.update(user.id, { pointsBalance: normalizePointAmount(user.pointsBalance + restored.permanentRestored, 0) });
            if (!updatedUser) throw new AuthInputError("用户不存在");
            context.user = updatedUser;
        }
        await updatePostgresQuota(client, context.settings, source.sourceDate || context.clock.date, user.id, input.usageKind, -nonNegativePoints(input.units), -positivePoints(-source.amount), context.clock.now.toISOString());
        const snapshot = postgresSnapshot(context);
        const record = await repos.points.addRecord({
            id: randomUUID(),
            userId: user.id,
            type: "refund",
            amount: normalizePointAmount(restored.permanentRestored + restored.dailyRestored, 0),
            balanceAfter: snapshot.totalPoints,
            permanentAmount: restored.permanentRestored,
            dailyAmount: restored.dailyRestored,
            permanentBalanceAfter: snapshot.permanentPoints,
            dailyBalanceAfter: snapshot.dailyPoints,
            description: restored.dailyExpired ? `${input.description}（${restored.dailyExpired} 今日余额已过期）` : input.description,
            model: input.model?.trim() || source.model,
            usageKind: input.usageKind,
            units: normalizePointAmount(input.units, 0),
            billingDetail: input.billingDetail || source.billingDetail,
            idempotencyKey: input.idempotencyKey,
            sourceRecordId: source.id,
            sourceDate: source.sourceDate,
            createdAt: context.clock.now.toISOString(),
        });
        return { snapshot, record, applied: true, ...restored };
    });
}

async function settlePostgresWallet(client: QueryExecutor, user: UserRecord, clock: WalletClock): Promise<PostgresWalletContext> {
    const repos = createPostgresRepositories(client);
    const settingsData = await repos.settings.getWalletSettings();
    const assignment = await repos.billing.getActivePlanAssignment(user.id, clock.now, true);
    const existingWallet = await repos.pointsWallet.getDailyWallet(user.id, clock.date, true);
    const activePlan = assignment ? settingsData.plans.find((plan) => plan.id === assignment.planId && plan.enabled) : undefined;
    const defaultPlan = settingsData.plans.find((plan) => plan.id === settingsData.settings?.defaultPlanId && plan.enabled) || settingsData.plans.find((plan) => plan.enabled);
    const quotaPlan = activePlan || defaultPlan;
    const hasPaidPlan = Boolean(assignment && activePlan);
    const dailyPoints = hasPaidPlan ? assignmentDailyPoints(assignment!.metadata, activePlan!.dailyPoints) : settingsData.settings?.freeDailyPointsEnabled === false ? 0 : nonNegativePoints(settingsData.settings?.freeDailyPoints || 0);
    const dailyEnabled = dailyPoints > 0 && Boolean(quotaPlan);
    let wallet = existingWallet;
    if (!dailyEnabled) wallet = null;
    else if (!wallet) {
        wallet = await repos.pointsWallet.createDailyWallet({
            userId: user.id,
            date: clock.date,
            planId: quotaPlan!.id,
            assignmentId: assignment?.id,
            grantedPoints: dailyPoints,
            remainingPoints: dailyPoints,
            createdAt: clock.now.toISOString(),
            updatedAt: clock.now.toISOString(),
        });
    } else {
        const assignmentId = assignment?.id || "";
        const sameEntitlement = wallet.planId === quotaPlan!.id && (wallet.assignmentId || "") === assignmentId;
        if (!sameEntitlement || wallet.grantedPoints !== dailyPoints) {
            const consumed = sameEntitlement ? Math.max(0, wallet.grantedPoints - wallet.remainingPoints) : 0;
            wallet = await repos.pointsWallet.replaceDailyGrant({
                userId: user.id,
                date: clock.date,
                planId: quotaPlan!.id,
                assignmentId: assignment?.id,
                grantedPoints: dailyPoints,
                remainingPoints: Math.max(0, normalizePointAmount(dailyPoints - consumed, 0)),
                createdAt: wallet.createdAt,
                updatedAt: clock.now.toISOString(),
            });
        }
    }
    return { user, wallet, assignment, activePlan, quotaPlan, settings: settingsData.settings, clock };
}

function snapshotFileWallet(db: AuthDatabase, userId: string, clock: WalletClock) {
    const user = db.users.find((item) => item.id === userId);
    if (!user || user.status !== "active") throw new AuthInputError("用户不可用");
    const wallet = settleFileDailyWallet(db, user, clock);
    const plan = resolveUserPlan(db, user);
    return buildSnapshot(user.pointsBalance, wallet, clock, { id: plan.id, name: plan.name, assignmentId: wallet?.assignmentId });
}

function settleFileDailyWallet(db: AuthDatabase, user: StoredUser, clock: WalletClock) {
    const plan = resolveUserPlan(db, user);
    const defaultPlan = resolveDefaultPlan(db.settings.entitlements);
    const freePlan = plan.id === defaultPlan.id;
    const dailyPoints = freePlan ? nonNegativePoints(db.settings.freeDailyPoints) : nonNegativePoints(plan.dailyPoints);
    if ((freePlan && !db.settings.freeDailyPointsEnabled) || !plan.enabled || dailyPoints <= 0) return null;

    let wallet = db.dailyPlanPointWallets.find((item) => item.userId === user.id && item.date === clock.date);
    const assignmentId = fileAssignmentId(plan.id);
    if (!wallet) {
        wallet = {
            userId: user.id,
            date: clock.date,
            planId: plan.id,
            assignmentId,
            grantedPoints: dailyPoints,
            remainingPoints: dailyPoints,
            createdAt: clock.now.toISOString(),
            updatedAt: clock.now.toISOString(),
        };
        db.dailyPlanPointWallets.push(wallet);
    } else if (wallet.planId !== plan.id || wallet.assignmentId !== assignmentId || wallet.grantedPoints !== dailyPoints) {
        const sameEntitlement = wallet.planId === plan.id && wallet.assignmentId === assignmentId;
        const consumed = sameEntitlement ? Math.max(0, wallet.grantedPoints - wallet.remainingPoints) : 0;
        wallet.planId = plan.id;
        wallet.assignmentId = assignmentId;
        wallet.grantedPoints = dailyPoints;
        wallet.remainingPoints = Math.max(0, normalizePointAmount(dailyPoints - consumed, 0));
        wallet.updatedAt = clock.now.toISOString();
    }
    return wallet;
}

function creditFilePoints(db: AuthDatabase, input: CreditPermanentPointsInput & { amount: number; idempotencyKey: string }, clock: WalletClock): PointsWalletMutationResult {
    const user = db.users.find((item) => item.id === input.userId);
    if (!user || user.status !== "active") throw new AuthInputError("用户不可用");
    const existing = db.pointRecords.find((record) => record.idempotencyKey === input.idempotencyKey);
    const snapshotBefore = snapshotFileWallet(db, user.id, clock);
    if (existing) return existingFileMutation(existing, snapshotBefore, user.id, input.type || "credit");

    user.pointsBalance = normalizePointAmount(user.pointsBalance + input.amount, 0);
    user.updatedAt = clock.now.toISOString();
    const snapshot = snapshotFileWallet(db, user.id, clock);
    const record: PublicPointRecord = {
        id: randomUUID(),
        userId: user.id,
        type: input.type || "credit",
        amount: input.amount,
        balanceAfter: snapshot.totalPoints,
        permanentAmount: input.amount,
        dailyAmount: 0,
        permanentBalanceAfter: snapshot.permanentPoints,
        dailyBalanceAfter: snapshot.dailyPoints,
        description: input.description,
        model: input.model?.trim(),
        idempotencyKey: input.idempotencyKey,
        createdAt: clock.now.toISOString(),
    };
    db.pointRecords.push(record);
    return { snapshot, record, applied: true };
}

function consumeFilePoints(db: AuthDatabase, input: ConsumePointsInput & { amount: number; idempotencyKey: string; requestFingerprint: string }, clock: WalletClock): PointsWalletMutationResult {
    const user = db.users.find((item) => item.id === input.userId);
    if (!user || user.status !== "active") throw new AuthInputError("用户不可用");
    const existing = db.pointRecords.find((record) => record.idempotencyKey === input.idempotencyKey);
    const snapshotBefore = snapshotFileWallet(db, user.id, clock);
    if (existing) {
        assertMatchingConsumption(existing, input);
        return existingFileMutation(existing, snapshotBefore, user.id, "consume");
    }

    assertFileQuota(db, user, clock.date, input.usageKind, input.units, input.amount);
    const wallet = settleFileDailyWallet(db, user, clock);
    const split = splitPointConsumption(wallet?.remainingPoints || 0, user.pointsBalance, input.amount);
    if (wallet) {
        wallet.remainingPoints = normalizePointAmount(wallet.remainingPoints - split.dailyDebit, 0);
        wallet.updatedAt = clock.now.toISOString();
    }
    user.pointsBalance = normalizePointAmount(user.pointsBalance - split.permanentDebit, 0);
    user.updatedAt = clock.now.toISOString();
    updateFileQuota(db, clock.date, user.id, input.usageKind, input.units, split.cost, clock.now.toISOString());
    const snapshot = snapshotFileWallet(db, user.id, clock);
    const record: StoredPointRecord = {
        id: randomUUID(),
        userId: user.id,
        type: "consume",
        amount: split.cost ? -split.cost : 0,
        balanceAfter: snapshot.totalPoints,
        permanentAmount: split.permanentDebit ? -split.permanentDebit : 0,
        dailyAmount: split.dailyDebit ? -split.dailyDebit : 0,
        permanentBalanceAfter: snapshot.permanentPoints,
        dailyBalanceAfter: snapshot.dailyPoints,
        description: input.description,
        model: input.model.trim(),
        usageKind: input.usageKind,
        units: normalizePointAmount(input.units, 0),
        billingDetail: input.billingDetail,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
        sourceDate: clock.date,
        createdAt: clock.now.toISOString(),
    };
    db.pointRecords.push(record);
    return { snapshot, record, applied: true };
}

function refundFilePoints(db: AuthDatabase, input: RefundPointsInput & { idempotencyKey: string }, clock: WalletClock): PointsWalletRefundResult {
    const user = db.users.find((item) => item.id === input.userId);
    if (!user) throw new AuthInputError("用户不存在");
    const existing = db.pointRecords.find((record) => record.idempotencyKey === input.idempotencyKey);
    const source = input.sourceRecordId?.trim() ? db.pointRecords.find((record) => record.id === input.sourceRecordId?.trim()) : db.pointRecords.find((record) => record.idempotencyKey === input.sourceIdempotencyKey?.trim());
    if (!source || source.userId !== input.userId || source.type !== "consume") throw new AuthInputError("原消费记录不存在");
    const priorRefund = db.pointRecords.find((record) => record.type === "refund" && record.sourceRecordId === source.id);
    const snapshotBefore = snapshotFileWallet(db, user.id, clock);
    if (existing) return existingFileRefund(existing, snapshotBefore, user.id);
    if (priorRefund) return existingFileRefund(priorRefund, snapshotBefore, user.id);

    const wallet = settleFileDailyWallet(db, user, clock);
    const plan = resolveUserPlan(db, user);
    const assignmentActive = Boolean(wallet && wallet.assignmentId === fileAssignmentId(plan.id));
    const restored = resolveRefund(source, clock.date, assignmentActive, wallet || null);
    if (wallet) {
        wallet.remainingPoints = normalizePointAmount(wallet.remainingPoints + restored.dailyRestored, 0);
        wallet.updatedAt = clock.now.toISOString();
    }
    user.pointsBalance = normalizePointAmount(user.pointsBalance + restored.permanentRestored, 0);
    user.updatedAt = clock.now.toISOString();
    reverseFileQuota(db, source.sourceDate || clock.date, user.id, input.usageKind, input.units, positivePoints(-source.amount), clock.now.toISOString());
    const snapshot = snapshotFileWallet(db, user.id, clock);
    const record: PublicPointRecord = {
        id: randomUUID(),
        userId: user.id,
        type: "refund",
        amount: normalizePointAmount(restored.permanentRestored + restored.dailyRestored, 0),
        balanceAfter: snapshot.totalPoints,
        permanentAmount: restored.permanentRestored,
        dailyAmount: restored.dailyRestored,
        permanentBalanceAfter: snapshot.permanentPoints,
        dailyBalanceAfter: snapshot.dailyPoints,
        description: restored.dailyExpired ? `${input.description}（${restored.dailyExpired} 今日余额已过期）` : input.description,
        model: input.model?.trim() || source.model,
        usageKind: input.usageKind,
        units: normalizePointAmount(input.units, 0),
        billingDetail: input.billingDetail || source.billingDetail,
        idempotencyKey: input.idempotencyKey,
        sourceRecordId: source.id,
        sourceDate: source.sourceDate,
        createdAt: clock.now.toISOString(),
    };
    db.pointRecords.push(record);
    return { snapshot, record, applied: true, ...restored };
}

function resolveRefund(source: PublicPointRecord, today: string, assignmentActive: boolean, wallet: StoredDailyPlanPointWallet | null) {
    const permanentRestored = nonNegativePoints(-source.permanentAmount);
    const dailyConsumed = nonNegativePoints(-source.dailyAmount);
    const availableCapacity = wallet ? nonNegativePoints(wallet.grantedPoints - wallet.remainingPoints) : 0;
    const dailyRestored = source.sourceDate === today && assignmentActive ? Math.min(dailyConsumed, availableCapacity) : 0;
    return {
        permanentRestored,
        dailyRestored: normalizePointAmount(dailyRestored, 0),
        dailyExpired: normalizePointAmount(dailyConsumed - dailyRestored, 0),
    };
}

function postgresSnapshot(context: PostgresWalletContext) {
    return buildSnapshot(context.user.pointsBalance, context.wallet, context.clock, {
        id: context.assignment?.planId || context.user.planId,
        name: context.activePlan?.name || context.quotaPlan?.name,
        assignmentId: context.assignment?.id,
    });
}

function buildSnapshot(permanentPoints: number, wallet: StoredDailyPlanPointWallet | null | undefined, clock: WalletClock, plan?: { id?: string; name?: string; assignmentId?: string }): PointsWalletSnapshot {
    const permanent = normalizePointAmount(permanentPoints, 0);
    const daily = nonNegativePoints(wallet?.remainingPoints || 0);
    return {
        permanentPoints: permanent,
        dailyPoints: daily,
        totalPoints: Math.max(0, normalizePointAmount(permanent + daily, 0)),
        dailyDate: clock.date,
        dailyExpiresAt: clock.expiresAt,
        activePlanId: plan?.id,
        activePlanName: plan?.name,
        assignmentId: wallet?.assignmentId || plan?.assignmentId,
    };
}

function existingMutation(record: PublicPointRecord, context: PostgresWalletContext, userId: string, expectedType?: PublicPointRecord["type"]): PointsWalletMutationResult {
    assertMatchingRecord(record, userId, expectedType);
    return { snapshot: postgresSnapshot(context), record, applied: false };
}

function existingRefund(record: PublicPointRecord, context: PostgresWalletContext, userId: string): PointsWalletRefundResult {
    assertMatchingRecord(record, userId, "refund");
    return {
        snapshot: postgresSnapshot(context),
        record,
        applied: false,
        permanentRestored: nonNegativePoints(record.permanentAmount),
        dailyRestored: nonNegativePoints(record.dailyAmount),
        dailyExpired: 0,
    };
}

function existingFileMutation(record: PublicPointRecord, snapshot: PointsWalletSnapshot, userId: string, expectedType?: PublicPointRecord["type"]): PointsWalletMutationResult {
    assertMatchingRecord(record, userId, expectedType);
    return { snapshot, record, applied: false };
}

function existingFileRefund(record: PublicPointRecord, snapshot: PointsWalletSnapshot, userId: string): PointsWalletRefundResult {
    assertMatchingRecord(record, userId, "refund");
    return {
        snapshot,
        record,
        applied: false,
        permanentRestored: nonNegativePoints(record.permanentAmount),
        dailyRestored: nonNegativePoints(record.dailyAmount),
        dailyExpired: 0,
    };
}

function assertMatchingRecord(record: PublicPointRecord, userId: string, expectedType?: PublicPointRecord["type"]) {
    if (record.userId !== userId || (expectedType && record.type !== expectedType)) throw new PointsWalletConflictError("余额幂等键已被其他业务使用");
}

function assertMatchingConsumption(record: StoredPointRecord, input: ConsumePointsInput & { amount: number; requestFingerprint: string }) {
    assertMatchingRecord(record, input.userId, "consume");
    if (normalizePointAmount(-record.amount, 0) !== input.amount || (record.model || "").trim() !== input.model.trim() || record.requestFingerprint !== input.requestFingerprint) {
        throw new PointsWalletConflictError("余额幂等键对应的消费参数不一致");
    }
}

function consumptionRequestFingerprint(input: ConsumePointsInput & { amount: number }) {
    const supplied = input.requestFingerprint?.trim().toLowerCase();
    if (supplied) {
        if (!/^[a-f0-9]{64}$/.test(supplied)) throw new AuthInputError("余额消费请求指纹无效");
        return supplied;
    }
    return createHash("sha256")
        .update([input.userId, String(input.amount), String(normalizePointAmount(input.units, 0)), input.usageKind, input.model.trim()].join("\0"))
        .digest("hex");
}

async function assertPostgresQuota(client: QueryExecutor, context: PostgresWalletContext, usageKind: PointUsageKind, units: number, cost: number) {
    const control = generationCostControl(context.settings?.generationCostControl);
    assertPlatformCostLimit(control.maxPointsPerTask, cost, "当前任务成本超过平台保护上限");
    const planLimits = context.settings?.entitlementsEnabled && context.quotaPlan ? entitlementLimits(context.quotaPlan.limits) : undefined;
    if (!planLimits && !costControlEnabled(control)) return;
    if (control.dailyTotalPointSpend > 0) await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`generation-cost:${context.clock.date}`]);
    const totals = await postgresQuotaTotals(client, context.user.id, context.clock.date);
    assertPlatformCostLimit(control.dailyUserPointSpend, totals.userPoints + cost, "今日个人生成成本保护已触发，请稍后再试");
    assertPlatformCostLimit(control.dailyTotalPointSpend, totals.totalPoints + cost, "平台今日生成成本保护已触发，请稍后再试");
    if (!planLimits) return;
    const usage = await createPostgresRepositories(client).points.getQuotaUsage(context.user.id, context.clock.date, usageKind);
    assertLimit(planLimits.dailyPointSpend, totals.userPoints + cost, "今日人民币余额消费额度");
    assertLimit(planLimits[usageLimitKey(usageKind)], (usage?.units || 0) + nonNegativePoints(units), usageLimitLabel(usageKind));
}

async function updatePostgresQuota(client: QueryExecutor, settings: AppSettingsRecord | undefined, date: string, userId: string, usageKind: PointUsageKind, unitsDelta: number, pointsDelta: number, updatedAt: string) {
    if (!settings?.entitlementsEnabled && !costControlEnabled(generationCostControl(settings?.generationCostControl))) return;
    const repos = createPostgresRepositories(client);
    const usage = await repos.points.getQuotaUsage(userId, date, usageKind);
    await repos.points.upsertQuotaUsage({
        userId,
        date,
        usageKind,
        units: Math.max(0, normalizePointAmount((usage?.units || 0) + unitsDelta, 0)),
        pointsSpent: Math.max(0, normalizePointAmount((usage?.pointsSpent || 0) + pointsDelta, 0)),
        updatedAt,
    });
}

function assertFileQuota(db: AuthDatabase, user: StoredUser, date: string, usageKind: PointUsageKind, units: number, cost: number) {
    const control = db.settings.generationCostControl;
    assertPlatformCostLimit(control.maxPointsPerTask, cost, "当前任务成本超过平台保护上限");
    const userPoints = db.quotaUsage.filter((item) => item.userId === user.id && item.date === date).reduce((sum, item) => sum + item.pointsSpent, 0);
    const totalPoints = db.quotaUsage.filter((item) => item.date === date).reduce((sum, item) => sum + item.pointsSpent, 0);
    assertPlatformCostLimit(control.dailyUserPointSpend, userPoints + cost, "今日个人生成成本保护已触发，请稍后再试");
    assertPlatformCostLimit(control.dailyTotalPointSpend, totalPoints + cost, "平台今日生成成本保护已触发，请稍后再试");
    if (!db.settings.entitlements.enabled) return;
    const plan = resolveUserPlan(db, user);
    const usage = db.quotaUsage.find((item) => item.userId === user.id && item.date === date && item.usageKind === usageKind);
    assertLimit(plan.limits.dailyPointSpend, userPoints + cost, "今日人民币余额消费额度");
    assertLimit(plan.limits[usageLimitKey(usageKind)], (usage?.units || 0) + nonNegativePoints(units), usageLimitLabel(usageKind));
}

function updateFileQuota(db: AuthDatabase, date: string, userId: string, usageKind: PointUsageKind, unitsDelta: number, pointsDelta: number, updatedAt: string) {
    if (!db.settings.entitlements.enabled && !costControlEnabled(db.settings.generationCostControl)) return;
    let usage = db.quotaUsage.find((item) => item.userId === userId && item.date === date && item.usageKind === usageKind);
    if (!usage) {
        usage = { userId, date, usageKind, pointsSpent: 0, units: 0, updatedAt };
        db.quotaUsage.push(usage);
    }
    usage.units = Math.max(0, normalizePointAmount(usage.units + unitsDelta, 0));
    usage.pointsSpent = Math.max(0, normalizePointAmount(usage.pointsSpent + pointsDelta, 0));
    usage.updatedAt = updatedAt;
}

function reverseFileQuota(db: AuthDatabase, date: string, userId: string, usageKind: PointUsageKind, units: number, points: number, updatedAt: string) {
    if (!db.settings.entitlements.enabled && !costControlEnabled(db.settings.generationCostControl)) return;
    const usage = db.quotaUsage.find((item) => item.userId === userId && item.date === date && item.usageKind === usageKind);
    if (!usage) return;
    usage.units = Math.max(0, normalizePointAmount(usage.units - nonNegativePoints(units), 0));
    usage.pointsSpent = Math.max(0, normalizePointAmount(usage.pointsSpent - nonNegativePoints(points), 0));
    usage.updatedAt = updatedAt;
}

function assignmentDailyPoints(metadata: JsonValue | undefined, fallback: number) {
    if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
        const value = Number(metadata.dailyPoints);
        if (Number.isFinite(value)) return nonNegativePoints(value);
    }
    return nonNegativePoints(fallback);
}

function entitlementLimits(value: JsonValue) {
    const limits = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return {
        dailyPointSpend: nonNegativePoints(limits.dailyPointSpend),
        dailyApiCalls: nonNegativePoints(limits.dailyApiCalls),
        dailyImages: nonNegativePoints(limits.dailyImages),
        dailyVideos: nonNegativePoints(limits.dailyVideos),
        dailyAudio: nonNegativePoints(limits.dailyAudio),
        dailyText: nonNegativePoints(limits.dailyText),
    };
}

function generationCostControl(value: JsonValue | undefined) {
    const control = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return {
        maxPointsPerTask: nonNegativePoints(control.maxPointsPerTask),
        dailyUserPointSpend: nonNegativePoints(control.dailyUserPointSpend),
        dailyTotalPointSpend: nonNegativePoints(control.dailyTotalPointSpend),
    };
}

function costControlEnabled(control: { maxPointsPerTask: number; dailyUserPointSpend: number; dailyTotalPointSpend: number }) {
    return control.maxPointsPerTask > 0 || control.dailyUserPointSpend > 0 || control.dailyTotalPointSpend > 0;
}

async function postgresQuotaTotals(client: QueryExecutor, userId: string, date: string) {
    const result = await client.query<{ user_points: string | number; total_points: string | number }>(
        `SELECT COALESCE(sum(points_spent) FILTER (WHERE user_id = $1), 0) AS user_points,
                COALESCE(sum(points_spent), 0) AS total_points
           FROM quota_usage
          WHERE date = $2::date`,
        [userId, date],
    );
    return {
        userPoints: nonNegativePoints(result.rows[0]?.user_points),
        totalPoints: nonNegativePoints(result.rows[0]?.total_points),
    };
}

function usageLimitKey(usageKind: PointUsageKind): "dailyApiCalls" | "dailyImages" | "dailyVideos" | "dailyAudio" | "dailyText" {
    if (usageKind === "image") return "dailyImages";
    if (usageKind === "video") return "dailyVideos";
    if (usageKind === "audio") return "dailyAudio";
    if (usageKind === "text") return "dailyText";
    return "dailyApiCalls";
}

function usageLimitLabel(usageKind: PointUsageKind) {
    if (usageKind === "image") return "今日图片生成次数";
    if (usageKind === "video") return "今日视频生成次数";
    if (usageKind === "audio") return "今日音频生成次数";
    if (usageKind === "text") return "今日文本生成次数";
    return "今日 API 调用次数";
}

function assertLimit(limit: number, next: number, label: string) {
    if (limit > 0 && next > limit) throw new QuotaExceededError(`${label}不足，今日额度 ${limit}，本次后将达到 ${normalizePointAmount(next, 0)}`);
}

function assertPlatformCostLimit(limit: number, next: number, message: string) {
    if (limit > 0 && next > limit) throw new QuotaExceededError(message);
}

function requiredIdempotencyKey(value: string) {
    const key = value.trim().slice(0, 240);
    if (!key) throw new AuthInputError("余额操作缺少幂等键");
    return key;
}

function positivePoints(value: unknown) {
    return Math.max(0, normalizePointAmount(value, 0));
}

function nonNegativePoints(value: unknown) {
    return Math.max(0, normalizePointAmount(value, 0));
}

function fileAssignmentId(planId: string) {
    return `file:${planId}`;
}

function validTimeZone(value: string) {
    try {
        new Intl.DateTimeFormat("en", { timeZone: value }).format();
        return value;
    } catch {
        return DEFAULT_TIME_ZONE;
    }
}
