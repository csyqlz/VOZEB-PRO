"use client";

import { App, Button, Empty, Input, Segmented, Skeleton, Tag } from "antd";
import { AlertCircle, Check, CheckCircle2, Clock3, Pause, Play, RefreshCw, RotateCcw, Search, Square, Workflow, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Panel } from "@/components/admin/admin-panel";
import type { VozebCmsWorkflowDefinition, VozebCmsWorkflowRun } from "@/lib/vozeb-cms/workflow-contract";
import { controlVozebCmsWorkflowRun, getVozebCmsWorkflowDashboard, reviewVozebCmsWorkflowNode, subscribeVozebCmsWorkflowRun } from "@/services/api/vozeb-cms-workflows";

type RunFilter = "attention" | "active" | "completed" | "all";

const statusLabel: Record<VozebCmsWorkflowRun["status"], string> = { pending: "排队中", running: "运行中", waiting: "等待处理", paused: "已暂停", completed: "已完成", failed: "失败", cancelled: "已取消" };
const statusColor: Record<VozebCmsWorkflowRun["status"], string> = { pending: "blue", running: "processing", waiting: "gold", paused: "default", completed: "success", failed: "error", cancelled: "default" };
const nodeStatusLabel: Record<VozebCmsWorkflowRun["nodeStates"][string]["status"], string> = { pending: "待执行", running: "执行中", waiting: "等待", success: "完成", failed: "失败", skipped: "已跳过", cancelled: "已取消" };

export function AdminWorkflowsSection() {
    const { message } = App.useApp();
    const [workflows, setWorkflows] = useState<VozebCmsWorkflowDefinition[]>([]);
    const [runs, setRuns] = useState<Record<string, VozebCmsWorkflowRun>>({});
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState("");
    const [filter, setFilter] = useState<RunFilter>("attention");
    const [query, setQuery] = useState("");
    const subscriptions = useRef<Record<string, () => void>>({});

    const watch = useCallback((run: VozebCmsWorkflowRun) => {
        setRuns((current) => ({ ...current, [run.id]: run }));
        if (["completed", "failed", "cancelled"].includes(run.status)) {
            subscriptions.current[run.id]?.();
            delete subscriptions.current[run.id];
        }
    }, []);

    const attach = useCallback(
        (run: VozebCmsWorkflowRun) => {
            if (["completed", "failed", "cancelled"].includes(run.status) || subscriptions.current[run.id]) return;
            subscriptions.current[run.id] = subscribeVozebCmsWorkflowRun(run.id, watch);
        },
        [watch],
    );

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const dashboard = await getVozebCmsWorkflowDashboard();
            setWorkflows(dashboard.workflows);
            setRuns(Object.fromEntries(dashboard.runs.map((run) => [run.id, run])));
            dashboard.runs.forEach(attach);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "自动化运行记录读取失败");
        } finally {
            setLoading(false);
        }
    }, [attach, message]);

    useEffect(() => {
        void load();
        const activeSubscriptions = subscriptions.current;
        return () => Object.values(activeSubscriptions).forEach((close) => close());
    }, [load]);

    const review = async (run: VozebCmsWorkflowRun, nodeId: string, decision: "approved" | "rejected") => {
        setBusy(`${decision}:${run.id}:${nodeId}`);
        try {
            const next = await reviewVozebCmsWorkflowNode(run.id, nodeId, decision);
            watch(next);
            attach(next);
            message.success(decision === "approved" ? "审核已通过，流程将继续" : "审核已驳回，流程已终止");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "审核操作失败");
        } finally {
            setBusy("");
        }
    };

    const control = async (run: VozebCmsWorkflowRun, action: "pause" | "resume" | "cancel" | "retry") => {
        setBusy(`${action}:${run.id}`);
        try {
            const next = await controlVozebCmsWorkflowRun(run.id, action);
            watch(next);
            attach(next);
            message.success(action === "retry" ? "失败步骤已重新进入执行" : action === "pause" ? "流程已暂停" : action === "resume" ? "流程已恢复" : "流程已取消");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "流程操作失败");
        } finally {
            setBusy("");
        }
    };

    const definitionById = new Map(workflows.map((workflow) => [workflow.id, workflow]));
    const runList = Object.values(runs).sort((left, right) => right.updatedAt - left.updatedAt);
    const reviewCount = runList.reduce((total, run) => total + pendingReviewNodes(run, definitionById.get(run.workflowId)).length, 0);
    const failedCount = runList.filter((run) => run.status === "failed").length;
    const activeCount = runList.filter((run) => ["pending", "running", "waiting", "paused"].includes(run.status)).length;
    const completedCount = runList.filter((run) => run.status === "completed").length;
    const normalizedQuery = query.trim().toLowerCase();
    const filteredRuns = runList.filter((run) => {
        const workflow = definitionById.get(run.workflowId);
        const waitingReview = pendingReviewNodes(run, workflow).length > 0;
        if (filter === "attention" && run.status !== "failed" && !waitingReview) return false;
        if (filter === "active" && !["pending", "running", "waiting", "paused"].includes(run.status)) return false;
        if (filter === "completed" && run.status !== "completed") return false;
        if (!normalizedQuery) return true;
        return [run.id, run.projectId, workflow?.name, run.projectRef?.type].filter(Boolean).some((value) => String(value).toLowerCase().includes(normalizedQuery));
    });

    if (loading && !runList.length)
        return (
            <Panel variant="page">
                <div className="admin-panel-surface rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
                    <Skeleton active paragraph={{ rows: 8 }} />
                </div>
            </Panel>
        );

    return (
        <Panel variant="page">
            <section className="min-w-0 space-y-4" aria-label="自动化运行中心">
                <div className="admin-panel-surface overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
                    <div className="flex min-w-0 flex-col gap-4 px-4 py-4 lg:flex-row lg:items-center lg:justify-between lg:px-5">
                        <div className="flex min-w-0 items-center gap-3">
                            <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950">
                                <Workflow className="size-[19px]" />
                            </span>
                            <div className="min-w-0">
                                <h2 className="text-base font-semibold text-zinc-950 dark:text-zinc-100">自动化运行</h2>
                                <p className="mt-0.5 text-xs leading-5 text-zinc-500 dark:text-zinc-400">集中处理跨项目失败、人工审核和恢复；新生产流程由对应短剧项目发起。</p>
                            </div>
                        </div>
                        <div className="grid shrink-0 grid-cols-4 divide-x divide-zinc-200 overflow-hidden rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                            <SummaryMetric label="待审核" value={reviewCount} tone={reviewCount ? "warning" : "neutral"} />
                            <SummaryMetric label="失败" value={failedCount} tone={failedCount ? "danger" : "neutral"} />
                            <SummaryMetric label="进行中" value={activeCount} />
                            <SummaryMetric label="已完成" value={completedCount} />
                        </div>
                    </div>
                    <div className="grid min-w-0 gap-2 border-t border-zinc-100 bg-zinc-50/70 px-4 py-3 md:grid-cols-[minmax(0,1fr)_auto] xl:grid-cols-[minmax(220px,288px)_minmax(0,1fr)_auto] xl:items-center dark:border-zinc-900 dark:bg-zinc-900/35">
                        <Input
                            className="min-w-0 md:col-start-1 md:row-start-1"
                            allowClear
                            prefix={<Search className="size-3.5 text-zinc-400" />}
                            value={query}
                            placeholder="搜索项目或流程"
                            aria-label="搜索自动化运行"
                            onChange={(event) => setQuery(event.target.value)}
                        />
                        <div className="min-w-0 overflow-x-auto md:col-span-2 md:row-start-2 xl:col-span-1 xl:col-start-2 xl:row-start-1">
                            <div className="w-max min-w-full">
                                <Segmented
                                    className="w-full"
                                    value={filter}
                                    onChange={setFilter}
                                    options={[
                                        { label: `待处理 ${reviewCount + failedCount}`, value: "attention" },
                                        { label: `进行中 ${activeCount}`, value: "active" },
                                        { label: "已完成", value: "completed" },
                                        { label: "全部", value: "all" },
                                    ]}
                                />
                            </div>
                        </div>
                        <Button className="w-full md:col-start-2 md:row-start-1 md:w-auto xl:col-start-3" icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void load()}>
                            刷新状态
                        </Button>
                    </div>
                </div>

                {filteredRuns.length ? (
                    <div className="space-y-3">
                        {filteredRuns.map((run) => (
                            <AutomationRunCard key={run.id} workflow={definitionById.get(run.workflowId)} run={run} busy={busy} onControl={control} onReview={review} />
                        ))}
                    </div>
                ) : (
                    <div className="admin-panel-surface rounded-xl border border-zinc-200 bg-white py-8 dark:border-zinc-800 dark:bg-zinc-950">
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={filter === "attention" ? "当前没有需要处理的自动化流程" : "没有符合条件的运行记录"} />
                    </div>
                )}
            </section>
        </Panel>
    );
}

function AutomationRunCard({
    workflow,
    run,
    busy,
    onControl,
    onReview,
}: {
    workflow?: VozebCmsWorkflowDefinition;
    run: VozebCmsWorkflowRun;
    busy: string;
    onControl: (run: VozebCmsWorkflowRun, action: "pause" | "resume" | "cancel" | "retry") => void;
    onReview: (run: VozebCmsWorkflowRun, nodeId: string, decision: "approved" | "rejected") => void;
}) {
    const nodes = workflow?.nodes || run.definitionSnapshot.nodes;
    const waitingReviews = pendingReviewNodes(run, workflow);
    const completedNodes = Object.values(run.nodeStates).filter((state) => ["success", "skipped"].includes(state.status)).length;
    const action = run.status === "paused" ? "resume" : run.status === "failed" ? "retry" : run.status === "waiting" || run.status === "running" ? "pause" : null;
    const projectLabel = run.projectRef?.type === "drama" ? "短剧项目" : run.projectRef?.type === "canvas" ? "Canvas 项目" : "创作项目";
    return (
        <article className="admin-panel-surface min-w-0 overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex min-w-0 flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <h2 className="truncate text-sm font-semibold text-zinc-950 dark:text-zinc-100">{workflow?.name || run.definitionSnapshot.name || "项目自动化"}</h2>
                        <Tag color={statusColor[run.status]} bordered={false}>
                            {statusLabel[run.status]}
                        </Tag>
                        {waitingReviews.length ? <Tag color="warning">等待人工审核</Tag> : null}
                    </div>
                    <div className="mt-1 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                        <span>{projectLabel}</span>
                        <span>{run.projectId || "未绑定项目"}</span>
                        <span>
                            进度 {completedNodes}/{nodes.length}
                        </span>
                        <span>{new Date(run.updatedAt).toLocaleString("zh-CN")}</span>
                    </div>
                </div>
                <div className="flex shrink-0 gap-1.5">
                    {action ? (
                        <Button
                            size="small"
                            icon={action === "resume" ? <Play className="size-3" /> : action === "retry" ? <RotateCcw className="size-3" /> : <Pause className="size-3" />}
                            loading={busy === `${action}:${run.id}`}
                            onClick={() => onControl(run, action)}
                        >
                            {action === "resume" ? "恢复" : action === "retry" ? "重试失败步骤" : "暂停"}
                        </Button>
                    ) : null}
                    {["running", "waiting", "paused"].includes(run.status) ? (
                        <Button size="small" danger icon={<Square className="size-3" />} loading={busy === `cancel:${run.id}`} onClick={() => onControl(run, "cancel")}>
                            取消
                        </Button>
                    ) : null}
                </div>
            </div>
            <div className="grid gap-px border-y border-zinc-100 bg-zinc-100 sm:grid-cols-2 xl:grid-cols-4 dark:border-zinc-900 dark:bg-zinc-900">
                {nodes.map((node) => {
                    const state = run.nodeStates[node.id];
                    if (!state) return null;
                    const waitingReview = node.kind === "manual_review" && state.status === "waiting";
                    const StatusIcon = state.status === "failed" ? AlertCircle : state.status === "success" ? CheckCircle2 : Clock3;
                    return (
                        <div key={node.id} className="min-w-0 bg-white px-3 py-3 dark:bg-zinc-950">
                            <div className="flex min-w-0 items-center gap-1.5">
                                <StatusIcon className={`size-3.5 shrink-0 ${state.status === "failed" ? "text-red-500" : state.status === "success" ? "text-emerald-500" : "text-amber-500"}`} />
                                <div className="truncate text-xs font-medium text-zinc-700 dark:text-zinc-200">{node.name}</div>
                                <span className="ml-auto shrink-0 text-[10px] text-zinc-400">{nodeStatusLabel[state.status]}</span>
                            </div>
                            {state.error ? <div className="mt-1.5 line-clamp-2 text-[10px] leading-4 text-red-600 dark:text-red-400">{state.error}</div> : null}
                            {waitingReview ? (
                                <div className="mt-2 flex gap-1.5">
                                    <Button size="small" type="primary" icon={<Check className="size-3" />} loading={busy === `approved:${run.id}:${node.id}`} onClick={() => onReview(run, node.id, "approved")}>
                                        通过
                                    </Button>
                                    <Button size="small" danger icon={<X className="size-3" />} loading={busy === `rejected:${run.id}:${node.id}`} onClick={() => onReview(run, node.id, "rejected")}>
                                        驳回
                                    </Button>
                                </div>
                            ) : null}
                        </div>
                    );
                })}
            </div>
            {run.error ? <div className="m-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/70 dark:bg-red-950/30 dark:text-red-300">{run.error}</div> : null}
            <div className="px-4 py-2 text-right font-mono text-[10px] text-zinc-400" title={run.id}>
                运行记录 {run.id.slice(-12)}
            </div>
        </article>
    );
}

function pendingReviewNodes(run: VozebCmsWorkflowRun, workflow?: VozebCmsWorkflowDefinition) {
    const nodes = workflow?.nodes || run.definitionSnapshot.nodes;
    return nodes.filter((node) => node.kind === "manual_review" && run.nodeStates[node.id]?.status === "waiting");
}

function SummaryMetric({ label, value, tone = "neutral" }: { label: string; value: number; tone?: "neutral" | "warning" | "danger" }) {
    const valueClass = tone === "danger" ? "text-red-600 dark:text-red-400" : tone === "warning" ? "text-amber-600 dark:text-amber-300" : "text-zinc-950 dark:text-zinc-100";
    return (
        <div className="min-w-[68px] px-2.5 py-2 text-center">
            <div className={`text-base font-semibold tabular-nums ${valueClass}`}>{value}</div>
            <div className="text-[10px] text-zinc-500 dark:text-zinc-400">{label}</div>
        </div>
    );
}
