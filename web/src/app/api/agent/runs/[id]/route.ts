import { NextResponse } from "next/server";
import { requireGenerationResourceAccess } from "@/app/api/generation-resource-access";
import { getCurrentUser } from "@/lib/auth/session";
import { getAgentRun } from "@/lib/server/agent-run-store";
import { publicAgentRun } from "@/lib/server/agent-run-public";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const run = await getAgentRun((await params).id);
    if (!run) return NextResponse.json({ code: 404, data: null, msg: "Agent 任务不存在" }, { status: 404 });
    const blocked = await requireGenerationResourceAccess({ actor: user, ownerUserId: run.userId, capabilityId: "agent.run", adminPermission: "generation.read", notFoundMessage: "Agent 任务不存在" });
    if (blocked) return blocked;
    return NextResponse.json({ code: 0, data: { run: publicAgentRun(run) }, msg: "OK" });
}
