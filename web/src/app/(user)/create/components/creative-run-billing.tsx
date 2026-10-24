"use client";

import { Popover } from "antd";
import { useEffect, useRef, useState } from "react";

import { formatCreditAmount } from "@/constant/credits";
import { getCreativeAgentRunBilling, type CreativeRunBillingSummary } from "@/services/api/creative";

const typeLabels = { text: "文本", image: "图片", video: "视频", audio: "音频" };
const purposeLabels = { generation: "生成", planning: "规划", review: "复盘" };

export function CreativeRunBilling({ runId, modelNames }: { runId?: string; modelNames: ReadonlyMap<string, string> }) {
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [summary, setSummary] = useState<CreativeRunBillingSummary | null>(null);
    const [error, setError] = useState("");
    const requestId = useRef(0);

    useEffect(
        () => () => {
            requestId.current += 1;
        },
        [runId],
    );

    if (!runId) return null;

    const onOpenChange = (next: boolean) => {
        setOpen(next);
        const current = ++requestId.current;
        if (!next) return;
        setLoading(true);
        setSummary(null);
        setError("");
        void getCreativeAgentRunBilling(runId)
            .then((value) => {
                if (requestId.current === current) setSummary(value);
            })
            .catch((cause) => {
                if (requestId.current === current) setError(cause instanceof Error ? cause.message : "费用读取失败");
            })
            .finally(() => {
                if (requestId.current === current) setLoading(false);
            });
    };

    return (
        <Popover
            trigger="click"
            placement="bottomLeft"
            arrow={false}
            open={open}
            onOpenChange={onOpenChange}
            content={
                <div className="max-h-[min(360px,60vh)] w-[min(340px,calc(100vw-48px))] overflow-y-auto py-1 text-xs text-[#344054] dark:text-[#d5dae0]">
                    <p className="mb-3 text-sm font-semibold text-[#20242a] dark:text-[#f3f5f7]">本轮费用</p>
                    {loading ? (
                        <p role="status">正在读取费用…</p>
                    ) : error ? (
                        <p role="alert" className="text-red-600 dark:text-red-300">
                            {error}
                        </p>
                    ) : summary ? (
                        <CreativeRunBillingDetails summary={summary} modelNames={modelNames} />
                    ) : null}
                </div>
            }
        >
            <button
                type="button"
                className="mt-1.5 inline-flex min-h-7 items-center rounded-md border border-[#e2e5eb] bg-white px-2 text-xs font-medium text-[#475467] transition-colors hover:border-[#a9a4ff] hover:text-[#514bdf] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#615cff]/40 dark:border-[#414853] dark:bg-[#242a32] dark:text-[#d5dae0] dark:hover:border-[#807aff] dark:hover:text-white"
                aria-label="查看本轮费用"
            >
                费用
            </button>
        </Popover>
    );
}

export function CreativeRunBillingDetails({ summary, modelNames }: { summary: CreativeRunBillingSummary; modelNames: ReadonlyMap<string, string> }) {
    const modelLabel = (id?: string) => (id ? modelNames.get(id) || id : "模型未记录");
    return (
        <div className="space-y-3">
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-lg bg-[#f6f7fa] p-3 dark:bg-[#272d36]">
                <dt>已结净额</dt>
                <dd className="text-right font-semibold">{formatCreditAmount(summary.actualPoints)} 积分</dd>
                <dt>已扣</dt>
                <dd className="text-right">{formatCreditAmount(summary.chargedPoints)} 积分</dd>
                <dt>已退</dt>
                <dd className="text-right">{formatCreditAmount(summary.refundedPoints)} 积分</dd>
            </dl>
            {summary.charges.length ? (
                <div>
                    <p className="mb-1 font-semibold">已结明细</p>
                    <ul className="space-y-2">
                        {summary.charges.map((item, index) => (
                            <li key={`${item.type}:${item.purpose}:${item.logicalModelId || ""}:${index}`} className="border-t border-[#e9ecf0] pt-2 dark:border-[#414853]">
                                <div className="flex justify-between gap-3">
                                    <span className="min-w-0 break-words">
                                        {modelLabel(item.logicalModelId)} · {typeLabels[item.type]}
                                        {purposeLabels[item.purpose]}
                                    </span>
                                    <strong className="shrink-0 font-medium">{formatCreditAmount(item.actualPoints)} 积分</strong>
                                </div>
                                {item.refundedPoints > 0 ? (
                                    <p className="mt-0.5 text-[#667085] dark:text-[#a0a9b4]">
                                        已扣 {formatCreditAmount(item.chargedPoints)} · 已退 {formatCreditAmount(item.refundedPoints)}
                                    </p>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                </div>
            ) : null}
            {summary.pending.length ? (
                <div className="border-t border-[#e9ecf0] pt-2 dark:border-[#414853]">
                    <div className="mb-1 flex justify-between gap-3 font-semibold">
                        <span>未结预留</span>
                        <span>{formatCreditAmount(summary.pendingHeldPoints)} 积分</span>
                    </div>
                    <ul className="space-y-1">
                        {summary.pending.map((item, index) => (
                            <li key={`${item.type}:${item.logicalModelId}:${index}`} className="flex justify-between gap-3">
                                <span className="min-w-0 break-words">
                                    {modelLabel(item.logicalModelId)} · {typeLabels[item.type]} × {item.count}
                                </span>
                                <span className="shrink-0">{formatCreditAmount(item.heldPoints)} 积分</span>
                            </li>
                        ))}
                    </ul>
                    <p className="mt-1 text-[#667085] dark:text-[#a0a9b4]">预留未计入已结净额，结算后以实际扣退为准。</p>
                </div>
            ) : null}
            {!summary.charges.length && !summary.pending.length ? <p className="text-[#667085] dark:text-[#a0a9b4]">暂无可归属的账务记录</p> : null}
        </div>
    );
}
