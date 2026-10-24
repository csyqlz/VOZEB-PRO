import { NextResponse } from "next/server";
import { hasAdminPermission } from "@/lib/admin-permissions";
import { readJsonBody } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { PricingInputError } from "@/lib/model-pricing";
import { auditActorFromRequest, safeRecordAuditLog } from "@/lib/server/audit-log-store";
import { revalueSavedTextEvidence } from "@/lib/server/model-pricing-shadow-evidence";

export const runtime = "nodejs";

export async function POST(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    if (!hasAdminPermission(user, "billing.manage")) return NextResponse.json({ code: 403, data: null, msg: "没有模型计费管理权限" }, { status: 403 });
    try {
        const body = await readJsonBody<Record<string, unknown>>(request);
        const modelId = typeof body.modelId === "string" ? body.modelId : "";
        const bindingKey = typeof body.bindingKey === "string" ? body.bindingKey : "";
        const data = await revalueSavedTextEvidence(modelId, bindingKey);
        await safeRecordAuditLog({ action: "admin.model-pricing.text-evidence-revalue", actor: auditActorFromRequest(request, user), target: { type: "model_pricing_binding", id: bindingKey }, metadata: { modelId, revalued: data.revalued } });
        return NextResponse.json({ code: 0, data, msg: "ok" });
    } catch (error) {
        if (error instanceof PricingInputError) return NextResponse.json({ code: 400, data: null, msg: error.message }, { status: 400 });
        console.error("Text evidence revaluation failed", { errorType: error instanceof Error ? error.name : "unknown" });
        return NextResponse.json({ code: 500, data: null, msg: "已有文本调用复核失败" }, { status: 500 });
    }
}
