"use client";

import { Metric, Panel, PanelHeader } from "@/components/admin/admin-panel";
import { formatAdminMoney } from "@/components/admin/admin-values";
import { formatCreditAmount } from "@/constant/credits";
import { Button } from "antd";
import { CircleDollarSign, CreditCard, PlugZap, ReceiptText, RefreshCw, WalletCards } from "lucide-react";

import type { AdminDashboardController } from "./use-admin-dashboard-controller";
import { FinanceFlowItem, FinanceMiniRow } from "./admin-dashboard-elements";

export function AdminWalletSection({ controller }: { controller: AdminDashboardController }) {
    const { billingSummary, billingSummaryLoading, activeSection, setActiveSection, walletSummary, loadBillingSummary } = controller;
    if (activeSection !== "wallet") return null;
    return (
        <div className="space-y-3 sm:space-y-5">
            <section className="grid grid-cols-2 gap-2 sm:gap-3 md:grid-cols-2 xl:grid-cols-4">
                <Metric label="实收金额" value={formatAdminMoney(billingSummary?.orders.paidAmountCents || 0)} detail={`${billingSummary?.orders.paid || 0} 笔已支付订单`} icon={<CircleDollarSign className="size-5" />} tone="emerald" />
                <Metric label="待支付金额" value={formatAdminMoney(billingSummary?.orders.pendingAmountCents || 0)} detail={`${billingSummary?.orders.pending || 0} 笔待支付订单`} icon={<ReceiptText className="size-5" />} tone="amber" />
                <Metric label="退款支出" value={formatAdminMoney(billingSummary?.orders.refundedAmountCents || 0)} detail={`${billingSummary?.orders.refunded || 0} 笔退款标记`} icon={<RefreshCw className="size-5" />} tone="blue" />
                <Metric label="用户人民币余额" value={`¥${formatCreditAmount(walletSummary.totalBalance)}`} detail="所有用户当前人民币余额合计" icon={<WalletCards className="size-5" />} tone="slate" />
            </section>
            <Panel>
                <PanelHeader
                    title="财务流水"
                    description="查看收入、退款、余额负债和对账口径；套餐、订单和支付渠道保持独立管理。"
                    actions={
                        <Button aria-label="刷新财务" title="刷新财务" loading={billingSummaryLoading} icon={<RefreshCw className="size-4" />} onClick={() => void loadBillingSummary()}>
                            <span className="hidden sm:inline">刷新财务</span>
                        </Button>
                    }
                />
                <div className="grid gap-3 p-3 sm:gap-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_340px]">
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-1 sm:gap-3">
                        <FinanceFlowItem
                            title="充值收入"
                            amount={formatAdminMoney(billingSummary?.orders.paidAmountCents || 0)}
                            description={`来自 ${billingSummary?.orders.paid || 0} 笔已支付订单和成功支付流水。`}
                            icon={<CircleDollarSign className="size-4" />}
                        />
                        <FinanceFlowItem
                            title="退款支出"
                            amount={formatAdminMoney(billingSummary?.orders.refundedAmountCents || 0)}
                            description={`来自 ${billingSummary?.orders.refunded || 0} 笔退款标记，用于核对净收入。`}
                            icon={<ReceiptText className="size-4" />}
                        />
                        <FinanceFlowItem
                            title="净收入口径"
                            amount={formatAdminMoney((billingSummary?.orders.paidAmountCents || 0) - (billingSummary?.orders.refundedAmountCents || 0))}
                            description="已支付订单金额减退款标记金额，后续可继续接支付商真实结算流水。"
                            icon={<CircleDollarSign className="size-4" />}
                        />
                        <FinanceFlowItem title="余额负债" amount={`¥${formatCreditAmount(walletSummary.totalBalance)}`} description="所有用户当前人民币余额，代表平台仍需履约的生成额度。" icon={<WalletCards className="size-4" />} />
                    </div>
                    <div className="rounded-lg border border-stone-200 bg-stone-50/70 p-3 sm:p-4 dark:border-stone-800 dark:bg-stone-900/40">
                        <div className="text-sm font-semibold text-stone-950 dark:text-stone-100">财务口径说明</div>
                        <div className="mt-2 line-clamp-2 text-xs leading-5 text-stone-500 sm:line-clamp-none sm:text-sm sm:leading-6 dark:text-stone-400">
                            财务流水只保留收入、退款、余额负债和对账口径。套餐管理负责商品权益，订单管理负责收款与售后，支付渠道负责密钥和回调。
                        </div>
                        <div className="mt-4 grid gap-2 rounded-lg border border-stone-200 bg-white p-3 text-sm dark:border-stone-800 dark:bg-stone-950">
                            <FinanceMiniRow label="总订单" value={`${billingSummary?.orders.total || 0} 笔`} />
                            <FinanceMiniRow
                                label="对账异常"
                                value={`${billingSummary ? billingSummary.reconciliation.paidOrdersWithoutSucceededPayment + billingSummary.reconciliation.succeededPaymentsWithoutPaidOrder + billingSummary.reconciliation.amountMismatchPayments : 0} 项`}
                            />
                            <FinanceMiniRow label="在售套餐" value={`${walletSummary.enabledPlans} 个`} />
                            <FinanceMiniRow label="套餐用户" value={`${walletSummary.usersWithPlan} 人`} />
                        </div>
                        <div className="mt-3 grid grid-cols-3 gap-1.5 sm:mt-4 sm:grid-cols-1 sm:gap-2">
                            <Button className="px-2 text-xs sm:px-3 sm:text-sm" onClick={() => setActiveSection("products")} icon={<CreditCard className="size-3.5 sm:size-4" />}>
                                套餐管理
                            </Button>
                            <Button className="px-2 text-xs sm:px-3 sm:text-sm" onClick={() => setActiveSection("orders")} icon={<ReceiptText className="size-3.5 sm:size-4" />}>
                                订单管理
                            </Button>
                            <Button className="px-2 text-xs sm:px-3 sm:text-sm" onClick={() => setActiveSection("payments")} icon={<PlugZap className="size-3.5 sm:size-4" />}>
                                支付渠道
                            </Button>
                        </div>
                    </div>
                </div>
            </Panel>
        </div>
    );
}
