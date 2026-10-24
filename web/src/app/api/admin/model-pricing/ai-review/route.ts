import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { hasAdminPermission } from "@/lib/admin-permissions";
import { readJsonBody } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { auditActorFromRequest, safeRecordAuditLog } from "@/lib/server/audit-log-store";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { markByteDanceSeedRetired, PriceReviewError, reviewOfficialPrices, unmarkByteDanceSeedRetired } from "@/lib/server/model-pricing-ai-review";

export const runtime = "nodejs";
export const maxDuration = 2400;

export async function POST(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    if (!hasAdminPermission(user, "upstream.manage")) return NextResponse.json({ code: 403, data: null, msg: "需要上游配置权限" }, { status: 403 });
    try {
        const body = await readJsonBody<{ requestId?: string; manufacturer?: string; sourceUrl?: string; sourceText?: string; retirementText?: string; targetOfficialModelId?: string; discoveryOnly?: boolean }>(request);
        const requestId = typeof body.requestId === "string" && /^[a-f0-9-]{36}$/i.test(body.requestId) ? body.requestId : randomUUID();
        const input = {
            origin: resolveInternalOrigin(new URL(request.url).origin),
            cookie: request.headers.get("cookie") || "",
            userId: user.id,
            requestId,
            manufacturer: body.manufacturer || "",
            sourceUrl: body.sourceUrl || "",
            sourceText: body.sourceText,
            retirementText: body.retirementText,
            targetOfficialModelId: body.targetOfficialModelId,
            ...(body.discoveryOnly === true ? { discoveryOnly: true } : {}),
        };
        if (request.headers.get("accept")?.includes("text/event-stream")) return streamReview(request, input);
        const data = await reviewOfficialPrices(input);
        return NextResponse.json({ code: 0, data, msg: "ok" });
    } catch (error) {
        const status = error instanceof PriceReviewError ? error.status : 500;
        if (status === 500) console.error("Model price AI review failed", error);
        return NextResponse.json({ code: status, data: null, msg: error instanceof PriceReviewError ? error.message : "官网价目核对失败" }, { status });
    }
}

function streamReview(request: Request, input: Parameters<typeof reviewOfficialPrices>[0]) {
    const encoder = new TextEncoder();
    let dispose: () => void = () => undefined;
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            let closed = false;
            const emit = (event: string, data: unknown) => {
                if (!closed) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
            };
            const heartbeat = setInterval(() => {
                if (!closed) controller.enqueue(encoder.encode(": heartbeat\n\n"));
            }, 15_000);
            const close = () => {
                if (closed) return;
                closed = true;
                clearInterval(heartbeat);
                request.signal.removeEventListener("abort", close);
                try {
                    controller.close();
                } catch {
                    /* The reader may have cancelled the stream. */
                }
            };
            dispose = close;
            request.signal.addEventListener("abort", close, { once: true });
            void reviewOfficialPrices({ ...input, signal: request.signal, onProgress: (progress) => emit("progress", progress), onPartial: (result) => emit("partial", result) })
                .then((data) => {
                    emit("result", data);
                    close();
                })
                .catch((error) => {
                    if (!(error instanceof PriceReviewError) && !request.signal.aborted) console.error("Model price AI review failed", error);
                    emit("error", { message: error instanceof PriceReviewError ? error.message : "官网价目核对失败" });
                    close();
                });
        },
        cancel() {
            dispose();
        },
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "private, no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
}

export async function PATCH(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    if (!hasAdminPermission(user, "upstream.manage")) return NextResponse.json({ code: 403, data: null, msg: "需要上游配置权限" }, { status: 403 });
    try {
        const body = await readJsonBody<{ action: "mark" | "unmark"; logicalModelId: string; officialModelId?: string; evidence?: string; evidenceMode?: "website" | "admin-excerpt"; deactivationDate?: string; observedAt?: string }>(request);
        if (body.action !== "mark" && body.action !== "unmark") throw new PriceReviewError("停用标记操作无效", 400);
        const data =
            body.action === "mark"
                ? await markByteDanceSeedRetired({
                      logicalModelId: body.logicalModelId,
                      officialModelId: body.officialModelId || "",
                      evidence: body.evidence || "",
                      evidenceMode: body.evidenceMode === "admin-excerpt" ? "admin-excerpt" : "website",
                      deactivationDate: body.deactivationDate || "",
                      observedAt: body.observedAt || "",
                      actorId: user.id,
                  })
                : await unmarkByteDanceSeedRetired(body.logicalModelId);
        await safeRecordAuditLog({
            action: body.action === "mark" ? "admin.model-pricing.lifecycle-mark" : "admin.model-pricing.lifecycle-unmark",
            actor: auditActorFromRequest(request, user),
            target: { type: "logical_model", id: body.logicalModelId },
            metadata: { officialModelId: body.officialModelId || null, source: "BytePlus ModelArk lifecycle notice" },
        });
        return NextResponse.json({ code: 0, data: data || null, msg: "ok" });
    } catch (error) {
        const status = error instanceof PriceReviewError ? error.status : 500;
        if (status === 500) console.error("Model price lifecycle mark failed", error);
        return NextResponse.json({ code: status, data: null, msg: error instanceof PriceReviewError ? error.message : "模型停用标记失败" }, { status });
    }
}
