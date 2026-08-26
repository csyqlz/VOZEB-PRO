import { hasAdminPermission } from "@/lib/admin-permissions";
import { NextResponse } from "next/server";

import { readJsonBody } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { createChannelProtocolDraft, ProtocolDraftError } from "@/lib/server/channel-protocol-assistant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DraftBody = {
    documentationUrl?: string;
    documentationText?: string;
    examples?: string;
    useTextModel?: boolean;
};

export async function POST(request: Request) {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    if (!hasAdminPermission(currentUser, "upstream.manage")) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
    try {
        const body = await readJsonBody<DraftBody>(request, 1024 * 1024);
        const result = await createChannelProtocolDraft({ requestUrl: request.url, cookie: request.headers.get("cookie") || "", userId: currentUser.id, ...body });
        return NextResponse.json({ ...result, draft: result.drafts[0] }, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
        if (error instanceof ProtocolDraftError) return NextResponse.json({ error: error.message }, { status: error.status });
        console.error("Channel protocol draft failed", error instanceof Error ? error.message : error);
        return NextResponse.json({ error: "协议分析失败，请检查文档或示例" }, { status: 502 });
    }
}
