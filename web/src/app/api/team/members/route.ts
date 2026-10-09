import { NextResponse } from "next/server";

import { readJsonObjectBody } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import type { TenantMembershipStatus } from "@/lib/tenant";
import { requireTenantContext } from "@/lib/server/tenant-context";
import { tenantErrorResponse } from "@/lib/server/tenant-route-response";
import { checkTenantMutationRateLimit } from "@/lib/server/tenant-rate-limit";
import { createTenantMember, listTenantMembers } from "@/lib/server/tenant-service";
import { rateLimitHeaders } from "@/lib/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    try {
        const tenant = await requireTenantContext(currentUser.id, ["owner", "admin"]);
        const params = new URL(request.url).searchParams;
        const rawStatus = params.get("status");
        const status = rawStatus === "active" || rawStatus === "disabled" ? (rawStatus as TenantMembershipStatus) : undefined;
        const members = await listTenantMembers(tenant, { page: Number(params.get("page") || 1), pageSize: Number(params.get("pageSize") || 20), keyword: params.get("keyword") || "", status });
        return NextResponse.json({ code: 0, data: { tenant, ...members }, msg: "OK" });
    } catch (error) {
        return tenantErrorResponse(error, "获取成员列表失败");
    }
}

export async function POST(request: Request) {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    try {
        const tenant = await requireTenantContext(currentUser.id, ["owner", "admin"]);
        const limit = await checkTenantMutationRateLimit("tenant-member-create", `${tenant.tenantId}:${currentUser.id}`);
        if (!limit.allowed) return NextResponse.json({ code: 429, data: null, msg: "创建成员过于频繁，请稍后再试" }, { status: 429, headers: rateLimitHeaders(limit) });
        const body = await readJsonObjectBody(request);
        const member = await createTenantMember(tenant, currentUser, {
            username: typeof body.username === "string" ? body.username : "",
            displayName: typeof body.displayName === "string" ? body.displayName : "",
            email: typeof body.email === "string" ? body.email : "",
            password: typeof body.password === "string" ? body.password : "",
            role: body.role === "admin" ? "admin" : "member",
        });
        return NextResponse.json({ code: 0, data: { member }, msg: "成员创建成功" }, { status: 201 });
    } catch (error) {
        return tenantErrorResponse(error, "创建成员失败");
    }
}
