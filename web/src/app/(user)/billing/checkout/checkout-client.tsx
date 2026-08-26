"use client";

import { App, Button, Empty, Popover, QRCode, Spin, Tag } from "antd";
import { ArrowLeft, Check, CheckCircle2, ChevronDown, Copy, CreditCard, ExternalLink, FileText, Landmark, LockKeyhole, Minus, Plus, QrCode, ReceiptText, RefreshCw, ShieldCheck, TicketPercent, WalletCards } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { CreditSymbol, formatCreditAmount } from "@/constant/credits";
import { useCopyText } from "@/hooks/use-copy-text";
import { createBillingOrder, createPaymentCheckout, listBillingCoupons, listBillingProducts, quoteBillingOrder, type BillingProduct, type BillingQuote, type PaymentCheckout, type UserCoupon } from "@/services/api/billing";
import { openPaymentCheckoutWindow } from "./payment-checkout-window";

const providers = [
    { label: "Stripe", value: "stripe", icon: CreditCard, description: "国际银行卡与数字钱包" },
    { label: "支付宝", value: "alipay", icon: Landmark, description: "支付宝安全支付" },
    { label: "微信支付", value: "wechat", icon: QrCode, description: "微信扫码支付" },
    { label: "PayPly", value: "payply", icon: WalletCards, description: "自定义支付接口" },
    { label: "客服确认", value: "manual", icon: FileText, description: "提交订单后由客服核实开通" },
] as const;

export function BillingCheckoutPage({ productId, supportEmail }: { productId: string; supportEmail?: string }) {
    const { message } = App.useApp();
    const router = useRouter();
    const copyText = useCopyText();
    const [product, setProduct] = useState<BillingProduct | null>(null);
    const [paymentProviders, setPaymentProviders] = useState<string[]>([]);
    const [provider, setProvider] = useState("");
    const [quantity, setQuantity] = useState(1);
    const [coupons, setCoupons] = useState<UserCoupon[]>([]);
    const [selectedCouponId, setSelectedCouponId] = useState("");
    const [couponOpen, setCouponOpen] = useState(false);
    const [couponsLoading, setCouponsLoading] = useState(false);
    const [quote, setQuote] = useState<BillingQuote | null>(null);
    const [quoteLoading, setQuoteLoading] = useState(false);
    const [quoteError, setQuoteError] = useState("");
    const [mobileSection, setMobileSection] = useState<"summary" | "payment">("payment");
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [checkout, setCheckout] = useState<PaymentCheckout | null>(null);
    const quoteRequest = useRef(0);
    const availableProviders = useMemo(() => providers.filter((item) => paymentProviders.includes(item.value)), [paymentProviders]);
    const hasAutomaticPayment = availableProviders.some((item) => item.value !== "manual");
    const selectedCoupon = useMemo(() => coupons.find((coupon) => coupon.id === selectedCouponId), [coupons, selectedCouponId]);

    const loadCoupons = useCallback(async () => {
        setCouponsLoading(true);
        try {
            const payload = await listBillingCoupons({ productId, quantity, pageSize: 50, includeTemplates: false });
            setCoupons(payload.coupons || []);
            setSelectedCouponId((current) => (current && payload.coupons.some((coupon) => coupon.id === current && coupon.applicable) ? current : ""));
            return payload.coupons || [];
        } catch (error) {
            message.error(error instanceof Error ? error.message : "优惠券加载失败");
            return [];
        } finally {
            setCouponsLoading(false);
        }
    }, [message, productId, quantity]);

    useEffect(() => {
        let active = true;
        void listBillingProducts()
            .then((payload) => {
                if (!active) return;
                const nextProduct = payload.products.find((item) => item.id === productId) || null;
                const nextProviders = payload.paymentProviders?.length ? payload.paymentProviders : ["manual"];
                setProduct(nextProduct);
                setPaymentProviders(nextProviders);
                setProvider(nextProviders[0] || "manual");
            })
            .catch((error) => message.error(error instanceof Error ? error.message : "支付信息加载失败"))
            .finally(() => {
                if (active) setLoading(false);
            });
        return () => {
            active = false;
        };
    }, [message, productId]);

    useEffect(() => {
        void loadCoupons();
    }, [loadCoupons]);

    useEffect(() => {
        if (!product) return;
        const requestId = ++quoteRequest.current;
        setQuoteLoading(true);
        setQuoteError("");
        void quoteBillingOrder({ productId: product.id, quantity, userCouponId: selectedCouponId || undefined })
            .then((payload) => {
                if (quoteRequest.current === requestId) setQuote(payload.quote);
            })
            .catch((error) => {
                if (quoteRequest.current !== requestId) return;
                setQuote(null);
                setQuoteError(error instanceof Error ? error.message : "结算价格加载失败");
            })
            .finally(() => {
                if (quoteRequest.current === requestId) setQuoteLoading(false);
            });
    }, [product, quantity, selectedCouponId]);

    const fallbackUnitAmountCents = product?.pricing?.saleUnitAmountCents ?? product?.amountCents ?? 0;
    const pricing = quote || {
        productId: product?.id || "",
        quantity,
        listAmountCents: (product?.pricing?.listUnitAmountCents ?? product?.amountCents ?? 0) * quantity,
        promotionDiscountCents: (product?.pricing?.discountCents ?? 0) * quantity,
        couponDiscountCents: 0,
        payableAmountCents: fallbackUnitAmountCents * quantity,
        promotion: product?.pricing?.promotion,
        pricingSnapshot: null,
    };

    const submit = async () => {
        if (!product || !provider) return;
        setSubmitting(true);
        try {
            const order = await createBillingOrder({ productId: product.id, provider, quantity, userCouponId: selectedCouponId || undefined });
            const result = await createPaymentCheckout(order.order.id, { provider });
            setCheckout(result.checkout);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "创建支付订单失败");
            await loadCoupons();
        } finally {
            setSubmitting(false);
        }
    };

    const openCheckout = () => {
        if (!checkout) return;
        const result = openPaymentCheckoutWindow(checkout);
        if (result.status === "opened") return;
        if (result.status === "manual") {
            message.info("该订单需要客服人工确认");
            return;
        }
        if (result.fallbackValue) copyText(result.fallbackValue, result.status === "blocked" ? "支付信息已复制，请粘贴到浏览器打开" : "支付信息已复制");
        message.warning(result.status === "blocked" ? "浏览器阻止了支付窗口，已复制支付信息。" : "支付地址无效或无法打开，请复制支付信息后手动打开。");
    };

    if (loading) {
        return (
            <main className="h-full min-h-0 overflow-y-auto bg-[#f4f5f2] px-3 py-4 sm:px-4 sm:py-8 dark:bg-[#0f1012]">
                <div className="mx-auto grid min-h-24 max-w-6xl place-items-center sm:min-h-[60dvh]">
                    <Spin />
                </div>
            </main>
        );
    }

    if (!product) {
        return (
            <main className="h-full min-h-0 overflow-y-auto bg-[#f4f5f2] px-3 py-4 sm:px-4 sm:py-8 dark:bg-[#0f1012]">
                <div className="mx-auto max-w-xl rounded-xl border border-stone-200 bg-white p-4 text-center sm:rounded-3xl sm:p-8 dark:border-stone-800 dark:bg-stone-950">
                    <Empty description="套餐不存在或已下架" />
                    <Link href="/profile?section=billing" className="mt-5 inline-flex text-sm font-semibold text-stone-700 hover:text-stone-950 dark:text-stone-300 dark:hover:text-white">
                        返回套餐中心
                    </Link>
                </div>
            </main>
        );
    }

    return (
        <main className="h-full min-h-0 overflow-y-auto bg-[#f4f5f2] px-2 py-2 text-stone-950 sm:px-6 sm:py-8 dark:bg-[#0f1012] dark:text-stone-100">
            <div className="mx-auto w-full max-w-6xl pb-[calc(1rem+env(safe-area-inset-bottom))] sm:pb-[calc(2rem+env(safe-area-inset-bottom))]">
                <header className="mb-2.5 flex items-center justify-between gap-2 sm:mb-5 sm:gap-4">
                    <Link
                        href="/profile?section=billing"
                        className="inline-flex h-9 items-center gap-2 rounded-xl border border-stone-200 bg-white px-3 text-sm font-semibold text-stone-700 shadow-sm transition hover:border-stone-300 hover:bg-stone-50 hover:text-stone-950 dark:border-stone-800 dark:bg-stone-950 dark:text-stone-300 dark:hover:border-stone-700 dark:hover:bg-stone-900 dark:hover:text-white"
                    >
                        <ArrowLeft className="size-4" /> 返回套餐中心
                    </Link>
                    <span className="inline-flex size-9 items-center justify-center rounded-xl border border-stone-200 bg-white text-stone-600 sm:h-auto sm:w-auto sm:gap-1.5 sm:rounded-full sm:px-3 sm:py-1.5 sm:text-xs sm:font-medium dark:border-stone-800 dark:bg-stone-950 dark:text-stone-300">
                        <ShieldCheck className="size-4 text-emerald-600 sm:size-3.5 dark:text-emerald-300" /> <span className="hidden sm:inline">星启智域订单结算</span>
                    </span>
                </header>

                <div className="overflow-hidden rounded-xl border border-stone-200 bg-white shadow-[0_18px_54px_rgba(15,23,42,0.10)] sm:rounded-[1.75rem] sm:shadow-[0_30px_90px_rgba(15,23,42,0.12)] lg:grid lg:grid-cols-[0.86fr_1.14fr] dark:border-stone-800 dark:bg-stone-950 dark:shadow-black/35">
                    <div className="m-1.5 grid grid-cols-2 gap-1 rounded-lg bg-stone-100 p-0.5 sm:hidden dark:bg-stone-900" role="tablist" aria-label="结算步骤">
                        <button
                            type="button"
                            role="tab"
                            aria-selected={mobileSection === "summary"}
                            className={`inline-flex h-8 items-center justify-center gap-1 rounded-md text-xs font-semibold transition ${mobileSection === "summary" ? "bg-white text-[#344256] shadow-sm dark:bg-[#252d37] dark:text-white" : "text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200"}`}
                            onClick={() => setMobileSection("summary")}
                        >
                            <ReceiptText className={`size-4 ${mobileSection === "summary" ? "text-[#66758e] dark:text-[#d8dee8]" : ""}`} /> 订单明细
                        </button>
                        <button
                            type="button"
                            role="tab"
                            aria-selected={mobileSection === "payment"}
                            className={`inline-flex h-8 items-center justify-center gap-1 rounded-md text-xs font-semibold transition ${mobileSection === "payment" ? "bg-white text-[#344256] shadow-sm dark:bg-[#252d37] dark:text-white" : "text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200"}`}
                            onClick={() => setMobileSection("payment")}
                        >
                            <CreditCard className={`size-4 ${mobileSection === "payment" ? "text-[#66758e] dark:text-[#d8dee8]" : ""}`} /> 支付方式
                        </button>
                    </div>

                    <section className={`${mobileSection === "summary" ? "block" : "hidden"} relative overflow-hidden bg-stone-950 p-2.5 text-white sm:block sm:p-8 lg:min-h-[34rem] dark:bg-stone-100 dark:text-stone-950`}>
                        <div className="pointer-events-none absolute -left-24 -top-24 size-72 rounded-full bg-[#66758e]/30 blur-3xl dark:bg-[#66758e]/20" />
                        <div className="relative">
                            <div className="text-[11px] font-semibold tracking-[0.2em] text-[#b8c4d6] dark:text-[#66758e]">星启智域 · 安全结算</div>
                            <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:mt-5 sm:text-3xl">{product.name}</h1>
                            <p className="mt-3 max-w-md text-sm leading-6 text-stone-300 dark:text-stone-600">{product.description}</p>

                            <div className="mt-4 flex items-end gap-1 sm:mt-8">
                                <span className="pb-1 text-sm">¥</span>
                                <span className="text-3xl font-semibold sm:text-5xl">{formatYuan(pricing.payableAmountCents)}</span>
                                <span className="pb-1 text-sm text-stone-400 dark:text-stone-500">今日需支付</span>
                            </div>

                            <div className="mt-3 overflow-hidden rounded-lg border border-white/10 bg-white/[0.06] sm:mt-8 sm:rounded-2xl dark:border-stone-300 dark:bg-white">
                                <SummaryRow label="日常价" value={`¥ ${formatYuan(pricing.listAmountCents)}`} />
                                <SummaryRow label="购买数量" value={`× ${quantity}`} />
                                {pricing.promotionDiscountCents > 0 ? <SummaryRow label={pricing.promotion?.label || "活动优惠"} value={`- ¥ ${formatYuan(pricing.promotionDiscountCents)}`} /> : null}
                                {pricing.couponDiscountCents > 0 ? <SummaryRow label="优惠券" value={`- ¥ ${formatYuan(pricing.couponDiscountCents)}`} /> : null}
                                <SummaryRow label="应付金额" value={`¥ ${formatYuan(pricing.payableAmountCents)}`} />
                                <SummaryRow label="充值人民币余额" value={`¥${formatCreditAmount(product.pointsAmount * quantity)}`} icon={<CreditSymbol />} />
                                <SummaryRow label="权益周期" value={product.productKind === "points" ? "一次性到账" : product.periodDays ? `${product.periodDays * quantity} 天` : "长期有效"} />
                            </div>

                            <div className="mt-6 flex items-start gap-2 text-xs leading-5 text-stone-400 dark:text-stone-600">
                                <ReceiptText className="mt-0.5 size-4 shrink-0 text-[#b8c4d6] dark:text-[#66758e]" />
                                订单创建后可在个人中心查看状态；支付成功后套餐与人民币余额自动更新。
                            </div>
                        </div>
                    </section>

                    <section className={`${mobileSection === "payment" ? "block" : "hidden"} p-2.5 sm:block sm:p-8`}>
                        <div className="mb-4 flex items-end justify-between gap-3 border-b border-stone-200 pb-3 sm:hidden dark:border-stone-800">
                            <div className="min-w-0">
                                <div className="text-[10px] font-semibold tracking-[0.16em] text-stone-400 dark:text-stone-500">当前订单</div>
                                <div className="mt-1 truncate text-sm font-semibold text-stone-950 dark:text-white">{product.name}</div>
                            </div>
                            <div className="shrink-0 text-right">
                                <div className="text-[11px] text-stone-500 dark:text-stone-400">应付金额</div>
                                <div className="mt-0.5 text-xl font-semibold tabular-nums text-stone-950 dark:text-white">¥ {formatYuan(pricing.payableAmountCents)}</div>
                            </div>
                        </div>
                        {!checkout ? (
                            <>
                                <div>
                                    <div className="text-[11px] font-semibold tracking-[0.18em] text-stone-400 dark:text-stone-500">PAYMENT</div>
                                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                                        <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">选择支付方式</h2>
                                        <Tag color="green" className="m-0">
                                            <span className="inline-flex items-center gap-1">
                                                <LockKeyhole className="size-3" /> {hasAutomaticPayment ? "支付信息加密" : "客服确认"}
                                            </span>
                                        </Tag>
                                    </div>
                                </div>

                                <div className="mt-3 space-y-1.5 sm:mt-6 sm:space-y-3">
                                    {availableProviders.map((item) => {
                                        const Icon = item.icon;
                                        const selected = provider === item.value;
                                        return (
                                            <button
                                                key={item.value}
                                                type="button"
                                                aria-pressed={selected}
                                                className={`flex w-full items-center gap-2.5 rounded-lg border p-2.5 text-left transition sm:rounded-2xl sm:p-4 ${selected ? "border-stone-950 bg-stone-50 ring-1 ring-stone-950 dark:border-stone-200 dark:bg-stone-900 dark:ring-stone-200" : "border-stone-200 bg-white hover:border-stone-400 hover:bg-stone-50 dark:border-stone-800 dark:bg-stone-950 dark:hover:border-stone-600 dark:hover:bg-stone-900/70"}`}
                                                onClick={() => setProvider(item.value)}
                                            >
                                                <span
                                                    className={`grid size-9 shrink-0 place-items-center rounded-lg sm:size-11 sm:rounded-xl ${selected ? "bg-stone-950 text-white dark:bg-white dark:text-stone-950" : "bg-stone-100 text-stone-600 dark:bg-stone-900 dark:text-stone-300"}`}
                                                >
                                                    <Icon className="size-5" />
                                                </span>
                                                <span className="min-w-0 flex-1">
                                                    <span className="block text-sm font-semibold text-stone-950 dark:text-white">{item.label}</span>
                                                    <span className="mt-1 block text-xs text-stone-500 dark:text-stone-400">{item.description}</span>
                                                </span>
                                                <span
                                                    className={`grid size-6 shrink-0 place-items-center rounded-full border transition ${selected ? "border-emerald-600 bg-emerald-600 text-white shadow-sm shadow-emerald-600/20 dark:border-emerald-500 dark:bg-emerald-500" : "border-stone-300 bg-white text-transparent dark:border-stone-700 dark:bg-stone-950"}`}
                                                    aria-hidden="true"
                                                >
                                                    <Check className="size-3.5" strokeWidth={2.5} />
                                                </span>
                                            </button>
                                        );
                                    })}
                                </div>

                                <div className="mt-4 border-t border-stone-200 pt-4 sm:mt-7 sm:pt-7 dark:border-stone-800">
                                    <div className="mb-3 border-b border-stone-200 pb-3 dark:border-stone-800 sm:mb-4 sm:pb-4">
                                        <div className="flex min-w-0 items-center justify-between gap-3">
                                            <span className="inline-flex min-w-0 items-center gap-2 text-sm font-semibold">
                                                <TicketPercent className="size-4 shrink-0 text-rose-600 dark:text-rose-300" />
                                                优惠券
                                                {!couponsLoading ? <span className="text-xs font-normal text-stone-500 dark:text-stone-400">{coupons.filter(isCouponAvailable).length} 张可用</span> : null}
                                            </span>
                                            <Popover
                                                trigger="click"
                                                placement="bottomRight"
                                                open={couponOpen}
                                                onOpenChange={setCouponOpen}
                                                styles={{ container: { padding: 8 } }}
                                                content={
                                                    <CouponPickerMenu
                                                        coupons={coupons}
                                                        selectedCouponId={selectedCouponId}
                                                        loading={couponsLoading}
                                                        onRefresh={() => void loadCoupons()}
                                                        onSelect={(value) => {
                                                            setSelectedCouponId(value);
                                                            setCouponOpen(false);
                                                        }}
                                                    />
                                                }
                                            >
                                                <button
                                                    type="button"
                                                    className="flex h-8 min-w-0 max-w-[65%] items-center gap-1.5 rounded-md border border-stone-200 bg-white px-2.5 text-left text-xs font-medium transition hover:border-stone-400 hover:bg-stone-50 dark:border-stone-700 dark:bg-stone-950 dark:hover:border-stone-500 dark:hover:bg-stone-900"
                                                    aria-label="选择优惠券"
                                                    aria-expanded={couponOpen}
                                                >
                                                    <span className="truncate">{selectedCoupon ? `${selectedCoupon.template?.name || "优惠券"} · ${couponDiscountLabel(selectedCoupon)}` : couponsLoading ? "读取中" : "选择"}</span>
                                                    <ChevronDown className={`size-3.5 shrink-0 text-stone-400 transition ${couponOpen ? "rotate-180" : ""}`} />
                                                </button>
                                            </Popover>
                                        </div>
                                        {quoteLoading ? (
                                            <p className="mt-1.5 text-right text-xs text-stone-500 dark:text-stone-400">正在核算最新应付金额...</p>
                                        ) : quoteError ? (
                                            <p className="mt-1.5 text-right text-xs text-rose-600 dark:text-rose-300">{quoteError}，请刷新后重试。</p>
                                        ) : null}
                                    </div>
                                    <label className="flex items-center justify-between gap-5">
                                        <span className="min-w-0">
                                            <span className="block text-sm font-semibold">购买数量</span>
                                            <span className="mt-1 block text-xs text-stone-500 dark:text-stone-400">人民币余额和权益按数量累计</span>
                                        </span>
                                        <div className="grid h-9 shrink-0 grid-cols-[2rem_2.5rem_2rem] overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm dark:border-stone-800 dark:bg-stone-950">
                                            <button
                                                type="button"
                                                className="grid place-items-center text-stone-500 transition hover:bg-stone-100 hover:text-stone-950 disabled:cursor-not-allowed disabled:opacity-35 dark:text-stone-400 dark:hover:bg-stone-900 dark:hover:text-white"
                                                aria-label="减少购买数量"
                                                title="减少数量"
                                                disabled={quantity <= 1}
                                                onClick={() => setQuantity((current) => Math.max(1, current - 1))}
                                            >
                                                <Minus className="size-3.5" />
                                            </button>
                                            <span className="grid place-items-center border-x border-stone-200 text-sm font-semibold tabular-nums text-stone-950 dark:border-stone-800 dark:text-white" aria-live="polite">
                                                {quantity}
                                            </span>
                                            <button
                                                type="button"
                                                className="grid place-items-center text-stone-500 transition hover:bg-stone-100 hover:text-stone-950 disabled:cursor-not-allowed disabled:opacity-35 dark:text-stone-400 dark:hover:bg-stone-900 dark:hover:text-white"
                                                aria-label="增加购买数量"
                                                title="增加数量"
                                                disabled={quantity >= 24}
                                                onClick={() => setQuantity((current) => Math.min(24, current + 1))}
                                            >
                                                <Plus className="size-3.5" />
                                            </button>
                                        </div>
                                    </label>

                                    <div className="mt-4 border-t border-dashed border-stone-200 pt-4 sm:mt-7 sm:pt-6 dark:border-stone-800">
                                        <Button block type="primary" size="large" className="profile-primary-button !h-10 sm:!h-12" loading={submitting} disabled={!provider || quoteLoading || Boolean(quoteError)} onClick={() => void submit()}>
                                            <span className="inline-flex items-center gap-2">
                                                <LockKeyhole className="size-4" /> {provider === "manual" ? "提交订单等待确认" : "确认订单并继续支付"}
                                            </span>
                                        </Button>
                                        <p className="mt-3 text-center text-xs leading-5 text-stone-500 dark:text-stone-400">{provider === "manual" ? "提交后订单进入待确认状态，客服核实后开通权益。" : "仅创建支付订单，支付完成后才会开通权益。"}</p>
                                    </div>
                                </div>
                            </>
                        ) : (
                            <div className="flex min-h-36 flex-col items-center justify-center text-center sm:min-h-[30rem]">
                                <span className="grid size-16 place-items-center rounded-2xl bg-[#eef2f7] text-[#52627a] dark:bg-[#66758e]/15 dark:text-[#d8dee8]">
                                    <CheckCircle2 className="size-8" />
                                </span>
                                <h2 className="mt-5 text-2xl font-semibold">{checkout.kind === "manual" ? "订单已提交" : "支付订单已创建"}</h2>
                                <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">
                                    订单号 {checkout.orderNo}
                                    {checkout.kind === "manual" ? "，客服确认后开通权益" : ""}
                                </p>
                                {checkout.qrContent ? <QRCode className="mt-6" value={checkout.qrContent} size={190} /> : null}
                                {checkout.kind === "manual" ? (
                                    <div className="mt-6 w-full max-w-md rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-left text-xs leading-5 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
                                        请将订单号提供给客服，客服确认收款后会开通套餐和人民币余额。
                                        {supportEmail ? (
                                            <a className="mt-1 block break-all font-semibold underline underline-offset-2" href={`mailto:${supportEmail}`}>
                                                客服邮箱：{supportEmail}
                                            </a>
                                        ) : null}
                                    </div>
                                ) : null}
                                <div className="mt-7 grid w-full max-w-md gap-3 sm:grid-cols-2">
                                    <Button icon={<Copy className="size-4" />} onClick={() => copyText(checkout.qrContent || checkout.url || checkout.orderNo, checkout.kind === "manual" ? "订单号已复制" : "支付信息已复制")}>
                                        {checkout.kind === "manual" ? "复制订单号" : "复制支付信息"}
                                    </Button>
                                    <Button
                                        type="primary"
                                        className="profile-primary-button"
                                        icon={<ExternalLink className="size-4" />}
                                        onClick={() => {
                                            if (checkout.kind === "manual") {
                                                router.push("/profile?section=orders");
                                                return;
                                            }
                                            openCheckout();
                                        }}
                                    >
                                        {checkout.kind === "manual" ? "查看订单状态" : "前往支付"}
                                    </Button>
                                </div>
                                <Link href="/profile?section=orders" className="mt-5 text-sm font-medium text-stone-500 hover:text-stone-950 dark:text-stone-400 dark:hover:text-white">
                                    返回个人中心查看订单
                                </Link>
                            </div>
                        )}
                    </section>
                </div>
            </div>
        </main>
    );
}

function SummaryRow({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
    return (
        <div className="flex items-center justify-between gap-4 border-b border-white/10 px-3 py-2.5 text-sm last:border-b-0 sm:px-4 sm:py-3.5 dark:border-stone-200">
            <span className="text-stone-400 dark:text-stone-500">{label}</span>
            <span className="inline-flex items-center gap-1 font-semibold">
                {icon}
                {value}
            </span>
        </div>
    );
}

function formatYuan(amountCents: number) {
    return (Math.max(0, amountCents) / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function CouponPickerMenu({ coupons, selectedCouponId, loading, onRefresh, onSelect }: { coupons: UserCoupon[]; selectedCouponId: string; loading: boolean; onRefresh: () => void; onSelect: (value: string) => void }) {
    const hasOptions = coupons.length > 0 || Boolean(selectedCouponId);
    return (
        <div className="w-[min(292px,calc(100vw-32px))] text-foreground">
            <div className="flex h-8 items-center justify-between border-b border-border pb-1.5">
                <p className="text-sm font-semibold">选择优惠券</p>
                <Button type="text" shape="circle" size="small" icon={<RefreshCw className="size-3.5" />} loading={loading} onClick={onRefresh} aria-label="刷新优惠券" />
            </div>
            <div className="thin-scrollbar mt-1.5 max-h-48 space-y-1 overflow-y-auto">
                {hasOptions ? <CouponPickerItem selected={!selectedCouponId} title="不使用优惠券" detail="按当前活动价格结算" onClick={() => onSelect("")} /> : null}
                {coupons.map((coupon) => (
                    <CouponPickerItem key={coupon.id} selected={selectedCouponId === coupon.id} disabled={!isCouponAvailable(coupon)} title={coupon.template?.name || "优惠券"} detail={couponDiscountLabel(coupon)} onClick={() => onSelect(coupon.id)} />
                ))}
                {!loading && !coupons.length ? <p className="px-2 py-2.5 text-center text-xs text-muted-foreground">当前没有可用优惠券</p> : null}
            </div>
        </div>
    );
}

function CouponPickerItem({ selected, disabled = false, title, detail, onClick }: { selected: boolean; disabled?: boolean; title: string; detail: string; onClick: () => void }) {
    return (
        <button
            type="button"
            disabled={disabled}
            className={`flex min-h-10 w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition ${selected ? "!bg-foreground !text-background" : "!bg-transparent !text-foreground hover:!bg-muted"} disabled:cursor-not-allowed disabled:!text-muted-foreground disabled:opacity-60`}
            onClick={onClick}
        >
            <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-semibold">{title}</span>
                <span className="mt-0.5 block truncate text-[11px] opacity-65">{detail}</span>
            </span>
            <span className={`grid size-4 shrink-0 place-items-center rounded-full border ${selected ? "border-current" : "border-border"}`}>{selected ? <Check className="size-3" /> : null}</span>
        </button>
    );
}

function isCouponAvailable(coupon: UserCoupon) {
    return coupon.status === "available" && coupon.applicable !== false;
}

function couponDiscountLabel(coupon: UserCoupon) {
    const template = coupon.template;
    if (!template) return coupon.unavailableReason || "规则不可用";
    const discount = template.discountType === "fixed" ? `减 ¥${formatYuan(template.discountValue)}` : `${(template.discountValue / 100).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}% 优惠`;
    return coupon.unavailableReason ? `${discount} · ${coupon.unavailableReason}` : discount;
}
