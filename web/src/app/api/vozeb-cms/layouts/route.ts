import { NextResponse } from "next/server";

import { hasAdminPermission } from "@/lib/admin-permissions";
import { readJsonBody } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { createVozebCmsAuditScope, recordVozebCmsAccessBlock } from "@/lib/server/vozeb-cms/audit";
import { VozebCmsModuleAccessError } from "@/lib/server/vozeb-cms/module-service";
import { createVozebCmsLayoutForUser, listVozebCmsLayoutsForUser, VozebCmsLayoutStoreError } from "@/lib/server/vozeb-cms/layout-service";
import { VozebCmsProjectRefError } from "@/lib/server/vozeb-cms/project-ref-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return responseError("请先登录", 401);
    if (!hasAdminPermission(user, "system.manage")) {
        await recordVozebCmsAccessBlock({ request, user, kind: "permission", id: "system.manage", status: 403 });
        return responseError("需要系统管理权限", 403);
    }
    const url = new URL(request.url);
    try {
        return NextResponse.json({
            code: 0,
            data: {
                layouts: await listVozebCmsLayoutsForUser(user.id, {
                    projectId: url.searchParams.get("projectId") || undefined,
                    projectType: url.searchParams.get("projectType") || undefined,
                    sitePath: url.searchParams.get("sitePath") || undefined,
                    limit: Number(url.searchParams.get("limit")) || undefined,
                }),
            },
            msg: "ok",
        });
    } catch (error) {
        return handleError(error, "页面布局读取失败");
    }
}

export async function POST(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return responseError("请先登录", 401);
    if (!hasAdminPermission(user, "system.manage")) {
        await recordVozebCmsAccessBlock({ request, user, kind: "permission", id: "system.manage", status: 403 });
        return responseError("需要系统管理权限", 403);
    }
    const audit = createVozebCmsAuditScope(request, user, "vozeb.layout.create", { type: "layout" });
    try {
        const layout = await createVozebCmsLayoutForUser(user.id, await readJsonBody(request));
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
        return NextResponse.json({ code: 0, data: { layout }, msg: "页面草稿已创建" }, { status: 201 });
    } catch (error) {
        await audit.failure(error);
        return handleError(error, "页面草稿创建失败");
    }
}

function handleError(error: unknown, fallback: string) {
    if (error instanceof VozebCmsLayoutStoreError || error instanceof VozebCmsModuleAccessError || error instanceof VozebCmsProjectRefError) return responseError(error.message, error.status);
    if (error instanceof Error && (error.message.startsWith("页面") || error.message.startsWith("项目") || error.message.startsWith("页面配置"))) return responseError(error.message, 400);
    console.error(fallback, error);
    return responseError(fallback, 500);
}

function responseError(msg: string, status: number) {
    return NextResponse.json({ code: status, data: null, msg }, { status });
}
