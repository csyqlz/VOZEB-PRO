import { createSign, generateKeyPairSync } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BillingOrderRecord, PaymentTransactionRecord } from "@/lib/server/database";
import { BillingInputError } from "./billing-errors";

const mocks = vi.hoisted(() => ({
    runtimeConfig: {
        saved: { providers: {} },
        valuesByEnvName: {} as Record<string, string>,
        providers: {},
    },
}));

vi.mock("@/lib/server/payment-config-store", () => ({
    getPaymentRuntimeConfig: vi.fn(async () => mocks.runtimeConfig),
    getPaymentRuntimeEnv: (config: typeof mocks.runtimeConfig, name: string) => config.valuesByEnvName[name]?.trim() || process.env[name]?.trim() || "",
    getPaymentRuntimeValue: (config: typeof mocks.runtimeConfig, ...names: string[]) => names.map((name) => config.valuesByEnvName[name]?.trim() || process.env[name]?.trim() || "").find(Boolean) || "",
}));
vi.mock("@/lib/server/safe-outbound-fetch", () => ({ fetchSafeOutbound: (url: string | URL, init?: RequestInit) => fetch(url, init) }));

import { refundPaymentTransaction } from "./payment-refund-service";

const order = {
    id: "order-one",
    orderNo: "VZ001",
    productId: "product",
    userId: "user",
    productKind: "plan",
    planId: "pro",
    status: "paid",
    subject: "Pro",
    listAmountCents: 1299,
    promotionDiscountCents: 0,
    couponDiscountCents: 0,
    amountCents: 1299,
    currency: "USD",
    pointsAmount: 100,
    dailyPoints: 20,
    periodDays: 30,
    quantity: 1,
    provider: "stripe",
    providerOrderId: "cs_test_session",
    providerPaymentId: "cs_test_session",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
} satisfies BillingOrderRecord;

const payment = {
    id: "payment-one",
    orderId: order.id,
    userId: order.userId,
    provider: "stripe",
    channel: "checkout.session.completed",
    status: "succeeded",
    amountCents: order.amountCents,
    currency: order.currency,
    providerTradeId: "pi_test_payment",
    providerPaymentId: "cs_test_session",
    rawPayload: {},
    paidAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
} satisfies PaymentTransactionRecord;

function testPrivateKey() {
    return generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

describe("payment refunds", () => {
    beforeEach(() => {
        mocks.runtimeConfig.valuesByEnvName = {};
        vi.unstubAllGlobals();
    });

    it("creates a Stripe refund with a payment intent and idempotency key", async () => {
        mocks.runtimeConfig.valuesByEnvName = {
            VOZEB_PRO_STRIPE_SECRET_KEY: "sk_test_secret",
            VOZEB_PRO_STRIPE_API_BASE: "https://stripe.test",
        };
        const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ id: "re_123", status: "succeeded" }));
        vi.stubGlobal("fetch", fetchMock);

        const result = await refundPaymentTransaction(order, payment, { reason: "重复购买", operatorUserId: "admin" });

        expect(result).toMatchObject({ provider: "stripe", status: "succeeded", providerRefundId: "re_123" });
        expect(fetchMock).toHaveBeenCalledWith(
            "https://stripe.test/v1/refunds",
            expect.objectContaining({
                method: "POST",
                headers: expect.objectContaining({
                    authorization: "Bearer sk_test_secret",
                    "Idempotency-Key": "vozeb-pro-refund-order-one",
                }),
            }),
        );
        const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
        expect(body.get("payment_intent")).toBe("pi_test_payment");
        expect(body.get("charge")).toBeNull();
        expect(body.get("amount")).toBe("1299");
        expect(body.get("metadata[orderNo]")).toBe(order.orderNo);
    });

    it("uses a Stripe charge when that is the only refundable provider id", async () => {
        mocks.runtimeConfig.valuesByEnvName = { VOZEB_PRO_STRIPE_SECRET_KEY: "sk_test_secret" };
        const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ id: "re_456", status: "pending" }));
        vi.stubGlobal("fetch", fetchMock);

        const result = await refundPaymentTransaction({ ...order, providerPaymentId: "ch_test_charge" }, { ...payment, providerTradeId: "cs_test_session", providerPaymentId: "ch_test_charge" });

        expect(result.status).toBe("pending");
        const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
        expect(body.get("charge")).toBe("ch_test_charge");
        expect(body.get("payment_intent")).toBeNull();
    });

    it("surfaces Stripe provider errors without treating the order as refunded", async () => {
        mocks.runtimeConfig.valuesByEnvName = { VOZEB_PRO_STRIPE_SECRET_KEY: "sk_test_secret" };
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => Response.json({ error: { message: "No such payment_intent" } }, { status: 404 })),
        );

        await expect(refundPaymentTransaction(order, payment)).rejects.toMatchObject({ message: "No such payment_intent", status: 400 });
    });

    it("keeps manual refunds local and does not call a provider", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        await expect(refundPaymentTransaction({ ...order, provider: "manual" }, undefined)).resolves.toMatchObject({ provider: "manual", status: "manual" });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("blocks PayPly refunds until an automatic refund endpoint is configured", async () => {
        mocks.runtimeConfig.valuesByEnvName = { VOZEB_PRO_PAYPLY_API_KEY: "payply-secret" };

        await expect(refundPaymentTransaction({ ...order, provider: "payply" }, { ...payment, provider: "payply" })).rejects.toThrow("未配置自动退款接口");
    });

    it("creates an Alipay refund with signed gateway parameters", async () => {
        mocks.runtimeConfig.valuesByEnvName = {
            VOZEB_PRO_ALIPAY_APP_ID: "2026000000000000",
            VOZEB_PRO_ALIPAY_PRIVATE_KEY: testPrivateKey(),
            VOZEB_PRO_ALIPAY_GATEWAY_URL: "https://alipay.test/gateway.do",
        };
        const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
            Response.json({
                alipay_trade_refund_response: {
                    code: "10000",
                    msg: "Success",
                    out_request_no: "refund-request",
                },
            }),
        );
        vi.stubGlobal("fetch", fetchMock);

        const result = await refundPaymentTransaction({ ...order, provider: "alipay", currency: "CNY" }, { ...payment, provider: "alipay", providerPaymentId: "2026071500000000001" }, { reason: "重复支付" });

        expect(result).toMatchObject({ provider: "alipay", status: "succeeded", providerRefundId: "refund-request" });
        expect(fetchMock).toHaveBeenCalledWith(
            "https://alipay.test/gateway.do",
            expect.objectContaining({
                method: "POST",
                headers: expect.objectContaining({ "content-type": "application/x-www-form-urlencoded; charset=utf-8" }),
            }),
        );
        const params = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
        expect(params.get("method")).toBe("alipay.trade.refund");
        expect(params.get("app_id")).toBe("2026000000000000");
        expect(params.get("sign")).toBeTruthy();
        const bizContent = JSON.parse(params.get("biz_content") || "{}") as Record<string, unknown>;
        expect(bizContent).toMatchObject({
            out_trade_no: order.orderNo,
            trade_no: "2026071500000000001",
            refund_amount: "12.99",
            refund_reason: "重复支付",
        });
    });

    it("decodes Alipay GBK error responses before exposing the provider message", async () => {
        mocks.runtimeConfig.valuesByEnvName = {
            VOZEB_PRO_ALIPAY_APP_ID: "2026000000000000",
            VOZEB_PRO_ALIPAY_PRIVATE_KEY: testPrivateKey(),
            VOZEB_PRO_ALIPAY_GATEWAY_URL: "https://alipay.test/gateway.do",
        };
        const gbkPayload = new Uint8Array([
            123, 34, 97, 108, 105, 112, 97, 121, 95, 116, 114, 97, 100, 101, 95, 114, 101, 102, 117, 110, 100, 95, 114, 101, 115, 112, 111, 110, 115, 101, 34, 58, 123, 34, 99, 111, 100, 101, 34, 58, 34, 52, 48, 48, 48, 52, 34, 44, 34, 115, 117, 98, 95,
            109, 115, 103, 34, 58, 34, 205, 203, 191, 238, 199, 235, 199, 243, 178, 206, 202, 253, 180, 237, 206, 243, 34, 125, 125,
        ]);
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(gbkPayload, { status: 400, headers: { "content-type": "application/json; charset=GBK" } })),
        );

        await expect(refundPaymentTransaction({ ...order, provider: "alipay", currency: "CNY" }, { ...payment, provider: "alipay" })).rejects.toMatchObject({
            message: "退款请求参数错误",
            status: 400,
        });
    });

    it("creates a WeChat Pay v3 refund with signed JSON payload", async () => {
        const platformKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
        const platformPublicKey = platformKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
        mocks.runtimeConfig.valuesByEnvName = {
            VOZEB_PRO_WECHAT_PAY_MCH_ID: "1900000001",
            VOZEB_PRO_WECHAT_PAY_CERT_SERIAL_NO: "serial-no",
            VOZEB_PRO_WECHAT_PAY_PRIVATE_KEY: testPrivateKey(),
            VOZEB_PRO_WECHAT_PAY_PLATFORM_PUBLIC_KEY: platformPublicKey,
            VOZEB_PRO_WECHAT_PAY_API_BASE: "https://wechat.test",
            VOZEB_PRO_WECHAT_PAY_REFUND_NOTIFY_URL: "https://example.com/refund-notify",
        };
        const responseBody = JSON.stringify({ refund_id: "5030001", status: "PROCESSING" });
        const responseTimestamp = "1785600000";
        const responseNonce = "wechat-refund-response";
        const responseSignature = createSign("RSA-SHA256").update(`${responseTimestamp}\n${responseNonce}\n${responseBody}\n`, "utf8").sign(platformKeyPair.privateKey, "base64");
        const fetchMock = vi.fn(
            async (_url: string, _init?: RequestInit) =>
                new Response(responseBody, {
                    headers: {
                        "content-type": "application/json",
                        "wechatpay-timestamp": responseTimestamp,
                        "wechatpay-nonce": responseNonce,
                        "wechatpay-signature": responseSignature,
                    },
                }),
        );
        vi.stubGlobal("fetch", fetchMock);

        const result = await refundPaymentTransaction({ ...order, provider: "wechat", currency: "CNY" }, { ...payment, provider: "wechat", providerPaymentId: "4200000000000000001" }, { reason: "运营退款" });

        expect(result).toMatchObject({ provider: "wechat", status: "pending", providerRefundId: "5030001" });
        expect(fetchMock).toHaveBeenCalledWith(
            "https://wechat.test/v3/refund/domestic/refunds",
            expect.objectContaining({
                method: "POST",
                headers: expect.objectContaining({
                    accept: "application/json",
                    "content-type": "application/json",
                }),
            }),
        );
        const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
        expect(String((init.headers as Record<string, string>).authorization)).toContain('mchid="1900000001"');
        const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(payload).toMatchObject({
            transaction_id: "4200000000000000001",
            reason: "运营退款",
            notify_url: "https://example.com/refund-notify",
            amount: { refund: 1299, total: 1299, currency: "CNY" },
        });
    });

    it("sends configurable PayPly refund requests and reads provider result fields", async () => {
        mocks.runtimeConfig.valuesByEnvName = {
            VOZEB_PRO_PAYPLY_API_KEY: "payply-secret",
            VOZEB_PRO_PAYPLY_REFUND_URL: "https://payply.test/refund",
            VOZEB_PRO_PAYPLY_REFUND_REQUEST_TEMPLATE: '{"tradeId":"{{providerTradeId}}","amount":{{amountCents}}}',
            VOZEB_PRO_PAYPLY_REFUND_STATUS_FIELD: "data.state",
            VOZEB_PRO_PAYPLY_REFUND_ID_FIELD: "data.refundNo",
            VOZEB_PRO_PAYPLY_REFUND_EXTRA_HEADERS: '{"x-refund":"1"}',
        };
        const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ data: { state: "success", refundNo: "rf_001" } }));
        vi.stubGlobal("fetch", fetchMock);

        const result = await refundPaymentTransaction({ ...order, provider: "payply" }, { ...payment, provider: "payply", providerTradeId: "trade-001" });

        expect(result).toMatchObject({ provider: "payply", status: "succeeded", providerRefundId: "rf_001" });
        expect(fetchMock).toHaveBeenCalledWith(
            "https://payply.test/refund",
            expect.objectContaining({
                method: "POST",
                headers: expect.objectContaining({
                    authorization: "Bearer payply-secret",
                    "idempotency-key": "vozeb-pro-refund-order-one",
                    "x-api-key": "payply-secret",
                    "x-refund": "1",
                }),
                body: JSON.stringify({ tradeId: "trade-001", amount: 1299 }),
            }),
        );
    });

    it("uses BillingInputError for providers without automatic refund support", async () => {
        await expect(refundPaymentTransaction({ ...order, provider: "unknown-pay" }, { ...payment, provider: "unknown-pay" })).rejects.toBeInstanceOf(BillingInputError);
    });
});
