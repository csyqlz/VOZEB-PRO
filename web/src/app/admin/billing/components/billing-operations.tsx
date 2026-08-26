"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { App, Button, DatePicker, Form, Input, InputNumber, Modal, Select, Segmented, Space, Switch, Table, Tag } from "antd";
import type { TableColumnsType } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { AlertTriangle, CheckCircle2, CircleDollarSign, Copy, CreditCard, FileText, FileUp, Landmark, Package, Pencil, Plus, QrCode, ReceiptText, RefreshCw, Save, Search, Settings2, Trash2, Undo2, WalletCards, XCircle } from "lucide-react";

import type { PaymentConfigRequirement, PaymentConfigSummary, PaymentProviderConfig, PaymentProviderConfigField } from "@/lib/payment-config-types";
import { AdminUserIdentity } from "@/components/admin/admin-user-identity";
import type { AdminBillingSummary as BillingSummary } from "@/lib/admin-billing-types";
import type { BillingOrder, BillingOrderStatus, BillingProduct } from "@/services/api/billing";
import { allowedAdminBillingTabs, type AdminBillingTab } from "@/lib/admin-permissions";
import { useUserStore } from "@/stores/use-user-store";
import { BillingReconciliationImport } from "./billing-reconciliation-import";
import { CouponTemplatePanel } from "./coupon-template-panel";
import { PromotionCampaignPanel } from "./promotion-campaign-panel";

const PAGE_SIZE = 20;
const tabOptions: Array<{ label: string; value: AdminBillingTab }> = [
    { label: "订单运营", value: "orders" },
    { label: "套餐商品", value: "products" },
    { label: "促销活动", value: "promotions" },
    { label: "优惠券", value: "coupons" },
    { label: "支付配置", value: "payments" },
];
const statusOptions: Array<{ label: string; value: BillingOrderStatus | "" }> = [
    { label: "全部状态", value: "" },
    { label: "待支付", value: "pending" },
    { label: "已支付", value: "paid" },
    { label: "已关闭", value: "closed" },
    { label: "已取消", value: "canceled" },
    { label: "已退款", value: "refunded" },
    { label: "退款处理中", value: "refunding" },
];

type ProductFormValue = {
    id?: string;
    productKind: "plan" | "points";
    planId?: string;
    name: string;
    description?: string;
    amountYuan: number;
    currency: string;
    pointsAmount: number;
    dailyPoints: number;
    periodDays: number;
    enabled: boolean;
    sortOrder: number;
};

function defaultProductFormValue(sortOrder: number): ProductFormValue {
    return {
        id: "",
        productKind: "plan",
        planId: "creator",
        name: "",
        description: "",
        amountYuan: 0,
        currency: "CNY",
        pointsAmount: 0,
        dailyPoints: 0,
        periodDays: 30,
        enabled: true,
        sortOrder,
    };
}

import {
    ReconciliationPanel,
    ActiveProductsPanel,
    ProductFact,
    PaymentConfigPanel,
    PaymentProviderCard,
    PaymentFieldSection,
    sortPaymentFields,
    isWidePaymentField,
    PaymentConfigFieldControl,
    PaymentFieldHeader,
    RequirementGrid,
    providerIcon,
    normalizePaymentFormValue,
    copyText,
    Metric,
    CheckLine,
    metricTone,
    statusLabel,
    statusColor,
    providerLabel,
    formatMoney,
    formatTime,
} from "./billing-operation-elements";

export function BillingOperations({ initialTab = "orders", initialPaymentConfig, embedded = false, hideTabs = false }: { initialTab?: AdminBillingTab; initialPaymentConfig?: PaymentConfigSummary; embedded?: boolean; hideTabs?: boolean }) {
    const { message, modal } = App.useApp();
    const currentUser = useUserStore((state) => state.user);
    const allowedTabs = useMemo(() => allowedAdminBillingTabs(currentUser), [currentUser]);
    const availableTabOptions = useMemo(() => tabOptions.filter((option) => allowedTabs.includes(option.value)), [allowedTabs]);
    const [productForm] = Form.useForm<ProductFormValue>();
    const [activeTab, setActiveTab] = useState<AdminBillingTab>(initialTab);
    const [summary, setSummary] = useState<BillingSummary | null>(null);
    const [orders, setOrders] = useState<BillingOrder[]>([]);
    const [products, setProducts] = useState<BillingProduct[]>([]);
    const [editingProductId, setEditingProductId] = useState("");
    const [productModalOpen, setProductModalOpen] = useState(false);
    const [reconciliationImportOpen, setReconciliationImportOpen] = useState(false);
    const [productSaving, setProductSaving] = useState(false);
    const [paymentConfig, setPaymentConfig] = useState<PaymentConfigSummary | null>(initialPaymentConfig || null);
    const [paymentConfigLoading, setPaymentConfigLoading] = useState(false);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [status, setStatus] = useState<BillingOrderStatus | "">("");
    const [keyword, setKeyword] = useState("");
    const [submittedKeyword, setSubmittedKeyword] = useState("");
    const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
    const [loading, setLoading] = useState(initialTab === "orders");
    const [productsLoading, setProductsLoading] = useState(initialTab !== "payments");
    const [actionOrderId, setActionOrderId] = useState("");
    const [deletingProductId, setDeletingProductId] = useState("");
    const productKind = Form.useWatch("productKind", productForm) || "plan";

    const startDate = range?.[0]?.format("YYYY-MM-DD");
    const endDate = range?.[1]?.format("YYYY-MM-DD");

    const loadProducts = useCallback(async () => {
        setProductsLoading(true);
        try {
            const response = await fetch("/api/admin/billing/products", { cache: "no-store" });
            const payload = (await response.json().catch(() => null)) as { products?: BillingProduct[]; error?: string } | null;
            if (!response.ok || !payload?.products) throw new Error(payload?.error || "加载套餐商品失败");
            setProducts(payload.products);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加载套餐商品失败");
        } finally {
            setProductsLoading(false);
        }
    }, [message]);

    const loadPaymentConfig = useCallback(async () => {
        setPaymentConfigLoading(true);
        try {
            const response = await fetch("/api/admin/billing/payment-config", { cache: "no-store" });
            const payload = (await response.json().catch(() => null)) as { paymentConfig?: PaymentConfigSummary; error?: string } | null;
            if (!response.ok || !payload?.paymentConfig) throw new Error(payload?.error || "加载支付配置失败");
            setPaymentConfig(payload.paymentConfig);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加载支付配置失败");
        } finally {
            setPaymentConfigLoading(false);
        }
    }, [message]);

    const loadDashboard = useCallback(async () => {
        setLoading(true);
        try {
            const summaryParams = new URLSearchParams();
            if (startDate) summaryParams.set("startDate", startDate);
            if (endDate) summaryParams.set("endDate", endDate);

            const orderParams = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
            if (status) orderParams.set("status", status);
            if (submittedKeyword) orderParams.set("keyword", submittedKeyword);

            const [summaryResponse, ordersResponse] = await Promise.all([fetch(`/api/admin/billing/summary?${summaryParams.toString()}`, { cache: "no-store" }), fetch(`/api/admin/billing/orders?${orderParams.toString()}`, { cache: "no-store" })]);
            const summaryPayload = (await summaryResponse.json().catch(() => null)) as { summary?: BillingSummary; error?: string } | null;
            const ordersPayload = (await ordersResponse.json().catch(() => null)) as { orders?: BillingOrder[]; total?: number; error?: string } | null;
            if (!summaryResponse.ok || !summaryPayload?.summary) throw new Error(summaryPayload?.error || "加载运营摘要失败");
            if (!ordersResponse.ok || !ordersPayload?.orders) throw new Error(ordersPayload?.error || "加载订单失败");
            setSummary(summaryPayload.summary);
            setOrders(ordersPayload.orders);
            setTotal(ordersPayload.total || 0);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加载财务钱包数据失败");
        } finally {
            setLoading(false);
        }
    }, [endDate, message, page, startDate, status, submittedKeyword]);

    useEffect(() => {
        if (allowedTabs.includes(activeTab) && (activeTab === "orders" || activeTab === "products" || activeTab === "promotions" || activeTab === "coupons")) void loadProducts();
    }, [activeTab, allowedTabs, loadProducts]);

    useEffect(() => {
        if (allowedTabs.includes(activeTab) && activeTab === "orders") void loadDashboard();
    }, [activeTab, allowedTabs, loadDashboard]);

    useEffect(() => {
        const nextTab = allowedTabs.includes(initialTab) ? initialTab : allowedTabs[0];
        if (nextTab) setActiveTab(nextTab);
    }, [allowedTabs, initialTab]);

    useEffect(() => {
        if (allowedTabs.includes(activeTab) && activeTab === "payments" && !paymentConfig) void loadPaymentConfig();
    }, [activeTab, allowedTabs, loadPaymentConfig, paymentConfig]);

    const runOrderAction = async (order: BillingOrder, action: "complete" | "close" | "refund", reason?: string) => {
        setActionOrderId(`${action}:${order.id}`);
        try {
            const response = await fetch(`/api/admin/billing/orders/${order.id}/${action}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(action === "complete" ? { provider: order.provider || "manual", channel: "admin-manual", providerTradeId: order.providerOrderId || order.orderNo } : { reason }),
            });
            const payload = (await response.json().catch(() => null)) as { error?: string } | null;
            if (!response.ok) throw new Error(payload?.error || "订单操作失败");
            message.success(action === "complete" ? "已确认支付" : action === "close" ? "已关闭订单" : "已标记退款");
            await loadDashboard();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "订单操作失败");
        } finally {
            setActionOrderId("");
        }
    };

    const confirmOrderAction = (order: BillingOrder, action: "complete" | "close" | "refund") => {
        if (action === "complete") {
            modal.confirm({
                title: "确认这笔订单已收款？",
                content: "确认后会开通套餐并发放人民币余额，请先核实支付商或线下收款记录。",
                okText: "确认收款",
                cancelText: "取消",
                onOk: () => runOrderAction(order, action),
            });
            return;
        }

        let reason = "";
        modal.confirm({
            title: action === "close" ? "关闭这笔待支付订单？" : "标记这笔订单为已退款？",
            content: (
                <Input.TextArea
                    rows={3}
                    maxLength={200}
                    placeholder={action === "close" ? "例如：用户取消、超时未支付" : "例如：支付商后台已退款、人工售后退款"}
                    onChange={(event) => {
                        reason = event.target.value;
                    }}
                />
            ),
            okText: action === "close" ? "关闭订单" : "标记退款",
            cancelText: "取消",
            okButtonProps: { danger: action === "refund" },
            onOk: () => runOrderAction(order, action, reason),
        });
    };

    const reconciliationIssues = summary ? summary.reconciliation.paidOrdersWithoutSucceededPayment + summary.reconciliation.succeededPaymentsWithoutPaidOrder + summary.reconciliation.amountMismatchPayments : 0;
    const activeProducts = useMemo(() => products.filter((product) => product.enabled), [products]);
    const openCreateProductModal = () => {
        setEditingProductId("");
        productForm.resetFields();
        productForm.setFieldsValue(defaultProductFormValue(products.length + 1));
        setProductModalOpen(true);
    };
    const closeProductModal = () => {
        if (productSaving) return;
        setProductModalOpen(false);
        setEditingProductId("");
        productForm.resetFields();
    };
    const editProduct = (product: BillingProduct) => {
        setEditingProductId(product.id);
        productForm.setFieldsValue({
            id: product.id,
            productKind: product.productKind || "plan",
            planId: product.planId,
            name: product.name,
            description: product.description,
            amountYuan: Number((product.amountCents / 100).toFixed(2)),
            currency: product.currency,
            pointsAmount: product.pointsAmount,
            dailyPoints: product.dailyPoints,
            periodDays: product.periodDays,
            enabled: product.enabled,
            sortOrder: product.sortOrder || 0,
        });
        setProductModalOpen(true);
    };
    const saveProduct = async (value: ProductFormValue) => {
        setProductSaving(true);
        try {
            const response = await fetch("/api/admin/billing/products", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    id: value.id || undefined,
                    productKind: value.productKind,
                    planId: value.productKind === "plan" ? value.planId : undefined,
                    name: value.name,
                    description: value.description || "",
                    amountCents: Math.round(Number(value.amountYuan || 0) * 100),
                    currency: value.currency,
                    pointsAmount: value.pointsAmount,
                    dailyPoints: value.productKind === "plan" ? value.dailyPoints : 0,
                    periodDays: value.productKind === "plan" ? value.periodDays : 0,
                    enabled: value.enabled,
                    sortOrder: value.sortOrder,
                }),
            });
            const payload = (await response.json().catch(() => null)) as { error?: string } | null;
            if (!response.ok) throw new Error(payload?.error || "保存套餐商品失败");
            message.success("套餐商品已保存");
            setProductModalOpen(false);
            setEditingProductId("");
            productForm.resetFields();
            await loadProducts();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存套餐商品失败");
        } finally {
            setProductSaving(false);
        }
    };
    const confirmDeleteProduct = (product: BillingProduct) => {
        modal.confirm({
            title: `删除“${product.name}”？`,
            content: "未产生订单的商品会永久删除；已有订单的商品会被保护，请改为编辑后下架。",
            okText: "确认删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                setDeletingProductId(product.id);
                try {
                    const response = await fetch(`/api/admin/billing/products/${encodeURIComponent(product.id)}`, { method: "DELETE" });
                    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
                    if (response.status === 409) {
                        modal.warning({
                            title: "该套餐已有订单，不能删除",
                            content: payload?.error || "为保留订单和财务记录，该套餐只能下架。请在编辑商品中关闭上架状态。",
                            okText: "去编辑下架",
                            onOk: () => editProduct(product),
                        });
                        return;
                    }
                    if (!response.ok) throw new Error(payload?.error || "删除套餐商品失败");
                    message.success("套餐商品已删除");
                    await loadProducts();
                } catch (error) {
                    message.error(error instanceof Error ? error.message : "删除套餐商品失败");
                    throw error;
                } finally {
                    setDeletingProductId("");
                }
            },
        });
    };

    const columns: TableColumnsType<BillingOrder> = [
        {
            title: "订单",
            dataIndex: "orderNo",
            width: 230,
            render: (_, order) => (
                <div className="min-w-0">
                    <div className="truncate font-medium text-stone-950 dark:text-stone-100">{order.orderNo}</div>
                    <div className="mt-1 truncate text-xs text-stone-500 dark:text-stone-400">{order.subject}</div>
                </div>
            ),
        },
        {
            title: "状态",
            dataIndex: "status",
            width: 110,
            render: (value: BillingOrderStatus) => <Tag color={statusColor(value)}>{statusLabel(value)}</Tag>,
        },
        {
            title: "渠道",
            dataIndex: "provider",
            width: 110,
            render: (value: string) => <span className="text-sm text-stone-700 dark:text-stone-200">{providerLabel(value)}</span>,
        },
        {
            title: "金额",
            dataIndex: "amountCents",
            width: 130,
            render: (_, order) => <span className="font-medium">{formatMoney(order.amountCents, order.currency)}</span>,
        },
        {
            title: "权益",
            width: 150,
            render: (_, order) => (
                <div className="text-sm text-stone-600 dark:text-stone-300">
                    <div>¥{order.pointsAmount} 永久余额</div>
                    <div className="text-xs text-stone-500 dark:text-stone-400">
                        每日 {order.dailyPoints} · {order.periodDays ? `${order.periodDays} 天` : "长期"}
                    </div>
                </div>
            ),
        },
        {
            title: "用户",
            dataIndex: "userId",
            width: 220,
            render: (_, order) => <AdminUserIdentity displayName={order.userDisplayName} username={order.userUsername} accountId={order.userAccountId} fallback={order.userId ? "用户信息不可用" : "未绑定用户"} />,
        },
        {
            title: "创建时间",
            dataIndex: "createdAt",
            width: 170,
            render: (value: string) => formatTime(value),
        },
        {
            title: "操作",
            fixed: "right",
            width: 230,
            render: (_, order) => (
                <Space size={6} wrap>
                    {order.status === "pending" ? (
                        <>
                            <Button size="small" icon={<CheckCircle2 className="size-3.5" />} loading={actionOrderId === `complete:${order.id}`} onClick={() => confirmOrderAction(order, "complete")}>
                                收款
                            </Button>
                            <Button size="small" icon={<XCircle className="size-3.5" />} loading={actionOrderId === `close:${order.id}`} onClick={() => confirmOrderAction(order, "close")}>
                                关单
                            </Button>
                        </>
                    ) : null}
                    {order.status === "paid" ? (
                        <Button danger size="small" icon={<Undo2 className="size-3.5" />} loading={actionOrderId === `refund:${order.id}`} onClick={() => confirmOrderAction(order, "refund")}>
                            退款
                        </Button>
                    ) : null}
                </Space>
            ),
        },
    ];

    return (
        <div className="space-y-3 sm:space-y-5">
            {!hideTabs ? (
                <section className="rounded-lg border border-stone-200 bg-white p-3 shadow-sm shadow-stone-200/40 dark:border-stone-800 dark:bg-stone-950 dark:shadow-black/20">
                    <Segmented
                        block
                        value={activeTab}
                        options={availableTabOptions}
                        onChange={(value) => setActiveTab(value as AdminBillingTab)}
                        className="[&_.ant-segmented-group]:!flex [&_.ant-segmented-item]:!min-w-0 [&_.ant-segmented-item]:!flex-1 [&_.ant-segmented-item-label]:!text-center"
                    />
                </section>
            ) : null}

            {allowedTabs.includes(activeTab) && activeTab === "orders" ? (
                <>
                    <section className="grid grid-cols-2 gap-2 sm:gap-3 md:grid-cols-2 xl:grid-cols-4">
                        <Metric title="实收金额" value={formatMoney(summary?.orders.paidAmountCents || 0)} icon={<CircleDollarSign className="size-4" />} tone="emerald" />
                        <Metric title="待支付金额" value={formatMoney(summary?.orders.pendingAmountCents || 0)} icon={<WalletCards className="size-4" />} tone="amber" />
                        <Metric title="已支付订单" value={summary?.orders.paid || 0} icon={<ReceiptText className="size-4" />} tone="blue" />
                        <Metric title="对账异常" value={reconciliationIssues} icon={<AlertTriangle className="size-4" />} tone={reconciliationIssues ? "rose" : "slate"} />
                    </section>

                    <section
                        className={
                            embedded
                                ? "rounded-lg border border-stone-200 bg-white p-3 dark:border-stone-800 dark:bg-stone-950 sm:p-4"
                                : "rounded-lg border border-stone-200 bg-white p-3 shadow-sm shadow-stone-200/40 dark:border-stone-800 dark:bg-stone-950 dark:shadow-black/20 sm:p-4"
                        }
                    >
                        <div>
                            <div>
                                <h2 className="text-base font-semibold text-stone-950 dark:text-stone-100">运营筛选</h2>
                                <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">日期范围影响摘要；订单列表可按状态和关键词筛选。</p>
                            </div>
                            <div className="mt-4 grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-[minmax(240px,1fr)_minmax(128px,0.45fr)_minmax(220px,0.9fr)_auto]">
                                <DatePicker.RangePicker className="w-full" value={range} onChange={(value) => setRange(value)} />
                                <Select
                                    className="w-full"
                                    value={status}
                                    options={statusOptions}
                                    onChange={(value) => {
                                        setStatus(value);
                                        setPage(1);
                                    }}
                                />
                                <Input
                                    className="w-full"
                                    allowClear
                                    value={keyword}
                                    prefix={<Search className="size-4 text-stone-400" />}
                                    placeholder="订单号 / 商品 / 支付单号 / 用户 ID"
                                    onChange={(event) => setKeyword(event.target.value)}
                                    onPressEnter={() => {
                                        setSubmittedKeyword(keyword.trim());
                                        setPage(1);
                                    }}
                                />
                                <div className="grid grid-cols-2 gap-2 sm:col-span-2 xl:col-span-1 xl:flex">
                                    <Button
                                        className="w-full xl:w-auto"
                                        icon={<Search className="size-4" />}
                                        onClick={() => {
                                            setSubmittedKeyword(keyword.trim());
                                            setPage(1);
                                        }}
                                    >
                                        查询
                                    </Button>
                                    <Button className="w-full xl:w-auto" icon={<RefreshCw className="size-4" />} loading={loading || productsLoading} onClick={() => void Promise.all([loadProducts(), loadDashboard()])}>
                                        刷新
                                    </Button>
                                </div>
                            </div>
                        </div>

                        <div className="mt-4 grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_360px]">
                            <div className="min-w-0 overflow-hidden rounded-lg border border-stone-200 dark:border-stone-800">
                                <Table
                                    rowKey="id"
                                    size="middle"
                                    columns={columns}
                                    dataSource={orders}
                                    loading={loading}
                                    scroll={{ x: 1300 }}
                                    pagination={{
                                        current: page,
                                        pageSize: PAGE_SIZE,
                                        total,
                                        showSizeChanger: false,
                                        onChange: setPage,
                                    }}
                                />
                            </div>

                            <aside className="min-w-0 space-y-3">
                                <ReconciliationPanel reconciliationIssues={reconciliationIssues} summary={summary} onImport={() => setReconciliationImportOpen(true)} />
                                <ActiveProductsPanel activeProducts={activeProducts} />
                            </aside>
                        </div>
                    </section>
                    <BillingReconciliationImport open={reconciliationImportOpen} onClose={() => setReconciliationImportOpen(false)} />
                </>
            ) : null}

            {allowedTabs.includes(activeTab) && activeTab === "products" ? (
                <>
                    <section className="grid min-w-0 items-start gap-4">
                        <div
                            className={`min-w-0 overflow-hidden ${embedded ? "rounded-lg border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-950" : "rounded-lg border border-stone-200 bg-white shadow-sm shadow-stone-200/40 dark:border-stone-800 dark:bg-stone-950 dark:shadow-black/20"}`}
                        >
                            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1.5 border-b border-stone-200 p-3 sm:flex sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:p-4 dark:border-stone-800">
                                <div className="contents sm:block">
                                    <h2 className="text-base font-semibold text-stone-950 dark:text-stone-100">套餐商品</h2>
                                    <div className="col-span-2 line-clamp-2 text-xs leading-5 text-stone-500 sm:mt-1 sm:block sm:text-sm dark:text-stone-400">上架后会出现在用户端充值中心；创建和编辑都在弹窗中完成。</div>
                                </div>
                                <div className="col-start-2 row-start-1 flex flex-wrap justify-end gap-1.5 sm:gap-2">
                                    <Button type="primary" aria-label="创建商品" title="创建商品" icon={<Plus className="size-4" />} onClick={openCreateProductModal}>
                                        <span className="sm:hidden">新建</span>
                                        <span className="hidden sm:inline">创建商品</span>
                                    </Button>
                                    <Button aria-label="刷新套餐商品" title="刷新套餐商品" icon={<RefreshCw className="size-4" />} loading={productsLoading} onClick={() => void loadProducts()}>
                                        <span className="hidden sm:inline">刷新</span>
                                    </Button>
                                </div>
                            </div>
                            <div className="grid min-w-0 gap-2 p-3 sm:gap-3 sm:p-4 md:grid-cols-2">
                                {productsLoading && !products.length ? (
                                    <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-stone-200 px-3 py-6 text-sm text-stone-500 sm:py-10 md:col-span-2 dark:border-stone-800 dark:text-stone-400">
                                        <RefreshCw className="size-4 animate-spin" />
                                        <span>正在加载套餐商品</span>
                                    </div>
                                ) : products.length ? (
                                    products.map((product) => (
                                        <article
                                            key={product.id}
                                            className={`min-w-0 rounded-lg border p-3 text-left transition sm:p-4 ${productModalOpen && editingProductId === product.id ? "border-stone-400 bg-stone-100/80 dark:border-stone-500 dark:bg-stone-800/55" : "border-stone-200 bg-stone-50/70 hover:border-stone-300 dark:border-stone-800 dark:bg-stone-900/40 dark:hover:border-stone-700"}`}
                                        >
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="min-w-0">
                                                    <div className="truncate text-sm font-semibold text-stone-950 dark:text-stone-100">{product.name}</div>
                                                    <div className="mt-1 line-clamp-2 text-xs leading-5 text-stone-500 dark:text-stone-400">
                                                        {product.description || (product.productKind === "points" ? "人民币余额充值商品" : product.planId || "未关联套餐")}
                                                    </div>
                                                    {product.pricing.discountCents > 0 ? (
                                                        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
                                                            <Tag className="m-0" color="red">
                                                                {product.pricing.promotion?.label || "活动进行中"}
                                                            </Tag>
                                                            <span className="font-semibold text-rose-600 dark:text-rose-300">活动价 {formatMoney(product.pricing.saleUnitAmountCents, product.currency)}</span>
                                                            <span className="text-stone-400 line-through dark:text-stone-500">日常价 {formatMoney(product.amountCents, product.currency)}</span>
                                                        </div>
                                                    ) : null}
                                                </div>
                                                <div className="flex shrink-0 items-center gap-1.5">
                                                    <Tag color={product.productKind === "points" ? "gold" : "blue"}>{product.productKind === "points" ? "余额充值" : "套餐"}</Tag>
                                                    <Tag color={product.enabled ? "green" : "default"}>{product.enabled ? "上架" : "下架"}</Tag>
                                                </div>
                                            </div>
                                            <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-stone-500 sm:mt-4 sm:grid-cols-4 dark:text-stone-400">
                                                <ProductFact label="日常价" value={formatMoney(product.amountCents, product.currency)} />
                                                <ProductFact label={product.productKind === "points" ? "充值余额（元）" : "永久余额（元）"} value={`¥${product.pointsAmount}`} />
                                                <ProductFact label="每日赠送余额（元）" value={product.productKind === "plan" ? `¥${product.dailyPoints}` : "-"} />
                                                <ProductFact label="周期" value={product.productKind === "plan" ? (product.periodDays ? `${product.periodDays} 天` : "长期") : "一次性"} />
                                            </div>
                                            <div className="mt-3 flex justify-end gap-2 border-t border-stone-200 pt-2.5 sm:mt-4 sm:pt-3 dark:border-stone-800">
                                                <Button size="small" icon={<Pencil className="size-3.5" />} onClick={() => editProduct(product)}>
                                                    编辑
                                                </Button>
                                                <Button danger size="small" icon={<Trash2 className="size-3.5" />} loading={deletingProductId === product.id} onClick={() => confirmDeleteProduct(product)}>
                                                    删除
                                                </Button>
                                            </div>
                                        </article>
                                    ))
                                ) : (
                                    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-stone-200 px-3 py-6 text-center text-sm text-stone-500 sm:gap-3 sm:py-10 md:col-span-2 dark:border-stone-800 dark:text-stone-400">
                                        <span>暂无套餐商品</span>
                                    </div>
                                )}
                            </div>
                        </div>
                    </section>
                    <Modal
                        title={editingProductId ? "编辑商品" : "创建商品"}
                        open={productModalOpen}
                        width={760}
                        centered
                        destroyOnHidden
                        onCancel={closeProductModal}
                        styles={{ body: { maxHeight: "min(68dvh, 640px)", overflowY: "auto", paddingTop: 8 } }}
                        footer={[
                            <Button key="cancel" onClick={closeProductModal} disabled={productSaving}>
                                取消
                            </Button>,
                            <Button key="save" type="primary" icon={<Save className="size-4" />} loading={productSaving} onClick={() => productForm.submit()}>
                                保存商品
                            </Button>,
                        ]}
                    >
                        <Form form={productForm} layout="vertical" initialValues={defaultProductFormValue(products.length + 1)} onFinish={(value) => void saveProduct(value)}>
                            <div className="mb-4 rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm leading-6 text-stone-500 dark:border-stone-800 dark:bg-stone-900/50 dark:text-stone-400">
                                保存后会立即影响充值中心展示。余额充值只增加永久人民币余额；套餐可同时配置有效期内的每日赠送余额。
                            </div>
                            <Form.Item name="id" hidden>
                                <Input />
                            </Form.Item>
                            <Form.Item name="name" label="商品名称" rules={[{ required: true, message: "请填写商品名称" }]}>
                                <Input maxLength={80} placeholder="例如：创作者版月卡" />
                            </Form.Item>
                            <Form.Item name="description" label="商品描述">
                                <Input.TextArea rows={3} maxLength={500} placeholder="展示给用户看的套餐说明" />
                            </Form.Item>
                            <Form.Item name="productKind" label="商品类型" rules={[{ required: true, message: "请选择商品类型" }]}>
                                <Segmented
                                    block
                                    options={[
                                        { label: "套餐权益", value: "plan" },
                                        { label: "余额充值", value: "points" },
                                    ]}
                                />
                            </Form.Item>
                            <div className="grid gap-3 sm:grid-cols-2">
                                {productKind === "plan" ? (
                                    <Form.Item name="planId" label="关联套餐" rules={[{ required: true, message: "请填写套餐 ID" }]}>
                                        <Input maxLength={80} placeholder="creator / pro" />
                                    </Form.Item>
                                ) : null}
                                <Form.Item name="currency" label="币种" rules={[{ required: true, message: "请填写币种" }]}>
                                    <Input maxLength={8} placeholder="CNY" />
                                </Form.Item>
                                <Form.Item name="amountYuan" label="价格" rules={[{ required: true, message: "请填写价格" }]}>
                                    <InputNumber min={0} precision={2} className="w-full" prefix="¥" />
                                </Form.Item>
                                <Form.Item name="pointsAmount" label="一次性永久余额（元）" rules={[{ required: true, message: "请填写永久余额" }]} extra="支付成功后一次性加入人民币余额，不会按日过期。">
                                    <InputNumber min={0} precision={8} prefix="¥" className="w-full" />
                                </Form.Item>
                                {productKind === "plan" ? (
                                    <>
                                        <Form.Item name="dailyPoints" label="每日赠送余额（元）" rules={[{ required: true, message: "请填写每日赠送余额" }]} extra="套餐有效期内每天自动补充，仅当日有效，不会跨日累积。">
                                            <InputNumber min={0} precision={8} prefix="¥" className="w-full" />
                                        </Form.Item>
                                        <Form.Item name="periodDays" label="生效天数" rules={[{ required: true, message: "请填写天数" }]}>
                                            <InputNumber min={1} precision={0} className="w-full" />
                                        </Form.Item>
                                    </>
                                ) : null}
                                <Form.Item name="sortOrder" label="排序">
                                    <InputNumber min={0} precision={0} className="w-full" />
                                </Form.Item>
                            </div>
                            <Form.Item name="enabled" label="上架状态" valuePropName="checked">
                                <Switch checkedChildren="上架" unCheckedChildren="下架" />
                            </Form.Item>
                        </Form>
                    </Modal>
                </>
            ) : null}

            {allowedTabs.includes(activeTab) && activeTab === "promotions" ? <PromotionCampaignPanel products={products} productsLoading={productsLoading} /> : null}

            {allowedTabs.includes(activeTab) && activeTab === "coupons" ? <CouponTemplatePanel products={products} productsLoading={productsLoading} /> : null}

            {allowedTabs.includes(activeTab) && activeTab === "payments" ? (
                <PaymentConfigPanel paymentConfig={paymentConfig} loading={paymentConfigLoading} embedded={embedded} onRefresh={loadPaymentConfig} onCopy={(value) => void copyText(value, message)} />
            ) : null}
        </div>
    );
}
