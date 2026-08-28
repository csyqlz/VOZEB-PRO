import { NextResponse } from "next/server";

import { requireVozebCmsCapability } from "@/app/api/vozeb-cms-capability";
import { readJsonBody } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { createVozebCmsAuditScope } from "@/lib/server/vozeb-cms/audit";
import { advanceVozebCmsWorkflowRun, createVozebCmsWorkflowRunForUser, VozebCmsWorkflowRuntimeError } from "@/lib/server/vozeb-cms/workflow-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser(request);
    if (!user) return responseError("请先登录", 401);
    const workflowId = (await params).id;
    const blocked = await requireVozebCmsCapability("workflow.run", user.id, request);
    if (blocked) return blocked;
    const audit = createVozebCmsAuditScope(request, user, "vozeb.workflow.run.create", { type: "workflow_run" });
    try {
        const body = await readJsonBody<{ context?: unknown; idempotencyKey?: unknown; autoStart?: unknown }>(request);
        const run = await createVozebCmsWorkflowRunForUser(user.id, workflowId, object(body.context), text(body.idempotencyKey));
        const current = body.autoStart === false ? run : await advanceVozebCmsWorkflowRun(user.id, run.id);
        const result = current || run;
        await audit.success({
            targetId: result.id,
            metadata: {
                workflowId,
                runId: result.id,
                definitionVersion: result.definitionVersion,
                projectId: result.projectId,
                projectType: result.projectRef?.type,
                status: result.status,
                autoStart: body.autoStart !== false,
                idempotent: Boolean(text(body.idempotencyKey)),
            },
        });
        return NextResponse.json({ code: 0, data: { run: result }, msg: "工作流运行已创建" });
    } catch (error) {
        await audit.failure(error, { metadata: { workflowId } });
        if (error instanceof VozebCmsWorkflowRuntimeError) return responseError(error.message, error.status);
        console.error("VOZEBCMS workflow run create failed", error);
        return responseError("工作流运行创建失败", 500);
    }
}

function object(value: unknown) {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown) {
    return typeof value === "string" ? value.trim().slice(0, 240) || undefined : undefined;
}

function responseError(msg: string, status: number) {
    return NextResponse.json({ code: status, data: null, msg }, { status });
}
