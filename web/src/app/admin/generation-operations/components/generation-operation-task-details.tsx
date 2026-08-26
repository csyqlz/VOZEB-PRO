import { Tag, Tooltip } from "antd";

import type { AdminGenerationTask } from "@/lib/admin-generation-operations";
import { generationOperationThemeClasses } from "./generation-operations-theme";

export function AgentPlannerAuditSummary({ task }: { task: AdminGenerationTask }) {
    const audit = task.plannerAudit;
    if (!audit) return null;
    return (
        <div className="mt-1.5 space-y-1 text-[11px] leading-4 text-zinc-500 dark:text-zinc-400">
            <div className="truncate">
                计划 Schema v{audit.schemaVersion} · {audit.mode === "direct" ? "用户直选模型" : planningProtocolLabel(audit.protocol)}
            </div>
            {audit.channelId || audit.upstreamModel ? (
                <Tooltip title={[audit.channelId, audit.upstreamModel].filter(Boolean).join(" → ")}>
                    <div className="truncate">{[audit.channelId, audit.upstreamModel].filter(Boolean).join(" → ")}</div>
                </Tooltip>
            ) : null}
            {audit.skills.length ? (
                <div className="flex min-w-0 flex-wrap gap-1">
                    {audit.skills.map((skill) => (
                        <Tooltip key={skill.id} title={skillSourceLabel(skill)}>
                            <Tag className={generationOperationThemeClasses.neutralTag}>{skill.name}</Tag>
                        </Tooltip>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

export function GenerationTaskRuntimeSummary({ task, compact = false }: { task: AdminGenerationTask; compact?: boolean }) {
    return (
        <div className={compact ? "mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-900" : "space-y-1 text-xs text-zinc-500 dark:text-zinc-400"}>
            <div className="flex flex-wrap items-center gap-1.5">
                <Tag className={generationOperationThemeClasses.neutralTag}>{executionPhaseLabel(task.executionPhase)}</Tag>
                {task.leaseExpired ? <Tag className={generationOperationThemeClasses.reviewTag}>Worker 租约已过期</Tag> : null}
            </div>
            <div className={compact ? "mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-xs" : "mt-1 space-y-1"}>
                <RuntimeFact label="Worker" value={task.workerId || "未认领"} />
                <RuntimeFact label="心跳" value={operationTimeLabel(task.lastHeartbeatAt)} />
                <RuntimeFact label="租约" value={operationTimeLabel(task.leaseUntil)} />
                <RuntimeFact label="下次查询" value={operationTimeLabel(task.nextPollAt)} />
                {task.provider ? <RuntimeFact label="Provider" value={task.provider} /> : null}
                {task.queryPath ? <RuntimeFact label="查询路径" value={task.queryPath} /> : null}
            </div>
        </div>
    );
}

export function generationTaskPointsLabel(task: AdminGenerationTask) {
    const breakdown = task.pointsBreakdown;
    return breakdown ? `规划 ¥${breakdown.planner} · 子任务 ¥${breakdown.childTasks} · 合计 ¥${breakdown.total}` : `¥${task.pointsCost}`;
}

export function planningProtocolLabel(protocol?: "responses" | "chat" | "gemini" | "custom") {
    if (protocol === "responses") return "Responses";
    if (protocol === "gemini") return "Gemini";
    if (protocol === "custom") return "自定义协议";
    if (protocol === "chat") return "Chat Completions";
    return "未记录协议";
}

export function executionPhaseLabel(value?: AdminGenerationTask["executionPhase"]) {
    return ({ created: "已创建", submitting: "提交中", submitted: "已提交", polling: "查询结果", result_ready: "结果待保存", persisting: "保存结果", needs_review: "待人工确认", completed: "已结束" } as Record<string, string>)[value || ""] || "未记录阶段";
}

function RuntimeFact({ label, value }: { label: string; value: string }) {
    return (
        <Tooltip title={value}>
            <div className="min-w-0 truncate">
                <span className="text-zinc-400 dark:text-zinc-500">{label}：</span>
                {value}
            </div>
        </Tooltip>
    );
}

function operationTimeLabel(value?: number) {
    if (!value || !Number.isFinite(value)) return "未记录";
    return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function skillSourceLabel(skill: NonNullable<AdminGenerationTask["plannerAudit"]>["skills"][number]) {
    const source = [skill.sourceVersion ? `版本 ${skill.sourceVersion}` : "", skill.sourceCommit ? `提交 ${skill.sourceCommit}` : "", skill.sourceContentHash ? `内容哈希 ${skill.sourceContentHash}` : ""].filter(Boolean);
    return source.length ? source.join(" · ") : `Skill ID：${skill.id}`;
}
