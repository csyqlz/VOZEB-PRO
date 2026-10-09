import { NextResponse } from "next/server";

import { hasAdminPermission } from "@/lib/admin-permissions";
import { readJsonObjectBody } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { tenantErrorResponse } from "@/lib/server/tenant-route-response";
import { checkTenantMutationRateLimit } from "@/lib/server/tenant-rate-limit";
import { renameTenant } from "@/lib/server/tenant-service";
import { rateLimitHeaders } from "@/lib/server/security";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    if (!hasAdminPermission(currentUser, "tenants.manage")) return NextResponse.json({ code: 403, data: null, msg: "当前管理员没有维护租户的职责权限" }, { status: 403 });
    const limit = await checkTenantMutationRateLimit("platform-tenant-rename", currentUser.id);
    if (!limit.allowed) return NextResponse.json({ code: 429, data: null, msg: "修改租户过于频繁，请稍后再试" }, { status: 429, headers: rateLimitHeaders(limit) });
    try {
        const [{ id }, body] = await Promise.all([context.params, readJsonObjectBody(request)]);
        const tenant = await renameTenant(currentUser, id, typeof body.name === "string" ? body.name : "");
        return NextResponse.json({ code: 0, data: { tenant }, msg: "租户名称已更新" });
    } catch (error) {
        return tenantErrorResponse(error, "更新租户失败");
    }
}
