import { createHash, randomBytes, randomUUID } from "node:crypto";

import { normalizePaymentProvider } from "@/lib/payment-provider";
import type { BillingProductInput } from "@/lib/server/billing-service";
import { BillingInputError } from "@/lib/server/billing-errors";
import { createPostgresRepositories, ensurePostgresSchema, isPostgresDatabaseEnabled, type BillingOrderRecord, type BillingProductRecord, type JsonValue, type QueryExecutor, type UserPlanAssignmentRecord } from "@/lib/server/database";
import type { PaymentRefundResult } from "@/lib/server/payment-refund-service";

const DEFAULT_ORDER_EXPIRES_MINUTES = 30;
const REFUND_CLAIM_TTL_MS = 10 * 60 * 1000;

export function isRefundClaimStale(order: BillingOrderRecord) {
    const startedAt = Date.parse(readRefundAttempt(order.metadata)?.startedAt || "");
    return !Number.isFinite(startedAt) || Date.now() - startedAt >= REFUND_CLAIM_TTL_MS;
}

export function readRefundAttempt(metadata: JsonValue | undefined): Record<string, string> | undefined {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
    const value = (metadata as Record<string, JsonValue>).refundAttempt;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item === "string" ? item : String(item)]));
}

export function isAutomaticallyExpiredOrder(order: BillingOrderRecord) {
    if (order.status !== "closed" || !order.metadata || typeof order.metadata !== "object" || Array.isArray(order.metadata)) return false;
    const close = (order.metadata as Record<string, JsonValue>).close;
    return Boolean(close && typeof close === "object" && !Array.isArray(close) && close.source === "expiration-job");
}

export async function buildPaidOrderResult(order: BillingOrderRecord, db?: QueryExecutor) {
    const repos = createPostgresRepositories(db);
    const payment = await repos.billing.findOrderPayment({ orderId: order.id, statuses: ["succeeded"] });
    const assignment = order.productKind === "plan" ? await repos.billing.getPlanAssignmentBySource("order", order.id) : null;
    const user = order.userId ? await repos.users.getById(order.userId) : null;
    return {
        order,
        payment: payment || undefined,
        assignment: assignment || undefined,
        user,
        pointsGranted: 0,
    };
}

export async function buildRefundedOrderResult(order: BillingOrderRecord, db?: QueryExecutor) {
    const repos = createPostgresRepositories(db);
    const payment = await repos.billing.findOrderPayment({ orderId: order.id, statuses: ["refunded"] });
    const assignment = order.productKind === "plan" ? await repos.billing.getPlanAssignmentBySource("order", order.id) : null;
    const user = order.userId ? await repos.users.getById(order.userId) : null;
    return {
        order,
        payment: payment || undefined,
        assignment: assignment || undefined,
        user,
        pointsReversed: 0,
    };
}

export async function createOrderPlanAssignment(order: BillingOrderRecord, paidAt: string, db: QueryExecutor) {
    if (!order.userId) throw new BillingInputError("订单没有绑定用户", 409);
    if (order.productKind !== "plan" || !order.planId) throw new BillingInputError("余额充值订单不能创建套餐权益", 409);
    const repos = createPostgresRepositories(db);
    const active = await repos.billing.getActivePlanAssignment(order.userId, new Date(paidAt));
    const paidDate = new Date(paidAt);
    const canExtendActive = Boolean(active && active.planId === order.planId && active.endsAt && Date.parse(active.endsAt) > paidDate.getTime());
    const baseEnd = canExtendActive && active?.endsAt ? new Date(active.endsAt) : paidDate;
    const endsAt = order.periodDays > 0 ? new Date(baseEnd.getTime() + order.periodDays * 24 * 60 * 60_000).toISOString() : undefined;
    const assignment: UserPlanAssignmentRecord = {
        id: randomUUID(),
        userId: order.userId,
        planId: order.planId,
        status: "active",
        source: "order",
        sourceId: order.id,
        startsAt: paidAt,
        endsAt,
        metadata: {
            orderNo: order.orderNo,
            subject: order.subject,
            amountCents: order.amountCents,
            currency: order.currency,
            pointsAmount: order.pointsAmount,
            dailyPoints: order.dailyPoints,
            periodDays: order.periodDays,
        },
        createdAt: paidAt,
        updatedAt: paidAt,
    };
    return repos.billing.createPlanAssignment(assignment);
}

export async function normalizeBillingProductInput(input: BillingProductInput, db: QueryExecutor): Promise<BillingProductRecord> {
    const now = new Date().toISOString();
    const id = normalizeId(input.id) || randomUUID();
    const productKind = input.productKind === "points" ? "points" : "plan";
    const plan = productKind === "plan" ? await resolveEnabledPlan(normalizeId(input.planId), db) : undefined;
    const name = normalizeText(input.name, "", 80);
    if (!name) throw new BillingInputError("请填写商品名称");
    const amountCents = normalizePositiveInteger(input.amountCents, 0, 100_000_000, 0);
    const pointsAmount = normalizeMoneyLike(input.pointsAmount, 0, 1_000_000);
    const dailyPoints = productKind === "plan" ? normalizeMoneyLike(input.dailyPoints, plan?.dailyPoints || 0, 1_000_000) : 0;
    if (productKind === "points" && pointsAmount <= 0) throw new BillingInputError("余额充值商品的金额必须大于零");
    if (pointsAmount > 0 && amountCents <= 0) throw new BillingInputError(productKind === "points" ? "余额充值商品价格必须大于零" : "赠送余额的商品价格必须大于零");
    return {
        id,
        productKind,
        planId: plan?.id,
        name,
        description: normalizeText(input.description, "", 500),
        amountCents,
        currency: normalizeCurrency(input.currency),
        pointsAmount,
        dailyPoints,
        periodDays: productKind === "plan" ? normalizePositiveInteger(input.periodDays, 1, 36_500, 30) : 0,
        enabled: input.enabled !== false,
        sortOrder: normalizeInteger(input.sortOrder, 0, 10_000, 0),
        metadata: sanitizeJson(input.metadata),
        createdAt: now,
        updatedAt: now,
    };
}

export async function normalizeBillingProductPatch(input: BillingProductInput, current: BillingProductRecord, db: QueryExecutor): Promise<Partial<Omit<BillingProductRecord, "id" | "createdAt" | "updatedAt">>> {
    const patch: Partial<Omit<BillingProductRecord, "id" | "createdAt" | "updatedAt">> = {};
    const productKind = input.productKind === undefined ? current.productKind : input.productKind === "points" ? "points" : "plan";
    if (input.productKind !== undefined) patch.productKind = productKind;
    if (productKind === "points") patch.planId = undefined;
    else if (input.planId !== undefined || current.productKind === "points" || !current.planId) patch.planId = (await resolveEnabledPlan(normalizeId(input.planId) || current.planId || "", db)).id;
    if (input.name !== undefined) {
        const name = normalizeText(input.name, "", 80);
        if (!name) throw new BillingInputError("请填写商品名称");
        patch.name = name;
    }
    if (input.description !== undefined) patch.description = normalizeText(input.description, "", 500);
    if (input.amountCents !== undefined) patch.amountCents = normalizePositiveInteger(input.amountCents, 0, 100_000_000, current.amountCents);
    if (input.currency !== undefined) patch.currency = normalizeCurrency(input.currency);
    if (input.pointsAmount !== undefined) patch.pointsAmount = normalizeMoneyLike(input.pointsAmount, current.pointsAmount, 1_000_000);
    if (productKind === "points") {
        patch.dailyPoints = 0;
        patch.periodDays = 0;
    } else {
        if (input.dailyPoints !== undefined) patch.dailyPoints = normalizeMoneyLike(input.dailyPoints, current.dailyPoints, 1_000_000);
        if (input.periodDays !== undefined || current.productKind === "points") patch.periodDays = normalizePositiveInteger(input.periodDays, 1, 36_500, current.periodDays || 30);
    }
    if (input.enabled !== undefined) patch.enabled = input.enabled !== false;
    if (input.sortOrder !== undefined) patch.sortOrder = normalizeInteger(input.sortOrder, 0, 10_000, current.sortOrder);
    if (input.metadata !== undefined) patch.metadata = sanitizeJson(input.metadata);
    const finalAmountCents = patch.amountCents ?? current.amountCents;
    const finalPointsAmount = patch.pointsAmount ?? current.pointsAmount;
    if (productKind === "points" && finalPointsAmount <= 0) throw new BillingInputError("余额充值商品的金额必须大于零");
    if (finalPointsAmount > 0 && finalAmountCents <= 0) throw new BillingInputError(productKind === "points" ? "余额充值商品价格必须大于零" : "赠送余额的商品价格必须大于零");
    return patch;
}

export async function resolveEnabledPlan(planId: string, db: QueryExecutor) {
    const plan = (await createPostgresRepositories(db).settings.listEntitlementPlans()).find((item) => item.id === planId && item.enabled);
    if (!plan) throw new BillingInputError("套餐不存在或已停用", 404);
    return plan;
}

export async function assertBillingDatabaseReady() {
    if (!isPostgresDatabaseEnabled()) throw new BillingInputError("商业订单需要启用 PostgreSQL", 501);
    await ensurePostgresSchema();
}

export function generateOrderNo() {
    const date = new Date();
    const stamp = `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
    return `VZ${stamp}${randomBytes(4).toString("hex").toUpperCase()}`;
}

export function deterministicPaymentId(provider: string, providerTradeId: string) {
    return `pay_${createHash("sha256").update(`${provider}:${providerTradeId}`).digest("hex").slice(0, 32)}`;
}

export function orderExpiresMinutes() {
    return normalizeInteger(process.env.VOZEB_PRO_BILLING_ORDER_EXPIRES_MINUTES, 1, 24 * 60, DEFAULT_ORDER_EXPIRES_MINUTES);
}

export function normalizeId(value: unknown) {
    return normalizeText(value, "", 120).replace(/[^a-zA-Z0-9_.:-]/g, "");
}

export function normalizeProvider(value: unknown) {
    return normalizePaymentProvider(value);
}

export function normalizeCurrency(value: unknown) {
    const currency = normalizeText(value, "CNY", 8).toUpperCase();
    return /^[A-Z]{3,8}$/.test(currency) ? currency : "CNY";
}

export function normalizeText(value: unknown, fallback: string, maxLength: number) {
    const text = typeof value === "string" ? value.trim() : "";
    return (text || fallback).slice(0, maxLength);
}

export function normalizeIso(value: unknown, fallback: string) {
    const date = new Date(typeof value === "string" || typeof value === "number" ? value : fallback);
    return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

export function normalizeOptionalDate(value: unknown, edge: "start" | "end") {
    const text = normalizeText(value, "", 40);
    if (!text) return undefined;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T${edge === "start" ? "00:00:00.000" : "23:59:59.999"}+08:00`) : new Date(text);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function normalizeInteger(value: unknown, min: number, max: number, fallback: number) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(number)));
}

export function normalizePositiveInteger(value: unknown, min: number, max: number, fallback: number) {
    return normalizeInteger(value, min, max, fallback);
}

export function normalizeMoneyLike(value: unknown, fallback: number, max: number) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return fallback;
    return Math.min(max, roundAmount(number));
}

export function roundAmount(value: number) {
    return Number(value.toFixed(2));
}

export function normalizeOptionalText(value: unknown, maxLength: number) {
    const text = normalizeText(value, "", maxLength);
    return text || undefined;
}

export function mergeJson(current: JsonValue | undefined, patch: Record<string, JsonValue>): JsonValue {
    const source = current && typeof current === "object" && !Array.isArray(current) ? (current as Record<string, JsonValue>) : {};
    return { ...source, ...patch };
}

export function paymentRefundMetadata(refund: PaymentRefundResult, includeRawPayload: boolean): Record<string, JsonValue> {
    const metadata: Record<string, JsonValue> = {
        provider: refund.provider,
        status: refund.status,
        providerRefundId: refund.providerRefundId || "",
    };
    if (includeRawPayload && refund.rawPayload !== undefined) metadata.rawPayload = refund.rawPayload;
    return metadata;
}

export function sanitizeJson(value: unknown, depth = 0): JsonValue {
    if (depth > 4) return "[truncated]";
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeJson(item, depth + 1));
    if (!value || typeof value !== "object") return {};
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .slice(0, 80)
            .map(([key, item]) => [normalizeText(key, "", 80), sanitizeJson(item, depth + 1)] as const)
            .filter(([key]) => Boolean(key)),
    );
}

export function pad2(value: number) {
    return String(value).padStart(2, "0");
}
