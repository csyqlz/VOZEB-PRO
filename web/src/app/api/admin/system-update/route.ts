import { NextResponse } from "next/server";

import { hasAdminPermission } from "@/lib/admin-permissions";
import { readJsonBody } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import type { SystemUpdateRequest } from "@/lib/system-update-contract";
import { auditActorFromRequest, safeRecordAuditLog } from "@/lib/server/audit-log-store";
import { getSystemUpdateInfo, requestSystemUpdate, SystemUpdateServiceError } from "@/lib/server/system-update-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
    const user = await getCurrentUser();
    if (!user) return failure("请先登录", 401);
    if (!hasAdminPermission(user, "system.manage")) return failure("需要系统管理权限", 403);
    try {
        return NextResponse.json({ code: 0, data: await getSystemUpdateInfo(), msg: "ok" }, privateResponse());
    } catch (error) {
        return serviceFailure(error);
    }
}

export async function POST(request: Request) {
    const user = await getCurrentUser();
    if (!user) return failure("请先登录", 401);
    if (!hasAdminPermission(user, "system.manage")) return failure("需要系统管理权限", 403);
    let input: SystemUpdateRequest | undefined;
    try {
        input = await readJsonBody<SystemUpdateRequest>(request);
        if ((input.action !== "upgrade" && input.action !== "rollback") || !input.confirmations || typeof input.targetVersion !== "string" || typeof input.idempotencyKey !== "string") return failure("升级请求参数无效", 400);
        const operation = await requestSystemUpdate(input);
        await safeRecordAuditLog({
            action: `admin.system_update.${input.action}`,
            actor: auditActorFromRequest(request, user),
            target: { type: "system_version", id: input.targetVersion, label: `VOZEB PRO ${input.targetVersion}` },
            metadata: { operationId: operation.id, status: operation.status },
        });
        return NextResponse.json({ code: 0, data: { operation }, msg: input.action === "upgrade" ? "升级任务已启动" : "回滚任务已启动" }, privateResponse(202));
    } catch (error) {
        await safeRecordAuditLog({
            action: `admin.system_update.${input?.action || "unknown"}`,
            status: "failure",
            actor: auditActorFromRequest(request, user),
            target: { type: "system_version", id: input?.targetVersion },
            metadata: { error: error instanceof Error ? error.message : "unknown" },
        });
        return serviceFailure(error);
    }
}

function serviceFailure(error: unknown) {
    if (error instanceof SystemUpdateServiceError) return failure(error.message, error.status);
    console.error("system update request failed", error);
    return failure("版本更新服务暂不可用", 500);
}

function failure(msg: string, status: number) {
    return NextResponse.json({ code: status, data: null, msg }, privateResponse(status));
}

function privateResponse(status = 200) {
    return { status, headers: { "Cache-Control": "private, no-store" } };
}
