"use client";

import { Button, Spin, Tag } from "antd";
import { ArrowLeft, CheckCircle2, Clock3, ReceiptText, RefreshCw, RotateCcw, XCircle } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { cancelBillingOrder, getBillingOrder, subscribeBillingOrder, type BillingOrder } from "@/services/api/billing";
import { useUserStore, type LocalUser } from "@/stores/use-user-store";

export function BillingResultPage({ mode, orderId }: { mode: "success" | "cancel"; orderId: string }) {
    const [order, setOrder] = useState<BillingOrder | null>(null);
    const [loading, setLoading] = useState(true);
    const [checking, setChecking] = useState(false);
    const [error, setError] = useState("");
    const setUser = useUserStore((state) => state.setUser);
    const refreshedPaidOrderId = useRef("");

    const refreshUser = useCallback(async () => {
        const response = await fetch("/api/auth/session", { cache: "no-store" });
        const payload = (await response.json().catch(() => ({}))) as { user?: LocalUser | null };
        if (payload.user) setUser(payload.user);
    }, [setUser]);

    const applyOrder = useCallback(
        (nextOrder: BillingOrder) => {
            setOrder(nextOrder);
            setLoading(false);
            setError("");
            if (nextOrder.status === "paid" && refreshedPaidOrderId.current !== nextOrder.id) {
                refreshedPaidOrderId.current = nextOrder.id;
                void refreshUser();
            }
        },
        [refreshUser],
    );

    useEffect(() => {
        let active = true;
        if (!orderId) {
            setError("支付结果缺少订单编号");
            setLoading(false);
            return;
        }
        if (mode === "success") {
            const unsubscribe = subscribeBillingOrder(
                orderId,
                (nextOrder) => {
                    if (active) applyOrder(nextOrder);
                },
                () => {
                    if (!active) return;
                    setLoading(false);
                    setError("实时状态连接暂时中断，正在自动恢复，也可以手动检查订单。");
                },
            );
            return () => {
                active = false;
                unsubscribe();
            };
        }
        void (async () => {
            try {
                const payload = await cancelBillingOrder(orderId);
                if (active) applyOrder(payload.order);
            } catch (value) {
                if (!active) return;
                setError(value instanceof Error ? value.message : "支付结果加载失败");
                setLoading(false);
            }
        })();
        return () => {
            active = false;
        };
    }, [applyOrder, mode, orderId]);

    const checkOrder = async () => {
        if (!orderId || checking) return;
        setChecking(true);
        try {
            applyOrder((await getBillingOrder(orderId)).order);
        } catch (value) {
            setError(value instanceof Error ? value.message : "支付结果加载失败");
        } finally {
            setChecking(false);
        }
    };

    const paid = order?.status === "paid";
    const canceled = mode === "cancel" || order?.status === "canceled" || order?.status === "closed";
    const refunded = order?.status === "refunding" || order?.status === "refunded";
    const pending = !order || order.status === "pending";
    const Icon = paid ? CheckCircle2 : canceled ? XCircle : refunded ? RotateCcw : Clock3;
    const title = paid ? "支付成功" : order?.status === "closed" ? "订单已关闭" : canceled ? "支付已取消" : order?.status === "refunded" ? "订单已退款" : order?.status === "refunding" ? "订单退款中" : "支付结果确认中";
    const description = paid
        ? "套餐权益和人民币余额已经更新。"
        : order?.status === "closed"
          ? "订单已超过支付有效期，你可以重新选择套餐和支付方式。"
          : canceled
            ? "订单已取消，你可以重新选择套餐和支付方式。"
            : order?.status === "refunded"
              ? "该订单已经完成退款。"
              : order?.status === "refunding"
                ? "退款正在处理中，可前往订单记录查看进度。"
                : "正在等待支付回调，可随时离开并在订单记录中查看最终状态。";
    const statusLabel = paid ? "已支付" : order?.status === "closed" ? "已关闭" : canceled ? "已取消" : order?.status === "refunded" ? "已退款" : order?.status === "refunding" ? "退款中" : "待确认";
    const statusColor = paid ? "green" : refunded ? "blue" : canceled ? "default" : "gold";

    return (
        <main className="profile-page-scroll h-full min-h-0 overflow-y-auto bg-[#fafbfc] px-2 py-2 text-stone-950 sm:px-6 sm:py-8 dark:bg-[#111316] dark:text-stone-100">
            <div className="mx-auto flex min-h-0 max-w-xl items-center justify-center sm:min-h-[calc(100dvh-8rem)]">
                <section className="w-full rounded-xl border border-stone-200 bg-white p-3 text-center shadow-sm shadow-stone-200/60 sm:rounded-2xl sm:p-8 dark:border-stone-800 dark:bg-stone-950 dark:shadow-black/25">
                    {loading ? (
                        <div className="py-2 sm:py-12">
                            <Spin />
                            <div className="mt-4 text-sm text-stone-500 dark:text-stone-400">正在确认支付结果…</div>
                        </div>
                    ) : (
                        <>
                            <span
                                className={`mx-auto grid size-12 place-items-center rounded-xl sm:size-16 sm:rounded-2xl ${paid ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-400/10 dark:text-emerald-300" : canceled ? "bg-rose-50 text-rose-600 dark:bg-rose-400/10 dark:text-rose-300" : refunded ? "bg-sky-50 text-sky-600 dark:bg-sky-400/10 dark:text-sky-300" : "bg-amber-50 text-amber-600 dark:bg-amber-400/10 dark:text-amber-300"}`}
                            >
                                <Icon className="size-6 sm:size-8" />
                            </span>
                            <h1 className="mt-3 text-xl font-semibold sm:mt-5 sm:text-2xl">{title}</h1>
                            <p className="mt-2 text-sm leading-6 text-stone-500 dark:text-stone-400">{error || description}</p>
                            {mode === "success" && pending ? (
                                <Button className="mt-3" icon={<RefreshCw className="size-4" />} loading={checking} onClick={() => void checkOrder()}>
                                    重新检查
                                </Button>
                            ) : null}
                            {order ? (
                                <div className="mt-4 rounded-xl border border-stone-200 bg-stone-50 p-3.5 text-left sm:mt-6 sm:p-4 dark:border-stone-800 dark:bg-stone-900/55">
                                    <div className="flex items-center justify-between gap-3 text-sm">
                                        <span className="text-stone-500 dark:text-stone-400">订单号</span>
                                        <span className="break-all font-mono text-xs">{order.orderNo}</span>
                                    </div>
                                    <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                                        <span className="text-stone-500 dark:text-stone-400">当前状态</span>
                                        <Tag color={statusColor}>{statusLabel}</Tag>
                                    </div>
                                </div>
                            ) : null}
                            <div className="mt-4 grid gap-2.5 sm:mt-6 sm:grid-cols-2 sm:gap-3">
                                <Link href="/billing" className="block">
                                    <Button block className="!h-10" icon={<ArrowLeft className="size-4" />}>
                                        返回充值中心
                                    </Button>
                                </Link>
                                <Link href="/profile?section=orders" className="block">
                                    <Button block type="primary" className="profile-primary-button !h-10" icon={<ReceiptText className="size-4" />}>
                                        查看订单记录
                                    </Button>
                                </Link>
                            </div>
                        </>
                    )}
                </section>
            </div>
        </main>
    );
}
