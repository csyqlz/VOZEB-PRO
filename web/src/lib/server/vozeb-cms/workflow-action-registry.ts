import type { NodeExecutor } from "./workflow-execution-contract";
import { executeVozebCmsDramaWorkflowAction } from "./workflow-drama-actions";

export const VOZEB_CMS_WORKFLOW_ACTION_IDS = ["drama.script.require", "drama.content.analyze", "drama.visual.plan", "drama.video.generate", "drama.asset.commit"] as const;
export type VozebCmsWorkflowActionId = (typeof VOZEB_CMS_WORKFLOW_ACTION_IDS)[number];

export function getVozebCmsWorkflowActionExecutor(value: unknown): NodeExecutor | undefined {
    if (typeof value !== "string" || !value.trim()) return undefined;
    const actionId = value.trim();
    if (VOZEB_CMS_WORKFLOW_ACTION_IDS.includes(actionId as VozebCmsWorkflowActionId)) return executeVozebCmsDramaWorkflowAction;
    return async () => ({ status: "failed", error: `工作流 Action 未注册：${actionId}` });
}
