import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { requireVozebCmsCapability } from "@/app/api/vozeb-cms-capability";
import { listVozebCmsAssets } from "@/lib/server/vozeb-cms/unified-resource-service";
import { resolveVozebCmsProjectRef, VozebCmsProjectRefError } from "@/lib/server/vozeb-cms/project-ref-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return responseError("请先登录", 401);
    const blocked = await requireVozebCmsCapability("asset.manage", user.id);
    if (blocked) return blocked;
    const url = new URL(request.url);
    try {
        const projectId = url.searchParams.get("projectId") || undefined;
        const projectType = url.searchParams.get("projectType") || undefined;
        const projectRef = projectId && projectType ? await resolveVozebCmsProjectRef(user.id, { id: projectId, type: projectType }, true) : undefined;
        if (projectType && !projectId) return responseError("项目类型必须和项目标识一起提供", 400);
        return NextResponse.json({ code: 0, data: { assets: await listVozebCmsAssets(user.id, { projectId, projectRef, limit: Number(url.searchParams.get("limit")) || undefined }) }, msg: "ok" });
    } catch (error) {
        if (error instanceof VozebCmsProjectRefError) return responseError(error.message, error.status);
        console.error("VOZEBCMS asset projection failed", error);
        return responseError("资产列表读取失败", 500);
    }
}

function responseError(msg: string, status: number) {
    return NextResponse.json({ code: status, data: null, msg }, { status });
}
