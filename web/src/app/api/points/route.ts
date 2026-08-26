import { NextResponse } from "next/server";

import { listPointRecordsPage } from "@/lib/auth/store";
import { getCurrentUser } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ error: "请先登录" }, { status: 401 });

    const url = new URL(request.url);
    const page = Number(url.searchParams.get("page") || 1);
    const pageSize = Number(url.searchParams.get("pageSize") || url.searchParams.get("limit") || 10);
    const directionValue = url.searchParams.get("direction");
    const direction = directionValue === "credit" || directionValue === "debit" ? directionValue : undefined;
    const view = url.searchParams.get("view") === "consumption" ? "consumption" : undefined;
    return NextResponse.json(await listPointRecordsPage(currentUser.id, view ? { page, pageSize, direction, view } : { page, pageSize, direction }));
}
