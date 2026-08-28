import { NextResponse } from "next/server";

import { requireVozebCmsCapability } from "@/app/api/vozeb-cms-capability";
import { readJsonBody } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { createVozebCmsAuditScope } from "@/lib/server/vozeb-cms/audit";
import { controlVozebCmsWorkflowRun, reviewVozebCmsWorkflowNode, VozebCmsWorkflowRuntimeError } from "@/lib/server/vozeb-cms/workflow-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ runId: string; action: string }> }) {
    const user = await getCurrentUser(request);
    if (!user) return responseError("请先登录", 401);
    const { runId, action } = await params;
    const blocked = await requireVozebCmsCapability("workflow.run", user.id, request);
    if (blocked) return blocked;
    let audit: ReturnType<typeof createVozebCmsAuditScope> | undefined;
    let auditMetadata: Record<string, unknown> = { runId };
    try {
        if (action === "review") {
            const body = await readJsonBody<{ nodeId?: unknown; decision?: unknown }>(request);
            if (typeof body.nodeId !== "string" || (body.decision !== "approved" && body.decision !== "rejected")) return responseError("审核参数无效", 400);
            audit = createVozebCmsAuditScope(request, user, body.decision === "approved" ? "vozeb.workflow.review.approve" : "vozeb.workflow.review.reject", { type: "workflow_run", id: runId });
            auditMetadata = { runId, nodeId: body.nodeId, decision: body.decision };
            const run = await reviewVozebCmsWorkflowNode(user.id, runId, body.nodeId, body.decision);
            await audit.success({ metadata: { ...auditMetadata, workflowId: run?.workflowId, definitionVersion: run?.definitionVersion, status: run?.status } });
            return NextResponse.json({ code: 0, data: { run }, msg: body.decision === "approved" ? "审核已通过" : "审核已拒绝" });
        }
        if (action !== "pause" && action !== "resume" && action !== "cancel" && action !== "retry") return responseError("工作流操作无效", 400);
        audit = createVozebCmsAuditScope(request, user, `vozeb.workflow.run.${action}`, { type: "workflow_run", id: runId });
        auditMetadata = { runId, controlAction: action };
        const run = await controlVozebCmsWorkflowRun(user.id, runId, action);
        await audit.success({ metadata: { ...auditMetadata, workflowId: run?.workflowId, definitionVersion: run?.definitionVersion, status: run?.status } });
        return NextResponse.json({ code: 0, data: { run }, msg: "工作流状态已更新" });
    } catch (error) {
        await audit?.failure(error, { metadata: auditMetadata });
        if (error instanceof VozebCmsWorkflowRuntimeError) return responseError(error.message, error.status);
        console.error("VOZEBCMS workflow action failed", error);
        return responseError("工作流操作失败", 500);
    }
}

function responseError(msg: string, status: number) {
    return NextResponse.json({ code: status, data: null, msg }, { status });
}
