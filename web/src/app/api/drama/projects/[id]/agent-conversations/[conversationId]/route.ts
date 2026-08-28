import { NextResponse } from "next/server";

import { requireVozebCmsCapability } from "@/app/api/vozeb-cms-capability";
import { getCurrentUser } from "@/lib/auth/session";
import { deleteDramaAgentConversationForUser, DramaProjectServiceError } from "@/lib/server/drama-project-service";

type Context = { params: Promise<{ id: string; conversationId: string }> };

export async function DELETE(request: Request, context: Context) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const blocked = await requireVozebCmsCapability("drama.project.manage", user.id);
    if (blocked) return blocked;
    const { id, conversationId } = await context.params;
    try {
        const result = await deleteDramaAgentConversationForUser(user.id, id, conversationId);
        return NextResponse.json({ code: 0, data: result, msg: "短剧 Agent 对话已删除" });
    } catch (error) {
        if (error instanceof DramaProjectServiceError) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        return NextResponse.json({ code: 500, data: null, msg: "短剧 Agent 对话删除失败" }, { status: 500 });
    }
}
