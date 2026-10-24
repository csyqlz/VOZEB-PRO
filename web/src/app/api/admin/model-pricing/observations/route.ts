import { NextResponse } from "next/server";

import { hasAdminPermission } from "@/lib/admin-permissions";
import { readJsonBody } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { PricingConflictError, PricingInputError } from "@/lib/model-pricing";
import { auditActorFromRequest, safeRecordAuditLog } from "@/lib/server/audit-log-store";
import {
    amendOfficialPriceObservationEvidence,
    bindOfficialPriceObservation,
    deleteOfficialPriceObservationEvidence,
    invalidateOfficialPriceObservationEvidence,
    listOfficialPriceObservations,
    reviewOfficialPriceObservationEvidence,
    saveOfficialPriceObservation,
} from "@/lib/server/model-pricing-observation-service";

export const runtime = "nodejs";

async function authorize() {
    const user = await getCurrentUser();
    if (!user) return { error: NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 }) };
    if (!hasAdminPermission(user, "upstream.manage")) return { error: NextResponse.json({ code: 403, data: null, msg: "需要上游配置权限" }, { status: 403 }) };
    return { user };
}
function failure(error: unknown) {
    if (error instanceof PricingConflictError) return NextResponse.json({ code: 409, data: null, msg: error.message }, { status: 409 });
    if (error instanceof PricingInputError) return NextResponse.json({ code: 400, data: null, msg: error.message }, { status: 400 });
    console.error("Official price observation operation failed", error);
    return NextResponse.json({ code: 500, data: null, msg: "官网发现操作失败" }, { status: 500 });
}
export async function GET(request: Request) {
    const auth = await authorize();
    if (auth.error) return auth.error;
    try {
        const url = new URL(request.url);
        return NextResponse.json({
            code: 0,
            data: await listOfficialPriceObservations(Number(url.searchParams.get("page") || 1), url.searchParams.get("manufacturer") || "", (url.searchParams.get("status") || "all") as "open" | "pending" | "confirmed" | "rejected" | "all"),
            msg: "ok",
        });
    } catch (error) {
        return failure(error);
    }
}
export async function DELETE(request: Request) {
    const auth = await authorize();
    if (auth.error) return auth.error;
    try {
        const body = await readJsonBody<Record<string, unknown>>(request);
        const deleted = await deleteOfficialPriceObservationEvidence(String(body.id || ""));
        await safeRecordAuditLog({
            action: "admin.model-pricing.observation-delete",
            actor: auditActorFromRequest(request, auth.user),
            target: { type: "model_official_price_observation", id: deleted.id },
            metadata: { manufacturer: deleted.manufacturer, officialModelId: deleted.officialModelId },
        });
        return NextResponse.json({ code: 0, data: { id: deleted.id, deleted: true }, msg: "ok" });
    } catch (error) {
        return failure(error);
    }
}
export async function POST(request: Request) {
    const auth = await authorize();
    if (auth.error) return auth.error;
    try {
        const data = await saveOfficialPriceObservation(await readJsonBody(request), auth.user!.id);
        await safeRecordAuditLog({
            action: "admin.model-pricing.observation-save",
            actor: auditActorFromRequest(request, auth.user),
            target: { type: "model_official_price_observation", id: data.id },
            metadata: { manufacturer: data.manufacturer, officialModelId: data.officialModelId },
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
        const id = String(body.id || "");
        const data =
            body.action === "amend"
                ? await amendOfficialPriceObservationEvidence(id, body, auth.user!.id)
                : body.action === "review"
                  ? await reviewOfficialPriceObservationEvidence(id, body.status as "confirmed" | "rejected", String(body.note || ""), auth.user!.id, Number(body.expectedRevision ?? 0))
                  : body.action === "invalidate"
                    ? await invalidateOfficialPriceObservationEvidence(id, String(body.reason || ""), auth.user!.id)
                    : body.action === "bind"
                      ? await bindOfficialPriceObservation(id, typeof body.logicalModelId === "string" && body.logicalModelId ? body.logicalModelId : null, auth.user!.id)
                      : (() => {
                            throw new PricingInputError("官网发现操作无效");
                        })();
        await safeRecordAuditLog({
            action:
                body.action === "amend"
                    ? "admin.model-pricing.observation-amend"
                    : body.action === "review"
                      ? "admin.model-pricing.observation-review"
                      : body.action === "invalidate"
                        ? "admin.model-pricing.observation-invalidate"
                        : "admin.model-pricing.observation-bind",
            actor: auditActorFromRequest(request, auth.user),
            target: { type: "model_official_price_observation", id },
            metadata: {
                status: body.action === "invalidate" ? "rejected" : body.status || null,
                logicalModelId: body.logicalModelId || null,
                reason: body.action === "amend" || body.action === "invalidate" ? body.reason : null,
                variantIndex: body.action === "amend" ? body.variantIndex : null,
            },
        });
        return NextResponse.json({ code: 0, data, msg: "ok" });
    } catch (error) {
        return failure(error);
    }
}
