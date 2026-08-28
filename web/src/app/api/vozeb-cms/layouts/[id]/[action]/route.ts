import { NextResponse } from "next/server";

import { hasAdminPermission } from "@/lib/admin-permissions";
import { readJsonBody } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { createVozebCmsAuditScope, recordVozebCmsAccessBlock } from "@/lib/server/vozeb-cms/audit";
import { VozebCmsModuleAccessError } from "@/lib/server/vozeb-cms/module-service";
import { publishVozebCmsLayoutForUser, rollbackVozebCmsLayoutForUser, VozebCmsLayoutStoreError } from "@/lib/server/vozeb-cms/layout-service";
import { VozebCmsProjectRefError } from "@/lib/server/vozeb-cms/project-ref-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string; action: string }> }) {
    const user = await getCurrentUser(request);
    if (!user) return responseError("请先登录", 401);
    if (!hasAdminPermission(user, "system.manage")) {
        await recordVozebCmsAccessBlock({ request, user, kind: "permission", id: "system.manage", status: 403 });
        return responseError("需要系统管理权限", 403);
    }
    const { id, action } = await params;
    if (action !== "publish" && action !== "rollback") return responseError("页面操作无效", 400);
    const audit = createVozebCmsAuditScope(request, user, `vozeb.layout.${action}`, { type: "layout", id });
    try {
        const body = await readJsonBody(request);
        if (action === "publish") {
            const layout = await publishVozebCmsLayoutForUser(user.id, id, body);
            await audit.success({
                metadata: {
                    baseRevision: number(body, "baseRevision"),
                    revision: layout.revision,
                    publishedRevision: layout.publishedRevision,
                    nodeCount: Array.isArray(layout.nodes) ? layout.nodes.length : 0,
                    sitePath: layout.site?.path,
                    status: layout.status,
                },
            });
            return NextResponse.json({ code: 0, data: { layout }, msg: "页面已发布" });
        }
        const layout = await rollbackVozebCmsLayoutForUser(user.id, id, body);
        await audit.success({
            metadata: {
                baseRevision: number(body, "baseRevision"),
                targetRevision: number(body, "targetRevision"),
                revision: layout.revision,
                nodeCount: Array.isArray(layout.nodes) ? layout.nodes.length : 0,
                sitePath: layout.site?.path,
                status: layout.status,
            },
        });
        return NextResponse.json({ code: 0, data: { layout }, msg: "页面已回滚为草稿" });
    } catch (error) {
        await audit.failure(error);
        return handleError(error, "页面操作失败");
    }
}

function number(value: unknown, key: string) {
    const input = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    const result = Number(input[key]);
    return Number.isFinite(result) ? result : undefined;
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
