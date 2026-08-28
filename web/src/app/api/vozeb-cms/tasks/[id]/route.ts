import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBodyResult } from "@/lib/auth/request";
import { requireVozebCmsCapability } from "@/app/api/vozeb-cms-capability";
import { createVozebCmsAuditScope, recordVozebCmsAccessBlock } from "@/lib/server/vozeb-cms/audit";
import { controlVozebCmsTask, getVozebCmsTask, VozebCmsTaskActionError, vozebCmsTaskCapabilityId, type VozebCmsTaskAction } from "@/lib/server/vozeb-cms/unified-task-service";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2400;

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
    const user = await getCurrentUser(request);
    if (!user) return responseError("请先登录", 401);
    const blocked = await requireVozebCmsCapability("asset.manage", user.id);
    if (blocked) {
        await recordVozebCmsAccessBlock({ request, user, kind: "capability", id: "asset.manage", status: blocked.status });
        return blocked;
    }
    const task = await getVozebCmsTask(user.id, (await context.params).id);
    if (task) {
        const taskBlocked = await requireVozebCmsCapability(vozebCmsTaskCapabilityId(task.type), user.id);
        if (taskBlocked) {
            await recordVozebCmsAccessBlock({ request, user, kind: "capability", id: vozebCmsTaskCapabilityId(task.type), status: taskBlocked.status });
            return taskBlocked;
        }
    }
    return task ? NextResponse.json({ code: 0, data: { task }, msg: "ok" }) : responseError("任务不存在或已过期", 404);
}

export async function POST(request: Request, context: RouteContext) {
    const user = await getCurrentUser(request);
    if (!user) return responseError("请先登录", 401);
    const id = (await context.params).id;
    const parsed = await readJsonBodyResult<{ action?: string }>(request);
    if (!parsed.ok) return responseError(parsed.message, parsed.status);
    const action = parsed.data.action;
    if (action !== "cancel" && action !== "recover" && action !== "retry") return responseError("不支持的任务操作", 400);
    const task = await getVozebCmsTask(user.id, id);
    if (!task) return responseError("任务不存在或已过期", 404);
    const capability = vozebCmsTaskCapabilityId(task.type);
    const blocked = await requireVozebCmsCapability(capability, user.id);
    if (blocked) {
        await recordVozebCmsAccessBlock({ request, user, kind: "capability", id: capability, status: blocked.status });
        return blocked;
    }
    const audit = createVozebCmsAuditScope(request, user, `vozeb.task.${action}`, { type: task.type === "workflow" ? "workflow_run" : "generation_task", id });
    try {
        const record = await controlVozebCmsTask({
            userId: user.id,
            id,
            action: action as VozebCmsTaskAction,
            origin: resolveInternalOrigin(new URL(request.url).origin),
            publicOrigin: new URL(request.url).origin,
            cookie: request.headers.get("cookie") || "",
        });
        if (!record) return responseError("任务状态已变化，请刷新后重试", 409);
        const current = await getVozebCmsTask(user.id, id);
        await audit.success({ metadata: { controlAction: action, status: current?.status, projectId: current?.project_id } });
        return NextResponse.json({ code: 0, data: { task: current }, msg: "ok" });
    } catch (error) {
        await audit.failure(error, { metadata: { controlAction: action } });
        if (error instanceof VozebCmsTaskActionError) return responseError(error.message, error.status);
        console.error("VOZEBCMS task action failed", error);
        return responseError("任务操作失败", 500);
    }
}

function responseError(msg: string, status: number) {
    return NextResponse.json({ code: status, data: null, msg }, { status });
}
