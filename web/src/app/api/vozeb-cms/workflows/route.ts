import { NextResponse } from "next/server";

import { requireVozebCmsCapability } from "@/app/api/vozeb-cms-capability";
import { readJsonBody } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { createVozebCmsAuditScope } from "@/lib/server/vozeb-cms/audit";
import { listVozebCmsWorkflowDefinitions, createVozebCmsWorkflowDefinition, listVozebCmsWorkflowRuns, VozebCmsWorkflowStoreError } from "@/lib/server/vozeb-cms/workflow-store";
import { resolveVozebCmsProjectRef, VozebCmsProjectRefError } from "@/lib/server/vozeb-cms/project-ref-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return responseError("请先登录", 401);
    const blocked = await requireVozebCmsCapability("workflow.run", user.id, request);
    if (blocked) return blocked;
    const url = new URL(request.url);
    const projectId = url.searchParams.get("projectId") || undefined;
    const projectType = url.searchParams.get("projectType") || undefined;
    try {
        const projectRef = projectId && projectType ? await resolveVozebCmsProjectRef(user.id, { id: projectId, type: projectType }, true) : undefined;
        if (projectType && !projectId) return responseError("项目类型必须和项目标识一起提供", 400);
        const project = projectRef || projectId || "";
        const [workflows, runs] = await Promise.all([listVozebCmsWorkflowDefinitions(user.id, project), listVozebCmsWorkflowRuns(user.id, { projectId, limit: 100 })]);
        return NextResponse.json({ code: 0, data: { workflows, runs }, msg: "ok" });
    } catch (error) {
        return handleError(error, "工作流列表读取失败");
    }
}

export async function POST(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return responseError("请先登录", 401);
    const blocked = await requireVozebCmsCapability("workflow.run", user.id, request);
    if (blocked) return blocked;
    const audit = createVozebCmsAuditScope(request, user, "vozeb.workflow.definition.create", { type: "workflow_definition" });
    try {
        const body = await readJsonBody(request);
        const input = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
        const projectRef = input.projectRef ? await resolveVozebCmsProjectRef(user.id, input.projectRef, true) : undefined;
        const workflow = await createVozebCmsWorkflowDefinition(user.id, { ...input, ...(projectRef ? { projectRef, projectId: projectRef.id } : {}) });
        await audit.success({
            targetId: workflow.id,
            metadata: { workflowId: workflow.id, version: workflow.version, nodeCount: workflow.nodes.length, projectId: workflow.projectId, projectType: workflow.projectRef?.type, status: workflow.enabled ? "enabled" : "disabled" },
        });
        return NextResponse.json({ code: 0, data: { workflow }, msg: "工作流已创建" });
    } catch (error) {
        await audit.failure(error);
        return handleError(error, "工作流创建失败");
    }
}

function handleError(error: unknown, fallback: string) {
    if (error instanceof VozebCmsWorkflowStoreError || error instanceof VozebCmsProjectRefError || (error instanceof Error && error.message.startsWith("工作流")))
        return responseError(error.message, error instanceof VozebCmsWorkflowStoreError || error instanceof VozebCmsProjectRefError ? error.status : 400);
    console.error(fallback, error);
    return responseError(fallback, 500);
}

function responseError(msg: string, status: number) {
    return NextResponse.json({ code: status, data: null, msg }, { status });
}
