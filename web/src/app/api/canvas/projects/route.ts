import { NextResponse } from "next/server";
import { requireVozebCmsCapability } from "@/app/api/vozeb-cms-capability";

import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBodyResult } from "@/lib/auth/request";
import { canvasProjectError, createCanvasProjectForUser, deleteCanvasProjectsForUser, listCanvasProjectsForUser } from "@/lib/server/canvas-project-service";

export async function GET(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const params = new URL(request.url).searchParams;
    return NextResponse.json({ code: 0, data: await listCanvasProjectsForUser(user.id, { page: params.get("page"), pageSize: params.get("pageSize") }), msg: "OK" });
}

export async function POST(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const blocked = await requireVozebCmsCapability("canvas.project.manage", user.id);
    if (blocked) return blocked;
    try {
        const parsed = await readJsonBodyResult<unknown>(request, 16 * 1024 * 1024);
        if (!parsed.ok) return NextResponse.json({ code: parsed.status, data: null, msg: parsed.message }, { status: parsed.status });
        const project = await createCanvasProjectForUser(user.id, parsed.data);
        return NextResponse.json({ code: 0, data: { project }, msg: "画布项目已创建" });
    } catch (error) {
        const known = canvasProjectError(error);
        if (known) return NextResponse.json({ code: known.status, data: null, msg: known.message }, { status: known.status });
        throw error;
    }
}

export async function DELETE(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const blocked = await requireVozebCmsCapability("canvas.project.manage", user.id);
    if (blocked) return blocked;
    const parsed = await readJsonBodyResult<{ ids?: unknown }>(request);
    if (!parsed.ok) return NextResponse.json({ code: parsed.status, data: null, msg: parsed.message }, { status: parsed.status });
    const body = parsed.data;
    const deleted = await deleteCanvasProjectsForUser(user.id, body.ids);
    return NextResponse.json({ code: 0, data: { deleted }, msg: "画布项目已删除" });
}
