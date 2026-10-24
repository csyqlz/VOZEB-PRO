import { randomUUID } from "node:crypto";

import { lockBillingOrderCoupon, prepareBillingOrderCommerce, redeemBillingOrderCoupon, releaseBillingOrderCoupon } from "@/lib/server/billing-commerce-service";
import { BillingInputError, isBillingInputError } from "@/lib/server/billing-errors";
import { lockAuthMutation } from "@/lib/server/auth-mutation-lock";
import { expirePendingBillingOrders } from "@/lib/server/billing-order-expiration-service";
import {
    createPostgresRepositories,
    ensurePostgresSchema,
    isPostgresDatabaseEnabled,
    withPostgresTransaction,
    type BillingOrderRecord,
    type BillingOrderStatus,
    type BillingProductRecord,
    type JsonValue,
    type PaymentTransactionRecord,
    type QueryExecutor,
    type UserPlanAssignmentRecord,
} from "@/lib/server/database";
import { getPaymentRuntimeConfig, isPaymentRuntimeProviderCheckoutReady } from "@/lib/server/payment-config-store";
import { adjustPermanentPointsInPostgresTransaction } from "@/lib/server/points-wallet-service";
import { resolveBillingProductPrices } from "@/lib/server/promotion-service";
import { prepareReferralRewardsForPaidOrder } from "@/lib/server/referral-service";
import {
    assertBillingDatabaseReady,
    buildPaidOrderResult,
    createOrderPlanAssignment,
    deterministicPaymentId,
    generateOrderNo,
    isAutomaticallyExpiredOrder,
    mergeJson,
    normalizeBillingProductInput,
    normalizeBillingProductPatch,
    normalizeCurrency,
    normalizeId,
    normalizeIso,
    normalizeMoneyLike,
    normalizeOptionalDate,
    normalizeOptionalText,
    normalizePositiveInteger,
    normalizeProvider,
    normalizeText,
    orderExpiresMinutes,
    resolveEnabledPlan,
    roundAmount,
    sanitizeJson,
} from "@/lib/server/billing-service-helpers";
import { normalizePage, normalizePageSize } from "@/lib/server/database/repository-shared";

export { BillingInputError, isBillingInputError };
export { expirePendingBillingOrders };

export type BillingProductInput = {
    id?: unknown;
    productKind?: unknown;
    planId?: unknown;
    name?: unknown;
    description?: unknown;
    amountCents?: unknown;
    currency?: unknown;
    pointsAmount?: unknown;
    dailyPoints?: unknown;
    periodDays?: unknown;
    enabled?: unknown;
    sortOrder?: unknown;
    metadata?: unknown;
};

type CreateBillingOrderInput = {
    userId: string;
    productId?: unknown;
    quantity?: unknown;
    provider?: unknown;
    userCouponId?: unknown;
};

type CompleteBillingOrderPaymentInput = {
    orderId: string;
    provider?: unknown;
    channel?: unknown;
    providerTradeId?: unknown;
    providerPaymentId?: unknown;
    amountCents?: unknown;
    currency?: unknown;
    rawPayload?: unknown;
    paidAt?: unknown;
    verificationSource?: "provider" | "admin";
};

type BillingOperationInput = {
    reason?: unknown;
    operatorUserId?: unknown;
    rawPayload?: unknown;
};

export async function listBillingProducts(includeDisabled = false) {
    await assertBillingDatabaseReady();
    return resolveBillingProductPrices(await createPostgresRepositories().billing.listProducts(includeDisabled));
}

export async function upsertBillingProduct(input: BillingProductInput) {
    await assertBillingDatabaseReady();
    return withPostgresTransaction(async (client) => {
        const repos = createPostgresRepositories(client);
        const product = await normalizeBillingProductInput(input, client);
        return repos.billing.upsertProduct(product);
    });
}

export async function updateBillingProduct(id: string, input: BillingProductInput) {
    await assertBillingDatabaseReady();
    return withPostgresTransaction(async (client) => {
        const repos = createPostgresRepositories(client);
        const current = await repos.billing.getProductById(normalizeId(id));
        if (!current) throw new BillingInputError("套餐商品不存在", 404);
        const patch = await normalizeBillingProductPatch(input, current, client);
        const product = await repos.billing.updateProduct(current.id, patch);
        if (!product) throw new BillingInputError("套餐商品不存在", 404);
        return product;
    });
}

export async function deleteBillingProduct(id: string) {
    await assertBillingDatabaseReady();
    return withPostgresTransaction(async (client) => {
        const repos = createPostgresRepositories(client);
        const productId = normalizeId(id);
        const current = await repos.billing.getProductById(productId);
        if (!current) throw new BillingInputError("套餐商品不存在", 404);
        const deleted = await repos.billing.deleteProductIfUnused(productId);
        if (!deleted) throw new BillingInputError("该商品已有订单记录，不能永久删除，请改为下架", 409);
        return deleted;
    });
}

export async function listUserBillingOrders(userId: string, input: { page?: number; pageSize?: number; status?: BillingOrderStatus } = {}) {
    if (!isPostgresDatabaseEnabled()) return { items: [], total: 0, page: normalizePage(input.page), pageSize: normalizePageSize(input.pageSize) };
    await expirePendingBillingOrders();
    return createPostgresRepositories().billing.listOrders({ ...input, userId });
}

export async function listAdminBillingOrders(input: { page?: number; pageSize?: number; status?: BillingOrderStatus; userId?: string; productId?: string; keyword?: string } = {}) {
    await expirePendingBillingOrders();
    return createPostgresRepositories().billing.listOrders(input);
}

export async function getAdminBillingSummary(input: { startDate?: unknown; endDate?: unknown } = {}) {
    await expirePendingBillingOrders();
    return createPostgresRepositories().billing.getSummary({
        startDate: normalizeOptionalDate(input.startDate, "start"),
        endDate: normalizeOptionalDate(input.endDate, "end"),
    });
}

export async function getBillingOrderForUser(userId: string, orderId: string) {
    await expirePendingBillingOrders({ orderId });
    const order = await createPostgresRepositories().billing.getOrderById(normalizeId(orderId));
    if (!order || order.userId !== userId) throw new BillingInputError("订单不存在", 404);
    return order;
}

export async function cancelBillingOrderForUser(userId: string, orderId: string) {
    await assertBillingDatabaseReady();
    await expirePendingBillingOrders({ orderId });
    return withPostgresTransaction(async (client) => {
        const repos = createPostgresRepositories(client);
        const order = await repos.billing.getOrderById(normalizeId(orderId), true);
        if (!order || order.userId !== userId) throw new BillingInputError("订单不存在", 404);
        if (order.status === "canceled" || order.status === "closed" || order.status === "paid") return order;
        if (order.status !== "pending") throw new BillingInputError("当前订单状态不能取消", 409);
        await releaseBillingOrderCoupon(client, order);
        const canceled = await repos.billing.updateOrder(order.id, { status: "canceled", closedAt: new Date().toISOString() });
        if (!canceled) throw new BillingInputError("订单不存在", 404);
        return canceled;
    });
}

export async function createBillingOrder(input: CreateBillingOrderInput) {
    await assertBillingDatabaseReady();
    const paymentConfig = await getPaymentRuntimeConfig();
    return withPostgresTransaction(async (client) => {
        const repos = createPostgresRepositories(client);
        const user = await repos.users.getById(input.userId);
        if (!user || user.status !== "active") throw new BillingInputError("用户不可用", 403);

        const productId = normalizeId(input.productId);
        if (!productId) throw new BillingInputError("请选择商品");
        const product = await repos.billing.getProductById(productId, true);
        if (!product || !product.enabled) throw new BillingInputError("商品不存在或已下架", 404);

        const plan = product.productKind === "plan" ? await resolveEnabledPlan(product.planId || "", client) : undefined;
        const quantity = normalizePositiveInteger(input.quantity, 1, 100, 1);
        const provider = normalizeProvider(input.provider);
        if (!isPaymentRuntimeProviderCheckoutReady(paymentConfig, provider)) throw new BillingInputError("该支付渠道未启用或配置不完整", 400);
        const now = new Date();
        const nowIso = now.toISOString();
        const commerce = await prepareBillingOrderCommerce({
            db: client,
            product,
            userId: user.id,
            quantity,
            userCouponId: normalizeId(input.userCouponId) || undefined,
            now,
        });
        const order: BillingOrderRecord = {
            id: randomUUID(),
            orderNo: generateOrderNo(),
            productId: product.id,
            userId: user.id,
            productKind: product.productKind,
            planId: plan?.id,
            status: "pending",
            subject: product.name,
            listAmountCents: commerce.price.listAmountCents,
            promotionDiscountCents: commerce.price.promotionDiscountCents,
            couponDiscountCents: commerce.price.couponDiscountCents,
            amountCents: commerce.price.payableAmountCents,
            currency: product.currency,
            pointsAmount: roundAmount(product.pointsAmount * quantity),
            dailyPoints: product.dailyPoints,
            periodDays: product.productKind === "plan" ? product.periodDays * quantity : 0,
            quantity,
            provider,
            promotionCampaignId: commerce.price.promotion?.id,
            userCouponId: commerce.coupon?.id,
            expiresAt: new Date(now.getTime() + orderExpiresMinutes() * 60_000).toISOString(),
            pricingSnapshot: commerce.pricingSnapshot,
            metadata: {
                product: {
                    id: product.id,
                    kind: product.productKind,
                    name: product.name,
                    description: product.description,
                    unitAmountCents: product.amountCents,
                    unitPointsAmount: product.pointsAmount,
                    dailyPoints: product.dailyPoints,
                    unitPeriodDays: product.periodDays,
                },
                ...(plan ? { plan: { id: plan.id, name: plan.name } } : {}),
            },
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const created = await repos.billing.createOrder(order);
        await lockBillingOrderCoupon(client, created, commerce.coupon, nowIso);
        return created;
    });
}

export async function completeBillingOrderPayment(input: CompleteBillingOrderPaymentInput) {
    await assertBillingDatabaseReady();
    return withPostgresTransaction(async (client) => {
        await lockAuthMutation(client);
        const repos = createPostgresRepositories(client);
        const order = await repos.billing.getOrderById(normalizeId(input.orderId), true);
        if (!order) throw new BillingInputError("订单不存在", 404);
        const provider = normalizeProvider(input.provider || order.provider);
        if (provider !== normalizeProvider(order.provider)) throw new BillingInputError("支付回调渠道与订单渠道不一致", 409);
        const providerVerified = input.verificationSource === "provider";
        if (providerVerified && input.amountCents === undefined) throw new BillingInputError("支付金额尚未核实", 409);
        if (providerVerified && input.currency === undefined) throw new BillingInputError("支付币种尚未核实", 409);
        const paidAmountCents = input.amountCents === undefined ? order.amountCents : normalizePositiveInteger(input.amountCents, 0, 100_000_000, -1);
        if (paidAmountCents !== order.amountCents) throw new BillingInputError("支付金额与订单金额不一致", 409);
        const paidCurrency = input.currency === undefined ? order.currency : normalizeCurrency(input.currency);
        if (paidCurrency !== order.currency) throw new BillingInputError("支付币种与订单币种不一致", 409);
        const incomingTradeId = normalizeText(input.providerTradeId, "", 160);
        const incomingPaymentId = normalizeText(input.providerPaymentId, "", 160);
        const incomingIdentifiers = [...new Set([incomingTradeId, incomingPaymentId].filter(Boolean))];
        if (providerVerified && !incomingIdentifiers.length) throw new BillingInputError("支付交易号尚未核实", 409);
        await repos.billing.lockPaymentIdentity(provider, incomingIdentifiers.length ? incomingIdentifiers : [`order:${order.id}`]);
        const existingPayment = incomingIdentifiers.length ? await repos.billing.getPaymentByProviderIdentifiers(provider, incomingIdentifiers, true) : null;
        if (existingPayment) assertPaymentTransactionOwnership(existingPayment, order, provider);
        if (order.status === "paid") {
            assertDuplicatePaymentIdentity(order, input);
            return buildPaidOrderResult(order, client);
        }
        if (order.status !== "pending" && !isAutomaticallyExpiredOrder(order)) throw new BillingInputError("当前订单状态不能确认支付", 409);
        if (!order.userId) throw new BillingInputError("订单没有绑定用户", 409);

        const user = await repos.users.getById(order.userId);
        if (!user || user.status !== "active") throw new BillingInputError("用户不可用", 403);

        const paidAt = normalizeIso(input.paidAt, new Date().toISOString());
        const providerTradeId = incomingTradeId || `${provider}:${order.orderNo}`;
        const providerPaymentId = incomingPaymentId || providerTradeId;
        await redeemBillingOrderCoupon(client, order, paidAt);
        const payment: PaymentTransactionRecord = {
            id: deterministicPaymentId(provider, providerTradeId),
            orderId: order.id,
            userId: user.id,
            provider,
            channel: normalizeText(input.channel, "", 60),
            status: "succeeded",
            amountCents: order.amountCents,
            currency: order.currency,
            providerTradeId,
            providerPaymentId,
            rawPayload: sanitizeJson(input.rawPayload),
            paidAt,
            createdAt: paidAt,
            updatedAt: paidAt,
        };
        const savedPayment = await repos.billing.upsertPayment(payment);
        assertPaymentTransactionOwnership(savedPayment, order, provider);

        if (order.pointsAmount > 0) {
            await adjustPermanentPointsInPostgresTransaction(client, {
                userId: user.id,
                amount: order.pointsAmount,
                description: `订单支付：${order.subject}`,
                idempotencyKey: `billing-order:${order.id}:credit`,
                type: "credit",
                now: new Date(paidAt),
            });
        }
        let updatedUser = user;
        let assignment: UserPlanAssignmentRecord | undefined;
        if (order.productKind === "plan") {
            if (!order.planId) throw new BillingInputError("套餐订单缺少套餐权益", 409);
            const planUser = await repos.users.update(user.id, { planId: order.planId });
            if (!planUser) throw new BillingInputError("用户不存在", 404);
            updatedUser = planUser;
            assignment = await createOrderPlanAssignment(order, paidAt, client);
        } else {
            const refreshedUser = await repos.users.getById(user.id);
            if (!refreshedUser) throw new BillingInputError("用户不存在", 404);
            updatedUser = refreshedUser;
        }
        const paidOrder = await repos.billing.updateOrder(order.id, {
            status: "paid",
            provider,
            providerOrderId: providerTradeId,
            providerPaymentId,
            paidAt,
            closedAt: undefined,
        });
        if (!paidOrder) throw new BillingInputError("订单不存在", 404);
        await prepareReferralRewardsForPaidOrder(client, { order: paidOrder, provider, rawPayload: savedPayment.rawPayload, paidAt });

        return {
            order: paidOrder,
            payment: savedPayment,
            assignment,
            user: updatedUser,
            pointsGranted: order.pointsAmount,
        };
    });
}

function assertPaymentTransactionOwnership(payment: PaymentTransactionRecord, order: BillingOrderRecord, provider: string) {
    if (payment.orderId !== order.id || payment.userId !== order.userId || normalizeProvider(payment.provider) !== provider) {
        throw new BillingInputError("该支付交易已绑定其他订单，禁止重复发放权益", 409);
    }
    if (payment.amountCents !== order.amountCents || normalizeCurrency(payment.currency) !== normalizeCurrency(order.currency)) {
        throw new BillingInputError("支付交易金额或币种与订单快照不一致", 409);
    }
}

function assertDuplicatePaymentIdentity(order: BillingOrderRecord, input: Pick<CompleteBillingOrderPaymentInput, "providerTradeId" | "providerPaymentId">) {
    const incoming = [normalizeText(input.providerTradeId, "", 160), normalizeText(input.providerPaymentId, "", 160)].filter(Boolean);
    const stored = [order.providerOrderId, order.providerPaymentId].map((value) => normalizeText(value, "", 160)).filter(Boolean);
    if (incoming.length && stored.length && !incoming.some((value) => stored.includes(value))) throw new BillingInputError("订单已由另一笔支付交易完成，请人工核对并处理重复付款", 409);
}

export async function closeBillingOrder(orderId: string, input: BillingOperationInput = {}) {
    await assertBillingDatabaseReady();
    return withPostgresTransaction(async (client) => {
        const repos = createPostgresRepositories(client);
        const order = await repos.billing.getOrderById(normalizeId(orderId), true);
        if (!order) throw new BillingInputError("订单不存在", 404);
        if (order.status === "closed") return { order };
        if (order.status !== "pending") throw new BillingInputError("只有待支付订单可以关闭", 409);

        const now = new Date().toISOString();
        await releaseBillingOrderCoupon(client, order);
        const updatedOrder = await repos.billing.updateOrder(order.id, {
            status: "closed",
            closedAt: now,
            metadata: mergeJson(order.metadata, {
                close: {
                    reason: normalizeText(input.reason, "运营关闭", 200),
                    operatorUserId: normalizeOptionalText(input.operatorUserId, 120) || "",
                    closedAt: now,
                },
            }),
        });
        if (!updatedOrder) throw new BillingInputError("订单不存在", 404);
        return { order: updatedOrder };
    });
}

export { refundBillingOrder } from "@/lib/server/billing-refund-orchestration-service";
