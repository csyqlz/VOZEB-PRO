import { NextResponse } from "next/server";
import { requireVozebCmsCapability } from "@/app/api/vozeb-cms-capability";

import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBody } from "@/lib/auth/request";
import { isAuthInputError } from "@/lib/auth/store";
import { createVozebCmsAuditScope } from "@/lib/server/vozeb-cms/audit";
import { reviewCreativeOutputs } from "@/lib/server/creative-review-service";
import { normalizeDramaVisualReviewInput } from "@/lib/server/drama-visual-review";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { checkRateLimit } from "@/lib/server/security";

export async function POST(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const blocked = await requireVozebCmsCapability("drama.workflow.run", user.id);
    if (blocked) return blocked;
    if (!(await checkRateLimit(`drama-review:${user.id}`, { maxRequests: 8, windowMs: 60_000 })).allowed) return NextResponse.json({ code: 429, data: null, msg: "视觉复盘请求过于频繁，请稍后重试" }, { status: 429 });
    let body: unknown;
    try {
        body = await readJsonBody(request, 2 * 1024 * 1024);
    } catch (error) {
        if (isAuthInputError(error)) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        throw error;
    }
    const input = normalizeDramaVisualReviewInput(body);
    if (!input.tasks.length) return NextResponse.json({ code: 400, data: null, msg: "请先生成至少一张可读取的分镜图" }, { status: 400 });
    const audit = createVozebCmsAuditScope(request, user, "vozeb.drama.review", { type: "drama_review" });
    try {
        const review = await reviewCreativeOutputs({
            origin: resolveInternalOrigin(new URL(request.url).origin),
            cookie: request.headers.get("cookie") || "",
            userId: user.id,
            foundation: input.foundation,
            tasks: input.tasks,
        });
        await audit.success({ metadata: { status: review.status, resultCount: input.tasks.length, nodeCount: review.issues.length } });
        return NextResponse.json({ code: 0, data: { review }, msg: "视觉复盘已完成" });
    } catch (error) {
        await audit.failure(error, { metadata: { resultCount: input.tasks.length } });
        throw error;
    }
}
