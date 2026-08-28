import { NextResponse } from "next/server";
import { requireVozebCmsCapability } from "@/app/api/vozeb-cms-capability";

import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBodyResult } from "@/lib/auth/request";
import { canvasProjectError, getCanvasProjectForUser, updateCanvasProjectForUser } from "@/lib/server/canvas-project-service";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    try {
        const project = await getCanvasProjectForUser(user.id, (await context.params).id);
        return NextResponse.json({ code: 0, data: { project }, msg: "OK" });
    } catch (error) {
        const known = canvasProjectError(error);
        if (known) return NextResponse.json({ code: known.status, data: null, msg: known.message }, { status: known.status });
        throw error;
    }
}

export async function PATCH(request: Request, context: Context) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const blocked = await requireVozebCmsCapability("canvas.project.manage", user.id);
    if (blocked) return blocked;
    try {
        const parsed = await readJsonBodyResult<unknown>(request, 16 * 1024 * 1024);
        if (!parsed.ok) return NextResponse.json({ code: parsed.status, data: null, msg: parsed.message }, { status: parsed.status });
        const result = await updateCanvasProjectForUser(user.id, (await context.params).id, parsed.data);
        return "projectId" in result ? NextResponse.json({ code: 0, data: { ack: result }, msg: "画布项目已保存" }) : NextResponse.json({ code: 0, data: { project: result }, msg: "画布项目已保存" });
    } catch (error) {
        const known = canvasProjectError(error);
        if (known) return NextResponse.json({ code: known.status, data: null, msg: known.message }, { status: known.status });
        throw error;
    }
}
