import { NextResponse } from "next/server";

import { requireVozebCmsCapability } from "@/app/api/vozeb-cms-capability";
import { readJsonBodyResult } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { canvasProjectError, deleteCanvasAssistantConversationsForUser } from "@/lib/server/canvas-project-service";

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const blocked = await requireVozebCmsCapability("canvas.project.manage", user.id);
    if (blocked) return blocked;
    const parsed = await readJsonBodyResult<{ conversationIds?: unknown }>(request);
    if (!parsed.ok) return NextResponse.json({ code: parsed.status, data: null, msg: parsed.message }, { status: parsed.status });
    try {
        const result = await deleteCanvasAssistantConversationsForUser(user.id, (await params).id, parsed.data?.conversationIds);
        return NextResponse.json({ code: 0, data: result, msg: "OK" });
    } catch (error) {
        const known = canvasProjectError(error);
        if (known) return NextResponse.json({ code: known.status, data: null, msg: known.message }, { status: known.status });
        return NextResponse.json({ code: 500, data: null, msg: "Agent 对话删除失败" }, { status: 500 });
    }
}
