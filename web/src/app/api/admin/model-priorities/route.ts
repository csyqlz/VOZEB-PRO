import { NextResponse } from "next/server";

import { getFreshAuthSettings } from "@/lib/auth/store";
import { readJsonBody } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { hasAllAdminPermissions } from "@/lib/admin-permissions";
import { auditActorFromRequest, safeRecordAuditLog } from "@/lib/server/audit-log-store";
import { commitModelPriorities, ModelPriorityConflict, previewModelPriorities } from "@/lib/server/model-priority-batch";

export const runtime = "nodejs";

async function authorize() {
    const user = await getCurrentUser();
    if (!user) return { error: NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 }) };
    if (!hasAllAdminPermissions(user, ["upstream.manage"])) return { error: NextResponse.json({ code: 403, data: null, msg: "需要上游配置权限" }, { status: 403 }) };
    return { user };
}

export async function POST(request: Request) {
    const auth = await authorize();
    if (auth.error) return auth.error;
    try {
        const scope = await readJsonBody<Parameters<typeof previewModelPriorities>[1]>(request);
        const rows = previewModelPriorities(await getFreshAuthSettings(), scope);
        return NextResponse.json({ code: 0, data: { rows }, msg: "ok" });
    } catch (error) {
        return NextResponse.json({ code: 400, data: null, msg: error instanceof Error ? error.message : "预览失败" }, { status: 400 });
    }
}

export async function PATCH(request: Request) {
    const auth = await authorize();
    if (auth.error) return auth.error;
    try {
        const input = await readJsonBody<Parameters<typeof commitModelPriorities>[0]>(request);
        const result = await commitModelPriorities(input);
        await safeRecordAuditLog({ action: "admin.model-priority.batch-update", actor: auditActorFromRequest(request, auth.user), target: { type: "logical_model_bindings" }, metadata: result });
        return NextResponse.json({ code: 0, data: result, msg: "批量优先级已保存" });
    } catch (error) {
        if (error instanceof ModelPriorityConflict) return NextResponse.json({ code: 409, data: { conflicts: error.items }, msg: error.message }, { status: 409 });
        if (error instanceof Error && /请选择|不能重复/.test(error.message)) return NextResponse.json({ code: 400, data: null, msg: error.message }, { status: 400 });
        console.error("Model priority batch update failed", error);
        return NextResponse.json({ code: 500, data: null, msg: "批量保存失败" }, { status: 500 });
    }
}
