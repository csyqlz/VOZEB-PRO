import { NextResponse } from "next/server";
import { hasAdminPermission } from "@/lib/admin-permissions";
import { getCurrentUser } from "@/lib/auth/session";
import { PricingInputError } from "@/lib/model-pricing";
import { listTextPricingExceptions } from "@/lib/server/model-pricing-text-exceptions";

export const runtime = "nodejs";

export async function GET(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    if (!hasAdminPermission(user, "billing.manage")) return NextResponse.json({ code: 403, data: null, msg: "没有模型计费管理权限" }, { status: 403 });
    const params = new URL(request.url).searchParams;
    try {
        const data = await listTextPricingExceptions({
            modelId: params.get("modelId") || "",
            channelId: params.get("channelId") || undefined,
            status: (params.get("status") || undefined) as "pending-review" | "settled-warning" | undefined,
            requestId: params.get("requestId") || undefined,
            from: params.get("from") || undefined,
            to: params.get("to") || undefined,
            offset: params.has("offset") ? Number(params.get("offset")) : 0,
        });
        return NextResponse.json({ code: 0, data, msg: "ok" });
    } catch (error) {
        if (error instanceof PricingInputError) return NextResponse.json({ code: 400, data: null, msg: error.message }, { status: 400 });
        console.error("Text pricing exception query failed", { errorType: error instanceof Error ? error.name : "unknown" });
        return NextResponse.json({ code: 500, data: null, msg: "计费异常暂时无法查询" }, { status: 500 });
    }
}
