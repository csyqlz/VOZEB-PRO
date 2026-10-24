import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { PricingInputError } from "@/lib/model-pricing";
import { getPricingWalletView } from "@/lib/server/model-pricing-wallet-view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    try {
        const query = new URL(request.url).searchParams;
        const data = await getPricingWalletView(user.id, { page: Number(query.get("page") || 1), pageSize: Number(query.get("pageSize") || 20), status: query.get("status") || undefined });
        return NextResponse.json({ code: 0, data, msg: "ok" }, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
        if (error instanceof PricingInputError) return NextResponse.json({ code: 400, data: null, msg: error.message }, { status: 400 });
        console.error("Pricing wallet view failed", { errorType: error instanceof Error ? error.name : "unknown" });
        return NextResponse.json({ code: 500, data: null, msg: "计费记录加载失败，请稍后重试" }, { status: 500 });
    }
}
