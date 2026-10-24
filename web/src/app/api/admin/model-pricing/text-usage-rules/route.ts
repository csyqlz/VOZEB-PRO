import { NextResponse } from "next/server";
import { hasAdminPermission } from "@/lib/admin-permissions";
import { readJsonBody } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { PricingConflictError, PricingInputError } from "@/lib/model-pricing";
import { auditActorFromRequest, safeRecordAuditLog } from "@/lib/server/audit-log-store";
import { getTextUsageRuleOptions, reviewModelTextUsageRule } from "@/lib/server/model-pricing-text-usage-rule-service";

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
    console.error("Text usage rule operation failed", error);
    return NextResponse.json({ code: 500, data: null, msg: "文本用量规则操作失败" }, { status: 500 });
}

export async function GET(request: Request) {
    const auth = await authorize();
    if (auth.error) return auth.error;
    try {
        return NextResponse.json({ code: 0, data: await getTextUsageRuleOptions(new URL(request.url).searchParams.get("modelId") || ""), msg: "ok" });
    } catch (error) {
        return failure(error);
    }
}

export async function POST(request: Request) {
    const auth = await authorize();
    if (auth.error) return auth.error;
    try {
        const body = await readJsonBody<Record<string, unknown>>(request);
        if (
            typeof body.modelId !== "string" ||
            typeof body.officialVersionId !== "string" ||
            typeof body.evidence !== "string" ||
            typeof body.cacheReadMissingAsZero !== "boolean" ||
            typeof body.cacheWriteMissingAsZero !== "boolean" ||
            (body.expectedCurrentId !== null && typeof body.expectedCurrentId !== "string")
        )
            throw new PricingInputError("文本缓存缺失规则参数无效");
        const data = await reviewModelTextUsageRule({
            modelId: body.modelId,
            officialVersionId: body.officialVersionId,
            evidence: body.evidence,
            cacheReadMissingAsZero: body.cacheReadMissingAsZero,
            cacheWriteMissingAsZero: body.cacheWriteMissingAsZero,
            expectedCurrentId: body.expectedCurrentId,
            actorId: auth.user!.id,
        });
        await safeRecordAuditLog({
            action: "admin.model-pricing.text-usage-rule-review",
            actor: auditActorFromRequest(request, auth.user),
            target: { type: "model_text_usage_rule", id: data.id },
            metadata: { modelId: data.modelId, officialVersionId: data.officialVersionId, previousId: body.expectedCurrentId, cacheReadMissingAsZero: data.cacheReadMissingAsZero, cacheWriteMissingAsZero: data.cacheWriteMissingAsZero },
        });
        return NextResponse.json({ code: 0, data, msg: "ok" });
    } catch (error) {
        return failure(error);
    }
}
