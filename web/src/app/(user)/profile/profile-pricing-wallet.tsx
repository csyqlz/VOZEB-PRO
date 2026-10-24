"use client";

import { useEffect, useState } from "react";
import { Button, Pagination, Select, Tag } from "antd";
import { RefreshCw } from "lucide-react";
import { formatCreditAmount } from "@/constant/credits";
import { getPricingWallet, type PricingWalletFilter, type PricingWalletView } from "@/services/api/points";
import { useUserStore } from "@/stores/use-user-store";
import { AccountPanel, formatTime, LoadingBlock, profileSecondaryButtonClass, RECORD_PAGE_SIZE } from "./profile-elements";

const amount = (value: string) => formatCreditAmount(Number(value));
const stages: Record<string, string> = { reserved: "已预留", submitting: "等待结果", submitted: "生成中", outcome_unknown: "待核对", response_received: "待结算", not_charged: "待退回", settled: "已结算", released: "已释放" };

export function ProfilePricingWallet({ refreshVersion }: { refreshVersion: number }) {
    const user = useUserStore((state) => state.user);
    const [status, setStatus] = useState<PricingWalletFilter>();
    const [page, setPage] = useState(1);
    const [revision, setRevision] = useState(0);
    const [result, setResult] = useState<{ key: string; data?: PricingWalletView; error?: string }>();
    const key = JSON.stringify([user?.id, user?.pointsBalance, status, page, revision, refreshVersion]);
    const data = result?.key === key ? result.data : undefined;
    const error = result?.key === key ? result.error : undefined;
    const loading = result?.key !== key;
    useEffect(() => {
        if (!user?.id) return;
        const controller = new AbortController();
        void getPricingWallet({ page, pageSize: RECORD_PAGE_SIZE, status }, controller.signal)
            .then((data) => {
                if (!controller.signal.aborted) setResult({ key, data });
            })
            .catch((error: unknown) => {
                if (!controller.signal.aborted) setResult({ key, error: error instanceof Error ? error.message : "计费记录加载失败" });
            });
        return () => controller.abort();
    }, [key, page, status, user?.id]);

    return (
        <AccountPanel
            title="按量计费"
            description="预留积分暂不可用，完成后按实际用量结算；已结算消费同时记入下方积分流水。"
            action={
                <Button className={profileSecondaryButtonClass} icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => setRevision((value) => value + 1)}>
                    刷新计费记录
                </Button>
            }
        >
            <div data-testid="pricing-wallet" className="min-w-0 space-y-3">
                <div className="w-full sm:w-44">
                    <Select
                        aria-label="计费状态"
                        className="w-full"
                        value={status || "all"}
                        onChange={(value) => {
                            setStatus(value === "all" ? undefined : (value as PricingWalletFilter));
                            setPage(1);
                        }}
                        options={[
                            { value: "all", label: "全部状态" },
                            { value: "reserved", label: "待结算" },
                            { value: "settled", label: "已结算" },
                            { value: "released", label: "已释放" },
                        ]}
                    />
                </div>
                {loading ? (
                    <LoadingBlock />
                ) : error ? (
                    <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                        {error}
                    </p>
                ) : data ? (
                    <>
                        <div className="grid grid-cols-2 gap-3 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                            <div>
                                <div className="text-xs text-stone-500 dark:text-stone-400">当前可用积分</div>
                                <strong data-testid="pricing-available" className="block break-all text-lg">
                                    {amount(data.summary.availablePoints)}
                                </strong>
                                <div className="text-xs text-stone-500 dark:text-stone-400">
                                    日赠 {amount(data.summary.dailyPoints)} · 永久 {amount(data.summary.permanentPoints)}
                                </div>
                            </div>
                            <div>
                                <div className="text-xs text-stone-500 dark:text-stone-400">待结算预留 · {data.summary.pendingCount} 笔</div>
                                <strong data-testid="pricing-held" className="block break-all text-lg">
                                    {amount(data.summary.pendingPoints)}
                                </strong>
                            </div>
                        </div>
                        {Number(data.summary.debtPoints) > 0 ? (
                            <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200">
                                待补扣 {amount(data.summary.debtPoints)} 积分；补足前暂停付费调用，充值积分会自动抵扣。
                            </p>
                        ) : null}
                        {Number(data.summary.inactiveDailyPoints) > 0 ? <p className="text-xs text-amber-700 dark:text-amber-300">预留中有 {amount(data.summary.inactiveDailyPoints)} 日赠积分所属额度已失效，结算后未使用的部分不会转为可用余额。</p> : null}
                        {data.items.length ? (
                            <div className="divide-y divide-stone-200 dark:divide-stone-800">
                                {data.items.map((item) => (
                                    <div key={item.id} data-pricing-status={item.status} className="min-w-0 space-y-2 py-3">
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="min-w-0">
                                                <div className="break-all text-sm font-semibold">{item.modelId}</div>
                                                <div className="text-xs text-stone-500 dark:text-stone-400">{formatTime(item.createdAt)}</div>
                                            </div>
                                            <Tag className="m-0 shrink-0" color={item.status === "reserved" ? "orange" : item.status === "settled" ? "green" : "blue"}>
                                                {stages[item.stage]}
                                            </Tag>
                                        </div>
                                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                                            <span>初始预留 {amount(item.heldPoints)}</span>
                                            {item.chargedPoints !== undefined ? (
                                                <span>
                                                    {item.unpaidAtSettlement !== undefined ? "本次应收" : "实际扣除"} {amount(item.chargedPoints)}
                                                </span>
                                            ) : null}
                                            {Number(item.unpaidAtSettlement) > 0 ? <span>结算时待补扣 {amount(item.unpaidAtSettlement || "0")}</span> : null}
                                            {item.restoredPoints !== undefined ? <span>未用退回 {amount(item.restoredPoints)}</span> : null}
                                            {Number(item.refundedPoints) > 0 ? <span>退款到账 {amount(item.refundedPoints)}</span> : null}
                                        </div>
                                        {Number(item.expiredPoints || 0) + Number(item.expiredRefundPoints) > 0 ? (
                                            <p className="text-xs text-amber-700 dark:text-amber-300">
                                                未用日赠失效 {amount(item.expiredPoints || "0")} · 退款日赠失效 {amount(item.expiredRefundPoints)}
                                            </p>
                                        ) : null}
                                        {item.calculation ? (
                                            <details className="text-xs text-stone-600 dark:text-stone-300">
                                                <summary className="cursor-pointer rounded py-1 font-medium text-stone-900 hover:bg-stone-100 focus-visible:outline focus-visible:outline-2 dark:text-stone-100 dark:hover:bg-stone-800">计费明细</summary>
                                                <div className="mt-2 space-y-2 break-words [overflow-wrap:anywhere]">
                                                    <p>
                                                        {item.calculation.manufacturer} · {item.calculation.officialModel}
                                                    </p>
                                                    <p>适用条件：{item.calculation.conditions}</p>
                                                    <ul className="space-y-1">
                                                        {item.calculation.lines.map((line) => (
                                                            <li key={line.key}>
                                                                {line.key}：用量 {line.quantity} {line.unit} ÷ {line.per} × 单价 {line.price} {line.currency} = {line.officialAmount} {line.currency}
                                                            </li>
                                                        ))}
                                                    </ul>
                                                    <p>
                                                        业务汇率：1 USD = {item.calculation.cnyPerUsd} CNY · {item.calculation.pointsPerCny} 积分/CNY · 售价系数 {item.calculation.coefficient}
                                                    </p>
                                                    {item.calculation.currencies
                                                        .filter((currency) => !["USD", "CNY"].includes(currency.currency))
                                                        .map((currency) => (
                                                            <p key={currency.currency}>
                                                                {currency.currency} 兑美元换算系数 {currency.usdPerCurrency}
                                                            </p>
                                                        ))}
                                                    <p>
                                                        本次计算积分约 {item.calculation.calculatedPoints}；实际扣除 {amount(item.chargedPoints!)}。小额尾差按原积分来源累计，实际扣分可能与单次四舍五入不同。
                                                    </p>
                                                    <p>
                                                        官方价版本 {item.calculation.officialVersionId} · 售价版本 {item.calculation.salesVersionId}
                                                    </p>
                                                    <a className="underline underline-offset-2 hover:opacity-80" href={item.calculation.sourceUrl} target="_blank" rel="noreferrer">
                                                        查看官方价格来源
                                                    </a>
                                                </div>
                                            </details>
                                        ) : null}
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <p className="py-2 text-sm text-stone-500 dark:text-stone-400">暂无按量计费记录，固定积分消费请查看积分流水。</p>
                        )}
                        {data.total > RECORD_PAGE_SIZE ? <Pagination size="small" current={page} pageSize={RECORD_PAGE_SIZE} total={data.total} showSizeChanger={false} onChange={setPage} /> : null}
                    </>
                ) : null}
            </div>
        </AccountPanel>
    );
}
