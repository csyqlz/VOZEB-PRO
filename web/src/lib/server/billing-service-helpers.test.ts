import { describe, expect, it } from "vitest";

import type { BillingOrderRecord, BillingProductRecord, QueryExecutor } from "./database";
import { isAutomaticallyExpiredOrder, normalizeBillingProductPatch, normalizeProvider } from "./billing-service-helpers";

describe("billing payment provider normalization", () => {
    it("uses the same stable provider ids as checkout and webhooks", () => {
        expect(normalizeProvider("Stripe-Checkout")).toBe("stripe");
        expect(normalizeProvider("ALI")).toBe("alipay");
        expect(normalizeProvider("wechatPay")).toBe("wechat");
        expect(normalizeProvider("pay_ply")).toBe("payply");
    });
});

describe("billing product patch", () => {
    const current: BillingProductRecord = {
        id: "product",
        productKind: "points",
        name: "积分商品",
        description: "",
        amountCents: 100,
        currency: "CNY",
        pointsAmount: 10,
        dailyPoints: 0,
        periodDays: 0,
        enabled: true,
        sortOrder: 0,
        metadata: {},
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
    };
    const db = null as unknown as QueryExecutor;
    const planCurrent: BillingProductRecord = { ...current, productKind: "plan", planId: "creator" };

    it("rejects changing an existing points product to free", async () => {
        await expect(normalizeBillingProductPatch({ amountCents: 0 }, current, db)).rejects.toThrow("余额充值商品价格必须大于零");
    });

    it("rejects adding points to a free product", async () => {
        await expect(normalizeBillingProductPatch({ pointsAmount: 10 }, { ...planCurrent, amountCents: 0, pointsAmount: 0 }, db)).rejects.toThrow("赠送余额的商品价格必须大于零");
    });

    it("allows a free product when points are removed together", async () => {
        await expect(normalizeBillingProductPatch({ amountCents: 0, pointsAmount: 0 }, planCurrent, db)).resolves.toMatchObject({ amountCents: 0, pointsAmount: 0 });
    });
});

describe("billing order expiration metadata", () => {
    const order = {
        id: "order",
        orderNo: "VZ-ORDER",
        productKind: "points",
        status: "closed",
        subject: "积分商品",
        listAmountCents: 100,
        promotionDiscountCents: 0,
        couponDiscountCents: 0,
        amountCents: 100,
        currency: "CNY",
        pointsAmount: 10,
        dailyPoints: 0,
        periodDays: 0,
        quantity: 1,
        provider: "stripe",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
    } satisfies BillingOrderRecord;

    it("only recognizes system expiration closures", () => {
        expect(isAutomaticallyExpiredOrder({ ...order, metadata: { close: { source: "expiration-job" } } })).toBe(true);
        expect(isAutomaticallyExpiredOrder({ ...order, metadata: { close: { source: "admin" } } })).toBe(false);
        expect(isAutomaticallyExpiredOrder({ ...order, status: "pending", metadata: { close: { source: "expiration-job" } } })).toBe(false);
    });
});
