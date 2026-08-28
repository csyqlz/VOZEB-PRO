import { NextResponse } from "next/server";

import { isAuthorizedWorkerRequest, isWorkerTokenConfigured } from "@/lib/server/maintenance-auth";
import { getInstallStatus } from "@/lib/server/install-status";
import { claimVozebCmsWorkflowRunsForMaintenance, getNextVozebCmsWorkflowDueAt } from "@/lib/server/vozeb-cms/workflow-store";
import { advanceVozebCmsWorkflowRun } from "@/lib/server/vozeb-cms/workflow-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2400;

export async function POST(request: Request) {
    if (!isWorkerTokenConfigured()) return NextResponse.json({ code: 503, data: null, msg: "Worker 令牌未配置或未与维护令牌分离" }, { status: 503 });
    if (!isAuthorizedWorkerRequest(request)) return NextResponse.json({ code: 401, data: null, msg: "Worker 认证失败" }, { status: 401 });
    try {
        if (!(await getInstallStatus()).database.schemaReady) return NextResponse.json({ code: 0, data: { claimed: 0, completed: 0 }, msg: "等待初始化数据库" });
        const owner = request.headers.get("x-vozeb-pro-worker-id")?.trim() || "vozeb-workflow-maintenance";
        const candidates = await claimVozebCmsWorkflowRunsForMaintenance(owner, 20);
        let completed = 0;
        for (const run of candidates) {
            const result = await advanceVozebCmsWorkflowRun(run.userId, run.id, { owner, claimed: true });
            if (result && ["completed", "failed", "cancelled"].includes(result.status)) completed += 1;
        }
        const nextDueAt = await getNextVozebCmsWorkflowDueAt();
        return NextResponse.json({ code: 0, data: { claimed: candidates.length, completed, nextDueAt }, msg: candidates.length ? `已处理 ${candidates.length} 个工作流运行` : "没有待处理的工作流" });
    } catch (error) {
        console.error("VOZEBCMS workflow recovery batch failed", error);
        return NextResponse.json({ code: 500, data: null, msg: "工作流恢复失败" }, { status: 500 });
    }
}
