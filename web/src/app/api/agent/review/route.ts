import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBody } from "@/lib/auth/request";
import { isAuthInputError } from "@/lib/auth/store";
import { normalizeCreativeDeliverables, normalizeCreativeFoundation } from "@/lib/creative-agent-contract";
import { reviewCreativeOutputs } from "@/lib/server/creative-review-service";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { checkRateLimit } from "@/lib/server/security";
import { normalizeCreativeReviewAssets } from "./creative-review-assets";
import { requireVozebCmsCapability } from "@/app/api/vozeb-cms-capability";

type ReviewBody = { recordId?: unknown; workspace?: unknown; foundation?: unknown; deliverables?: unknown; assets?: unknown };

export async function POST(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const blocked = await requireVozebCmsCapability("agent.run", user.id);
    if (blocked) return blocked;
    const rate = await checkRateLimit(`agent-review:${user.id}`, { maxRequests: 12, windowMs: 60 * 1000 });
    if (!rate.allowed) return NextResponse.json({ code: 429, data: null, msg: "复盘请求过于频繁，请稍后重试" }, { status: 429 });
    let body: ReviewBody;
    try {
        body = await readJsonBody(request);
    } catch (error) {
        if (isAuthInputError(error)) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        throw error;
    }
    const workspace = body.workspace === "video" ? "video" : "image";
    const recordId = typeof body.recordId === "string" ? body.recordId.trim() : "";
    if (!recordId || recordId.length > 160) return NextResponse.json({ code: 400, data: null, msg: "复盘记录标识无效" }, { status: 400 });
    const foundation = normalizeCreativeFoundation(body.foundation, workspace === "image" ? "检查当前图片结果" : "检查当前视频结果");
    const deliverables = normalizeCreativeDeliverables(body.deliverables, { title: workspace === "image" ? "当前图片" : "当前视频", type: workspace, role: "当前创作结果" });
    const assets = normalizeCreativeReviewAssets(body.assets, workspace);
    const review = await reviewCreativeOutputs({
        origin: resolveInternalOrigin(new URL(request.url).origin),
        cookie: request.headers.get("cookie") || "",
        userId: user.id,
        billingId: recordId,
        foundation,
        tasks: [
            {
                id: "workbench-output",
                title: deliverables[0]?.title || (workspace === "image" ? "当前图片" : "当前视频"),
                type: workspace,
                prompt: foundation.brief.objective,
                resultSummary: assets.length ? `已生成 ${assets.length} 个${workspace === "image" ? "图片" : "视频"}结果` : `${workspace === "image" ? "图片" : "视频"}结果没有可读取的视觉输入`,
                imageUrls: workspace === "image" ? assets.map((item) => item.url) : [],
            },
        ],
    });
    return NextResponse.json({ code: 0, data: { review }, msg: "OK" });
}
