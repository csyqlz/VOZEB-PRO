"use client";

import { Button, Segmented, Tooltip } from "antd";
import { Activity, ArrowRight, CalendarDays, CircleHelp, CreditCard, PlugZap, RefreshCw, UsersRound } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";

import { AdminCommerceConversionPanel } from "@/components/admin/admin-commerce-conversion-panel";
import { generationKindLabel, generationSourceLabel } from "@/components/admin/admin-generation-log";
import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import { formatAdminMoney } from "@/components/admin/admin-values";
import type { AdminBillingSummary } from "@/lib/admin-billing-types";
import type { AdminGenerationOverviewSummary } from "@/lib/admin-generation-overview";
import type { SystemModelChannel } from "@/lib/auth/store";
import type { GenerationAssetStats, StoredGenerationLog } from "@/lib/server/generation-log-store";

type OverviewStats = { total: number; active: number; admins: number };
type SettingsSummary = { totalChannels: number; enabledChannels: number };
type WalletSummary = { enabledPlans: number; usersWithPlan: number };
type DistributionItem = { label: string; value: number; percent: number };
type OperationsSummary = AdminGenerationOverviewSummary;
type AnalysisMode = "trend" | "kind";
type AdminOverviewProps = {
    stats: OverviewStats;
    settingsSummary: SettingsSummary;
    walletSummary: WalletSummary;
    billingSummary: AdminBillingSummary | null;
    operationsSummary: OperationsSummary;
    promptCount: number;
    assetStats: GenerationAssetStats | null;
    enabledProducts: number;
    billingLoading: boolean;
    loading: boolean;
    onRefreshBilling: () => Promise<void>;
    onRefresh: () => void;
};

export function AdminOverview({ stats, settingsSummary, walletSummary, billingSummary, operationsSummary, promptCount, assetStats, enabledProducts, billingLoading, loading, onRefreshBilling, onRefresh }: AdminOverviewProps) {
    const [analysisMode, setAnalysisMode] = useState<AnalysisMode>("trend");
    const orders = billingSummary?.orders;
    const paidOrderRate = percentage(orders?.paid || 0, orders?.total || 0);
    const activeUserRate = percentage(stats.active, stats.total);
    const todayCalls = operationsSummary.dailyCalls.at(-1)?.value || 0;

    return (
        <div className="space-y-3 sm:space-y-5">
            <section className="grid min-w-0 grid-cols-2 gap-3 sm:gap-5 xl:grid-cols-4" aria-label="经营核心指标">
                <AnalysisMetricCard
                    title="实收金额"
                    tooltip="累计已支付订单的实际入账金额"
                    value={formatAdminMoney(orders?.paidAmountCents || 0)}
                    detail={(orders?.paid || 0) + " 笔已支付订单"}
                    footer={<MetricFooter left={"支付转化 " + paidOrderRate + "%"} right={"待支付 " + formatAdminMoney(orders?.pendingAmountCents || 0)} />}
                >
                    <MiniBars
                        tone="amber"
                        items={[
                            { label: "订单总额", value: orders?.grossAmountCents || 0 },
                            { label: "实收金额", value: orders?.paidAmountCents || 0 },
                            { label: "退款金额", value: orders?.refundedAmountCents || 0 },
                        ]}
                    />
                </AnalysisMetricCard>
                <AnalysisMetricCard
                    title="用户运营"
                    tooltip="当前平台账号总量与可用账号比例"
                    value={formatCompactNumber(stats.total)}
                    detail={stats.active + " 个可用账号 · " + stats.admins + " 位管理员"}
                    footer={<MetricFooter left={"可用率 " + activeUserRate + "%"} right={walletSummary.usersWithPlan + " 个套餐用户"} />}
                >
                    <AccountStructure active={stats.active} disabled={Math.max(0, stats.total - stats.active)} />
                </AnalysisMetricCard>
                <AnalysisMetricCard
                    title="今日调用"
                    tooltip={"统计近 " + operationsSummary.windowDays + " 日生成调用"}
                    value={formatCompactNumber(todayCalls)}
                    detail={"近 " + operationsSummary.windowDays + " 日共 " + formatCompactNumber(operationsSummary.totalCalls) + " 次"}
                    footer={<MetricFooter left={operationsSummary.activeUsers + " 个活跃用户"} right={settingsSummary.enabledChannels + " 个可用渠道"} />}
                >
                    <MiniBars items={operationsSummary.dailyCalls} tone="cyan" />
                </AnalysisMetricCard>
                <AnalysisMetricCard
                    title="调用成功率"
                    tooltip="成功生成调用占全部生成调用的比例"
                    value={operationsSummary.successRate + "%"}
                    detail={formatCompactNumber(operationsSummary.successCalls) + " 次成功 · " + formatCompactNumber(operationsSummary.failedCalls) + " 次失败"}
                    footer={<MetricFooter left={"总调用 " + formatCompactNumber(operationsSummary.totalCalls)} right={"模型 " + operationsSummary.modelDistribution.length + " 个"} />}
                >
                    <ProgressBar value={operationsSummary.successRate} tone="blue" />
                </AnalysisMetricCard>
            </section>

            <AnalysisPanel operationsSummary={operationsSummary} mode={analysisMode} loading={loading} onModeChange={setAnalysisMode} onRefresh={onRefresh} />
            <QuickActionsPanel />
            <AdminCommerceConversionPanel billingSummary={billingSummary} billingLoading={billingLoading} onRefreshBilling={onRefreshBilling} />
            <Panel>
                <PanelHeader title="运营资源" description="账号、商品、内容与媒体资源" />
                <div className="admin-resource-grid grid grid-cols-2 lg:grid-cols-4">
                    <ResourceStat label="管理员" value={stats.admins + " 人"} detail={stats.active + " 个可用账号"} />
                    <ResourceStat label="上架商品" value={enabledProducts + " 个"} detail={walletSummary.enabledPlans + " 个在售套餐"} />
                    <ResourceStat label="提示词" value={promptCount + " 条"} detail={walletSummary.usersWithPlan + " 个套餐用户"} />
                    <ResourceStat label="本地资源" value={assetStats ? assetStats.totalFiles + " 个" : "-"} detail={assetStats ? formatBytes(assetStats.totalBytes) + " · " + assetStats.missingReferences + " 个异常" : "等待统计"} />
                </div>
            </Panel>
        </div>
    );
}

function AnalysisMetricCard({ title, tooltip, value, detail, children, footer }: { title: string; tooltip: string; value: string; detail: string; children: ReactNode; footer: ReactNode }) {
    return (
        <article className="admin-analysis-metric-card admin-panel-surface min-w-0 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex h-12 items-center justify-between border-b border-zinc-100 px-3.5 sm:px-5 dark:border-zinc-800">
                <h2 className="truncate text-xs font-semibold text-zinc-800 sm:text-sm dark:text-zinc-100">{title}</h2>
                <Tooltip title={tooltip}>
                    <span className="grid size-6 shrink-0 place-items-center text-zinc-400" aria-label={tooltip}>
                        <CircleHelp className="size-3.5" />
                    </span>
                </Tooltip>
            </div>
            <div className="min-w-0 px-3.5 py-3 sm:px-5 sm:py-4">
                <div className="truncate text-xl font-semibold tabular-nums text-zinc-950 sm:text-2xl dark:text-zinc-50">{value}</div>
                <div className="mt-1 truncate text-[10px] text-zinc-500 sm:text-xs dark:text-zinc-400">{detail}</div>
                <div className="mt-3 min-h-10">{children}</div>
                <div className="mt-3 border-t border-zinc-100 pt-2.5 dark:border-zinc-800">{footer}</div>
            </div>
        </article>
    );
}

function ProgressBar({ value, tone }: { value: number; tone: "blue" | "emerald" | "amber" }) {
    const color = tone === "blue" ? "bg-blue-500 dark:bg-blue-400" : tone === "emerald" ? "bg-emerald-500 dark:bg-emerald-400" : "bg-amber-500 dark:bg-amber-400";
    return (
        <div className="flex h-10 items-center">
            <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                <span className={"block h-full rounded-full " + color} style={{ width: clampPercent(value) + "%" }} />
            </div>
        </div>
    );
}

function MiniBars({ items, tone }: { items: Array<{ label: string; value: number }>; tone: "amber" | "cyan" }) {
    const max = Math.max(1, ...items.map((item) => item.value));
    const color = tone === "amber" ? "bg-amber-500 hover:bg-amber-600 dark:bg-amber-400 dark:hover:bg-amber-300" : "bg-cyan-500 hover:bg-cyan-600 dark:bg-cyan-400 dark:hover:bg-cyan-300";
    return (
        <div className="flex h-10 items-end gap-1.5" aria-label="近期调用微柱图">
            {items.map((item) => (
                <span key={item.label} className={"min-w-1 flex-1 rounded-t-sm transition-colors " + color} style={{ height: item.value ? Math.max(12, (item.value / max) * 100) + "%" : "2px" }} title={item.label + "：" + item.value} />
            ))}
        </div>
    );
}

function AccountStructure({ active, disabled }: { active: number; disabled: number }) {
    const total = active + disabled;
    const activeWidth = total ? (active / total) * 100 : 0;
    const disabledWidth = total ? (disabled / total) * 100 : 0;
    return (
        <div className="flex h-10 flex-col justify-center gap-2">
            <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                {activeWidth ? <span className="h-full bg-emerald-500 dark:bg-emerald-400" style={{ width: activeWidth + "%" }} /> : null}
                {disabledWidth ? <span className="h-full bg-zinc-300 dark:bg-zinc-600" style={{ width: disabledWidth + "%" }} /> : null}
            </div>
            <div className="flex items-center gap-3 text-[9px] text-zinc-500 sm:text-[10px] dark:text-zinc-400">
                <span className="inline-flex items-center gap-1">
                    <i className="size-1.5 rounded-full bg-emerald-500" />
                    可用 {active}
                </span>
                <span className="inline-flex items-center gap-1">
                    <i className="size-1.5 rounded-full bg-zinc-300 dark:bg-zinc-600" />
                    停用 {disabled}
                </span>
            </div>
        </div>
    );
}

function MetricFooter({ left, right }: { left: string; right: string }) {
    return (
        <div className="flex min-w-0 items-center justify-between gap-2 text-[9px] text-zinc-500 sm:text-[11px] dark:text-zinc-400">
            <span className="truncate">{left}</span>
            <span className="truncate text-right">{right}</span>
        </div>
    );
}

function AnalysisPanel({ operationsSummary, mode, loading, onModeChange, onRefresh }: { operationsSummary: OperationsSummary; mode: AnalysisMode; loading: boolean; onModeChange: (mode: AnalysisMode) => void; onRefresh: () => void }) {
    const chartItems = mode === "trend" ? operationsSummary.dailyCalls : operationsSummary.kindDistribution;
    return (
        <div data-admin-analysis-panel>
            <Panel>
                <div className="flex min-w-0 flex-col gap-3 border-b border-zinc-200 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5 dark:border-zinc-800">
                    <div className="min-w-0 overflow-x-auto">
                        <Segmented
                            value={mode}
                            onChange={onModeChange}
                            options={[
                                { label: "调用趋势", value: "trend" },
                                { label: "生成类型", value: "kind" },
                            ]}
                        />
                    </div>
                    <div className="flex items-center justify-between gap-2 sm:justify-end">
                        <span className="inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-200 bg-zinc-50 px-2.5 text-[11px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                            <CalendarDays className="size-3.5" />近 {operationsSummary.windowDays} 日
                        </span>
                        <Button size="small" loading={loading} icon={<RefreshCw className="size-3.5" />} onClick={onRefresh}>
                            刷新
                        </Button>
                    </div>
                </div>
                <div className="grid min-w-0 xl:grid-cols-[minmax(0,1fr)_320px]">
                    <div className="min-w-0 px-3 py-4 sm:px-5 sm:py-5">
                        <div className="mb-4 flex min-w-0 items-end justify-between gap-3">
                            <div className="min-w-0">
                                <h2 className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{mode === "trend" ? "调用量" : "生成类型分布"}</h2>
                                <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">{mode === "trend" ? "按日统计平台真实生成调用" : "按图片、视频、音频与文本任务统计"}</p>
                            </div>
                            <div className="shrink-0 text-right">
                                <div className="text-[10px] text-zinc-400">合计</div>
                                <div className="mt-0.5 text-base font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{formatCompactNumber(chartItems.reduce((sum, item) => sum + item.value, 0))}</div>
                            </div>
                        </div>
                        <BarChart items={chartItems} />
                    </div>
                    <ModelRankingList items={operationsSummary.modelDistribution} operationsSummary={operationsSummary} />
                </div>
            </Panel>
        </div>
    );
}

function BarChart({ items }: { items: Array<{ label: string; value: number }> }) {
    const max = Math.max(1, ...items.map((item) => item.value));
    if (!items.length) return <div className="grid min-h-56 place-items-center text-sm text-zinc-400">暂无可分析数据</div>;
    return (
        <div className="relative min-w-0">
            <div className="pointer-events-none absolute inset-x-0 top-0 h-56 sm:h-64">
                {[0, 1, 2, 3, 4].map((line) => (
                    <span key={line} className="absolute inset-x-0 border-t border-zinc-100 dark:border-zinc-800" style={{ top: line * 25 + "%" }} />
                ))}
            </div>
            <div className="relative grid h-56 min-w-0 items-end gap-2 sm:h-64 sm:gap-3" style={{ gridTemplateColumns: "repeat(" + items.length + ", minmax(0, 1fr))" }}>
                {items.map((item) => (
                    <div key={item.label} className="flex h-full min-w-0 flex-col items-center justify-end">
                        <span className="mb-1.5 text-[9px] font-medium tabular-nums text-zinc-500 sm:text-[10px] dark:text-zinc-400">{formatCompactNumber(item.value)}</span>
                        <span
                            data-admin-analysis-bar
                            className="w-full max-w-16 rounded-t-sm bg-blue-500 transition-colors hover:bg-blue-600 dark:bg-blue-400 dark:hover:bg-blue-300"
                            style={{ height: item.value ? Math.max(4, (item.value / max) * 82) + "%" : "2px" }}
                            title={item.label + "：" + item.value}
                        />
                        <span className="mt-2 w-full truncate text-center text-[9px] text-zinc-400 sm:text-[11px]" title={item.label}>
                            {item.label}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}

function ModelRankingList({ items, operationsSummary }: { items: DistributionItem[]; operationsSummary: OperationsSummary }) {
    const displayItems = items.slice(0, 7);
    return (
        <aside className="min-w-0 border-t border-zinc-200 px-4 py-4 sm:px-5 xl:border-l xl:border-t-0 dark:border-zinc-800" aria-label="模型调用排行">
            <div className="mb-3">
                <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">模型调用排行</h2>
                <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">近 {operationsSummary.windowDays} 日真实调用</p>
            </div>
            <div className="min-h-52">
                {displayItems.length ? (
                    displayItems.map((item, index) => (
                        <div key={item.label} className="grid grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-2 border-b border-zinc-100 py-2.5 last:border-b-0 dark:border-zinc-800/80">
                            <span
                                className={
                                    "grid size-5 place-items-center rounded-full text-[10px] font-semibold " + (index < 3 ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-950" : "bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400")
                                }
                            >
                                {index + 1}
                            </span>
                            <span className="min-w-0 truncate text-xs text-zinc-700 dark:text-zinc-200">{item.label}</span>
                            <span className="tabular-nums text-xs font-medium text-zinc-950 dark:text-zinc-100">{formatCompactNumber(item.value)}</span>
                        </div>
                    ))
                ) : (
                    <div className="grid min-h-52 place-items-center text-sm text-zinc-400">暂无调用记录</div>
                )}
            </div>
            <div className="grid grid-cols-3 divide-x divide-zinc-100 border-t border-zinc-100 pt-3 text-center dark:divide-zinc-800 dark:border-zinc-800">
                <RankingStat label="成功" value={operationsSummary.successCalls} />
                <RankingStat label="失败" value={operationsSummary.failedCalls} />
                <RankingStat label="活跃用户" value={operationsSummary.activeUsers} />
            </div>
        </aside>
    );
}

const quickActions = [
    { href: "/admin?section=users", label: "用户运营", detail: "账号、角色与套餐", icon: <UsersRound className="size-4" />, tone: "bg-emerald-50 text-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-300" },
    { href: "/admin?section=channels", label: "模型渠道", detail: "上游接口与模型", icon: <PlugZap className="size-4" />, tone: "bg-blue-50 text-blue-600 dark:bg-blue-950/50 dark:text-blue-300" },
    { href: "/admin?section=products", label: "套餐管理", detail: "商品、价格与权益", icon: <CreditCard className="size-4" />, tone: "bg-amber-50 text-amber-600 dark:bg-amber-950/50 dark:text-amber-300" },
    { href: "/admin?section=generationOperations", label: "生成运维", detail: "任务状态与排障", icon: <Activity className="size-4" />, tone: "bg-cyan-50 text-cyan-600 dark:bg-cyan-950/50 dark:text-cyan-300" },
] as const;

function QuickActionsPanel() {
    return (
        <Panel>
            <PanelHeader title="常用操作" description="高频经营与系统入口" />
            <div className="grid min-w-0 sm:grid-cols-2 xl:grid-cols-4">
                {quickActions.map((action) => (
                    <Link
                        key={action.href}
                        href={action.href}
                        className="group flex min-w-0 items-center gap-3 border-b border-zinc-100 px-4 py-3.5 transition hover:bg-zinc-50 sm:[&:nth-child(odd)]:border-r xl:border-b-0 xl:border-r xl:last:border-r-0 dark:border-zinc-800 dark:hover:bg-zinc-900/70"
                    >
                        <span className={"grid size-9 shrink-0 place-items-center rounded-md " + action.tone}>{action.icon}</span>
                        <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-medium text-zinc-800 dark:text-zinc-200">{action.label}</span>
                            <span className="mt-0.5 block truncate text-[10px] text-zinc-400 dark:text-zinc-500">{action.detail}</span>
                        </span>
                        <ArrowRight className="size-3.5 shrink-0 text-zinc-300 transition group-hover:translate-x-0.5 group-hover:text-zinc-500 dark:text-zinc-700 dark:group-hover:text-zinc-400" />
                    </Link>
                ))}
            </div>
        </Panel>
    );
}

function RankingStat({ label, value }: { label: string; value: number }) {
    return (
        <div>
            <div className="text-[10px] text-zinc-400">{label}</div>
            <div className="mt-1 text-sm font-semibold tabular-nums text-zinc-800 dark:text-zinc-200">{formatCompactNumber(value)}</div>
        </div>
    );
}

function ResourceStat({ label, value, detail }: { label: string; value: string; detail: string }) {
    return (
        <div className="admin-resource-stat min-w-0 p-2.5 sm:p-5">
            <div className="text-[10px] font-medium text-zinc-500 sm:text-[11px] dark:text-zinc-400">{label}</div>
            <div className="mt-1 truncate text-base font-semibold tabular-nums text-zinc-950 sm:mt-2 sm:text-lg dark:text-zinc-100">{value}</div>
            <div className="mt-0.5 truncate text-[10px] text-zinc-400 sm:mt-1 sm:text-[11px] dark:text-zinc-500">{detail}</div>
        </div>
    );
}

export function buildOperationsSummary(logs: StoredGenerationLog[], channels: SystemModelChannel[]) {
    const totalCalls = logs.length;
    const successCalls = logs.filter((log) => log.status === "success").length;
    const failedCalls = logs.filter((log) => log.status === "failed").length;
    const activeUsers = new Set(logs.map((log) => log.userId).filter(Boolean)).size;
    const today = new Date();
    const dayItems = Array.from({ length: 7 }).map((_, offset) => {
        const date = new Date(today);
        date.setDate(today.getDate() - (6 - offset));
        const key = date.toISOString().slice(0, 10);
        const label = date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
        return { key, label, value: 0 };
    });
    const dayMap = new Map(dayItems.map((item) => [item.key, item]));
    for (const log of logs) {
        const key = new Date(log.createdAt).toISOString().slice(0, 10);
        const item = dayMap.get(key);
        if (item) item.value += 1;
    }
    const knownModels = new Set(channels.flatMap((channel) => channel.models));
    const modelDistribution = distributionFromValues(
        logs.map((log) => log.model || "未记录模型"),
        (value) => (knownModels.has(value) ? value : value || "未记录模型"),
    );
    const sourceDistribution = distributionFromValues(logs.map((log) => generationSourceLabel(log.source)));
    const kindDistribution = distributionFromValues(logs.map((log) => generationKindLabel(log.kind)));
    return {
        totalCalls,
        successCalls,
        failedCalls,
        activeUsers,
        successRate: totalCalls ? Math.round((successCalls / totalCalls) * 100) : 0,
        dailyCalls: dayItems.map(({ label, value }) => ({ label, value })),
        modelDistribution,
        sourceDistribution,
        kindDistribution,
    };
}

function distributionFromValues(values: string[], normalize: (value: string) => string = (value) => value) {
    const counts = new Map<string, number>();
    for (const value of values) {
        const label = normalize(value).trim() || "未记录";
        counts.set(label, (counts.get(label) || 0) + 1);
    }
    const total = Array.from(counts.values()).reduce((sum, value) => sum + value, 0);
    return Array.from(counts.entries())
        .map(([label, value]) => ({ label, value, percent: total ? Math.round((value / total) * 100) : 0 }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 6);
}

function formatCompactNumber(value: number) {
    const numberValue = Number(value || 0);
    if (numberValue >= 100000000) return trimFixed(numberValue / 100000000, 2) + "亿";
    if (numberValue >= 10000) return trimFixed(numberValue / 10000, 1) + "万";
    return String(numberValue);
}

function trimFixed(value: number, digits: number) {
    return value
        .toFixed(digits)
        .replace(/\.0+$/, "")
        .replace(/(\.\d*[1-9])0+$/, "$1");
}

function percentage(value: number, total: number) {
    return total > 0 ? Math.round((value / total) * 100) : 0;
}

function clampPercent(value: number) {
    return Math.min(100, Math.max(0, value));
}

function formatBytes(value: number) {
    if (!value) return "0 B";
    const units = ["B", "KB", "MB", "GB"] as const;
    let size = value;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex += 1;
    }
    return (size >= 10 || unitIndex === 0 ? size.toFixed(0) : size.toFixed(1)) + " " + units[unitIndex];
}
