import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBody } from "@/lib/auth/request";
import { createConversationForUser, CreativeRuntimeServiceError, deleteConversationsForUser, listConversationsForUser } from "@/lib/server/creative-runtime-service";
import { requireVozebCmsCapability } from "@/app/api/vozeb-cms-capability";

export async function GET(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    try {
        const url = new URL(request.url);
        const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 50));
        const conversations = await listConversationsForUser(user.id, {
            surface: url.searchParams.get("surface"),
            source: url.searchParams.get("source"),
            projectId: url.searchParams.get("projectId"),
            status: url.searchParams.get("status"),
            limit: String(limit + 1),
            offset: url.searchParams.get("offset"),
        });
        return NextResponse.json({ code: 0, data: { conversations: conversations.slice(0, limit), hasMore: conversations.length > limit }, msg: "OK" });
    } catch (error) {
        return serviceError(error);
    }
}

export async function POST(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const blocked = await requireVozebCmsCapability("agent.run", user.id);
    if (blocked) return blocked;
    try {
        const conversation = await createConversationForUser(user.id, await readJsonBody<unknown>(request));
        return NextResponse.json({ code: 0, data: { conversation }, msg: "创作会话已创建" });
    } catch (error) {
        return serviceError(error);
    }
}

export async function DELETE(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    try {
        const body = await readJsonBody<{ ids?: unknown }>(request);
        const deleted = await deleteConversationsForUser(user.id, body.ids);
        return NextResponse.json({ code: 0, data: { deleted }, msg: "创作会话已删除" });
    } catch (error) {
        return serviceError(error);
    }
}

function serviceError(error: unknown) {
    if (error instanceof CreativeRuntimeServiceError) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
    throw error;
}
