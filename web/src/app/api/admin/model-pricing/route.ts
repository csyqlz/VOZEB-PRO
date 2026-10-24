import { NextResponse } from "next/server";

import { hasAnyAdminPermission, hasAdminPermission } from "@/lib/admin-permissions";
import { readJsonBody } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { PricingConflictError, PricingInputError, TextPriceScheduleError, TextPriceSelectionError } from "@/lib/model-pricing";
import { auditActorFromRequest, safeRecordAuditLog } from "@/lib/server/audit-log-store";
import { getModelPricingAdmission } from "@/lib/server/model-pricing-admission";
import { getModelPricingActivationStatus, setModelPricingActivation } from "@/lib/server/model-pricing-activation-service";
import { bindSelectedOfficialPrice, getCurrentModelPriceSelection, listModelPriceBindingHistory, previewSelectedOfficialPrice, revokeSelectedOfficialPrice } from "@/lib/server/model-price-binding-service";
import { getDirectedPricingEvidence, getModelPricingSampleUsage, revalueSavedImageEvidence } from "@/lib/server/model-pricing-shadow-evidence";
import {
    createOfficialPriceCandidate,
    editOfficialPriceCandidate,
    removeOfficialPriceCandidate,
    getModelPricingOverview,
    getIndependentOfficialPriceOptions,
    getOfficialPriceReferences,
    getOfficialPriceStructureReferences,
    getOfficialPriceReviewLinks,
    getOfficialPriceSources,
    linkReviewedOfficialPrice,
    previewSalesPricing,
    publishSalesPricing,
    reviewOfficialPriceCandidate,
    updateBusinessExchangeRate,
    updateOfficialPriceSource,
    unbindModelSalesPrice,
} from "@/lib/server/model-pricing-service";

export const runtime = "nodejs";

async function authorize(permission?: "upstream.manage" | "billing.manage") {
    const user = await getCurrentUser();
    if (!user) return { error: NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 }) };
    const allowed = permission ? hasAdminPermission(user, permission) : hasAnyAdminPermission(user, ["upstream.manage", "billing.manage"]);
    if (!allowed) return { error: NextResponse.json({ code: 403, data: null, msg: "没有模型售价管理权限" }, { status: 403 }) };
    return { user };
}

function failure(error: unknown) {
    if (error instanceof PricingConflictError) return NextResponse.json({ code: 409, data: null, msg: error.message }, { status: 409 });
    if (error instanceof TextPriceScheduleError) return NextResponse.json({ code: 400, data: { issues: error.issues }, msg: error.message }, { status: 400 });
    if (error instanceof TextPriceSelectionError) return NextResponse.json({ code: 400, data: { reason: error.reason, issues: error.issues }, msg: error.message }, { status: 400 });
    if (error instanceof PricingInputError) return NextResponse.json({ code: 400, data: null, msg: error.message }, { status: 400 });
    console.error("Model pricing operation failed", error);
    return NextResponse.json({ code: 500, data: null, msg: "模型售价操作失败" }, { status: 500 });
}

export async function GET(request: Request) {
    const auth = await authorize();
    if (auth.error) return auth.error;
    try {
        const url = new URL(request.url);
        if (url.searchParams.get("action") === "selection-binding") {
            return NextResponse.json({ code: 0, data: await getCurrentModelPriceSelection(url.searchParams.get("modelId") || "", url.searchParams.get("scope") || ""), msg: "ok" });
        }
        if (url.searchParams.get("action") === "selection-options") {
            return NextResponse.json({ code: 0, data: await getIndependentOfficialPriceOptions(url.searchParams.get("modelId") || "", Number(url.searchParams.get("page") || 1), url.searchParams.get("sku") || ""), msg: "ok" });
        }
        if (url.searchParams.get("action") === "selection-history") {
            if (!hasAdminPermission(auth.user!, "upstream.manage")) return NextResponse.json({ code: 403, data: null, msg: "需要上游配置权限" }, { status: 403 });
            return NextResponse.json({ code: 0, data: await listModelPriceBindingHistory(url.searchParams.get("modelId") || "", url.searchParams.get("scope") || "", Number(url.searchParams.get("page") || 1)), msg: "ok" });
        }
        if (url.searchParams.get("action") === "activation") {
            const operation = url.searchParams.get("imageOperation");
            const audioOperation = url.searchParams.get("audioOperation");
            if (operation && operation !== "generations" && operation !== "edits") throw new PricingInputError("图片计价操作无效");
            if (audioOperation && audioOperation !== "generateContent" && audioOperation !== "chat/completions") throw new PricingInputError("音频计价操作无效");
            if (operation && audioOperation) throw new PricingInputError("计价操作范围不能重复");
            return NextResponse.json({
                code: 0,
                data: await getModelPricingActivationStatus(url.searchParams.get("modelId") || "", (operation || undefined) as "generations" | "edits" | undefined, (audioOperation || undefined) as "generateContent" | "chat/completions" | undefined),
                msg: "ok",
            });
        }
        if (url.searchParams.get("action") === "sample") return NextResponse.json({ code: 0, data: await getModelPricingSampleUsage(url.searchParams.get("modelId") || "", url.searchParams.get("officialVersionId") || ""), msg: "ok" });
        if (url.searchParams.get("action") === "directed-evidence") {
            if (!hasAdminPermission(auth.user!, "billing.manage")) return NextResponse.json({ code: 403, data: null, msg: "需要财务管理权限" }, { status: 403 });
            const capability = url.searchParams.get("capability");
            if (!["text", "image", "video", "audio"].includes(capability || "")) return NextResponse.json({ code: 400, data: null, msg: "验收能力无效" }, { status: 400 });
            return NextResponse.json({ code: 0, data: await getDirectedPricingEvidence(auth.user!.id, url.searchParams.get("taskId") || "", capability as "text" | "image" | "video" | "audio"), msg: "ok" });
        }
        if (url.searchParams.get("action") === "admission") return NextResponse.json({ code: 0, data: await getModelPricingAdmission(url.searchParams.get("modelId") || ""), msg: "ok" });
        if (url.searchParams.get("action") === "official-sources") {
            if (!hasAdminPermission(auth.user!, "upstream.manage")) return NextResponse.json({ code: 403, data: null, msg: "需要上游配置权限" }, { status: 403 });
            return NextResponse.json({ code: 0, data: await getOfficialPriceSources(), msg: "ok" });
        }
        if (url.searchParams.get("action") === "review-links") {
            if (!hasAdminPermission(auth.user!, "upstream.manage")) return NextResponse.json({ code: 403, data: null, msg: "需要上游配置权限" }, { status: 403 });
            return NextResponse.json({ code: 0, data: await getOfficialPriceReviewLinks(url.searchParams.get("manufacturer") || ""), msg: "ok" });
        }
        if (url.searchParams.get("action") === "references")
            return NextResponse.json({ code: 0, data: await getOfficialPriceReferences(url.searchParams.get("manufacturer") || "", url.searchParams.get("series") || undefined, url.searchParams.get("officialVersion") || undefined), msg: "ok" });
        if (url.searchParams.get("action") === "structure-references") {
            if (!hasAdminPermission(auth.user!, "upstream.manage")) return NextResponse.json({ code: 403, data: null, msg: "需要上游配置权限" }, { status: 403 });
            return NextResponse.json({ code: 0, data: await getOfficialPriceStructureReferences(url.searchParams.get("modelId") || "", url.searchParams.get("manufacturer") || undefined, url.searchParams.get("capability") || undefined), msg: "ok" });
        }
        const candidateStatus = url.searchParams.get("candidateStatus") || undefined;
        return NextResponse.json({
            code: 0,
            data: await getModelPricingOverview(
                url.searchParams.get("modelId") || undefined,
                Number(url.searchParams.get("candidatePage") || 1),
                Number(url.searchParams.get("officialPage") || 1),
                {
                    modelId: url.searchParams.get("candidateModelId") || undefined,
                    manufacturer: url.searchParams.get("manufacturer") || undefined,
                    status: candidateStatus as "pending" | "approved" | "rejected" | undefined,
                },
                Number(url.searchParams.get("unpricedPage") || 1),
                {
                    manufacturer: url.searchParams.get("unpricedManufacturer") || undefined,
                    series: url.searchParams.get("unpricedSeries") || undefined,
                    capability: url.searchParams.get("unpricedCapability") || undefined,
                    name: url.searchParams.get("unpricedName") || undefined,
                    status: (url.searchParams.get("unpricedStatus") || undefined) as "no-candidate" | "pending-review" | "sales-unpublished" | undefined,
                },
                Number(url.searchParams.get("workbenchPage") || 1),
                {
                    enabled: (url.searchParams.get("workbenchEnabled") || undefined) as "active" | "disabled" | "all" | undefined,
                    manufacturer: url.searchParams.get("workbenchManufacturer") || undefined,
                    capability: url.searchParams.get("workbenchCapability") || undefined,
                    name: url.searchParams.get("workbenchName") || undefined,
                    status: (url.searchParams.get("workbenchStatus") || undefined) as "no-candidate" | "pending-review" | "sales-unpublished" | "published" | "channel-pending" | undefined,
                },
            ),
            msg: "ok",
        });
    } catch (error) {
        return failure(error);
    }
}

export async function POST(request: Request) {
    try {
        const body = await readJsonBody<Record<string, unknown>>(request);
        const action = body.action;
        if (action !== "candidate" && action !== "preview" && action !== "selection-preview") throw new PricingInputError("模型售价操作无效");
        const auth = await authorize(action === "candidate" ? "upstream.manage" : "billing.manage");
        if (auth.error) return auth.error;
        const data =
            action === "candidate"
                ? await createOfficialPriceCandidate(body.price, auth.user!.id)
                : action === "selection-preview"
                  ? await previewSelectedOfficialPrice(
                        String(body.modelId || ""),
                        String(body.scope || ""),
                        body.usage && typeof body.usage === "object" && !Array.isArray(body.usage) ? (body.usage as Record<string, string | number>) : {},
                        body.facts && typeof body.facts === "object" && !Array.isArray(body.facts) ? (body.facts as { inputTotalTokens?: number }) : undefined,
                    )
                  : await previewSalesPricing(
                        body.policy,
                        String(body.modelId || ""),
                        body.usage && typeof body.usage === "object" && !Array.isArray(body.usage) ? (body.usage as Record<string, string | number>) : {},
                        typeof body.scope === "string" ? body.scope : undefined,
                    );
        if (action === "candidate")
            await safeRecordAuditLog({
                action: "admin.model-pricing.price-candidate",
                actor: auditActorFromRequest(request, auth.user),
                target: { type: "model_price_candidate", id: (data as { id: string }).id },
                metadata: { logicalModelId: (data as { logicalModelId: string }).logicalModelId },
            });
        return NextResponse.json({ code: 0, data, msg: "ok" });
    } catch (error) {
        return failure(error);
    }
}

export async function PATCH(request: Request) {
    try {
        const body = await readJsonBody<Record<string, unknown>>(request);
        const action = body.action;
        if (
            action !== "review" &&
            action !== "candidate-edit" &&
            action !== "candidate-delete" &&
            action !== "price-link" &&
            action !== "selection-bind" &&
            action !== "selection-revoke" &&
            action !== "publish" &&
            action !== "unbind" &&
            action !== "exchange-rate" &&
            action !== "official-source" &&
            action !== "activation" &&
            action !== "revalue-image-evidence"
        )
            throw new PricingInputError("模型售价操作无效");
        const auth = await authorize(
            action === "review" || action === "candidate-edit" || action === "candidate-delete" || action === "price-link" || action === "selection-bind" || action === "selection-revoke" || action === "official-source"
                ? "upstream.manage"
                : "billing.manage",
        );
        if (auth.error) return auth.error;
        if (action === "activation" && body.imageOperation !== undefined && body.imageOperation !== "generations" && body.imageOperation !== "edits") throw new PricingInputError("图片计价操作无效");
        if (action === "revalue-image-evidence" && body.imageOperation !== undefined && body.imageOperation !== "generations" && body.imageOperation !== "edits") throw new PricingInputError("图片计价操作无效");
        if (action === "activation" && body.audioOperation !== undefined && body.audioOperation !== "generateContent" && body.audioOperation !== "chat/completions") throw new PricingInputError("音频计价操作无效");
        if (action === "activation" && body.imageOperation !== undefined && body.audioOperation !== undefined) throw new PricingInputError("计价操作范围不能重复");
        const data =
            action === "selection-bind"
                ? await bindSelectedOfficialPrice(
                      String(body.versionId || ""),
                      String(body.logicalModelId || ""),
                      String(body.operation || ""),
                      String(body.evidence || ""),
                      typeof body.expectedRevision === "string" ? body.expectedRevision : null,
                      auth.user!.id,
                  )
                : action === "selection-revoke"
                  ? await revokeSelectedOfficialPrice(String(body.logicalModelId || ""), String(body.scope || ""), String(body.evidence || ""), typeof body.expectedRevision === "string" ? body.expectedRevision : null, auth.user!.id)
                  : action === "revalue-image-evidence"
                    ? await revalueSavedImageEvidence(String(body.modelId || ""), String(body.bindingKey || ""), body.imageOperation as "generations" | "edits" | undefined)
                    : action === "activation"
                      ? await setModelPricingActivation({
                            modelId: String(body.modelId || ""),
                            enabled: body.enabled as boolean,
                            expectedRevision: body.expectedRevision as string | null,
                            actorId: auth.user!.id,
                            ...(typeof body.bindingKey === "string" ? { bindingKey: body.bindingKey } : {}),
                            ...(body.imageOperation === "generations" || body.imageOperation === "edits" ? { imageOperation: body.imageOperation } : {}),
                            ...(body.audioOperation === "generateContent" || body.audioOperation === "chat/completions" ? { audioOperation: body.audioOperation } : {}),
                        })
                      : action === "unbind"
                        ? await unbindModelSalesPrice(String(body.modelId || ""), typeof body.currentSalesVersionId === "string" ? body.currentSalesVersionId : null, auth.user!.id, typeof body.scope === "string" ? body.scope : undefined)
                        : action === "review"
                          ? await reviewOfficialPriceCandidate(String(body.candidateId || ""), body.approved === true, String(body.note || ""), auth.user!.id)
                          : action === "price-link"
                            ? await linkReviewedOfficialPrice(String(body.versionId || ""), String(body.logicalModelId || ""), auth.user!.id)
                            : action === "candidate-edit"
                              ? await editOfficialPriceCandidate(String(body.candidateId || ""), body.price, typeof body.expectedRevision === "string" ? body.expectedRevision : null, auth.user!.id)
                              : action === "candidate-delete"
                                ? await removeOfficialPriceCandidate(String(body.candidateId || ""), typeof body.expectedRevision === "string" ? body.expectedRevision : null)
                                : action === "official-source"
                                  ? await updateOfficialPriceSource(String(body.manufacturer || ""), String(body.url || ""), typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : null, auth.user!.id, body.create === true)
                                  : action === "exchange-rate"
                                    ? await updateBusinessExchangeRate(body.exchangeRate, typeof body.expectedObservedAt === "string" ? body.expectedObservedAt : null)
                                    : await publishSalesPricing(body.policy, typeof body.currentSalesVersionId === "string" ? body.currentSalesVersionId : null, String(body.previewToken || ""), auth.user!.id);
        await safeRecordAuditLog({
            action:
                action === "selection-bind" || action === "selection-revoke"
                    ? "admin.model-pricing.selection-binding"
                    : action === "revalue-image-evidence"
                      ? "admin.model-pricing.image-evidence-revalue"
                      : action === "activation"
                        ? "admin.model-pricing.activation"
                        : action === "unbind"
                          ? "admin.model-pricing.sales-unbind"
                          : action === "review"
                            ? "admin.model-pricing.price-review"
                            : action === "price-link"
                              ? "admin.model-pricing.price-link"
                              : action === "candidate-edit"
                                ? "admin.model-pricing.price-candidate-edit"
                                : action === "candidate-delete"
                                  ? "admin.model-pricing.price-candidate-delete"
                                  : action === "official-source"
                                    ? "admin.model-pricing.official-source-update"
                                    : action === "exchange-rate"
                                      ? "admin.model-pricing.exchange-rate-update"
                                      : "admin.model-pricing.sales-publish",
            actor: auditActorFromRequest(request, auth.user),
            target:
                action === "selection-bind" || action === "selection-revoke"
                    ? { type: "model_price_binding", id: (data as { id: string }).id }
                    : action === "price-link"
                      ? { type: "model_official_price_version", id: (data as { id: string }).id }
                      : action === "revalue-image-evidence"
                        ? { type: "model_pricing_binding", id: String(body.bindingKey) }
                        : action === "activation"
                          ? { type: "model_pricing_activation", id: String(body.modelId) }
                          : action === "unbind"
                            ? { type: "model_sales_version", id: (data as { id: string }).id }
                            : action === "exchange-rate"
                              ? { type: "model_exchange_rate", id: "default" }
                              : action === "official-source"
                                ? { type: "model_official_price_source", id: String(body.manufacturer) }
                                : {
                                      type: action === "review" || action === "candidate-edit" || action === "candidate-delete" ? "model_price_candidate" : "model_sales_version",
                                      id: action === "review" || action === "candidate-edit" || action === "candidate-delete" ? String(body.candidateId) : (data as { id: string }).id,
                                  },
            metadata:
                action === "selection-bind" || action === "selection-revoke"
                    ? {
                          logicalModelId: body.logicalModelId,
                          scope: (data as { scope: string }).scope,
                          status: (data as { status: string }).status,
                          versionId: (data as { officialVersionId: string | null }).officialVersionId,
                          previousRevision: body.expectedRevision || null,
                      }
                    : action === "price-link"
                      ? { sourceVersionId: body.versionId, logicalModelId: body.logicalModelId }
                      : action === "revalue-image-evidence"
                        ? { modelId: body.modelId, imageOperation: body.imageOperation || null, revalued: (data as Awaited<ReturnType<typeof revalueSavedImageEvidence>>).revalued }
                        : action === "activation"
                          ? {
                                enabled: body.enabled === true,
                                scope: (data as Awaited<ReturnType<typeof setModelPricingActivation>>).activation?.scope || null,
                                bindingKey: typeof body.bindingKey === "string" ? body.bindingKey : null,
                                revision: (data as Awaited<ReturnType<typeof setModelPricingActivation>>).activation?.revision,
                                fingerprint: (data as Awaited<ReturnType<typeof setModelPricingActivation>>).activation?.fingerprint,
                            }
                          : action === "unbind"
                            ? { modelId: body.modelId, previousVersionId: body.currentSalesVersionId || null }
                            : action === "review"
                              ? { approved: body.approved === true }
                              : action === "candidate-edit"
                                ? { revision: (data as { revision: string }).revision, previousRevision: body.expectedRevision || null }
                                : action === "candidate-delete"
                                  ? { previousRevision: body.expectedRevision || null }
                                  : action === "official-source"
                                    ? { operation: body.create === true ? "create" : "update", previousUpdatedAt: body.expectedUpdatedAt || null, source: data }
                                    : action === "exchange-rate"
                                      ? { previousObservedAt: body.expectedObservedAt || null, rate: data }
                                      : { versionId: (data as { id: string }).id, previousVersionId: body.currentSalesVersionId || null },
        });
        return NextResponse.json({ code: 0, data, msg: "ok" });
    } catch (error) {
        return failure(error);
    }
}
