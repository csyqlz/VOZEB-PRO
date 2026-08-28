import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { requireVozebCmsCapability } from "@/app/api/vozeb-cms-capability";
import { listVozebCmsTaskPage, VozebCmsTaskQueryError } from "@/lib/server/vozeb-cms/unified-task-service";
import { resolveVozebCmsProjectRef, VozebCmsProjectRefError } from "@/lib/server/vozeb-cms/project-ref-service";
import { isVozebCmsTaskStatus, isVozebCmsTaskType } from "@/lib/vozeb-cms/unified-resource-contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return responseError("请先登录", 401);
    const blocked = await requireVozebCmsCapability("asset.manage", user.id);
    if (blocked) return blocked;
    const url = new URL(request.url);
    try {
        const projectId = url.searchParams.get("projectId") || undefined;
        const projectType = url.searchParams.get("projectType") || undefined;
        const projectRef = projectId && projectType ? await resolveVozebCmsProjectRef(user.id, { id: projectId, type: projectType }, true) : undefined;
        if (projectType && !projectId) return responseError("项目类型必须和项目标识一起提供", 400);
        const typeValue = url.searchParams.get("type");
        const statusValue = url.searchParams.get("status");
        const limitValue = url.searchParams.get("limit");
        if (typeValue && !isVozebCmsTaskType(typeValue)) return responseError("任务类型无效", 400);
        if (statusValue && !isVozebCmsTaskStatus(statusValue)) return responseError("任务状态无效", 400);
        if (limitValue && (!Number.isInteger(Number(limitValue)) || Number(limitValue) < 1 || Number(limitValue) > 100)) return responseError("任务分页大小无效", 400);
        const type = isVozebCmsTaskType(typeValue) ? typeValue : undefined;
        const status = isVozebCmsTaskStatus(statusValue) ? statusValue : undefined;
        const page = await listVozebCmsTaskPage(user.id, {
            projectId,
            projectRef,
            type,
            status,
            cursor: url.searchParams.get("cursor") || undefined,
            limit: limitValue ? Number(limitValue) : undefined,
        });
        return NextResponse.json({
            code: 0,
            data: {
                tasks: page.items,
                total: page.total,
                limit: page.limit,
                nextCursor: page.nextCursor,
            },
            msg: "ok",
        });
    } catch (error) {
        if (error instanceof VozebCmsProjectRefError || error instanceof VozebCmsTaskQueryError) return responseError(error.message, error.status);
        console.error("VOZEBCMS task projection failed", error);
        return responseError("任务列表读取失败", 500);
    }
}

function responseError(msg: string, status: number) {
    return NextResponse.json({ code: status, data: null, msg }, { status });
}
