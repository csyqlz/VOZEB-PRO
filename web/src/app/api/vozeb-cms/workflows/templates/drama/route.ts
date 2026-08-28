import { NextResponse } from "next/server";

import { requireVozebCmsCapability } from "@/app/api/vozeb-cms-capability";
import { getCurrentUser } from "@/lib/auth/session";
import { createVozebCmsWorkflowDefinition, VozebCmsWorkflowStoreError } from "@/lib/server/vozeb-cms/workflow-store";
import { createVozebCmsDramaProductionWorkflow } from "@/lib/vozeb-cms/workflow-templates";
import { readJsonBody } from "@/lib/auth/request";
import { getDramaProject } from "@/lib/server/drama-project-store";
import { createVozebCmsAuditScope } from "@/lib/server/vozeb-cms/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return responseError("请先登录", 401);
    const blocked = await requireVozebCmsCapability("drama.workflow.run", user.id, request);
    if (blocked) return blocked;
    const audit = createVozebCmsAuditScope(request, user, "vozeb.workflow.template.drama.create", { type: "workflow_definition" });
    try {
        const body = await readJsonBody<{ projectId?: unknown; id?: unknown }>(request);
        const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
        if (!projectId) return responseError("短剧项目标识不能为空", 400);
        if (!(await getDramaProject(projectId, user.id))) return responseError("短剧项目不存在", 404);
        const workflow = await createVozebCmsWorkflowDefinition(
            user.id,
            createVozebCmsDramaProductionWorkflow({ userId: user.id, projectId, projectRef: { id: projectId, type: "drama", ownerId: user.id }, id: typeof body.id === "string" ? body.id.trim() || undefined : undefined }),
        );
        await audit.success({
            targetId: workflow.id,
            metadata: { workflowId: workflow.id, templateId: "drama-production", version: workflow.version, nodeCount: workflow.nodes.length, projectId, projectType: "drama", status: workflow.enabled ? "enabled" : "disabled" },
        });
        return NextResponse.json({ code: 0, data: { workflow }, msg: "短剧工作流已创建" });
    } catch (error) {
        await audit.failure(error);
        if (error instanceof VozebCmsWorkflowStoreError || (error instanceof Error && error.message.startsWith("工作流"))) return responseError(error.message, error instanceof VozebCmsWorkflowStoreError ? error.status : 400);
        console.error("VOZEBCMS drama workflow template failed", error);
        return responseError("短剧工作流创建失败", 500);
    }
}

function responseError(msg: string, status: number) {
    return NextResponse.json({ code: status, data: null, msg }, { status });
}
