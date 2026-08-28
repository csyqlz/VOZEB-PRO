import type { VozebCmsWorkflowNodeDefinition, VozebCmsWorkflowRun } from "@/lib/vozeb-cms/workflow-contract";
import { getVozebCmsWorkflowActionExecutor } from "./workflow-action-registry";
import type { NodeExecutor } from "./workflow-execution-contract";

export function getVozebCmsBuiltInWorkflowNodeExecutor(node: VozebCmsWorkflowNodeDefinition, _run: VozebCmsWorkflowRun): NodeExecutor | undefined {
    return getVozebCmsWorkflowActionExecutor(node.config.actionId);
}
