import { NextResponse } from "next/server";

import { readJsonObjectBody } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { requireTenantContext } from "@/lib/server/tenant-context";
import { tenantErrorResponse } from "@/lib/server/tenant-route-response";
import { checkTenantMutationRateLimit } from "@/lib/server/tenant-rate-limit";
import { TenantInputError, updateTenantMember } from "@/lib/server/tenant-service";
import { rateLimitHeaders } from "@/lib/server/security";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ userId: string }> }) {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    try {
        const tenant = await requireTenantContext(currentUser.id, ["owner", "admin"]);
        const limit = await checkTenantMutationRateLimit("tenant-member-update", `${tenant.tenantId}:${currentUser.id}`);
        if (!limit.allowed) return NextResponse.json({ code: 429, data: null, msg: "更新成员过于频繁，请稍后再试" }, { status: 429, headers: rateLimitHeaders(limit) });
        const [{ userId }, body] = await Promise.all([context.params, readJsonObjectBody(request)]);
        const role = body.role === "admin" || body.role === "member" ? body.role : undefined;
        const status = body.status === "active" || body.status === "disabled" ? body.status : undefined;
        if (!role && !status) throw new TenantInputError("请提供有效的角色或状态");
        const member = await updateTenantMember(tenant, currentUser, userId, { role, status });
        return NextResponse.json({ code: 0, data: { member }, msg: "成员已更新" });
    } catch (error) {
        return tenantErrorResponse(error, "更新成员失败");
    }
}
