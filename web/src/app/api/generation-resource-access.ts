import { NextResponse } from "next/server";

import { requireVozebCmsCapability } from "@/app/api/vozeb-cms-capability";
import { hasAdminPermission, type AdminPermission } from "@/lib/admin-permissions";

type GenerationResourceActor = {
    id: string;
    role?: unknown;
    status?: unknown;
    adminPermissions?: unknown;
};

export async function requireGenerationResourceAccess(input: { actor: GenerationResourceActor; ownerUserId: string; capabilityId: string; adminPermission: Extract<AdminPermission, "generation.read" | "generation.manage">; notFoundMessage: string }) {
    const blocked = await requireVozebCmsCapability(input.capabilityId, input.actor.id);
    if (blocked) return blocked;
    if (input.ownerUserId === input.actor.id) return null;
    if (input.actor.role !== "admin") return responseError(input.notFoundMessage, 404);
    if (!hasAdminPermission(input.actor, input.adminPermission)) return responseError(input.adminPermission === "generation.read" ? "当前管理员没有查看生成任务的职责权限" : "当前管理员没有管理生成任务的职责权限", 403);
    return null;
}

function responseError(msg: string, status: number) {
    return NextResponse.json({ code: status, data: null, msg, error: msg }, { status });
}
