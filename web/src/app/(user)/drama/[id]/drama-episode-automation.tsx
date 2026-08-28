"use client";

import { App, Button, Popover, Progress, Tag, Tooltip } from "antd";
import { Check, Pause, Play, RefreshCw, RotateCcw, Square, Workflow, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { VozebCmsWorkflowRun } from "@/lib/vozeb-cms/workflow-contract";
import { controlVozebCmsWorkflowRun, getVozebCmsWorkflowDashboard, reviewVozebCmsWorkflowNode, startVozebCmsDramaEpisodeWorkflow, subscribeVozebCmsWorkflowRun } from "@/services/api/vozeb-cms-workflows";

const labels: Record<VozebCmsWorkflowRun["status"], string> = { pending: "排队中", running: "生产中", waiting: "等待处理", paused: "已暂停", completed: "已完成", failed: "失败", cancelled: "已取消" };
const colors: Record<VozebCmsWorkflowRun["status"], string> = { pending: "blue", running: "processing", waiting: "gold", paused: "default", completed: "success", failed: "error", cancelled: "default" };

export function DramaEpisodeAutomation({ projectId, episodeId }: { projectId: string; episodeId: string }) {
    const { message } = App.useApp();
    const [run, setRun] = useState<VozebCmsWorkflowRun>();
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState("");

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const dashboard = await getVozebCmsWorkflowDashboard(projectId, "drama");
            setRun(dashboard.runs.filter((item) => item.context.episodeId === episodeId).sort((left, right) => right.updatedAt - left.updatedAt)[0]);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "本集自动化状态读取失败");
        } finally {
            setLoading(false);
        }
    }, [episodeId, message, projectId]);

    useEffect(() => {
        void load();
    }, [load]);

    const runId = run?.id;
    const runStatus = run?.status;
    useEffect(() => {
        if (!runId || !runStatus || ["completed", "failed", "cancelled"].includes(runStatus)) return;
        return subscribeVozebCmsWorkflowRun(runId, setRun);
    }, [runId, runStatus]);

    const start = async () => {
        setBusy("start");
        try {
            const next = await startVozebCmsDramaEpisodeWorkflow(projectId, episodeId, `drama-episode:${projectId}:${episodeId}:${crypto.randomUUID()}`);
            setRun(next);
            message.success("本集自动生产已启动");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "本集自动生产启动失败");
        } finally {
            setBusy("");
        }
    };

    const control = async (action: "pause" | "resume" | "cancel" | "retry") => {
        if (!run) return;
        setBusy(action);
        try {
            setRun(await controlVozebCmsWorkflowRun(run.id, action));
            message.success(action === "retry" ? "失败步骤已重试" : action === "pause" ? "本集生产已暂停" : action === "resume" ? "本集生产已恢复" : "本集生产已取消");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "本集自动化操作失败");
        } finally {
            setBusy("");
        }
    };

    const review = async (decision: "approved" | "rejected") => {
        const node = run?.definitionSnapshot.nodes.find((item) => item.kind === "manual_review" && run.nodeStates[item.id]?.status === "waiting");
        if (!run || !node) return;
        setBusy(decision);
        try {
            setRun(await reviewVozebCmsWorkflowNode(run.id, node.id, decision));
            message.success(decision === "approved" ? "审核已通过，正在回写项目资产" : "审核已驳回，本次生产已终止");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "审核操作失败");
        } finally {
            setBusy("");
        }
    };

    if (!run) {
        return (
            <Tooltip title="按当前剧集依次完成内容分析、视觉方案、视频生成、审核和资产回写">
                <Button className="!h-9 !px-2.5" icon={<Workflow className="size-4" />} loading={loading || busy === "start"} onClick={() => void start()} aria-label="启动本集自动生产">
                    <span className="hidden 2xl:inline">自动生产</span>
                </Button>
            </Tooltip>
        );
    }

    const nodes = run.definitionSnapshot.nodes;
    const completed = Object.values(run.nodeStates).filter((state) => ["success", "skipped"].includes(state.status)).length;
    const waitingReview = nodes.some((node) => node.kind === "manual_review" && run.nodeStates[node.id]?.status === "waiting");
    const percent = Math.round((completed / Math.max(1, nodes.length)) * 100);
    const content = (
        <div className="w-[min(340px,calc(100vw-32px))] space-y-3">
            <div className="flex items-start justify-between gap-3">
                <div>
                    <div className="text-sm font-semibold text-foreground">本集自动生产</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">只处理当前剧集，不会跟随项目当前选中集变化。</div>
                </div>
                <Tag color={colors[run.status]} bordered={false}>
                    {labels[run.status]}
                </Tag>
            </div>
            <Progress percent={percent} size="small" status={run.status === "failed" ? "exception" : run.status === "completed" ? "success" : "active"} />
            <div className="grid grid-cols-2 gap-1.5">
                {nodes.map((node) => {
                    const state = run.nodeStates[node.id];
                    return (
                        <div key={node.id} className="flex min-w-0 items-center justify-between gap-2 rounded-md border border-border px-2 py-1.5 text-[11px]">
                            <span className="truncate text-foreground">{node.name}</span>
                            <span className="shrink-0 text-muted-foreground">{state?.status === "success" ? "完成" : state?.status === "failed" ? "失败" : state?.status === "waiting" ? "等待" : state?.status === "running" ? "执行中" : "待执行"}</span>
                        </div>
                    );
                })}
            </div>
            {run.error ? <div className="rounded-md border border-red-200 bg-red-50 px-2.5 py-2 text-xs text-red-700 dark:border-red-900/70 dark:bg-red-950/30 dark:text-red-300">{run.error}</div> : null}
            <div className="flex flex-wrap justify-end gap-1.5 border-t border-border pt-3">
                {waitingReview ? (
                    <>
                        <Button size="small" type="primary" icon={<Check className="size-3" />} loading={busy === "approved"} onClick={() => void review("approved")}>
                            通过审核
                        </Button>
                        <Button size="small" danger icon={<X className="size-3" />} loading={busy === "rejected"} onClick={() => void review("rejected")}>
                            驳回
                        </Button>
                    </>
                ) : null}
                {run.status === "failed" ? (
                    <Button size="small" icon={<RotateCcw className="size-3" />} loading={busy === "retry"} onClick={() => void control("retry")}>
                        重试失败步骤
                    </Button>
                ) : null}
                {run.status === "paused" ? (
                    <Button size="small" icon={<Play className="size-3" />} loading={busy === "resume"} onClick={() => void control("resume")}>
                        恢复
                    </Button>
                ) : null}
                {["running", "waiting"].includes(run.status) && !waitingReview ? (
                    <Button size="small" icon={<Pause className="size-3" />} loading={busy === "pause"} onClick={() => void control("pause")}>
                        暂停
                    </Button>
                ) : null}
                {["running", "waiting", "paused"].includes(run.status) ? (
                    <Button size="small" danger icon={<Square className="size-3" />} loading={busy === "cancel"} onClick={() => void control("cancel")}>
                        取消
                    </Button>
                ) : null}
                {["completed", "cancelled"].includes(run.status) ? (
                    <Button size="small" icon={<RefreshCw className="size-3" />} loading={busy === "start"} onClick={() => void start()}>
                        再次运行
                    </Button>
                ) : null}
            </div>
        </div>
    );

    return (
        <Popover trigger="click" placement="bottomRight" content={content}>
            <Tooltip title={`本集自动生产：${labels[run.status]}`}>
                <Button
                    className={`!h-9 !px-2.5 ${run.status === "failed" ? "!border-red-300 !text-red-600 dark:!border-red-800 dark:!text-red-300" : waitingReview ? "!border-amber-300 !text-amber-700 dark:!border-amber-800 dark:!text-amber-300" : ""}`}
                    icon={<Workflow className="size-4" />}
                    loading={loading}
                    aria-label="查看本集自动生产状态"
                >
                    <span className="hidden 2xl:inline">{labels[run.status]}</span>
                </Button>
            </Tooltip>
        </Popover>
    );
}
