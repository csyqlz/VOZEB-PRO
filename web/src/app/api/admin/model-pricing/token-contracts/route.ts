import { NextResponse } from "next/server";

import { hasAdminPermission } from "@/lib/admin-permissions";
import { readJsonBody } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { PricingConflictError, PricingInputError } from "@/lib/model-pricing";
import { auditActorFromRequest, safeRecordAuditLog } from "@/lib/server/audit-log-store";
import { getFlatTextPriceContractHistory, getFlatTextPriceContractOptions, reviewFlatTextPriceContract } from "@/lib/server/model-pricing-token-contract-service";

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
    console.error("Flat text price contract operation failed", error);
    return NextResponse.json({ code: 500, data: null, msg: "纯文本计费契约操作失败" }, { status: 500 });
}

export async function GET(request: Request) {
    const auth = await authorize();
    if (auth.error) return auth.error;
    try {
        const query = new URL(request.url).searchParams;
        const officialVersionId = query.get("officialVersionId") || "";
        const channelId = query.get("channelId") || "";
        const requestedModel = query.get("requestedModel") || "";
        const data = channelId || requestedModel ? await getFlatTextPriceContractHistory(officialVersionId, channelId, requestedModel) : await getFlatTextPriceContractOptions(officialVersionId, query.get("logicalModelId") || undefined);
        return NextResponse.json({ code: 0, data, msg: "ok" });
    } catch (error) {
        return failure(error);
    }
}

export async function POST(request: Request) {
    const auth = await authorize();
    if (auth.error) return auth.error;
    try {
        const body = await readJsonBody<Record<string, unknown>>(request);
        if (body.expectedCurrentId !== null && typeof body.expectedCurrentId !== "string") throw new PricingInputError("请先读取当前契约再提交审核");
        const data = await reviewFlatTextPriceContract(
            typeof body.officialVersionId === "string" ? body.officialVersionId : "",
            body.contract,
            body.expectedCurrentId,
            auth.user!.id,
            typeof body.logicalModelId === "string" ? body.logicalModelId : undefined,
        );
        await safeRecordAuditLog({
            action: "admin.model-pricing.flat-text-contract-review",
            actor: auditActorFromRequest(request, auth.user),
            target: { type: "model_flat_text_price_contract", id: data.id },
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
