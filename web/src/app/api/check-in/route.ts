import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ error: "请先登录" }, { status: 401 });

    return NextResponse.json({ error: "签到功能已取消，每日免费人民币余额会按套餐自动发放且仅当日有效" }, { status: 410 });
}
