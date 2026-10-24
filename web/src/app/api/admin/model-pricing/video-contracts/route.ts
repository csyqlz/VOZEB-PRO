import { NextResponse } from "next/server";

import { hasAdminPermission } from "@/lib/admin-permissions";
import { readJsonBodyResult } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { PricingConflictError, PricingInputError } from "@/lib/model-pricing";
import { auditActorFromRequest, safeRecordAuditLog } from "@/lib/server/audit-log-store";
import { getVideoPriceContractHistory, getVideoPriceContractOptions, reviewVideoPriceContract } from "@/lib/server/model-pricing-video-contract-service";

export const runtime = "nodejs";

async function authorize() {
    const user = await getCurrentUser();
    if (!user) return { error: NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 }) };
    if (!hasAdminPermission(user, "billing.manage")) return { error: NextResponse.json({ code: 403, data: null, msg: "没有模型售价管理权限" }, { status: 403 }) };
    return { user };
}

function failure(error: unknown) {
    if (error instanceof PricingConflictError) return NextResponse.json({ code: 409, data: null, msg: error.message }, { status: 409 });
    if (error instanceof PricingInputError) return NextResponse.json({ code: 400, data: null, msg: error.message }, { status: 400 });
    console.error("Video price contract operation failed", error);
    return NextResponse.json({ code: 500, data: null, msg: "视频计费契约操作失败" }, { status: 500 });
}

export async function GET(request: Request) {
    const auth = await authorize();
    if (auth.error) return auth.error;
    try {
        const query = new URL(request.url).searchParams;
        const officialVersionId = query.get("officialVersionId") || "";
        const channelId = query.get("channelId") || "";
        const requestedModel = query.get("requestedModel") || "";
        const data = channelId || requestedModel ? await getVideoPriceContractHistory(officialVersionId, channelId, requestedModel) : await getVideoPriceContractOptions(officialVersionId, query.get("logicalModelId") || undefined);
        return NextResponse.json({ code: 0, data, msg: "ok" });
    } catch (error) {
        return failure(error);
    }
}

export async function POST(request: Request) {
    const auth = await authorize();
    if (auth.error) return auth.error;
    try {
        const parsed = await readJsonBodyResult<Record<string, unknown>>(request);
        if (!parsed.ok) return NextResponse.json({ code: parsed.status, data: null, msg: parsed.message }, { status: parsed.status });
        const body = parsed.data;
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new PricingInputError("视频契约请求格式无效");
        if (body.expectedCurrentId !== null && typeof body.expectedCurrentId !== "string") throw new PricingInputError("请先读取当前契约再提交审核");
        const data = await reviewVideoPriceContract(typeof body.officialVersionId === "string" ? body.officialVersionId : "", body.contract, body.expectedCurrentId, auth.user!.id, typeof body.logicalModelId === "string" ? body.logicalModelId : undefined);
        await safeRecordAuditLog({
            action: "admin.model-pricing.video-contract-review",
            actor: auditActorFromRequest(request, auth.user),
            target: { type: "model_video_price_contract", id: data.id },
            metadata: {
                officialVersionId: data.officialVersionId,
                logicalModelId: typeof body.logicalModelId === "string" ? body.logicalModelId : undefined,
                channelId: data.channelId,
                requestedModel: data.requestedModel,
                previousId: body.expectedCurrentId,
            },
        });
        return NextResponse.json({ code: 0, data, msg: "ok" });
    } catch (error) {
        return failure(error);
    }
}
