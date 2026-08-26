import { NextResponse } from "next/server";

import { readJsonBody } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { isAuthInputError } from "@/lib/auth/store";
import { CanvasImageDecompositionError, decomposeCanvasImage } from "@/lib/server/canvas-image-decomposition-service";
import { createCanvasImageLayerGrant } from "@/lib/server/canvas-image-layer-grant";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { checkGenerationRateLimit, rateLimitHeaders } from "@/lib/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2400;

type CanvasImageDecompositionBody = { requestId?: unknown; source?: unknown };

export async function POST(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const rate = await checkGenerationRateLimit(user.id, request, "text");
    if (!rate.allowed) return NextResponse.json({ code: 429, data: null, msg: "图片分层识别请求过于频繁，请稍后重试" }, { status: 429, headers: rateLimitHeaders(rate) });

    let body: CanvasImageDecompositionBody;
    try {
        body = await readJsonBody(request);
    } catch (error) {
        if (isAuthInputError(error)) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        throw error;
    }
    const requestId = text(body.requestId, 160);
    const source = text(body.source, 4 * 1024 * 1024);
    if (!requestId || !source) return NextResponse.json({ code: 400, data: null, msg: "缺少需要分层的图片" }, { status: 400 });

    try {
        const decomposition = await decomposeCanvasImage({
            origin: resolveInternalOrigin(new URL(request.url).origin),
            cookie: request.headers.get("cookie") || "",
            userId: user.id,
            requestId,
            source,
        });
        const data = { ...decomposition, batchGrant: createCanvasImageLayerGrant({ userId: user.id, requestId, source, decomposition }) };
        return NextResponse.json({ code: 0, data, msg: "OK" });
    } catch (error) {
        const status = error instanceof CanvasImageDecompositionError ? error.status : 502;
        const message = error instanceof CanvasImageDecompositionError ? error.message : "图片分层识别失败，请稍后重试";
        return NextResponse.json({ code: status, data: null, msg: message }, { status });
    }
}

function text(value: unknown, maxLength: number) {
    return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}
