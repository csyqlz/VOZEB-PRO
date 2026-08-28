import type { VozebCmsWorkflowDefinition } from "./workflow-contract";
import type { VozebCmsProjectRef } from "./project-ref";

export function createVozebCmsDramaProductionWorkflow(input: { userId: string; projectId: string; projectRef?: VozebCmsProjectRef; id?: string; now?: number }): VozebCmsWorkflowDefinition {
    const now = input.now || Date.now();
    const node = (id: string, actionId: string, kind: VozebCmsWorkflowDefinition["nodes"][number]["kind"], name: string, moduleId: "drama" | "video", capabilities: string[], dependsOn: string[] = []) => ({
        id,
        kind,
        name,
        dependsOn,
        config: { actionId, moduleId, capabilities },
    });
    return {
        id: input.id || `workflow-drama-${input.projectId}`,
        userId: input.userId,
        projectId: input.projectId,
        ...(input.projectRef ? { projectRef: input.projectRef } : {}),
        name: "短剧生产闭环",
        version: 1,
        enabled: true,
        nodes: [
            node("script", "drama.script.require", "task", "剧本", "drama", ["drama.workflow.run"]),
            node("content", "drama.content.analyze", "agent", "内容分析", "drama", ["drama.workflow.run", "agent.run", "text.generate"], ["script"]),
            node("visual", "drama.visual.plan", "ai", "视觉方案", "drama", ["drama.workflow.run", "text.generate"], ["content"]),
            node("video", "drama.video.generate", "task", "视频生成", "video", ["drama.workflow.run", "video.generate"], ["visual"]),
            node("review", "manual_review", "manual_review", "内容审核", "drama", ["drama.workflow.run"], ["video"]),
            node("asset", "drama.asset.commit", "task", "资产回写", "drama", ["drama.workflow.run", "asset.manage"], ["review"]),
        ],
        createdAt: now,
        updatedAt: now,
    };
}
