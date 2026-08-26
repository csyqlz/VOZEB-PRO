import { NextResponse } from "next/server";

import { hasAdminPermission } from "@/lib/admin-permissions";
import { getCurrentUser } from "@/lib/auth/session";
import { auditActorFromRequest, safeRecordAuditLog } from "@/lib/server/audit-log-store";
import { cleanupNestedExternalStoragePreviews } from "@/lib/server/object-storage-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    if (!hasAdminPermission(user, "system.manage")) return NextResponse.json({ code: 403, data: null, msg: "当前管理员没有管理存储的职责权限" }, { status: 403 });
    try {
        const data = await cleanupNestedExternalStoragePreviews();
        await safeRecordAuditLog({
            action: "admin.object-storage.previews.cleanup",
            actor: auditActorFromRequest(request, user),
            target: { type: "object_storage", id: "primary" },
            metadata: data,
        });
        return NextResponse.json({ code: 0, data, msg: data.deleted ? "异常预览文件已清理" : "未发现异常预览文件" });
    } catch (error) {
        await safeRecordAuditLog({
            action: "admin.object-storage.previews.cleanup",
            status: "failure",
            actor: auditActorFromRequest(request, user),
            target: { type: "object_storage", id: "primary" },
            metadata: { error: error instanceof Error ? error.message : "unknown" },
        });
        console.error("Nested object preview cleanup failed", error);
        return NextResponse.json({ code: 500, data: null, msg: error instanceof Error ? error.message : "异常预览文件清理失败" }, { status: 500 });
    }
}
