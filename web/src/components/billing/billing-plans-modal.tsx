"use client";

import { App, Modal, Spin } from "antd";
import { BadgeCheck, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";

import { BillingPlanGrid } from "@/components/billing/billing-plan-grid";
import { DEFAULT_SUPPORT_EMAIL } from "@/lib/site-brand";
import { listBillingProducts, type BillingProduct } from "@/services/api/billing";

export function BillingPlansModal({ open, onClose, onSelect }: { open: boolean; onClose: () => void; onSelect: (product: BillingProduct) => void }) {
    const { message } = App.useApp();
    const [products, setProducts] = useState<BillingProduct[]>([]);
    const [paymentProviders, setPaymentProviders] = useState<string[]>([]);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!open || products.length || loading) return;
        setLoading(true);
        void listBillingProducts()
            .then((payload) => {
                setProducts(payload.products || []);
                setPaymentProviders(payload.paymentProviders || []);
            })
            .catch((error) => message.error(error instanceof Error ? error.message : "套餐加载失败"))
            .finally(() => setLoading(false));
    }, [loading, message, open, products.length]);
    const hasAutomaticPayment = paymentProviders.some((provider) => provider !== "manual");

    return (
        <Modal
            rootClassName="billing-plans-modal profile-page-scroll"
            title={null}
            open={open}
            width={modalWidth(products.length)}
            centered
            footer={null}
            closable={false}
            onCancel={onClose}
            styles={{ container: { padding: 0, overflow: "hidden" }, body: { padding: 0, maxHeight: "calc(100dvh - 32px)", overflowY: "auto" } }}
        >
            <div className="bg-[#f7f7f5] text-stone-950 dark:bg-[#101113] dark:text-stone-100">
                <div className="relative border-b border-stone-200 bg-white px-4 py-3 sm:px-5 dark:border-stone-800 dark:bg-stone-950">
                    <button
                        type="button"
                        className="absolute right-3 top-3 z-10 grid size-8 place-items-center rounded-lg border border-stone-200 bg-stone-50 text-stone-600 transition hover:border-stone-300 hover:bg-stone-100 hover:text-stone-950 disabled:text-stone-300 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300 dark:hover:border-stone-600 dark:hover:bg-stone-800 dark:hover:text-white"
                        aria-label="关闭套餐选择"
                        title="关闭"
                        onClick={onClose}
                    >
                        <X className="size-4" />
                    </button>
                    <div className="mx-auto flex max-w-[1060px] items-center justify-between gap-4 pr-11">
                        <div className="flex min-w-0 items-center gap-2.5">
                            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-stone-950 text-white dark:bg-white dark:text-stone-950">
                                <Sparkles className="size-4" />
                            </span>
                            <div className="min-w-0">
                                <div className="text-sm font-semibold">升级创作套餐</div>
                                <div className="mt-0.5 truncate text-xs text-stone-500 dark:text-stone-400">选择方案后查看订单与支付方式</div>
                            </div>
                        </div>
                        <span className="hidden items-center gap-1.5 text-xs font-medium text-emerald-700 sm:inline-flex dark:text-emerald-300">
                            <BadgeCheck className="size-4" /> 订单完成后到账
                        </span>
                    </div>
                </div>

                <div className="px-2.5 py-2.5 sm:px-4 sm:py-4">
                    {loading ? (
                        <div className="grid min-h-32 place-items-center">
                            <Spin />
                        </div>
                    ) : products.length ? (
                        <div className="mx-auto max-w-[1060px]">
                            <p className="mb-3 rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-xs leading-5 text-stone-600 dark:border-stone-800 dark:bg-stone-950 dark:text-stone-300">
                                余额按人民币结算：文本按实际输入和输出用量计费，图片与视频按模型和参数计费；生成失败会自动退回已扣余额。
                                {hasAutomaticPayment ? "当前支持在线支付，支付完成后权益会自动到账。" : "当前支付方式为客服确认，提交订单后请将订单号发送给客服开通。"}{" "}
                                <a className="font-medium underline underline-offset-2" href={`mailto:${DEFAULT_SUPPORT_EMAIL}`}>
                                    客服邮箱：{DEFAULT_SUPPORT_EMAIL}
                                </a>
                            </p>
                            <BillingPlanGrid
                                variant="modal"
                                products={products}
                                onSelect={(product) => {
                                    onClose();
                                    onSelect(product);
                                }}
                            />
                        </div>
                    ) : (
                        <div className="mx-auto max-w-3xl rounded-xl border border-dashed border-stone-300 bg-white px-5 py-10 text-center dark:border-stone-700 dark:bg-stone-950">
                            <div className="text-sm font-semibold text-stone-900 dark:text-stone-100">套餐正在准备中</div>
                            <p className="mx-auto mt-2 max-w-md text-xs leading-5 text-stone-500 dark:text-stone-400">当前可以先体验已开放的创作能力。套餐上线后，这里会显示价格、余额和有效期，未完成购买不会产生扣费。</p>
                        </div>
                    )}
                </div>
            </div>
        </Modal>
    );
}

function modalWidth(productCount: number) {
    if (productCount <= 1) return "min(94vw, 520px)";
    if (productCount === 2) return "min(94vw, 860px)";
    if (productCount === 3) return "min(96vw, 1040px)";
    return "min(96vw, 1180px)";
}
