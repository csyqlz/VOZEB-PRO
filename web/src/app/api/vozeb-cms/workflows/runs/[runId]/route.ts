import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { requireVozebCmsCapability } from "@/app/api/vozeb-cms-capability";
import { getRecoverableVozebCmsWorkflowRun } from "@/lib/server/vozeb-cms/workflow-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
    const user = await getCurrentUser(request);
    if (!user) return responseError("请先登录", 401);
    const blocked = await requireVozebCmsCapability("workflow.run", user.id);
    if (blocked) return blocked;
    const runId = (await params).runId;
    const run = await getRecoverableVozebCmsWorkflowRun(user.id, runId);
    if (!run) return responseError("工作流运行不存在", 404);
    return NextResponse.json({ code: 0, data: { run }, msg: "ok" });
}

function responseError(msg: string, status: number) {
    return NextResponse.json({ code: status, data: null, msg }, { status });
}
