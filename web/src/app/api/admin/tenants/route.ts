import { NextResponse } from "next/server";

import { hasAdminPermission } from "@/lib/admin-permissions";
import { readJsonObjectBody } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { tenantErrorResponse } from "@/lib/server/tenant-route-response";
import { checkTenantMutationRateLimit } from "@/lib/server/tenant-rate-limit";
import { createTenantWithOwner, listPlatformTenants } from "@/lib/server/tenant-service";
import { rateLimitHeaders } from "@/lib/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    if (!hasAdminPermission(currentUser, "tenants.read")) return NextResponse.json({ code: 403, data: null, msg: "当前管理员没有查看租户的职责权限" }, { status: 403 });
    try {
        const params = new URL(request.url).searchParams;
        const result = await listPlatformTenants({ page: Number(params.get("page") || 1), pageSize: Number(params.get("pageSize") || 20), keyword: params.get("keyword") || "" });
        return NextResponse.json({ code: 0, data: result, msg: "OK" });
    } catch (error) {
        return tenantErrorResponse(error, "获取租户列表失败");
    }
}

export async function POST(request: Request) {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    if (!hasAdminPermission(currentUser, "tenants.manage")) return NextResponse.json({ code: 403, data: null, msg: "当前管理员没有创建租户的职责权限" }, { status: 403 });
    const limit = await checkTenantMutationRateLimit("platform-tenant-create", currentUser.id);
    if (!limit.allowed) return NextResponse.json({ code: 429, data: null, msg: "创建租户过于频繁，请稍后再试" }, { status: 429, headers: rateLimitHeaders(limit) });
    try {
        const body = await readJsonObjectBody(request);
        const owner = body.owner && typeof body.owner === "object" && !Array.isArray(body.owner) ? (body.owner as Record<string, unknown>) : {};
        const result = await createTenantWithOwner(currentUser, {
            name: typeof body.name === "string" ? body.name : "",
            slug: typeof body.slug === "string" ? body.slug : "",
            owner: {
                username: typeof owner.username === "string" ? owner.username : "",
                displayName: typeof owner.displayName === "string" ? owner.displayName : "",
                email: typeof owner.email === "string" ? owner.email : "",
                password: typeof owner.password === "string" ? owner.password : "",
            },
        });
        return NextResponse.json({ code: 0, data: result, msg: "租户创建成功" }, { status: 201 });
    } catch (error) {
        return tenantErrorResponse(error, "创建租户失败");
    }
}
