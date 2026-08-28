"use client";

import { Drawer, Tag, Tooltip } from "antd";

import type { AdminGenerationTask } from "@/lib/admin-generation-operations";
import { AgentFailureSummary, AgentPlannerAuditSummary, GenerationTaskRuntimeSummary, executionPhaseLabel, generationTaskPointsLabel } from "./generation-operation-task-details";
import { formatGenerationDuration } from "./generation-operations-format";
import { generationOperationStatusTagClass, generationOperationThemeClasses } from "./generation-operations-theme";

export function GenerationTaskDetailsDrawer({ task, onClose }: { task?: AdminGenerationTask; onClose: () => void }) {
    return (
        <Drawer open={Boolean(task)} title="任务详情" placement="right" size={640} styles={{ wrapper: { maxWidth: "100vw" } }} destroyOnHidden onClose={onClose}>
            {task ? (
                <div className="space-y-4">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <Tag className={generationOperationThemeClasses.neutralTag}>{taskTypeLabel(task.type)}</Tag>
                        <Tag className={generationOperationStatusTagClass(task.status)}>{statusLabel(task.status)}</Tag>
                        <Tag className={generationOperationThemeClasses.neutralTag}>{executionPhaseLabel(task.executionPhase)}</Tag>
                    </div>

                    <section className="rounded-lg border border-zinc-200 bg-zinc-50/70 p-3 dark:border-zinc-800 dark:bg-zinc-900/40" aria-label="任务概览">
                        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
                            <DetailFact label="任务类型" value={taskTypeLabel(task.type)} />
                            <DetailFact label="创作入口" value={surfaceLabel(task.surface)} />
                            <DetailFact label="模型" value={task.model || "未记录"} />
                            <DetailFact label="耗时" value={formatGenerationDuration(task.durationMs)} />
                            <DetailFact label="积分" value={generationTaskPointsLabel(task)} />
                            <DetailFact label="Provider" value={task.provider || "未记录"} />
                        </div>
                    </section>

                    <DetailsSection title="身份与关联">
                        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                            <DetailFact label="任务 ID" value={task.id} mono />
                            <DetailFact label="用户" value={[task.displayName, task.username ? `@${task.username}` : ""].filter(Boolean).join(" · ") || "未记录"} />
                            <DetailFact label="用户 ID" value={task.userId || "未记录"} mono />
                            <DetailFact label="账号 ID" value={task.accountId || "未记录"} mono />
                            <DetailFact label="会话 ID" value={task.conversationId || "未记录"} mono />
                            <DetailFact label="项目 ID" value={task.projectId || "未记录"} mono />
                            <DetailFact label="Run ID" value={task.runId || "未记录"} mono />
                            <DetailFact label="父任务 ID" value={task.parentTaskId || "未记录"} mono />
                            <DetailFact label="渠道 ID" value={task.channelId || "未记录"} mono />
                            <DetailFact label="上游任务 ID" value={task.upstreamTaskId || "未记录"} mono />
                        </div>
                    </DetailsSection>

                    <DetailsSection title="请求内容">
                        <p className="mb-0 max-h-72 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-6 text-zinc-700 dark:text-zinc-300">{task.prompt || "无请求摘要"}</p>
                    </DetailsSection>

                    {task.error ? (
                        <DetailsSection title="失败原因" tone="danger">
                            <p className="mb-0 whitespace-pre-wrap break-words text-sm leading-6 text-rose-700 dark:text-rose-300">{task.error}</p>
                        </DetailsSection>
                    ) : null}

                    <DetailsSection title="规划与执行">
                        <AgentPlannerAuditSummary task={task} />
                        <AgentFailureSummary task={task} />
                        <div className="mt-3">
                            <GenerationTaskRuntimeSummary task={task} />
                        </div>
                    </DetailsSection>

                    <DetailsSection title="时间记录">
                        <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
                            <DetailFact label="创建时间" value={dateTimeLabel(task.createdAt)} />
                            <DetailFact label="更新时间" value={dateTimeLabel(task.updatedAt)} />
                            <DetailFact label="最后心跳" value={dateTimeLabel(task.lastHeartbeatAt)} />
                            <DetailFact label="最后查询" value={dateTimeLabel(task.lastPollAt)} />
                        </div>
                    </DetailsSection>
                </div>
            ) : null}
        </Drawer>
    );
}

function DetailsSection({ title, children, tone = "default" }: { title: string; children: React.ReactNode; tone?: "default" | "danger" }) {
    return (
        <section className={`rounded-lg border p-3.5 ${tone === "danger" ? "border-rose-200 bg-rose-50/60 dark:border-rose-900/70 dark:bg-rose-950/20" : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/60"}`}>
            <h3 className="mb-3 text-xs font-semibold text-zinc-950 dark:text-zinc-100">{title}</h3>
            {children}
        </section>
    );
}

function DetailFact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
    return (
        <div className="min-w-0">
            <div className="text-[11px] text-zinc-400 dark:text-zinc-500">{label}</div>
            <Tooltip title={value}>
                <div className={`mt-1 truncate text-xs text-zinc-700 dark:text-zinc-300 ${mono ? "font-mono" : ""}`}>{value}</div>
            </Tooltip>
        </div>
    );
}

function dateTimeLabel(value?: number) {
    if (!value || !Number.isFinite(value)) return "未记录";
    return new Date(value).toLocaleString("zh-CN", { hour12: false });
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
