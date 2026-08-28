import { NextResponse } from "next/server";
import { requireGenerationResourceAccess } from "@/app/api/generation-resource-access";

import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBodyResult } from "@/lib/auth/request";
import { getDramaRenderTask, transitionDramaRenderTask } from "@/lib/server/drama-render-store";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser();
    const task = user ? await getDramaRenderTask((await params).id) : null;
    if (!user || !task) return NextResponse.json({ code: user ? 404 : 401, data: null, msg: "合成任务不存在" }, { status: user ? 404 : 401 });
    const blocked = await requireGenerationResourceAccess({ actor: user, ownerUserId: task.userId, capabilityId: "drama.workflow.run", adminPermission: "generation.read", notFoundMessage: "合成任务不存在" });
    if (blocked) return blocked;
    return NextResponse.json({ code: 0, data: { id: task.id, status: task.status, result: task.result, error: task.error }, msg: "OK" });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser();
    const task = user ? await getDramaRenderTask((await params).id) : null;
    if (!user || !task) return NextResponse.json({ code: user ? 404 : 401, data: null, msg: "合成任务不存在" }, { status: user ? 404 : 401 });
    const blocked = await requireGenerationResourceAccess({ actor: user, ownerUserId: task.userId, capabilityId: "drama.workflow.run", adminPermission: "generation.manage", notFoundMessage: "合成任务不存在" });
    if (blocked) return blocked;
    const parsed = await readJsonBodyResult<{ status?: string }>(request);
    if (!parsed.ok) return NextResponse.json({ code: parsed.status, data: null, msg: parsed.message }, { status: parsed.status });
    const body = parsed.data;
    if (body.status !== "cancelled" || !["pending", "running"].includes(task.status)) return NextResponse.json({ code: 409, data: null, msg: "当前任务无法取消" }, { status: 409 });
    const next = await transitionDramaRenderTask(task, ["pending", "running"], { status: "cancelled", error: "任务已取消" });
    if (!next) return NextResponse.json({ code: 409, data: null, msg: "当前任务无法取消" }, { status: 409 });
    return NextResponse.json({ code: 0, data: next, msg: "已取消" });
}
