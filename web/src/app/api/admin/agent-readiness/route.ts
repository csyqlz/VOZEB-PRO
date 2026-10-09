import { hasAdminPermission } from "@/lib/admin-permissions";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { getAuthSettings } from "@/lib/auth/store";
import { buildAgentReadiness, probeDefaultTextModel } from "@/lib/server/agent-readiness";

export async function GET() {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    if (!hasAdminPermission(user, "upstream.manage")) return NextResponse.json({ code: 403, data: null, msg: "需要管理员权限" }, { status: 403 });
    return NextResponse.json({ code: 0, data: buildAgentReadiness(await getAuthSettings()), msg: "OK" });
}

export async function POST(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    if (!hasAdminPermission(user, "upstream.manage")) return NextResponse.json({ code: 403, data: null, msg: "需要管理员权限" }, { status: 403 });
    const settings = await getAuthSettings();
    const readiness = buildAgentReadiness(settings);
    const textProbe = await probeDefaultTextModel({ settings, request, userId: user.id });
    return NextResponse.json({
        code: 0,
        data: { ...readiness, ready: readiness.ready && textProbe.status !== "fail", diagnostics: { ...readiness.diagnostics, probes: [textProbe] } },
        msg: textProbe.status === "pass" ? "模型诊断完成" : "模型诊断发现问题",
    });
}
