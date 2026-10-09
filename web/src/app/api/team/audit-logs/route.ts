import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { requireTenantContext } from "@/lib/server/tenant-context";
import { tenantErrorResponse } from "@/lib/server/tenant-route-response";
import { listTenantAuditLogs } from "@/lib/server/tenant-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    try {
        const tenant = await requireTenantContext(currentUser.id, ["owner", "admin"]);
        const params = new URL(request.url).searchParams;
        const logs = await listTenantAuditLogs(tenant, { page: Number(params.get("page") || 1), pageSize: Number(params.get("pageSize") || 20), keyword: params.get("keyword") || "" });
        return NextResponse.json({ code: 0, data: { tenant, ...logs }, msg: "OK" });
    } catch (error) {
        return tenantErrorResponse(error, "获取租户审计失败");
    }
}
