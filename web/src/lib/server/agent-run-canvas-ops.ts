import type { AgentRunTask } from "@/lib/server/agent-run-store";
import type { AgentPlan } from "@/lib/server/agent-run-validation";

import { agentCanvasOutputNodeIds, agentCanvasTaskNodeId } from "./agent-run-canvas-node-ids";
import { agentTaskResultItems } from "./agent-run-result-items";
import { canvasSnapshotNodes, canvasTaskSourceNodeIds } from "./agent-run-task-input";

const WORK_COLUMN_X = 400;
const OUTPUT_COLUMN_X = 800;
const START_Y = 96;
const ROW_GAP = 300;

export function planToOps(plan: AgentPlan, tasks: AgentRunTask[], runId: string, snapshot: unknown) {
    const snapshotNodeMap = canvasSnapshotNodes(snapshot);
    if (tasks.length === 1 && tasks[0]?.type === "text" && tasks[0].targetNodeId && snapshotNodeMap.get(tasks[0].targetNodeId)?.type === "text") return [];
    const briefId = `brief-${runId}`;
    const brandId = `brand-${runId}`;
    const ops: Array<Record<string, unknown>> = [
        {
            type: "add_node",
            id: briefId,
            nodeType: "brief",
            title: "创作简报",
            position: { x: 0, y: START_Y },
            metadata: { agentRunId: runId, agentBrief: { ...plan.foundation.brief, deliverables: plan.deliverables } },
        },
        { type: "add_node", id: brandId, nodeType: "brand-kit", title: "视觉方向", position: { x: 0, y: START_Y + 320 }, metadata: { agentRunId: runId, brandKit: { ...plan.foundation.direction, approvedNodeIds: [], rejectedNodeIds: [] } } },
    ];
    const taskNodeIds = new Map(tasks.map((task, index) => [task.id, agentCanvasTaskNodeId(runId, index)]));
    const existingNodeIds = new Set(snapshotNodeMap.keys());

    tasks.forEach((task, index) => {
        const taskNodeId = agentCanvasTaskNodeId(runId, index);
        const targetNodeId = task.targetNodeId && existingNodeIds.has(task.targetNodeId) ? task.targetNodeId : undefined;
        const outputNodeIds = task.type === "text" ? [] : agentCanvasOutputNodeIds(runId, index, task);
        const sourceNodeIds = canvasTaskSourceNodeIds(task, existingNodeIds);
        ops.push(
            {
                type: "add_node",
                id: taskNodeId,
                nodeType: "task",
                title: task.title,
                position: { x: WORK_COLUMN_X, y: START_Y + index * ROW_GAP },
                metadata: {
                    agentRunId: runId,
                    agentTaskId: task.id,
                    targetNodeId,
                    model: task.model,
                    prompt: task.prompt,
                    agentTaskType: task.type,
                    agentTaskStatus: "ready",
                    agentTaskAttempts: 0,
                    agentTaskDependencies: task.dependencies,
                    agentTaskOutputNodeIds: outputNodeIds,
                },
            },
            { type: "connect_nodes", fromNodeId: briefId, toNodeId: taskNodeId },
            { type: "connect_nodes", fromNodeId: brandId, toNodeId: taskNodeId },
        );
        if (targetNodeId) ops.push({ type: "connect_nodes", fromNodeId: targetNodeId, toNodeId: taskNodeId });
        for (const dependency of task.dependencies) {
            const dependencyNodeId = taskNodeIds.get(dependency);
            if (dependencyNodeId) ops.push({ type: "connect_nodes", fromNodeId: dependencyNodeId, toNodeId: taskNodeId });
        }
        outputNodeIds.forEach((outputNodeId, copyIndex) => {
            ops.push(
                {
                    type: "add_node",
                    id: outputNodeId,
                    nodeType: task.type,
                    title: outputNodeIds.length > 1 ? `${task.title} ${copyIndex + 1}` : task.title,
                    position: { x: OUTPUT_COLUMN_X + copyIndex * 380, y: START_Y + index * ROW_GAP },
                    metadata: outputMetadata(runId, task, "loading"),
                },
                { type: "connect_nodes", fromNodeId: taskNodeId, toNodeId: outputNodeId },
                ...sourceNodeIds.map((sourceNodeId) => ({ type: "connect_nodes", fromNodeId: sourceNodeId, toNodeId: outputNodeId })),
            );
        });
    });
    return ops;
}

export function taskCanvasEventOps(runId: string, index: number, task: AgentRunTask, eventType: string, childTaskId?: string) {
    if (eventType === "task.completed") return taskResultOps(runId, index, task);
    if (eventType === "task.child.completed" || eventType === "task.child.failed") return taskChildResultOps(runId, index, task, eventType, childTaskId);
    if (!new Set(["task.running", "task.created", "task.needs_review", "task.failed"]).has(eventType)) return null;
    const taskNodeId = agentCanvasTaskNodeId(runId, index);
    const nodeIds = task.type === "text" ? [] : agentCanvasOutputNodeIds(runId, index, task);
    const failed = eventType === "task.failed";
    const needsReview = eventType === "task.needs_review";
    const taskIds = task.taskIds?.length ? task.taskIds : task.taskId ? [task.taskId] : undefined;
    const partialFailure = failed && task.type !== "text" && task.childTasks?.some((child) => child.status === "completed") ? failedTaskOutputOps(runId, index, task) : null;
    const ops: Array<Record<string, unknown>> = [
        {
            type: "update_node",
            id: taskNodeId,
            metadata: {
                agentTaskStatus: failed ? "failed" : needsReview ? "needs_review" : "running",
                agentTaskAttempts: task.attempts,
                agentTaskError: failed || needsReview ? task.error : "",
                agentTaskOutputNodeIds: nodeIds,
                agentGenerationTaskIds: taskIds || [],
            },
        },
        ...(partialFailure?.ops ||
            nodeIds.map((id) => ({
                type: "update_node",
                id,
                metadata: {
                    ...outputMetadata(runId, task, failed ? "error" : needsReview ? "needs_review" : "loading"),
                    errorDetails: failed ? task.error || "生成任务失败" : needsReview ? task.error || "上游创建结果待确认" : undefined,
                    agentGenerationTaskIds: taskIds || [],
                },
            }))),
    ];
    return { nodeIds: partialFailure?.nodeIds || nodeIds, ops };
}

function taskChildResultOps(runId: string, index: number, task: AgentRunTask, eventType: string, childTaskId?: string) {
    if (task.type === "text") return null;
    const childIndex = task.childTasks?.findIndex((child) => child.id === childTaskId) ?? -1;
    const outputNodeId = childIndex >= 0 ? agentCanvasOutputNodeIds(runId, index, task)[childIndex] : undefined;
    if (!outputNodeId) return null;
    const child = task.childTasks?.[childIndex];
    const sourceNodeIds = canvasTaskSourceNodeIds(task);
    const failed = eventType === "task.child.failed";
    const completedCount = task.childTasks?.filter((item) => item.status === "completed").length || 0;
    const failedCount = task.childTasks?.filter((item) => item.status === "failed").length || 0;
    return {
        nodeIds: [outputNodeId],
        ops: [
            {
                type: "update_node",
                id: outputNodeId,
                metadata: failed
                    ? { ...outputMetadata(runId, task, "error"), errorDetails: child?.error || "生成任务失败", agentGenerationTaskIds: child?.id ? [child.id] : [] }
                    : { ...completedMediaMetadata(task, agentTaskResultItems(child?.result)[0] || {}), agentRunId: runId, agentTaskId: task.id, agentTaskType: task.type, agentGenerationTaskIds: child?.id ? [child.id] : [] },
            },
            {
                type: "update_node",
                id: agentCanvasTaskNodeId(runId, index),
                metadata: { agentTaskStatus: "running", agentTaskCompletedCount: completedCount, agentTaskFailedCount: failedCount },
            },
            ...sourceNodeIds.map((sourceNodeId) => ({ type: "connect_nodes", fromNodeId: sourceNodeId, toNodeId: outputNodeId })),
        ],
    };
}

export function cancelledRunCanvasOps(runId: string, tasks: AgentRunTask[]) {
    return tasks.flatMap((task, index) => {
        if (task.status !== "cancelled") return [];
        const outputNodeIds = task.type === "text" ? [] : agentCanvasOutputNodeIds(runId, index, task);
        return [
            {
                type: "update_node",
                id: agentCanvasTaskNodeId(runId, index),
                metadata: { agentTaskStatus: "cancelled", agentTaskError: "任务已取消" },
            },
            ...outputNodeIds.map((id) => ({
                type: "update_node",
                id,
                metadata: { status: "cancelled", agentTaskStatus: "cancelled", errorDetails: "任务已取消" },
            })),
        ];
    });
}

export function taskResultOps(runId: string, index: number, task: AgentRunTask) {
    const taskNodeId = agentCanvasTaskNodeId(runId, index);
    const results = agentTaskResultItems(task.result);
    if (task.type === "text" && task.targetNodeId) {
        const content = String(results[0]?.content || "").trim();
        const nodeIds = [task.targetNodeId];
        return {
            nodeIds,
            ops: [
                { type: "update_node", id: task.targetNodeId, metadata: { content, prompt: content, status: "success", agentRunId: runId } },
                { type: "select_nodes", ids: nodeIds },
            ],
        };
    }

    const plannedNodeIds = agentCanvasOutputNodeIds(runId, index, task);
    const nodeIds = results.map((_, resultIndex) => `output-${runId}-${index}-${resultIndex}`);
    const sourceNodeIds = canvasTaskSourceNodeIds(task);
    const ops: Array<Record<string, unknown>> = results.flatMap((record, resultIndex) => {
        const outputNodeId = nodeIds[resultIndex];
        const metadata = task.type === "text" ? { content: String(record.content || ""), status: "success" } : completedMediaMetadata(task, record);
        const nodeOp =
            task.type === "text"
                ? {
                      type: "add_node",
                      id: outputNodeId,
                      nodeType: task.type,
                      title: results.length > 1 ? `${task.title} ${resultIndex + 1}` : task.title,
                      position: { x: OUTPUT_COLUMN_X + resultIndex * 380, y: START_Y + index * ROW_GAP },
                      metadata: { ...metadata, agentRunId: runId, agentTaskId: task.id, agentTaskType: task.type },
                  }
                : plannedNodeIds.includes(outputNodeId)
                  ? {
                        type: "update_node",
                        id: outputNodeId,
                        patch: { title: results.length > 1 ? `${task.title} ${resultIndex + 1}` : task.title },
                        metadata: { ...metadata, agentRunId: runId, agentTaskId: task.id, agentTaskType: task.type, agentGenerationTaskIds: task.taskIds?.length ? task.taskIds : task.taskId ? [task.taskId] : [] },
                    }
                  : {
                        type: "add_node",
                        id: outputNodeId,
                        nodeType: task.type,
                        title: `${task.title} ${resultIndex + 1}`,
                        position: { x: OUTPUT_COLUMN_X + resultIndex * 380, y: START_Y + index * ROW_GAP },
                        metadata: { ...metadata, agentRunId: runId, agentTaskId: task.id, agentTaskType: task.type, agentGenerationTaskIds: task.taskIds?.length ? task.taskIds : task.taskId ? [task.taskId] : [] },
                    };
        return [nodeOp, { type: "connect_nodes", fromNodeId: taskNodeId, toNodeId: outputNodeId }, ...sourceNodeIds.map((sourceNodeId) => ({ type: "connect_nodes", fromNodeId: sourceNodeId, toNodeId: outputNodeId }))];
    });
    ops.push({ type: "update_node", id: taskNodeId, metadata: { agentTaskStatus: "completed", agentTaskOutputNodeIds: nodeIds, agentTaskAttempts: task.attempts, agentTaskError: "" } });
    if (task.type === "text" && nodeIds.length) ops.push({ type: "select_nodes", ids: nodeIds });
    return { nodeIds, ops };
}

function outputMetadata(runId: string, task: AgentRunTask, status: "loading" | "needs_review" | "error") {
    return {
        agentRunId: runId,
        agentTaskId: task.id,
        agentTaskType: task.type,
        model: task.model,
        prompt: task.prompt,
        size: task.ratio,
        quality: task.quality,
        count: task.count,
        seconds: task.seconds ? String(task.seconds) : undefined,
        audioVoice: task.voice,
        audioFormat: task.format,
        status,
        errorDetails: "",
    };
}

function completedMediaMetadata(task: AgentRunTask, record: Record<string, unknown>) {
    const content = [record.serverUrl, record.dataUrl, record.remoteUrl, record.url].find((item) => typeof item === "string" && item.trim());
    return {
        content: typeof content === "string" ? content : "",
        storageKey: text(record.storageKey),
        remoteUrl: text(record.remoteUrl) || (typeof record.url === "string" && /^https?:\/\//i.test(record.url) ? record.url : undefined),
        serverUrl: text(record.serverUrl) || (typeof record.url === "string" && !/^https?:\/\//i.test(record.url) ? record.url : undefined),
        mimeType: text(record.mimeType),
        naturalWidth: positiveNumber(record.width),
        naturalHeight: positiveNumber(record.height),
        bytes: positiveNumber(record.bytes),
        durationMs: positiveNumber(record.durationMs),
        size: task.ratio,
        status: "success",
        errorDetails: "",
    };
}

function positiveNumber(value: unknown) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : undefined;
}

function text(value: unknown) {
    return typeof value === "string" ? value.trim() || undefined : undefined;
}

function failedTaskOutputOps(runId: string, index: number, task: AgentRunTask) {
    const plannedCount = agentCanvasOutputNodeIds(runId, index, task).length;
    const entries: Array<{ status: "completed"; result: Record<string, unknown>; taskId: string } | { status: "failed"; error: string; taskId: string }> = [];
    for (const child of task.childTasks || []) {
        if (child.status === "completed") entries.push(...agentTaskResultItems(child.result).map((result) => ({ status: "completed" as const, result, taskId: child.id })));
        else entries.push({ status: "failed", error: child.error || task.error || "生成任务失败", taskId: child.id });
    }
    const missingChildren = Math.max(0, plannedCount - (task.childTasks?.length || 0));
    entries.push(...Array.from({ length: missingChildren }, () => ({ status: "failed" as const, error: task.error || "生成任务失败", taskId: "" })));
    const nodeIds = entries.map((_, resultIndex) => `output-${runId}-${index}-${resultIndex}`);
    const sourceNodeIds = canvasTaskSourceNodeIds(task);
    const ops = entries.flatMap((entry, resultIndex) => {
        const id = nodeIds[resultIndex];
        const metadata =
            entry.status === "completed"
                ? { ...completedMediaMetadata(task, entry.result), agentRunId: runId, agentTaskId: task.id, agentTaskType: task.type, agentGenerationTaskIds: entry.taskId ? [entry.taskId] : [] }
                : { ...outputMetadata(runId, task, "error"), errorDetails: entry.error, agentGenerationTaskIds: entry.taskId ? [entry.taskId] : [] };
        const nodeOp =
            resultIndex < plannedCount
                ? { type: "update_node", id, patch: { title: entries.length > 1 ? `${task.title} ${resultIndex + 1}` : task.title }, metadata }
                : { type: "add_node", id, nodeType: task.type, title: `${task.title} ${resultIndex + 1}`, position: { x: OUTPUT_COLUMN_X + resultIndex * 380, y: START_Y + index * ROW_GAP }, metadata };
        return [nodeOp, { type: "connect_nodes", fromNodeId: agentCanvasTaskNodeId(runId, index), toNodeId: id }, ...sourceNodeIds.map((sourceNodeId) => ({ type: "connect_nodes", fromNodeId: sourceNodeId, toNodeId: id }))];
    });
    return { nodeIds, ops };
}
