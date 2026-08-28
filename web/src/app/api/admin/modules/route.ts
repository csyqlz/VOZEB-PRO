import { NextResponse } from "next/server";

import { hasAdminPermission } from "@/lib/admin-permissions";
import { isVozebCmsModuleId } from "@/lib/vozeb-cms/module-contract";
import { readJsonBody } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { VozebCmsModuleAccessError, changeVozebCmsModuleState, listVozebCmsModules } from "@/lib/server/vozeb-cms/module-service";
import { VozebCmsModuleStateError } from "@/lib/server/vozeb-cms/module-state-store";
import { auditActorFromRequest, safeRecordAuditLog } from "@/lib/server/audit-log-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
    const currentUser = await getCurrentUser();
    if (!currentUser) return responseError("请先登录", 401);
    if (!hasAdminPermission(currentUser, "system.manage")) return responseError("需要系统管理权限", 403);
    return NextResponse.json({ code: 0, data: { modules: await listVozebCmsModules() }, msg: "ok" });
}

export async function PATCH(request: Request) {
    const currentUser = await getCurrentUser();
    if (!currentUser) return responseError("请先登录", 401);
    if (!hasAdminPermission(currentUser, "system.manage")) return responseError("需要系统管理权限", 403);

    let moduleId: string | undefined;
    try {
        const body = await readJsonBody<{ moduleId?: unknown; enabled?: unknown; baseRevision?: unknown; mutationId?: unknown }>(request);
        moduleId = typeof body.moduleId === "string" ? body.moduleId : undefined;
        if (!isVozebCmsModuleId(body.moduleId) || typeof body.enabled !== "boolean" || !Number.isInteger(body.baseRevision) || Number(body.baseRevision) < 0 || typeof body.mutationId !== "string" || !body.mutationId.trim()) {
            return responseError("模块状态参数无效", 400);
        }
        const moduleView = await changeVozebCmsModuleState({
            moduleId: body.moduleId,
            enabled: body.enabled,
            baseRevision: Number(body.baseRevision),
            mutationId: body.mutationId.trim().slice(0, 120),
            updatedBy: currentUser.id,
        });
        await safeRecordAuditLog({
            action: "admin.module.state.update",
            actor: auditActorFromRequest(request, currentUser),
            target: { type: "vozeb_cms_module", id: moduleView.id, label: moduleView.name },
            metadata: { enabled: moduleView.enabled, revision: moduleView.revision },
        });
        return NextResponse.json({ code: 0, data: { module: moduleView, modules: await listVozebCmsModules() }, msg: moduleView.enabled ? "模块已启用" : "模块已停用" });
    } catch (error) {
        await safeRecordAuditLog({
            action: "admin.module.state.update",
            status: "failure",
            actor: auditActorFromRequest(request, currentUser),
            target: { type: "vozeb_cms_module", id: moduleId },
            metadata: { error: error instanceof Error ? error.message : "unknown" },
        });
        if (error instanceof VozebCmsModuleAccessError || error instanceof VozebCmsModuleStateError) return responseError(error.message, error.status);
        console.error("VOZEBCMS module state update failed", error);
        return responseError("模块状态更新失败", 500);
    }
}

function responseError(msg: string, status: number) {
    return NextResponse.json({ code: status, data: null, msg }, { status });
}
