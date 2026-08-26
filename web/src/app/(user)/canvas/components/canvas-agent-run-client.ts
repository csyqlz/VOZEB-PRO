import type { CanvasAgentOp } from "../utils/canvas-agent-ops";
import type { CanvasAgentRunStage, CanvasAgentStableStageKey } from "./canvas-agent-progress";
import { getCreativeAgentRun } from "@/services/api/creative";
import { ClientSessionExpiredError, stopIfClientSessionExpired } from "@/services/api/session-expiration";

type RunHandlers = {
    onPlan: (ops: CanvasAgentOp[], reply: string) => void;
    onAssistant: (text: string, detail?: { nodeIds?: string[]; taskType?: "text" | "image" | "video" | "audio"; runId?: string; taskId?: string; title?: string }) => void;
    onStage: (stage: CanvasAgentRunStage) => void;
    onPaused: (paused: boolean) => void;
    onOps: (ops: CanvasAgentOp[]) => void;
};

export function watchCanvasAgentRun(runId: string, handlers: RunHandlers, options: { signal?: AbortSignal } = {}) {
    if (options.signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
        const stream = new EventSource(`/api/agent/runs/${encodeURIComponent(runId)}/events`);
        let appliedPlan = false;
        let connectionInterrupted = false;
        let reconciliation: Promise<void> | null = null;
        let settled = false;
        let paused: boolean | undefined;
        let latestStageKey: CanvasAgentStableStageKey = "planning";
        let latestOutput: { nodeIds?: string[]; taskType?: "text" | "image" | "video" | "audio" } | undefined;
        const completedOutputNodeIds = new Set<string>();
        let latestFailedTask: { taskId: string; title?: string } | undefined;
        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            stream.close();
            options.signal?.removeEventListener("abort", abort);
            if (error) reject(error);
            else resolve();
        };
        const abort = () => finish();
        options.signal?.addEventListener("abort", abort, { once: true });
        const listen = (type: string, listener: (event: Event) => void) =>
            stream.addEventListener(type, (event) => {
                if (!settled) listener(event);
            });
        const read = <T>(event: Event) => JSON.parse((event as MessageEvent<string>).data) as T;
        const setPaused = (value: boolean) => {
            if (paused === value) return;
            paused = value;
            handlers.onPaused(value);
        };
        const reportStage = (stage: CanvasAgentRunStage) => {
            if (stage.key !== "reconnecting") latestStageKey = stage.key;
            handlers.onStage(stage);
        };
        const reconcileRun = async () => {
            if (await stopIfClientSessionExpired()) {
                reportStage({ key: "reconnecting", resumeKey: latestStageKey, text: "登录状态已失效，任务仍可能在后台运行；重新登录后可继续查看" });
                finish();
                return;
            }
            try {
                const run = await getCreativeAgentRun(runId);
                if (settled) return;
                if (run.status === "completed") {
                    handlers.onAssistant("智能任务已完成，结果已经返回。", latestOutput);
                    finish();
                    return;
                }
                if (run.status === "cancelled") {
                    handlers.onAssistant("智能任务已取消。");
                    finish();
                    return;
                }
                if (run.status === "failed") {
                    const failed = run.tasks.find((task) => task.status === "failed");
                    if (!latestFailedTask && failed) handlers.onAssistant(`「${failed.title || "创作任务"}」执行失败：${failed.error || "生成服务暂时不可用"}`, { runId, taskId: failed.id, title: failed.title || "创作任务失败" });
                    else if (!latestFailedTask) handlers.onAssistant("智能任务执行失败", { runId, title: "智能任务执行失败" });
                    finish();
                    return;
                }
                setPaused(run.status === "paused");
                reportStage({ key: "reconnecting", resumeKey: latestStageKey, text: run.status === "paused" ? "任务仍在后台保存，当前处于暂停状态" : "任务仍在后台运行，正在恢复连接" });
            } catch (error) {
                if (settled) return;
                if (error instanceof ClientSessionExpiredError) {
                    reportStage({ key: "reconnecting", resumeKey: latestStageKey, text: "登录状态已失效，任务仍可能在后台运行；重新登录后可继续查看" });
                    finish();
                    return;
                }
                reportStage({ key: "reconnecting", resumeKey: latestStageKey, text: "暂时无法确认实时状态，任务仍会在后台继续运行" });
            }
        };

        listen("run.planning", () => reportStage({ key: "planning", text: "正在理解需求并分析当前画布" }));
        listen("skills.selected", () => reportStage({ key: "skills", text: "正在匹配合适的创作技能" }));
        listen("canvas.ops", (event) => {
            const payload = read<{ data?: { ops?: CanvasAgentOp[]; reply?: string } }>(event);
            if (!appliedPlan && payload.data?.ops?.length) {
                appliedPlan = true;
                handlers.onPlan(payload.data.ops, payload.data.reply || "创作计划已添加到画布，后台正在执行任务。");
            }
            reportStage({ key: "plan", text: "文本执行计划已生成，正在准备任务" });
        });
        listen("task.running", (event) => {
            const payload = read<{ data?: { title?: string; attempts?: number; ops?: CanvasAgentOp[] } }>(event);
            if (payload.data?.ops?.length) handlers.onOps(payload.data.ops);
            reportStage({ key: "executing", text: `正在执行「${payload.data?.title || "创作任务"}」${payload.data?.attempts ? `（第 ${payload.data.attempts} 次）` : ""}` });
        });
        listen("task.created", (event) => {
            const payload = read<{ data?: { ops?: CanvasAgentOp[] } }>(event);
            if (payload.data?.ops?.length) handlers.onOps(payload.data.ops);
        });
        listen("task.child.completed", (event) => {
            const payload = read<{ data?: ChildTaskEventData }>(event);
            if (payload.data?.ops?.length) handlers.onOps(payload.data.ops);
            for (const nodeId of payload.data?.outputNodeIds || []) completedOutputNodeIds.add(nodeId);
            latestOutput = { nodeIds: Array.from(completedOutputNodeIds), taskType: payload.data?.type };
            const progress = childProgressText(payload.data);
            reportStage({ key: "executing", text: progress });
            handlers.onAssistant(progress, latestOutput);
        });
        listen("task.child.failed", (event) => {
            const payload = read<{ data?: ChildTaskEventData }>(event);
            if (payload.data?.ops?.length) handlers.onOps(payload.data.ops);
            const progress = childProgressText(payload.data);
            reportStage({ key: "executing", text: progress });
            handlers.onAssistant(progress, latestOutput);
        });
        listen("task.completed", (event) => {
            const payload = read<{ data?: { message?: string; title?: string; outputNodeIds?: string[]; type?: "text" | "image" | "video" | "audio"; ops?: CanvasAgentOp[] } }>(event);
            if (payload.data?.ops?.length) handlers.onOps(payload.data.ops);
            latestOutput = { nodeIds: payload.data?.outputNodeIds, taskType: payload.data?.type };
            handlers.onAssistant(payload.data?.message || `「${payload.data?.title || "创作任务"}」已完成，正在继续处理。`, latestOutput);
        });
        listen("task.failed", (event) => {
            const payload = read<{ data?: { taskId?: string; title?: string; error?: string; ops?: CanvasAgentOp[] } }>(event);
            if (payload.data?.ops?.length) handlers.onOps(payload.data.ops);
            if (!payload.data?.taskId) return;
            latestFailedTask = { taskId: payload.data.taskId, title: payload.data.title };
            handlers.onAssistant(`「${payload.data.title || "创作任务"}」执行失败：${payload.data.error || "生成服务暂时不可用"}`, { taskType: undefined, nodeIds: [], ...latestFailedTask, runId });
        });
        listen("task.retry.requested", (event) => {
            const payload = read<{ data?: { ops?: CanvasAgentOp[] } }>(event);
            if (payload.data?.ops?.length) handlers.onOps(payload.data.ops);
        });
        listen("run.review.retry", () => reportStage({ key: "reviewing", text: "发现可优化内容，正在重新生成" }));
        listen("run.review.passed", () => reportStage({ key: "finalizing", text: "检查完成，正在整理结果" }));
        listen("run.review.unavailable", () => reportStage({ key: "finalizing", text: "正在整理已完成结果" }));
        listen("run.completed", (event) => {
            const payload = read<{ data?: { reply?: string } }>(event);
            handlers.onAssistant(payload.data?.reply || "创作计划与后台生成任务已全部完成。", latestOutput);
            finish();
        });
        listen("run.failed", (event) => {
            const payload = read<{ data?: { message?: string } }>(event);
            if (!latestFailedTask) handlers.onAssistant(payload.data?.message || "智能任务执行失败", { runId, title: "智能任务执行失败" });
            finish();
        });
        listen("run.cancelled", (event) => {
            const payload = read<{ data?: { ops?: CanvasAgentOp[] } }>(event);
            if (payload.data?.ops?.length) handlers.onOps(payload.data.ops);
            handlers.onAssistant("智能任务已取消。");
            finish();
        });
        listen("run.paused", () => {
            setPaused(true);
            reportStage({ key: "paused", text: "任务已暂停" });
        });
        listen("run.resumed", () => {
            setPaused(false);
            reportStage({ key: "executing", text: "任务已恢复，正在继续执行" });
        });
        listen("run.snapshot", (event) => {
            const payload = read<{ status?: string; tasks?: Array<{ id?: string; title?: string; status?: string; error?: string }> }>(event);
            if (payload.status === "cancelled") {
                handlers.onAssistant("智能任务已取消。");
                finish();
            }
            if (payload.status === "completed") {
                handlers.onAssistant("智能任务已完成，结果已经返回。");
                finish();
            }
            if (payload.status === "failed") {
                const failed = payload.tasks?.find((task) => task.status === "failed" && task.id);
                if (!latestFailedTask && failed?.id) handlers.onAssistant(`「${failed.title || "创作任务"}」执行失败：${failed.error || "生成服务暂时不可用"}`, { runId, taskId: failed.id, title: failed.title || "创作任务失败" });
                else if (!latestFailedTask) handlers.onAssistant("智能任务执行失败", { runId, title: "智能任务执行失败" });
                finish();
            }
            if (payload.status === "paused") setPaused(true);
            if (payload.status === "planning" || payload.status === "running") setPaused(false);
        });
        stream.onopen = () => {
            if (connectionInterrupted && !settled) reportStage({ key: latestStageKey, text: "连接已恢复，任务继续运行" });
            connectionInterrupted = false;
        };
        stream.onerror = () => {
            if (settled) return;
            connectionInterrupted = true;
            reportStage({ key: "reconnecting", resumeKey: latestStageKey, text: "连接暂时中断，正在确认后台任务状态" });
            reconciliation ||= reconcileRun().finally(() => {
                reconciliation = null;
            });
        };
    });
}

type ChildTaskEventData = {
    title?: string;
    type?: "text" | "image" | "video" | "audio";
    completedCount?: number;
    failedCount?: number;
    totalCount?: number;
    outputNodeIds?: string[];
    ops?: CanvasAgentOp[];
};

function childProgressText(data?: ChildTaskEventData) {
    const completed = nonNegativeCount(data?.completedCount);
    const failed = nonNegativeCount(data?.failedCount);
    const total = Math.max(1, nonNegativeCount(data?.totalCount));
    return `「${data?.title || "创作任务"}」已完成 ${completed}/${total}${failed ? `，失败 ${failed}` : ""}`;
}

function nonNegativeCount(value: unknown) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}
