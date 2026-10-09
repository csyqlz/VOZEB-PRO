import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { requireTenantContext } from "@/lib/server/tenant-context";
import { tenantErrorResponse } from "@/lib/server/tenant-route-response";
import { getTeamOverview } from "@/lib/server/tenant-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    try {
        const tenant = await requireTenantContext(currentUser.id, ["owner", "admin"]);
        return NextResponse.json({ code: 0, data: { tenant, overview: await getTeamOverview(tenant) }, msg: "OK" });
    } catch (error) {
        return tenantErrorResponse(error, "获取租户看板失败");
    }
}
