"use client";

import { App, Button, Input, Modal, Pagination, Select, Table, Tag, Tooltip } from "antd";
import type { TableColumnsType } from "antd";
import { Activity, CircleCheckBig, CircleStop, Clock3, Coins, RefreshCw, RotateCcw, Route, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import { AdminUserIdentity } from "@/components/admin/admin-user-identity";
import type { AdminGenerationOperationsPayload, AdminGenerationTask } from "@/lib/admin-generation-operations";
import { GenerationChannelStatus } from "./generation-channel-status";
import { AgentFailureSummary, AgentPlannerAuditSummary, executionPhaseLabel, GenerationTaskRuntimeSummary, generationTaskPointsLabel } from "./generation-operation-task-details";
import { generationOperationStatusTagClass, generationOperationThemeClasses } from "./generation-operations-theme";

const PAGE_SIZE = 20;

export function GenerationOperationsClient() {
    const { message } = App.useApp();
    const [data, setData] = useState<AdminGenerationOperationsPayload>();
    const [loading, setLoading] = useState(true);
    const [page, setPage] = useState(1);
    const [type, setType] = useState("");
    const [status, setStatus] = useState("");
    const [surface, setSurface] = useState("");
    const [search, setSearch] = useState("");
    const [submittedSearch, setSubmittedSearch] = useState("");
    const [actingId, setActingId] = useState("");
    const [reviewingTask, setReviewingTask] = useState<AdminGenerationTask>();
    const [reviewAction, setReviewAction] = useState<"resume_upstream" | "provide_result" | "confirm_failed">("resume_upstream");
    const [reviewValue, setReviewValue] = useState("");
    const [reviewing, setReviewing] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const query = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
            if (type) query.set("type", type);
            if (status) query.set("status", status);
            if (surface) query.set("surface", surface);
            if (submittedSearch) query.set("search", submittedSearch);
            const response = await fetch(`/api/admin/generation-operations?${query}`, { cache: "no-store" });
            const payload = (await response.json().catch(() => ({}))) as { data?: AdminGenerationOperationsPayload; msg?: string };
            if (!response.ok || !payload.data) throw new Error(payload.msg || "任务数据加载失败");
            setData(payload.data);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "任务数据加载失败");
        } finally {
            setLoading(false);
        }
    }, [message, page, status, submittedSearch, surface, type]);

    useEffect(() => {
        void load();
    }, [load]);

    const runAction = async (task: AdminGenerationTask, action: "cancel" | "retry") => {
        setActingId(`${task.id}:${action}`);
        try {
            const url =
                action === "retry"
                    ? `/api/agent/runs/${encodeURIComponent(task.id)}/tasks/${encodeURIComponent(task.retryTaskId || "")}/retry`
                    : task.type === "agent"
                      ? `/api/agent/runs/${encodeURIComponent(task.id)}/cancel`
                      : task.type === "render"
                        ? `/api/drama/render/${encodeURIComponent(task.id)}`
                        : `/api/${task.type}-tasks/${encodeURIComponent(task.id)}`;
            const response = await fetch(url, action === "retry" || task.type === "agent" ? { method: "POST" } : { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "cancelled" }) });
            const payload = (await response.json().catch(() => ({}))) as { msg?: string; error?: string };
            if (!response.ok) throw new Error(payload.msg || payload.error || "任务操作失败");
            message.success(action === "retry" ? "失败子任务已重新提交" : "任务已取消");
            await load();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "任务操作失败");
        } finally {
            setActingId("");
        }
    };

    const openReview = (task: AdminGenerationTask) => {
        setReviewingTask(task);
        setReviewAction("resume_upstream");
        setReviewValue(task.upstreamTaskId || "");
    };

    const submitReview = async () => {
        if (!reviewingTask) return;
        setReviewing(true);
        try {
            const body =
                reviewAction === "resume_upstream"
                    ? { action: reviewAction, upstreamTaskId: reviewValue.trim() }
                    : reviewAction === "provide_result"
                      ? { action: reviewAction, result: reviewValue.trim() }
                      : { action: reviewAction, reason: reviewValue.trim() };
            const response = await fetch(`/api/admin/generation-operations/${reviewingTask.type}/${encodeURIComponent(reviewingTask.id)}/review`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const payload = (await response.json().catch(() => ({}))) as { msg?: string };
            if (!response.ok) throw new Error(payload.msg || "任务接管失败");
            message.success(reviewAction === "confirm_failed" ? "任务已确认失败并结束" : "任务已交给后台 Worker 继续处理");
            setReviewingTask(undefined);
            await load();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "任务接管失败");
        } finally {
            setReviewing(false);
        }
    };

    const columns = useMemo<TableColumnsType<AdminGenerationTask>>(
        () => [
            {
                title: "任务",
                dataIndex: "id",
                width: 260,
                render: (_, task) => (
                    <div className="min-w-0">
                        <div className="flex items-center gap-2">
                            <TaskTypeTag type={task.type} />
                            {task.canReview ? <ReviewTag /> : <StatusTag status={task.status} />}
                        </div>
                        <Tooltip title={task.id}>
                            <div className="mt-2 truncate font-mono text-xs text-zinc-500 dark:text-zinc-400">{task.id}</div>
                        </Tooltip>
                    </div>
                ),
            },
            {
                title: "用户",
                width: 210,
                render: (_, task) => <AdminUserIdentity displayName={task.displayName} username={task.username} accountId={task.accountId} fallback="用户信息不可用" />,
            },
            {
                title: "模型 / 入口",
                width: 190,
                render: (_, task) => (
                    <div>
                        <div className="truncate text-sm">{task.model || "未记录"}</div>
                        <div className="mt-1 text-xs text-zinc-500">
                            {surfaceLabel(task.surface)}
                            {task.channelId ? ` · 渠道 ${task.channelId}` : ""}
                            {task.projectId ? ` · 项目 ${task.projectId.slice(0, 8)}` : ""}
                        </div>
                        <AgentPlannerAuditSummary task={task} />
                    </div>
                ),
            },
            {
                title: "请求",
                render: (_, task) => (
                    <div>
                        <div className="line-clamp-2 text-sm leading-5">{task.prompt || task.error || "无请求摘要"}</div>
                        <div className="mt-1 text-xs text-zinc-500">
                            {formatDuration(task.durationMs)} · {generationTaskPointsLabel(task)}
                            {task.attempts && task.attempts.length > 1 ? ` · ${task.attempts.length} 次渠道尝试` : ""}
                        </div>
                    </div>
                ),
            },
            {
                title: "执行诊断",
                width: 220,
                render: (_, task) => (
                    <div>
                        <GenerationTaskRuntimeSummary task={task} />
                        <AgentFailureSummary task={task} />
                    </div>
                ),
            },
            {
                title: "操作",
                width: 118,
                fixed: "right",
                render: (_, task) => (
                    <div className="flex gap-1">
                        {task.canCancel ? (
                            <Tooltip title="取消任务">
                                <Button danger type="text" shape="circle" icon={<CircleStop className="size-4" />} loading={actingId === `${task.id}:cancel`} onClick={() => void runAction(task, "cancel")} />
                            </Tooltip>
                        ) : null}
                        {task.retryTaskId ? (
                            <Tooltip title="重试失败子任务">
                                <Button type="text" shape="circle" icon={<RotateCcw className="size-4" />} loading={actingId === `${task.id}:retry`} onClick={() => void runAction(task, "retry")} />
                            </Tooltip>
                        ) : null}
                        {task.canReview ? (
                            <Tooltip title="接管待确认任务">
                                <Button aria-label="接管待确认任务" type="text" shape="circle" icon={<ShieldAlert className="size-4 text-amber-600 dark:text-amber-300" />} onClick={() => openReview(task)} />
                            </Tooltip>
                        ) : null}
                    </div>
                ),
            },
        ],
        [actingId],
    );

    const summary = data?.summary;
    return (
        <>
            <div className="space-y-3 sm:space-y-4">
                <Panel>
                    <PanelHeader
                        title="运行概览"
                        description="快速查看任务吞吐、成功率、耗时与人民币余额消耗。"
                        actions={
                            <Button aria-label="刷新生成运维数据" icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void load()}>
                                刷新
                            </Button>
                        }
                    />
                    <section className="grid grid-cols-2 gap-px bg-zinc-200 dark:bg-zinc-800 sm:grid-cols-3 xl:grid-cols-6">
                        <SummaryMetric icon={<Activity />} label="任务总数" value={summary?.total || 0} detail="全部生成记录" />
                        <SummaryMetric icon={<Route />} label="执行中" value={summary?.active || 0} detail="排队与运行任务" />
                        <SummaryMetric icon={<CircleCheckBig />} label="成功" value={summary?.success || 0} detail="已完成任务" />
                        <SummaryMetric icon={<CircleStop />} label="失败" value={summary?.failed || 0} detail="需要关注" tone="danger" />
                        <SummaryMetric icon={<Clock3 />} label="平均耗时" value={formatDuration(summary?.averageDurationMs || 0)} detail="全部任务平均" />
                        <SummaryMetric icon={<Coins />} label="余额消耗（元）" value={`¥${summary?.totalPointsCost || 0}`} detail="累计扣减" />
                    </section>
                </Panel>

                {data?.agentPerformance.sampleSize ? (
                    <Panel>
                        <PanelHeader
                            title="Agent 分阶段性能"
                            description="拆分规划、首个结果、排队、上游保存与复盘耗时，定位实际瓶颈。"
                            actions={<Tag className={generationOperationThemeClasses.neutralTag}>{data.agentPerformance.sampleSize} 次样本</Tag>}
                        />
                        <section className="grid grid-cols-2 gap-px bg-zinc-200 dark:bg-zinc-800 sm:grid-cols-4 xl:grid-cols-7">
                            <PerformanceValue label="规划 P50" value={data.agentPerformance.planningP50Ms} detail="典型规划耗时" />
                            <PerformanceValue label="规划 P95" value={data.agentPerformance.planningP95Ms} detail="慢请求边界" />
                            <PerformanceValue label="首结果 P50" value={data.agentPerformance.firstResultP50Ms} detail="典型首屏等待" />
                            <PerformanceValue label="首结果 P95" value={data.agentPerformance.firstResultP95Ms} detail="长尾首屏等待" />
                            <PerformanceValue label="排队平均" value={data.agentPerformance.queueAverageMs} detail="调度等待" />
                            <PerformanceValue label="上游及保存" value={data.agentPerformance.upstreamAverageMs} detail="生成与落盘" />
                            <PerformanceValue className="col-span-2 sm:col-span-1" label="复盘平均" value={data.agentPerformance.reviewAverageMs} detail="后台质量复盘" />
                        </section>
                    </Panel>
                ) : null}

                <Panel>
                    <PanelHeader title="任务队列" description={`共 ${data?.total || 0} 条记录，可按任务、用户、模型、状态和创作入口定位问题。`} />
                    <section className="border-b border-zinc-200 bg-zinc-50/70 p-3 dark:border-zinc-800 dark:bg-zinc-900/40 sm:p-4">
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-[minmax(280px,1fr)_repeat(3,minmax(140px,180px))] xl:gap-3">
                            <Input.Search
                                className="col-span-2 sm:col-span-3 xl:col-span-1"
                                value={search}
                                allowClear
                                aria-label="搜索生成任务"
                                placeholder="任务、用户 ID、模型、会话或项目"
                                enterButton="查询"
                                onChange={(event) => setSearch(event.target.value)}
                                onSearch={(value) => {
                                    setPage(1);
                                    setSubmittedSearch(value.trim());
                                }}
                            />
                            <div className="min-w-0">
                                <Select
                                    className="w-full"
                                    aria-label="按任务类型筛选"
                                    value={type || undefined}
                                    allowClear
                                    placeholder="任务类型"
                                    options={["agent", "text", "image", "video", "audio", "render"].map((value) => ({ value, label: taskTypeLabel(value) }))}
                                    onChange={(value) => {
                                        setPage(1);
                                        setType(value || "");
                                    }}
                                />
                            </div>
                            <div className="min-w-0">
                                <Select
                                    className="w-full"
                                    aria-label="按任务状态筛选"
                                    value={status || undefined}
                                    allowClear
                                    placeholder="任务状态"
                                    options={["pending", "running", "paused", "success", "error", "cancelled"].map((value) => ({ value, label: statusLabel(value) }))}
                                    onChange={(value) => {
                                        setPage(1);
                                        setStatus(value || "");
                                    }}
                                />
                            </div>
                            <div className="col-span-2 min-w-0 sm:col-span-1">
                                <Select
                                    className="w-full"
                                    aria-label="按创作入口筛选"
                                    value={surface || undefined}
                                    allowClear
                                    placeholder="创作入口"
                                    options={[
                                        { value: "chat", label: "创作对话" },
                                        { value: "canvas", label: "Canvas" },
                                        { value: "drama", label: "短剧" },
                                    ]}
                                    onChange={(value) => {
                                        setPage(1);
                                        setSurface(value || "");
                                    }}
                                />
                            </div>
                        </div>
                    </section>

                    <section className="min-w-0 p-3 sm:p-4">
                        <div className="hidden overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800 md:block">
                            <Table rowKey="id" size="middle" loading={loading} columns={columns} dataSource={data?.items || []} pagination={false} scroll={{ x: 1200 }} />
                        </div>
                        <div className="space-y-3 md:hidden">
                            {(data?.items || []).map((task) => (
                                <TaskCard key={task.id} task={task} actingId={actingId} onAction={runAction} onReview={openReview} />
                            ))}
                            {loading ? <div className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">正在加载任务…</div> : null}
                            {!loading && !data?.items.length ? <div className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">没有匹配任务</div> : null}
                        </div>
                        <div className="mt-4 flex justify-end border-t border-zinc-100 pt-4 dark:border-zinc-900">
                            <Pagination current={page} pageSize={PAGE_SIZE} total={data?.total || 0} showSizeChanger={false} responsive onChange={setPage} />
                        </div>
                    </section>
                </Panel>

                <GenerationChannelStatus channels={data?.channels || []} loading={loading} />
            </div>

            <Modal
                open={Boolean(reviewingTask)}
                title="接管待确认任务"
                centered
                width="min(520px, calc(100vw - 24px))"
                okText={reviewAction === "confirm_failed" ? "确认结束任务" : "确认并继续"}
                okButtonProps={{ danger: reviewAction === "confirm_failed", disabled: reviewAction !== "confirm_failed" && !reviewValue.trim(), className: reviewAction === "confirm_failed" ? undefined : generationOperationThemeClasses.primaryButton }}
                cancelButtonProps={{ className: generationOperationThemeClasses.secondaryButton }}
                confirmLoading={reviewing}
                destroyOnHidden
                onOk={() => void submitReview()}
                onCancel={() => !reviewing && setReviewingTask(undefined)}
            >
                <div className="space-y-4 pt-2">
                    <div className={generationOperationThemeClasses.reviewPanel}>创建请求结果无法自动确认。系统已停止重复创建，接管操作只会继续查询、保存已有结果或明确结束任务。</div>
                    <div className="grid grid-cols-3 gap-2">
                        {[
                            { value: "resume_upstream", label: "录入任务 ID" },
                            { value: "provide_result", label: reviewingTask?.type === "text" ? "录入文本结果" : "录入结果地址" },
                            { value: "confirm_failed", label: "确认未创建" },
                        ].map((item) => (
                            <button
                                key={item.value}
                                type="button"
                                className={`min-h-10 rounded-lg border px-2 text-xs font-medium transition-colors sm:text-sm ${reviewAction === item.value ? generationOperationThemeClasses.selectedAction : generationOperationThemeClasses.idleAction}`}
                                onClick={() => {
                                    setReviewAction(item.value as typeof reviewAction);
                                    setReviewValue(item.value === "resume_upstream" ? reviewingTask?.upstreamTaskId || "" : "");
                                }}
                            >
                                {item.label}
                            </button>
                        ))}
                    </div>
                    <Input.TextArea
                        className={generationOperationThemeClasses.textarea}
                        value={reviewValue}
                        autoSize={{ minRows: reviewAction === "provide_result" && reviewingTask?.type === "text" ? 4 : 2, maxRows: 8 }}
                        placeholder={reviewAction === "resume_upstream" ? "粘贴上游任务 ID" : reviewAction === "provide_result" ? (reviewingTask?.type === "text" ? "粘贴上游返回的最终文本" : "粘贴上游成品 URL 或站内媒体地址") : "可选：填写确认失败原因"}
                        onChange={(event) => setReviewValue(event.target.value)}
                    />
                    <div className="text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                        任务 {reviewingTask?.id} · {taskTypeLabel(reviewingTask?.type || "")} · 当前阶段 {executionPhaseLabel(reviewingTask?.executionPhase)}
                    </div>
                </div>
            </Modal>
        </>
    );
}

function SummaryMetric({ icon, label, value, detail, tone = "default" }: { icon: React.ReactNode; label: string; value: string | number; detail: string; tone?: "default" | "danger" }) {
    return (
        <div className="flex min-h-[94px] min-w-0 flex-col justify-between bg-white p-3 dark:bg-zinc-950 sm:min-h-28 sm:p-4">
            <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400 sm:text-xs">{label}</span>
                <span className={`[&>svg]:size-4 ${tone === "danger" ? "text-red-600 dark:text-red-300" : "text-zinc-400 dark:text-zinc-500"}`}>{icon}</span>
            </div>
            <div>
                <div className="truncate text-xl font-semibold leading-none tabular-nums text-zinc-950 dark:text-zinc-100 sm:text-2xl">{value}</div>
                <div className="mt-1.5 truncate text-[10px] text-zinc-400 dark:text-zinc-500 sm:text-[11px]">{detail}</div>
            </div>
        </div>
    );
}

function PerformanceValue({ label, value, detail, className = "" }: { label: string; value: number; detail: string; className?: string }) {
    return (
        <div className={`min-h-[82px] min-w-0 bg-white p-3 dark:bg-zinc-950 sm:min-h-24 sm:p-4 ${className}`}>
            <div className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">{label}</div>
            <div className="mt-2 truncate text-base font-semibold tabular-nums text-zinc-950 dark:text-zinc-100 sm:text-lg">{formatDuration(value)}</div>
            <div className="mt-1 truncate text-[10px] text-zinc-400 dark:text-zinc-500">{detail}</div>
        </div>
    );
}

function TaskCard({ task, actingId, onAction, onReview }: { task: AdminGenerationTask; actingId: string; onAction: (task: AdminGenerationTask, action: "cancel" | "retry") => Promise<void>; onReview: (task: AdminGenerationTask) => void }) {
    return (
        <article className="min-w-0 rounded-lg border border-zinc-200 bg-white p-3.5 dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-wrap gap-1.5">
                    <TaskTypeTag type={task.type} />
                    {task.canReview ? <ReviewTag /> : <StatusTag status={task.status} />}
                </div>
                <div className="flex shrink-0 gap-0.5">
                    {task.canCancel ? (
                        <Tooltip title="取消任务">
                            <Button aria-label="取消任务" danger type="text" shape="circle" icon={<CircleStop className="size-4" />} loading={actingId === `${task.id}:cancel`} onClick={() => void onAction(task, "cancel")} />
                        </Tooltip>
                    ) : null}
                    {task.retryTaskId ? (
                        <Tooltip title="重试失败子任务">
                            <Button aria-label="重试失败子任务" type="text" shape="circle" icon={<RotateCcw className="size-4" />} loading={actingId === `${task.id}:retry`} onClick={() => void onAction(task, "retry")} />
                        </Tooltip>
                    ) : null}
                    {task.canReview ? (
                        <Tooltip title="接管待确认任务">
                            <Button aria-label="接管待确认任务" type="text" shape="circle" icon={<ShieldAlert className="size-4 text-amber-600 dark:text-amber-300" />} onClick={() => onReview(task)} />
                        </Tooltip>
                    ) : null}
                </div>
            </div>
            <Tooltip title={task.id}>
                <div className="mt-2 truncate font-mono text-[11px] text-zinc-400 dark:text-zinc-500">{task.id}</div>
            </Tooltip>
            <div className="mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-900">
                <AdminUserIdentity displayName={task.displayName} username={task.username} accountId={task.accountId} fallback="用户信息不可用" />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-y border-zinc-100 py-3 text-xs dark:border-zinc-900">
                <TaskCardFact label="模型" value={task.model || "未记录"} />
                <TaskCardFact label="入口" value={surfaceLabel(task.surface)} />
                <TaskCardFact label="耗时" value={formatDuration(task.durationMs)} />
                <TaskCardFact label="余额" value={generationTaskPointsLabel(task)} />
            </div>
            <AgentPlannerAuditSummary task={task} />
            <AgentFailureSummary task={task} />
            <GenerationTaskRuntimeSummary task={task} compact />
            <div className="mt-3">
                <div className="text-[11px] font-medium text-zinc-400 dark:text-zinc-500">请求摘要</div>
                <p className="mt-1 line-clamp-3 text-sm leading-5 text-zinc-700 dark:text-zinc-300">{task.prompt || task.error || "无请求摘要"}</p>
            </div>
        </article>
    );
}

function TaskCardFact({ label, value }: { label: string; value: string }) {
    return (
        <div className="min-w-0">
            <div className="text-[10px] text-zinc-400 dark:text-zinc-500">{label}</div>
            <div className="mt-0.5 truncate text-zinc-700 dark:text-zinc-300">{value}</div>
        </div>
    );
}

function StatusTag({ status }: { status: string }) {
    return <Tag className={generationOperationStatusTagClass(status)}>{statusLabel(status)}</Tag>;
}

function TaskTypeTag({ type }: { type: string }) {
    return <Tag className={generationOperationThemeClasses.neutralTag}>{taskTypeLabel(type)}</Tag>;
}

function ReviewTag() {
    return <Tag className={generationOperationThemeClasses.reviewTag}>待人工确认</Tag>;
}

function taskTypeLabel(value: string) {
    return ({ agent: "Agent", text: "文本", image: "图片", video: "视频", audio: "音频", render: "合成" } as Record<string, string>)[value] || value;
}
function statusLabel(value: string) {
    return ({ pending: "排队", running: "执行中", paused: "已暂停", success: "成功", error: "失败", cancelled: "已取消" } as Record<string, string>)[value] || value;
}
function surfaceLabel(value?: string) {
    return value === "canvas" ? "Canvas" : value === "drama" ? "短剧" : value === "chat" ? "创作对话" : "专业工作台";
}
function formatDuration(ms: number) {
    if (!ms) return "0 秒";
    return ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} 秒` : `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`;
}
