import { NextResponse } from "next/server";

import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { runGenerationTaskRecoveryBatch } from "@/lib/server/generation-task-recovery-service";
import { getNextGenerationTaskDueAt } from "@/lib/server/generation-task-scheduler";
import { isAuthorizedWorkerRequest, isWorkerTokenConfigured } from "@/lib/server/maintenance-auth";
import { getInstallStatus } from "@/lib/server/install-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2400;

export async function POST(request: Request) {
    if (!isWorkerTokenConfigured()) return NextResponse.json({ code: 503, data: null, msg: "Worker 令牌未配置或未与维护令牌分离" }, { status: 503 });
    if (!isAuthorizedWorkerRequest(request)) return NextResponse.json({ code: 401, data: null, msg: "Worker 认证失败" }, { status: 401 });
    try {
        if (!(await getInstallStatus()).database.schemaReady) return NextResponse.json({ code: 0, data: { claimed: 0 }, msg: "等待初始化数据库" });
        const workerId = request.headers.get("x-vozeb-pro-worker-id")?.trim();
        const result = await runGenerationTaskRecoveryBatch({
            origin: resolveInternalOrigin(new URL(request.url).origin),
            publicOrigin: process.env.NEXT_PUBLIC_SITE_URL?.trim() || new URL(request.url).origin,
            limit: 50,
            workerId: workerId || undefined,
        });
        const nextDueAt = await getNextGenerationTaskDueAt();
        return NextResponse.json({ code: 0, data: { ...result, nextDueAt }, msg: result.claimed ? `已处理 ${result.claimed} 个生成任务` : "没有到期的生成任务" });
    } catch (error) {
        console.error("Generation task recovery batch failed", error);
        return NextResponse.json({ code: 500, data: null, msg: "生成任务恢复失败" }, { status: 500 });
    }
}
