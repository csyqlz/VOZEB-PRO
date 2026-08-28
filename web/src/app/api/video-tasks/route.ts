import { NextResponse } from "next/server";
import { requireVozebCmsCapability } from "@/app/api/vozeb-cms-capability";
import { getCurrentUser } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2400;

export async function POST(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    const blocked = await requireVozebCmsCapability("video.generate", user.id);
    if (blocked) return blocked;
    return NextResponse.json({ error: "旧视频任务登记接口已停用，请通过服务端视频生成接口创建任务" }, { status: 410 });
}
