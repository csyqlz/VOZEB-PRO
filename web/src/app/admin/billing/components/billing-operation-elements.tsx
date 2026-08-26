"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { App, Button, DatePicker, Form, Input, InputNumber, Modal, Select, Segmented, Space, Switch, Table, Tag } from "antd";
import type { TableColumnsType } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { AlertTriangle, CheckCircle2, CircleDollarSign, Copy, CreditCard, FileText, FileUp, Landmark, Package, Plus, QrCode, ReceiptText, RefreshCw, Save, Search, Settings2, Undo2, WalletCards, XCircle } from "lucide-react";

import { DEFAULT_ALIPAY_PAYMENT_MODE, getAlipayPaymentModePresentation, type PaymentConfigRequirement, type PaymentConfigSummary, type PaymentProviderConfig, type PaymentProviderConfigField } from "@/lib/payment-config-types";
import type { AdminBillingSummary as BillingSummary } from "@/lib/admin-billing-types";
import type { BillingOrder, BillingOrderStatus, BillingProduct } from "@/services/api/billing";
import { BillingReconciliationImport } from "./billing-reconciliation-import";

export function ReconciliationPanel({ reconciliationIssues, summary, onImport }: { reconciliationIssues: number; summary: BillingSummary | null; onImport: () => void }) {
    return (
        <div className="rounded-lg border border-stone-200 bg-stone-50/70 p-4 dark:border-stone-800 dark:bg-stone-900/40">
            <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-stone-950 dark:text-stone-100">对账检查</div>
                <Tag color={reconciliationIssues ? "red" : "green"}>{reconciliationIssues ? "需处理" : "正常"}</Tag>
            </div>
            <div className="mt-3 space-y-2 text-sm text-stone-600 dark:text-stone-300">
                <CheckLine label="已支付但缺少成功流水" value={summary?.reconciliation.paidOrdersWithoutSucceededPayment || 0} />
                <CheckLine label="成功流水未对应已支付订单" value={summary?.reconciliation.succeededPaymentsWithoutPaidOrder || 0} />
                <CheckLine label="流水金额与订单金额不一致" value={summary?.reconciliation.amountMismatchPayments || 0} />
            </div>
            <div className="mt-4 border-t border-stone-200 pt-3 dark:border-stone-800">
                <Button className="w-full" icon={<FileUp className="size-4" />} onClick={onImport}>
                    导入支付商账单
                </Button>
            </div>
        </div>
    );
}

export function ActiveProductsPanel({ activeProducts }: { activeProducts: BillingProduct[] }) {
    return (
        <div className="rounded-lg border border-stone-200 bg-stone-50/70 p-4 dark:border-stone-800 dark:bg-stone-900/40">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-stone-950 dark:text-stone-100">
                <Package className="size-4" />
                在售商品
            </div>
            <div className="space-y-2">
                {activeProducts.length ? (
                    activeProducts.map((product) => (
                        <div key={product.id} className="rounded-md border border-stone-200 bg-white p-3 dark:border-stone-800 dark:bg-stone-950">
                            <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                    <div className="truncate text-sm font-medium text-stone-950 dark:text-stone-100">{product.name}</div>
                                    <div className="mt-1 line-clamp-2 text-xs leading-5 text-stone-500 dark:text-stone-400">{product.description || product.planId}</div>
                                </div>
                                <Tag color="green">{formatMoney(product.amountCents, product.currency)}</Tag>
                            </div>
                            <div className="mt-2 text-xs text-stone-500 dark:text-stone-400">
                                ¥{product.pointsAmount} 余额 / {product.periodDays ? `${product.periodDays} 天` : "长期"}
                            </div>
                        </div>
                    ))
                ) : (
                    <div className="rounded-md border border-dashed border-stone-200 px-3 py-6 text-center text-sm text-stone-500 dark:border-stone-800 dark:text-stone-400">暂无在售商品</div>
                )}
            </div>
        </div>
    );
}

export function ProductFact({ label, value }: { label: string; value: string }) {
    return (
        <div className="min-w-0 rounded-md bg-white px-2 py-2 ring-1 ring-stone-200 dark:bg-stone-950 dark:ring-stone-800">
            <div>{label}</div>
            <div className="mt-1 truncate font-semibold text-stone-950 dark:text-stone-100">{value}</div>
        </div>
    );
}

export function PaymentConfigPanel({ paymentConfig, loading, embedded, onRefresh, onCopy }: { paymentConfig: PaymentConfigSummary | null; loading: boolean; embedded?: boolean; onRefresh: () => Promise<void> | void; onCopy: (value: string) => void }) {
    const { message } = App.useApp();
    const [form] = Form.useForm<Record<string, string | boolean>>();
    const providers = paymentConfig?.providers || [];
    const [activeProviderId, setActiveProviderId] = useState<PaymentProviderConfig["id"]>("stripe");
    const [saving, setSaving] = useState(false);
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const activeProvider = providers.find((provider) => provider.id === activeProviderId) || providers[0];
    const enabled = Form.useWatch("enabled", form);
    const alipayMode = Form.useWatch("mode", form);

    useEffect(() => {
        if (providers.length && !providers.some((provider) => provider.id === activeProviderId)) setActiveProviderId(providers[0].id);
    }, [activeProviderId, providers]);

    useEffect(() => {
        if (!activeProvider) return;
        const values: Record<string, string | boolean> = { enabled: activeProvider.enabled };
        for (const field of activeProvider.fields) values[field.key] = field.secret ? "" : field.value || "";
        form.setFieldsValue(values);
        setAdvancedOpen(false);
    }, [activeProvider, form]);

    const saveProviderConfig = async () => {
        if (!activeProvider) return;
        const value = await form.validateFields();
        const fieldValues = Object.fromEntries(activeProvider.fields.map((field) => [field.key, normalizePaymentFormValue(value[field.key])]));
        setSaving(true);
        try {
            const response = await fetch("/api/admin/billing/payment-config", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ providerId: activeProvider.id, enabled: value.enabled === true, values: fieldValues }),
            });
            const payload = (await response.json().catch(() => null)) as { error?: string } | null;
            if (!response.ok) throw new Error(payload?.error || "保存支付配置失败");
            message.success("支付配置已保存");
            await onRefresh();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存支付配置失败");
        } finally {
            setSaving(false);
        }
    };

    const routeFieldKeys = ["notifyUrl", "returnUrl", "cancelUrl", "successUrl"];
    const mainFields = activeProvider?.fields.filter((field) => !field.advanced && !routeFieldKeys.includes(field.key)) || [];
    const selectedAlipayMode = activeProvider?.id === "alipay" ? normalizePaymentFormValue(alipayMode || activeProvider.fields.find((field) => field.key === "mode")?.value || DEFAULT_ALIPAY_PAYMENT_MODE) : "";
    const isAlipayFaceToFace = selectedAlipayMode === "face_to_face";
    const alipayPresentation = getAlipayPaymentModePresentation(selectedAlipayMode);
    const routeFields = activeProvider?.fields.filter((field) => routeFieldKeys.includes(field.key) && !(isAlipayFaceToFace && field.key === "returnUrl")) || [];
    const advancedFields = activeProvider?.fields.filter((field) => field.advanced && !routeFieldKeys.includes(field.key)) || [];
    const sortedMainFields = sortPaymentFields(mainFields);
    const sortedRouteFields = sortPaymentFields(routeFields);
    const sortedAdvancedFields = sortPaymentFields(advancedFields);
    const formEnabled = enabled === undefined ? activeProvider?.enabled === true : enabled === true;
    const requiredFields = activeProvider?.fields.filter((field) => field.required) || [];
    const requiredReady = requiredFields.filter((field) => field.configured).length;

    return (
        <>
            <section
                className={
                    embedded
                        ? "overflow-hidden rounded-3xl border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-950"
                        : "overflow-hidden rounded-3xl border border-stone-200 bg-white shadow-sm shadow-stone-200/40 dark:border-stone-800 dark:bg-stone-950 dark:shadow-black/20"
                }
            >
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1.5 border-b border-stone-200 px-3 py-3 sm:flex sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:px-5 sm:py-5 dark:border-stone-800">
                    <div className="contents sm:block sm:min-w-0">
                        <h2 className="min-w-0 truncate text-base font-semibold tracking-normal text-stone-950 sm:text-xl dark:text-stone-100">支付渠道配置</h2>
                        <div className="col-span-2 line-clamp-2 text-xs leading-5 text-stone-500 sm:mt-1 sm:block sm:text-sm sm:leading-6 dark:text-stone-400">每个渠道独立保存。下单接口、密钥、回调验签、返回地址和字段映射都可以在这里配置。</div>
                    </div>
                    <div className="col-start-2 row-start-1 flex flex-wrap items-center justify-end gap-1.5 sm:gap-2">
                        <Tag className="m-0 hidden sm:inline-flex">{paymentConfig?.readyProviders || 0} 个真实支付可用</Tag>
                        <Button aria-label="刷新支付状态" title="刷新支付状态" icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void onRefresh()}>
                            <span className="hidden sm:inline">刷新状态</span>
                        </Button>
                    </div>
                </div>
                <div className="grid gap-3 bg-stone-50/70 p-3 sm:gap-5 sm:p-5 xl:grid-cols-[300px_minmax(0,1fr)] dark:bg-stone-950/45">
                    <aside className="space-y-3">
                        <div className="rounded-xl border border-stone-200/80 bg-white p-2.5 sm:rounded-3xl sm:p-3 dark:border-stone-800 dark:bg-stone-900/60">
                            <div className="px-2 pb-2 text-xs font-semibold uppercase tracking-[0.14em] text-stone-400">支付渠道</div>
                            <div className="grid grid-cols-2 gap-1.5 sm:block sm:space-y-2">
                                {providers.map((provider) => (
                                    <PaymentProviderCard key={provider.id} provider={provider} active={provider.id === activeProvider?.id} onSelect={() => setActiveProviderId(provider.id)} />
                                ))}
                                {!providers.length ? <div className="rounded-xl border border-dashed border-stone-200 px-3 py-10 text-center text-sm text-stone-500 dark:border-stone-800 dark:text-stone-400">支付配置状态加载中</div> : null}
                            </div>
                        </div>
                    </aside>
                    {activeProvider ? (
                        <Form form={form} layout="vertical" onFinish={() => void saveProviderConfig()} className="min-w-0">
                            <Form.Item name="enabled" valuePropName="checked" hidden>
                                <Switch />
                            </Form.Item>
                            <div className="min-w-0 overflow-hidden rounded-3xl border border-stone-200/80 bg-white dark:border-stone-800 dark:bg-stone-950">
                                <div className="border-b border-stone-200/80 px-3 py-3 sm:px-5 sm:py-5 dark:border-stone-800">
                                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                                        <div className="min-w-0">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <h3 className="text-xl font-semibold tracking-normal text-stone-950 sm:text-2xl dark:text-stone-100">{activeProvider.name}</h3>
                                                <Tag className="m-0" color={activeProvider.ready ? "green" : activeProvider.checkoutReady ? "gold" : "default"}>
                                                    {activeProvider.ready ? "可用" : activeProvider.checkoutReady ? "待回调" : "待配置"}
                                                </Tag>
                                                <Tag className="m-0">{activeProvider.sourceLabel}</Tag>
                                            </div>
                                            <div className="mt-1 line-clamp-2 max-w-3xl text-xs leading-5 text-stone-500 sm:mt-2 sm:line-clamp-none sm:text-sm sm:leading-6 dark:text-stone-400">
                                                {activeProvider.id === "alipay" ? alipayPresentation?.description || activeProvider.description : activeProvider.description}
                                            </div>
                                            <div className="mt-3 flex flex-wrap gap-2 text-xs text-stone-500 dark:text-stone-400">
                                                <span className="rounded-full bg-stone-100 px-2.5 py-1 ring-1 ring-stone-200 dark:bg-stone-900 dark:ring-stone-800">
                                                    必填 {requiredReady}/{requiredFields.length}
                                                </span>
                                                <span className="rounded-full bg-stone-100 px-2.5 py-1 ring-1 ring-stone-200 dark:bg-stone-900 dark:ring-stone-800">下单：{activeProvider.checkoutReady ? "已配置" : "待配置"}</span>
                                                <span className="rounded-full bg-stone-100 px-2.5 py-1 ring-1 ring-stone-200 dark:bg-stone-900 dark:ring-stone-800">
                                                    回调：{activeProvider.webhookOptional ? "可选" : activeProvider.webhookReady ? "已配置" : "待配置"}
                                                </span>
                                            </div>
                                        </div>
                                        <div className="flex shrink-0 flex-wrap items-center gap-3">
                                            <Switch disabled={activeProvider.id === "manual"} checked={formEnabled} checkedChildren="启用" unCheckedChildren="关闭" onChange={(checked) => form.setFieldValue("enabled", checked)} />
                                            <Button type="primary" htmlType="submit" icon={<Save className="size-4" />} loading={saving} className="!text-white">
                                                保存
                                            </Button>
                                        </div>
                                    </div>
                                </div>
                                <div className="border-b border-stone-200/80 bg-stone-50/65 px-3 py-3 sm:px-5 sm:py-4 dark:border-stone-800 dark:bg-stone-900/35">
                                    <div className="rounded-xl border border-stone-200/80 bg-white p-3 sm:rounded-2xl sm:p-4 dark:border-stone-800 dark:bg-stone-950">
                                        <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-center">
                                            <div className="flex shrink-0 items-center gap-2 text-sm font-semibold text-stone-950 dark:text-stone-100">
                                                <Copy className="size-4 text-stone-500 dark:text-stone-400" />
                                                系统回调地址
                                            </div>
                                            <div className="min-w-0 flex-1 truncate rounded-xl bg-stone-50 px-3 py-2 font-mono text-xs leading-5 text-stone-700 ring-1 ring-stone-200 dark:bg-stone-900 dark:text-stone-200 dark:ring-stone-800">
                                                {activeProvider.webhookUrl}
                                            </div>
                                            <Button className="!h-9 shrink-0 justify-center" size="small" icon={<Copy className="size-3.5" />} onClick={() => onCopy(activeProvider.webhookUrl)}>
                                                复制
                                            </Button>
                                        </div>
                                        <div className="mt-4 border-t border-stone-200/80 pt-4 dark:border-stone-800">
                                            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-stone-950 dark:text-stone-100">
                                                <Settings2 className="size-4" />
                                                必填检查
                                            </div>
                                            <RequirementGrid checkout={activeProvider.checkoutRequirements} webhook={activeProvider.webhookRequirements} webhookOptional={activeProvider.webhookOptional} />
                                        </div>
                                    </div>
                                </div>
                                <div className="space-y-3 p-3 sm:space-y-5 sm:p-5">
                                    <PaymentFieldSection title="基础配置" description="这里是启用该渠道最常用的字段，包含下单地址、商户号、接口密钥和请求方式。">
                                        {sortedMainFields.map((field) => (
                                            <PaymentConfigFieldControl key={field.key} field={field} providerEnabled={formEnabled} />
                                        ))}
                                    </PaymentFieldSection>
                                    {routeFields.length ? (
                                        <PaymentFieldSection
                                            title={isAlipayFaceToFace ? "异步回调" : "回调与返回"}
                                            description={isAlipayFaceToFace ? "当面付自动使用本站异步通知地址，不需要同步返回地址；只有需要自定义通知域名时才填写。" : "这些地址默认使用当前网站的系统地址，无需填写；只有需要改成其他域名或页面时才覆盖。"}
                                        >
                                            {sortedRouteFields.map((field) => (
                                                <PaymentConfigFieldControl key={field.key} field={field} providerEnabled={formEnabled} />
                                            ))}
                                        </PaymentFieldSection>
                                    ) : null}
                                    {advancedFields.length ? (
                                        <div className="rounded-3xl border border-stone-200/80 bg-stone-50/70 p-4 dark:border-stone-800 dark:bg-stone-900/45">
                                            <button
                                                type="button"
                                                className="flex w-full items-center justify-between gap-3 rounded-2xl px-1 py-1 text-left transition hover:text-stone-950 dark:hover:text-stone-100"
                                                onClick={() => setAdvancedOpen((value) => !value)}
                                            >
                                                <span>
                                                    <span className="block text-base font-semibold text-stone-950 dark:text-stone-100">高级字段映射</span>
                                                    <span className="mt-1 block text-xs leading-5 text-stone-500 dark:text-stone-400">支付商字段映射、额外请求头、请求体模板和高级回调设置，不确定时可以先保持为空。</span>
                                                </span>
                                                <Tag className="m-0">{advancedOpen ? "收起" : `${advancedFields.length} 项`}</Tag>
                                            </button>
                                            {advancedOpen ? (
                                                <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-3">
                                                    {sortedAdvancedFields.map((field) => (
                                                        <PaymentConfigFieldControl key={field.key} field={field} providerEnabled={formEnabled} />
                                                    ))}
                                                </div>
                                            ) : null}
                                        </div>
                                    ) : null}
                                </div>
                                <div className="mx-5 mb-5 flex flex-col-reverse gap-3 border-t border-stone-200/80 pt-4 sm:flex-row sm:items-center sm:justify-between dark:border-stone-800">
                                    <div className="text-xs leading-5 text-stone-500 dark:text-stone-400">密钥留空表示保留原值；需要清空密钥时请关闭该渠道或覆盖保存新的值。</div>
                                    <Button type="primary" htmlType="submit" icon={<Save className="size-4" />} loading={saving} className="!text-white">
                                        保存支付配置
                                    </Button>
                                </div>
                            </div>
                        </Form>
                    ) : null}
                </div>
            </section>
        </>
    );
}

export function PaymentProviderCard({ provider, active, onSelect }: { provider: PaymentProviderConfig; active: boolean; onSelect: () => void }) {
    const Icon = providerIcon(provider.id);
    return (
        <button
            type="button"
            className={`w-full rounded-lg border p-2 text-left transition sm:rounded-2xl sm:p-3 ${active ? "border-stone-400 bg-white shadow-sm dark:border-stone-600 dark:bg-stone-950" : "border-transparent bg-transparent hover:bg-white/80 dark:hover:bg-stone-950/70"}`}
            onClick={onSelect}
        >
            <div className="flex items-start gap-2 sm:gap-3">
                <span
                    className={`flex size-7 shrink-0 items-center justify-center rounded-md ring-1 [&>svg]:size-3.5 sm:size-10 sm:rounded-xl sm:[&>svg]:size-5 ${active ? "bg-stone-950 text-white ring-stone-950 dark:bg-white dark:text-stone-950 dark:ring-white" : "bg-white text-stone-700 ring-stone-200 dark:bg-stone-950 dark:text-stone-200 dark:ring-stone-800"}`}
                >
                    <Icon />
                </span>
                <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                            <div className="truncate text-xs font-semibold text-stone-950 sm:text-sm dark:text-stone-100">{provider.name}</div>
                            <div className="mt-1 hidden truncate text-xs text-stone-500 sm:block dark:text-stone-400">{provider.sourceLabel}</div>
                        </div>
                        <Tag className="m-0 shrink-0 !px-1 !text-[10px] sm:!px-[7px] sm:!text-xs" color={provider.ready ? "green" : provider.checkoutReady ? "gold" : "default"}>
                            {provider.ready ? "可用" : provider.checkoutReady ? "待回调" : "待配置"}
                        </Tag>
                    </div>
                    <div className="mt-2 grid grid-cols-3 gap-1 sm:mt-3 sm:gap-1.5">
                        <span className={`h-1.5 rounded-full ${provider.enabled ? "bg-stone-950 dark:bg-white" : "bg-stone-200 dark:bg-stone-800"}`} />
                        <span className={`h-1.5 rounded-full ${provider.checkoutReady ? "bg-stone-950 dark:bg-white" : "bg-stone-200 dark:bg-stone-800"}`} />
                        <span className={`h-1.5 rounded-full ${provider.webhookReady || provider.webhookOptional ? "bg-stone-950 dark:bg-white" : "bg-stone-200 dark:bg-stone-800"}`} />
                    </div>
                </div>
            </div>
        </button>
    );
}

export function PaymentFieldSection({ title, description, children }: { title: string; description: string; children: ReactNode }) {
    return (
        <div className="rounded-xl border border-stone-200/80 bg-stone-50/70 p-3 sm:rounded-3xl sm:p-4 dark:border-stone-800 dark:bg-stone-900/45">
            <div className="mb-3 min-w-0">
                <div className="text-base font-semibold text-stone-950 dark:text-stone-100">{title}</div>
                <div className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">{description}</div>
            </div>
            <div className="grid items-start gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,230px),1fr))]">{children}</div>
        </div>
    );
}

export function sortPaymentFields<T extends PaymentProviderConfigField>(fields: T[]) {
    return [...fields].sort((left, right) => Number(isWidePaymentField(left)) - Number(isWidePaymentField(right)));
}

export function isWidePaymentField(field: PaymentProviderConfigField) {
    const key = field.key.toLowerCase();
    return field.kind === "textarea" || key.includes("template") || key.includes("headers") || key.includes("privatekey") || key.includes("publickey") || key.includes("certificate");
}

export function PaymentConfigFieldControl({ field, providerEnabled }: { field: PaymentProviderConfigField & { configured: boolean; value?: string; sourceLabel: string }; providerEnabled: boolean }) {
    const rules = [
        {
            validator: (_: unknown, value: unknown) => {
                if (!providerEnabled || !field.required || field.configured || normalizePaymentFormValue(value)) return Promise.resolve();
                return Promise.reject(new Error(`请填写${field.label}`));
            },
        },
    ];
    const wide = isWidePaymentField(field);
    const usesSystemDefault = paymentFieldUsesSystemDefault(field);
    const inputClassName = "admin-payment-compact-control w-full";
    return (
        <div className={`min-w-0 self-start rounded-2xl border border-stone-200/80 bg-white shadow-sm shadow-stone-200/20 dark:border-stone-800 dark:bg-stone-950 dark:shadow-black/10 ${wide ? "p-3 md:col-span-full" : "p-3"}`}>
            <PaymentFieldHeader field={field} />
            <Form.Item name={field.key} rules={rules} className="m-0 !mt-2.5">
                {field.key === "mode" && field.options?.length === 2 ? (
                    <Segmented block className="admin-payment-mode-segmented" options={field.options} />
                ) : field.kind === "select" ? (
                    <Select className={inputClassName} options={field.options || []} placeholder={field.placeholder} />
                ) : field.kind === "textarea" ? (
                    <Input.TextArea className="admin-payment-textarea" rows={field.secret ? 5 : 4} maxLength={20_000} placeholder={field.configured && field.secret ? "已配置，留空不修改" : field.placeholder} />
                ) : field.kind === "secret" ? (
                    <Input.Password className={inputClassName} autoComplete="new-password" placeholder={field.configured ? "已配置，留空不修改" : field.placeholder} />
                ) : (
                    <Input className={inputClassName} maxLength={2000} placeholder={field.placeholder} />
                )}
            </Form.Item>
            {field.note || usesSystemDefault ? <div className="mt-2.5 text-xs leading-5 text-stone-500 dark:text-stone-400">{field.note || "留空时自动使用系统默认值，仅在需要自定义时填写。"}</div> : null}
        </div>
    );
}

export function PaymentFieldHeader({ field }: { field: PaymentProviderConfigField & { configured: boolean; sourceLabel: string } }) {
    const usesSystemDefault = paymentFieldUsesSystemDefault(field);
    return (
        <div className="flex min-w-0 items-center justify-between gap-2">
            <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold leading-5 text-stone-950 dark:text-stone-100">{field.label}</div>
                {field.configured || usesSystemDefault ? <div className="mt-0.5 text-xs text-stone-400 dark:text-stone-500">{field.configured ? field.sourceLabel : "留空自动使用"}</div> : null}
            </div>
            <div className="flex shrink-0 flex-wrap justify-end gap-1">
                {field.required ? <Tag className="m-0">必填</Tag> : null}
                <Tag className="m-0" color={field.configured ? "green" : usesSystemDefault ? "blue" : "default"}>
                    {field.configured ? "已配置" : usesSystemDefault ? "系统默认" : "未配置"}
                </Tag>
            </div>
        </div>
    );
}

function paymentFieldUsesSystemDefault(field: PaymentProviderConfigField & { configured: boolean }) {
    return !field.configured && !field.required && /^默认(?:\s|$)/.test(field.placeholder || "");
}

export function RequirementGrid({ checkout, webhook, webhookOptional }: { checkout: PaymentConfigRequirement[]; webhook: PaymentConfigRequirement[]; webhookOptional?: boolean }) {
    const items = [...checkout.map((item) => ({ ...item, group: "下单" })), ...webhook.map((item) => ({ ...item, group: "回调" }))];
    if (!items.length) {
        return <div className="rounded-md border border-dashed border-stone-200 px-3 py-3 text-sm text-stone-500 dark:border-stone-800 dark:text-stone-400">{webhookOptional ? "该渠道无需强制回调配置" : "暂无必填变量"}</div>;
    }
    return (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,180px),1fr))] gap-2">
            {items.map((item) => (
                <div key={`${item.group}:${item.label}:${item.envNames.join(",")}`} className="min-w-0 rounded-xl border border-stone-200 bg-white px-3 py-2 dark:border-stone-800 dark:bg-stone-950">
                    <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-xs text-stone-500 dark:text-stone-400">{item.group}</span>
                        <Tag className="m-0" color={item.configured ? "green" : "gold"}>
                            {item.configured ? "已设置" : "待设置"}
                        </Tag>
                    </div>
                    <div className="mt-1 truncate text-sm font-semibold text-stone-950 dark:text-stone-100">{item.label}</div>
                </div>
            ))}
        </div>
    );
}

export function providerIcon(provider: PaymentProviderConfig["id"]) {
    if (provider === "stripe") return CreditCard;
    if (provider === "alipay") return Landmark;
    if (provider === "wechat") return QrCode;
    if (provider === "payply") return WalletCards;
    return FileText;
}

export function normalizePaymentFormValue(value: unknown) {
    return typeof value === "string" ? value.trim() : value === null || value === undefined ? "" : String(value).trim();
}

export async function copyText(value: string, message: { success: (content: string) => void; error: (content: string) => void }) {
    try {
        await navigator.clipboard.writeText(value);
        message.success("已复制");
    } catch {
        message.error("复制失败");
    }
}

export function Metric({ title, value, icon, tone }: { title: string; value: string | number; icon: ReactNode; tone: "emerald" | "amber" | "blue" | "rose" | "slate" }) {
    return (
        <div className="rounded-lg border border-stone-200 bg-white p-3 shadow-sm shadow-stone-200/40 sm:p-4 dark:border-stone-800 dark:bg-stone-950 dark:shadow-black/20">
            <div className="flex items-center justify-between gap-2 sm:gap-3">
                <div className="text-xs text-stone-500 sm:text-sm dark:text-stone-400">{title}</div>
                <span className={`flex size-7 items-center justify-center rounded-md [&>svg]:size-3.5 sm:size-8 sm:[&>svg]:size-4 ${metricTone(tone)}`}>{icon}</span>
            </div>
            <div className="mt-2 text-lg font-semibold tracking-normal text-stone-950 sm:mt-3 sm:text-2xl dark:text-stone-100">{value}</div>
        </div>
    );
}

export function CheckLine({ label, value }: { label: string; value: number }) {
    return (
        <div className="flex items-center justify-between gap-3">
            <span>{label}</span>
            <span className={value ? "font-semibold text-rose-600 dark:text-rose-300" : "font-semibold text-emerald-600 dark:text-emerald-300"}>{value}</span>
        </div>
    );
}

export function metricTone(tone: "emerald" | "amber" | "blue" | "rose" | "slate") {
    if (tone === "emerald") return "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-200";
    if (tone === "amber") return "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-200";
    if (tone === "blue") return "bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-200";
    if (tone === "rose") return "bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-200";
    return "bg-stone-100 text-stone-700 dark:bg-stone-900 dark:text-stone-200";
}

export function statusLabel(status: BillingOrderStatus) {
    if (status === "pending") return "待支付";
    if (status === "paid") return "已支付";
    if (status === "refunding") return "退款处理中";
    if (status === "closed") return "已关闭";
    if (status === "canceled") return "已取消";
    return "已退款";
}

export function statusColor(status: BillingOrderStatus) {
    if (status === "pending") return "gold";
    if (status === "paid") return "green";
    if (status === "refunded") return "red";
    if (status === "refunding") return "orange";
    return "default";
}

export function providerLabel(value: string) {
    if (value === "stripe") return "Stripe";
    if (value === "alipay") return "支付宝";
    if (value === "wechat") return "微信支付";
    if (value === "payply") return "PayPly";
    if (value === "manual") return "人工确认";
    return value || "-";
}

export function formatMoney(cents: number, currency = "CNY") {
    const amount = (Number(cents || 0) / 100).toFixed(2);
    return currency === "CNY" ? `¥${amount}` : `${currency} ${amount}`;
}

export function formatTime(value?: string) {
    if (!value) return "-";
    const date = dayjs(value);
    return date.isValid() ? date.format("YYYY-MM-DD HH:mm") : "-";
}
