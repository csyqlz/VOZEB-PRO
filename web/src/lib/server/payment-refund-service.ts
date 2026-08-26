import { createSign, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import { normalizePaymentProvider } from "@/lib/payment-provider";
import { BillingInputError } from "@/lib/server/billing-errors";
import type { BillingOrderRecord, JsonValue, PaymentTransactionRecord } from "@/lib/server/database";
import { getPaymentRuntimeConfig, getPaymentRuntimeEnv, getPaymentRuntimeValue, type PaymentRuntimeConfig } from "@/lib/server/payment-config-store";
import { loadPaymentPublicKey, verifyRsaSha256 } from "@/lib/server/payment-signature-utils";
import { fetchSafeOutbound } from "@/lib/server/safe-outbound-fetch";

export type PaymentRefundStatus = "succeeded" | "pending" | "manual";

export type PaymentRefundResult = {
    provider: string;
    status: PaymentRefundStatus;
    providerRefundId?: string;
    rawPayload?: JsonValue;
};

type PaymentRefundOptions = {
    reason?: string;
    operatorUserId?: string;
};

export async function refundPaymentTransaction(order: BillingOrderRecord, payment: PaymentTransactionRecord | undefined, options: PaymentRefundOptions = {}): Promise<PaymentRefundResult> {
    const provider = normalizeProvider(payment?.provider || order.provider);
    if (provider === "manual") return { provider, status: "manual", rawPayload: { mode: "manual" } };
    if (!payment) throw new BillingInputError("订单缺少支付流水，不能自动退款", 409);

    const paymentConfig = await getPaymentRuntimeConfig();
    if (provider === "stripe") return refundStripePayment(order, payment, options, paymentConfig);
    if (provider === "alipay") return refundAlipayPayment(order, payment, options, paymentConfig);
    if (provider === "wechat") return refundWechatPayment(order, payment, options, paymentConfig);
    if (provider === "payply") return refundPayplyPayment(order, payment, options, paymentConfig);
    throw new BillingInputError("该支付渠道未接入自动退款，不能直接标记本地退款", 409);
}

export async function reconcilePaymentRefund(order: BillingOrderRecord, payment: PaymentTransactionRecord | undefined, current: PaymentRefundResult, options: PaymentRefundOptions = {}): Promise<PaymentRefundResult> {
    if (!payment) throw new BillingInputError("订单缺少支付流水，不能查询退款", 409);
    const config = await getPaymentRuntimeConfig();
    if (current.provider === "stripe" && current.providerRefundId) return queryStripeRefund(current.providerRefundId, config);
    if (current.provider === "wechat") return queryWechatRefund(order, config);
    if (current.provider === "payply") {
        const queried = await queryPayplyRefund(order, payment, current, config);
        if (queried) return queried;
    }
    return refundPaymentTransaction(order, payment, options);
}

async function refundStripePayment(order: BillingOrderRecord, payment: PaymentTransactionRecord, options: PaymentRefundOptions, paymentConfig: PaymentRuntimeConfig): Promise<PaymentRefundResult> {
    const secretKey = requiredConfig(paymentConfig, "VOZEB_PRO_STRIPE_SECRET_KEY", "STRIPE_SECRET_KEY");
    const target = resolveStripeRefundTarget(order, payment);
    if (!target) throw new BillingInputError("缺少 Stripe PaymentIntent 或 Charge，不能自动退款", 409);

    const params = new URLSearchParams();
    params.set(target.kind, target.id);
    params.set("amount", String(order.amountCents));
    params.set("metadata[orderId]", order.id);
    params.set("metadata[orderNo]", order.orderNo);
    params.set("metadata[vozebProOrderId]", order.id);
    params.set("metadata[vozebProOrderNo]", order.orderNo);
    const reason = normalizeText(options.reason, "", 200);
    if (reason) params.set("metadata[refundReason]", reason);
    if (options.operatorUserId) params.set("metadata[operatorUserId]", normalizeText(options.operatorUserId, "", 120));

    const response = await fetchSafeOutbound(`${stripeApiBase(paymentConfig)}/v1/refunds`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${secretKey}`,
            "content-type": "application/x-www-form-urlencoded",
            "Idempotency-Key": `vozeb-pro-refund-${order.id}`,
        },
        body: params,
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) throw new BillingInputError(readStripeError(payload, "Stripe 退款失败"), response.status >= 500 ? 502 : 400);
    const status = normalizeStripeRefundStatus(payload.status);
    if (!status) throw new BillingInputError(`Stripe 退款未成功：${normalizeText(payload.status, "unknown", 80)}`, 502);
    return {
        provider: "stripe",
        status,
        providerRefundId: normalizeOptionalText(payload.id, 160),
        rawPayload: sanitizeJson(payload),
    };
}

async function refundAlipayPayment(order: BillingOrderRecord, payment: PaymentTransactionRecord, options: PaymentRefundOptions, paymentConfig: PaymentRuntimeConfig): Promise<PaymentRefundResult> {
    const appId = requiredConfig(paymentConfig, "VOZEB_PRO_ALIPAY_APP_ID");
    const privateKey = loadPrivateKey(paymentConfig, "VOZEB_PRO_ALIPAY_PRIVATE_KEY", "VOZEB_PRO_ALIPAY_PRIVATE_KEY_PATH");
    const gateway = getPaymentRuntimeEnv(paymentConfig, "VOZEB_PRO_ALIPAY_GATEWAY_URL") || "https://openapi.alipay.com/gateway.do";
    const bizContent: Record<string, string> = {
        out_trade_no: order.orderNo,
        refund_amount: centsToDecimal(order.amountCents),
        refund_reason: normalizeText(options.reason, "运营退款", 200),
        out_request_no: providerRefundRequestNo(order),
    };
    const tradeNo = normalizeProviderTradeNo(payment.providerPaymentId || payment.providerTradeId, order);
    if (tradeNo) bizContent.trade_no = tradeNo;
    const params: Record<string, string> = {
        app_id: appId,
        method: "alipay.trade.refund",
        charset: "utf-8",
        sign_type: "RSA2",
        timestamp: alipayTimestamp(),
        version: "1.0",
        biz_content: JSON.stringify(bizContent),
    };
    params.sign = signAlipayParams(params, privateKey);

    const response = await fetchSafeOutbound(gateway, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
        body: new URLSearchParams(params),
    });
    const payload = await readJsonResponse(response);
    if (!response.ok) throw new BillingInputError(readAlipayError(payload, "支付宝退款失败"), response.status >= 500 ? 502 : 400);
    const result = readPath(payload, "alipay_trade_refund_response");
    const resultObject = result && typeof result === "object" && !Array.isArray(result) ? (result as Record<string, unknown>) : {};
    if (normalizeText(resultObject.code, "", 20) !== "10000") throw new BillingInputError(readAlipayError(payload, "支付宝退款失败"), 400);
    return {
        provider: "alipay",
        status: "succeeded",
        providerRefundId: normalizeOptionalText(readPath(resultObject, "out_request_no") || bizContent.out_request_no, 160),
        rawPayload: sanitizeJson(payload),
    };
}

async function refundWechatPayment(order: BillingOrderRecord, payment: PaymentTransactionRecord, options: PaymentRefundOptions, paymentConfig: PaymentRuntimeConfig): Promise<PaymentRefundResult> {
    const mchid = requiredConfig(paymentConfig, "VOZEB_PRO_WECHAT_PAY_MCH_ID");
    const serialNo = requiredConfig(paymentConfig, "VOZEB_PRO_WECHAT_PAY_CERT_SERIAL_NO");
    const privateKey = loadPrivateKey(paymentConfig, "VOZEB_PRO_WECHAT_PAY_PRIVATE_KEY", "VOZEB_PRO_WECHAT_PAY_PRIVATE_KEY_PATH");
    if (order.currency.toUpperCase() !== "CNY") throw new BillingInputError("微信支付退款只支持 CNY 订单", 409);
    const transactionId = normalizeProviderTradeNo(payment.providerPaymentId || payment.providerTradeId, order);
    const payload: Record<string, unknown> = {
        out_refund_no: providerRefundRequestNo(order),
        reason: normalizeText(options.reason, "运营退款", 80),
        amount: {
            refund: order.amountCents,
            total: order.amountCents,
            currency: order.currency.toUpperCase(),
        },
    };
    if (transactionId) payload.transaction_id = transactionId;
    else payload.out_trade_no = order.orderNo;
    const notifyUrl = getPaymentRuntimeEnv(paymentConfig, "VOZEB_PRO_WECHAT_PAY_REFUND_NOTIFY_URL");
    if (notifyUrl) payload.notify_url = notifyUrl;

    const body = JSON.stringify(payload);
    const apiBase = (getPaymentRuntimeEnv(paymentConfig, "VOZEB_PRO_WECHAT_PAY_API_BASE") || "https://api.mch.weixin.qq.com").replace(/\/+$/, "");
    const path = "/v3/refund/domestic/refunds";
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomBytes(16).toString("hex");
    const signature = signWechatRequest("POST", path, timestamp, nonce, body, privateKey);
    const response = await fetchSafeOutbound(`${apiBase}${path}`, {
        method: "POST",
        headers: {
            authorization: `WECHATPAY2-SHA256-RSA2048 mchid="${mchid}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${serialNo}",signature="${signature}"`,
            accept: "application/json",
            "content-type": "application/json",
        },
        body,
    });
    const responseRaw = await response.text();
    const responsePayload = parseJsonObject(responseRaw);
    if (!response.ok) throw new BillingInputError(readWechatError(responsePayload, "微信支付退款失败"), response.status >= 500 ? 502 : 400);
    if (!verifyWechatResponse(responseRaw, response.headers, paymentConfig)) throw new BillingInputError("微信支付退款响应验签失败", 502);
    const status = normalizeWechatRefundStatus(responsePayload.status);
    if (!status) throw new BillingInputError(`微信支付退款未成功：${normalizeText(responsePayload.status, "unknown", 80)}`, 502);
    return {
        provider: "wechat",
        status,
        providerRefundId: normalizeOptionalText(responsePayload.refund_id, 160),
        rawPayload: sanitizeJson(responsePayload),
    };
}

async function refundPayplyPayment(order: BillingOrderRecord, payment: PaymentTransactionRecord, options: PaymentRefundOptions, paymentConfig: PaymentRuntimeConfig): Promise<PaymentRefundResult> {
    const refundUrl = getPaymentRuntimeValue(paymentConfig, "VOZEB_PRO_PAYPLY_REFUND_URL", "PAYPLY_REFUND_URL");
    if (!refundUrl) throw new BillingInputError("该支付渠道未配置自动退款接口，请先配置 PayPly 退款接口后再退款", 400);
    const apiKey = requiredConfig(paymentConfig, "VOZEB_PRO_PAYPLY_API_KEY", "PAYPLY_API_KEY");
    const idempotencyKey = providerRefundRequestNo(order);
    const body = buildPayplyRefundPayload(paymentConfig, order, payment, options);
    const contentType = payplyRefundContentType(paymentConfig);
    const request = buildPayplyRequest(refundUrl, payplyRefundRequestMethod(paymentConfig), contentType, body, payplyHeaders(paymentConfig, apiKey, contentType, idempotencyKey));
    const response = await fetchSafeOutbound(request.url, { ...request.init, signal: AbortSignal.timeout(20_000) });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) throw new BillingInputError(readPayplyError(payload, "PayPly 退款失败"), response.status >= 500 ? 502 : 400);

    const providerStatus = normalizeOptionalText(readConfiguredPath(paymentConfig, payload, "VOZEB_PRO_PAYPLY_REFUND_STATUS_FIELD", ["refundStatus", "refund_status", "status", "data.refundStatus", "data.status", "result.status"]), 80);
    const status = normalizePayplyRefundStatus(providerStatus, paymentConfig);
    if (!status) throw new BillingInputError(`PayPly 退款未成功：${providerStatus || "unknown"}`, 502);
    return {
        provider: "payply",
        status,
        providerRefundId: normalizeOptionalText(readConfiguredPath(paymentConfig, payload, "VOZEB_PRO_PAYPLY_REFUND_ID_FIELD", ["refundId", "refund_id", "id", "data.refundId", "data.refund_id", "data.id", "result.id"]), 160),
        rawPayload: sanitizeJson(payload),
    };
}

async function queryStripeRefund(refundId: string, config: PaymentRuntimeConfig): Promise<PaymentRefundResult> {
    const secretKey = requiredConfig(config, "VOZEB_PRO_STRIPE_SECRET_KEY", "STRIPE_SECRET_KEY");
    const response = await fetchSafeOutbound(`${stripeApiBase(config)}/v1/refunds/${encodeURIComponent(refundId)}`, {
        headers: { authorization: `Bearer ${secretKey}` },
        signal: AbortSignal.timeout(20_000),
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) throw new BillingInputError(readStripeError(payload, "Stripe 退款查询失败"), response.status >= 500 ? 502 : 400);
    const status = normalizeStripeRefundStatus(payload.status);
    if (!status) throw new BillingInputError(`Stripe 退款状态异常：${normalizeText(payload.status, "unknown", 80)}`, 502);
    return { provider: "stripe", status, providerRefundId: normalizeOptionalText(payload.id, 160) || refundId, rawPayload: sanitizeJson(payload) };
}

async function queryWechatRefund(order: BillingOrderRecord, config: PaymentRuntimeConfig): Promise<PaymentRefundResult> {
    const mchid = requiredConfig(config, "VOZEB_PRO_WECHAT_PAY_MCH_ID");
    const serialNo = requiredConfig(config, "VOZEB_PRO_WECHAT_PAY_CERT_SERIAL_NO");
    const privateKey = loadPrivateKey(config, "VOZEB_PRO_WECHAT_PAY_PRIVATE_KEY", "VOZEB_PRO_WECHAT_PAY_PRIVATE_KEY_PATH");
    const apiBase = (getPaymentRuntimeEnv(config, "VOZEB_PRO_WECHAT_PAY_API_BASE") || "https://api.mch.weixin.qq.com").replace(/\/+$/, "");
    const path = `/v3/refund/domestic/refunds/${encodeURIComponent(providerRefundRequestNo(order))}`;
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomBytes(16).toString("hex");
    const signature = signWechatRequest("GET", path, timestamp, nonce, "", privateKey);
    const response = await fetchSafeOutbound(`${apiBase}${path}`, {
        headers: { authorization: `WECHATPAY2-SHA256-RSA2048 mchid="${mchid}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${serialNo}",signature="${signature}"`, accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
    });
    const raw = await response.text();
    const payload = parseJsonObject(raw);
    if (!response.ok) throw new BillingInputError(readWechatError(payload, "微信支付退款查询失败"), response.status >= 500 ? 502 : 400);
    if (!verifyWechatResponse(raw, response.headers, config)) throw new BillingInputError("微信支付退款查询响应验签失败", 502);
    const status = normalizeWechatRefundStatus(payload.status);
    if (!status) throw new BillingInputError(`微信支付退款状态异常：${normalizeText(payload.status, "unknown", 80)}`, 502);
    return { provider: "wechat", status, providerRefundId: normalizeOptionalText(payload.refund_id, 160), rawPayload: sanitizeJson(payload) };
}

async function queryPayplyRefund(order: BillingOrderRecord, payment: PaymentTransactionRecord, current: PaymentRefundResult, config: PaymentRuntimeConfig): Promise<PaymentRefundResult | null> {
    const template = getPaymentRuntimeValue(config, "VOZEB_PRO_PAYPLY_REFUND_QUERY_URL", "PAYPLY_REFUND_QUERY_URL");
    if (!template) return null;
    const apiKey = requiredConfig(config, "VOZEB_PRO_PAYPLY_API_KEY", "PAYPLY_API_KEY");
    const url = renderTemplate(template, {
        orderId: order.id,
        orderNo: order.orderNo,
        providerOrderId: order.providerOrderId || payment.providerTradeId || "",
        providerTradeId: payment.providerTradeId || "",
        providerPaymentId: payment.providerPaymentId || "",
        providerRefundId: current.providerRefundId || "",
        refundRequestNo: providerRefundRequestNo(order),
    });
    const customHeader = getPaymentRuntimeEnv(config, "VOZEB_PRO_PAYPLY_API_KEY_HEADER");
    const headers = customHeader ? { [customHeader]: apiKey } : { authorization: `Bearer ${apiKey}`, "x-api-key": apiKey };
    const response = await fetchSafeOutbound(url, { headers, signal: AbortSignal.timeout(20_000) });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) throw new BillingInputError(readPayplyError(payload, "PayPly 退款查询失败"), response.status >= 500 ? 502 : 400);
    const providerStatus = normalizeOptionalText(readConfiguredPath(config, payload, "VOZEB_PRO_PAYPLY_REFUND_QUERY_STATUS_FIELD", ["refundStatus", "refund_status", "status", "data.status"]), 80);
    const status = normalizePayplyRefundStatus(providerStatus, config);
    if (!status) throw new BillingInputError(`PayPly 退款状态异常：${providerStatus || "unknown"}`, 502);
    return {
        provider: "payply",
        status,
        providerRefundId: normalizeOptionalText(readConfiguredPath(config, payload, "VOZEB_PRO_PAYPLY_REFUND_QUERY_ID_FIELD", ["refundId", "refund_id", "id", "data.refundId", "data.id"]), 160) || current.providerRefundId,
        rawPayload: sanitizeJson(payload),
    };
}

function resolveStripeRefundTarget(order: BillingOrderRecord, payment: PaymentTransactionRecord) {
    const ids = [payment.providerPaymentId, order.providerPaymentId, payment.providerTradeId, order.providerOrderId].map((value) => normalizeText(value, "", 160)).filter(Boolean);
    const paymentIntent = ids.find((id) => id.startsWith("pi_"));
    if (paymentIntent) return { kind: "payment_intent" as const, id: paymentIntent };
    const charge = ids.find((id) => id.startsWith("ch_"));
    if (charge) return { kind: "charge" as const, id: charge };
    return undefined;
}

function normalizeProviderTradeNo(value: unknown, order: BillingOrderRecord) {
    const id = normalizeText(value, "", 160);
    if (!id || id === order.orderNo || id.includes(":")) return undefined;
    return id;
}

function providerRefundRequestNo(order: BillingOrderRecord) {
    const id = normalizeText(order.id || order.orderNo, "", 80).replace(/[^a-zA-Z0-9_-]/g, "");
    return `vozeb-pro-refund-${id || order.orderNo}`.slice(0, 64);
}

function buildPayplyRefundPayload(paymentConfig: PaymentRuntimeConfig, order: BillingOrderRecord, payment: PaymentTransactionRecord, options: PaymentRefundOptions) {
    const refundRequestNo = providerRefundRequestNo(order);
    const defaultPayload: Record<string, unknown> = {
        merchantId: getPaymentRuntimeEnv(paymentConfig, "VOZEB_PRO_PAYPLY_MERCHANT_ID") || undefined,
        orderId: order.id,
        orderNo: order.orderNo,
        providerOrderId: order.providerOrderId || payment.providerTradeId || order.orderNo,
        providerTradeId: payment.providerTradeId || order.providerOrderId || "",
        providerPaymentId: payment.providerPaymentId || order.providerPaymentId || "",
        amountCents: order.amountCents,
        amount: centsToDecimal(order.amountCents),
        currency: order.currency,
        reason: normalizeText(options.reason, "运营退款", 200),
        operatorUserId: normalizeText(options.operatorUserId, "", 120),
        refundRequestNo,
        idempotencyKey: refundRequestNo,
        metadata: {
            vozebProOrderId: order.id,
            vozebProOrderNo: order.orderNo,
            userId: order.userId || "",
        },
    };
    const template = getPaymentRuntimeValue(paymentConfig, "VOZEB_PRO_PAYPLY_REFUND_REQUEST_TEMPLATE", "PAYPLY_REFUND_REQUEST_TEMPLATE");
    if (!template) return defaultPayload;
    const rendered = renderTemplate(template, {
        orderId: order.id,
        orderNo: order.orderNo,
        providerOrderId: normalizeText(defaultPayload.providerOrderId, "", 160),
        providerTradeId: normalizeText(defaultPayload.providerTradeId, "", 160),
        providerPaymentId: normalizeText(defaultPayload.providerPaymentId, "", 160),
        amountCents: String(order.amountCents),
        amount: centsToDecimal(order.amountCents),
        currency: order.currency,
        reason: normalizeText(options.reason, "运营退款", 200),
        operatorUserId: normalizeText(options.operatorUserId, "", 120),
        userId: order.userId || "",
        merchantId: normalizeText(defaultPayload.merchantId, "", 160),
        refundRequestNo,
        idempotencyKey: refundRequestNo,
    });
    try {
        const payload = JSON.parse(rendered) as unknown;
        if (payload && typeof payload === "object" && !Array.isArray(payload)) return payload as Record<string, unknown>;
    } catch {
        throw new BillingInputError("PayPly 退款请求体模板必须是有效 JSON 对象", 400);
    }
    throw new BillingInputError("PayPly 退款请求体模板必须是有效 JSON 对象", 400);
}

function buildPayplyRequest(refundUrl: string, method: "GET" | "POST", contentType: string, body: Record<string, unknown>, headers: Record<string, string>) {
    if (method === "GET") {
        const url = new URL(refundUrl);
        for (const [key, value] of Object.entries(body)) {
            if (value === undefined || value === null || typeof value === "object") continue;
            url.searchParams.set(key, String(value));
        }
        return { url: url.toString(), init: { method, headers } };
    }
    return {
        url: refundUrl,
        init: {
            method,
            headers,
            body: contentType === "application/x-www-form-urlencoded" ? new URLSearchParams(flattenBody(body)).toString() : JSON.stringify(body),
        },
    };
}

function payplyHeaders(config: PaymentRuntimeConfig, apiKey: string, contentType: string, idempotencyKey: string) {
    const customHeader = getPaymentRuntimeEnv(config, "VOZEB_PRO_PAYPLY_API_KEY_HEADER");
    const headers: Record<string, string> = { "content-type": contentType, "idempotency-key": idempotencyKey };
    if (customHeader) {
        headers[customHeader] = apiKey;
    } else {
        headers.authorization = `Bearer ${apiKey}`;
        headers["x-api-key"] = apiKey;
    }
    return { ...headers, ...parseExtraHeaders(config, "VOZEB_PRO_PAYPLY_EXTRA_HEADERS", "PAYPLY_EXTRA_HEADERS"), ...parseExtraHeaders(config, "VOZEB_PRO_PAYPLY_REFUND_EXTRA_HEADERS", "PAYPLY_REFUND_EXTRA_HEADERS") };
}

function parseExtraHeaders(config: PaymentRuntimeConfig, ...names: string[]): Record<string, string> {
    const text = getPaymentRuntimeValue(config, ...names);
    if (!text) return {};
    try {
        const value = JSON.parse(text) as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)) return {};
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .map(([key, item]) => [key.trim(), normalizeText(item, "", 1000)] as const)
                .filter(([key, item]) => Boolean(key && item)),
        );
    } catch {
        return {};
    }
}

function flattenBody(body: Record<string, unknown>) {
    return Object.fromEntries(
        Object.entries(body)
            .filter(([, value]) => value !== undefined && value !== null && typeof value !== "object")
            .map(([key, value]) => [key, String(value)]),
    );
}

function normalizeStripeRefundStatus(value: unknown): Exclude<PaymentRefundStatus, "manual"> | undefined {
    const status = normalizeText(value, "", 80).toLowerCase();
    if (status === "succeeded") return "succeeded";
    if (status === "pending" || status === "requires_action") return "pending";
    return undefined;
}

function normalizePayplyRefundStatus(value: string | undefined, paymentConfig: PaymentRuntimeConfig): Exclude<PaymentRefundStatus, "manual"> | undefined {
    const status = normalizeText(value, "", 80).toLowerCase();
    if (!status) return "succeeded";
    if (status === "pending" || status === "processing") return "pending";
    const configured = getPaymentRuntimeEnv(paymentConfig, "VOZEB_PRO_PAYPLY_REFUND_SUCCESS_STATUSES");
    const successStatuses = (configured || "refunded,refund,success,succeeded,completed,ok")
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
    return successStatuses.includes(status) ? "succeeded" : undefined;
}

function readConfiguredPath(config: PaymentRuntimeConfig, payload: unknown, envName: string, defaultPaths: string[]) {
    const paths = [getPaymentRuntimeEnv(config, envName), ...defaultPaths].filter(Boolean);
    for (const path of paths) {
        const value = readPath(payload, path);
        if (value !== undefined && value !== null && value !== "") return value;
    }
    return undefined;
}

function readPath(source: unknown, path: string): unknown {
    return path.split(".").reduce<unknown>((current, key) => {
        if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
        return (current as Record<string, unknown>)[key];
    }, source);
}

function requiredConfig(config: PaymentRuntimeConfig, ...names: string[]) {
    const value = getPaymentRuntimeValue(config, ...names);
    if (!value) throw new BillingInputError(`缺少支付配置：${names[0]}`, 500);
    return value;
}

function loadPrivateKey(config: PaymentRuntimeConfig, valueEnv: string, pathEnv: string) {
    const value = getPaymentRuntimeEnv(config, valueEnv);
    if (value) return normalizePrivateKey(value);
    const path = getPaymentRuntimeEnv(config, pathEnv);
    if (path) return normalizePrivateKey(readFileSync(path, "utf8"));
    throw new BillingInputError(`缺少支付私钥配置：${valueEnv}`, 500);
}

function normalizePrivateKey(value: string) {
    const text = value.replace(/\\n/g, "\n").trim();
    if (text.includes("-----BEGIN")) return text;
    return `-----BEGIN PRIVATE KEY-----\n${text.match(/.{1,64}/g)?.join("\n") || text}\n-----END PRIVATE KEY-----`;
}

function signAlipayParams(params: Record<string, string>, privateKey: string) {
    const content = Object.keys(params)
        .filter((key) => key !== "sign" && params[key] !== "")
        .sort()
        .map((key) => `${key}=${params[key]}`)
        .join("&");
    return createSign("RSA-SHA256").update(content, "utf8").sign(privateKey, "base64");
}

function signWechatRequest(method: string, path: string, timestamp: string, nonce: string, body: string, privateKey: string) {
    const message = `${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`;
    return createSign("RSA-SHA256").update(message, "utf8").sign(privateKey, "base64");
}

function verifyWechatResponse(rawBody: string, headers: Headers, config: PaymentRuntimeConfig) {
    const timestamp = headers.get("wechatpay-timestamp") || "";
    const nonce = headers.get("wechatpay-nonce") || "";
    const signature = headers.get("wechatpay-signature") || "";
    if (!timestamp || !nonce || !signature) return false;
    const publicKey = loadPaymentPublicKey(config, "VOZEB_PRO_WECHAT_PAY_PLATFORM_PUBLIC_KEY", "VOZEB_PRO_WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH");
    return verifyRsaSha256(`${timestamp}\n${nonce}\n${rawBody}\n`, signature, publicKey);
}

function parseJsonObject(value: string) {
    try {
        const parsed = JSON.parse(value) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

async function readJsonResponse(response: Response) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    const declaredCharset = response.headers.get("content-type")?.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1];
    const encodings = Array.from(new Set([normalizeCharset(declaredCharset), "utf-8", "gb18030"].filter(Boolean))) as string[];
    for (const encoding of encodings) {
        try {
            const payload = parseJsonObject(new TextDecoder(encoding, { fatal: true }).decode(bytes));
            if (Object.keys(payload).length) return payload;
        } catch {
            continue;
        }
    }
    return {};
}

function normalizeCharset(value?: string) {
    const charset = value?.trim().toLowerCase();
    if (!charset) return "";
    if (["utf8", "utf-8"].includes(charset)) return "utf-8";
    if (["gbk", "gb2312", "gb18030"].includes(charset)) return "gb18030";
    return charset;
}

function stripeApiBase(config: PaymentRuntimeConfig) {
    return (getPaymentRuntimeEnv(config, "VOZEB_PRO_STRIPE_API_BASE") || "https://api.stripe.com").replace(/\/+$/, "");
}

function payplyRefundRequestMethod(config: PaymentRuntimeConfig) {
    const method = getPaymentRuntimeValue(config, "VOZEB_PRO_PAYPLY_REFUND_REQUEST_METHOD", "PAYPLY_REFUND_REQUEST_METHOD").toUpperCase();
    return method === "GET" ? "GET" : "POST";
}

function payplyRefundContentType(config: PaymentRuntimeConfig) {
    const contentType = getPaymentRuntimeValue(config, "VOZEB_PRO_PAYPLY_REFUND_CONTENT_TYPE", "PAYPLY_REFUND_CONTENT_TYPE", "VOZEB_PRO_PAYPLY_CONTENT_TYPE", "PAYPLY_CONTENT_TYPE") || "application/json";
    return contentType === "application/x-www-form-urlencoded" ? contentType : "application/json";
}

function readStripeError(payload: Record<string, unknown>, fallback: string) {
    const error = payload.error && typeof payload.error === "object" ? (payload.error as Record<string, unknown>) : {};
    return normalizeText(error.message, fallback, 300);
}

function readAlipayError(payload: Record<string, unknown>, fallback: string) {
    const result = readPath(payload, "alipay_trade_refund_response");
    const resultObject = result && typeof result === "object" && !Array.isArray(result) ? (result as Record<string, unknown>) : {};
    return normalizeText(resultObject.sub_msg || resultObject.msg || resultObject.code || payload.message, fallback, 300);
}

function readWechatError(payload: Record<string, unknown>, fallback: string) {
    return normalizeText(payload.message || payload.code, fallback, 300);
}

function readPayplyError(payload: Record<string, unknown>, fallback: string) {
    return normalizeText(readPath(payload, "message") || readPath(payload, "error.message") || readPath(payload, "error") || readPath(payload, "data.message"), fallback, 300);
}

function renderTemplate(template: string, values: Record<string, string>) {
    return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key: string) => values[key] ?? "");
}

function normalizeProvider(value: unknown) {
    const provider = normalizePaymentProvider(value);
    if (provider === "custom") return "manual";
    return provider;
}

function normalizeWechatRefundStatus(value: unknown): Exclude<PaymentRefundStatus, "manual"> | undefined {
    const status = normalizeText(value, "", 80).toUpperCase();
    if (status === "SUCCESS") return "succeeded";
    if (status === "PROCESSING") return "pending";
    return undefined;
}

function normalizeText(value: unknown, fallback: string, maxLength: number) {
    const text = typeof value === "string" ? value.trim() : value === null || value === undefined ? "" : String(value).trim();
    return (text || fallback).slice(0, maxLength);
}

function normalizeOptionalText(value: unknown, maxLength: number) {
    const text = normalizeText(value, "", maxLength);
    return text || undefined;
}

function centsToDecimal(cents: number) {
    return (cents / 100).toFixed(2);
}

function alipayTimestamp(date = new Date()) {
    const formatter = new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    });
    const parts = formatter.formatToParts(date);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

function sanitizeJson(value: unknown, depth = 0): JsonValue {
    if (depth > 4) return "[truncated]";
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) return value.slice(0, 80).map((item) => sanitizeJson(item, depth + 1));
    if (!value || typeof value !== "object") return {};
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .slice(0, 120)
            .map(([key, item]) => [normalizeText(key, "", 100), sanitizeJson(item, depth + 1)] as const)
            .filter(([key]) => Boolean(key)),
    ) as { [key: string]: JsonValue };
}
