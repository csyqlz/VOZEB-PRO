import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { canvasProjectError, getCanvasProjectForUser } from "@/lib/server/canvas-project-service";
import { getGenerationProjectBillingSummary } from "@/lib/server/generation-project-billing-service";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    try {
        const project = await getCanvasProjectForUser(user.id, (await params).id);
        return NextResponse.json({ code: 0, data: { summary: await getGenerationProjectBillingSummary(user.id, project.id) }, msg: "OK" });
    } catch (error) {
        const known = canvasProjectError(error);
        if (known) return NextResponse.json({ code: known.status, data: null, msg: known.message }, { status: known.status });
        throw error;
    }
}
