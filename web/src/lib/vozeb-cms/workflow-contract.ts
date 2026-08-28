import { randomUUID } from "node:crypto";

import { normalizeVozebCmsProjectRef } from "./project-ref";

export const VOZEB_CMS_WORKFLOW_NODE_KINDS = ["agent", "ai", "task", "manual_review", "condition"] as const;
export type VozebCmsWorkflowNodeKind = (typeof VOZEB_CMS_WORKFLOW_NODE_KINDS)[number];

export const VOZEB_CMS_WORKFLOW_RUN_STATUSES = ["pending", "running", "waiting", "paused", "completed", "failed", "cancelled"] as const;
export type VozebCmsWorkflowRunStatus = (typeof VOZEB_CMS_WORKFLOW_RUN_STATUSES)[number];

export const VOZEB_CMS_WORKFLOW_NODE_STATUSES = ["pending", "running", "waiting", "success", "failed", "skipped", "cancelled"] as const;
export type VozebCmsWorkflowNodeStatus = (typeof VOZEB_CMS_WORKFLOW_NODE_STATUSES)[number];

export type VozebCmsWorkflowNodeDefinition = {
    id: string;
    kind: VozebCmsWorkflowNodeKind;
    name: string;
    dependsOn: string[];
    config: Record<string, unknown>;
};

export type VozebCmsWorkflowDefinition = {
    id: string;
    userId: string;
    projectId?: string;
    projectRef?: import("./project-ref").VozebCmsProjectRef;
    name: string;
    version: number;
    enabled: boolean;
    nodes: VozebCmsWorkflowNodeDefinition[];
    createdAt: number;
    updatedAt: number;
};

export type VozebCmsWorkflowNodeState = {
    status: VozebCmsWorkflowNodeStatus;
    attempts: number;
    taskId?: string;
    taskIds?: string[];
    output?: unknown;
    error?: string;
    reviewDecision?: "approved" | "rejected";
    updatedAt: number;
};

export type VozebCmsWorkflowRun = {
    id: string;
    userId: string;
    workflowId: string;
    definitionVersion: number;
    definitionSnapshot: VozebCmsWorkflowDefinition;
    projectId?: string;
    projectRef?: import("./project-ref").VozebCmsProjectRef;
    status: VozebCmsWorkflowRunStatus;
    version: number;
    idempotencyKey?: string;
    context: Record<string, unknown>;
    nodeStates: Record<string, VozebCmsWorkflowNodeState>;
    nextRunAt?: number;
    error?: string;
    createdAt: number;
    updatedAt: number;
};

export type VozebCmsWorkflowEvent = {
    id: string;
    runId: string;
    type: string;
    data?: unknown;
    createdAt: number;
};

export function validateVozebCmsWorkflowNodes(nodes: readonly VozebCmsWorkflowNodeDefinition[]) {
    if (!nodes.length) throw new Error("工作流至少需要一个节点");
    const ids = new Set<string>();
    for (const node of nodes) {
        if (!/^[a-zA-Z0-9_-]{1,120}$/.test(node.id) || ids.has(node.id)) throw new Error(`工作流节点 ID 无效或重复：${node.id}`);
        ids.add(node.id);
        if (!VOZEB_CMS_WORKFLOW_NODE_KINDS.includes(node.kind)) throw new Error(`工作流节点类型不支持：${node.kind}`);
        if (!node.name.trim()) throw new Error(`工作流节点名称不能为空：${node.id}`);
    }
    for (const node of nodes) {
        for (const dependency of node.dependsOn) if (!ids.has(dependency) || dependency === node.id) throw new Error(`工作流节点依赖无效：${node.id} -> ${dependency}`);
    }
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const visit = (id: string) => {
        if (visiting.has(id)) throw new Error(`工作流节点依赖存在循环：${id}`);
        if (visited.has(id)) return;
        visiting.add(id);
        for (const dependency of byId.get(id)?.dependsOn || []) visit(dependency);
        visiting.delete(id);
        visited.add(id);
    };
    for (const node of nodes) visit(node.id);
}

export function normalizeVozebCmsWorkflowDefinition(value: unknown, userId: string): VozebCmsWorkflowDefinition {
    const input = object(value);
    const nodes = Array.isArray(input.nodes) ? input.nodes.flatMap(normalizeNode) : [];
    validateVozebCmsWorkflowNodes(nodes);
    const now = Date.now();
    return {
        id: text(input.id) || `workflow-${randomUUID()}`,
        userId,
        projectId: optionalText(input.projectId),
        ...(input.projectRef ? { projectRef: normalizeVozebCmsProjectRef(input.projectRef, userId) } : {}),
        name: text(input.name).slice(0, 160) || "未命名工作流",
        version: positiveInteger(input.version) || 1,
        enabled: input.enabled !== false,
        nodes,
        createdAt: positiveInteger(input.createdAt) || now,
        updatedAt: now,
    };
}

export function createVozebCmsWorkflowRun(definition: VozebCmsWorkflowDefinition, userId: string, context: Record<string, unknown>, idempotencyKey?: string): VozebCmsWorkflowRun {
    const now = Date.now();
    const definitionSnapshot = createVozebCmsWorkflowDefinitionSnapshot(definition);
    return {
        id: `workflow-run-${randomUUID()}`,
        userId,
        workflowId: definition.id,
        definitionVersion: definitionSnapshot.version,
        definitionSnapshot,
        projectId: definition.projectId,
        projectRef: definition.projectRef,
        status: "pending",
        version: 1,
        idempotencyKey: optionalText(idempotencyKey),
        context,
        nodeStates: Object.fromEntries(definition.nodes.map((node) => [node.id, { status: "pending", attempts: 0, updatedAt: now }])),
        nextRunAt: now,
        createdAt: now,
        updatedAt: now,
    };
}

export function createVozebCmsWorkflowDefinitionSnapshot(definition: VozebCmsWorkflowDefinition): VozebCmsWorkflowDefinition {
    const cloned = JSON.parse(JSON.stringify(definition)) as unknown;
    const snapshot = normalizeVozebCmsWorkflowDefinition(cloned, definition.userId);
    return {
        ...snapshot,
        id: definition.id,
        userId: definition.userId,
        version: definition.version,
        createdAt: definition.createdAt,
        updatedAt: definition.updatedAt,
    };
}

export function getVozebCmsWorkflowRunDefinition(run: VozebCmsWorkflowRun): VozebCmsWorkflowDefinition {
    const snapshot = run.definitionSnapshot;
    if (!snapshot || snapshot.id !== run.workflowId || snapshot.userId !== run.userId || snapshot.version !== run.definitionVersion) throw new Error("工作流运行定义快照无效");
    validateVozebCmsWorkflowNodes(snapshot.nodes);
    return snapshot;
}

function normalizeNode(value: unknown): VozebCmsWorkflowNodeDefinition[] {
    const input = object(value);
    const kind = VOZEB_CMS_WORKFLOW_NODE_KINDS.find((item) => item === input.kind);
    const id = text(input.id);
    if (!id || !kind) return [];
    const dependsOn = Array.isArray(input.dependsOn) ? Array.from(new Set(input.dependsOn.map(optionalText).filter((item): item is string => Boolean(item)))) : [];
    return [{ id, kind, name: text(input.name) || id, dependsOn, config: object(input.config) }];
}

function object(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function optionalText(value: unknown) {
    const result = text(value).slice(0, 240);
    return result || undefined;
}

function positiveInteger(value: unknown) {
    const result = Number(value);
    return Number.isInteger(result) && result > 0 ? result : undefined;
}
