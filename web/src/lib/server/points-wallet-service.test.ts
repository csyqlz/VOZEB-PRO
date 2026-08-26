import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { emptyDb } from "@/lib/auth/store-normalizers";
import { readAuthDb, writeAuthDb } from "@/lib/auth/store-repository";
import type { AuthDatabase, EntitlementPlan, StoredUser } from "@/lib/auth/store-types";

import { consumePoints, creditPermanentPoints, getPointsWalletSnapshot, refundPoints } from "./points-wallet-service";

const previousProvider = process.env.VOZEB_PRO_DATABASE_PROVIDER;
const previousDataDir = process.env.VOZEB_PRO_DATA_DIR;
let dataDir = "";

beforeAll(() => {
    process.env.VOZEB_PRO_DATABASE_PROVIDER = "file";
});

beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "vozeb-points-wallet-"));
    process.env.VOZEB_PRO_DATA_DIR = dataDir;
});

afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
});

afterAll(() => {
    if (previousProvider === undefined) delete process.env.VOZEB_PRO_DATABASE_PROVIDER;
    else process.env.VOZEB_PRO_DATABASE_PROVIDER = previousProvider;
    if (previousDataDir === undefined) delete process.env.VOZEB_PRO_DATA_DIR;
    else process.env.VOZEB_PRO_DATA_DIR = previousDataDir;
});

describe("points wallet service", () => {
    it("settles one daily plan wallet lazily", async () => {
        await seedWallet({ permanentPoints: 50, dailyPoints: 30 });

        const first = await getPointsWalletSnapshot("user-one", { now: at("2026-07-22T08:00:00+08:00") });
        const second = await getPointsWalletSnapshot("user-one", { now: at("2026-07-22T12:00:00+08:00") });
        const db = await readAuthDb();

        expect(first).toMatchObject({ permanentPoints: 50, dailyPoints: 30, totalPoints: 80, dailyDate: "2026-07-22", activePlanId: "pro" });
        expect(second.dailyPoints).toBe(30);
        expect(db.dailyPlanPointWallets).toHaveLength(1);
    });

    it("consumes daily points before permanent points", async () => {
        await seedWallet({ permanentPoints: 50, dailyPoints: 30 });

        const result = await consume("consume-one", 40, "2026-07-22T08:00:00+08:00");

        expect(result.snapshot).toMatchObject({ permanentPoints: 40, dailyPoints: 0, totalPoints: 40 });
        expect(result.record).toMatchObject({ permanentAmount: -10, dailyAmount: -30 });
    });

    it("rejects an insufficient debit without partial mutation", async () => {
        await seedWallet({ permanentPoints: 50, dailyPoints: 30 });

        await expect(consume("consume-too-much", 81, "2026-07-22T08:00:00+08:00")).rejects.toThrow("人民币余额不足");
        const snapshot = await getPointsWalletSnapshot("user-one", { now: at("2026-07-22T09:00:00+08:00") });
        const db = await readAuthDb();

        expect(snapshot).toMatchObject({ permanentPoints: 50, dailyPoints: 30, totalPoints: 80 });
        expect(db.pointRecords).toHaveLength(0);
        expect(db.quotaUsage).toHaveLength(0);
    });

    it("does not debit twice for the same idempotency key", async () => {
        await seedWallet({ permanentPoints: 50, dailyPoints: 30 });

        const first = await consume("consume-idempotent", 20, "2026-07-22T08:00:00+08:00");
        const second = await consume("consume-idempotent", 20, "2026-07-22T08:05:00+08:00");
        const db = await readAuthDb();

        expect(first.applied).toBe(true);
        expect(second.applied).toBe(false);
        expect(second.snapshot.totalPoints).toBe(60);
        expect(db.pointRecords).toHaveLength(1);
    });

    it("persists structured token billing details on the consumption record", async () => {
        await seedWallet({ permanentPoints: 50, dailyPoints: 0 });

        const result = await consumePoints({
            userId: "user-one",
            amount: 0.01234567,
            units: 1,
            usageKind: "text",
            model: "writer",
            description: "文本模型调用",
            idempotencyKey: "text-detail-one",
            billingDetail: {
                billingUnit: "per_1m_tokens",
                currency: "CNY",
                actualCost: 0.01234567,
                inputTokens: 1200,
                outputTokens: 800,
                inputRate: 1.5,
                outputRate: 9,
            },
        });

        expect(result.record).toMatchObject({
            usageKind: "text",
            units: 1,
            billingDetail: expect.objectContaining({ inputTokens: 1200, outputTokens: 800, actualCost: 0.01234567 }),
        });
        expect((await readAuthDb()).pointRecords[0]).toMatchObject({ billingDetail: expect.objectContaining({ billingUnit: "per_1m_tokens" }) });
    });

    it("rejects reused consumption keys with different billing parameters", async () => {
        await seedWallet({ permanentPoints: 50, dailyPoints: 30 });
        await consume("consume-parameter-conflict", 5, "2026-07-22T08:00:00+08:00");

        await expect(consume("consume-parameter-conflict", 6, "2026-07-22T08:05:00+08:00")).rejects.toThrow("消费参数不一致");
        await expect(
            consumePoints({
                userId: "user-one",
                amount: 5,
                units: 1,
                usageKind: "image",
                model: "another-image-model",
                description: "生成图片调用扣除",
                idempotencyKey: "consume-parameter-conflict",
                now: at("2026-07-22T08:10:00+08:00"),
            }),
        ).rejects.toThrow("消费参数不一致");
    });

    it("rejects one server billing identity when the upstream request fingerprint changes", async () => {
        await seedWallet({ permanentPoints: 50, dailyPoints: 30 });
        const input = {
            userId: "user-one",
            amount: 5,
            units: 1,
            usageKind: "text" as const,
            model: "writer",
            description: "文本模型调用扣除",
            idempotencyKey: "system-ai:stable-business-request",
            now: at("2026-07-22T08:00:00+08:00"),
        };

        await consumePoints({ ...input, requestFingerprint: "a".repeat(64) });
        await expect(consumePoints({ ...input, requestFingerprint: "b".repeat(64) })).rejects.toThrow("消费参数不一致");

        expect((await readAuthDb()).pointRecords[0]).toMatchObject({ idempotencyKey: input.idempotencyKey, requestFingerprint: "a".repeat(64) });
    });

    it("restores both buckets for a same-day refund", async () => {
        await seedWallet({ permanentPoints: 50, dailyPoints: 10 });
        const debit = await consume("consume-refund", 30, "2026-07-22T08:00:00+08:00");

        const refund = await refundPoints({
            userId: "user-one",
            sourceRecordId: debit.record.id,
            idempotencyKey: "refund-same-day",
            usageKind: "image",
            units: 1,
            description: "图片任务失败退回",
            now: at("2026-07-22T09:00:00+08:00"),
        });

        expect(refund).toMatchObject({ permanentRestored: 20, dailyRestored: 10, dailyExpired: 0, applied: true });
        expect(refund.snapshot).toMatchObject({ permanentPoints: 50, dailyPoints: 10, totalPoints: 60 });
    });

    it("does not convert expired daily points into permanent points", async () => {
        await seedWallet({ permanentPoints: 50, dailyPoints: 10 });
        const debit = await consume("consume-cross-day", 30, "2026-07-22T08:00:00+08:00");

        const refund = await refundPoints({
            userId: "user-one",
            sourceRecordId: debit.record.id,
            idempotencyKey: "refund-cross-day",
            usageKind: "image",
            units: 1,
            description: "图片任务失败退回",
            now: at("2026-07-23T08:00:00+08:00"),
        });

        expect(refund).toMatchObject({ permanentRestored: 20, dailyRestored: 0, dailyExpired: 10 });
        expect(refund.snapshot).toMatchObject({ permanentPoints: 50, dailyPoints: 10, totalPoints: 60, dailyDate: "2026-07-23" });
        expect(refund.record.amount).toBe(20);
    });

    it("keeps paid plan daily points while the free-user switch is disabled", async () => {
        await seedWallet({ permanentPoints: 50, dailyPoints: 30, freeDailyPointsEnabled: false });

        const snapshot = await getPointsWalletSnapshot("user-one", { now: at("2026-07-22T08:00:00+08:00") });

        expect(snapshot).toMatchObject({ permanentPoints: 50, dailyPoints: 30, totalPoints: 80 });
        expect((await readAuthDb()).dailyPlanPointWallets).toHaveLength(1);
    });

    it("disables only the free-user daily points", async () => {
        await seedWallet({ permanentPoints: 50, dailyPoints: 0, freeDailyPoints: 20, freeDailyPointsEnabled: false, planId: "free" });

        const snapshot = await getPointsWalletSnapshot("user-one", { now: at("2026-07-22T08:00:00+08:00") });

        expect(snapshot).toMatchObject({ permanentPoints: 50, dailyPoints: 0, totalPoints: 50 });
        expect((await readAuthDb()).dailyPlanPointWallets).toHaveLength(0);
    });

    it("settles configured daily points for a free user", async () => {
        await seedWallet({ permanentPoints: 0, dailyPoints: 0, freeDailyPoints: 20, planId: "free" });

        const snapshot = await getPointsWalletSnapshot("user-one", { now: at("2026-07-22T08:00:00+08:00") });

        expect(snapshot).toMatchObject({ permanentPoints: 0, dailyPoints: 20, totalPoints: 20, activePlanId: "free" });
    });

    it("refunds one consumption only once", async () => {
        await seedWallet({ permanentPoints: 50, dailyPoints: 10 });
        const debit = await consume("consume-single-refund", 30, "2026-07-22T08:00:00+08:00");
        const input = {
            userId: "user-one",
            sourceRecordId: debit.record.id,
            usageKind: "image" as const,
            units: 1,
            description: "图片任务失败退回",
            now: at("2026-07-22T09:00:00+08:00"),
        };

        const first = await refundPoints({ ...input, idempotencyKey: "refund-first" });
        const second = await refundPoints({ ...input, idempotencyKey: "refund-second" });
        const db = await readAuthDb();

        expect(first.applied).toBe(true);
        expect(second.applied).toBe(false);
        expect(second.record.id).toBe(first.record.id);
        expect(db.pointRecords.filter((record) => record.type === "refund")).toHaveLength(1);
    });

    it("separates quota usage by the injected wallet date", async () => {
        await seedWallet({ permanentPoints: 100, dailyPoints: 0, dailyImages: 1 });

        await consume("quota-day-one", 5, "2026-07-22T08:00:00+08:00");
        await expect(consume("quota-day-one-extra", 5, "2026-07-22T09:00:00+08:00")).rejects.toThrow("今日图片生成次数不足");
        await expect(consume("quota-day-two", 5, "2026-07-23T08:00:00+08:00")).resolves.toMatchObject({ applied: true });

        expect((await readAuthDb()).quotaUsage.map((usage) => usage.date)).toEqual(["2026-07-22", "2026-07-23"]);
    });

    it("tracks and refunds quota usage for a zero-point model", async () => {
        await seedWallet({ permanentPoints: 0, dailyPoints: 0, dailyText: 1 });
        const input = {
            userId: "user-one",
            amount: 0,
            units: 1,
            usageKind: "text" as const,
            model: "free-text",
            description: "免费文本调用",
            now: at("2026-07-22T08:00:00+08:00"),
        };

        const consumption = await consumePoints({ ...input, idempotencyKey: "free-text:first" });
        await expect(consumePoints({ ...input, idempotencyKey: "free-text:limited" })).rejects.toThrow("今日文本生成次数不足");
        const refund = await refundPoints({
            userId: "user-one",
            sourceRecordId: consumption.record.id,
            idempotencyKey: "free-text:refund",
            usageKind: "text",
            units: 1,
            description: "免费文本调用失败回滚",
            now: at("2026-07-22T08:05:00+08:00"),
        });
        await expect(consumePoints({ ...input, idempotencyKey: "free-text:after-refund" })).resolves.toMatchObject({ applied: true });

        expect(consumption).toMatchObject({ applied: true, snapshot: { totalPoints: 0 }, record: { amount: 0 } });
        expect(refund).toMatchObject({ applied: true, permanentRestored: 0, dailyRestored: 0 });
        expect((await readAuthDb()).quotaUsage).toEqual([expect.objectContaining({ usageKind: "text", units: 1, pointsSpent: 0 })]);
    });

    it("enforces the configured per-task cost guard while entitlements are disabled", async () => {
        await seedWallet({ permanentPoints: 100, dailyPoints: 0, entitlementsEnabled: false, generationCostControl: { maxPointsPerTask: 6 } });

        await expect(consume("cost-task-rejected", 7, "2026-07-22T08:00:00+08:00")).rejects.toThrow("当前任务成本超过平台保护上限");
        expect((await readAuthDb()).pointRecords).toHaveLength(0);
    });

    it("aggregates the configured daily user cost across generation capabilities", async () => {
        await seedWallet({ permanentPoints: 100, dailyPoints: 0, entitlementsEnabled: false, generationCostControl: { dailyUserPointSpend: 6 } });
        await consume("cost-user-image", 4, "2026-07-22T08:00:00+08:00");

        await expect(consumePoints({ userId: "user-one", amount: 3, units: 1, usageKind: "text", model: "test-text-model", description: "文本调用", idempotencyKey: "cost-user-text", now: at("2026-07-22T09:00:00+08:00") })).rejects.toThrow(
            "今日个人生成成本保护已触发",
        );
        expect((await readAuthDb()).quotaUsage).toEqual([expect.objectContaining({ usageKind: "image", pointsSpent: 4 })]);
    });

    it("shares the configured daily total cost across users and releases refunded cost", async () => {
        await seedWallet({ permanentPoints: 100, dailyPoints: 0, entitlementsEnabled: false, generationCostControl: { dailyTotalPointSpend: 6 } });
        const db = await readAuthDb();
        db.users.push({ ...user(100, "pro"), id: "user-two", accountId: "0002", username: "wallet-user-two" });
        await writeAuthDb(db);
        const first = await consume("cost-total-first", 4, "2026-07-22T08:00:00+08:00");
        const secondInput = { userId: "user-two", amount: 3, units: 1, usageKind: "video" as const, model: "test-video-model", description: "视频调用", now: at("2026-07-22T09:00:00+08:00") };

        await expect(consumePoints({ ...secondInput, idempotencyKey: "cost-total-rejected" })).rejects.toThrow("平台今日生成成本保护已触发");
        await refundPoints({ userId: "user-one", sourceRecordId: first.record.id, idempotencyKey: "cost-total-refund", usageKind: "image", units: 1, description: "图片失败退款", now: at("2026-07-22T09:30:00+08:00") });
        await expect(consumePoints({ ...secondInput, idempotencyKey: "cost-total-after-refund" })).resolves.toMatchObject({ applied: true });
    });

    it("applies the plan daily point limit across all generation capabilities", async () => {
        await seedWallet({ permanentPoints: 100, dailyPoints: 0 });
        const db = await readAuthDb();
        db.settings.entitlements.plans.find((item) => item.id === "pro")!.limits.dailyPointSpend = 6;
        await writeAuthDb(db);
        await consume("plan-total-image", 4, "2026-07-22T08:00:00+08:00");

        await expect(consumePoints({ userId: "user-one", amount: 3, units: 1, usageKind: "text", model: "test-text-model", description: "文本调用", idempotencyKey: "plan-total-text", now: at("2026-07-22T09:00:00+08:00") })).rejects.toThrow(
            "今日人民币余额消费额度不足",
        );
    });

    it("rejects a credit idempotency key owned by another record type", async () => {
        await seedWallet({ permanentPoints: 50, dailyPoints: 0 });
        await consume("shared-key", 5, "2026-07-22T08:00:00+08:00");

        await expect(
            creditPermanentPoints({
                userId: "user-one",
                amount: 10,
                description: "充值积分",
                idempotencyKey: "shared-key",
                now: at("2026-07-22T09:00:00+08:00"),
            }),
        ).rejects.toThrow("余额幂等键已被其他业务使用");
    });
});

async function seedWallet({
    permanentPoints,
    dailyPoints,
    freeDailyPoints = 0,
    freeDailyPointsEnabled = true,
    dailyImages = 0,
    dailyText = 0,
    planId = "pro",
    entitlementsEnabled = true,
    generationCostControl = {},
}: {
    permanentPoints: number;
    dailyPoints: number;
    freeDailyPoints?: number;
    freeDailyPointsEnabled?: boolean;
    dailyImages?: number;
    dailyText?: number;
    planId?: "free" | "pro";
    entitlementsEnabled?: boolean;
    generationCostControl?: Partial<AuthDatabase["settings"]["generationCostControl"]>;
}) {
    const db = structuredClone(emptyDb());
    db.settings.freeDailyPointsEnabled = freeDailyPointsEnabled;
    db.settings.freeDailyPoints = freeDailyPoints;
    db.settings.entitlements = {
        enabled: entitlementsEnabled,
        defaultPlanId: "free",
        plans: [plan({ id: "free", dailyPoints: 0, dailyImages: 0, dailyText: 0 }), plan({ id: "pro", dailyPoints, dailyImages, dailyText })],
    };
    db.settings.generationCostControl = { ...db.settings.generationCostControl, ...generationCostControl };
    db.users.push(user(permanentPoints, planId));
    await writeAuthDb(db);
}

function user(pointsBalance: number, planId: "free" | "pro"): StoredUser {
    return {
        id: "user-one",
        accountId: "0001",
        username: "wallet-user",
        displayName: "钱包用户",
        bio: "",
        role: "user",
        adminPermissions: [],
        status: "active",
        planId,
        pointsBalance,
        passwordHash: "test",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
    };
}

function plan({ id, dailyPoints, dailyImages, dailyText }: { id: "free" | "pro"; dailyPoints: number; dailyImages: number; dailyText: number }): EntitlementPlan {
    return {
        id,
        name: id === "pro" ? "专业版" : "免费版",
        enabled: true,
        dailyPoints,
        limits: { dailyPointSpend: 0, dailyApiCalls: 0, dailyImages, dailyVideos: 0, dailyAudio: 0, dailyText },
        features: ["points-wallet"],
    };
}

function consume(idempotencyKey: string, amount: number, iso: string) {
    return consumePoints({
        userId: "user-one",
        amount,
        units: 1,
        usageKind: "image",
        model: "test-image-model",
        description: "生成图片调用扣除",
        idempotencyKey,
        now: at(iso),
    });
}

function at(iso: string) {
    return new Date(iso);
}
