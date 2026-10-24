import { NextResponse } from "next/server";

import { hasAdminPermission } from "@/lib/admin-permissions";
import { readJsonBody } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { PricingConflictError, PricingInputError } from "@/lib/model-pricing";
import { auditActorFromRequest, safeRecordAuditLog } from "@/lib/server/audit-log-store";
import { createOfficialPriceCatalog, editOfficialPriceCatalog, getOfficialPriceCatalog, getOfficialPriceCatalogImpact, removeOfficialPriceCatalog } from "@/lib/server/model-pricing-catalog-service";

export const runtime = "nodejs";

async function authorize(readOnly = false) {
    const user = await getCurrentUser();
    if (!user) return { error: NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 }) };
    if (!hasAdminPermission(user, "upstream.manage") && !(readOnly && hasAdminPermission(user, "billing.manage"))) return { error: NextResponse.json({ code: 403, data: null, msg: "需要上游配置或计费权限" }, { status: 403 }) };
    return { user };
}

function failure(error: unknown) {
    if (error instanceof PricingConflictError) return NextResponse.json({ code: 409, data: null, msg: error.message }, { status: 409 });
    if (error instanceof PricingInputError) return NextResponse.json({ code: 400, data: null, msg: error.message }, { status: 400 });
    console.error("Official price catalog operation failed", error);
    return NextResponse.json({ code: 500, data: null, msg: "官方型号目录操作失败" }, { status: 500 });
}

export async function GET(request: Request) {
    const auth = await authorize(true);
    if (auth.error) return auth.error;
    try {
        const params = new URL(request.url).searchParams;
        const manufacturer = params.get("manufacturer") || "";
        return NextResponse.json({ code: 0, data: params.has("impactId") ? await getOfficialPriceCatalogImpact(manufacturer, params.get("impactId") || "") : await getOfficialPriceCatalog(manufacturer), msg: "ok" });
    } catch (error) {
        return failure(error);
    }
}

export async function POST(request: Request) {
    const auth = await authorize();
    if (auth.error) return auth.error;
    try {
        const body = await readJsonBody<Record<string, unknown>>(request);
        const data = await createOfficialPriceCatalog(body, auth.user!.id);
        await safeRecordAuditLog({
            action: "admin.model-pricing.catalog-create",
            actor: auditActorFromRequest(request, auth.user),
            target: { type: "official_price_catalog", id: data.id },
            metadata: { manufacturer: data.manufacturer, kind: data.kind, parentId: data.parentId },
        });
        return NextResponse.json({ code: 0, data, msg: "ok" });
    } catch (error) {
        return failure(error);
    }
}

export async function PATCH(request: Request) {
    const auth = await authorize();
    if (auth.error) return auth.error;
    try {
        const body = await readJsonBody<Record<string, unknown>>(request);
        const data = await editOfficialPriceCatalog(body, auth.user!.id);
        await safeRecordAuditLog({
            action: "admin.model-pricing.catalog-update",
            actor: auditActorFromRequest(request, auth.user),
            target: { type: "official_price_catalog", id: data.id },
            metadata: { manufacturer: data.manufacturer, kind: data.kind, parentId: data.parentId },
        });
        return NextResponse.json({ code: 0, data, msg: "ok" });
    } catch (error) {
        return failure(error);
    }
}

export async function DELETE(request: Request) {
    const auth = await authorize();
    if (auth.error) return auth.error;
    try {
        const body = await readJsonBody<Record<string, unknown>>(request);
        await removeOfficialPriceCatalog(body);
        await safeRecordAuditLog({ action: "admin.model-pricing.catalog-delete", actor: auditActorFromRequest(request, auth.user), target: { type: "official_price_catalog", id: String(body.id) }, metadata: { manufacturer: body.manufacturer } });
        return NextResponse.json({ code: 0, data: { id: body.id }, msg: "ok" });
    } catch (error) {
        return failure(error);
    }
}
