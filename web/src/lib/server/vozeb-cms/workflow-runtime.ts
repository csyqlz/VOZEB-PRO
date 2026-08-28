import { getStoredGenerationTaskRecordForUser, listStoredGenerationTaskRecordsByRunIds } from "@/lib/server/generation-task-store";
import { generationTaskNextPollAt } from "@/lib/server/generation-task-scheduler";
import { claimVozebCmsWorkflowRun, createVozebCmsWorkflowRun, getVozebCmsWorkflowDefinition, getVozebCmsWorkflowRun, mutateVozebCmsWorkflowRun, releaseVozebCmsWorkflowRunLease, renewVozebCmsWorkflowRunLease } from "@/lib/server/vozeb-cms/workflow-store";
import { persistVozebCmsWorkflowOutputAssets } from "@/lib/server/vozeb-cms/workflow-output";
import { getVozebCmsBuiltInWorkflowNodeExecutor } from "@/lib/server/vozeb-cms/workflow-default-executors";
import type { NodeExecutionResult, NodeExecutor } from "@/lib/server/vozeb-cms/workflow-execution-contract";
import { assertVozebCmsModuleEnabled, assertVozebCmsUserCapability, VozebCmsModuleAccessError } from "@/lib/server/vozeb-cms/module-service";
import { isVozebCmsModuleId, type VozebCmsModuleId } from "@/lib/vozeb-cms/module-contract";
import type { VozebCmsWorkflowDefinition, VozebCmsWorkflowNodeDefinition, VozebCmsWorkflowNodeState, VozebCmsWorkflowRun } from "@/lib/vozeb-cms/workflow-contract";
import { createVozebCmsWorkflowRun as createRun, getVozebCmsWorkflowRunDefinition } from "@/lib/vozeb-cms/workflow-contract";

export type { NodeExecutionResult, NodeExecutor } from "@/lib/server/vozeb-cms/workflow-execution-contract";
const adapters = new Map<string, NodeExecutor>();
const activeAdvances = new Map<string, Promise<VozebCmsWorkflowRun | null>>();
const WORKER_ID = `workflow-worker:${process.pid}:${Math.random().toString(36).slice(2, 10)}`;
const WORKFLOW_LEASE_MS = 120_000;

export function registerVozebCmsWorkflowNodeExecutor(kind: "agent" | "ai" | "task", executor: NodeExecutor) {
    adapters.set(kind, executor);
    return () => adapters.delete(kind);
}

export async function createVozebCmsWorkflowRunForUser(userId: string, workflowId: string, context: Record<string, unknown>, idempotencyKey?: string) {
    const definition = await requiredDefinition(userId, workflowId);
    if (!definition.enabled) throw new VozebCmsWorkflowRuntimeError("工作流已停用", 403);
    await assertWorkflowAccess(userId, definition);
    return createVozebCmsWorkflowRun(createRun(definition, userId, context, idempotencyKey));
}

/** Read a run and advance it only when its durable next-run timestamp is due. */
export async function getRecoverableVozebCmsWorkflowRun(userId: string, runId: string, now = Date.now()) {
    const run = await getVozebCmsWorkflowRun(userId, runId);
    if (!run || !workflowRunIsDue(run, now)) return run;
    return (await advanceVozebCmsWorkflowRun(userId, runId)) || run;
}

export async function advanceVozebCmsWorkflowRun(userId: string, runId: string, options: { owner?: string; claimed?: boolean } = {}) {
    const current = activeAdvances.get(runId);
    if (current) return current;
    const owner = options.owner?.trim() || WORKER_ID;
    const operation = (async () => {
        const claimed = options.claimed === true || (await claimVozebCmsWorkflowRun(userId, runId, owner, WORKFLOW_LEASE_MS));
        if (!claimed) return getVozebCmsWorkflowRun(userId, runId);
        try {
            return await advance(userId, runId, owner);
        } finally {
            await releaseVozebCmsWorkflowRunLease(userId, runId, owner);
        }
    })().finally(() => activeAdvances.delete(runId));
    activeAdvances.set(runId, operation);
    return operation;
}

export async function controlVozebCmsWorkflowRun(userId: string, runId: string, action: "pause" | "resume" | "cancel" | "retry") {
    const run = await requiredRun(userId, runId);
    if (action === "pause") {
        if (!["pending", "running", "waiting"].includes(run.status)) throw new VozebCmsWorkflowRuntimeError("当前工作流无法暂停", 409);
        return mutateVozebCmsWorkflowRun(userId, runId, (current) => ({ run: { ...current, status: "paused", nextRunAt: undefined }, event: { type: "workflow.paused" } }));
    }
    if (action === "resume") {
        if (!["paused", "waiting"].includes(run.status)) throw new VozebCmsWorkflowRuntimeError("只有暂停或等待中的工作流可以恢复", 409);
        await assertWorkflowAccess(userId, requiredDefinitionSnapshot(run));
        await mutateVozebCmsWorkflowRun(userId, runId, (current) => ({ run: { ...current, status: "running", error: undefined, nextRunAt: Date.now() }, event: { type: "workflow.resumed" } }));
        return advanceVozebCmsWorkflowRun(userId, runId);
    }
    if (action === "cancel") {
        if (["completed", "failed", "cancelled"].includes(run.status)) throw new VozebCmsWorkflowRuntimeError("工作流已经结束", 409);
        await cancelBoundGenerationTasks(run);
        return mutateVozebCmsWorkflowRun(userId, runId, (current) => ({ run: { ...current, status: "cancelled", nextRunAt: undefined, nodeStates: cancelOpenNodes(current.nodeStates) }, event: { type: "workflow.cancelled" } }));
    }
    if (run.status !== "failed") throw new VozebCmsWorkflowRuntimeError("只有失败的工作流可以重试", 409);
    await assertWorkflowAccess(userId, requiredDefinitionSnapshot(run));
    await retryBoundGenerationTasks(run);
    await mutateVozebCmsWorkflowRun(userId, runId, (current) => ({ run: { ...current, status: "running", error: undefined, nextRunAt: Date.now(), nodeStates: retryFailedNodes(current.nodeStates) }, event: { type: "workflow.retry.requested" } }));
    return advanceVozebCmsWorkflowRun(userId, runId);
}

export async function reviewVozebCmsWorkflowNode(userId: string, runId: string, nodeId: string, decision: "approved" | "rejected") {
    const run = await requiredRun(userId, runId);
    const definition = requiredDefinitionSnapshot(run);
    await assertWorkflowAccess(userId, definition);
    const node = definition.nodes.find((item) => item.id === nodeId);
    if (!node || node.kind !== "manual_review") throw new VozebCmsWorkflowRuntimeError("审核节点不存在", 404);
    const state = run.nodeStates[nodeId];
    if (!state || state.status !== "waiting") throw new VozebCmsWorkflowRuntimeError("当前节点不在待审核状态", 409);
    await mutateVozebCmsWorkflowRun(userId, runId, (current) => ({
        run: {
            ...current,
            status: decision === "approved" ? "running" : "failed",
            nextRunAt: decision === "approved" ? Date.now() : undefined,
            error: decision === "approved" ? undefined : "人工审核未通过",
            nodeStates: {
                ...current.nodeStates,
                [nodeId]: { ...current.nodeStates[nodeId], status: decision === "approved" ? "success" : "failed", reviewDecision: decision, updatedAt: Date.now(), ...(decision === "rejected" ? { error: "人工审核未通过" } : {}) },
            },
        },
        event: { type: decision === "approved" ? "node.review.approved" : "node.review.rejected", data: { nodeId } },
    }));
    return decision === "approved" ? advanceVozebCmsWorkflowRun(userId, runId) : requiredRun(userId, runId);
}

async function advance(userId: string, runId: string, owner: string): Promise<VozebCmsWorkflowRun | null> {
    let run = await requiredRun(userId, runId);
    const definition = requiredDefinitionSnapshot(run);
    try {
        await assertWorkflowAccess(userId, definition);
    } catch (error) {
        if (!(error instanceof VozebCmsWorkflowRuntimeError) || error.status !== 403) throw error;
        if (["paused", "completed", "failed", "cancelled"].includes(run.status)) return run;
        if (run.status === "waiting" && run.error === error.message) return run;
        return (
            (await mutateVozebCmsWorkflowRun(
                userId,
                runId,
                (current) => ({
                    run: { ...current, status: "waiting", error: error.message, nextRunAt: undefined },
                    event: { type: "workflow.blocked", data: { reason: error.message } },
                }),
                owner,
            )) || run
        );
    }
    if (run.status === "pending") {
        run = (await mutateVozebCmsWorkflowRun(userId, runId, (current) => ({ run: { ...current, status: "running", nextRunAt: undefined }, event: { type: "workflow.started" } }), owner)) || run;
    } else if (run.status === "waiting" && run.error) {
        run = (await mutateVozebCmsWorkflowRun(userId, runId, (current) => ({ run: { ...current, status: "running", error: undefined, nextRunAt: undefined }, event: { type: "workflow.unblocked" } }), owner)) || run;
    } else if (run.status === "waiting" && hasRecheckableWaitingNode(definition, run)) {
        run = { ...run, status: "running" };
    }
    while (run && run.status === "running") {
        const selection = nextRunnableNode(definition, run);
        if (selection.skipNodeId) {
            run =
                (await mutateVozebCmsWorkflowRun(
                    userId,
                    runId,
                    (current) => ({
                        run: { ...current, nodeStates: { ...current.nodeStates, [selection.skipNodeId!]: { ...current.nodeStates[selection.skipNodeId!], status: "skipped", output: { result: false }, updatedAt: Date.now() } } },
                        event: { type: "node.skipped", data: { nodeId: selection.skipNodeId } },
                    }),
                    owner,
                )) || run;
            continue;
        }
        const candidate = selection.node;
        if (!candidate) {
            const states = Object.values(run.nodeStates);
            if (states.some((state) => state.status === "waiting" || state.status === "running")) {
                const nextRunAt = nextWorkflowRunAt(definition, run);
                run =
                    (await mutateVozebCmsWorkflowRun(
                        userId,
                        runId,
                        (current) => ({
                            run: { ...current, status: "waiting", nextRunAt },
                            ...(current.status === "waiting" ? {} : { event: { type: "workflow.waiting", data: { nextRunAt } } }),
                        }),
                        owner,
                    )) || run;
                return run;
            }
            if (states.every((state) => ["success", "skipped"].includes(state.status))) {
                run = (await mutateVozebCmsWorkflowRun(userId, runId, (current) => ({ run: { ...current, status: "completed", nextRunAt: undefined }, event: { type: "workflow.completed" } }), owner)) || run;
                return run;
            }
            if (states.some((state) => state.status === "failed")) {
                run =
                    (await mutateVozebCmsWorkflowRun(
                        userId,
                        runId,
                        (current) => ({
                            run: { ...current, status: "failed", nextRunAt: undefined, error: current.error || "工作流依赖节点失败" },
                            event: { type: "workflow.failed", data: { reason: current.error || "dependency_failed" } },
                        }),
                        owner,
                    )) || run;
                return run;
            }
            return run;
        }
        const nodeState = run.nodeStates[candidate.id];
        const attempts = nodeState.status === "pending" ? nodeState.attempts + 1 : nodeState.attempts;
        const started =
            nodeState.status === "pending"
                ? (await mutateVozebCmsWorkflowRun(
                      userId,
                      runId,
                      (current) => ({
                          run: { ...current, nodeStates: { ...current.nodeStates, [candidate.id]: { ...current.nodeStates[candidate.id], status: "running", attempts, updatedAt: Date.now(), error: undefined } } },
                          event: { type: "node.started", data: { nodeId: candidate.id, kind: candidate.kind } },
                      }),
                      owner,
                  )) || run
                : { ...run, nodeStates: { ...run.nodeStates, [candidate.id]: { ...nodeState, status: "running" as const, attempts, updatedAt: Date.now(), error: undefined } } };
        run = started;
        const stopLeaseHeartbeat = startLeaseHeartbeat(userId, runId, owner);
        let execution: NodeExecutionResult;
        let leaseOwned = false;
        try {
            execution = await executeNode(userId, run, candidate, { ...nodeState, status: "running", attempts });
        } finally {
            const heartbeatHealthy = await stopLeaseHeartbeat();
            leaseOwned = heartbeatHealthy && (await renewVozebCmsWorkflowRunLease(userId, runId, owner, WORKFLOW_LEASE_MS));
        }
        if (!leaseOwned) return getVozebCmsWorkflowRun(userId, runId);
        if (execution.status === "success") {
            try {
                await persistVozebCmsWorkflowOutputAssets({ userId, run, node: candidate, taskId: execution.taskId, output: execution.output });
            } catch (error) {
                execution = { status: "failed", taskId: execution.taskId, error: error instanceof Error ? error.message : "工作流资产回写失败" };
            }
        }
        const nextStatus = execution.status === "success" ? "success" : execution.status === "waiting" ? "waiting" : "failed";
        run =
            (await mutateVozebCmsWorkflowRun(
                userId,
                runId,
                (current) => ({
                    run: {
                        ...current,
                        status: nextStatus === "failed" ? "failed" : nextStatus === "waiting" ? "waiting" : "running",
                        nextRunAt: nextStatus === "waiting" ? execution.nextRunAt : undefined,
                        error: nextStatus === "failed" ? execution.error || `${candidate.name} 执行失败` : undefined,
                        context: nextStatus === "success" ? mergeNodeOutputContext(current.context, candidate.id, execution.output, execution.taskId, execution.taskIds) : current.context,
                        nodeStates: {
                            ...current.nodeStates,
                            [candidate.id]: {
                                ...current.nodeStates[candidate.id],
                                status: nextStatus,
                                ...(execution.output !== undefined ? { output: execution.output } : {}),
                                ...(execution.taskId ? { taskId: execution.taskId } : {}),
                                ...(execution.taskIds?.length ? { taskIds: execution.taskIds } : {}),
                                error: execution.error,
                                updatedAt: Date.now(),
                            },
                        },
                    },
                    ...(nodeState.status !== "pending" && nextStatus === "waiting" ? {} : { event: { type: `node.${nextStatus}`, data: { nodeId: candidate.id, ...(execution.error ? { error: execution.error } : {}) } } }),
                }),
                owner,
            )) || run;
        if (nextStatus !== "success") return run;
    }
    return run;
}

async function executeNode(userId: string, run: VozebCmsWorkflowRun, node: VozebCmsWorkflowNodeDefinition, state: VozebCmsWorkflowNodeState): Promise<NodeExecutionResult> {
    await assertWorkflowNodeAccess(userId, node);
    if (node.kind === "manual_review") return state.reviewDecision === "approved" ? { status: "success", output: { decision: "approved" } } : { status: "waiting" };
    if (node.kind === "condition") {
        const passed = evaluateCondition(node.config, run);
        return { status: "success", output: { result: passed } };
    }
    const builtIn = getVozebCmsBuiltInWorkflowNodeExecutor(node, run);
    if (builtIn) return builtIn({ userId, run, node, state });
    const taskId = text(node.config.taskId) || state.taskId || taskIdFromContext(run.context, text(node.config.taskContextKey) || node.id);
    if (taskId) {
        const task = await getStoredGenerationTaskRecordForUser(taskId, userId);
        if (!task) return { status: "failed", error: "绑定的任务不存在或已过期" };
        await assertWorkflowCapability(userId, generationTaskCapabilityId(task.type));
        if (task.status === "success") return { status: "success", taskId, output: task.resultPayload || task.payload.result || task.payload.results || task.payload.output };
        if (task.status === "error" || task.status === "cancelled") return { status: "failed", taskId, error: String(task.payload.error || task.payload.message || `绑定任务${task.status === "cancelled" ? "已取消" : "失败"}`) };
        return { status: "waiting", taskId, nextRunAt: task.status === "paused" ? undefined : (positiveTime(task.nextPollAt) ?? generationTaskNextPollAt({ submittedAt: task.createdAt })) };
    }
    const adapter = adapters.get(node.kind);
    if (adapter) return adapter({ userId, run, node, state });
    if (Object.prototype.hasOwnProperty.call(node.config, "output")) return { status: "success", output: node.config.output };
    return { status: "failed", error: `${node.name} 尚未绑定 Action、任务或执行适配器` };
}

function nextRunnableNode(definition: VozebCmsWorkflowDefinition, run: VozebCmsWorkflowRun): { node?: VozebCmsWorkflowNodeDefinition; skipNodeId?: string } {
    for (const node of definition.nodes) {
        const state = run.nodeStates[node.id];
        if (!state || (state.status !== "pending" && ((state.status !== "waiting" && state.status !== "running") || node.kind === "manual_review"))) continue;
        const dependencies = node.dependsOn.map((id) => ({ node: definition.nodes.find((item) => item.id === id), state: run.nodeStates[id] }));
        if (dependencies.some((item) => !item.state || !["success", "skipped"].includes(item.state.status))) continue;
        if (dependencies.some((item) => ["success", "skipped"].includes(item.state?.status || "") && object(item.state.output).result === false)) {
            return { skipNodeId: node.id };
        }
        return { node };
    }
    return {};
}

function hasRecheckableWaitingNode(definition: VozebCmsWorkflowDefinition, run: VozebCmsWorkflowRun) {
    return definition.nodes.some((node) => node.kind !== "manual_review" && run.nodeStates[node.id]?.status === "waiting");
}

function nextWorkflowRunAt(definition: VozebCmsWorkflowDefinition, run: VozebCmsWorkflowRun) {
    return hasRecheckableWaitingNode(definition, run) ? positiveTime(run.nextRunAt) : undefined;
}

function startLeaseHeartbeat(userId: string, runId: string, owner: string) {
    const intervalMs = Math.max(1_000, Math.floor(WORKFLOW_LEASE_MS / 3));
    let stopped = false;
    let healthy = true;
    let pending = Promise.resolve();
    const renew = () => {
        pending = pending.then(async () => {
            if (stopped || !healthy) return;
            try {
                healthy = await renewVozebCmsWorkflowRunLease(userId, runId, owner, WORKFLOW_LEASE_MS);
            } catch {
                healthy = false;
            }
        });
    };
    const timer = setInterval(renew, intervalMs);
    return async () => {
        stopped = true;
        clearInterval(timer);
        await pending;
        return healthy;
    };
}

async function requiredDefinition(userId: string, workflowId: string) {
    const definition = await getVozebCmsWorkflowDefinition(userId, workflowId);
    if (!definition) throw new VozebCmsWorkflowRuntimeError("工作流不存在", 404);
    return definition;
}

async function requiredRun(userId: string, runId: string) {
    const run = await getVozebCmsWorkflowRun(userId, runId);
    if (!run) throw new VozebCmsWorkflowRuntimeError("工作流运行不存在", 404);
    return run;
}

function requiredDefinitionSnapshot(run: VozebCmsWorkflowRun) {
    try {
        return getVozebCmsWorkflowRunDefinition(run);
    } catch {
        throw new VozebCmsWorkflowRuntimeError("工作流运行定义快照无效", 409);
    }
}

async function assertWorkflowAccess(userId: string, definition: VozebCmsWorkflowDefinition) {
    const moduleIds = new Set<VozebCmsModuleId>();
    if (definition.projectRef?.type === "canvas" || definition.projectRef?.type === "drama") moduleIds.add(definition.projectRef.type);
    for (const node of definition.nodes) {
        const moduleId = node.config.moduleId;
        if (isVozebCmsModuleId(moduleId)) moduleIds.add(moduleId);
    }
    try {
        await assertVozebCmsUserCapability(userId, "workflow.run");
        for (const moduleId of moduleIds) await assertVozebCmsModuleEnabled(moduleId);
        for (const node of definition.nodes) await assertWorkflowNodeAccess(userId, node);
    } catch (error) {
        if (error instanceof VozebCmsModuleAccessError) throw new VozebCmsWorkflowRuntimeError(error.message, error.status);
        throw error;
    }
}

async function assertWorkflowNodeAccess(userId: string, node: VozebCmsWorkflowNodeDefinition) {
    for (const capabilityId of workflowNodeCapabilityIds(node)) await assertWorkflowCapability(userId, capabilityId);
}

async function assertWorkflowCapability(userId: string, capabilityId: string) {
    try {
        await assertVozebCmsUserCapability(userId, capabilityId);
    } catch (error) {
        if (error instanceof VozebCmsModuleAccessError) throw new VozebCmsWorkflowRuntimeError(error.message, error.status);
        throw error;
    }
}

function workflowNodeCapabilityIds(node: VozebCmsWorkflowNodeDefinition) {
    const explicit = [text(node.config.capabilityId), ...(Array.isArray(node.config.capabilities) ? node.config.capabilities.map(text) : [])].filter(Boolean);
    if (explicit.length) return Array.from(new Set(explicit));
    if (node.kind === "agent") return ["agent.run"];
    const taskType = text(node.config.taskType);
    if (taskType === "image" || taskType === "video" || taskType === "audio" || taskType === "text" || taskType === "agent" || taskType === "render") return [generationTaskCapabilityId(taskType)];
    return [];
}

function generationTaskCapabilityId(type: string) {
    if (type === "image") return "image.generate";
    if (type === "video") return "video.generate";
    if (type === "audio") return "audio.generate";
    if (type === "text") return "text.generate";
    if (type === "agent") return "agent.run";
    return "drama.workflow.run";
}

function workflowRunIsDue(run: VozebCmsWorkflowRun, now: number) {
    if (run.status === "pending" || run.status === "running") return !run.nextRunAt || run.nextRunAt <= now;
    return run.status === "waiting" && Boolean(run.nextRunAt && run.nextRunAt <= now);
}

function evaluateCondition(config: Record<string, unknown>, run: VozebCmsWorkflowRun) {
    const value = readPath(run.context, text(config.path));
    if (Object.prototype.hasOwnProperty.call(config, "equals")) return JSON.stringify(value) === JSON.stringify(config.equals);
    if (Object.prototype.hasOwnProperty.call(config, "notEquals")) return JSON.stringify(value) !== JSON.stringify(config.notEquals);
    return Boolean(value);
}

function mergeNodeOutputContext(context: Record<string, unknown>, nodeId: string, output: unknown, taskId?: string, taskIds?: string[]) {
    const nodeOutputs = object(context.nodeOutputs);
    return {
        ...context,
        nodeOutputs: { ...nodeOutputs, [nodeId]: output },
        ...(taskId || taskIds?.length ? { taskIds: { ...object(context.taskIds), [nodeId]: taskIds?.length ? taskIds : taskId } } : {}),
    };
}

function readPath(root: unknown, path: string): unknown {
    if (!path) return undefined;
    return path.split(".").reduce<unknown>((value, key) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined), root);
}

function taskIdFromContext(context: Record<string, unknown>, nodeId: string) {
    const taskIds = context.taskIds && typeof context.taskIds === "object" && !Array.isArray(context.taskIds) ? (context.taskIds as Record<string, unknown>) : {};
    return text(taskIds[nodeId]);
}

function cancelOpenNodes(states: Record<string, VozebCmsWorkflowNodeState>): Record<string, VozebCmsWorkflowNodeState> {
    return Object.fromEntries(Object.entries(states).map(([id, state]) => [id, ["pending", "running", "waiting"].includes(state.status) ? { ...state, status: "cancelled" as const, updatedAt: Date.now() } : state]));
}

function retryFailedNodes(states: Record<string, VozebCmsWorkflowNodeState>): Record<string, VozebCmsWorkflowNodeState> {
    return Object.fromEntries(
        Object.entries(states).map(([id, state]) => [
            id,
            state.status === "failed"
                ? { ...state, status: "pending" as const, error: undefined, reviewDecision: undefined, updatedAt: Date.now() }
                : ["waiting", "running"].includes(state.status)
                  ? { ...state, status: "pending" as const, updatedAt: Date.now() }
                  : state,
        ]),
    );
}

async function cancelBoundGenerationTasks(run: VozebCmsWorkflowRun) {
    const { controlVozebCmsTask } = await import("@/lib/server/vozeb-cms/unified-task-service");
    const tasks = await boundGenerationTasks(run);
    for (const task of tasks) {
        if (task.status !== "pending" && task.status !== "running" && task.status !== "paused") continue;
        await controlVozebCmsTask({ userId: run.userId, id: task.id, action: "cancel", origin: "" });
    }
}

async function retryBoundGenerationTasks(run: VozebCmsWorkflowRun) {
    const { controlVozebCmsTask } = await import("@/lib/server/vozeb-cms/unified-task-service");
    const tasks = await boundGenerationTasks(run);
    for (const task of tasks) {
        if (task.status !== "error" || task.payload.retryable !== true) continue;
        await controlVozebCmsTask({ userId: run.userId, id: task.id, action: "retry", origin: "" });
    }
}

async function boundGenerationTasks(run: VozebCmsWorkflowRun) {
    const explicitIds = Array.from(
        new Set(
            Object.values(run.nodeStates)
                .flatMap((state) => [...(state.taskIds || []), ...(state.taskId ? [state.taskId] : [])])
                .filter((id): id is string => Boolean(id)),
        ),
    );
    const records = await listStoredGenerationTaskRecordsByRunIds([run.id], [run.userId]);
    const byId = new Map(records.map((task) => [task.id, task]));
    for (const id of explicitIds) {
        const task = await getStoredGenerationTaskRecordForUser(id, run.userId);
        if (task) byId.set(task.id, task);
    }
    return [...byId.values()];
}

function object(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown) {
    return typeof value === "string" ? value.trim().slice(0, 240) : "";
}

function positiveTime(value: unknown) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

export class VozebCmsWorkflowRuntimeError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
    }
}
