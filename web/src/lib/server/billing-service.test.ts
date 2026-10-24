import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BillingOrderRecord, PaymentTransactionRecord, UserPlanAssignmentRecord } from "@/lib/server/database";
import { isPostgresDatabaseEnabled } from "@/lib/server/database";
import type { UserRecord } from "@/lib/server/database/repository-shared";

const mocks = vi.hoisted(() => ({
    client: {},
    order: undefined as BillingOrderRecord | undefined,
    user: undefined as UserRecord | undefined,
    payments: [] as PaymentTransactionRecord[],
    getOrderById: vi.fn(),
    upsertPayment: vi.fn(),
    lockPaymentIdentity: vi.fn(),
    getPaymentByProviderIdentifiers: vi.fn(),
    updateOrder: vi.fn(),
    listPayments: vi.fn(),
    findOrderPayment: vi.fn(),
    listPlanAssignments: vi.fn(),
    getPlanAssignmentBySource: vi.fn(),
    updatePlanAssignment: vi.fn(),
    getActivePlanAssignment: vi.fn(),
    getRefundJobByOrderId: vi.fn(),
    upsertRefundJob: vi.fn(),
    releaseRefundJob: vi.fn(),
    checkpointRefundJob: vi.fn(),
    updatePaymentState: vi.fn(),
    getSettings: vi.fn(),
    getUserById: vi.fn(),
    updateUser: vi.fn(),
    adjustPoints: vi.fn(),
    createOrderPlanAssignment: vi.fn(),
    lockAuthMutation: vi.fn(),
    getReferralRelationshipByInviteeUserId: vi.fn(),
    getReferralRewardsByTriggerOrder: vi.fn(),
}));

vi.mock("@/lib/server/auth-mutation-lock", () => ({ lockAuthMutation: mocks.lockAuthMutation }));
vi.mock("@/lib/server/database", () => ({
    createPostgresRepositories: vi.fn(() => ({
        billing: {
            getOrderById: mocks.getOrderById,
            upsertPayment: mocks.upsertPayment,
            lockPaymentIdentity: mocks.lockPaymentIdentity,
            getPaymentByProviderIdentifiers: mocks.getPaymentByProviderIdentifiers,
            updateOrder: mocks.updateOrder,
            listPayments: mocks.listPayments,
            findOrderPayment: mocks.findOrderPayment,
            listPlanAssignments: mocks.listPlanAssignments,
            getPlanAssignmentBySource: mocks.getPlanAssignmentBySource,
            updatePlanAssignment: mocks.updatePlanAssignment,
            getActivePlanAssignment: mocks.getActivePlanAssignment,
            getRefundJobByOrderId: mocks.getRefundJobByOrderId,
            upsertRefundJob: mocks.upsertRefundJob,
            releaseRefundJob: mocks.releaseRefundJob,
            checkpointRefundJob: mocks.checkpointRefundJob,
            updatePaymentState: mocks.updatePaymentState,
        },
        users: {
            getById: mocks.getUserById,
            update: mocks.updateUser,
        },
        settings: { getSettings: mocks.getSettings },
        referrals: {
            getRelationshipByInviteeUserId: mocks.getReferralRelationshipByInviteeUserId,
            getRewardsByTriggerOrder: mocks.getReferralRewardsByTriggerOrder,
        },
    })),
    ensurePostgresSchema: vi.fn(),
    isPostgresDatabaseEnabled: vi.fn(() => true),
    withPostgresTransaction: vi.fn(async (callback: (client: typeof mocks.client) => unknown) => callback(mocks.client)),
}));
vi.mock("@/lib/server/points-wallet-service", () => ({ adjustPermanentPointsInPostgresTransaction: mocks.adjustPoints }));
vi.mock("@/lib/server/billing-service-helpers", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/server/billing-service-helpers")>()),
    createOrderPlanAssignment: mocks.createOrderPlanAssignment,
}));

import { completeBillingOrderPayment, listUserBillingOrders, refundBillingOrder } from "./billing-service";

describe("billing order listing", () => {
    it("returns an empty page in file database mode without querying PostgreSQL", async () => {
        vi.mocked(isPostgresDatabaseEnabled).mockReturnValueOnce(false);
        await expect(listUserBillingOrders("user-one", { page: 2, pageSize: 10 })).resolves.toEqual({ items: [], total: 0, page: 2, pageSize: 10 });
    });
});

const now = "2026-07-23T00:00:00.000Z";
const baseUser = {
    id: "user-one",
    accountId: "0001",
    username: "tester",
    displayName: "测试用户",
    bio: "",
    role: "user",
    adminPermissions: [],
    status: "active",
    planId: "existing-plan",
    pointsBalance: 100,
    passwordHash: "hash",
    createdAt: now,
    updatedAt: now,
} satisfies UserRecord;
const pointsOrder = {
    id: "order-points",
    orderNo: "VZ-POINTS",
    productId: "points-500",
    userId: baseUser.id,
    productKind: "points",
    status: "pending",
    subject: "500 积分",
    listAmountCents: 990,
    promotionDiscountCents: 0,
    couponDiscountCents: 0,
    amountCents: 990,
    currency: "CNY",
    pointsAmount: 500,
    dailyPoints: 0,
    periodDays: 0,
    quantity: 1,
    provider: "stripe",
    createdAt: now,
    updatedAt: now,
} satisfies BillingOrderRecord;

describe("billing payment completion", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.order = { ...pointsOrder };
        mocks.user = { ...baseUser };
        mocks.payments = [];
        mocks.getOrderById.mockImplementation(async () => mocks.order);
        mocks.getUserById.mockImplementation(async () => mocks.user);
        mocks.upsertPayment.mockImplementation(async (payment: PaymentTransactionRecord) => {
            mocks.payments = [...mocks.payments.filter((item) => item.id !== payment.id), payment];
            return payment;
        });
        mocks.getPaymentByProviderIdentifiers.mockImplementation(
            async (_provider: string, identifiers: string[]) => mocks.payments.find((item) => identifiers.includes(item.providerTradeId || "") || identifiers.includes(item.providerPaymentId || "")) || null,
        );
        mocks.lockPaymentIdentity.mockResolvedValue(undefined);
        mocks.updatePaymentState.mockImplementation(async (payment: PaymentTransactionRecord) => {
            mocks.payments = mocks.payments.map((item) =>
                item.id === payment.id ? { ...item, status: payment.status, rawPayload: payment.rawPayload, paidAt: payment.paidAt, refundedAt: payment.refundedAt, failedAt: payment.failedAt, updatedAt: payment.updatedAt } : item,
            );
            return mocks.payments.find((item) => item.id === payment.id) || payment;
        });
        mocks.getRefundJobByOrderId.mockResolvedValue(null);
        mocks.upsertRefundJob.mockImplementation(async (job: unknown) => job);
        mocks.checkpointRefundJob.mockResolvedValue(null);
        mocks.releaseRefundJob.mockResolvedValue(null);
        mocks.listPayments.mockImplementation(async () => ({ items: mocks.payments }));
        mocks.findOrderPayment.mockImplementation(
            async ({ preferredPaymentId, statuses }: { preferredPaymentId?: string; statuses: string[] }) => mocks.payments.find((item) => item.id === preferredPaymentId) || mocks.payments.find((item) => statuses.includes(item.status)) || null,
        );
        mocks.listPlanAssignments.mockResolvedValue({ items: [] });
        mocks.getPlanAssignmentBySource.mockResolvedValue(null);
        mocks.updateOrder.mockImplementation(async (_id: string, patch: Partial<BillingOrderRecord>) => {
            mocks.order = mocks.order ? { ...mocks.order, ...patch } : undefined;
            return mocks.order;
        });
        mocks.updateUser.mockImplementation(async (_id: string, patch: Partial<UserRecord>) => {
            mocks.user = mocks.user ? { ...mocks.user, ...patch } : undefined;
            return mocks.user;
        });
        mocks.adjustPoints.mockImplementation(async (_client: unknown, input: { amount: number }) => {
            const currentBalance = mocks.user?.pointsBalance || 0;
            const appliedAmount = input.amount < 0 ? -Math.min(currentBalance, Math.abs(input.amount)) : input.amount;
            if (mocks.user) mocks.user = { ...mocks.user, pointsBalance: Math.max(0, currentBalance + appliedAmount) };
            return { record: { amount: appliedAmount } };
        });
        mocks.getSettings.mockResolvedValue({ settings: { defaultPlanId: "free" } });
        mocks.getReferralRelationshipByInviteeUserId.mockResolvedValue(undefined);
        mocks.getReferralRewardsByTriggerOrder.mockResolvedValue([]);
    });

    it("credits a points product without replacing the user's plan and remains idempotent", async () => {
        const first = await completeBillingOrderPayment({ orderId: pointsOrder.id, providerTradeId: "trade-points", paidAt: now });
        const duplicate = await completeBillingOrderPayment({ orderId: pointsOrder.id, providerTradeId: "trade-points", paidAt: now });

        expect(first).toMatchObject({ assignment: undefined, pointsGranted: 500, user: { planId: "existing-plan", pointsBalance: 600 } });
        expect(duplicate).toMatchObject({ assignment: undefined, pointsGranted: 0, user: { planId: "existing-plan", pointsBalance: 600 } });
        expect(mocks.adjustPoints).toHaveBeenCalledTimes(1);
        expect(mocks.updateUser).not.toHaveBeenCalled();
        expect(mocks.createOrderPlanAssignment).not.toHaveBeenCalled();
        expect(mocks.order?.status).toBe("paid");
        expect(mocks.lockAuthMutation).toHaveBeenCalledWith(mocks.client);
        expect(mocks.getOrderById).toHaveBeenCalledWith(pointsOrder.id, true);
    });

    it("rejects a verified callback from a different provider than the order snapshot", async () => {
        await expect(completeBillingOrderPayment({ orderId: pointsOrder.id, provider: "alipay", providerTradeId: "ali-trade", paidAt: now })).rejects.toMatchObject({
            message: "支付回调渠道与订单渠道不一致",
            status: 409,
        });
        expect(mocks.upsertPayment).not.toHaveBeenCalled();
        expect(mocks.adjustPoints).not.toHaveBeenCalled();
    });

    it("rejects a second provider transaction instead of silently treating it as the same payment", async () => {
        await completeBillingOrderPayment({ orderId: pointsOrder.id, provider: "stripe", providerTradeId: "trade-one", paidAt: now });

        await expect(completeBillingOrderPayment({ orderId: pointsOrder.id, provider: "stripe", providerTradeId: "trade-two", paidAt: now })).rejects.toMatchObject({
            message: "订单已由另一笔支付交易完成，请人工核对并处理重复付款",
            status: 409,
        });
        expect(mocks.adjustPoints).toHaveBeenCalledTimes(1);
        expect(mocks.upsertPayment).toHaveBeenCalledTimes(1);
    });

    it("still applies plan products to the user and creates an assignment", async () => {
        mocks.order = { ...pointsOrder, id: "order-plan", orderNo: "VZ-PLAN", productKind: "plan", planId: "creator", periodDays: 30, dailyPoints: 10 };
        const assignment = {
            id: "assignment-one",
            userId: baseUser.id,
            planId: "creator",
            status: "active",
            source: "order",
            sourceId: "order-plan",
            startsAt: now,
            createdAt: now,
            updatedAt: now,
        } satisfies UserPlanAssignmentRecord;
        mocks.createOrderPlanAssignment.mockResolvedValue(assignment);

        const result = await completeBillingOrderPayment({ orderId: "order-plan", providerTradeId: "trade-plan", paidAt: now });

        expect(result).toMatchObject({ assignment, user: { planId: "creator", pointsBalance: 600 }, pointsGranted: 500 });
        expect(mocks.updateUser).toHaveBeenCalledWith(baseUser.id, { planId: "creator" });
        expect(mocks.createOrderPlanAssignment).toHaveBeenCalledTimes(1);
    });

    it("accepts a verified late payment for a system-expired order and clears its closed timestamp", async () => {
        mocks.order = {
            ...pointsOrder,
            status: "closed",
            closedAt: "2026-07-23T00:31:00.000Z",
            metadata: { close: { source: "expiration-job", reason: "订单超时自动关闭" } },
        };

        const result = await completeBillingOrderPayment({ orderId: pointsOrder.id, providerTradeId: "late-paid", paidAt: "2026-07-23T00:32:00.000Z" });

        expect(result.order).toMatchObject({ status: "paid", closedAt: undefined });
        expect(mocks.updateOrder).toHaveBeenCalledWith(pointsOrder.id, expect.objectContaining({ status: "paid", closedAt: undefined }));
        expect(mocks.adjustPoints).toHaveBeenCalledTimes(1);
    });

    it("refunds a points product without changing the user's existing plan", async () => {
        const paidOrder = { ...pointsOrder, status: "paid" } satisfies BillingOrderRecord;
        mocks.order = paidOrder;
        mocks.user = { ...baseUser, pointsBalance: 600 };
        mocks.payments = [
            {
                id: "payment-points",
                orderId: paidOrder.id,
                userId: paidOrder.userId,
                provider: "manual",
                channel: "manual",
                status: "succeeded",
                amountCents: paidOrder.amountCents,
                currency: paidOrder.currency,
                providerTradeId: "trade-points",
                providerPaymentId: "trade-points",
                createdAt: now,
                updatedAt: now,
            },
        ];

        const result = await refundBillingOrder(paidOrder.id);

        expect(result).toMatchObject({ order: { status: "refunded" }, user: { planId: "existing-plan", pointsBalance: 100 }, pointsReversed: 500 });
        expect(mocks.updateUser).not.toHaveBeenCalled();
        expect(mocks.listPlanAssignments).not.toHaveBeenCalled();
        expect(mocks.getActivePlanAssignment).not.toHaveBeenCalled();
        expect(mocks.getSettings).not.toHaveBeenCalled();
    });
});
