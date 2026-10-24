import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { NextResponse } from "next/server";
import { hasAdminPermission } from "@/lib/admin-permissions";
import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBodyResult } from "@/lib/auth/request";
import { PricingConflictError, PricingInputError } from "@/lib/model-pricing";
import { auditActorFromRequest, safeRecordAuditLog } from "@/lib/server/audit-log-store";
import { getPricingTaskReview, reviewPricingTask } from "@/lib/server/model-pricing-task-review-service";

export const maxDuration = 2400;

type Context = { params: Promise<{ type: string; id: string }> };
async function handle(request: Request, context: Context, write: boolean) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    if (!hasAdminPermission(user, "generation.manage") || !hasAdminPermission(user, "billing.manage")) return NextResponse.json({ code: 403, data: null, msg: "需要生成管理及账务管理权限" }, { status: 403 });
    const { type, id } = await context.params;
    if (type !== "text" && type !== "image" && type !== "video" && type !== "audio") return NextResponse.json({ code: 400, data: null, msg: "该能力尚未支持按量账务核对" }, { status: 400 });
    try {
        let data;
        if (write) {
            const body = await readJsonBodyResult<unknown>(request);
            if (!body.ok) return NextResponse.json({ code: body.status, data: null, msg: body.message }, { status: body.status });
            data = await reviewPricingTask(id, body.data, user.id, type, resolveInternalOrigin(new URL(request.url).origin));
            await safeRecordAuditLog({ action: "admin.model-pricing.task-review", actor: auditActorFromRequest(request, user), target: { type: `${type}_task`, id }, metadata: { executionPhase: data.executionPhase, reviewId: data.reviewId || null } });
        } else data = await getPricingTaskReview(id, type);
        return NextResponse.json({ code: 0, data, msg: "ok" }, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
        if (write)
            await safeRecordAuditLog({
                action: "admin.model-pricing.task-review",
                status: "failure",
                actor: auditActorFromRequest(request, user),
                target: { type: `${type}_task`, id },
                metadata: { errorType: error instanceof Error ? error.name : "unknown" },
            });
        const status = error instanceof PricingConflictError ? 409 : error instanceof PricingInputError ? 400 : 500;
        return NextResponse.json({ code: status, data: null, msg: status === 500 ? "账务核对暂时无法完成，请使用原任务恢复" : (error as Error).message }, { status });
    }
}
export const GET = (request: Request, context: Context) => handle(request, context, false);
export const POST = (request: Request, context: Context) => handle(request, context, true);
