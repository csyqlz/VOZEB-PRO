import type { VozebCmsWorkflowNodeDefinition, VozebCmsWorkflowNodeState, VozebCmsWorkflowRun } from "@/lib/vozeb-cms/workflow-contract";

export type NodeExecutionResult = {
    status: "success" | "waiting" | "failed";
    output?: unknown;
    error?: string;
    taskId?: string;
    taskIds?: string[];
    nextRunAt?: number;
};

export type NodeExecutor = (input: { userId: string; run: VozebCmsWorkflowRun; node: VozebCmsWorkflowNodeDefinition; state: VozebCmsWorkflowNodeState }) => Promise<NodeExecutionResult>;
