import { NextResponse } from "next/server";

import { requireVozebCmsCapability } from "@/app/api/vozeb-cms-capability";
import { hasAdminPermission } from "@/lib/admin-permissions";
import { readJsonBodyResult } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { createVozebCmsAuditScope, recordVozebCmsAccessBlock } from "@/lib/server/vozeb-cms/audit";
import { VozebCmsLayoutBuilderError, buildVozebCmsLayoutForUser } from "@/lib/server/vozeb-cms/layout-builder-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2400;

export async function POST(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return responseError("请先登录", 401);
    if (!hasAdminPermission(user, "system.manage")) {
        await recordVozebCmsAccessBlock({ request, user, kind: "permission", id: "system.manage", status: 403 });
        return responseError("需要系统管理权限", 403);
    }
    const blocked = await requireVozebCmsCapability("layout.compose", user.id, request);
    if (blocked) return blocked;
    const body = await readJsonBodyResult<unknown>(request, 128 * 1024);
    if (!body.ok) return responseError(body.message, body.status);
    const audit = createVozebCmsAuditScope(request, user, "vozeb.layout.ai_build", { type: "layout" });
    try {
        const layout = await buildVozebCmsLayoutForUser(user.id, body.data, { origin: resolveInternalOrigin(new URL(request.url).origin), cookie: request.headers.get("cookie") || "", signal: request.signal });
        await audit.success({
            targetId: layout.id,
            metadata: {
                revision: layout.revision,
                nodeCount: Array.isArray(layout.nodes) ? layout.nodes.length : 0,
                moduleId: layout.moduleId,
                projectId: layout.projectRef?.id,
                projectType: layout.projectRef?.type,
                sitePath: layout.site?.path,
                status: layout.status,
            },
        });
        return NextResponse.json({ code: 0, data: { layout }, msg: "AI 页面草稿已创建" }, { status: 201 });
    } catch (error) {
        await audit.failure(error);
        if (error instanceof VozebCmsLayoutBuilderError) return responseError(error.message, error.status);
        return responseError("AI 页面搭建失败，请稍后重试", 502);
    }
}

function responseError(msg: string, status: number) {
    return NextResponse.json({ code: status, data: null, msg }, { status });
}
