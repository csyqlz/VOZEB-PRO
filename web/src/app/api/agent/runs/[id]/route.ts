import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { getAgentRun } from "@/lib/server/agent-run-store";
import { publicAgentRunForRequest } from "@/lib/server/agent-run-public-selection";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const run = await getAgentRun((await params).id);
    if (!run || run.userId !== user.id) return NextResponse.json({ code: 404, data: null, msg: "Agent 任务不存在" }, { status: 404 });
    return NextResponse.json({ code: 0, data: { run: await publicAgentRunForRequest(run, request) }, msg: "OK" });
}
