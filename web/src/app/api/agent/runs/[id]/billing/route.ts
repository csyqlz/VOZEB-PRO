import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { getAgentRun } from "@/lib/server/agent-run-store";
import { getGenerationRunBillingSummary } from "@/lib/server/generation-run-billing-service";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const run = await getAgentRun((await params).id);
    if (!run || run.userId !== user.id) return NextResponse.json({ code: 404, data: null, msg: "Agent 任务不存在" }, { status: 404 });
    return NextResponse.json({ code: 0, data: { summary: await getGenerationRunBillingSummary(user.id, run.id) }, msg: "OK" });
}
