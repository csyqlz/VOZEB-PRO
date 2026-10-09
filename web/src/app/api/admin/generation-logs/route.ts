import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { readJsonBody } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { getPublicUsersByIds } from "@/lib/auth/store";
import { deleteGenerationLogs, listGenerationLogs } from "@/lib/server/generation-log-store";
import { hasAdminPermission } from "@/lib/admin-permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    if (!hasAdminPermission(currentUser, "generation.read")) return NextResponse.json({ error: "当前管理员没有查看生成记录的职责权限" }, { status: 403 });

    const params = request.nextUrl.searchParams;
    const result = await listGenerationLogs({
        page: Number(params.get("page")) || 1,
        pageSize: Number(params.get("pageSize")) || 20,
        keyword: params.get("keyword") || "",
        kind: params.get("kind") || "",
        source: params.get("source") || "",
        status: params.get("status") || "",
        userId: params.get("userId") || "",
        start: params.get("start") || "",
        end: params.get("end") || "",
        includeEcommerceTrace: true,
    });

    const users = await getPublicUsersByIds(result.items.map((item) => item.userId));
    const accountIdByUserId = new Map(users.map((user) => [user.id, user.accountId]));
    return NextResponse.json({ logs: result.items.map((item) => ({ ...item, accountId: accountIdByUserId.get(item.userId) })), total: result.total, page: result.page, pageSize: result.pageSize });
}

export async function DELETE(request: Request) {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    if (!hasAdminPermission(currentUser, "generation.manage")) return NextResponse.json({ error: "当前管理员没有管理生成记录的职责权限" }, { status: 403 });

    const body = await readJsonBody<{ ids?: unknown }>(request);
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    const result = await deleteGenerationLogs(ids);
    return NextResponse.json(result);
}
