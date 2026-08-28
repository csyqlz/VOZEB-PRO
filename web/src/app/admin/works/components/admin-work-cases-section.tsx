"use client";

import { App, Button, Input, Modal, Pagination, Select, Tag } from "antd";
import { Check, Eye, RefreshCw, Search, ShieldAlert, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { AdminAccountId } from "@/components/admin/admin-user-identity";
import { listAdminWorkCases, resolveAdminWorkCase, type WorkGovernanceCase, type WorkGovernanceCaseStatus, type WorkGovernanceCaseType } from "@/services/api/work-governance";

const PAGE_SIZE = 12;

export function AdminWorkCasesSection() {
    const { message } = App.useApp();
    const requestIdRef = useRef(0);
    const [items, setItems] = useState<WorkGovernanceCase[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [caseType, setCaseType] = useState<WorkGovernanceCaseType | "all">("all");
    const [status, setStatus] = useState<WorkGovernanceCaseStatus | "all">("open");
    const [keyword, setKeyword] = useState("");
    const [debouncedKeyword, setDebouncedKeyword] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [action, setAction] = useState<{ item: WorkGovernanceCase; decision: "approved" | "rejected" }>();
    const [resolution, setResolution] = useState("");

    useEffect(() => {
        const timer = window.setTimeout(() => setDebouncedKeyword(keyword.trim()), 300);
        return () => window.clearTimeout(timer);
    }, [keyword]);

    const load = useCallback(async () => {
        const requestId = ++requestIdRef.current;
        setLoading(true);
        setError("");
        try {
            const result = await listAdminWorkCases({ page, pageSize: PAGE_SIZE, caseType: caseType === "all" ? undefined : caseType, status: status === "all" ? undefined : status, keyword: debouncedKeyword || undefined });
            if (requestId !== requestIdRef.current) return;
            setItems(result.items);
            setTotal(result.total);
        } catch (loadError) {
            if (requestId !== requestIdRef.current) return;
            setItems([]);
            setTotal(0);
            setError(loadError instanceof Error ? loadError.message : "举报申诉列表加载失败");
        } finally {
            if (requestId === requestIdRef.current) setLoading(false);
        }
    }, [caseType, debouncedKeyword, page, status]);

    useEffect(() => {
        void load();
    }, [load]);

    const submitResolution = async () => {
        if (!action || resolution.trim().length < 5) return message.warning("请至少填写 5 个字的处理说明");
        try {
            await resolveAdminWorkCase(action.item.id, { decision: action.decision, resolution: resolution.trim() });
            message.success(actionResultLabel(action.item.caseType, action.decision));
            setAction(undefined);
            setResolution("");
            await load();
        } catch (resolveError) {
            message.error(resolveError instanceof Error ? resolveError.message : "处理失败");
        }
    };

    return (
        <>
            <div className="admin-panel-surface min-w-0 space-y-4 overflow-hidden rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950 sm:p-4">
                <div className="grid min-w-0 grid-cols-2 gap-2 border-b border-zinc-200 pb-4 lg:grid-cols-[136px_136px_minmax(280px,380px)_auto] lg:items-center lg:justify-start dark:border-zinc-800">
                    <div className="min-w-0 lg:w-36 lg:shrink-0">
                        <Select
                            className="w-full"
                            value={caseType}
                            options={[
                                { value: "all", label: "全部类型" },
                                { value: "report", label: "作品举报" },
                                { value: "appeal", label: "下架申诉" },
                            ]}
                            onChange={(value) => {
                                setCaseType(value);
                                setPage(1);
                            }}
                        />
                    </div>
                    <div className="min-w-0 lg:w-36 lg:shrink-0">
                        <Select
                            className="w-full"
                            value={status}
                            options={[
                                { value: "open", label: "待处理" },
                                { value: "approved", label: "已确认" },
                                { value: "rejected", label: "已驳回" },
                                { value: "all", label: "全部状态" },
                            ]}
                            onChange={(value) => {
                                setStatus(value);
                                setPage(1);
                            }}
                        />
                    </div>
                    <div className="col-span-2 min-w-0 lg:col-span-1">
                        <Input
                            className="w-full"
                            allowClear
                            prefix={<Search className="size-4 text-zinc-400" />}
                            placeholder="搜索作品标题、作者、提交人、用户 ID 或作品链接"
                            value={keyword}
                            onChange={(event) => {
                                setKeyword(event.target.value);
                                setPage(1);
                            }}
                        />
                    </div>
                    <Button className="col-span-2 w-full lg:col-span-1 lg:w-auto" icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void load()}>
                        刷新
                    </Button>
                </div>

                {error ? (
                    <div className="grid min-h-40 place-items-center border-y border-rose-200 px-4 text-center text-sm text-rose-700 dark:border-rose-900/60 dark:text-rose-300">{error}</div>
                ) : loading && !items.length ? (
                    <div className="grid min-h-40 place-items-center text-sm text-zinc-500 dark:text-zinc-400">正在加载举报申诉...</div>
                ) : items.length ? (
                    <div className="grid min-w-0 gap-2.5">
                        {items.map((item) => (
                            <GovernanceCaseItem
                                key={item.id}
                                item={item}
                                onResolve={(decision) => {
                                    setResolution("");
                                    setAction({ item, decision });
                                }}
                            />
                        ))}
                    </div>
                ) : (
                    <div className="flex min-h-44 flex-col items-center justify-center gap-2 border-y border-dashed border-zinc-300 px-4 text-center dark:border-zinc-700">
                        <ShieldAlert className="size-5 text-zinc-400" />
                        <div className="text-sm font-medium text-zinc-800 dark:text-zinc-200">当前筛选下没有治理案件</div>
                        <div className="text-xs text-zinc-500 dark:text-zinc-400">新的举报和申诉会显示在这里。</div>
                    </div>
                )}

                {total > PAGE_SIZE ? <Pagination current={page} pageSize={PAGE_SIZE} total={total} showSizeChanger={false} size="small" onChange={setPage} /> : null}
            </div>
            <Modal
                title={action ? actionModalTitle(action.item.caseType, action.decision) : "处理治理案件"}
                open={Boolean(action)}
                okText="确认处理"
                cancelText="取消"
                okButtonProps={{ danger: action?.item.caseType === "report" && action.decision === "approved", disabled: resolution.trim().length < 5 }}
                onOk={() => void submitResolution()}
                onCancel={() => setAction(undefined)}
            >
                <p className="mb-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">处理说明会作为案件证据保存。确认举报将只下架被举报的同一线上版本；通过申诉会恢复目标下架版本。</p>
                <Input.TextArea value={resolution} rows={5} maxLength={1000} showCount placeholder="填写核验结论、依据和后续处理说明" onChange={(event) => setResolution(event.target.value)} />
            </Modal>
        </>
    );
}

function GovernanceCaseItem({ item, onResolve }: { item: WorkGovernanceCase; onResolve: (decision: "approved" | "rejected") => void }) {
    return (
        <article className="min-w-0 rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950 sm:p-4">
            <div className="flex min-w-0 items-start gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-md bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950">
                    <ShieldAlert className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <h3 className="max-w-full truncate text-sm font-semibold text-zinc-950 dark:text-zinc-100">{item.title || item.slug}</h3>
                        <Tag color={item.caseType === "report" ? "warning" : "processing"} className="m-0">
                            {item.caseType === "report" ? "作品举报" : "下架申诉"}
                        </Tag>
                        <Tag color={caseStatusColor(item.status)} className="m-0">
                            {caseStatusLabel(item.status)}
                        </Tag>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-zinc-700 dark:text-zinc-300">{item.description}</p>
                    <div className="mt-2 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-500 dark:text-zinc-400 sm:text-xs">
                        <span>类型：{caseCategoryLabel(item.category)}</span>
                        <span className="inline-flex min-w-0 items-center gap-1.5">
                            提交人：{item.submitterDisplayName || item.submitterUsername || "用户信息不可用"}
                            <AdminAccountId accountId={item.submitterAccountId} />
                        </span>
                        <span className="inline-flex min-w-0 items-center gap-1.5">
                            作者：{item.ownerDisplayName || item.ownerUsername || "用户信息不可用"}
                            <AdminAccountId accountId={item.ownerAccountId} />
                        </span>
                        <span>{formatTime(item.createdAt)}</span>
                    </div>
                    {item.resolution ? <div className="mt-2 border-l-2 border-zinc-300 pl-2 text-xs leading-5 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">处理说明：{item.resolution}</div> : null}
                </div>
            </div>
            <div className="mt-3 flex min-w-0 flex-wrap justify-end gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
                <Button size="small" icon={<Eye className="size-3.5" />} onClick={() => window.open(`/share/${encodeURIComponent(item.slug || "")}`, "_blank", "noopener,noreferrer")}>
                    查看作品
                </Button>
                {item.status === "open" ? (
                    <>
                        <Button size="small" icon={<X className="size-3.5" />} onClick={() => onResolve("rejected")}>
                            驳回
                        </Button>
                        <Button size="small" type="primary" danger={item.caseType === "report"} icon={<Check className="size-3.5" />} onClick={() => onResolve("approved")}>
                            {item.caseType === "report" ? "确认违规并下架" : "通过并恢复"}
                        </Button>
                    </>
                ) : null}
            </div>
        </article>
    );
}

function caseStatusLabel(status: WorkGovernanceCaseStatus) {
    return status === "open" ? "待处理" : status === "approved" ? "已确认" : "已驳回";
}
function caseStatusColor(status: WorkGovernanceCaseStatus) {
    return status === "open" ? "processing" : status === "approved" ? "success" : "default";
}
function caseCategoryLabel(category: string) {
    return ({ illegal: "违规内容", copyright: "侵权内容", privacy: "隐私泄露", spam: "垃圾或广告", other: "其他问题", appeal: "下架复核" } as Record<string, string>)[category] || category;
}
function actionModalTitle(type: WorkGovernanceCaseType, decision: "approved" | "rejected") {
    return type === "report" ? (decision === "approved" ? "确认举报并下架" : "驳回作品举报") : decision === "approved" ? "通过申诉并恢复" : "驳回下架申诉";
}
function actionResultLabel(type: WorkGovernanceCaseType, decision: "approved" | "rejected") {
    return type === "report" ? (decision === "approved" ? "举报已确认，目标版本已按当前状态处置" : "举报已驳回") : decision === "approved" ? "申诉已通过，作品版本已恢复" : "申诉已驳回";
}
function formatTime(value: string) {
    return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}
