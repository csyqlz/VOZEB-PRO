import { NextResponse } from "next/server";
import { requireVozebCmsCapability } from "@/app/api/vozeb-cms-capability";

import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBodyResult } from "@/lib/auth/request";
import { createDramaProjectForUser, DramaProjectServiceError, listDramaProjectSummariesForUser } from "@/lib/server/drama-project-service";

export async function GET(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const blocked = await requireVozebCmsCapability("drama.project.manage", user.id, request);
    if (blocked) return blocked;
    const params = new URL(request.url).searchParams;
    const result = await listDramaProjectSummariesForUser(user.id, {
        page: Math.max(1, Number(params.get("page")) || 1),
        pageSize: Math.max(1, Math.min(100, Number(params.get("pageSize")) || 20)),
    });
    return NextResponse.json({ code: 0, data: { projects: result.items, total: result.total, page: result.page, pageSize: result.pageSize }, msg: "OK" });
}

export async function POST(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const blocked = await requireVozebCmsCapability("drama.project.manage", user.id);
    if (blocked) return blocked;
    try {
        const parsed = await readJsonBodyResult<unknown>(request, 8 * 1024 * 1024);
        if (!parsed.ok) return NextResponse.json({ code: parsed.status, data: null, msg: parsed.message }, { status: parsed.status });
        const project = await createDramaProjectForUser(user.id, parsed.data);
        return NextResponse.json({ code: 0, data: { project }, msg: "短剧项目已创建" });
    } catch (error) {
        if (error instanceof DramaProjectServiceError) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        throw error;
    }
}
